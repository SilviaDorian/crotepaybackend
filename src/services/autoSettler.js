import { getClient } from '../db/index.js';

/**
 * processBulkEscrowFunding
 * @param {string|null} batchRef - Optional: The specific batch to process.
 */
export async function processBulkEscrowFunding(batchRef = null) {
    let client;
    try {
        client = await getClient();

        // 1. Determine which batches to process
        let targetBatches = [];
        if (batchRef) {
            targetBatches = [batchRef];
        } else {
            // Global Sweep: Find all unique batches with LOCKED vouchers that aren't yet funded
            const res = await client.query(
                `SELECT DISTINCT parent_batch_ref 
                 FROM vouchers 
                 WHERE status = 'LOCKED' 
                 AND id NOT IN (SELECT voucher_id FROM transactions WHERE transaction_type = 'ESCROW_DEPOSIT')`
            );
            targetBatches = res.rows.map(r => r.parent_batch_ref);
        }

        if (targetBatches.length === 0) return;

        console.log(`🚀 AUTO-SETTLER: Processing ${targetBatches.length} batch(es)...`);

        // 2. Process each batch
        for (const bRef of targetBatches) {
            const { rows: vouchers } = await client.query(
                `SELECT id, recipient_email, amount, currency 
                 FROM vouchers 
                 WHERE parent_batch_ref = $1 
                 AND status = 'LOCKED'
                 AND id NOT IN (SELECT voucher_id FROM transactions WHERE transaction_type = 'ESCROW_DEPOSIT')
                 FOR UPDATE SKIP LOCKED`, 
                [bRef]
            );

            for (const v of vouchers) {
                try {
                    await client.query('BEGIN');

                    // Fund Wallet
                    await client.query(
                        `INSERT INTO wallets (user_email, escrow_balance, currency, updated_at)
                         VALUES ($1, $2, $3, NOW())
                         ON CONFLICT (user_email, currency) 
                         DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                        [v.recipient_email, Number(v.amount), v.currency]
                    );

                    // Log Transaction
                    await client.query(
                        `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                         VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())`,
                        [v.recipient_email, v.id, Number(v.amount), v.currency, `AUTO-FUND-${v.id}`]
                    );

                    await client.query('COMMIT');
                    console.log(`✅ AUTO-SETTLER: Successfully funded voucher ${v.id} from batch ${bRef}`);
                } catch (txErr) {
                    await client.query('ROLLBACK');
                    console.error(`❌ AUTO-SETTLER: Failed to fund voucher ${v.id}:`, txErr.message);
                }
            }
        }
    } catch (err) {
        console.error(`❌ AUTO-SETTLER CRITICAL ERROR:`, err);
    } finally {
        if (client) client.release();
    }
}