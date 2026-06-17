import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {

    // 🔥 DEBUG: confirm webhook hit
    console.log("DEBUG: Webhook hit. Payload:", JSON.stringify(req.body, null, 2));

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        console.log("❌ Webhook rejected: invalid signature");
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;

    if (
        !payload?.data ||
        payload.event !== 'charge.completed' ||
        payload.data.status?.toUpperCase() !== 'SUCCESSFUL'
    ) {
        console.log("⚠️ Webhook ignored: not successful charge");
        return res.status(200).send('Ignored');
    }

    const txRef = payload.data.tx_ref?.trim();

    const batchRef =
        payload.data.meta?.parent_batch_ref ||
        (txRef?.startsWith("BATCH-") ? txRef : null);

    console.log("📦 Extracted txRef:", txRef);
    console.log("📦 Extracted batchRef:", batchRef);

    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // =========================
        // 🔥 BULK LOGIC (FIXED)
        // =========================
        if (batchRef) {

            console.log(`🔄 WEBHOOK: Locking batch ${batchRef}`);

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

            console.log(`✅ Batch lock result: ${lockRes.rowCount} vouchers updated`);

            if (lockRes.rowCount === 0) {
                console.log("⚠️ WARNING: No vouchers locked. Check batchRef or status mismatch.");
            }

            await client.query('COMMIT');

            console.log(`💾 COMMIT successful for batch ${batchRef}`);

            return res.status(200).send('Batch locked successfully');
        }

        // =========================
        // SINGLE VOUCHER (UNCHANGED)
        // =========================
        else if (txRef) {

            console.log(`🔄 Processing single voucher ${txRef}`);

            const voucherResult = await client.query(
                `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE id = $1 AND status = 'PENDING' RETURNING *`,
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
                    [v.recipient_email, v.id, Number(v.amount), v.currency, `FLW-${String(payload.data.id)}`]
                );
            }

            await client.query('COMMIT');

            return res.status(200).send('Single voucher processed');
        }

        await client.query('COMMIT');
        return res.status(200).send('No action taken');

    } catch (err) {

        if (client) await client.query('ROLLBACK');

        console.error('❌ WEBHOOK ERROR:', err);

        return res.status(200).send('Error logged');

    } finally {

        if (client) client.release();
    }
});

export default router;
