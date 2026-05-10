import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, getClient } from '../db/index.js'; // Added getClient for transaction safety

const router = express.Router();

/**
 * 1. REGISTER
 * Now includes 'currency' and automatically creates the user's wallet.
 */
router.post('/register', async (req, res) => {
    const { email, password, full_name, country, currency } = req.body;
    const client = await getClient();

    if (!email || !password || !currency) {
        return res.status(400).json({ error: "Email, password, and currency are required." });
    }

    try {
        await client.query('BEGIN');

        const hashedPassword = await bcrypt.hash(password, 10);
        const selectedCurrency = currency.toUpperCase();

        // 1. Create the User
        await client.query(
            "INSERT INTO users (email, password_hash, full_name, country, preferred_currency) VALUES ($1, $2, $3, $4, $5)",
            [email, hashedPassword, full_name, country, selectedCurrency]
        );

        // 2. Initialize the Wallet immediately
        // This ensures the dashboard doesn't error out when a new user logs in.
        await client.query(
            "INSERT INTO wallets (user_email, available_balance, escrow_balance, currency) VALUES ($1, 0.00, 0.00, $2)",
            [email, selectedCurrency]
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: "Account and wallet created successfully!" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Registration Error:", err.message);
        res.status(400).json({ error: "Registration failed. Email might already exist." });
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
        const user = (await query("SELECT * FROM users WHERE email = $1", [email])).rows[0];
        
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        // Create JWT Token
        const token = jwt.sign(
            { email: user.email, name: user.full_name }, 
            process.env.JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({ 
            success: true, 
            token, 
            user: { 
                email: user.email, 
                name: user.full_name,
                currency: user.preferred_currency 
            } 
        });
    } catch (err) {
        res.status(500).json({ error: "Server error during login." });
    }
});

export default router;