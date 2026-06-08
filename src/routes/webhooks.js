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
    if (!payload || !payload.data) return res.status(200).send('No payload');

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        if (payload.event === 'charge.completed') {
            const txRef = payload.data.tx_ref?.trim();
            const paymentStatus = payload.data.status?.toUpperCase() || 'FAILED';
            const flutterwaveTxId = String(payload.data.id);
            
            // Retrieve Batch Ref from meta if provided, otherwise fallback to txRef
            const batchRef = payload.data.meta?.parent_batch_ref || txRef;
            const isBatch = payload.data.meta?.type === 'batch' || batchRef.startsWith('BATCH-');

            console.log(`💳 WEBHOOK RECEIVED: ${txRef} | BATCH_REF: ${batchRef} | STATUS: ${paymentStatus}`);

            // =========================
            // ✅ BATCH PROCESSING
            // =========================
            if (isBatch && paymentStatus === 'SUCCESSFUL') {
                const batchResult = await client.query(
                    "SELECT * FROM vouchers WHERE parent_batch_ref = $1 FOR UPDATE",
                    [batchRef]
                );

                if (batchResult.rows.length > 0) {
                    for (const v of batchResult.rows) {
                        if (v.status !== 'PENDING') continue;

                        // Lock individual voucher
                        await client.query(
                            "UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() WHERE id = $1",
                            [v.id]
                        );

                        // Credit Recipient's Escrow
                        await client.query(
                            `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
                             VALUES ($1, $2, 0.0000, $3, NOW())
                             ON CONFLICT (user_email, currency) 
                             DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                            [v.recipient_email, Number(v.amount), v.currency]
                        );
                    }
                    console.log(`✅ Batch processed successfully: ${batchRef}`);
                    await client.query('COMMIT');
                    return res.status(200).send('Batch processed');
                }
            }

            // =========================
            // ✅ SINGLE VOUCHER PROCESSING
            // =========================
            const voucherResult = await client.query(
                `SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`,
                [txRef]
            );

            if (voucherResult.rows.length === 0) {
                await client.query('COMMIT');
                return res.status(200).send('Voucher not found');
            }

            const voucher = voucherResult.rows[0];
            if (['LOCKED', 'RELEASED', 'AWAITING_SETTLEMENT'].includes(voucher.status)) {
                await client.query('COMMIT');
                return res.status(200).send('Already processed');
            }

            const amount = Number(payload.data.amount || voucher.amount);
            const currency = payload.data.currency || voucher.currency || 'NGN';
            const voucherStatus = paymentStatus === 'SUCCESSFUL' ? 'LOCKED' : 'CANCELLED';

            await client.query(
                `UPDATE vouchers SET status = $1::text::voucher_status, locked_at = NOW(), updated_at = NOW() WHERE id = $2`,
                [voucherStatus, txRef]
            );

            if (paymentStatus === 'SUCCESSFUL') {
                await client.query(
                    `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
                     VALUES ($1, $2, 0.0000, $3, NOW())
                     ON CONFLICT (user_email, currency) 
                     DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                    [voucher.recipient_email, amount, currency]
                );

                await client.query(
                    `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                     VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
                     ON CONFLICT (reference_id) DO NOTHING`,
                    [voucher.recipient_email, txRef, amount, currency, `FLW-${flutterwaveTxId}`]
                );
            }
        }

        await client.query('COMMIT');
        return res.status(200).send('Webhook processed');
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ CRITICAL WEBHOOK FAILURE:', err.message);
        return res.status(200).send('Internal Error Handled');
    } finally {
        if (client) client.release();
    }
});

export default router;