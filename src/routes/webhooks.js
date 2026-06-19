import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    // 1. Log the entire payload to verify the incoming data structure
    console.log("DEBUG: Webhook hit. Payload:", JSON.stringify(req.body, null, 2));

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        console.log("❌ Webhook rejected: Invalid signature.");
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;
    if (!payload?.data || payload.event !== 'charge.completed' || payload.data.status?.toUpperCase() !== 'SUCCESSFUL') {
        console.log("⚠️ Webhook ignored: Status not successful or invalid payload.");
        return res.status(200).send('Ignored');
    }

    // Capture the reference. We prioritize meta for bulk and tx_ref as the fallback
    const ref = (payload.data.meta?.parent_batch_ref || payload.data.tx_ref)?.trim();
    const isBatch = ref?.startsWith("BATCH-");

    console.log(`📦 Processing Reference: ${ref} (Identified as: ${isBatch ? 'BULK BATCH' : 'SINGLE VOUCHER'})`);

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        if (isBatch) {
            // BULK LOCKING: Update all PENDING vouchers for this batch
            console.log(`🔄 Attempting to lock all vouchers for batch: ${ref}`);
            
            const lockRes = await client.query(
                `UPDATE vouchers 
                 SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE parent_batch_ref = $1 AND status = 'PENDING'
                 RETURNING id`,
                [ref]
            );
            
            console.log(`✅ Batch lock result: Updated ${lockRes.rowCount} rows for batch ${ref}`);
            
            if (lockRes.rowCount === 0) {
                console.log(`⚠️ WARNING: No vouchers found with status 'PENDING' for batch ${ref}. Check database!`);
            }
        } else {
            // SINGLE VOUCHER LOCKING AND WALLET FUNDING
            console.log(`🔄 Attempting to lock single voucher: ${ref}`);
            
            const voucherResult = await client.query(
                `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE id = split_part($1, '_', 1) AND status = 'PENDING' RETURNING *`,
                [ref]
            );

            if (voucherResult.rowCount > 0) {
                const v = voucherResult.rows[0];
                
                // Update Wallet Balance
                await client.query(
                    `INSERT INTO wallets (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
                     VALUES ($1, $2, $3, 0, 0, NOW())
                     ON CONFLICT (user_email, currency) 
                     DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                    [v.creator_email, v.currency.toUpperCase(), Number(v.amount)]
                );
                
                // Record Transaction
                await client.query(
                    `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                     VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())`,
                    [v.creator_email, v.id, Number(v.amount), v.currency, `FLW-${String(payload.data.id)}`]
                );
                
                console.log(`✅ Single voucher processed: ${ref}`);
            } else {
                console.log(`⚠️ Single voucher lock failed: No 'PENDING' voucher found with ID ${ref}`);
            }
        }

        await client.query('COMMIT');
        console.log("💾 Transaction committed successfully.");
        return res.status(200).send('Operation processed successfully');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK ERROR:', err);
        return res.status(200).send('Error logged');
    } finally {
        if (client) client.release();
    }
});

export default router;
