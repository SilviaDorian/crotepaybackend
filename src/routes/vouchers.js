import express from 'express';
import crypto from 'crypto';
import { query, getClient } from '../db/index.js';

const router = express.Router();

/**
 * 1. CREATE VOUCHER
 * payer_email: The person creating the voucher (must be Tier 1+).
 * recipient_email: The person receiving the money.
 */
router.post('/create', async (req, res) => {
    const { payer_email, recipient_email, amount, currency } = req.body;

    if (!payer_email || !recipient_email || !amount) {
        return res.status(400).json({ error: "Missing required fields: email, recipient, and amount." });
    }

    try {
        // 1. Fetch Creator and their Preferred Currency
        const userCheck = await query(
            "SELECT kyc_tier, preferred_currency FROM users WHERE email = $1", 
            [payer_email]
        );
        const user = userCheck.rows[0];

        if (!user) {
            return res.status(404).json({ error: "Creator account not found. Please register first." });
        }

        // Tier 1 logic: Must have verified email (basic registration)
        if (user.kyc_tier < 1) {
            return res.status(403).json({ 
                error: "KYC Required", 
                message: "Please verify your account to create vouchers." 
            });
        }

        /**
         * CURRENCY LOGIC:
         * 1. Use currency from request body (Creator manual selection)
         * 2. Fallback to user's profile preferred_currency
         * 3. Default to USD
         */
        const selectedCurrency = currency || user.preferred_currency || 'USD';

        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); // 14-day escrow window

        // 2. Create the Voucher
        // We save the selectedCurrency so the deal is locked to this unit
        await query(
            `INSERT INTO vouchers (id, creator_email, recipient_email, amount, currency, status, release_key_hash, expires_at) 
             VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)`,
            [voucherId, payer_email, recipient_email, amount, selectedCurrency, hashedKey, expiresAt]
        );

        res.status(201).json({ 
            success: true,
            voucherId: voucherId, 
            currency: selectedCurrency,
            releaseKey: rawKey,
            message: `Voucher created in ${selectedCurrency}. Funds will be held once paid.`
        });
    } catch (err) {
        console.error("Voucher Creation Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 2. RELEASE FUNDS
 * Moves money from Recipient's ESCROW to AVAILABLE balance.
 * Deducts 7% fee.
 */
router.post('/release', async (req, res) => {
    const { voucherId, releaseKey, payerEmail } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');

        // Fetch and Lock Voucher row
        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucherId]);
        const v = vResult.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'LOCKED') throw new Error(`Voucher is ${v.status}. Payment must be made before release.`);

        // Validation: Authorized Payer OR Valid Key
        const hashedKey = crypto.createHash('sha256').update(releaseKey || "").digest('hex');
        const isAuthorizedPayer = (payerEmail && v.creator_email === payerEmail);
        const isValidKey = (v.release_key_hash === hashedKey);

        if (!isAuthorizedPayer && !isValidKey) {
            throw new Error("Invalid release key or unauthorized user access.");
        }

        // 7% Platform Fee Calculation
        const fee = parseFloat((v.amount * 0.07).toFixed(4));
        const netAmount = parseFloat(v.amount) - fee;

        // Move funds in Recipient's Wallet
        await client.query(`
            UPDATE wallets SET 
                escrow_balance = escrow_balance - $1,
                available_balance = available_balance + $2,
                updated_at = NOW()
            WHERE user_email = $3`,
            [v.amount, netAmount, v.recipient_email]
        );

        // Mark Voucher as Finished
        await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [v.id]);

        await client.query('COMMIT');
        
        res.json({ 
            success: true, 
            message: "Funds released successfully.",
            data: {
                net_credited: netAmount,
                fee_deducted: fee,
                currency: v.currency
            }
        });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});

/**
 * 3. DISPUTE
 * Freezes the voucher for Admin intervention.
 */
router.post('/dispute', async (req, res) => {
    const { voucherId, userEmail, reason } = req.body;

    try {
        // Only involved parties can dispute
        const result = await query(
            "SELECT * FROM vouchers WHERE id = $1 AND (creator_email = $2 OR recipient_email = $2)",
            [voucherId, userEmail]
        );
        const v = result.rows[0];

        if (!v) return res.status(403).json({ error: "Unauthorized: You are not part of this transaction." });
        if (v.status !== 'LOCKED') return res.status(400).json({ error: "Only vouchers currently in escrow (LOCKED) can be disputed." });

        await query(
            "UPDATE vouchers SET status = 'DISPUTED', dispute_reason = $1, updated_at = NOW() WHERE id = $2",
            [reason || "User initiated dispute", voucherId]
        );

        res.json({ success: true, message: "Voucher disputed. Our team will review the transaction." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;