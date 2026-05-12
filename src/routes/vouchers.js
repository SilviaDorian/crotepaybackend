import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; // System Revenue Account

/**
 * 1. CREATE VOUCHER & GENERATE PAYMENT LINK
 * This starts as PENDING. It only moves to LOCKED when the webhook confirms payment.
 */
router.post('/create', async (req, res) => {
    const { payer_email, recipient_email, amount, currency, description } = req.body;

    if (!payer_email || !recipient_email || !amount) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        // --- YOUR ORIGINAL KYC CHECK ---
        const userCheck = await query(
            "SELECT kyc_tier, preferred_currency FROM users WHERE email = $1", 
            [payer_email]
        );
        const user = userCheck.rows[0];

        if (!user) return res.status(404).json({ error: "Creator not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required." });

        // --- YOUR ORIGINAL HASHING LOGIC ---
        const selectedCurrency = currency || user.preferred_currency || 'USD';
        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); // 14-day expiry

        // 1. Save Voucher to DB (Status: PENDING)
        await query(
            `INSERT INTO vouchers (id, creator_email, recipient_email, amount, currency, status, release_key_hash, expires_at, description) 
             VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)`,
            [voucherId, payer_email, recipient_email, amount, selectedCurrency, hashedKey, expiresAt, description || "FielPay Escrow"]
        );

        // 2. TRIGGER FLUTTERWAVE PAYMENT LINK
        // This is the new part that makes the "Create" button actually generate a link
        const flwResponse = await axios.post(
            'https://api.flutterwave.com/v3/payments',
            {
                tx_ref: voucherId,
                amount: amount,
                currency: selectedCurrency,
                redirect_url: `${process.env.FRONTEND_URL}/dashboard.html`,
                customer: { email: payer_email },
                customizations: {
                    title: "FielPay Escrow Payment",
                    description: `Funding Voucher ${voucherId}`
                }
            },
            { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
        );

        res.status(201).json({ 
            success: true,
            voucherId, 
            paymentLink: flwResponse.data.data.link, // Send this to the user to pay
            releaseKey: rawKey, // Show this once to the creator
            message: `Voucher created in ${selectedCurrency}. Fund it to activate escrow.`
        });
    } catch (err) {
        console.error("Create Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 2. WEBHOOK: FLUTTERWAVE SUCCESS
 * This is what moves the status from PENDING to LOCKED after payment.
 */
router.post('/webhook/flutterwave', async (req, res) => {
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
        return res.status(401).end();
    }

    const { status, tx_ref } = req.body.data;

    if (status === "successful") {
        const client = await getClient();
        try {
            await client.query('BEGIN');

            const vRes = await client.query("SELECT * FROM vouchers WHERE id = $1 AND status = 'PENDING'", [tx_ref]);
            const v = vRes.rows[0];

            if (v) {
                // Move from PENDING to LOCKED (Escrow is now active)
                await client.query("UPDATE vouchers SET status = 'LOCKED' WHERE id = $1", [v.id]);

                // Update Recipient's Escrow Balance
                await client.query(
                    "UPDATE wallets SET escrow_balance = escrow_balance + $1 WHERE user_email = $2",
                    [v.amount, v.recipient_email]
                );
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            console.error("Webhook Error:", e.message);
        } finally {
            client.release();
        }
    }
    res.status(200).send("OK");
});

/**
 * 3. RELEASE FUNDS (YOUR ORIGINAL LOGIC)
 * Credits Recipient (93%) and Owner (7%)
 */
router.post('/release', async (req, res) => {
    const { voucherId, releaseKey, payerEmail } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');

        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucherId]);
        const v = vResult.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'LOCKED') throw new Error(`Voucher status is ${v.status}.`);

        const hashedKey = crypto.createHash('sha256').update(releaseKey || "").digest('hex');
        const isAuthorizedPayer = (payerEmail && v.creator_email === payerEmail);
        const isValidKey = (v.release_key_hash === hashedKey);

        if (!isAuthorizedPayer && !isValidKey) {
            throw new Error("Invalid release key or unauthorized access.");
        }

        // --- YOUR ORIGINAL 7% SPLIT LOGIC ---
        const fee = parseFloat((v.amount * 0.07).toFixed(4));
        const netAmount = parseFloat(v.amount) - fee;

        // 1. Update Recipient: Clear Escrow, add Net to Available
        await client.query(`
            UPDATE wallets SET 
                escrow_balance = escrow_balance - $1,
                available_balance = available_balance + $2,
                updated_at = NOW()
            WHERE user_email = $3`,
            [v.amount, netAmount, v.recipient_email]
        );

        // 2. Credit Your Revenue Account (7%)
        await client.query(`
            UPDATE wallets SET 
                available_balance = available_balance + $1,
                updated_at = NOW()
            WHERE user_email = $2`,
            [fee, OWNER_EMAIL]
        );

        // 3. Log Transaction
        await client.query(`
            INSERT INTO transactions (
                user_email, voucher_id, transaction_type, amount_usd, fee_usd, status, reference_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [v.recipient_email, v.id, 'VOUCHER_RELEASE', v.amount, fee, 'SUCCESSFUL', `REL-${v.id}`]
        );

        // 4. Mark Voucher as RELEASED
        await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [v.id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Funds released.", data: { net: netAmount, fee: fee } });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});

/**
 * 4. DISPUTE (YOUR ORIGINAL LOGIC)
 */
router.post('/dispute', async (req, res) => {
    const { voucherId, userEmail, reason } = req.body;
    try {
        const result = await query(
            "SELECT * FROM vouchers WHERE id = $1 AND (creator_email = $2 OR recipient_email = $2)",
            [voucherId, userEmail]
        );
        const v = result.rows[0];
        if (!v || v.status !== 'LOCKED') return res.status(400).json({ error: "Cannot dispute this voucher." });

        await query(
            "UPDATE vouchers SET status = 'DISPUTED', dispute_reason = $1, updated_at = NOW() WHERE id = $2",
            [reason || "User initiated dispute", voucherId]
        );
        res.json({ success: true, message: "Funds frozen for dispute." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;