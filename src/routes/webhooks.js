import express from 'express';
import { getClient } from '../db/index.js';
import { processBulkEscrowFunding } from '../src/controllers/bulkSettlementWorker.js'; // ← Adjust path if your file is elsewhere

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;
    if (!payload?.data) {
        return res.status(200).send('No payload');
    }

    if (payload.event !== 'charge.completed' || 
        payload.data.status?.toUpperCase() !== 'SUCCESSFUL') {
        return res.status(200).send('Ignored');
    }

    const txRef = payload.data.tx_ref?.trim();
    const flutterwaveTxId = String(payload.data.id);
    
    // Get batch reference from meta or tx_ref (this is the key)
    const batchRef = payload.data.meta?.parent_batch_ref || 
                    (txRef?.startsWith("BATCH-") ? txRef : null);

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        if (batchRef) {
            console.log(`🔄 WEBHOOK: Received batch payment for ${batchRef}`);

            // Lock vouchers if not already locked
            const lockRes = await client.query(
                `UPDATE vouchers 
                 SET status = 'LOCKED', 
                     locked_at = NOW(), 
                     updated_at = NOW() 
                 WHERE parent_batch_ref = $1 
                   AND status = 'PENDING'
                 RETURNING id`,
                [batchRef]
            );

            console.log(`✅ Locked ${lockRes.rowCount} voucher(s) for batch ${batchRef}`);

            await client.query('COMMIT');

            // 🔥 Trigger worker with the real batchRef from Flutterwave
            if (lockRes.rowCount > 0) {
                console.log(`🚀 Triggering bulkSettlementWorker with batchRef: ${batchRef}`);
                processBulkEscrowFunding(batchRef)
                    .then(() => console.log(`✅ Worker finished for batch ${batchRef}`))
                    .catch(err => console.error(`❌ Worker error for ${batchRef}:`, err));
            }

            return res.status(200).send(`Batch ${batchRef} locked and funding worker triggered`);

        } else if (txRef) {
            // SINGLE VOUCHER FLOW (unchanged logic)
            console.log(`🔄 Processing single voucher: ${txRef}`);

            const voucherResult = await client.query(
                `UPDATE vouchers 
                 SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE id = $1 AND status = 'PENDING' 
                 RETURNING *`,
                [txRef]
            );

            if (voucherResult.rowCount > 0) {
                const v = voucherResult.rows[0];

                await client.query(
                    `INSERT INTO wallets (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
                     VALUES ($1, $2, $3, 0, 0, NOW())
                     ON CONFLICT (user_email, currency) 
                     DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                    [v.recipient_email, v.currency.toUpperCase(), Number(v.amount)]
                );

                await client.query(
                    `INSERT INTO transactions 
                     (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                     VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())`,
                    [v.recipient_email, v.id, Number(v.amount), v.currency, `FLW-${flutterwaveTxId}`]
                );

                console.log(`✅ Single voucher ${txRef} funded`);
            }

            await client.query('COMMIT');
            return res.status(200).send('Single voucher processed');
        }

        await client.query('COMMIT');
        return res.status(200).send('No action needed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK CRITICAL ERROR:', err);
        return res.status(200).send('Error logged - check server logs');
    } finally {
        if (client) client.release();
    }
});

export default router;