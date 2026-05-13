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
         * SCENARIO A: CLIENT (Payer) PAYS THE VOUCHER
         * Physical money enters your Merchant Account.
         * Ledger: Add to Client's Escrow Balance.
         */
        if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
            const voucherId = payload.data.tx_ref; // Assuming tx_ref was set to Voucher ID during checkout
            
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            // Only process if voucher is PENDING to avoid double-crediting
            if (v && v.status === 'PENDING') {
                // 1. Lock Voucher (Money is now in Escrow)
                await client.query(
                    "UPDATE vouchers SET status = 'LOCKED', updated_at = NOW() WHERE id = $1",
                    [voucherId]
                );

                // 2. Update Client's (Recipient) Escrow Ledger
                // We track it on the Client's side because they "own" the money until they release it
                await client.query(`
                    INSERT INTO wallets (user_email, escrow_balance, currency) 
                    VALUES ($1, $2, $3)
                    ON CONFLICT (user_email) 
                    DO UPDATE SET 
                        escrow_balance = wallets.escrow_balance + $2,
                        updated_at = NOW()`,
                    [v.recipient_email, v.amount, v.currency]
                );

                // 3. Log the Deposit in Transactions for the Creator (Seller) to see
                await client.query(`
                    INSERT INTO transactions (
                        user_email, voucher_id, transaction_type, amount_usd, status, reference_id
                    ) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        v.creator_email, 
                        v.id, 
                        'ESCROW_DEPOSIT', 
                        v.amount, 
                        'SUCCESSFUL', 
                        `FLW-${payload.data.id}`
                    ]
                );
                
                console.log(`✅ Webhook: Voucher ${voucherId} secured in Escrow.`);
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL STATUS UPDATE
         * Physical money is leaving (or failed to leave) your Merchant Account.
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount, currency } = payload.data;
            
            // 1. Update the Transaction Record
            await client.query(
                "UPDATE transactions SET status = $1, updated_at = NOW() WHERE reference_id = $2",
                [status, reference]
            );

            // 2. If the Bank Transfer FAILED, we must refund the Ledger
            if (status === 'FAILED') {
                console.error(`❌ Withdrawal FAILED for ref: ${reference}. Refunding Ledger...`);
                
                // Extract email from reference (Format: FP-WD-TIMESTAMP-EMAIL)
                const parts = reference.split('-');
                const email = parts[parts.length - 1]; 

                // Note: Using a fixed rate or fetching live rate for USD refund
                // If your system is purely USD internally, use the original amount
                const refundAmount = parseFloat(amount); 

                await client.query(`
                    UPDATE wallets SET 
                        available_balance = available_balance + $1,
                        updated_at = NOW()
                    WHERE user_email = $2`,
                    [refundAmount, email]
                );

                // Log the Refund Transaction
                await client.query(`
                    INSERT INTO transactions (
                        user_email, transaction_type, amount_usd, status, reference_id
                    ) VALUES ($1, 'REFUND', $2, 'SUCCESSFUL', $3)`,
                    [email, refundAmount, `REF-${reference}`]
                );
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