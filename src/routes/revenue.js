import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; 

// Centralized rates object for consistency
const LIVE_RATES = {
    'NGN': 1550.00,
    'GBP': 0.79,
    'EUR': 0.92,
    'GHS': 14.50,
    'USD': 1.00
};

/**
 * 1. GET /api/revenue/rates/all
 */
router.get('/rates/all', (req, res) => {
    res.json(LIVE_RATES);
});

/**
 * 2. GET /api/revenue/rates/:currency
 */
router.get('/rates/:currency', async (req, res) => {
    const { currency } = req.params;
    const targetCurrency = currency.toUpperCase();
    const rate = LIVE_RATES[targetCurrency] || 1.0;

    res.json({ 
        success: true, 
        currency: targetCurrency, 
        rate: rate 
    });
});

/**
 * 3. GET /api/revenue/stats
 * Dashboard data for the Admin (OWNER_EMAIL).
 */
router.get('/stats', async (req, res) => {
    const { email } = req.query;

    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Access denied. Admin credentials required." });
    }

    try {
        // FIXED: Changed fee_usd to fee
        const stats = await query(
            `SELECT 
                SUM(fee) as total_revenue,
                COUNT(*) as total_transactions
             FROM public.transactions 
             WHERE status = 'SUCCESSFUL'::text::voucher_status`
        );

        const currentBalance = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1",
            [OWNER_EMAIL]
        );

        res.json({
            success: true,
            owner: OWNER_EMAIL,
            data: {
                lifetime_fees_collected: parseFloat(stats.rows[0].total_revenue || 0).toFixed(4),
                withdrawable_revenue: parseFloat(currentBalance.rows[0]?.available_balance || 0).toFixed(4),
                total_processed_deals: stats.rows[0].total_transactions
            }
        });
    } catch (err) {
        console.error("Revenue Stats Error:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

/**
 * 4. POST /api/revenue/withdraw
 * Moves Admin commission to bank.
 */
router.post('/withdraw', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;

    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Unauthorized access." });
    }

    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const walletRes = await client.query(
            "SELECT available_balance FROM wallets WHERE user_email = $1 FOR UPDATE",
            [OWNER_EMAIL]
        );
        
        if (walletRes.rows.length === 0) throw new Error("Revenue wallet not found.");
        
        const balance = parseFloat(walletRes.rows[0].available_balance);
        const withdrawalAmount = parseFloat(amount);

        if (balance < withdrawalAmount) {
            throw new Error("Insufficient revenue balance.");
        }

        // FIXED: Using updated_at to match wallet schema
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [withdrawalAmount, OWNER_EMAIL]
        );

        const reference = `REV-WD-${Date.now()}-${OWNER_EMAIL.replace('@', '_at_')}`;

        // FIXED: amount_usd -> amount | added ::text::voucher_status
        await client.query(`
            INSERT INTO transactions (
                user_email, transaction_type, amount, status, reference_id
            ) VALUES ($1, $2, $3, 'PROCESSING'::text::voucher_status, $4)`,
            [OWNER_EMAIL, 'SYSTEM_WITHDRAWAL', withdrawalAmount, reference]
        );

        await triggerBankTransfer({
            amount: withdrawalAmount,
            currency: currency || 'NGN',
            bankCode,
            accountNumber,
            reference
        });

        await client.query('COMMIT');
        res.json({ success: true, message: "Revenue withdrawal initiated." });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Revenue Withdrawal Error:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

export default router;