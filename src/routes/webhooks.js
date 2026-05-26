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
            const voucherId = payload.data.tx_ref?.trim();
            const paymentStatus = payload.data.status?.toUpperCase() || 'FAILED';
            const amount = Number(payload.data.amount || 0);
            const flutterwaveTxId = String(payload.data.id);

            console.log(`💳 WEBHOOK RECEIVED: ${voucherId} | STATUS: ${paymentStatus}`);

            if (!voucherId) {
                console.error('❌ Missing tx_ref');
                await client.query('COMMIT');
                return res.status(200).send('Missing tx_ref');
            }

            // 1. FETCH VOUCHER
            const voucherResult = await client.query(
                `SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`,
                [voucherId]
            );

            if (voucherResult.rows.length === 0) {
                console.error(`❌ Voucher not found in DB: ${voucherId}`);
                await client.query('COMMIT');
                return res.status(200).send('Voucher not found');
            }

            const voucher = voucherResult.rows[0];
            const currency = payload.data.currency || voucher.currency || 'NGN';

            // MAP STATUSES
            let voucherStatus = 'FAILED';
            if (paymentStatus === 'SUCCESSFUL') voucherStatus = 'LOCKED';
            else if (paymentStatus === 'PENDING') voucherStatus = 'PROCESSING';
            else if (paymentStatus === 'CANCELLED') voucherStatus = 'CANCELLED';

            let transactionStatus = (paymentStatus === 'SUCCESSFUL') ? 'SUCCESSFUL' : 'FAILED';

            // 2. UPDATE VOUCHER & SET LOCKED_AT TIMESTAMP
            // If the new status is LOCKED, we record the time. Otherwise, keep existing locked_at.
            await client.query(
                `UPDATE vouchers 
                 SET status = $1::text::voucher_status, 
                     locked_at = CASE WHEN $1 = 'LOCKED' THEN NOW() ELSE locked_at END, 
                     updated_at = NOW() 
                 WHERE id = $2`,
                [voucherStatus, voucherId]
            );
            console.log(`✅ Voucher status updated to: ${voucherStatus}`);

            // 3. VIRTUAL WALLET BALANCE UPDATE
            if (paymentStatus === 'SUCCESSFUL' && voucher.status === 'PENDING') {
                try {
                    const walletUpdate = await client.query(
                        `UPDATE wallets SET escrow_balance = escrow_balance + $1, updated_at = NOW()
                         WHERE user_email = $2 AND currency = $3 RETURNING *`,
                        [amount, voucher.creator_email, currency]
                    );

                    if (walletUpdate.rowCount === 0) {
                        await client.query(
                            `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
                             VALUES ($1, $2, 0.0000, $3, NOW())`,
                            [voucher.creator_email, amount, currency]
                        );
                    }
                    console.log(`💰 Virtual Escrow Wallet Credited: ${amount} ${currency}`);
                } catch (walletErr) {
                    console.error('⚠️ Wallet sync warning:', walletErr.message);
                }
            }

            // 4. TRANSACTION LOG
            try {
                await client.query(
                    `INSERT INTO transactions (
                        user_email, voucher_id, transaction_type, amount, currency, 
                        fee, status, reference_id, created_at, updated_at
                    )
                    VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 0, $5::text::transaction_status, $6, NOW(), NOW())
                    ON CONFLICT (reference_id) DO NOTHING`,
                    [
                        voucher.creator_email, voucherId, amount, currency, 
                        transactionStatus, `FLW-${flutterwaveTxId}`
                    ]
                );
                console.log('📒 Ledger entry written successfully.');
            } catch (txErr) {
                console.error('❌ LEDGER SQL COMPILATION ERROR:', txErr.message);
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