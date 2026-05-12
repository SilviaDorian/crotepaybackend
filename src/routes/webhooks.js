import express from 'express';
import { getClient } from '../db/index.js';
import axios from 'axios';

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
         * SCENARIO A: PAYER DEPOSITS MONEY (Voucher Payment)
         */
        if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
            const voucherId = payload.data.tx_ref; 
            
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            if (v && v.status === 'PENDING') {
                // 1. Lock Voucher
                await client.query(
                    "UPDATE vouchers SET status = 'LOCKED', updated_at = NOW() WHERE id = $1",
                    [voucherId]
                );

                // 2. Update Recipient's Escrow Balance
                await client.query(`
                    INSERT INTO wallets (user_email, escrow_balance, currency) 
                    VALUES ($1, $2, $3)
                    ON CONFLICT (user_email) 
                    DO UPDATE SET 
                        escrow_balance = wallets.escrow_balance + $2,
                        updated_at = NOW()`,
                    [v.recipient_email, v.amount, v.currency]
                );

                // 3. NEW: Log the DEPOSIT in transactions table
                await client.query(`
                    INSERT INTO transactions (
                        user_email, voucher_id, transaction_type, amount_usd, status, reference_id, metadata
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        v.creator_email, 
                        v.id, 
                        'DEPOSIT', 
                        v.amount, 
                        'SUCCESSFUL', 
                        `DEP-${payload.data.id}`, 
                        JSON.stringify(payload.data)
                    ]
                );
                
                console.log(`✅ Webhook: Voucher ${voucherId} locked and Deposit logged.`);
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL (BANK TRANSFER) STATUS
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount, currency } = payload.data;
            
            // 1. Update the Transaction Record status
            await client.query(
                "UPDATE transactions SET status = $1, updated_at = NOW() WHERE reference_id = $2",
                [status, reference]
            );

            if (status === 'SUCCESSFUL') {
                console.log(`💰 Webhook: Withdrawal SUCCESS for ref: ${reference}`);
            } 
            else if (status === 'FAILED') {
                console.error(`❌ Webhook: Withdrawal FAILED for ref: ${reference}. Refunding...`);
                
                // Get email from the reference suffix we created in withdraw.js
                const email = reference.split('-').pop(); 

                // Calculate USD refund based on current rates
                const rateResponse = await axios.get(
                    `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGERATE_API_KEY}/pair/${currency}/USD`
                );
                const rate = rateResponse.data.conversion_rate;
                const usdRefund = parseFloat((amount * rate).toFixed(4));

                // 2. Refund the User's Available Balance
                await client.query(`
                    UPDATE wallets SET 
                        available_balance = available_balance + $1,
                        updated_at = NOW()
                    WHERE user_email = $2`,
                    [usdRefund, email]
                );

                // 3. NEW: Log the REFUND as a separate transaction for the audit trail
                await client.query(`
                    INSERT INTO transactions (
                        user_email, transaction_type, amount_usd, status, reference_id, metadata
                    ) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        email, 
                        'REFUND', 
                        usdRefund, 
                        'SUCCESSFUL', 
                        `REF-${reference}`, 
                        JSON.stringify({ reason: "Bank transfer failed", original_ref: reference })
                    ]
                );
                
                console.log(`🔄 Refunded $${usdRefund} USD to ${email}.`);
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