import express from 'express';
import { getClient } from '../db/index.js';
import { processBulkEscrowFunding } from '../src/controllers/bulkSettlementWorker.js'; // Adjust path if needed

const router = express.Router();

async function creditEscrowWallet(client, voucher, flutterwaveTxId, isBatch = false) {
    const amount = Number(voucher.amount);
    const ref = isBatch ? `BULK-ESCROW-${voucher.id}` : `FLW-${flutterwaveTxId}`;

    try {
        // Wallet funding
        await client.query(
            `INSERT INTO public.wallets 
             (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
             VALUES ($1, $2, $3, 0, 0, NOW())
             ON CONFLICT (user_email, currency) 
             DO UPDATE SET 
                 escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                 updated_at = NOW()`,
            [voucher.recipient_email, voucher.currency.toUpperCase(), amount]
        );

        // Transaction record
        await client.query(
            `INSERT INTO public.transactions 
             (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
             VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
             ON CONFLICT (reference_id) DO NOTHING`,
            [voucher.recipient_email, voucher.id, amount, voucher.currency, ref]
        );

        // Mark as funded
        await client.query(
            `UPDATE public.vouchers 
             SET escrow_funded = true, updated_at = NOW() 
             WHERE id = $1`,
            [voucher.id]
        );

        console.log(`✅ Credited ${amount} ${voucher.currency} to ${voucher.recipient_email}`);
    } catch (err) {
        console.error(`❌ Failed to credit voucher ${voucher.id}:`, err.message);
        throw err;
    }
}

router.post('/flutterwave', async (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;
    if (!payload?.data || payload.event !== 'charge.completed' || 
        payload.data.status?.toUpperCase() !== 'SUCCESSFUL') {
        return res.status(200).send('Ignored');
    }

    const txRef = payload.data.tx_ref?.trim();
    const flutterwaveTxId = String(payload.data.id);
    const batchRef = payload.data.meta?.parent_batch_ref || 
                    (txRef?.startsWith("BATCH-") ? txRef : null);

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        if (batchRef) {
            console.log(`🔄 WEBHOOK: Processing batch ${batchRef}`);

            const alreadyProcessed = await client.query(
                `SELECT 1 FROM transactions WHERE reference_id LIKE $1 LIMIT 1`,
                [`BULK-ESCROW-${batchRef}%`]
            );

            if (alreadyProcessed.rowCount > 0) {
                await client.query('COMMIT');
                return res.status(200).send('Already processed');
            }

            const lockRes = await client.query(
                `UPDATE vouchers 
                 SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE parent_batch_ref = $1 AND status = 'PENDING'
                 RETURNING id, recipient_email, amount, currency`,
                [batchRef]
            );

            if (lockRes.rowCount > 0) {
                for (const voucher of lockRes.rows) {
                    await creditEscrowWallet(client, voucher, flutterwaveTxId, true);
                }
                console.log(`✅ Batch ${batchRef} fully funded via webhook`);
            }

            // Background safety net
            processBulkEscrowFunding(batchRef).catch(err => 
                console.error('Background worker error:', err)
            );

        } else if (txRef) {
            // Single voucher
            const voucherResult = await client.query(
                `UPDATE vouchers 
                 SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE id = $1 AND status = 'PENDING' 
                 RETURNING id, recipient_email, amount, currency`,
                [txRef]
            );

            if (voucherResult.rowCount > 0) {
                await creditEscrowWallet(client, voucherResult.rows[0], flutterwaveTxId, false);
            }
        }

        await client.query('COMMIT');
        return res.status(200).send('Processed successfully');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK CRITICAL ERROR:', err);
        return res.status(200).send('Error logged - check logs');
    } finally {
        if (client) client.release();
    }
});

export default router;