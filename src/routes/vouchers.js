import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; // System Revenue Account

/**
 * 1. CREATE VOUCHER (DATABASE ONLY)
 * Following Option 1: We stop calling Flutterwave here to avoid Redirect URL errors.
 * The voucher starts as 'PENDING'.
 */
router.post('/create', async (req, res) => {
    const { payer_email, recipient_email, recipient_name, amount, currency, description } = req.body;

    if (!payer_email || !recipient_email || !amount) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        // --- KYC CHECK ---
        const userCheck = await query(
            "SELECT kyc_tier, preferred_currency FROM users WHERE email = $1", 
            [payer_email]
        );
        const user = userCheck.rows[0];

        if (!user) return res.status(404).json({ error: "Creator not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required." });

        // --- HASHING & ID GENERATION ---
        const selectedCurrency = currency || user.preferred_currency || 'USD';
        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); // 14-day expiry

        // 1. Save Voucher to DB (Status: PENDING)
        // No external API calls are made here to ensure speed and stability.
        await query(
            `INSERT INTO vouchers (id, creator_email, recipient_email, recipient_name, amount, currency, status, release_key_hash, expires_at, description) 
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9)`,
            [voucherId, payer_email, recipient_email, recipient_name, amount, selectedCurrency, hashedKey, expiresAt, description || "FielPay Escrow"]
        );

        // 2. Return Success
        // Frontend will build the link: https://fielpay.free.af/payment-link.html?v_id=VC-XXXXXX
        res.status(201).json({ 
            success: true,
            voucher_code: voucherId, 
            releaseKey: rawKey, 
            message: `Voucher created in ${selectedCurrency}. Share the link to initiate payment.`
        });

    } catch (err) {
        console.error("Create Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 2. GET VOUCHER DETAILS
 * Used by payment-link.html to display details to the recipient.
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await query("SELECT * FROM vouchers WHERE id = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Voucher not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 3. WEBHOOK: FLUTTERWAVE SUCCESS
 * Moves status from PENDING to LOCKED after payment is confirmed.
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
                // Move to LOCKED (Escrow Active)
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
 * 4. RELEASE FUNDS
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

        // 2. Credit Owner Revenue Account (7%)
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
 * 5. DISPUTE
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