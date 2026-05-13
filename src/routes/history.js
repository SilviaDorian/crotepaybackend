import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET /api/history/transactions
 * Fetch all digital ledger records for a user.
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
                voucher_id,
                transaction_type, 
                amount_usd, 
                fee_usd, 
                status, 
                reference_id, 
                created_at 
             FROM transactions 
             WHERE user_email = $1 
             ORDER BY created_at DESC`,
            [email]
        );

        // Enhance the records with human-readable timestamps for the UI
        const transactions = result.rows.map(tx => {
            const dateObj = new Date(tx.created_at);
            return {
                ...tx,
                formatted_date: dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                formatted_time: dateObj.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
            };
        });

        res.json({
            success: true,
            transactions
        });
    } catch (err) {
        console.error("History Error:", err.message);
        res.status(500).json({ error: "Internal server error while fetching history." });
    }
});

/**
 * 2. GET /api/history/summary
 * Returns current digital ledger balances (Available vs Escrow).
 */
router.get('/summary', async (req, res) => {
    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ error: "Email is required." });
    }

    try {
        const result = await query(
            "SELECT available_balance, escrow_balance, currency, updated_at FROM wallets WHERE user_email = $1",
            [email]
        );

        // If no wallet exists yet (e.g., new user), return a default empty ledger
        if (result.rows.length === 0) {
            return res.json({
                success: true,
                wallet: {
                    available_balance: "0.0000",
                    escrow_balance: "0.0000",
                    currency: "USD",
                    message: "Ledger initialized."
                }
            });
        }

        res.json({
            success: true,
            wallet: result.rows[0]
        });
    } catch (err) {
        console.error("Summary Error:", err.message);
        res.status(500).json({ error: "Internal server error while fetching summary." });
    }
});

export default router;