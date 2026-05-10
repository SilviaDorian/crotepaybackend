import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com';

/**
 * GET /api/revenue/stats
 * Calculates total fees collected by the system.
 */
router.get('/stats', async (req, res) => {
    const { email } = req.query;

    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Access denied. Admins only." });
    }

    try {
        const stats = await query(
            `SELECT 
                SUM(fee_usd) as total_revenue,
                COUNT(*) as total_transactions
             FROM transactions 
             WHERE transaction_type = 'VOUCHER_RELEASE' AND status = 'SUCCESSFUL'`
        );

        res.json({
            success: true,
            owner: OWNER_EMAIL,
            data: {
                total_fees_collected: parseFloat(stats.rows[0].total_revenue || 0).toFixed(4),
                total_processed_deals: stats.rows[0].total_transactions
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/revenue/withdraw
 * Allows the owner to withdraw system earnings.
 */
router.post('/withdraw', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;

    if (email !== OWNER_EMAIL) {
        return res.status(403).json({ error: "Unauthorized." });
    }

    const client = await getClient();

    try {
        await client.query('BEGIN');

        const walletRes = await client.query(
            "SELECT available_balance FROM wallets WHERE user_email = $1 FOR UPDATE",
            [OWNER_EMAIL]
        );
        
        if (walletRes.rows.length === 0) throw new Error("Owner wallet not found.");
        
        const balance = parseFloat(walletRes.rows[0].available_balance);

        if (balance < parseFloat(amount)) {
            throw new Error("Insufficient revenue balance for withdrawal.");
        }

        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [amount, OWNER_EMAIL]
        );

        const reference = `REV-WD-${Date.now()}`;

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
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// CRITICAL: Ensure this line exists and has no typos
export default router;