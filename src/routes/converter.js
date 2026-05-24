import express from 'express';
import axios from 'axios';
import { query } from '../db/index.js';

const router = express.Router();
const CONVERSION_FEE_PERCENT = 0.02; // 2% Fee

/**
 * FETCH LIVE FLUTTERWAVE RATE
 */
async function getLiveRate(from, to, amount) {
    const response = await axios.post(
        'https://api.flutterwave.com/v3/transfers/rates',
        { source_currency: from, destination_currency: to, amount },
        { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    return Number(response.data?.data?.rate);
}

router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);

    if (!numericAmount || numericAmount <= 0) return res.status(400).json({ message: 'Invalid amount' });

    try {
        // 1. Check Available Balance (Ignore Escrow)
        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [email.toLowerCase().trim(), fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient available balance' });
        }

        // 2. Fetch Live Rate
        const rate = await getLiveRate(fromCurrency, toCurrency, numericAmount);
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const netAmount = numericAmount - fee;
        const convertedAmount = netAmount * rate;

        // 3. Database Updates (Atomic Transaction)
        await query('BEGIN');
        
        // Deduct source
        await query(
            "UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3",
            [numericAmount, email.toLowerCase().trim(), fromCurrency]
        );

        // Credit destination (Upsert)
        await query(`
            INSERT INTO public.wallets (user_email, available_balance, currency)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email, currency) 
            DO UPDATE SET available_balance = public.wallets.available_balance + EXCLUDED.available_balance
        `, [email.toLowerCase().trim(), convertedAmount, toCurrency]);

        // Log transaction
        await query(`
            INSERT INTO public.transactions (user_email, transaction_type, amount, currency, status, created_at)
            VALUES ($1, 'CONVERSION', $2, $3, 'SUCCESSFUL', NOW())
        `, [email.toLowerCase().trim(), numericAmount, fromCurrency]);

        await query('COMMIT');

        // 4. Trigger Flutterwave Transfer Immediately
        try {
            await axios.post('https://api.flutterwave.com/v3/transfers', {
                account_bank: 'flutterwave',
                amount: convertedAmount,
                currency: toCurrency,
                reference: `conv_${Date.now()}`,
                narration: `${fromCurrency} to ${toCurrency} conversion`
            }, { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } });
        } catch (flwErr) {
            console.error('Flutterwave Transfer Warning:', flwErr.message);
            // Note: DB is already updated. Log error for reconciliation.
        }

        res.json({ success: true, convertedAmount, rate, fee });

    } catch (err) {
        await query('ROLLBACK');
        res.status(500).json({ message: "Conversion failed: " + err.message });
    }
});

export default router;