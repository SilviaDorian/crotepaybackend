import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com'; // System Revenue Account

/**
 * 1. GET /api/revenue/rates/:currency
 * Added to resolve Dashboard 404s. 
 * Provides exchange rates for the frontend to calculate local currency displays.
 */
router.get('/rates/:currency', (req, res) => {
    const { currency } = req.params;
    
    // Static rates relative to USD (Base 1.0)
    // You can later update this to fetch from a live API like ExchangeRate-API
    const rates = {
        'NGN': 1550.00,
        'GBP': 0.79,
        'EUR': 0.92,
        'USD': 1.00
    };

    const targetCurrency = currency.toUpperCase();
    const rate = rates[targetCurrency];

    if (rate) {
        res.json({ 
            success: true, 
            currency: targetCurrency, 
            rate: rate 
        });
    } else {
        // Fallback to 1.0 if currency not found to prevent dashboard crashes
        res.json({ 
            success: true, 
            currency: targetCurrency, 
            rate: 1.0 
        });
    }
});

/**
 * 2. GET /api/revenue/stats
 * Provides a snapshot of the platform's financial health.
 */
router.get('/stats', async (req, res) => {
    const { email } = req.query;

    // Strict Admin-Only Access
    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Access denied. Admin credentials required." });
    }

    try {
        const stats = await query(
            `SELECT 
                SUM(fee_usd) as total_revenue,
                COUNT(*) as total_transactions
             FROM transactions 
             WHERE transaction_type = 'ESCROW_RELEASE' AND status = 'SUCCESSFUL'`
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
 * Allows admin to move earned commission to bank.
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

        if (balance < parseFloat(amount)) {
            throw new Error("Insufficient revenue balance.");
        }

        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [amount, OWNER_EMAIL]
        );

        const reference = `REV-WD-${Date.now()}-${OWNER_EMAIL}`;

        await client.query(`
            INSERT INTO transactions (
                user_email, transaction_type, amount_usd, status, reference_id
            ) VALUES ($1, $2, $3, $4, $5)`,
            [OWNER_EMAIL, 'SYSTEM_WITHDRAWAL', amount, 'PENDING', reference]
        );

        await triggerBankTransfer({
            amount: parseFloat(amount),
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