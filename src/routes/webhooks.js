import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

/**
 * FLUTTERWAVE WEBHOOK HANDLER
 * Endpoint: /api/webhooks/flutterwave
 */
router.post('/flutterwave', async (req, res) => {
    // 1. Authenticate the Webhook
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) {
        console.warn("⚠️ Webhook Warning: Invalid or missing verif-hash.");
        // We return 200 to prevent Flutterwave from retrying an unauthenticated request
        return res.status(200).send('Unauthorized');
    }

    const payload = req.body;
    let client;

    try {
        if (!payload || !payload.data) {
            return res.status(200).send('No data payload');
        }

        client = await getClient();
        await client.query('BEGIN');

        /**
         * SCENARIO A: DEPOSIT (User pays to fund a Voucher)
         * Event: 'charge.completed'
         */
        if (payload.event === 'charge.completed') {
            const voucherId = payload.data.tx_ref; 
            const flwStatus = payload.data.status.toUpperCase(); // SUCCESSFUL
            const amountPaid = payload.data.amount;
            const currency = payload.data.currency;
            
            console.log(`[Webhook] Processing Payment: ${voucherId} | Status: ${flwStatus}`);

            // Lock the voucher row
            const result = await client.query(
                "SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", 
                [voucherId]
            );
            const v = result.rows[0];

            if (v) {
                // Determine target status
                const targetStatus = (flwStatus === 'SUCCESSFUL') ? 'LOCKED' : 'FAILED';

                // Update Voucher Status
                await client.query(
                    "UPDATE vouchers SET status = $1::voucher_status, updated_at = NOW() WHERE id = $2",
                    [targetStatus, voucherId]
                );

                // Only update ledger if it's a new SUCCESSFUL payment for a PENDING voucher
                if (flwStatus === 'SUCCESSFUL' && v.status === 'PENDING') {
                    // 1. Update Wallet: Increase Escrow Balance
                    await client.query(`
                        INSERT INTO wallets (user_email, escrow_balance, available_balance, currency) 
                        VALUES ($1, $2, 0, $3)
                        ON CONFLICT (user_email, currency) 
                        DO UPDATE SET 
                            escrow_balance = wallets.escrow_balance + $2,
                            updated_at = NOW()`,
                        [v.creator_email, amountPaid, currency]
                    );

                    // 2. Log Transaction: Using amount_usd and fee_usd as per your schema
                    // Note: fee_usd is 0 here as the 7% fee is only taken during 'release'
                    await client.query(`
                        INSERT INTO transactions (
                            user_email, voucher_id, transaction_type, amount_usd, fee_usd, status, reference_id, currency
                        ) VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, 0, 'SUCCESSFUL'::voucher_status, $4, $5)`,
                        [v.creator_email, v.id, amountPaid, `FLW-${payload.data.id}`, currency]
                    );
                    
                    console.log(`✅ Ledger Updated: ${amountPaid} ${currency} added to Escrow for ${v.creator_email}`);
                }
            } else {
                console.error(`❌ DB Error: Voucher ID ${voucherId} not found.`);
            }
        }

        /**
         * SCENARIO B: WITHDRAWAL (Flutterwave Transfer API)
         * Event: 'transfer.completed'
         */
        if (payload.event === 'transfer.completed') {
            const { reference, status, amount, currency } = payload.data;
            const finalStatus = status.toUpperCase(); 

            const txResult = await client.query(
                "SELECT * FROM transactions WHERE reference_id = $1",
                [reference]
            );
            const originalTx = txResult.rows[0];

            if (originalTx) {
                // Update original transaction status
                await client.query(
                    "UPDATE transactions SET status = $1::voucher_status, updated_at = NOW() WHERE reference_id = $2",
                    [finalStatus, reference]
                );

                if (finalStatus === 'FAILED' || finalStatus === 'REJECTED') {
                    // Refund the user's available balance
                    await client.query(`
                        UPDATE wallets SET 
                            available_balance = available_balance + $1,
                            updated_at = NOW()
                        WHERE user_email = $2 AND currency = $3`,
                        [parseFloat(amount), originalTx.user_email, currency]
                    );

                    // Log the reversal
                    await client.query(`
                        INSERT INTO transactions (
                            user_email, transaction_type, amount_usd, fee_usd, status, reference_id, currency
                        ) VALUES ($1, 'WITHDRAWAL_REVERSAL', $2, 0, 'SUCCESSFUL'::voucher_status, $3, $4)`,
                        [originalTx.user_email, amount, `REV-${reference}`, currency]
                    );
                    
                    console.log(`↺ Withdrawal Reversed: ${amount} ${currency} returned to ${originalTx.user_email}`);
                }
            }
        }

        await client.query('COMMIT');
        res.status(200).send('OK');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("⚠️ Webhook Processing Error:", err.message);
        res.status(200).send('Error Processed'); 
    } finally {
        if (client) client.release();
    }
});

export default router;