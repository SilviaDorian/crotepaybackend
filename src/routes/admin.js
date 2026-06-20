import express from 'express';
import { getClient, query } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com';

const authorizeAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
};

const logAction = async (action, target_id, details) => {
    try {
        await query(
            `INSERT INTO admin_audit_logs (admin_email, action, target_id, details) VALUES ($1, $2, $3, $4)`,
            [OWNER_EMAIL, action, target_id, JSON.stringify(details)]
        );
    } catch (err) {
        console.error("Audit Logging Failed:", err);
    }
};

// --- REVENUE & STATS ---
router.get('/stats', authorizeAdmin, async (req, res) => {
    try {
        // Changed to simple string comparison to avoid type cast errors
        const stats = await query(`SELECT SUM(fee) as total_revenue, COUNT(*) as total_transactions 
                                   FROM public.transactions WHERE status = 'SUCCESSFUL'`);
        
        const balance = await query("SELECT available_balance FROM public.wallets WHERE user_email = $1", [OWNER_EMAIL]);
        
        res.json({
            success: true,
            data: {
                lifetime_fees: parseFloat(stats.rows[0].total_revenue || 0).toFixed(4),
                withdrawable_revenue: parseFloat(balance.rows[0]?.available_balance || 0).toFixed(4),
                total_deals: stats.rows[0].total_transactions
            }
        });
    } catch (err) {
        console.error("Stats Error:", err);
        res.status(500).json({ error: "Stats error", details: err.message });
    }
});

router.post('/withdraw', authorizeAdmin, async (req, res) => {
    const { amount, bankCode, accountNumber, currency } = req.body;
    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        
        const walletRes = await client.query("SELECT available_balance FROM wallets WHERE user_email = $1 FOR UPDATE", [OWNER_EMAIL]);
        if (walletRes.rows.length === 0 || walletRes.rows[0].available_balance < amount) throw new Error("Insufficient funds");

        await client.query("UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2", [amount, OWNER_EMAIL]);
        const reference = `REV-WD-${Date.now()}`;
        
        // Removed custom type cast here as well
        await client.query(`INSERT INTO transactions (user_email, transaction_type, amount, status, reference_id) 
                            VALUES ($1, 'SYSTEM_WITHDRAWAL', $2, 'PROCESSING', $3)`, [OWNER_EMAIL, amount, reference]);

        await triggerBankTransfer({ amount, currency: currency || 'NGN', bankCode, accountNumber, reference });
        await logAction('WITHDRAWAL', reference, { amount, currency, bankCode });
        
        await client.query('COMMIT');
        res.json({ success: true, message: "Withdrawal initiated" });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

// --- DISPUTE RESOLUTION ---
router.post('/resolve-dispute', authorizeAdmin, async (req, res) => {
    const { voucher_id, resolution, adminNote } = req.body;
    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        
        const v = (await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucher_id])).rows[0];
        if (!v || v.status !== 'DISPUTED') throw new Error("Invalid state");

        const amount = parseFloat(v.amount);
        const fee = amount * 0.07;

        if (resolution === 'PAY_CREATOR') {
            await client.query("UPDATE wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2 AND currency = $3", [amount, v.recipient_email, v.currency]);
            await client.query("UPDATE wallets SET available_balance = available_balance + $1 WHERE user_email = $2 AND currency = $3", [amount - fee, v.creator_email, v.currency]);
            await client.query("UPDATE wallets SET available_balance = available_balance + $1 WHERE user_email = $2 AND currency = $3", [fee, OWNER_EMAIL, v.currency]);
            await client.query("UPDATE vouchers SET status = 'RELEASED', description = CONCAT(description, ' | Admin Note: ', $1::text) WHERE id = $2", [adminNote || "Resolved", voucher_id]);
        } else {
            await client.query("UPDATE wallets SET escrow_balance = escrow_balance - $1, available_balance = available_balance + $1 WHERE user_email = $2 AND currency = $3", [amount, v.recipient_email, v.currency]);
            await client.query("UPDATE vouchers SET status = 'REFUNDED', description = CONCAT(description, ' | Admin Note: ', $1::text) WHERE id = $2", [adminNote || "Resolved", voucher_id]);
        }
        
        await logAction('RESOLVE_DISPUTE', voucher_id, { resolution, adminNote });
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

// --- GET DISPUTES QUEUE ---
router.get('/disputes', authorizeAdmin, async (req, res) => {
    try {
        const queryText = `
            SELECT 
                id, creator_email, recipient_email, amount, currency, 
                description, dispute_reason, dispute_story, created_at
            FROM public.vouchers 
            WHERE status = 'DISPUTED'
            ORDER BY created_at DESC`;
        
        const { rows } = await query(queryText);
        res.json({ success: true, disputes: rows });
    } catch (err) {
        console.error("Disputes Fetch Error:", err);
        res.status(500).json({ error: "Failed to fetch disputes" });
    }
});

export default router;