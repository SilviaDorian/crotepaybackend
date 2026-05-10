import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * GET /api/history/transactions
 * Fetch all audit trail records for a user
 */
router.get('/transactions', async (req, res) => {
    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ error: "User email is required." });
    }

    try {
        const result = await query(
            `SELECT 
                id, 
                transaction_type, 
                amount_usd, 
                fee_usd, 
                local_amount, 
                local_currency, 
                status, 
                reference_id, 
                created_at 
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
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/history/summary
 * Returns current wallet balances
 */
router.get('/summary', async (req, res) => {
    const { email } = req.query;

    try {
        const result = await query(
            "SELECT available_balance, escrow_balance, currency FROM wallets WHERE user_email = $1",
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Wallet not found." });
        }

        res.json({
            success: true,
            wallet: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CRITICAL: This is what was likely missing or named incorrectly[cite: 1]
export default router;