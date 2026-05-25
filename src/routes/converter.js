import express from 'express';
import { query } from '../db/index.js';
import { getLiveRate } from '../utils/converterUtils.js';
import cron from 'node-cron';

const router = express.Router();
const CONVERSION_FEE_PERCENT = 0.02;
const OWNER_EMAIL = 'deepxverified@gmail.com';

// Helper: Initiate Flutterwave Transfer
async function triggerFlutterwaveTransfer(amount, from, to, reference) {
    try {
        const response = await fetch('https://api.flutterwave.com/v3/transfers', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: amount,
                currency: from,
                destination_currency: to,
                narration: `Conversion Ref: ${reference}`,
                reference: reference
            })
        });
        return await response.json();
    } catch (err) {
        console.error("Flutterwave API Error:", err);
        return { status: 'error' };
    }
}

// POST /convert
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();
    const reference = `TXN_${Date.now()}`;

    try {
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const netAmountToConvert = numericAmount - fee; 

        // 1. Check Balance
        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [userEmail, fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient available balance' });
        }

        const rate = await getLiveRate(fromCurrency, toCurrency, netAmountToConvert);
        const convertedAmount = netAmountToConvert * rate;

        await query('BEGIN');
        
        // 2. Move to Awaiting Settlement
        await query(
            "UPDATE public.wallets SET available_balance = available_balance - $1, awaiting_settlement = awaiting_settlement + $1 WHERE user_email = $2 AND currency = $3", 
            [numericAmount, userEmail, fromCurrency]
        );

        // 3. Log as PENDING
        await query(`
            INSERT INTO public.transactions 
            (user_email, transaction_status, amount, fee, from_currency, to_currency, converted_amount, status, created_at, reference) 
            VALUES ($1, 'CONVERSION', $2, $3, $4, $5, $6, 'PENDING', NOW(), $7)`,
            [userEmail, numericAmount, fee, fromCurrency, toCurrency, convertedAmount, reference]
        );
            
        await query('COMMIT');

        // 4. Instantaneously send request to Flutterwave
        triggerFlutterwaveTransfer(numericAmount, fromCurrency, toCurrency, reference)
            .then(flwRes => {
                if (flwRes.status !== 'success') {
                    console.error("Critical: Flutterwave transfer failed to initiate", flwRes);
                    // Optionally: Update transaction status to 'FAILED_API' in DB here
                }
            });

        res.json({ success: true, message: "Conversion initiated. Funds are pending 3-day settlement." });
    } catch (err) {
        await query('ROLLBACK');
        res.status(500).json({ message: "Transaction failed: " + err.message });
    }
});

// Daily Cron Job (3-day settlement logic remains as discussed)
cron.schedule('0 1 * * *', async () => {
    // Reconciliation logic would go here, checking status of the 'reference'
});

export default router;