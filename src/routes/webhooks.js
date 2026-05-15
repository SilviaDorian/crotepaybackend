import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

/**
 * FLUTTERWAVE WEBHOOK HANDLER
 * Endpoint: /api/webhooks/flutterwave
 */
router.post('/flutterwave', async (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    // 1. Verify the authenticity of the webhook
    if (!signature || signature !== secretHash) {
        return res.status(401).end(); 
    }

    const payload = req.body;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');

        /**
         * SCENARIO A: DEPOSIT (User pays for the Voucher)
         * Funds enter your FLW Merchant Account.
         * Action: Increment user's ESCROW_BALANCE.
         */
        if (payload.event === 'charge.completed') {
            const voucherId = payload.data.tx_ref; 
            const flwStatus = payload.data.status.toUpperCase(); 
            const amountPaid = payload.data.amount;
            const currency = payload.data.currency;
            
            // Lock the voucher row for update to prevent concurrent race conditions
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            if (v) {
                const targetStatus = (flwStatus === 'SUCCESSFUL') ? 'LOCKED' : 'FAILED';

                // Update Voucher Status
                await client.query(
                    "UPDATE vouchers SET status = $1::voucher_status, updated_at = NOW() WHERE id = $2",
                    [targetStatus, voucherId]
                );

                // Only update ledger if it's a new successful payment for a PENDING voucher
                if (flwStatus === 'SUCCESSFUL' && v.status === 'PENDING') {
                    // Update Internal Wallet: Increase Escrow
                    await client.query(`
                        INSERT INTO wallets (user_email, escrow_balance, available_balance, currency) 
                        VALUES ($1, $2, 0, $3)
                        ON CONFLICT (user_email, currency) 
                        DO UPDATE SET 
                            escrow_balance = wallets.escrow_balance + $2,
                            updated_at = NOW()`,
                        [v.creator_email, amountPaid, currency]
                    );

                    // Log the Escrow Deposit Transaction
                    await client.query(`
                        INSERT INTO transactions (
                            user_email, voucher_id, transaction_type, amount_usd, status, reference_id, currency
                        ) VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, 'SUCCESSFUL'::voucher_status, $4, $5)`,
                        [v.creator_email, v.id, amountPaid, `FLW-CHG-${payload.data.id}`, currency]
                    );
                }
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL (Flutterwave Transfer API)
         * Funds leave your FLW Merchant Account to user's bank.
         * Action: Finalize deduction or REVERSE if bank transfer fails.
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount, currency } = payload.data;
            const finalStatus = status.toUpperCase(); 

            // Find the original internal transaction created by withdraw.js
            const txResult = await client.query(
                "SELECT * FROM transactions WHERE reference_id = $1",
                [reference]
            );
            const originalTx = txResult.rows[0];

            if (originalTx) {
                // 1. Update the original transaction status (flipping from PROCESSING to result)
                await client.query(
                    "UPDATE transactions SET status = $1::voucher_status, updated_at = NOW() WHERE reference_id = $2",
                    [finalStatus, reference]
                );

                if (finalStatus === 'SUCCESSFUL') {
                    console.log(`✅ Withdrawal Settled: ${amount} ${currency} for ${originalTx.user_email}`);
                } 
                else if (finalStatus === 'FAILED' || finalStatus === 'REJECTED') {
                    // Transfer failed at the bank level. Refund the user's available balance.
                    await client.query(`
                        UPDATE wallets SET 
                            available_balance = available_balance + $1,
                            updated_at = NOW()
                        WHERE user_email = $2 AND currency = $3`,
                        [parseFloat(amount), originalTx.user_email, currency]
                    );

                    // Log the reversal for the user's history
                    await client.query(`
                        INSERT INTO transactions (
                            user_email, transaction_type, amount_usd, status, reference_id, currency
                        ) VALUES ($1, 'WITHDRAWAL_REVERSAL', $2, 'SUCCESSFUL'::voucher_status, $3, $4)`,
                        [originalTx.user_email, amount, `REF-${reference}`, currency]
                    );
                    
                    console.log(`↺ Withdrawal Failed: ${amount} ${currency} refunded to ${originalTx.user_email}`);
                }
            }
        }

        await client.query('COMMIT');
        // Flutterwave requires a 200 OK response to stop retrying the webhook
        res.status(200).send('Webhook Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("⚠️ Webhook Error:", err.message);
        // We still send 200 so Flutterwave doesn't bombard the server if it's a logic error
        res.status(200).send('Error Handled'); 
    } finally {
        if (client) client.release();
    }
});

export default router;