import express from 'express';
import axios from 'axios';
import { query } from '../db/index.js';
import { getLiveRate } from '../utils/converterUtils.js'; // Import the helper

const router = express.Router();
const CONVERSION_FEE_PERCENT = 0.02;

router.get('/preview', async (req, res) => {
    const { amount, from, to } = req.query;
    try {
        const rate = await getLiveRate(from, to, parseFloat(amount));
        const fee = parseFloat(amount) * CONVERSION_FEE_PERCENT;
        const converted = (parseFloat(amount) - fee) * rate;
        res.json({ rate, fee, convertedAmount: converted });
    } catch (err) {
        // Log the actual error to your server console
        console.error("Flutterwave API Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Rate unavailable: " + (err.response?.data?.message || err.message) });
    }
});

router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();
    const OWNER_EMAIL = 'deepxverified@gmail.com'; // Add this constant

    try {
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const totalDeduction = numericAmount; 
        const netAmountToConvert = numericAmount - fee; 

        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [userEmail, fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < totalDeduction) {
            return res.status(400).json({ message: 'Insufficient available balance' });
        }

        const rate = await getLiveRate(fromCurrency, toCurrency, netAmountToConvert);
        const convertedAmount = netAmountToConvert * rate;

        await query('BEGIN');
        
        // 1. Deduct total amount from User
        await query("UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3", 
            [totalDeduction, userEmail, fromCurrency]);

        // 2. CREDIT ADMIN WALLET with the fee
        await query(`
            INSERT INTO public.wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email, currency) DO UPDATE 
            SET available_balance = public.wallets.available_balance + EXCLUDED.available_balance`,
            [OWNER_EMAIL, fee, fromCurrency]
        );

        // 3. Credit recipient wallet (the converted amount)
        await query(`INSERT INTO public.wallets (user_email, available_balance, currency) VALUES ($1, $2, $3) 
                     ON CONFLICT (user_email, currency) DO UPDATE SET available_balance = public.wallets.available_balance + EXCLUDED.available_balance`,
            [userEmail, convertedAmount, toCurrency]);

        // 4. Log the transaction
        await query("INSERT INTO public.transactions (user_email, transaction_status, amount, fee, currency, status) VALUES ($1, 'CONVERSION', $2, $3, $4, 'SUCCESSFUL')",
            [userEmail, numericAmount, fee, fromCurrency]);
            
        await query('COMMIT');

        res.json({ success: true, convertedAmount });
    } catch (err) {
        await query('ROLLBACK');
        res.status(500).json({ message: err.message });
    }
});

export default router;