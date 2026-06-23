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
    
    if (data?.status?.toUpperCase() !== 'SUCCESSFUL') {
        console.log("⚠️ Webhook ignored: Status not successful.");
        return res.status(200).send('Ignored');
    }

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // --- PATH A: CURRENCY CONVERSION ---
        if (event === 'transfer.completed') {
            const ref = data.reference; 
            console.log(`🔄 Finalizing conversion: ${ref}`);
            
            const txRes = await client.query(
                "UPDATE transactions SET status = 'SUCCESSFUL', updated_at = NOW() WHERE reference_id = $1 AND status = 'PENDING' RETURNING *",
                [ref]
            );

            if (txRes.rowCount > 0) {
                const tx = txRes.rows[0];
                const metadata = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : tx.metadata;
                
                // VALIDATION: Ensure we have a valid number to credit
                const convertedAmount = parseFloat(metadata?.convertedAmount);
                if (isNaN(convertedAmount)) {
                    throw new Error(`Invalid metadata for transaction ${ref}: missing or invalid convertedAmount`);
                }
                
                await client.query(
                    `INSERT INTO wallets (user_email, currency, available_balance, updated_at)
                     VALUES ($1, $2, $3, NOW())
                     ON CONFLICT (user_email, currency) 
                     DO UPDATE SET available_balance = wallets.available_balance + EXCLUDED.available_balance, updated_at = NOW()`,
                    [tx.user_email, metadata.toCurrency, convertedAmount]
                );
                console.log(`✅ Conversion ${ref} successful. Credited ${convertedAmount} ${metadata.toCurrency}`);
            }
        }

        // --- PATH B: VOUCHER DEPOSITS ---
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
        // Returning 200 to Flutterwave prevents them from retrying failed logic unnecessarily 
        // if the error is data-related, but logs the true error on your server.
        return res.status(200).send('Error logged');
    } finally {
        if (client) client.release();
    }
});

export default router;