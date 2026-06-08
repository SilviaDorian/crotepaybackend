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
            const rawTxRef = payload.data.tx_ref?.trim();
            const paymentStatus = payload.data.status?.toUpperCase() || 'FAILED';
            const flutterwaveTxId = String(payload.data.id);
            
            // Determine if this is a Batch or Single process
            const isBatch = rawTxRef.startsWith('BATCH-');

            if (isBatch) {
                // BULK PROCESSING: Use the full rawTxRef as the batch identifier
                const batchResult = await client.query(
                    `SELECT * FROM vouchers WHERE parent_batch_ref = $1 AND status = 'PENDING' FOR UPDATE`,
                    [rawTxRef]
                );

                if (batchResult.rows.length > 0) {
                    for (const v of batchResult.rows) {
                        await client.query(`UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.id]);
                        
                        await client.query(
                            `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
                             VALUES ($1, $2, 0.0000, $3, NOW())
                             ON CONFLICT (user_email, currency) 
                             DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                            [v.recipient_email, Number(v.amount), v.currency]
                        );

                        await client.query(
                            `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                             VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
                             ON CONFLICT (reference_id) DO NOTHING`,
                            [v.recipient_email, v.id, Number(v.amount), v.currency, `FLW-BATCH-${rawTxRef}-${v.id}`]
                        );
                    }
                }
            } else {
                // SINGLE PROCESSING: Handle potential timestamp suffixes (e.g., VC-123_171...)
                const txRef = rawTxRef.split('_')[0];
                const voucherResult = await client.query(`SELECT * FROM vouchers WHERE id = $1 FOR UPDATE`, [txRef]);
                const voucher = voucherResult.rows[0];

                if (voucher && voucher.status === 'PENDING' && paymentStatus === 'SUCCESSFUL') {
                    await client.query(`UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() WHERE id = $1`, [txRef]);
                    
                    await client.query(
                        `INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
                         VALUES ($1, $2, 0.0000, $3, NOW())
                         ON CONFLICT (user_email, currency) 
                         DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                        [voucher.creator_email, Number(payload.data.amount), voucher.currency]
                    );

                    await client.query(
                        `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                         VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
                         ON CONFLICT (reference_id) DO NOTHING`,
                        [voucher.creator_email, txRef, Number(payload.data.amount), voucher.currency, `FLW-${flutterwaveTxId}`]
                    );
                }
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