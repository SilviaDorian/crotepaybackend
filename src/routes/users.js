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
            [email.toLowerCase().trim(), hashedPassword, full_name, country_name, isoCode, selectedCurrency]
        );

        // 2. Initialize Ledger Wallet with Tier 1 Limits
        await client.query(
            `INSERT INTO wallets (user_email, currency, max_balance_limit, daily_withdraw_limit) 
             VALUES ($1, $2, 500.00, 0.00)`,
            [email.toLowerCase().trim(), selectedCurrency]
        );

        await client.query('COMMIT');
        res.status(201).json({ 
            success: true, 
            message: "Account created (Tier 1). Verify phone to enable withdrawals." 
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Registration Error:", err.message);
        res.status(400).json({ error: "Registration failed. This email is likely already in use." });
    } finally {
        client.release();
    }
});

/**
 * 2. LOGIN
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
        const user = result.rows[0];
        
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
                full_name: user.full_name || "User", 
                email: user.email, 
                currency: user.preferred_currency || "USD",
                kyc_tier: parseInt(user.kyc_tier) || 1,
                kyc_status: user.kyc_status || 'NONE',
                phone_number: user.phone_number || null, 
                phone_verified: user.phone_verified || false
            } 
        });
    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 3. TIER 2: REQUEST PHONE OTP
 * Fixed: Added verbose logging to identify 500 errors.
 */
router.post('/request-phone-otp', async (req, res) => {
    const { email, phone_number } = req.body;
    
    if (!email || !phone_number) {
        return res.status(400).json({ error: "Email and Phone required." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        // Log start for debugging
        console.log(`[OTP] Processing request for ${email}`);

        // Ensure clean inputs
        const userEmail = email.toLowerCase().trim();

        // Transactional update to ensure codes are saved
        await query("DELETE FROM verification_codes WHERE email = $1", [userEmail]); 
        
        // This is the common failure point if table 'verification_codes' is missing
        await query(
            "INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')", 
            [userEmail, otp]
        );
        
        await query("UPDATE users SET phone_number = $1 WHERE email = $2", [phone_number, userEmail]);

        console.log(`\n[SMS GATEWAY SIMULATION]\nTo: ${phone_number}\nCode: ${otp}\n`);

        res.json({ success: true, message: "Verification code sent." });
    } catch (err) {
        // Detailed log to Vercel/Server console
        console.error("CRITICAL OTP ERROR:", err.message);
        res.status(500).json({ 
            error: "Failed to process OTP request.",
            details: err.message // Helps identify missing tables
        });
    }
});

/**
 * 4. TIER 2: VERIFY OTP (Upgrade to Tier 2)
 */
router.post('/verify-phone-otp', async (req, res) => {
    const { email, code } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');
        const userEmail = email.toLowerCase().trim();

        const result = await client.query(
            "SELECT * FROM verification_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()",
            [userEmail, code]
        );

        if (result.rows.length === 0) {
            throw new Error("Invalid or expired code.");
        }

        // Upgrade User
        await client.query(
            "UPDATE users SET kyc_tier = 2, phone_verified = true, updated_at = NOW() WHERE email = $1",
            [userEmail]
        );

        // Increase Ledger Limits
        await client.query(
            "UPDATE wallets SET daily_withdraw_limit = 500.00, max_balance_limit = 2000.00, updated_at = NOW() WHERE user_email = $1",
            [userEmail]
        );

        await client.query("DELETE FROM verification_codes WHERE email = $1", [userEmail]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Verification successful. Limits upgraded!" });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Verification Error:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * 5. TIER 3: SUBMIT DOCUMENTS
 */
router.post('/submit-docs', async (req, res) => {
    const { email, tax_id, document_url, video_url } = req.body;

    if (!tax_id || !document_url) {
        return res.status(400).json({ error: "Documents and Tax ID are required." });
    }

    try {
        await query(
            `UPDATE users SET 
                tax_id = $1, 
                document_url = $2, 
                video_url = $3,
                kyc_status = 'PENDING', 
                updated_at = NOW() 
             WHERE email = $4`,
            [tax_id, document_url, video_url || null, email.toLowerCase().trim()]
        );

        res.json({ success: true, message: "Documents submitted for manual review." });
    } catch (err) {
        console.error("KYC Submission Error:", err.message);
        res.status(500).json({ error: "Failed to update KYC documents." });
    }
});

export default router;