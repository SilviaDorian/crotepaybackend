import { getClient } from '../db/index.js';

export async function processBulkEscrowFunding(batchRef) {
    let client;
    try {
        client = await getClient();

        // Use a loop to ensure we handle the batch safely
        const vouchersToFund = await client.query(
            `SELECT id, recipient_email, amount, currency 
             FROM vouchers 
             WHERE parent_batch_ref = $1 
             AND status = 'LOCKED'
             AND id NOT IN (SELECT voucher_id FROM transactions WHERE transaction_type = 'ESCROW_DEPOSIT')
             FOR UPDATE SKIP LOCKED`, 
            [batchRef]
        );

        if (vouchersToFund.rows.length === 0) return;

        for (const v of vouchersToFund.rows) {
            await client.query('BEGIN');
            
            // Fund Wallet
            await client.query(
                `INSERT INTO wallets (user_email, escrow_balance, currency, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_email, currency) 
                 DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                [v.recipient_email, Number(v.amount), v.currency]
            );

            // Create Transaction Record
            await client.query(
                `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                 VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())`,
                [v.recipient_email, v.id, Number(v.amount), v.currency, `AUTO-FUND-${v.id}`]
            );

            await client.query('COMMIT');
        }
        console.log(`✅ Auto-funded ${vouchersToFund.rows.length} vouchers for ${batchRef}`);

    } catch (err) {
        console.error(`❌ Auto-Settler Error:`, err);
    } finally {
        if (client) client.release();
    }
}