import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    // -----------------------------
    // SECURITY CHECK
    // -----------------------------
    if (!secretHash || signature !== secretHash) {
        console.warn('⚠️ Invalid webhook signature');
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;

    if (!payload?.data) {
        return res.status(200).send('No payload');
    }

    let client;

    try {

        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // Only handle completed charges
        if (payload.event !== 'charge.completed') {
            await client.query('COMMIT');
            return res.status(200).send('Ignored');
        }

        const txRef = payload.data.tx_ref?.trim();
        const status = payload.data.status?.toUpperCase() || 'FAILED';
        const flutterwaveTxId = String(payload.data.id);

        //const batchRef = payload.data.meta?.parent_batch_ref || null;

        const batchRefRaw = payload.data.meta?.parent_batch_ref || null;

const batchRef = batchRefRaw
    ? (batchRefRaw.startsWith("BATCH-")
        ? batchRefRaw
        : `BATCH-${batchRefRaw}`)
    : null;

        console.log(`💳 WEBHOOK: ${txRef} | STATUS: ${status}`);


        if (!txRef) {
            await client.query('COMMIT');
            return res.status(200).send('Missing tx_ref');
        }

        // =========================================================
        // ONLY SUCCESSFUL PAYMENTS PROCEED TO ESCROW FUNDING
        // =========================================================
        if (status !== 'SUCCESSFUL') {
            await client.query('COMMIT');
            return res.status(200).send('Not successful');
        }

        // =========================================================
        // BULK PAYMENT FLOW
        // =========================================================
        if (batchRef) {

            const batchResult = await client.query(
                `
                SELECT *
                FROM vouchers
                WHERE parent_batch_ref = $1
                FOR UPDATE
                `,
                [batchRef]
            );

            if (batchResult.rows.length === 0) {
                await client.query('COMMIT');
                return res.status(200).send('Empty batch');
            }

            for (const v of batchResult.rows) {

                // idempotency guard
                if (v.status !== 'PENDING') continue;

                const amount = Number(v.amount);

                // 1. LOCK VOUCHER
                await client.query(
                    `
                    UPDATE vouchers
                    SET status = 'LOCKED',
                        locked_at = NOW(),
                        updated_at = NOW()
                    WHERE id = $1
                    `,
                    [v.id]
                );

                // 2. FUND ESCROW (2-decimal safe)
                await client.query(
                    `
                    INSERT INTO wallets (
                        user_email,
                        escrow_balance,
                        available_balance,
                        currency,
                        updated_at
                    )
                    VALUES (
                        $1,
                        ROUND($2::numeric,2),
                        0,
                        $3,
                        NOW()
                    )
                    ON CONFLICT (user_email, currency)
                    DO UPDATE SET
                        escrow_balance =
                            wallets.escrow_balance +
                            ROUND(EXCLUDED.escrow_balance,2),
                        updated_at = NOW()
                    `,
                    [
                        v.recipient_email,
                        amount,
                        v.currency
                    ]
                );

                // 3. TRANSACTION LOG
                await client.query(
                    `
                    INSERT INTO transactions (
                        user_email,
                        voucher_id,
                        transaction_type,
                        amount,
                        currency,
                        status,
                        reference_id,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1,$2,'ESCROW_DEPOSIT',$3,$4,'SUCCESSFUL',$5,NOW(),NOW()
                    )
                    ON CONFLICT (reference_id) DO NOTHING
                    `,
                    [
                        v.recipient_email,
                        v.id,
                        amount,
                        v.currency,
                        `FLW-BATCH-${flutterwaveTxId}-${v.id}`
                    ]
                );
            }

            await client.query('COMMIT');
            return res.status(200).send('Batch processed');
        }

        // =========================================================
        // SINGLE VOUCHER FLOW
        // =========================================================

        const voucherResult = await client.query(
            `
            SELECT *
            FROM vouchers
            WHERE id = $1
            FOR UPDATE
            `,
            [txRef]
        );

        if (voucherResult.rows.length === 0) {
            await client.query('COMMIT');
            return res.status(200).send('Voucher not found');
        }

        const v = voucherResult.rows[0];

        if (v.status !== 'PENDING') {
            await client.query('COMMIT');
            return res.status(200).send('Already processed');
        }

        const amount = Number(v.amount);

        // 1. LOCK
        await client.query(
            `
            UPDATE vouchers
            SET status = 'LOCKED',
                locked_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            `,
            [txRef]
        );

        // 2. FUND ESCROW
        await client.query(
            `
            INSERT INTO wallets (
                user_email,
                escrow_balance,
                available_balance,
                currency,
                updated_at
            )
            VALUES (
                $1,
                ROUND($2::numeric,2),
                0,
                $3,
                NOW()
            )
            ON CONFLICT (user_email, currency)
            DO UPDATE SET
                escrow_balance =
                    wallets.escrow_balance +
                    ROUND(EXCLUDED.escrow_balance,2),
                updated_at = NOW()
            `,
            [
                v.recipient_email,
                amount,
                v.currency
            ]
        );

        // 3. TRANSACTION LOG
        await client.query(
            `
            INSERT INTO transactions (
                user_email,
                voucher_id,
                transaction_type,
                amount,
                currency,
                status,
                reference_id,
                created_at,
                updated_at
            )
            VALUES (
                $1,$2,'ESCROW_DEPOSIT',$3,$4,'SUCCESSFUL',$5,NOW(),NOW()
            )
            ON CONFLICT (reference_id) DO NOTHING
            `,
            [
                v.recipient_email,
                v.id,
                amount,
                v.currency,
                `FLW-${flutterwaveTxId}`
            ]
        );

        await client.query('COMMIT');
        return res.status(200).send('Webhook processed');

    } catch (err) {

        if (client) await client.query('ROLLBACK');

        console.error('❌ WEBHOOK ERROR:', err.message);

        return res.status(200).send('Handled error');

    } finally {

        if (client) client.release();
    }
});

export default router;