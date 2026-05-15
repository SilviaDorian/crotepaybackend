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
    const client = await getClient();

    try {
        await client.query('BEGIN');

        /**
         * SCENARIO A: DEPOSIT (Payer pays for Voucher)
         */
        if (payload.event === 'charge.completed') {
            const voucherId = payload.data.tx_ref;
            // Flutterwave sends 'successful' or 'failed'
            const flwStatus = payload.data.status.toUpperCase(); 
            
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            if (v && v.status === 'PENDING') {
                if (flwStatus === 'SUCCESSFUL') {
                    // 1. Move Voucher to LOCKED (Explicit cast to ENUM)
                    await client.query(
                        "UPDATE vouchers SET status = 'LOCKED'::voucher_status, updated_at = NOW() WHERE id = $1",
                        [voucherId]
                    );

                    // 2. Update Payer's Escrow Balance
                    await client.query(`
                        INSERT INTO wallets (user_email, escrow_balance, currency) 
                        VALUES ($1, $2, $3)
                        ON CONFLICT (user_email) 
                        DO UPDATE SET 
                            escrow_balance = wallets.escrow_balance + $2,
                            updated_at = NOW()`,
                        [v.recipient_email, v.amount, v.currency]
                    );

                    // 3. Log Audit Transaction (Explicit cast to ENUM)
                    await client.query(`
                        INSERT INTO transactions (
                            user_email, voucher_id, transaction_type, amount_usd, status, reference_id
                        ) VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, 'SUCCESSFUL'::voucher_status, $4)`,
                        [v.creator_email, v.id, v.amount, `FLW-${payload.data.id}`]
                    );
                    
                    console.log(`✅ Escrow Secured: ${voucherId}`);
                } else {
                    // Handle Failed Payment
                    await client.query(
                        "UPDATE vouchers SET status = 'FAILED'::voucher_status, updated_at = NOW() WHERE id = $1",
                        [voucherId]
                    );
                }
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL (Transfer from Merchant to Vendor Bank)
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount } = payload.data;
            const finalStatus = status.toUpperCase(); 
            
            // 1. Update the Audit Record
            await client.query(
                "UPDATE transactions SET status = $1::voucher_status, updated_at = NOW() WHERE reference_id = $2",
                [finalStatus, reference]
            );

            // 2. If Failed, return value to Vendor's Available Balance
            if (finalStatus === 'FAILED') {
                // Assuming reference format: WD-TIMESTAMP-EMAIL
                const parts = reference.split('-');
                const email = parts[parts.length - 1]; 

                await client.query(`
                    UPDATE wallets SET 
                        available_balance = available_balance + $1,
                        updated_at = NOW()
                    WHERE user_email = $2`,
                    [parseFloat(amount), email]
                );

                await client.query(`
                    INSERT INTO transactions (
                        user_email, transaction_type, amount_usd, status, reference_id
                    ) VALUES ($1, 'REVERSED', $2, 'SUCCESSFUL'::voucher_status, $3)`,
                    [email, amount, `REF-${reference}`]
                );
                console.log(`⏪ Withdrawal Reversed for: ${email}`);
            }
        }

        await client.query('COMMIT');
        res.status(200).send('Webhook Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("⚠️ Webhook Error:", err.message);
        res.status(500).send('Internal Server Error');
    } finally {
        if (client) client.release();
    }
});

export default router;