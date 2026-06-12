import express from 'express';
import { getClient } from '../db/index.js';
import { processBulkEscrowFunding } from '../services/autoSettler.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;
    if (!payload?.data) return res.status(200).send('No payload');

    let client;

    try {

        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // ---------------------------------------------
        // ONLY SUCCESSFUL PAYMENTS
        // ---------------------------------------------
        if (
            payload.event !== 'charge.completed' ||
            payload.data.status?.toUpperCase() !== 'SUCCESSFUL'
        ) {
            await client.query('COMMIT');
            return res.status(200).send('Ignored');
        }

        const txRef = payload.data.tx_ref?.trim();
        const flutterwaveTxId = String(payload.data.id);

        if (!txRef) {
            await client.query('COMMIT');
            return res.status(200).send('Missing txRef');
        }

        let batchRef =
            payload.data.meta?.parent_batch_ref ||
            (txRef.startsWith("BATCH-") ? txRef : null);

        // =====================================================
        // BULK FLOW
        // =====================================================
        if (batchRef) {

            console.log(`🔄 WEBHOOK: Batch detected ${batchRef}`);

            // 1. LOCK ONLY ONCE (idempotent-safe)
            const lockRes = await client.query(
                `
                UPDATE vouchers
                SET status = 'LOCKED',
                    locked_at = NOW(),
                    updated_at = NOW()
                WHERE parent_batch_ref = $1
                AND status = 'PENDING'
                RETURNING id
                `,
                [batchRef]
            );

            await client.query('COMMIT');

            console.log(
                `✅ WEBHOOK: Locked ${lockRes.rowCount} vouchers for ${batchRef}`
            );

            // ---------------------------------------------
            // IMPORTANT: DO NOT BLOCK WEBHOOK RESPONSE
            // ---------------------------------------------
            process.nextTick(async () => {
                try {
                    console.log(`💰 SETTLER START: ${batchRef}`);

                    await processBulkEscrowFunding(batchRef);

                    console.log(`✔ SETTLER DONE: ${batchRef}`);

                } catch (err) {
                    console.error(
                        `❌ SETTLER FAILED ${batchRef}:`,
                        err.message
                    );
                }
            });

            return res.status(200).send('Batch locked, settlement queued');
        }

        // =====================================================
        // SINGLE FLOW
        // =====================================================
        const voucherResult = await client.query(
            `
            UPDATE vouchers
            SET status = 'LOCKED',
                locked_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            AND status = 'PENDING'
            RETURNING *
            `,
            [txRef]
        );

        if (voucherResult.rowCount > 0) {

            const v = voucherResult.rows[0];

            await client.query(
                `
                INSERT INTO wallets (
                    user_email,
                    escrow_balance,
                    available_balance,
                    currency,
                    updated_at
                )
                VALUES ($1,$2,0,$3,NOW())
                ON CONFLICT (user_email, currency)
                DO UPDATE SET
                    escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                    updated_at = NOW()
                `,
                [v.recipient_email, Number(v.amount), v.currency]
            );

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
                VALUES ($1,$2,'ESCROW_DEPOSIT',$3,$4,'SUCCESSFUL',$5,NOW(),NOW())
                ON CONFLICT (reference_id) DO NOTHING
                `,
                [
                    v.recipient_email,
                    v.id,
                    Number(v.amount),
                    v.currency,
                    `FLW-${flutterwaveTxId}`
                ]
            );
        }

        await client.query('COMMIT');

        return res.status(200).send('Processed');

    } catch (err) {

        if (client) await client.query('ROLLBACK');

        console.error('❌ WEBHOOK ERROR:', err);

        return res.status(500).json({
            error: 'Internal server error',
            details: err.message
        });

    } finally {
        if (client) client.release();
    }
});

export default router;