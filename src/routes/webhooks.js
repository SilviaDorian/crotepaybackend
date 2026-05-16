import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

/**
 * FLUTTERWAVE WEBHOOK
 * Endpoint: /api/webhooks/flutterwave
 */

router.post('/flutterwave', async (req, res) => {

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

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

        /**
         * PAYMENT EVENT
         */
        if (payload.event === 'charge.completed') {

            const voucherId = payload.data.tx_ref?.trim();

            const paymentStatus =
                payload.data.status?.toUpperCase() || 'FAILED';

            const amount = Number(payload.data.amount || 0);
            const currency = payload.data.currency || 'NGN';
            const flutterwaveTxId = String(payload.data.id);

            console.log(`💳 WEBHOOK: ${voucherId} | ${paymentStatus}`);

            if (!voucherId) {
                console.error('❌ Missing tx_ref');
                await client.query('COMMIT');
                return res.status(200).send('Missing tx_ref');
            }

            /**
             * FIND VOUCHER
             */
            const voucherResult = await client.query(
                `SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`,
                [voucherId]
            );

            if (voucherResult.rows.length === 0) {
                console.error(`❌ Voucher not found: ${voucherId}`);
                await client.query('COMMIT');
                return res.status(200).send('Voucher not found');
            }

            const voucher = voucherResult.rows[0];

            /**
             * MAP STATUS SAFELY
             */
            let voucherStatus = 'FAILED';

            if (paymentStatus === 'SUCCESSFUL') {
                voucherStatus = 'LOCKED';
            } else if (paymentStatus === 'PENDING') {
                voucherStatus = 'PROCESSING';
            } else if (paymentStatus === 'CANCELLED') {
                voucherStatus = 'CANCELLED';
            } else if (paymentStatus === 'FAILED') {
                voucherStatus = 'FAILED';
            }

            /**
             * ALWAYS UPDATE VOUCHER
             */
            await client.query(
                `
                UPDATE vouchers
                SET status = $1, updated_at = NOW()
                WHERE id = $2
                `,
                [voucherStatus, voucherId]
            );

            console.log(`✅ Voucher updated -> ${voucherStatus}`);

            /**
             * SAFE TRANSACTION INSERT (NO CRASH IF COLUMN MISSING)
             */
            try {
                await client.query(
                    `
                    INSERT INTO transactions (
                        user_email,
                        voucher_id,
                        transaction_type,
                        amount_usd,
                        fee_usd,
                        status,
                        reference_id,
                        currency
                    )
                    VALUES (
                        $1, $2, 'ESCROW_DEPOSIT',
                        $3, 0, $4,
                        $5, $6
                    )
                    ON CONFLICT (reference_id) DO NOTHING
                    `,
                    [
                        voucher.creator_email,
                        voucherId,
                        amount,
                        voucherStatus,
                        `FLW-${flutterwaveTxId}`,
                        currency
                    ]
                );

                console.log('📒 Transaction logged');
            } catch (txErr) {
                console.error('❌ Transaction insert failed:', txErr.message);
            }

            /**
             * WALLET CREDIT ONLY ON SUCCESS + FIRST TIME
             */
            if (
                paymentStatus === 'SUCCESSFUL' &&
                voucher.status === 'PENDING'
            ) {

                try {
                    await client.query(
                        `
                        INSERT INTO wallets (
                            user_email,
                            escrow_balance,
                            available_balance,
                            currency
                        )
                        VALUES ($1, $2, 0, $3)
                        ON CONFLICT (user_email, currency)
                        DO UPDATE SET
                            escrow_balance =
                                wallets.escrow_balance + EXCLUDED.escrow_balance,
                            updated_at = NOW()
                        `,
                        [
                            voucher.creator_email,
                            amount,
                            currency
                        ]
                    );

                    console.log(`💰 Wallet credited: ${amount} ${currency}`);

                } catch (walletErr) {
                    console.error('❌ Wallet update failed:', walletErr.message);
                }
            }
        }

        await client.query('COMMIT');

        return res.status(200).send('Webhook processed');

    } catch (err) {

        console.error('❌ FULL WEBHOOK ERROR:', err);

        if (client) {
            await client.query('ROLLBACK');
        }

        return res.status(200).send('Webhook error');

    } finally {

        if (client) {
            client.release();
        }
    }
});

export default router;