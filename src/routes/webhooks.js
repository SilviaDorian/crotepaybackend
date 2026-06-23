import express from 'express';
import { getClient } from '../db/index.js';
import { sendNotification } from '../services/notificationService.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    console.log("DEBUG: Webhook hit. Event:", req.body.event);

    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        console.log("❌ Webhook rejected: Invalid signature.");
        return res.status(200).send('Unauthorized');
    }

    const { event, data } = req.body;
    
    if (data?.status?.toUpperCase() !== 'SUCCESSFUL' && event !== 'transfer.failed' && event !== 'transfer.reversed') {
        console.log("⚠️ Webhook ignored: Status not relevant.");
        return res.status(200).send('Ignored');
    }

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // --- PATH A: FLUTTERWAVE TRANSFERS (CONVERSIONS OR WITHDRAWALS) ---
        if (event === 'transfer.completed') {
            const ref = data.reference;
            
            if (ref.startsWith('WD-')) {
                console.log(`🔄 Finalizing withdrawal: ${ref}`);
                await client.query(
                    "UPDATE transactions SET status = 'SUCCESSFUL', update_at = NOW() WHERE reference_id = $1 AND status = 'PROCESSING'",
                    [ref]
                );
            } else {
                console.log(`🔄 Finalizing conversion: ${ref}`);
                const txRes = await client.query(
                    "UPDATE transactions SET status = 'SUCCESSFUL', updated_at = NOW() WHERE reference_id = $1 AND status = 'PENDING' RETURNING *",
                    [ref]
                );

                if (txRes.rowCount > 0) {
                    const tx = txRes.rows[0];
                    const metadata = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : tx.metadata;
                    const convertedAmount = parseFloat(metadata?.convertedAmount);
                    
                    if (!isNaN(convertedAmount)) {
                        await client.query(
                            `INSERT INTO wallets (user_email, currency, available_balance, updated_at)
                             VALUES ($1, $2, $3, NOW())
                             ON CONFLICT (user_email, currency) 
                             DO UPDATE SET available_balance = wallets.available_balance + EXCLUDED.available_balance, updated_at = NOW()`,
                            [tx.user_email, metadata.toCurrency, convertedAmount]
                        );
                    }
                }
            }
        }

        // --- PATH B: PAYOUT REVERSALS (ROLLBACK) ---
        else if (event === 'transfer.failed' || event === 'transfer.reversed') {
            const ref = data.reference;
            console.log(`⚠️ Processing payout rollback for: ${ref}`);

            const txRes = await client.query(
                "SELECT user_email, amount, fee, currency FROM transactions WHERE reference_id = $1 AND status = 'PROCESSING'",
                [ref]
            );

            if (txRes.rowCount > 0) {
                const tx = txRes.rows[0];
                await client.query(
                    `UPDATE wallets SET available_balance = available_balance + $1, updated_at = NOW() 
                     WHERE user_email = $2 AND currency = $3`,
                    [parseFloat(tx.amount), tx.user_email, tx.currency]
                );
                await client.query(
                    `UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() 
                     WHERE user_email = $2 AND currency = $3`,
                    [parseFloat(tx.fee), 'deepxverified@gmail.com', tx.currency]
                );
                await client.query(
                    "UPDATE transactions SET status = 'FAILED', updated_at = NOW() WHERE reference_id = $1",
                    [ref]
                );
            }
        }

        // --- PATH C: VOUCHER DEPOSITS ---
        else if (event === 'charge.completed') {
            const ref = (data.meta?.parent_batch_ref || data.tx_ref)?.trim();
            const isBatch = ref?.startsWith("BATCH-");

            if (isBatch) {
                await client.query(
                    `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                     WHERE parent_batch_ref = $1 AND status = 'PENDING'`,
                    [ref]
                );
            } else {
                const voucherResult = await client.query(
                    `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                     WHERE id = split_part($1, '_', 1) AND status = 'PENDING' RETURNING *`,
                    [ref]
                );

                if (voucherResult.rowCount > 0) {
                    const v = voucherResult.rows[0];
                    await client.query(
                        `INSERT INTO wallets (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
                         VALUES ($1, $2, $3, 0, 0, NOW())
                         ON CONFLICT (user_email, currency) 
                         DO UPDATE SET escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance, updated_at = NOW()`,
                        [v.creator_email, v.currency.toUpperCase(), Number(v.amount)]
                    );
                    
                    await client.query(
                        `INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
                         VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())`,
                        [v.creator_email, v.id, Number(v.amount), v.currency, `FLW-${String(data.id)}`]
                    );

                    await sendNotification('VOUCHER_LOCKED', v.creator_email, {
                        full_name: v.creator_name || 'User',
                        voucher_ref: v.id,
                        amount: v.amount,
                        currency: v.currency,
                        cta_link: "https://fielpay.free.nf/login.html" 
                    });
                }
            }
        }

        await client.query('COMMIT');
        return res.status(200).send('Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK ERROR:', err);
        return res.status(200).send('Error logged');
    } finally {
        if (client) client.release();
    }
});

export default router;