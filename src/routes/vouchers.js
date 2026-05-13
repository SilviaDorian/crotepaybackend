import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; // System Revenue Account

/**
 * 1. CREATE VOUCHER (DATABASE ONLY)
 */
router.post('/create', async (req, res) => {
    const { payer_email, recipient_email, recipient_name, amount, currency, description, category } = req.body;

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
        await query(
            `INSERT INTO vouchers (id, creator_email, recipient_email, recipient_name, amount, currency, status, release_key_hash, expires_at, description, category) 
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10)`,
            [voucherId, payer_email, recipient_email, recipient_name, amount, selectedCurrency, hashedKey, expiresAt, description || "FielPay Escrow", category || "General"]
        );

        res.status(201).json({ 
            success: true,
            voucher_code: voucherId, 
            releaseKey: rawKey, 
            message: `Voucher created in ${selectedCurrency}.`
        });

    } catch (err) {
        console.error("Create Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 2. GET VOUCHER DETAILS (PUBLIC ACCESS)
 * Uses LEFT JOIN to get creator's full name and country for the recipient/guest to see.
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await query(
            `SELECT 
                v.*, 
                u.full_name AS creator_name, 
                u.country AS creator_country
             FROM vouchers v
             LEFT JOIN users u ON v.creator_email = u.email
             WHERE v.id = $1`, 
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Voucher not found" });
        }

        // Return the full object including joined user details
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Fetch Voucher Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 3. WEBHOOK: FLUTTERWAVE SUCCESS
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
            
            // Extract the voucher ID from the tx_ref (Format used in frontend: FP-VC-ID-TIMESTAMP)
            const vId = tx_ref.split('-')[2]; 

            const vRes = await client.query("SELECT * FROM vouchers WHERE id = $1 AND status = 'PENDING'", [vId]);
            const v = vRes.rows[0];

            if (v) {
                await client.query("UPDATE vouchers SET status = 'LOCKED' WHERE id = $1", [v.id]);
                // Note: We don't update recipient balance here if they are a guest/unregistered. 
                // The balance logic should handle "where user_email exists".
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

        await client.query(`
            UPDATE wallets SET 
                escrow_balance = escrow_balance - $1,
                available_balance = available_balance + $2,
                updated_at = NOW()
            WHERE user_email = $3`,
            [v.amount, netAmount, v.recipient_email]
        );

        await client.query(`
            UPDATE wallets SET 
                available_balance = available_balance + $1,
                updated_at = NOW()
            WHERE user_email = $2`,
            [fee, OWNER_EMAIL]
        );

        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount_usd, fee_usd, status, reference_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [v.recipient_email, v.id, 'VOUCHER_RELEASE', v.amount, fee, 'SUCCESSFUL', `REL-${v.id}`]
        );

        await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [v.id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Funds released." });

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