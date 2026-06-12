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

        // Verify completion status
        if (payload.event !== 'charge.completed' || payload.data.status?.toUpperCase() !== 'SUCCESSFUL') {
            await client.query('COMMIT');
            return res.status(200).send('Ignored');
        }

        const txRef = payload.data.tx_ref?.trim();
        const flutterwaveTxId = String(payload.data.id);
        let batchRef = payload.data.meta?.parent_batch_ref || (txRef.startsWith("BATCH-") ? txRef : null);

        if (batchRef) {
            console.log(`🔄 WEBHOOK: Processing batch: ${batchRef}`);

            // 1. Lock vouchers
            const lockRes = await client.query(
                `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE parent_batch_ref = $1 AND status = 'PENDING'
                 RETURNING id`,
                [batchRef]
            );

            // 2. Commit transaction to persist the "LOCKED" status
            await client.query('COMMIT');
            console.log(`✅ WEBHOOK: Batch ${batchRef} locked (${lockRes.rowCount} records).`);

            // 3. Await settlement to ensure funding finishes before responding to Flutterwave
            console.log(`💰 WEBHOOK: Running settler for ${batchRef}...`);
            await processBulkEscrowFunding(batchRef);
            
            return res.status(200).send('Batch locked and funded successfully');
        }

        // Single voucher flow
        const voucherResult = await client.query(
            `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
             WHERE id = $1 AND status = 'PENDING' RETURNING *`, 
            [txRef]
        );

        if (voucherResult.rowCount > 0) {
            const v = voucherResult.rows[0];
            await client.query(
                `INSERT INTO wallets (user_email, escrow_balance, currency, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_email, currency) 
                 DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                [v.recipient_email, Number(v.amount), v.currency]
            );
            await client.query(
                `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                 VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())`,
                [v.recipient_email, v.id, Number(v.amount), v.currency, `FLW-${flutterwaveTxId}`]
            );
        }

        await client.query('COMMIT');
        return res.status(200).send('Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK CRITICAL ERROR:', err);
        return res.status(500).json({ error: 'Internal server error', details: err.message });
    } finally {
        if (client) client.release();
    }
});

export default router;