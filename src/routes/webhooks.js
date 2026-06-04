import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    // =========================
    // VERIFY WEBHOOK
    // =========================
    if (!secretHash || signature !== secretHash) {
        console.warn('⚠️ Invalid webhook signature');
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;

    if (!payload || !payload.data) {
        return res.status(200).send('No payload');
    }

    let client;

    try {

        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        if (payload.event === 'charge.completed') {

            const txRef = payload.data.tx_ref?.trim();
            const paymentStatus = (payload.data.status || '').toUpperCase();
            const amount = Number(payload.data.amount || 0);
            const flutterwaveTxId = String(payload.data.id);
            const currency = payload.data.currency || 'NGN';

            const isBatch = typeof txRef === 'string' && txRef.startsWith('BATCH-');

            console.log(
                `💳 WEBHOOK: ${txRef} | STATUS: ${paymentStatus} | TYPE: ${isBatch ? 'BATCH' : 'SINGLE'}`
            );

            if (!txRef) {
                console.error('❌ Missing tx_ref');
                await client.query('COMMIT');
                return res.status(200).send('Missing tx_ref');
            }

            const isSuccess =
                ['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'CHARGED'].includes(paymentStatus);

            // =====================================================
            // 🔥 BATCH ESCROW PROCESSING (parent_batch_ref driven)
            // =====================================================
            if (isBatch && isSuccess) {

                const batchResult = await client.query(
                    `
                    SELECT * FROM vouchers
                    WHERE parent_batch_ref = $1
                    FOR UPDATE
                    `,
                    [txRef]
                );

                if (batchResult.rows.length === 0) {
                    console.error(`❌ No vouchers found for batch: ${txRef}`);
                    await client.query('COMMIT');
                    return res.status(200).send('Batch not found');
                }

                for (const v of batchResult.rows) {

                    // =========================
                    // IDEMPOTENCY CHECK
                    // =========================
                    if (v.locked_at) continue;

                    const voucherAmount = Number(v.amount);

                    // =========================
                    // CREDIT ESCROW WALLET
                    // =========================
                    const walletUpdate = await client.query(
                        `
                        UPDATE wallets
                        SET escrow_balance = escrow_balance + $1,
                            updated_at = NOW()
                        WHERE user_email = $2 AND currency = $3
                        RETURNING *
                        `,
                        [voucherAmount, v.creator_email, v.currency]
                    );

                    // CREATE WALLET IF MISSING
                    if (walletUpdate.rowCount === 0) {
                        await client.query(
                            `
                            INSERT INTO wallets (
                                user_email,
                                escrow_balance,
                                available_balance,
                                currency,
                                updated_at
                            )
                            VALUES ($1, $2, 0, $3, NOW())
                            `,
                            [v.creator_email, voucherAmount, v.currency]
                        );
                    }

                    // =========================
                    // MARK AS LOCKED (AFTER CREDIT)
                    // =========================
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
                }

                console.log(`✅ Batch escrow credited: ${txRef}`);

                await client.query('COMMIT');
                return res.status(200).send('Batch processed');
            }

            // =====================================================
            // 🔥 SINGLE VOUCHER PROCESSING
            // =====================================================

            const voucherResult = await client.query(
                `
                SELECT * FROM vouchers
                WHERE id = $1
                FOR UPDATE
                `,
                [txRef]
            );

            if (voucherResult.rows.length === 0) {
                console.error(`❌ Voucher not found: ${txRef}`);
                await client.query('COMMIT');
                return res.status(200).send('Voucher not found');
            }

            const voucher = voucherResult.rows[0];

            const alreadyCredited = voucher.locked_at !== null;

            if (alreadyCredited) {
                console.log(`ℹ️ Already processed: ${voucher.id}`);
                await client.query('COMMIT');
                return res.status(200).send('Already processed');
            }

            if (!isSuccess) {
                await client.query('COMMIT');
                return res.status(200).send('Not successful');
            }

            const voucherAmount = Number(voucher.amount);

            // =========================
            // CREDIT ESCROW WALLET
            // =========================
            const walletUpdate = await client.query(
                `
                UPDATE wallets
                SET escrow_balance = escrow_balance + $1,
                    updated_at = NOW()
                WHERE user_email = $2 AND currency = $3
                RETURNING *
                `,
                [voucherAmount, voucher.creator_email, currency]
            );

            if (walletUpdate.rowCount === 0) {
                await client.query(
                    `
                    INSERT INTO wallets (
                        user_email,
                        escrow_balance,
                        available_balance,
                        currency,
                        updated_at
                    )
                    VALUES ($1, $2, 0, $3, NOW())
                    `,
                    [voucher.creator_email, voucherAmount, currency]
                );
            }

            // =========================
            // MARK VOUCHER LOCKED
            // =========================
            await client.query(
                `
                UPDATE vouchers
                SET status = 'LOCKED',
                    locked_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                `,
                [voucher.id]
            );

            console.log(`💰 Escrow credited: ${voucher.id}`);

            await client.query('COMMIT');
            return res.status(200).send('Webhook processed');
        }

        await client.query('COMMIT');
        return res.status(200).send('Ignored event');

    } catch (err) {

        console.error('❌ WEBHOOK ERROR:', err.message);

        if (client) {
            await client.query('ROLLBACK');
        }

        return res.status(200).send('Error handled');

    } finally {
        if (client) client.release();
    }
});

export default router;