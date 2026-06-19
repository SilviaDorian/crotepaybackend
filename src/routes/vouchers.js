import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';
import { sendNotification } from '../services/notificationService.js'; // Ensure path is correct

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

        // 2. Determine destination: available or settlement
        const escrowStartTime = new Date(v.locked_at || v.created_at);
        const diffInHours = (new Date() - escrowStartTime) / (1000 * 60 * 60);
        const targetColumn = diffInHours >= 72 ? 'available_balance' : 'awaiting_settlement';

        // 3. Move funds from Creator's Escrow to their Wallet
        // DEDUCT from Recipient's Escrow Balance
        await client.query(
            "UPDATE wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2 AND currency = $3",
            [amount, v.creator_email, v.currency]
        );

        // ADD to Creator's Target Wallet (Awaiting Settlement or Available)
        await client.query(
            `UPDATE wallets 
             SET ${targetColumn} = ${targetColumn} + $1, updated_at = NOW() 
             WHERE user_email = $2 AND currency = $3`,
            [amount, v.creator_email, v.currency]
        );

        // 4. Finalize Voucher
        await client.query(`UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1`, [v.id]);

        // 5. Log Transaction for the RECIPIENT
        await client.query(
            `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) 
             VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)`, 
            [v.creator_email, v.id, amount, v.currency, `REL-${v.id}`]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `Funds moved from escrow to ${targetColumn}.` });

     // --- TRIGGER RELEASE NOTIFICATION ---
try {
    await sendNotification('VOUCHER_RELEASED', v.creator_email, {
        voucher_ref: v.id,
        amount: amount,
        currency: v.currency
    });
    console.log(`✅ VOUCHER_RELEASED notification sent to ${v.creator_email}`);
} catch (err) {
    console.error("❌ Failed to send VOUCHER_RELEASED email:", err);
}

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Release Error:", e.message);
        res.status(400).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

// POST /vouchers/:id/settle
router.post('/:id/settle', async (req, res) => {
    const { id } = req.params;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // 1. Lock the voucher for update
        const result = await client.query(
            "UPDATE vouchers SET status = 'SETTLED', updated_at = NOW() WHERE id = $1 AND status = 'RELEASED' RETURNING *",
            [id]
        );

        if (result.rowCount === 0) {
            throw new Error("Voucher not found or not in 'RELEASED' status.");
        }

        const v = result.rows[0];
        const amount = parseFloat(v.amount);
        const targetEmail = v.parent_batch_ref ? v.recipient_email : v.creator_email;

        // 2. Move funds from 'awaiting_settlement' to 'available_balance'
        const updateWallet = await client.query(
            `UPDATE wallets 
             SET awaiting_settlement = awaiting_settlement - $1, 
                 available_balance = available_balance + $1, 
                 updated_at = NOW() 
             WHERE user_email = $2 AND currency = $3 
             AND awaiting_settlement >= $1`,
            [amount, targetEmail, v.currency]
        );

        if (updateWallet.rowCount === 0) {
            throw new Error("Insufficient funds in awaiting settlement.");
        }

        // 3. Log the transaction
        await client.query(
            `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) 
             VALUES ($1, $2, 'AUTO_SETTLEMENT', $3, $4, 'SUCCESSFUL', $5)`, 
            [targetEmail, v.id, amount, v.currency, `AS-${v.id}`]
        );

        await client.query('COMMIT');
        res.json({ message: "Voucher settled successfully.", voucher: v });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Auto-Settlement Error:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// POST /vouchers/:id/manual-settle
router.post('/:id/manual-settle', async (req, res) => {
    const { id } = req.params;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // 1. Fetch voucher
        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [id]);
        const v = vResult.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status === 'SETTLED') throw new Error("Voucher is already settled.");
        if (v.status !== 'RELEASED') throw new Error("Voucher must be in RELEASED status.");

        const amount = parseFloat(v.amount);

        // 2. Determine target email based on voucher type
        // If parent_batch_ref is present, it's a Bulk voucher (use recipient_email)
        // Otherwise, it's a Single voucher (use creator_email)
        const targetEmail = v.parent_batch_ref ? v.recipient_email : v.creator_email;

        // 3. Move funds from 'awaiting_settlement' to 'available_balance'
        const updateWallet = await client.query(
            `UPDATE wallets 
             SET awaiting_settlement = awaiting_settlement - $1, 
                 available_balance = available_balance + $1, 
                 updated_at = NOW() 
             WHERE user_email = $2 AND currency = $3 
             AND awaiting_settlement >= $1`,
            [amount, targetEmail, v.currency]
        );

        if (updateWallet.rowCount === 0) {
            throw new Error(`Insufficient funds in awaiting settlement for ${targetEmail}.`);
        }

        // 4. Update Voucher Status
        await client.query("UPDATE vouchers SET status = 'SETTLED', updated_at = NOW() WHERE id = $1", [id]);

        // 5. Log transaction
        await client.query(
            `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) 
             VALUES ($1, $2, 'MANUAL_SETTLEMENT', $3, $4, 'SUCCESSFUL', $5)`, 
            [targetEmail, v.id, amount, v.currency, `MS-${v.id}`]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `Funds settled for ${targetEmail} successfully.` });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Manual Settlement Error:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

router.post('/dispute', async (req, res) => {
    const { voucher_id, reason, story } = req.body;
    
    // Validation
    if (!voucher_id || !reason || !story) {
        return res.status(400).json({ error: "Missing required dispute information." });
    }

    try {
        // Update the voucher status and store the dispute context
        // We use 'DISPUTED' as the status and save the user's input for your review
        await query(
            `UPDATE public.vouchers 
             SET status = 'DISPUTED', 
                 dispute_reason = $1, 
                 dispute_story = $2, 
                 updated_at = NOW() 
             WHERE id = $3`, 
            [reason, story, voucher_id]
        );

        res.json({ 
            success: true, 
            message: "Dispute submitted successfully. Funds have been frozen pending administrative review." 
        });
    } catch (err) {
        console.error("Dispute Error:", err.message);
        res.status(500).json({ error: "Internal server error while processing dispute." });
    }
});

export default router;