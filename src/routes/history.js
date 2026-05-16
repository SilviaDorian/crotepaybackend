import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET /api/history/wallets
 */
router.get('/wallets', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        // Kept 'currency' because it exists in your schema!
        const result = await query(
            `SELECT 
                currency, 
                available_balance, 
                escrow_balance
             FROM public.wallets 
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
        res.status(500).json({ error: "Database error fetching wallets." });
    }
});

/**
 * 2. GET /api/history/transactions
 */
router.get('/transactions', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });

    try {
        // FIXED: Changed 'amount_usd' to 'amount'
        // FIXED: Added 'currency' back because your schema confirmed it exists
        const result = await query(
            `SELECT 
                transaction_type, 
                amount, 
                currency,
                status, 
                reference_id, 
                TO_CHAR(created_at, 'DD Mon YYYY, HH:MI AM') as formatted_date 
             FROM public.transactions 
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
        res.status(500).json({ error: "Database error fetching transactions." });
    }
});

/**
 * 3. GET /api/history/wallet-stats
 */
router.get('/wallet-stats', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });

    try {
        // FIXED: Changed 'amount_usd' to 'amount' in the SUM logic
        const stats = await query(
            `SELECT 
                COALESCE(SUM(CASE WHEN transaction_type IN ('ESCROW_RELEASE', 'REVERSED') AND status = 'SUCCESSFUL' THEN amount ELSE 0 END), 0) as total_in,
                COALESCE(SUM(CASE WHEN transaction_type = 'WITHDRAWAL' AND status = 'SUCCESSFUL' THEN amount ELSE 0 END), 0) as total_out
             FROM public.transactions WHERE user_email = $1`,
            [email.toLowerCase().trim()]
        );

        const wallet = await query(
            "SELECT available_balance, escrow_balance FROM public.wallets WHERE user_email = $1 LIMIT 1",
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
        console.error("Stats error:", err.message);
        res.status(500).json({ error: "Stats error" });
    }
});

export default router;