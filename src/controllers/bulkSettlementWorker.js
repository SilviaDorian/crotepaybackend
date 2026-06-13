import { getClient } from '../db/index.js';

// Reusable helper (kept in sync with webhook.js)
async function creditEscrowWallet(client, voucher, isBatch = true) {
    const amount = Number(voucher.amount);
    const ref = isBatch 
        ? `BULK-ESCROW-${voucher.id}` 
        : `FLW-${voucher.id}`;  // fallback for single if needed

    // Robust wallet UPSERT
    await client.query(
        `INSERT INTO public.wallets 
         (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
         VALUES ($1, $2, $3, 0, 0, NOW())
         ON CONFLICT (user_email, currency) 
         DO UPDATE SET 
             escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
             updated_at = NOW()`,
        [voucher.recipient_email, voucher.currency.toUpperCase(), amount]
    );

    // Idempotent transaction log
    await client.query(
        `INSERT INTO public.transactions 
         (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
         VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
         ON CONFLICT (reference_id) DO NOTHING`,
        [voucher.recipient_email, voucher.id, amount, voucher.currency, ref]
    );
}

export async function processBulkEscrowFunding(batchRef = null) {
    let client;

    try {
        console.log('🚀 BULK SETTLEMENT WORKER START:', batchRef || 'ALL_PENDING_BATCHES');

        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // Find LOCKED vouchers that haven't been funded yet
        const result = await client.query(
            `
            SELECT v.*
            FROM public.vouchers v
            LEFT JOIN public.transactions t 
                ON t.reference_id = 'BULK-ESCROW-' || v.id 
                AND t.status = 'SUCCESSFUL'
            WHERE v.status = 'LOCKED'
              AND v.parent_batch_ref IS NOT NULL
              AND ($1::text IS NULL OR v.parent_batch_ref = $1)
              AND t.reference_id IS NULL  -- Only unfunded ones
            FOR UPDATE SKIP LOCKED
            `,
            [batchRef]
        );

        console.log(`📦 FOUND ${result.rows.length} unfunded LOCKED vouchers`);

        for (const voucher of result.rows) {
            console.log('TICK ➜ Processing funding for voucher:', voucher.id);

            try {
                await creditEscrowWallet(client, voucher, true);
                console.log('✅ FUNDED ➜', voucher.recipient_email, Number(voucher.amount));
            } catch (voucherErr) {
                console.error(`❌ Failed to fund voucher ${voucher.id}:`, voucherErr.message);
                // Continue with other vouchers (don't fail the whole batch)
            }
        }

        await client.query('COMMIT');
        console.log('✅ BULK SETTLEMENT WORKER COMPLETED SUCCESSFULLY');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ BULK SETTLEMENT WORKER CRITICAL ERROR:', err.message);
    } finally {
        if (client) client.release();
    }
}