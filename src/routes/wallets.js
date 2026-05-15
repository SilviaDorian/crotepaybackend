import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();

/**
 * 1. GET BALANCE & STATS
 * Returns ALL currency ledgers for the user + total aggregates.
 */
router.get('/dashboard/:email', async (req, res) => {
    try {
        const { email } = req.params;

        // 1. Get ALL Wallet Ledgers (Multi-currency support)
        const walletRes = await query(
            "SELECT available_balance, escrow_balance, currency FROM wallets WHERE user_email = $1", 
            [email]
        );
        
        // 2. Get Voucher Aggregates
        // This calculates the total value of active vouchers across all currencies
        const statsRes = await query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'LOCKED'::voucher_status) as active_escrows,
                COUNT(*) FILTER (WHERE status = 'RELEASED'::voucher_status) as total_completed,
                COALESCE(SUM(usd_equivalent) FILTER (WHERE status = 'LOCKED'::voucher_status), 0) as total_locked_value
             FROM vouchers 
             WHERE creator_email = $1`,
            [email]
        );

        // If no wallet exists yet, return a default USD starting point
        const wallets = walletRes.rows.length > 0 ? walletRes.rows : [{ 
            available_balance: "0.00", 
            escrow_balance: "0.00", 
            currency: "USD" 
        }];

        const stats = statsRes.rows[0];

        res.json({
            wallets: wallets, // Changed from 'balances' to 'wallets' array
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
 * Added 'currency' and 'amount' to ensure the UI knows which wallet a transaction belongs to.
 */
router.get('/history/:email', async (req, res) => {
    try {
        const result = await query(
            `SELECT transaction_type, amount, amount_usd, currency, status, created_at 
             FROM transactions 
             WHERE user_email = $1 
             ORDER BY created_at DESC LIMIT 10`,
            [req.params.email]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;