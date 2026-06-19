import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, getClient } from '../db/index.js';

const router = express.Router();

/**
 * 1. REGISTER (Starts at Tier 1)
 */
router.post('/register', async (req, res) => {
    const { email, password, full_name, country_name, country_code, currency } = req.body;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const hashedPassword = await bcrypt.hash(password, 10);
        const userEmail = email.toLowerCase().trim();

        const check = await client.query(
            "SELECT 1 FROM users WHERE email = $1",
            [userEmail]
        );

        if (check.rows.length > 0) {
            return res.status(400).json({ error: "Email already registered." });
        }

        await client.query(
            `INSERT INTO users (
                email, password_hash, full_name, 
                country_name, country_code, preferred_currency, kyc_tier
            ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
            [
                userEmail,
                hashedPassword,
                full_name,
                country_name,
                country_code,
                (currency || 'USD').toUpperCase()
            ]
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: "Account created!" });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Registration Error:", err.message);
        res.status(400).json({ error: "Registration failed." });
    } finally {
        if (client) client.release();
    }
});

/**
 * 2. LOGIN
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await query(
            "SELECT * FROM public.users WHERE email = $1",
            [email.toLowerCase().trim()]
        );

        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        const token = jwt.sign(
            { email: user.email, kyc_tier: user.kyc_tier },
            process.env.JWT_SECRET || 'fielpay_secret_key_2024',
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: {
                full_name: user.full_name,
                email: user.email,
                currency: user.preferred_currency,
                kyc_tier: parseInt(user.kyc_tier),
                kyc_status: user.kyc_status,
                phone_number: user.phone_number,
                phone_verified: user.phone_verified
            }
        });

    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 8. FORGOT PASSWORD: Generate Token
 */
/**
 * 8. FORGOT PASSWORD: Generate Token
 */
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    try {
        const userEmail = email.toLowerCase().trim();
        const userResult = await query('SELECT id FROM public.users WHERE email = $1', [userEmail]);
        
        // Return 404 if email does not exist
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "This email address does not exist in our records." });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000); // 1 hour expiry

        await query('UPDATE public.users SET reset_token = $1, reset_expires_at = $2 WHERE email = $3', 
            [token, expiresAt, userEmail]);

        // await sendEmail(userEmail, "Reset your password", `...`);
        
        res.json({ message: "A reset link has been sent to your email." });
    } catch (err) {
        res.status(500).json({ error: "Server error." });
    }
});/**
 * 9. RESET PASSWORD: Validate Token & Update
 */
router.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    
    try {
        const userResult = await query(
            'SELECT id FROM public.users WHERE reset_token = $1 AND reset_expires_at > NOW()', 
            [token]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid or expired token." });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await query(
            'UPDATE public.users SET password_hash = $1, reset_token = NULL, reset_expires_at = NULL WHERE id = $2', 
            [hashedPassword, userResult.rows[0].id]
        );
        
        res.json({ success: true, message: "Password reset successful." });
    } catch (err) {
        res.status(500).json({ error: "Reset failed." });
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
        const userEmail = email.toLowerCase().trim();
        await query("DELETE FROM public.verification_codes WHERE email = $1", [userEmail]);
        await query(
            "INSERT INTO public.verification_codes (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')",
            [userEmail, otp]
        );
        await query(
            "UPDATE public.users SET phone_number = $1 WHERE email = $2",
            [phone_number, userEmail]
        );
        res.json({ success: true, code: otp });
    } catch (err) {
        console.error("OTP Error:", err.message);
        res.status(500).json({ error: "Database error." });
    }
});

/**
 * 4. TIER 2: VERIFY OTP
 */
router.post('/verify-phone-otp', async (req, res) => {
    const { email, code } = req.body;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const userEmail = email.toLowerCase().trim();
        const result = await client.query(
            "SELECT * FROM verification_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()",
            [userEmail, code]
        );

        if (result.rows.length === 0) throw new Error("Invalid or expired code.");

        await client.query("UPDATE users SET kyc_tier = 2, phone_verified = true, updated_at = NOW() WHERE email = $1", [userEmail]);
        await client.query("UPDATE wallets SET daily_withdraw_limit = 500.00, max_balance_limit = 2000.00, updated_at = NOW() WHERE user_email = $1", [userEmail]);
        await client.query("DELETE FROM verification_codes WHERE email = $1", [userEmail]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Verification successful. Limits upgraded!" });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * 5. TIER 3: SUBMIT DOCUMENTS (User side)
 */
router.post('/submit-docs', async (req, res) => {
    const { email, document_url, address_url, video_url } = req.body;

    try {
        await query(
            `UPDATE public.users SET 
                document_url = $1, 
                address_url = $2, 
                video_url = $3,
                kyc_status = 'PENDING', 
                updated_at = NOW() 
             WHERE email = $4`,
            [document_url, address_url, video_url, email.toLowerCase().trim()]
        );

        res.json({ success: true, message: "Documents submitted for review." });
    } catch (err) {
        console.error("KYC Submission Error:", err.message);
        res.status(500).json({ error: "Failed to update KYC documents." });
    }
});

/**
 * 6. ADMIN: TRIGGER UPGRADE (Manual Review Approval)
 */
router.post('/admin/upgrade-tier-3', async (req, res) => {
    const { email } = req.body;
    try {
        await query(
            "UPDATE public.users SET kyc_tier = 3, kyc_status = 'VERIFIED', updated_at = NOW() WHERE email = $1", 
            [email.toLowerCase().trim()]
        );

        // Unlimited limits set to a high-precision number
        await query(
            "UPDATE public.wallets SET daily_withdraw_limit = 999999999.00, max_balance_limit = 999999999.00, updated_at = NOW() WHERE user_email = $1",
            [email.toLowerCase().trim()]
        );

        res.json({ success: true, message: "User successfully upgraded to Merchant Pro (Tier 3)." });
    } catch (err) {
        console.error("Admin Upgrade Error:", err.message);
        res.status(500).json({ error: "Upgrade failed." });
    }
});

/**
 * 7. REFRESH USER DATA
 */
router.get('/me/:email', async (req, res) => {
    try {
        const result = await query(
            `SELECT email, full_name, preferred_currency, kyc_tier, kyc_status, phone_verified, phone_number 
             FROM public.users WHERE email = $1`,
            [req.params.email.toLowerCase()]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;