import express from 'express';
import axios from 'axios';
import { query } from '../db/index.js';

const router = express.Router();
const CONVERSION_FEE_PERCENT = 0.02; // 2%

// Helper to get real Flutterwave rate
async function getLiveRate(from, to, amount) {
    const response = await axios.post(
        'https://api.flutterwave.com/v3/transfers/rates',
        { source_currency: from, destination_currency: to, amount: amount || 1 },
        { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    return Number(response.data?.data?.rate);
}

/**
 * PREVIEW ENDPOINT (For live UI feedback)
 */
router.get('/preview', async (req, res) => {
    const { amount, from, to } = req.query;
    try {
        const rate = await getLiveRate(from, to, parseFloat(amount));
        const fee = parseFloat(amount) * CONVERSION_FEE_PERCENT;
        const converted = (parseFloat(amount) - fee) * rate;
        res.json({ rate, fee, convertedAmount: converted });
    } catch (err) {
        res.status(500).json({ error: "Rate unavailable" });
    }
});

/**
 * CONVERT ENDPOINT (Atomic Execution)
 */
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();

    try {
        // 1. Balance Check
        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [userEmail, fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient available balance' });
        }

        // 2. Perform Transaction
        const rate = await getLiveRate(fromCurrency, toCurrency, numericAmount);
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const convertedAmount = (numericAmount - fee) * rate;

        await query('BEGIN');
        
        // Update Source
        await query("UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3", 
            [numericAmount, userEmail, fromCurrency]);

        // Update Destination
        await query(`INSERT INTO public.wallets (user_email, available_balance, currency) VALUES ($1, $2, $3) 
                     ON CONFLICT (user_email, currency) DO UPDATE SET available_balance = public.wallets.available_balance + EXCLUDED.available_balance`,
            [userEmail, convertedAmount, toCurrency]);

        // Log
        await query("INSERT INTO public.transactions (user_email, transaction_type, amount, currency, status) VALUES ($1, 'CONVERSION', $2, $3, 'SUCCESSFUL')",
            [userEmail, numericAmount, fromCurrency]);

        await query('COMMIT');

        // 3. Trigger Flutterwave Transfer (Async fire-and-forget)
        axios.post('https://api.flutterwave.com/v3/transfers', { /* ...config... */ }, { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } })
             .catch(e => console.error("FLW Transfer failed", e.message));

        res.json({ success: true, convertedAmount });
    } catch (err) {
        await query('ROLLBACK');
        res.status(500).json({ message: err.message });
    }
});

export default router;