import express from 'express';
import crypto from 'crypto';
import axios from 'axios'; // Ensure you run: npm install axios
import { query, getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; 

/**
 * UTILITY: Get Live Conversion to USD
 * Ensures the platform tracks the stable USD value regardless of the voucher currency.
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
        // Fallback calculation or throw error to prevent 400s
        throw new Error("Unable to verify currency exchange rates.");
    }
};

/**
 * 1. CREATE VOUCHER (DATABASE ONLY)
 * Creator = Seller/Service Provider
 * Recipient = Client/Buyer
 */
router.post('/create', async (req, res) => {
    // Destructured exactly what the updated frontend sends
    const { 
        creator_email, 
        recipient_email, 
        recipient_name, 
        amount, 
        currency, 
        description, 
        category 
    } = req.body;

    // Fix for "Missing Field" 400 error: Comprehensive Validation
    if (!creator_email || !recipient_email || !recipient_name || !amount || !currency) {
        return res.status(400).json({ 
            error: "Missing required fields. Name, Email, Amount, and Currency must be provided." 
        });
    }

    try {
        // KYC Check
        const userCheck = await query(
            "SELECT kyc_tier FROM users WHERE email = $1", 
            [creator_email]
        );
        const user = userCheck.rows[0];

        if (!user) return res.status(404).json({ error: "Creator account not found." });
        if (user.kyc_tier < 1) return res.status(403).json({ error: "KYC Tier 1 required to create vouchers." });

        // Calculate USD Equivalent using live API
        const usdValue = await getUsdEquivalent(amount, currency);

        // Hashing & ID Generation
        const rawKey = crypto.randomBytes(8).toString('hex');
        const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
        const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
        
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 14); 

        // Save Voucher to DB with both Original and USD values
        await query(
            `INSERT INTO vouchers (
                id, creator_email, recipient_email, recipient_name, 
                amount, currency, usd_equivalent, status, 
                release_key_hash, expires_at, description, category
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11)`,
            [
                voucherId, creator_email, recipient_email, recipient_name, 
                amount, currency, usdValue, hashedKey, 
                expiresAt, description || "FielPay Escrow", category || "General"
            ]
        );

        res.status(201).json({ 
            success: true,
            voucher_code: voucherId, 
            ref_id: voucherId, // Added for frontend compatibility
            releaseKey: rawKey, 
            message: `Payment request created at $${usdValue.toFixed(2)} USD equivalent.`
        });

    } catch (err) {
        console.error("Create Error:", err.message);
        res.status(500).json({ error: err.message || "Internal server error." });
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

        const voucher = result.rows[0];
        const createdAt = new Date(voucher.created_at);
        
        res.json({
            ...voucher,
            display_date: createdAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
            display_time: createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            created_at_iso: voucher.created_at
        });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

/**
 * 3. RELEASE FUNDS (LEDGER MOVEMENT)
 * Modified to handle fees in the specific voucher currency.
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

        const hashedKey = crypto.createHash('sha256').update(releaseKey || "").digest('hex');
        if (v.release_key_hash !== hashedKey) throw new Error("Invalid release key.");

        const amount = parseFloat(v.amount);
        const fee = parseFloat((amount * 0.07).toFixed(4)); // 7% Fee
        const netAmount = amount - fee;

        // 1. Deduct Client Escrow
        await client.query(
            "UPDATE wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2",
            [amount, v.recipient_email]
        );

        // 2. Add Net to Creator
        await client.query(
            "UPDATE wallets SET available_balance = available_balance + $1 WHERE user_email = $2",
            [netAmount, v.creator_email]
        );

        // 3. System Fee Collection
        await client.query(
            "UPDATE wallets SET available_balance = available_balance + $1 WHERE user_email = $2",
            [fee, OWNER_EMAIL]
        );

        // 4. Log Transaction
        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, fee, status) 
            VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, $5, 'SUCCESSFUL')`,
            [v.creator_email, v.id, netAmount, v.currency, fee]
        );

        await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [v.id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Success! Funds are now in your wallet." });

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
        // Logic: Move status to DISPUTED to freeze any further action
        await query(
            "UPDATE vouchers SET status = 'DISPUTED', description = $1, updated_at = NOW() WHERE id = $2",
            [reason || "User initiated dispute", voucherId]
        );
        res.json({ success: true, message: "Funds frozen for dispute review." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;