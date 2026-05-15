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
         * SCENARIO A: DEPOSIT (User pays for the Voucher)
         * Funds enter your FLW Merchant Account.
         * Action: Increment user's ESCROW_BALANCE.
         */
        if (payload.event === 'charge.completed') {
            const voucherId = payload.data.tx_ref; // Ensure this is just the Voucher ID or parsed correctly
            const flwStatus = payload.data.status.toUpperCase(); 
            const amountPaid = payload.data.amount;
            const currency = payload.data.currency;
            
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

                // Only increment ledger if it's a new successful payment
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
            const { reference, status, amount, currency, fee } = payload.data;
            const finalStatus = status.toUpperCase(); 

            // Find the original internal transaction
            const txResult = await client.query(
                "SELECT * FROM transactions WHERE reference_id = $1",
                [reference]
            );
            const originalTx = txResult.rows[0];

            if (originalTx) {
                // 1. Update the original transaction status
                await client.query(
                    "UPDATE transactions SET status = $1::voucher_status, updated_at = NOW() WHERE reference_id = $2",
                    [finalStatus, reference]
                );

                if (finalStatus === 'SUCCESSFUL') {
                    // Funds physically left FLW Merchant account. 
                    // Internal deduction already happened during withdrawal request.
                    console.log(`✅ Withdrawal Settled: ${amount} ${currency} for ${originalTx.user_email}`);
                } 
                else if (finalStatus === 'FAILED' || finalStatus === 'REJECTED') {
                    // Physical funds NEVER left FLW. We must REFUND the available balance.
                    await client.query(`
                        UPDATE wallets SET 
                            available_balance = available_balance + $1,
                            updated_at = NOW()
                        WHERE user_email = $2 AND currency = $3`,
                        [parseFloat(amount), originalTx.user_email, currency]
                    );

                    // Log the reversal so the user knows why their balance went back up
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
        res.status(200).send('Webhook Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("⚠️ Webhook Error:", err.message);
        res.status(200).send('Error Handled'); 
    } finally {
        if (client) client.release();
    }
});

export default router;