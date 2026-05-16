import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET BALANCE & STATS
 */
router.get('/dashboard/:email', async (req, res) => {
    try {
        const { email } = req.params;

        // 1. Get ALL Wallet Ledgers
        // Explicitly using public schema for reliability
        const walletRes = await query(
            "SELECT available_balance, escrow_balance, currency FROM public.wallets WHERE user_email = $1", 
            [email]
        );
        
        // 2. Get Voucher Aggregates 
        // Note: Using usd_equivalent for the locked value as per your vouchers table schema
        const statsRes = await query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'LOCKED') as active_escrows,
                COUNT(*) FILTER (WHERE status = 'RELEASED') as total_completed,
                COALESCE(SUM(usd_equivalent) FILTER (WHERE status = 'LOCKED'), 0) as total_locked_value
             FROM public.vouchers 
             WHERE creator_email = $1`,
            [email]
        );

        const wallets = walletRes.rows.length > 0 ? walletRes.rows : [{ 
            available_balance: "0.00", 
            escrow_balance: "0.00", 
            currency: "USD" 
        }];

        const stats = statsRes.rows[0];

        res.json({
            wallets: wallets,
            summary: {
                active_vouchers: parseInt(stats.active_escrows || 0),
                completed_vouchers: parseInt(stats.total_completed || 0),
                total_locked_usd: parseFloat(stats.total_locked_value || 0)
            }
        });
    } catch (err) {
        console.error("Dashboard Stats Error:", err.message);
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * 2. TRANSACTION HISTORY
 */
router.get('/history/:email', async (req, res) => {
    try {
        // FIXED: Changed 'amount_usd' to 'amount' to match your DB schema
        const result = await query(
            `SELECT transaction_type, amount, currency, status, created_at, reference_id
             FROM public.transactions 
             WHERE user_email = $1 
             ORDER BY created_at DESC LIMIT 15`,
            [req.params.email]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("History Fetch Error:", err.message);
        // This is where your previous 'column amount_usd does not exist' error was triggered
        res.status(500).json({ error: "Could not retrieve history." });
    }
});

export default router;