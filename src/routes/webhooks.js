import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    // 1. Verify the Secret Hash from Flutterwave Dashboard
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
         * SCENARIO A: PAYER DEPOSITS MONEY
         * Update Voucher to LOCKED and move funds into Recipient's Escrow Wallet.
         */
        if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
            const voucherId = payload.data.tx_ref; 
            
            // Lock voucher row for update to prevent race conditions
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            if (v && v.status === 'PENDING') {
                // 1. Update Voucher Status
                await client.query(
                    "UPDATE vouchers SET status = 'LOCKED', updated_at = NOW() WHERE id = $1",
                    [voucherId]
                );

                // 2. Add money to Recipient's Escrow Balance
                // We use ON CONFLICT to create the wallet if this is their first time
                await client.query(`
                    INSERT INTO wallets (user_email, escrow_balance, currency) 
                    VALUES ($1, $2, $3)
                    ON CONFLICT (user_email) 
                    DO UPDATE SET 
                        escrow_balance = wallets.escrow_balance + $2,
                        updated_at = NOW()`,
                    [v.recipient_email, v.amount, v.currency]
                );
                
                console.log(`✅ Webhook: Voucher ${voucherId} locked. Escrow wallet updated for ${v.recipient_email}.`);
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL (BANK TRANSFER) STATUS
         * Tracks if the money actually arrived in the user's bank account.
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount, currency } = payload.data;
            
            if (status === 'SUCCESSFUL') {
                console.log(`💰 Webhook: Payout confirmed for ref: ${reference}`);
            } else if (status === 'FAILED') {
                // If transfer fails, we MUST refund the user's "Available Balance" 
                // so the money isn't lost in limbo.
                console.error(`❌ Webhook: Payout failed for ref: ${reference}. Rolling back to wallet.`);
                
                // Logic to identify user from reference and refund
                // Example reference format: WITHDRAW-timestamp-email
                const email = reference.split('-').pop(); 
                
                await client.query(`
                    UPDATE wallets SET 
                        available_balance = available_balance + $1,
                        updated_at = NOW()
                    WHERE user_email = $2`,
                    [amount, email]
                );
            }
        }

        await client.query('COMMIT');
        res.status(200).send('Webhook Processed');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("⚠️ Webhook Error:", err.message);
        res.status(500).send('Internal Server Error');
    } finally {
        client.release();
    }
});

export default router;