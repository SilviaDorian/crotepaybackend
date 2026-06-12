import { getClient } from '../db/index.js';

export async function processBulkEscrowFunding() {

    let client;

    try {

        client = await getClient();

        await client.query('BEGIN');

        /**
         * Find all bulk vouchers that:
         * - are LOCKED
         * - belong to a batch
         * - have not yet been funded
         *
         * FOR UPDATE SKIP LOCKED prevents duplicate funding
         * when many workers run simultaneously.
         */

        const vouchersResult = await client.query(
            `
            SELECT *
            FROM public.vouchers
            WHERE
                status = 'LOCKED'
                AND parent_batch_ref IS NOT NULL
                AND escrow_funded = FALSE
            FOR UPDATE SKIP LOCKED
            `
        );

        for (const voucher of vouchersResult.rows) {

            const amount = Number(voucher.amount);

            /**
             * FUND RECIPIENT ESCROW WALLET
             */
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
                (
                    $1,
                    $2,
                    $3,
                    0,
                    NOW()
                )

                ON CONFLICT (user_email, currency)

                DO UPDATE SET

                    escrow_balance =
                        wallets.escrow_balance + EXCLUDED.escrow_balance,

                    updated_at = NOW()
                `,
                [
                    voucher.recipient_email,
                    voucher.currency,
                    amount
                ]
            );

            /**
             * CREATE TRANSACTION RECORD
             */
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
                (
                    $1,
                    $2,
                    'ESCROW_DEPOSIT',
                    $3,
                    $4,
                    0,
                    'SUCCESSFUL',
                    $5,
                    NOW(),
                    NOW()
                )

                ON CONFLICT (reference_id)
                DO NOTHING
                `,
                [
                    voucher.recipient_email,
                    voucher.id,
                    amount,
                    voucher.currency,
                    `BULK-ESCROW-${voucher.id}`
                ]
            );

            /**
             * MARK THIS VOUCHER AS ALREADY FUNDED
             */
            await client.query(
                `
                UPDATE public.vouchers
                SET
                    escrow_funded = TRUE,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [voucher.id]
            );

        }

        await client.query('COMMIT');

    } catch (err) {

        if (client) {
            await client.query('ROLLBACK');
        }

        console.error(
            '❌ BULK SETTLEMENT WORKER ERROR:',
            err.message
        );

    } finally {

        if (client) {
            client.release();
        }

    }
}