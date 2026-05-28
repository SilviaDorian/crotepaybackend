import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';

const router = express.Router();

router.get('/', async (req, res) => {
    const { email } = req.query;
    try {
        let result;
        if (email) {
            result = await query(
                `SELECT v.*, u.full_name AS creator_name 
                  FROM public.vouchers v
                  LEFT JOIN public.users u ON v.creator_email = u.email
                  WHERE LOWER(v.creator_email) = LOWER($1) 
                     OR LOWER(v.recipient_email) = LOWER($1)
                  ORDER BY v.created_at DESC`,
                [email]
            );
        } else {
            result = await query("SELECT * FROM public.vouchers ORDER BY created_at DESC");
        }
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Vouchers Error:", err.message);
        res.status(500).json({ error: "Database error while fetching vouchers." });
    }
});

router.post('/create', async (req, res) => {
    const { creator_email, recipient_email, recipient_name, amount, currency, description, category } = req.body;
    if (!creator_email || !recipient_email || !recipient_name || !amount || !currency) {
        return res.status(400).json({ error: "Missing required fields." });
    }
    try {
        const userCheck = await query("SELECT kyc_tier FROM public.users WHERE email = $1", [creator_email]);
        const user = userCheck.rows[0];
        if (!user) return res.status(404).json({ error: "Creator account not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required." });

        const rawKey = crypto.randomBytes(8).toString('hex');
        const rawAccessToken = crypto.randomBytes(32).toString('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14);

        await query(
            `INSERT INTO public.vouchers (id, creator_email, recipient_email, recipient_name, amount, currency, usd_equivalent, status, release_key_hash, expires_at, description, category, recipient_access_token) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11, $12)`,
            [voucherId, creator_email, recipient_email, recipient_name, amount, currency, amount, rawKey, expiresAt, description || "FielPay Escrow", category || "General", rawAccessToken]
        );

        res.status(201).json({
            success: true,
            voucher_code: voucherId,
            message: "Voucher created successfully."
        });
    } catch (err) {
        console.error("Voucher Creation Error:", err.message);
        res.status(500).json({ error: "Server error during voucher creation." });
    }
});

router.post('/finalize-payment', async (req, res) => {
    const { voucher_id } = req.body;
    try {
        const result = await query(
            "UPDATE public.vouchers SET status = 'LOCKED', locked_at = NOW() WHERE id = $1 RETURNING recipient_access_token", 
            [voucher_id]
        );
        
        if (result.rows.length === 0) return res.status(404).json({ error: "Voucher not found" });

        res.json({ 
            success: true, 
            token: result.rows[0].recipient_access_token 
        });
    } catch (err) {
        console.error("Finalize Payment Error:", err.message);
        res.status(500).json({ error: "Payment finalization failed." });
    }
});

router.get('/public/:id', async (req, res) => {
    try {
        const result = await query(
            `SELECT v.*, u.full_name AS creator_name, u.country_name AS creator_country
             FROM public.vouchers v
             LEFT JOIN public.users u ON v.creator_email = u.email
             WHERE v.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Voucher not found" });
        delete result.rows[0].recipient_access_token;
        delete result.rows[0].release_key_hash;
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Public Fetch Error:", err.message);
        res.status(500).json({ error: "Database error" });
    }
});

router.get('/verify-access', async (req, res) => {
    const { v_id, token } = req.query;
    if (!v_id || !token) return res.status(400).json({ error: "Missing credentials" });
    try {
        const result = await query(
            `SELECT v.*, u.full_name AS creator_name, u.country_name AS creator_country
             FROM public.vouchers v
             LEFT JOIN public.users u ON v.creator_email = u.email
             WHERE v.id = $1 AND v.recipient_access_token = $2`,
            [v_id, token]
        );
        if (result.rows.length === 0) return res.status(403).json({ error: "Access Denied" });
        delete result.rows[0].recipient_access_token;
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Verify Access Error:", err.message);
        res.status(500).json({ error: "Verification failed" });
    }
});

router.get('/:id', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: "Access token required" });
    try {
        const result = await query(
            `SELECT v.*, u.full_name AS creator_name, u.country_name AS creator_country
             FROM public.vouchers v
             LEFT JOIN public.users u ON v.creator_email = u.email
             WHERE v.id = $1 AND v.recipient_access_token = $2`,
            [req.params.id, token]
        );
        if (result.rows.length === 0) return res.status(403).json({ error: "Unauthorized access" });
        delete result.rows[0].recipient_access_token;
        delete result.rows[0].release_key_hash;
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Voucher Fetch Error:", err.message);
        res.status(500).json({ error: "Database error" });
    }
});

router.post('/release', async (req, res) => {
    const { voucher_id, releaseKey } = req.body;
    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // 1. Fetch and Lock the voucher
        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucher_id]);
        const v = vResult.rows[0];
        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'LOCKED') throw new Error(`Funds are currently ${v.status}.`);
        if (v.release_key_hash !== releaseKey) throw new Error("Invalid release key.");

        const amount = parseFloat(v.amount);

        // 2. Logic: Determine if funds are immediately available or in settlement
        const escrowStartTime = new Date(v.locked_at || v.created_at);
        const now = new Date();
        const diffInHours = (now - escrowStartTime) / (1000 * 60 * 60);
        
        // Define destination bucket
        const targetColumn = diffInHours >= 72 ? 'available_balance' : 'awaiting_settlement';

        // 3. Deduct from Escrow
        await client.query(
            `UPDATE wallets SET escrow_balance = escrow_balance - $1, updated_at = NOW() 
             WHERE user_email = $2 AND currency = $3`,
            [amount, v.creator_email, v.currency]
        );

        // 4. Update Creator Wallet (Add the FULL amount - No fees applied here)
        await client.query(
            `INSERT INTO wallets (user_email, ${targetColumn}, currency) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (user_email, currency) 
             DO UPDATE SET ${targetColumn} = wallets.${targetColumn} + $2, updated_at = NOW()`,
            [v.creator_email, amount, v.currency]
        );

        // 5. Finalize Voucher
        await client.query(`UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1`, [v.id]);

        // 6. Log Transaction
        await client.query(
            `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) 
             VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)`, 
            [v.creator_email, v.id, amount, v.currency, `REL-${v.id}`]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `Funds moved to ${targetColumn}.` });
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Release Error:", e.message);
        res.status(400).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

router.post('/dispute', async (req, res) => {
    const { voucher_id, reason } = req.body;
    try {
        await query(`UPDATE public.vouchers SET status = 'DISPUTED'::text::voucher_status, description = $1, updated_at = NOW() WHERE id = $2`, [reason || "User initiated dispute", voucher_id]);
        res.json({ success: true, message: "Funds frozen." });
    } catch (err) {
        console.error("Dispute Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;