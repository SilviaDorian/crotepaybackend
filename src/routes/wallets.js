import express from 'express';
import { query } from '../db/index.js';

const router = express.Router();

/**
 * 1. GET BALANCE & STATS
 * Implemented "Lazy Settlement" logic to automatically move 
 * funds from awaiting_settlement to available_balance.
 */
router.get('/dashboard/:email', async (req, res) => {
    try {
        const { email } = req.params;

        // 1. ATOMIC SETTLEMENT: Move ONLY matured funds
        // Calculation starts from 'locked_at' to satisfy the escrow duration rule.
        await query(`
            WITH matured_vouchers AS (
                UPDATE public.vouchers
                SET status = 'SETTLED'
                WHERE recipient_email = $1 
                AND status = 'RELEASED' 
                AND (NOW() - locked_at) >= INTERVAL '72 hours'
                RETURNING amount
            )
            UPDATE public.wallets
            SET 
                available_balance = available_balance + (SELECT COALESCE(SUM(amount), 0) FROM matured_vouchers),
                awaiting_settlement = awaiting_settlement - (SELECT COALESCE(SUM(amount), 0) FROM matured_vouchers)
            WHERE user_email = $1 
            AND (SELECT COUNT(*) FROM matured_vouchers) > 0
        `, [email]);

        // 2. Fetch updated Wallet Stats
        const walletRes = await query(
            "SELECT available_balance, escrow_balance, awaiting_settlement, currency FROM public.wallets WHERE user_email = $1", 
            [email]
        );
        
        // 3. Updated Voucher Aggregates
        const statsRes = await query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'LOCKED') as active_escrows,
                COUNT(*) FILTER (WHERE status = 'RELEASED' OR status = 'SETTLED') as total_completed,
                COALESCE(SUM(amount) FILTER (WHERE status = 'LOCKED'), 0) as total_locked_value
             FROM public.vouchers 
             WHERE recipient_email = $1`,
            [email]
        );

        // 4. Get the next upcoming release date (based on locked_at + 72 hours)
        const upcomingRelease = await query(
            `SELECT (locked_at + INTERVAL '72 hours') as release_at
             FROM public.vouchers 
             WHERE recipient_email = $1 AND status = 'RELEASED'
             ORDER BY release_at ASC LIMIT 1`,
            [email]
        );

        const stats = statsRes.rows[0];

        res.json({
            wallets: walletRes.rows.length > 0 ? walletRes.rows : [{ available_balance: "0.00", escrow_balance: "0.00", awaiting_settlement: "0.00", currency: "USD" }],
            summary: {
                active_vouchers: parseInt(stats.active_escrows || 0),
                completed_vouchers: parseInt(stats.total_completed || 0),
                total_locked_usd: parseFloat(stats.total_locked_value || 0),
                next_release_at: upcomingRelease.rows.length > 0 ? upcomingRelease.rows[0].release_at : null
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
        res.status(500).json({ error: "Could not retrieve history." });
    }
});

router.get('/vouchers/settlement-ready', async (req, res) => {
    const { email } = req.query;
    console.log(`[DEBUG] Settlement query initiated for: ${email}`);
    
    try {
        // We will break the query into stages so we can see which part fails
        const result = await query(
            `SELECT id, status, recipient_email, locked_at, updated_at 
             FROM public.vouchers 
             WHERE LOWER(recipient_email) = LOWER($1)`,
            [email]
        );

        console.log(`[DEBUG] Found ${result.rows.length} total vouchers for user.`);
        
        // Filter in JS to identify why they aren't matching
        const matured = result.rows.filter(v => {
            const isReleased = v.status === 'RELEASED';
            const hasLockedAt = v.locked_at !== null;
            // You can add console logs here if needed
            return isReleased && hasLockedAt;
        });

        console.log(`[DEBUG] After filtering (Released + Has locked_at): ${matured.length} remaining.`);

        res.json({ vouchers: matured });
    } catch (err) {
        console.error("[CRITICAL] Settlement Route Error:", err);
        res.status(500).json({ error: err.message });
    }
});
export default router;