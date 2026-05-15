import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; 

/**
 * 1. GET /api/revenue/rates/:currency
 * Provides exchange rates for frontend calculations.
 */
router.get('/rates/:currency', async (req, res) => {
    const { currency } = req.params;
    
    // Default fallback rates
    const rates = {
        'NGN': 1550.00,
        'GBP': 0.79,
        'EUR': 0.92,
        'USD': 1.00
    };

    const targetCurrency = currency.toUpperCase();
    const rate = rates[targetCurrency] || 1.0;

    res.json({ 
        success: true, 
        currency: targetCurrency, 
        rate: rate 
    });
});

/**
 * 2. GET /api/revenue/stats
 * Dashboard data for the Admin (OWNER_EMAIL).
 */
router.get('/stats', async (req, res) => {
    const { email } = req.query;

    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Access denied. Admin credentials required." });
    }

    try {
        // Updated to sum fees from both Escrow Releases and Withdrawals
        const stats = await query(
            `SELECT 
                SUM(fee_usd) as total_revenue,
                COUNT(*) as total_transactions
             FROM transactions 
             WHERE status = 'SUCCESSFUL'::voucher_status`
        );

        const currentBalance = await query(
            "SELECT available_balance FROM wallets WHERE user_email = $1",
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
 * 3. POST /api/revenue/withdraw
 * Moves Admin commission to bank.
 */
router.post('/withdraw', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;

    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Unauthorized access." });
    }

    const client = await getClient();

    try {
        await client.query('BEGIN');

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

        // 1. Deduct from Admin Wallet
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [withdrawalAmount, OWNER_EMAIL]
        );

        // 2. Generate Reference (Sanitized)
        const reference = `REV-WD-${Date.now()}-${OWNER_EMAIL.replace('@', '_at_')}`;

        // 3. Log Transaction
        await client.query(`
            INSERT INTO transactions (
                user_email, transaction_type, amount_usd, status, reference_id
            ) VALUES ($1, $2, $3, 'PROCESSING'::voucher_status, $4)`,
            [OWNER_EMAIL, 'SYSTEM_WITHDRAWAL', withdrawalAmount, reference]
        );

        // 4. Trigger Payout
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