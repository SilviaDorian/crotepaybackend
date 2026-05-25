import express from 'express';
import { query } from '../db/index.js';
import { getLiveRate } from '../utils/converterUtils.js';

const router = express.Router();
const CONVERSION_FEE_PERCENT = 0.02;
const OWNER_EMAIL = 'deepxverified@gmail.com';

// GET /preview - Calculate conversion details
router.get('/preview', async (req, res) => {
    const { amount, from, to } = req.query;
    const numericAmount = parseFloat(amount);
    
    if (!numericAmount || numericAmount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    try {
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const netAmount = numericAmount - fee;
        const rate = await getLiveRate(from, to, netAmount);
        const converted = netAmount * rate;
        
        res.json({ rate, fee, convertedAmount: converted });
    } catch (err) {
        console.error("Conversion Preview Error:", err.message);
        res.status(500).json({ error: "Rate unavailable" });
    }
});

// POST /convert - Execute the conversion
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();

    try {
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const netAmountToConvert = numericAmount - fee; 

        // 1. Check User Balance
        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [userEmail, fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient available balance' });
        }

        // 2. Get Live Rate and Convert
        const rate = await getLiveRate(fromCurrency, toCurrency, netAmountToConvert);
        const convertedAmount = netAmountToConvert * rate;

        await query('BEGIN');
        
        // 3. Deduct Total Amount from User
        await query(
            "UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3", 
            [numericAmount, userEmail, fromCurrency]
        );

        // 4. Credit Admin Wallet with the Fee
        await query(`
            INSERT INTO public.wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email, currency) DO UPDATE 
            SET available_balance = public.wallets.available_balance + EXCLUDED.available_balance`,
            [OWNER_EMAIL, fee, fromCurrency]
        );

        // 5. Credit Recipient Wallet with Converted Amount
        await query(`
            INSERT INTO public.wallets (user_email, available_balance, currency) 
            VALUES ($1, $2, $3) 
            ON CONFLICT (user_email, currency) DO UPDATE 
            SET available_balance = public.wallets.available_balance + EXCLUDED.available_balance`,
            [userEmail, convertedAmount, toCurrency]
        );

        // 6. Log the Transaction
        await query(`
            INSERT INTO public.transactions (user_email, transaction_status, amount, fee, currency, status) 
            VALUES ($1, 'CONVERSION', $2, $3, $4, 'SUCCESSFUL')`,
            [userEmail, numericAmount, fee, fromCurrency]
        );
            
        await query('COMMIT');

        res.json({ success: true, convertedAmount });
    } catch (err) {
        await query('ROLLBACK');
        console.error("Conversion Error:", err);
        res.status(500).json({ message: "Transaction failed: " + err.message });
    }
});

export default router;