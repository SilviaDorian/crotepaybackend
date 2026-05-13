import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();

/**
 * 1. GET BALANCE & STATS
 * Returns the Available and Escrow balances, plus dashboard aggregates.
 */
router.get('/dashboard/:email', async (req, res) => {
    try {
        const { email } = req.params;

        // 1. Get Wallet Ledgers
        const walletRes = await query(
            "SELECT available_balance, escrow_balance, currency FROM wallets WHERE user_email = $1", 
            [email]
        );
        
        // 2. Get Voucher Aggregates for the Creator
        const statsRes = await query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'LOCKED') as active_escrows,
                COUNT(*) FILTER (WHERE status = 'RELEASED') as total_completed,
                COALESCE(SUM(amount) FILTER (WHERE status = 'LOCKED'), 0) as total_locked_value
             FROM vouchers 
             WHERE creator_email = $1`,
            [email]
        );

        const wallet = walletRes.rows[0] || { available_balance: "0.00", escrow_balance: "0.00", currency: "USD" };
        const stats = statsRes.rows[0];

        res.json({
            balances: {
                available: wallet.available_balance,
                escrow: wallet.escrow_balance,
                currency: wallet.currency
            },
            summary: {
                active_vouchers: parseInt(stats.active_escrows),
                completed_vouchers: parseInt(stats.total_completed),
                total_locked_usd: parseFloat(stats.total_locked_value)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 2. WITHDRAW FUNDS
 * Physical movement: Your Merchant Account -> Creator's Bank Account.
 */
router.post('/withdraw', async (req, res) => {
    const { email, amount, bankCode, accountNumber } = req.body;
    const client = await getClient();

    if (!email || !amount || !bankCode || !accountNumber) {
        return res.status(400).json({ error: "Missing withdrawal details." });
    }

    try {
        await client.query('BEGIN');

        // Fetch and Lock Wallet to prevent race conditions
        const wResult = await client.query(
            "SELECT * FROM wallets WHERE user_email = $1 FOR UPDATE", 
            [email]
        );
        const wallet = wResult.rows[0];

        if (!wallet || parseFloat(wallet.available_balance) < parseFloat(amount)) {
            throw new Error("Insufficient available balance for withdrawal.");
        }

        // 1. Deduct from internal ledger first
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [amount, email]
        );

        // 2. Trigger Real Bank Transfer (Physical money leaves your Merchant Account)
        const payout = await triggerBankTransfer({
            amount,
            currency: wallet.currency || 'USD',
            bankCode,
            accountNumber,
            reference: `FP-WD-${Date.now()}-${email.split('@')[0]}`
        });

        if (payout.status !== 'success') {
            throw new Error(payout.message || "Flutterwave payout failed.");
        }

        // 3. Log the physical movement in transactions
        await client.query(
            `INSERT INTO transactions (user_email, transaction_type, amount_usd, status, reference_id) 
             VALUES ($1, 'WITHDRAWAL', $2, 'SUCCESSFUL', $3)`,
            [email, amount, payout.data.id || `WD-${Date.now()}`]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Withdrawal initiated successfully." });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});

/**
 * 3. TRANSACTION HISTORY
 */
router.get('/history/:email', async (req, res) => {
    try {
        const result = await query(
            `SELECT * FROM transactions 
             WHERE user_email = $1 
             ORDER BY created_at DESC LIMIT 50`,
            [req.params.email]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;