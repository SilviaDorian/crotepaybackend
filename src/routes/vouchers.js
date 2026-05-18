import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; 

/**
 * NEW: GET ALL VOUCHERS OR FILTER BY EMAIL
 * Handles: GET /api/vouchers?email=user@example.com
 */
router.get('/', async (req, res) => {
    const { email } = req.query;

    try {
        let result;
        if (email) {
            // Fetch records where the user is either the creator OR the recipient
            result = await query(
                `SELECT v.*, u.full_name AS creator_name 
                 FROM public.vouchers v
                 LEFT JOIN public.users u ON v.creator_email = u.email
                 WHERE LOWER(v.creator_email) = LOWER($1) OR LOWER(v.recipient_email) = LOWER($1)
                 ORDER BY v.created_at DESC`,
                [email]
            );
        } else {
            // Fallback for admin overview if no email query parameter is supplied
            result = await query("SELECT * FROM public.vouchers ORDER BY created_at DESC");
        }

        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Vouchers Error:", err.message);
        res.status(500).json({ error: "Database error while fetching vouchers." });
    }
});

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
        const userCheck = await query("SELECT kyc_tier FROM public.users WHERE email = $1", [creator_email]);
        const user = userCheck.rows[0];

        if (!user) return res.status(404).json({ error: "Creator account not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required." });

        const usdValue = amount; 
        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); 

        await query(
            `INSERT INTO public.vouchers (
                id, creator_email, recipient_email, recipient_name, 
                amount, currency, usd_equivalent, status, 
                release_key_hash, expires_at, description, category
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING'::text::voucher_status, $8, $9, $10, $11)`,
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
            message: `Voucher created successfully.`
        });
    } catch (err) {
        console.error("Voucher Creation Error:", err.message);
        res.status(500).json({ error: "Server error during voucher creation." });
    }
});

/**
 * 2. GET VOUCHER DETAILS BY UNIQUE ID
 * Note: Placed below root route to avoid wildcard string capture interference
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await query(
            `SELECT v.*, u.full_name AS creator_name, u.country_name AS creator_country
             FROM public.vouchers v
             LEFT JOIN public.users u ON v.creator_email = u.email
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
 */
router.post('/release', async (req, res) => {
    const { voucher_id, releaseKey } = req.body;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucher_id]);
        const v = vResult.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'LOCKED') throw new Error(`Funds are currently ${v.status}. Payment must be verified.`);

        if (releaseKey) {
            const hashedInput = crypto.createHash('sha256').update(releaseKey).digest('hex');
            if (v.release_key_hash !== hashedInput) throw new Error("Invalid release key.");
        }

        const amount = parseFloat(v.amount);
        const fee = parseFloat((amount * 0.07).toFixed(4)); 
        const netAmount = amount - fee;

        // 1. Deduct from CREATOR's Escrow
        await client.query(
            "UPDATE wallets SET escrow_balance = escrow_balance - $1, updated_at = NOW() WHERE user_email = $2 AND currency = $3",
            [amount, v.creator_email, v.currency]
        );

        // 2. Add Net to CREATOR's Available Balance
        await client.query(`
            INSERT INTO wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email, currency) DO UPDATE SET 
            available_balance = wallets.available_balance + $2, 
            updated_at = NOW()`,
            [v.creator_email, netAmount, v.currency]
        );

        // 3. System Fee to Platform Owner
        await client.query(`
            INSERT INTO wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email, currency) DO UPDATE SET 
            available_balance = wallets.available_balance + $2, 
            updated_at = NOW()`,
            [OWNER_EMAIL, fee, v.currency]
        );

        // 4. Update Voucher Status
        await client.query(
            "UPDATE vouchers SET status = 'RELEASED'::text::voucher_status, updated_at = NOW() WHERE id = $1", 
            [v.id]
        );

        // 5. Log Audit Transaction
        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, fee, status, reference_id) 
            VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, $5, 'SUCCESSFUL'::text::voucher_status, $6)`,
            [v.creator_email, v.id, netAmount, v.currency, fee, `REL-${v.id}`]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Funds released to balance." });

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Release Error:", e.message);
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
            "UPDATE public.vouchers SET status = 'DISPUTED'::text::voucher_status, description = $1, updated_at = NOW() WHERE id = $2",
            [reason || "User initiated dispute", voucher_id]
        );
        res.json({ success: true, message: "Funds frozen." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;