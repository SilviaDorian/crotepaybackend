import { getClient } from '../db/index.js';

export async function processBulkEscrowFunding(batchRef = null) {

    let client;

    try {

        console.log('🚀 BULK WORKER START:', batchRef || 'ALL_BATCHES');

        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // --------------------------------------------------
        // STEP 1: FIND LOCKED VOUCHERS
        // --------------------------------------------------
        const result = await client.query(
            `
            SELECT *
            FROM public.vouchers
            WHERE
                status = 'LOCKED'
                AND parent_batch_ref IS NOT NULL
                AND ($1::text IS NULL OR parent_batch_ref = $1)
            FOR UPDATE SKIP LOCKED
            `,
            [batchRef]
        );

        console.log(`📦 FOUND ${result.rows.length} LOCKED vouchers`);

        for (const voucher of result.rows) {

            console.log('TICK ➜', voucher.id);

            const amount = Number(voucher.amount);
            const ref = `BULK-ESCROW-${voucher.id}`;

            // --------------------------------------------------
            // STEP 2: IDEMPOTENCY CHECK (transaction-based)
            // --------------------------------------------------
            const exists = await client.query(
                `SELECT 1 FROM public.transactions WHERE reference_id = $1`,
                [ref]
            );

            if (exists.rowCount > 0) {
                console.log('SKIP (already funded):', voucher.id);
                continue;
            }

            // --------------------------------------------------
            // STEP 3: FUND ESCROW
            // --------------------------------------------------
            await client.query(
                `
                INSERT INTO public.wallets
                (
                    user_email,
                    currency,
                    escrow_balance,
                    available_balance,
                    updated_at
                )
                VALUES
                ($1,$2,$3,0,NOW())

                ON CONFLICT (user_email, currency)
                DO UPDATE SET
                    escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                    updated_at = NOW()
                `,
                [
                    voucher.recipient_email,
                    voucher.currency,
                    amount
                ]
            );

            console.log('FUNDED ➜', voucher.recipient_email, amount);

            // --------------------------------------------------
            // STEP 4: TRANSACTION LOG
            // --------------------------------------------------
            await client.query(
                `
                INSERT INTO public.transactions
                (
                    user_email,
                    voucher_id,
                    transaction_type,
                    amount,
                    currency,
                    fee,
                    status,
                    reference_id,
                    created_at,
                    updated_at
                )
                VALUES
                ($1,$2,'ESCROW_DEPOSIT',$3,$4,0,'SUCCESSFUL',$5,NOW(),NOW())
                ON CONFLICT (reference_id) DO NOTHING
                `,
                [
                    voucher.recipient_email,
                    voucher.id,
                    amount,
                    voucher.currency,
                    ref
                ]
            );

            // --------------------------------------------------
            // STEP 5: MARK PROCESSED (NO escrow_funded NEEDED)
            // --------------------------------------------------
            await client.query(
                `
                UPDATE public.vouchers
                SET
                    updated_at = NOW()
                WHERE id = $1
                `,
                [voucher.id]
            );
        }

        await client.query('COMMIT');

        console.log('✅ BULK WORKER DONE');

    } catch (err) {

        if (client) await client.query('ROLLBACK');

        console.error('❌ BULK WORKER ERROR:', err.message);

    } finally {

        if (client) client.release();
    }
}