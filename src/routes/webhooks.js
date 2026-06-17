import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

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
    const batchRef = payload.data.meta?.parent_batch_ref || 
                    (txRef?.startsWith("BATCH-") ? txRef : null);

    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        /**
         * =========================
         * BULK / BATCH LOGIC (LOCK ONLY)
         * =========================
         */
        if (batchRef) {
            console.log(`🔄 WEBHOOK: Locking batch ${batchRef}`);

            const lockRes = await client.query(
                `UPDATE vouchers 
                 SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE parent_batch_ref = $1 AND status = 'PENDING'
                 RETURNING id`,
                [batchRef]
            );

            console.log(`✅ Locked ${lockRes.rowCount} vouchers for batch ${batchRef}`);

            await client.query('COMMIT');

            // ❌ IMPORTANT: NO FUNDING TRIGGER HERE
            // Frontend (allocating-funds.html) handles funding

            return res.status(200).send('Batch locked successfully');
        }

        /**
         * =========================
         * SINGLE VOUCHER LOGIC (UNCHANGED)
         * =========================
         */
        else if (txRef) {
            console.log(`🔄 Processing single voucher ${txRef}`);

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
                    `INSERT INTO wallets 
                     (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
                     VALUES ($1, $2, $3, 0, 0, NOW())
                     ON CONFLICT (user_email, currency) 
                     DO UPDATE SET 
                        escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
                        updated_at = NOW()`,
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

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK ERROR:', err);
        return res.status(200).send('Error logged');
    } finally {
        if (client) client.release();
    }
});

export default router;
