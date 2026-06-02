import { query } from '../db/index.js';

/**
 * runSettlementLogic scans for 'ESCROW_RELEASE' transactions.
 * It uses the 'locked_at' timestamp from the vouchers table 
 * to enforce the 72-hour settlement maturity rule.
 */
export async function runSettlementLogic() {
    console.log(`[${new Date().toISOString()}] Starting internal settlement sweep based on locked_at...`);

    try {
        // Query logic: 
        // 1. Join with vouchers to access the 'locked_at' timestamp.
        // 2. Filter for successful releases currently in 'awaiting_settlement'.
        // 3. Enforce the 72-hour rule starting from the 'locked_at' timestamp.
        const settleableTxs = await query(`
            SELECT t.id, t.user_email, t.amount, t.currency, v.locked_at 
            FROM public.transactions t
            JOIN public.vouchers v ON t.voucher_id = v.id
            WHERE t.transaction_type = 'ESCROW_RELEASE'
            AND t.status = 'SUCCESSFUL'
            AND (NOW() - v.locked_at) >= INTERVAL '72 hours'
            AND EXISTS (
                SELECT 1 FROM public.wallets w 
                WHERE w.user_email = t.user_email 
                AND w.currency = t.currency 
                AND w.awaiting_settlement >= t.amount
            )
        `);

        console.log(`[${new Date().toISOString()}] Found ${settleableTxs.rowCount} vouchers matured to available balance.`);

        for (const tx of settleableTxs.rows) {
            await finalizeIndividualSettlement(tx);
        }
        
        console.log(`[${new Date().toISOString()}] Settlement sweep complete.`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Fatal error in reconciliation sweep:`, err);
        throw err; 
    }
}

async function finalizeIndividualSettlement(tx) {
    try {
        await query('BEGIN');
        
        // Move from 'awaiting_settlement' to 'available_balance'
        await query(`
            UPDATE public.wallets 
            SET awaiting_settlement = awaiting_settlement - $1,
                available_balance = available_balance + $1,
                updated_at = NOW()
            WHERE user_email = $2 AND currency = $3`,
            [tx.amount, tx.user_email, tx.currency]
        );

        // Mark as SETTLED
        await query("UPDATE public.transactions SET status = 'SETTLED' WHERE id = $1", [tx.id]);
        
        await query('COMMIT');
        console.log(`[${new Date().toISOString()}] Settlement successful for TX: ${tx.id}`);
    } catch (err) { 
        await query('ROLLBACK');
        console.error(`[${new Date().toISOString()}] Failed to settle transaction ${tx.id}:`, err);
    }
}