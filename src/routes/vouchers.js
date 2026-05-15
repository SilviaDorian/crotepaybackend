import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; 

/**
 * UTILITY: Get Live Conversion to USD
 */
const getUsdEquivalent = async (amount, fromCurrency) => {
    if (fromCurrency === 'USD') return parseFloat(amount);
    try {
        const apiKey = process.env.EXCHANGERATE_API_KEY;
        const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/${fromCurrency}/USD/${amount}`;
        const response = await axios.get(url);
        return response.data.conversion_result;
    } catch (error) {
        console.error("Currency Conversion Error:", error.message);
        throw new Error("Unable to verify currency exchange rates.");
    }
};

/**
 * 1. CREATE VOUCHER
 */
router.post('/create', async (req, res) => {
    const { 
        creator_email, recipient_email, recipient_name, 
        amount, currency, description, category 
    } = req.body;

    if (!creator_email || !recipient_email || !recipient_name || !amount || !currency) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        const userCheck = await query("SELECT kyc_tier FROM users WHERE email = $1", [creator_email]);
        const user = userCheck.rows[0];

        if (!user) return res.status(404).json({ error: "Creator account not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required." });

        const usdValue = await getUsdEquivalent(amount, currency);
        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); 

        await query(
            `INSERT INTO vouchers (
                id, creator_email, recipient_email, recipient_name, 
                amount, currency, usd_equivalent, status, 
                release_key_hash, expires_at, description, category
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING'::voucher_status, $8, $9, $10, $11)`,
            [
                voucherId, creator_email, recipient_email, recipient_name, 
                amount, currency, usdValue, hashedKey, 
                expiresAt, description || "FielPay Escrow", category || "General"
            ]
        );

        res.status(201).json({ 
            success: true,
            voucher_code: voucherId, 
            ref_id: voucherId,
            releaseKey: rawKey, 
            message: `Created at $${usdValue.toFixed(2)} USD equivalent.`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 2. GET VOUCHER DETAILS
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await query(
            `SELECT v.*, u.full_name AS creator_name, u.country_name AS creator_country
             FROM vouchers v
             LEFT JOIN users u ON v.creator_email = u.email
             WHERE v.id = $1`, 
            [req.params.id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: "Voucher not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

/**
 * 3. RELEASE FUNDS (LEDGER MOVEMENT)
 * Supports Recipient Button Click OR Creator entering Release Key
 */
router.post('/release', async (req, res) => {
    const { voucher_id, releaseKey } = req.body; // Aligned with frontend
    const client = await getClient();

    try {
        await client.query('BEGIN');
        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucher_id]);
        const v = vResult.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'LOCKED') throw new Error(`Funds are ${v.status}, not in Escrow.`);

        // If key provided, verify it. If not, we assume Recipient triggered via UI.
        if (releaseKey) {
            const hashedInput = crypto.createHash('sha256').update(releaseKey).digest('hex');
            if (v.release_key_hash !== hashedInput) throw new Error("Invalid release key.");
        }

        const amount = parseFloat(v.amount);
        const fee = parseFloat((amount * 0.07).toFixed(4)); 
        const netAmount = amount - fee;

        // 1. Deduct Payer Escrow
        await client.query(
            "UPDATE wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2",
            [amount, v.recipient_email]
        );

        // 2. Add Net to Creator (With ON CONFLICT safety)
        await client.query(`
            INSERT INTO wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email) DO UPDATE SET 
            available_balance = wallets.available_balance + $2, updated_at = NOW()`,
            [v.creator_email, netAmount, v.currency]
        );

        // 3. System Fee to OWNER_EMAIL
        await client.query(`
            INSERT INTO wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email) DO UPDATE SET 
            available_balance = wallets.available_balance + $2, updated_at = NOW()`,
            [OWNER_EMAIL, fee, v.currency]
        );

        // 4. Log Transaction
        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, fee, status) 
            VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, $5, 'SUCCESSFUL'::voucher_status)`,
            [v.creator_email, v.id, netAmount, v.currency, fee]
        );

        await client.query("UPDATE vouchers SET status = 'RELEASED'::voucher_status, updated_at = NOW() WHERE id = $1", [v.id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Funds released to available balance." });

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * 4. DISPUTE
 */
router.post('/dispute', async (req, res) => {
    const { voucher_id, reason } = req.body;
    try {
        await query(
            "UPDATE vouchers SET status = 'DISPUTED'::voucher_status, description = $1, updated_at = NOW() WHERE id = $2",
            [reason || "User initiated dispute", voucher_id]
        );
        res.json({ success: true, message: "Funds frozen." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;