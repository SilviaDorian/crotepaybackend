import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, getClient } from '../db/index.js';

const router = express.Router();

/**
 * 1. REGISTER (Starts at Tier 1)
 * Wallet Limit: $500 | Withdrawal Limit: $0
 */
router.post('/register', async (req, res) => {
    const { email, password, full_name, country_name, country_code, currency } = req.body;
    const client = await getClient();

    if (!email || !password || !currency || !country_code) {
        return res.status(400).json({ error: "Required: Email, Password, Currency, and Country Code." });
    }

    try {
        await client.query('BEGIN');

        const hashedPassword = await bcrypt.hash(password, 10);
        const selectedCurrency = currency.toUpperCase();
        const isoCode = country_code.toUpperCase().substring(0, 2);

        // 1. Create User (Tier 1)
        await client.query(
            `INSERT INTO users (
                email, password_hash, full_name, 
                country_name, country_code, preferred_currency, kyc_tier
            ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
            [email, hashedPassword, full_name, country_name, isoCode, selectedCurrency]
        );

        // 2. Initialize Wallet with Tier 1 Limits
        await client.query(
            `INSERT INTO wallets (user_email, currency, max_balance_limit, daily_withdraw_limit) 
             VALUES ($1, $2, 500.00, 0.00)`,
            [email, selectedCurrency]
        );

        await client.query('COMMIT');
        res.status(201).json({ 
            success: true, 
            message: "Account created (Tier 1). Verify phone to enable withdrawals." 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: "Registration failed. Email might already exist." });
    } finally {
        client.release();
    }
});

/**
 * 2. LOGIN (Null-Safe for Phone Numbers)
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = (await query("SELECT * FROM users WHERE email = $1", [email])).rows[0];
        
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        const token = jwt.sign(
            { email: user.email, kyc_tier: user.kyc_tier }, 
            process.env.JWT_SECRET || 'fallback_secret', 
            { expiresIn: '24h' }
        );

        res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id,
                full_name: user.full_name ?? "User", 
                email: user.email, 
                currency: user.preferred_currency ?? "USD",
                kyc_tier: user.kyc_tier ?? 1,
                kyc_status: user.kyc_status ?? 'NONE',
                // Explicitly handling the early-stage null phone
                phone_number: user.phone_number ?? null, 
                phone_verified: user.phone_verified ?? false
            } 
        });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Server error during login." });
    }
});

/**
 * 3. TIER 2: REQUEST PHONE OTP
 */
router.post('/request-phone-otp', async (req, res) => {
    const { email, phone_number } = req.body;
    if (!email || !phone_number) return res.status(400).json({ error: "Email and Phone required." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        await query("DELETE FROM verification_codes WHERE email = $1", [email]); // Clear old codes
        await query("INSERT INTO verification_codes (email, code) VALUES ($1, $2)", [email, otp]);
        
        // Update phone number pending verification
        await query("UPDATE users SET phone_number = $1 WHERE email = $2", [phone_number, email]);

        // LOG TO CONSOLE (Replace with real SMS API like Twilio/Termii later)
        console.log(`\n[SMS OTP] To: ${phone_number} | Code: ${otp}\n`);

        res.json({ success: true, message: "Verification code sent to your phone." });
    } catch (err) {
        res.status(500).json({ error: "Failed to send OTP." });
    }
});

/**
 * 4. TIER 2: VERIFY OTP (Upgrade to Tier 2)
 * Wallet: $2,000 | Withdrawal: $500/day
 */
router.post('/verify-phone-otp', async (req, res) => {
    const { email, code } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            "SELECT * FROM verification_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()",
            [email, code]
        );

        if (result.rows.length === 0) {
            throw new Error("Invalid or expired code.");
        }

        // Upgrade User
        await client.query(
            "UPDATE users SET kyc_tier = 2, phone_verified = true WHERE email = $1",
            [email]
        );

        // Update Limits
        await client.query(
            "UPDATE wallets SET daily_withdraw_limit = 500.00, max_balance_limit = 2000.00 WHERE user_email = $1",
            [email]
        );

        await client.query("DELETE FROM verification_codes WHERE email = $1", [email]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Tier 2 Verified! Withdrawal limits increased." });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * 5. TIER 3: SUBMIT DOCUMENTS (Manual Review)
 */
router.post('/submit-docs', async (req, res) => {
    const { email, tax_id, document_url, is_pep } = req.body;

    if (!tax_id || !document_url) {
        return res.status(400).json({ error: "Tax ID and Document image URL are required." });
    }

    try {
        await query(
            `UPDATE users SET 
                tax_id = $1, 
                document_url = $2, 
                is_pep = $3, 
                kyc_status = 'PENDING', 
                updated_at = NOW() 
             WHERE email = $4`,
            [tax_id, document_url, is_pep || false, email]
        );

        res.json({ success: true, message: "Documents received. Admin will review shortly." });
    } catch (err) {
        res.status(500).json({ error: "Failed to submit documents." });
    }
});

export default router;