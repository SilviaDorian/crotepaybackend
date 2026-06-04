import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

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
        await client.query('SET search_path TO public');

        if (payload.event === 'charge.completed') {

            const txRef = payload.data.tx_ref?.trim();
            const paymentStatus = payload.data.status?.toUpperCase() || 'FAILED';
            const amount = Number(payload.data.amount || 0);
            const flutterwaveTxId = String(payload.data.id);

            const meta = payload.data.meta || {};
            const batchRef = meta.parent_batch_ref || meta.batch_id || null;

            const isBatch = !!batchRef;

            console.log(`💳 WEBHOOK RECEIVED: ${txRef} | STATUS: ${paymentStatus} | TYPE: ${isBatch ? 'BATCH' : 'SINGLE'}`);

            if (!txRef) {
                console.error('❌ Missing tx_ref');
                await client.query('COMMIT');
                return res.status(200).send('Missing tx_ref');
            }

            // =====================================================
            // 🔥 BATCH PAYMENT LOGIC
            // =====================================================
            if (isBatch && paymentStatus === 'SUCCESSFUL') {

                const batchResult = await client.query(
                    `SELECT * FROM vouchers WHERE parent_batch_ref = $1 FOR UPDATE`,
                    [batchRef]
                );

                if (batchResult.rows.length === 0) {
                    console.error(`❌ No vouchers found for batch: ${batchRef}`);
                    await client.query('COMMIT');
                    return res.status(200).send('Batch not found');
                }

                for (const v of batchResult.rows) {

                    if (v.status !== 'PENDING') continue;

                    const vAmount = Number(v.amount);

                    // LOCK voucher
                    await client.query(
                        `UPDATE vouchers
                         SET status = 'LOCKED',
                             locked_at = NOW(),
                             updated_at = NOW()
                         WHERE id = $1`,
                        [v.id]
                    );

                    // CREDIT ESCROW (safe UPSERT)
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
                        ON CONFLICT (user_email, currency)
                        DO UPDATE SET
                            escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                            updated_at = NOW()
                        `,
                        [v.creator_email, vAmount, v.currency]
                    );
                }

                console.log(`✅ Batch escrow distributed successfully: ${batchRef}`);

                await client.query('COMMIT');
                return res.status(200).send('Batch processed');
            }

            // =====================================================
            // 🔐 SINGLE VOUCHER LOGIC
            // =====================================================

            const voucherResult = await client.query(
                `SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`,
                [txRef]
            );

            if (voucherResult.rows.length === 0) {
                console.error(`❌ Voucher not found in DB: ${txRef}`);
                await client.query('COMMIT');
                return res.status(200).send('Voucher not found');
            }

            const voucher = voucherResult.rows[0];

            const currency =
                payload.data.currency ||
                voucher.currency ||
                'NGN';

            if (
                voucher.status === 'LOCKED' ||
                voucher.status === 'RELEASED' ||
                voucher.status === 'AWAITING_SETTLEMENT'
            ) {
                console.log(`ℹ️ Voucher already processed: ${voucher.id}`);
                await client.query('COMMIT');
                return res.status(200).send('Already processed');
            }

            let voucherStatus = 'FAILED';

            if (paymentStatus === 'SUCCESSFUL') {
                voucherStatus = 'LOCKED';
            } else if (paymentStatus === 'PENDING') {
                voucherStatus = 'PROCESSING';
            } else if (paymentStatus === 'CANCELLED') {
                voucherStatus = 'CANCELLED';
            }

            await client.query(
                `
                UPDATE vouchers
                SET
                    status = $1::text::voucher_status,
                    locked_at = CASE WHEN $1 = 'LOCKED' THEN NOW() ELSE locked_at END,
                    updated_at = NOW()
                WHERE id = $2
                `,
                [voucherStatus, txRef]
            );

            console.log(`✅ Voucher updated: ${voucherStatus}`);

            // CREDIT ESCROW (single)
            if (paymentStatus === 'SUCCESSFUL' && voucher.status === 'PENDING') {

                const vAmount = Number(voucher.amount);

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
                    ON CONFLICT (user_email, currency)
                    DO UPDATE SET
                        escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                        updated_at = NOW()
                    `,
                    [voucher.creator_email, vAmount, currency]
                );
            }

            // LEDGER ENTRY
            try {
                await client.query(
                    `
                    INSERT INTO transactions (
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
                    VALUES (
                        $1,$2,'ESCROW_DEPOSIT',$3,$4,0,'SUCCESSFUL',$5,NOW(),NOW()
                    )
                    ON CONFLICT (reference_id) DO NOTHING
                    `,
                    [
                        voucher.creator_email,
                        txRef,
                        amount,
                        currency,
                        `FLW-${flutterwaveTxId}`
                    ]
                );

                console.log('📒 Ledger entry written successfully.');

            } catch (txErr) {
                console.error('❌ LEDGER ERROR:', txErr.message);
            }
        }

        await client.query('COMMIT');
        return res.status(200).send('Webhook processed');

    } catch (err) {

        console.error('❌ CRITICAL WEBHOOK FAILURE:', err.message);

        if (client) {
            await client.query('ROLLBACK');
        }

        return res.status(200).send('Internal Error Handled');

    } finally {
        if (client) client.release();
    }
});

export default router;