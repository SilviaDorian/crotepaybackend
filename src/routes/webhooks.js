import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    // -----------------------------
    // SECURITY CHECK
    // -----------------------------
    if (!secretHash || signature !== secretHash) {
        console.warn('⚠️ Invalid webhook signature');
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;

    if (!payload?.data) {
        return res.status(200).send('No payload');
    }

    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // Only handle completed charges
        if (payload.event !== 'charge.completed') {
            await client.query('COMMIT');
            return res.status(200).send('Ignored');
        }

        const txRef = payload.data.tx_ref?.trim();
        const status = payload.data.status?.toUpperCase() || 'FAILED';
        const flutterwaveTxId = String(payload.data.id);

        console.log(`💳 WEBHOOK: ${txRef} | STATUS: ${status}`);

        if (!txRef) {
            await client.query('COMMIT');
            return res.status(200).send('Missing tx_ref');
        }

        // =========================================================
        // ONLY SUCCESSFUL PAYMENTS PROCEED TO ESCROW FUNDING
        // =========================================================
        if (status !== 'SUCCESSFUL') {
            await client.query('COMMIT');
            return res.status(200).send('Not successful');
        }

        // -----------------------------
        // CLEAN BATCH REF EXTRACTION
        // -----------------------------
        let batchRef = null;
        const meta = payload.data.meta || {};

        if (meta.parent_batch_ref) {
            batchRef = String(meta.parent_batch_ref).trim();
        } else if (meta.batch_ref) {
            batchRef = String(meta.batch_ref).trim();
        } else if (txRef && txRef.startsWith("BATCH-")) {
            batchRef = txRef;   // fallback
        }

        console.log(`🔍 WEBHOOK received batchRef: "${batchRef}" | txRef: ${txRef}`);

        // =========================================================
        // BULK PAYMENT FLOW
        // =========================================================
        if (batchRef) {
            console.log(`🔄 Processing BULK for: ${batchRef}`);

            const batchResult = await client.query(
                `
                SELECT * FROM vouchers 
                WHERE parent_batch_ref = $1 
                FOR UPDATE
                `,
                [batchRef]
            );

            console.log(`📊 Found ${batchResult.rows.length} vouchers for batch ${batchRef}`);

            if (batchResult.rows.length === 0) {
                console.warn(`⚠️ No vouchers found for batchRef: ${batchRef}`);
                await client.query('COMMIT');
                return res.status(200).send('Empty batch');
            }

            let processed = 0;

            for (const v of batchResult.rows) {
                if (v.status !== 'PENDING') {
                    console.log(`⏭ Skipping ${v.id} (status: ${v.status})`);
                    continue;
                }

                const amount = Number(v.amount);
                if (isNaN(amount) || amount <= 0) {
                    console.error(`Invalid amount for voucher ${v.id}`);
                    continue;
                }

                // 1. LOCK VOUCHER
                await client.query(
                    `
                    UPDATE vouchers
                    SET status = 'LOCKED',
                        locked_at = NOW(),
                        updated_at = NOW()
                    WHERE id = $1
                    `,
                    [v.id]
                );

                // 2. FUND ESCROW
                await client.query(
                    `
                    INSERT INTO wallets (
                        user_email,
                        escrow_balance,
                        available_balance,
                        currency,
                        updated_at
                    )
                    VALUES (
                        $1,
                        ROUND($2::numeric, 2),
                        0,
                        $3,
                        NOW()
                    )
                    ON CONFLICT (user_email, currency)
                    DO UPDATE SET
                        escrow_balance = COALESCE(wallets.escrow_balance, 0) + ROUND(EXCLUDED.escrow_balance, 2),
                        updated_at = NOW()
                    `,
                    [v.recipient_email, amount, v.currency]
                );

                // 3. TRANSACTION LOG
                await client.query(
                    `
                    INSERT INTO transactions (
                        user_email,
                        voucher_id,
                        transaction_type,
                        amount,
                        currency,
                        status,
                        reference_id,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW()
                    )
                    ON CONFLICT (reference_id) DO NOTHING
                    `,
                    [
                        v.recipient_email,
                        v.id,
                        amount,
                        v.currency,
                        `FLW-BATCH-\( {flutterwaveTxId}- \){v.id}`
                    ]
                );

                processed++;
                console.log(`✅ Funded escrow for ${v.recipient_email} | ${amount} ${v.currency}`);
            }

            console.log(`🏁 Batch ${batchRef} completed - ${processed} funded`);
            await client.query('COMMIT');
            return res.status(200).send(`Batch processed: ${processed}`);
        }

        // =========================================================
        // SINGLE VOUCHER FLOW (unchanged)
        // =========================================================
        const voucherResult = await client.query(
            `
            SELECT * FROM vouchers WHERE id = $1 FOR UPDATE
            `,
            [txRef]
        );

        if (voucherResult.rows.length === 0) {
            await client.query('COMMIT');
            return res.status(200).send('Voucher not found');
        }

        const v = voucherResult.rows[0];

        if (v.status !== 'PENDING') {
            await client.query('COMMIT');
            return res.status(200).send('Already processed');
        }

        const amount = Number(v.amount);

        // 1. LOCK
        await client.query(
            `
            UPDATE vouchers
            SET status = 'LOCKED',
                locked_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            `,
            [txRef]
        );

        // 2. FUND ESCROW
        await client.query(
            `
            INSERT INTO wallets (user_email, escrow_balance, available_balance, currency, updated_at)
            VALUES ($1, ROUND($2::numeric, 2), 0, $3, NOW())
            ON CONFLICT (user_email, currency) 
            DO UPDATE SET 
                escrow_balance = COALESCE(wallets.escrow_balance, 0) + ROUND(EXCLUDED.escrow_balance, 2),
                updated_at = NOW()
            `,
            [v.recipient_email, amount, v.currency]
        );

        // 3. TRANSACTION LOG
        await client.query(
            `
            INSERT INTO transactions (
                user_email, voucher_id, transaction_type, amount, currency, 
                status, reference_id, created_at, updated_at
            )
            VALUES ($1,$2,'ESCROW_DEPOSIT',$3,$4,'SUCCESSFUL',$5,NOW(),NOW())
            ON CONFLICT (reference_id) DO NOTHING
            `,
            [v.recipient_email, v.id, amount, v.currency, `FLW-${flutterwaveTxId}`]
        );

        await client.query('COMMIT');
        return res.status(200).send('Webhook processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK ERROR:', err.message);
        return res.status(200).send('Handled error');
    } finally {
        if (client) client.release();
    }
});

export default router;