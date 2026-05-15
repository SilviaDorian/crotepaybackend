import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET /api/history/wallets
 * NEW: Fetches all sub-wallets (USD, GBP, EUR, etc.) for the dashboard slider
 */
router.get('/wallets', async (req, res) => {
    const { email } = req.query;

    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        const result = await query(
            `SELECT 
                id, 
                currency, 
                available_balance, 
                escrow_balance, 
                max_balance_limit, 
                daily_withdraw_limit 
             FROM wallets 
             WHERE user_email = $1 
             ORDER BY 
                CASE 
                    WHEN currency = 'USD' THEN 1 
                    WHEN currency = 'GBP' THEN 2 
                    WHEN currency = 'EUR' THEN 3 
                    ELSE 4 
                END ASC`,
            [email.toLowerCase().trim()]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Fetch Wallets Error:", err.message);
        res.status(500).json({ error: "Failed to fetch wallets." });
    }
});

/**
 * 2. GET /api/history/wallet-stats
 * Aggregates inflow/outflow across all user activities
 */
router.get('/wallet-stats', async (req, res) => {
    const { email } = req.query;

    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        // Aggregating USD value of all movements for a high-level overview
        const stats = await query(
            `SELECT 
                COALESCE(SUM(CASE 
                    WHEN transaction_type IN ('ESCROW_RELEASE', 'REVERSED') 
                    AND status = 'SUCCESSFUL' THEN amount_usd 
                    ELSE 0 END), 0) as total_in,
                COALESCE(SUM(CASE 
                    WHEN transaction_type = 'WITHDRAWAL' 
                    AND status = 'SUCCESSFUL' THEN amount_usd 
                    ELSE 0 END), 0) as total_out
             FROM transactions WHERE user_email = $1`,
            [email.toLowerCase().trim()]
        );

        // Fetch primary wallet (usually USD or the user's preferred) for legacy support
        const wallet = await query(
            "SELECT available_balance, escrow_balance FROM wallets WHERE user_email = $1 LIMIT 1",
            [email.toLowerCase().trim()]
        );

        res.json({
            success: true,
            balance: parseFloat(wallet.rows[0]?.available_balance || 0),
            escrow: parseFloat(wallet.rows[0]?.escrow_balance || 0),
            inflow: parseFloat(stats.rows[0].total_in),
            outflow: parseFloat(stats.rows[0].total_out)
        });
    } catch (err) {
        console.error("Wallet Stats Error:", err.message);
        res.status(500).json({ error: "Failed to fetch wallet stats" });
    }
});

/**
 * 3. GET /api/history/summary
 */
router.get('/summary', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });
    
    try {
        const wallet = await query(
            "SELECT SUM(available_balance) as total_available, SUM(escrow_balance) as total_escrow FROM wallets WHERE user_email = $1",
            [email.toLowerCase().trim()]
        );
        res.json({
            success: true,
            wallet: wallet.rows[0] || { total_available: 0, total_escrow: 0 }
        });
    } catch (err) {
        res.status(500).json({ error: "Summary error" });
    }
});

/**
 * 4. GET /api/history/transactions
 */
router.get('/transactions', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });

    try {
        const result = await query(
            `SELECT 
                transaction_type, 
                amount_usd, 
                currency,
                status, 
                reference_id, 
                TO_CHAR(created_at, 'DD Mon YYYY, HH:MI AM') as formatted_date 
             FROM transactions 
             WHERE user_email = $1 
             ORDER BY created_at DESC`,
            [email.toLowerCase().trim()]
        );

        res.json({
            success: true,
            transactions: result.rows
        });
    } catch (err) {
        console.error("Transaction Fetch Error:", err.message);
        res.status(500).json({ error: "Transaction fetch error" });
    }
});

export default router;