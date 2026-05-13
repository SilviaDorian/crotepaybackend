import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET /api/history/wallet-stats
 * Fixes Dashboard 404: Fetches balance, total inflow, and outflow.
 */
router.get('/wallet-stats', async (req, res) => {
    const { email } = req.query;

    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        const stats = await query(
            `SELECT 
                COALESCE(SUM(CASE WHEN amount_usd > 0 AND status = 'SUCCESSFUL' THEN amount_usd ELSE 0 END), 0) as total_in,
                COALESCE(SUM(CASE WHEN amount_usd < 0 AND status = 'SUCCESSFUL' THEN ABS(amount_usd) ELSE 0 END), 0) as total_out
             FROM transactions WHERE user_email = $1`,
            [email]
        );

        const wallet = await query(
            "SELECT available_balance, escrow_balance FROM wallets WHERE user_email = $1",
            [email]
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
 * 2. GET /api/history/summary
 * Specifically used by the History HTML page for top cards.
 */
router.get('/summary', async (req, res) => {
    const { email } = req.query;
    try {
        const wallet = await query(
            "SELECT available_balance, escrow_balance FROM wallets WHERE user_email = $1",
            [email]
        );
        res.json({
            success: true,
            wallet: wallet.rows[0] || { available_balance: 0, escrow_balance: 0 }
        });
    } catch (err) {
        res.status(500).json({ error: "Summary error" });
    }
});

/**
 * 3. GET /api/history/transactions
 * Fetches the full list for the history table.
 */
router.get('/transactions', async (req, res) => {
    const { email } = req.query;
    try {
        const result = await query(
            `SELECT 
                transaction_type, 
                amount_usd, 
                status, 
                reference_id, 
                TO_CHAR(created_at, 'DD Mon YYYY, HH:MI AM') as formatted_date 
             FROM transactions 
             WHERE user_email = $1 
             ORDER BY created_at DESC`,
            [email]
        );

        res.json({
            success: true,
            transactions: result.rows
        });
    } catch (err) {
        res.status(500).json({ error: "Transaction fetch error" });
    }
});

export default router;