import express from 'express';
import { getClient } from '../db/index.js';
import { processBulkEscrowFunding } from '../services/autoSettler.js';

const router = express.Router();

// Reusable helper for crediting escrow (DRY + consistent)
async function creditEscrowWallet(client, voucher, flutterwaveTxId, isBatch = false) {
    const amount = Number(voucher.amount);
    const ref = isBatch 
        ? `BULK-ESCROW-${voucher.id}` 
        : `FLW-${flutterwaveTxId}`;

    // Robust wallet UPSERT - guarantees wallet exists
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

    // Transaction log with idempotency
    await client.query(
        `INSERT INTO public.transactions 
         (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
         VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
         ON CONFLICT (reference_id) DO NOTHING`,
        [voucher.recipient_email, voucher.id, amount, voucher.currency, ref]
    );
}

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

    // Only process successful charges
    if (payload.event !== 'charge.completed' || 
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

        let processed = false;

        if (batchRef) {
            console.log(`🔄 WEBHOOK: Processing batch ${batchRef}`);

            // Idempotency check for the entire batch
            const alreadyProcessed = await client.query(
                `SELECT 1 FROM public.transactions 
                 WHERE reference_id LIKE $1 LIMIT 1`,
                [`BULK-ESCROW-${batchRef}%`]
            );

            if (alreadyProcessed.rowCount > 0) {
                await client.query('COMMIT');
                return res.status(200).send('Batch already processed');
            }

            // Lock vouchers and return necessary data
            const lockRes = await client.query(
                `UPDATE public.vouchers 
                 SET status = 'LOCKED', 
                     locked_at = NOW(), 
                     updated_at = NOW() 
                 WHERE parent_batch_ref = $1 
                   AND status = 'PENDING'
                 RETURNING id, recipient_email, amount, currency`,
                [batchRef]
            );

            if (lockRes.rowCount === 0) {
                await client.query('COMMIT');
                return res.status(200).send('No pending vouchers found');
            }

            console.log(`✅ Locked ${lockRes.rowCount} vouchers for batch ${batchRef}`);

            // === FUNDING HAPPENS IN SAME TRANSACTION (critical fix) ===
            for (const voucher of lockRes.rows) {
                await creditEscrowWallet(client, voucher, flutterwaveTxId, true);
            }

            processed = true;
            console.log(`💰 Batch ${batchRef} funded successfully`);

            // Optional: Still trigger worker as extra safety net
            // processBulkEscrowFunding(batchRef).catch(console.error);

        } else if (txRef) {
            // SINGLE VOUCHER FLOW
            console.log(`🔄 WEBHOOK: Processing single voucher ${txRef}`);

            const voucherResult = await client.query(
                `UPDATE public.vouchers 
                 SET status = 'LOCKED', 
                     locked_at = NOW(), 
                     updated_at = NOW() 
                 WHERE id = $1 AND status = 'PENDING' 
                 RETURNING id, recipient_email, amount, currency`,
                [txRef]
            );

            if (voucherResult.rowCount > 0) {
                const voucher = voucherResult.rows[0];
                await creditEscrowWallet(client, voucher, flutterwaveTxId, false);
                processed = true;
                console.log(`💰 Single voucher ${txRef} funded`);
            }
        }

        await client.query('COMMIT');
        return res.status(200).send(
            processed ? 'Processed successfully' : 'No action needed'
        );

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK CRITICAL ERROR:', err);
        // Always return 200 to prevent Flutterwave from retrying endlessly
        return res.status(200).send('Error logged - check server logs');
    } finally {
        if (client) client.release();
    }
});

export default router;