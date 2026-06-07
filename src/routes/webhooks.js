import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    /**
     * Verify Webhook Signature
     */
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

        /**
         * Flutterwave Charge Completed
         */
        if (payload.event === 'charge.completed') {

            const txRef = payload.data.tx_ref?.trim();
            const paymentStatus = payload.data.status?.toUpperCase() || 'FAILED';
            const flutterwaveTxId = String(payload.data.id);

            console.log(`💳 WEBHOOK RECEIVED: ${txRef} | STATUS: ${paymentStatus}`);

            if (!txRef) {
                console.error('❌ Missing tx_ref');
                await client.query('COMMIT');
                return res.status(200).send('Missing tx_ref');
            }

            // =========================================================
            // ✅ NEW: CHECK IF THIS IS A BATCH PAYMENT FIRST
            // =========================================================
            const batchResult = await client.query(
                `SELECT * FROM vouchers WHERE parent_batch_ref = $1 FOR UPDATE`,
                [txRef]
            );

            const isBatch = batchResult.rows.length > 0;

            // =========================================================
            // ✅ BATCH LOGIC (NEW ADDITION)
            // =========================================================
            // =========================
// BATCH PROCESSING (FIXED)
// =========================
const batchRef =
    payload.data.meta?.parent_batch_ref ||
    txRef;

const isBatch = payload.data.meta?.type === "batch" || txRef?.startsWith("BATCH-");

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

        // 🚨 IMPORTANT: ALWAYS USE v.amount (NOT payload.amount)
        const amount = Number(v.amount);

        if (v.status !== 'PENDING') continue;

        // lock voucher
        await client.query(
            `UPDATE vouchers
             SET status = 'LOCKED',
                 locked_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [v.id]
        );

        // credit escrow PER VOUCHER AMOUNT
        await client.query(
            `
            INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
            VALUES ($1, $2, 0, $3, NOW())
            ON CONFLICT (user_email, currency)
            DO UPDATE SET
                escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                updated_at = NOW()
            `,
            [v.recipient_email, amount, v.currency]
        );
    }

    console.log(`✅ Batch escrow correctly distributed: ${batchRef}`);

    await client.query('COMMIT');
    return res.status(200).send('Batch processed');
}

            // =========================================================
            // ✅ SINGLE VOUCHER LOGIC (UNCHANGED - ONLY GUARDED)
            // =========================================================

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
            const amount = Number(payload.data.amount || voucher.amount);
            const currency = payload.data.currency || voucher.currency || 'NGN';

            if (['LOCKED', 'RELEASED', 'AWAITING_SETTLEMENT'].includes(voucher.status)) {
                console.log(`ℹ️ Voucher already processed: ${voucher.id}`);
                await client.query('COMMIT');
                return res.status(200).send('Already processed');
            }

            let voucherStatus =
                paymentStatus === 'SUCCESSFUL'
                    ? 'LOCKED'
                    : paymentStatus === 'PENDING'
                        ? 'PROCESSING'
                        : 'CANCELLED';

            const transactionStatus =
                paymentStatus === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';

            await client.query(
                `UPDATE vouchers 
                 SET status = $1::text::voucher_status,
                     locked_at = CASE WHEN $1 = 'LOCKED' THEN NOW() ELSE locked_at END,
                     updated_at = NOW()
                 WHERE id = $2`,
                [voucherStatus, txRef]
            );

            if (paymentStatus === 'SUCCESSFUL' && voucher.status === 'PENDING') {

                await client.query(
                    `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
                     VALUES ($1, $2, 0.0000, $3, NOW())
                     ON CONFLICT (user_email, currency)
                     DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                                   updated_at = NOW()`,
                    [voucher.recipient_email, amount, currency]
                );
            }

            try {
                await client.query(
                    `INSERT INTO transactions (
                        user_email, voucher_id, transaction_type,
                        amount, currency, fee, status, reference_id,
                        created_at, updated_at
                    )
                    VALUES (
                        $1, $2, 'ESCROW_DEPOSIT',
                        $3, $4, 0, $5::text::transaction_status, $6,
                        NOW(), NOW()
                    )
                    ON CONFLICT (reference_id) DO NOTHING`,
                    [
                        voucher.recipient_email,
                        txRef,
                        amount,
                        currency,
                        transactionStatus,
                        `FLW-${flutterwaveTxId}`
                    ]
                );
            } catch (txErr) {
                console.error('❌ LEDGER SQL ERROR:', txErr.message);
            }
        }

        await client.query('COMMIT');
        return res.status(200).send('Webhook processed');

    } catch (err) {
        console.error('❌ CRITICAL WEBHOOK FAILURE:', err.message);
        if (client) await client.query('ROLLBACK');
        return res.status(200).send('Internal Error Handled');
    } finally {
        if (client) client.release();
    }
});

export default router;