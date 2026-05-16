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
        // Ensure we are targeting the public schema and the correct search path
        await client.query('SET search_path TO public');

        if (payload.event === 'charge.completed') {
            const voucherId = payload.data.tx_ref?.trim();
            const paymentStatus = payload.data.status?.toUpperCase() || 'FAILED';
            const amount = Number(payload.data.amount || 0);
            const currency = payload.data.currency || 'NGN';
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

            // MAP STATUS TO ENUM
            let voucherStatus = 'FAILED';
            if (paymentStatus === 'SUCCESSFUL') voucherStatus = 'LOCKED';
            else if (paymentStatus === 'PENDING') voucherStatus = 'PROCESSING';
            else if (paymentStatus === 'CANCELLED') voucherStatus = 'CANCELLED';

            // 2. UPDATE VOUCHER (Primary Goal - Unblocks the "Syncing" UI)
            await client.query(
                `UPDATE vouchers SET status = $1::text::voucher_status, updated_at = NOW() WHERE id = $2`,
                [voucherStatus, voucherId]
            );
            console.log(`✅ Voucher status updated to: ${voucherStatus}`);

            // 3. WALLET CREDIT (Escrow Logic)
            if (paymentStatus === 'SUCCESSFUL' && voucher.status === 'PENDING') {
                try {
                    // Update current wallet or create if doesn't exist
                    const walletUpdate = await client.query(
                        `UPDATE wallets SET escrow_balance = escrow_balance + $1, updated_at = NOW()
                         WHERE user_email = $2 AND currency = $3 RETURNING *`,
                        [amount, voucher.creator_email, currency]
                    );

                    if (walletUpdate.rowCount === 0) {
                        await client.query(
                            `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency)
                             VALUES ($1, $2, 0, $3)`,
                            [voucher.creator_email, amount, currency]
                        );
                    }
                    console.log(`💰 Wallet credited: ${amount} ${currency}`);
                } catch (walletErr) {
                    console.error('⚠️ Wallet sync warning (Non-fatal):', walletErr.message);
                }
            }

            // 4. TRANSACTION LOG (Using confirmed schema names)
            try {
                // Column names matched to your information_schema: 
                // amount, currency, fee, update_at
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
                        update_at
                    )
                    VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 0, $5::text::voucher_status, $6, NOW())
                    ON CONFLICT (reference_id) DO NOTHING
                    `,
                    [
                        voucher.creator_email,
                        voucherId,
                        amount,
                        currency,
                        voucherStatus,
                        `FLW-${flutterwaveTxId}`
                    ]
                );
                console.log('📒 Ledger entry created successfully');
            } catch (txErr) {
                console.error('❌ LEDGER ERROR (Sync continuing):', txErr.message);
                // We DON'T throw here so the BEGIN/COMMIT still saves the Voucher/Wallet updates
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