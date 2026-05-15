import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET /api/history/wallet-stats
 * Optimized to correctly identify money coming in vs. going out
 */
router.get('/wallet-stats', async (req, res) => {
    const { email } = req.query;

    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        // Logic: 
        // Inflow = ESCROW_RELEASE (Creator getting paid) or REVERSED (Withdrawal failed)
        // Outflow = WITHDRAWAL (Successful bank transfer)
        const stats = await query(
            `SELECT 
                COALESCE(SUM(CASE 
                    WHEN transaction_type IN ('ESCROW_RELEASE', 'REVERSED') 
                    AND status = 'SUCCESSFUL'::voucher_status THEN amount_usd 
                    ELSE 0 END), 0) as total_in,
                COALESCE(SUM(CASE 
                    WHEN transaction_type = 'WITHDRAWAL' 
                    AND status = 'SUCCESSFUL'::voucher_status THEN amount_usd 
                    ELSE 0 END), 0) as total_out
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
 * Uses explicit ENUM casting for stability
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