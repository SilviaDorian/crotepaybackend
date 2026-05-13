import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; // System Revenue Account

/**
 * 1. CREATE VOUCHER (DATABASE ONLY)
 * Creator = Seller/Service Provider (Requesting money)
 * Recipient = Client/Buyer (Paying money)
 */
router.post('/create', async (req, res) => {
    // Corrected variable names to match business logic
    const { creator_email, recipient_email, recipient_name, amount, currency, description, category } = req.body;

    if (!creator_email || !recipient_email || !amount) {
        return res.status(400).json({ error: "Missing required fields." });
    }

    try {
        // --- KYC CHECK ON CREATOR ---
        const userCheck = await query(
            "SELECT kyc_tier, preferred_currency FROM users WHERE email = $1", 
            [creator_email]
        );
        const user = userCheck.rows[0];

        if (!user) return res.status(404).json({ error: "Creator not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required to request payments." });

        // --- HASHING & ID GENERATION ---
        const selectedCurrency = currency || user.preferred_currency || 'USD';
        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); // 14-day expiry

        // Save Voucher to DB
        await query(
            `INSERT INTO vouchers (id, creator_email, recipient_email, recipient_name, amount, currency, status, release_key_hash, expires_at, description, category) 
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10)`,
            [voucherId, creator_email, recipient_email, recipient_name, amount, selectedCurrency, hashedKey, expiresAt, description || "FielPay Escrow", category || "General"]
        );

        res.status(201).json({ 
            success: true,
            voucher_code: voucherId, 
            releaseKey: rawKey, 
            message: `Payment request created.`
        });

    } catch (err) {
        console.error("Create Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 2. GET VOUCHER DETAILS (PUBLIC ACCESS)
 * Includes formatted Date and Time of creation.
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await query(
            `SELECT 
                v.*,
                u.full_name AS creator_name, 
                u.country_name AS creator_country
             FROM vouchers v
             LEFT JOIN users u ON v.creator_email = u.email
             WHERE v.id = $1`, 
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Voucher not found" });
        }

        const voucher = result.rows[0];

        // Format Date and Time for the UI
        const createdAt = new Date(voucher.created_at);
        const formattedDate = createdAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const formattedTime = createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        res.json({
            ...voucher,
            display_date: formattedDate,
            display_time: formattedTime,
            created_at_iso: voucher.created_at // Original for sorting/logic
        });
    } catch (err) {
        console.error("Fetch Voucher Error:", err.message);
        res.status(500).json({ error: "Database error" });
    }
});

/**
 * 3. RELEASE FUNDS (LEDGER MOVEMENT)
 * Moves value from Client's Escrow Ledger to Creator's Available Ledger.
 */
router.post('/release', async (req, res) => {
    const { voucherId, releaseKey } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');
        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucherId]);
        const v = vResult.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'LOCKED') throw new Error(`Funds are ${v.status}, not in Escrow.`);

        // Verify Key
        const hashedKey = crypto.createHash('sha256').update(releaseKey || "").digest('hex');
        if (v.release_key_hash !== hashedKey) {
            throw new Error("Invalid release key. Contact your client for the key.");
        }

        const amount = parseFloat(v.amount);
        const fee = parseFloat((amount * 0.07).toFixed(4)); // 7% System Fee
        const netAmount = amount - fee;

        // 1. Deduct from Client's (Recipient) Escrow Balance
        await client.query(
            "UPDATE wallets SET escrow_balance = escrow_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [amount, v.recipient_email]
        );

        // 2. Add Net to Creator's Available Balance (Ready for withdrawal)
        await client.query(
            "UPDATE wallets SET available_balance = available_balance + $1, updated_at = NOW() WHERE user_email = $2",
            [netAmount, v.creator_email]
        );

        // 3. Add Fee to System Account
        await client.query(
            "UPDATE wallets SET available_balance = available_balance + $1, updated_at = NOW() WHERE user_email = $2",
            [fee, OWNER_EMAIL]
        );

        // 4. Log the Ledger Movement
        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount_usd, fee_usd, status, reference_id) 
            VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)`,
            [v.creator_email, v.id, netAmount, fee, `REL-${v.id}`]
        );

        // 5. Update Voucher Status
        await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [v.id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Success! Funds are now available in your wallet." });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});

/**
 * 4. DISPUTE
 */
router.post('/dispute', async (req, res) => {
    const { voucherId, reason } = req.body;
    try {
        await query(
            "UPDATE vouchers SET status = 'DISPUTED', updated_at = NOW() WHERE id = $2",
            [reason || "User initiated dispute", voucherId]
        );
        res.json({ success: true, message: "Funds frozen for dispute review." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;