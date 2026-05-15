import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!signature || signature !== secretHash) {
        return res.status(401).end(); 
    }

    const payload = req.body;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');

        /**
         * SCENARIO A: DEPOSIT (Payer pays for the Voucher)
         */
        if (payload.event === 'charge.completed') {
            const voucherId = payload.data.tx_ref;
            const flwStatus = payload.data.status.toUpperCase(); 
            
            // 1. Fetch voucher & lock row
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            if (v) {
                // Determine new status based on Flutterwave feedback
                const targetStatus = (flwStatus === 'SUCCESSFUL') ? 'LOCKED' : 'FAILED';

                // 2. ALWAYS update the voucher status so the UI/Receipt can stop "Syncing"
                await client.query(
                    "UPDATE vouchers SET status = $1::voucher_status, updated_at = NOW() WHERE id = $2",
                    [targetStatus, voucherId]
                );

                // 3. ONLY update ledger if status is SUCCESSFUL and it was previously PENDING
                if (flwStatus === 'SUCCESSFUL' && v.status === 'PENDING') {
                    
                    // Update CREATOR's Escrow Balance (Internal Ledger Mirror)
                    await client.query(`
                        INSERT INTO wallets (user_email, escrow_balance, available_balance, currency) 
                        VALUES ($1, $2, 0, $3)
                        ON CONFLICT (user_email, currency) 
                        DO UPDATE SET 
                            escrow_balance = wallets.escrow_balance + $2,
                            updated_at = NOW()`,
                        [v.creator_email, v.amount, v.currency]
                    );

                    // Log Audit Transaction for the Creator
                    await client.query(`
                        INSERT INTO transactions (
                            user_email, voucher_id, transaction_type, amount_usd, status, reference_id, currency
                        ) VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, 'SUCCESSFUL'::voucher_status, $4, $5)`,
                        [v.creator_email, v.id, v.amount, `FLW-${payload.data.id}`, v.currency]
                    );
                    
                    console.log(`✅ Ledger Updated: ${v.amount} ${v.currency} credited to ${v.creator_email} (Escrow)`);
                } else if (flwStatus !== 'SUCCESSFUL') {
                    console.log(`❌ Payment Failed for Voucher: ${voucherId}. Status updated to FAILED.`);
                }
            } else {
                console.error(`⚠️ Webhook received for unknown Voucher ID: ${voucherId}`);
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL / TRANSFER
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount, currency } = payload.data;
            const finalStatus = status.toUpperCase(); 
            
            await client.query(
                "UPDATE transactions SET status = $1::voucher_status, updated_at = NOW() WHERE reference_id = $2",
                [finalStatus, reference]
            );

            if (finalStatus === 'FAILED') {
                const parts = reference.split('-');
                const email = parts[parts.length - 1]; 

                await client.query(`
                    UPDATE wallets SET 
                        available_balance = available_balance + $1,
                        updated_at = NOW()
                    WHERE user_email = $2 AND currency = $3`,
                    [parseFloat(amount), email, currency]
                );

                await client.query(`
                    INSERT INTO transactions (
                        user_email, transaction_type, amount_usd, status, reference_id, currency
                    ) VALUES ($1, 'REVERSED', $2, 'SUCCESSFUL'::voucher_status, $3, $4)`,
                    [email, amount, `REF-${reference}`, currency]
                );
            }
        }

        await client.query('COMMIT');
        res.status(200).send('Webhook Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("⚠️ Webhook Logic Error:", err.message);
        // Still send 200 to FLW so they stop retrying a broken transaction
        res.status(200).send('Error Handled'); 
    } finally {
        if (client) client.release();
    }
});

export default router;