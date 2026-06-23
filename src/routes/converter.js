import express from 'express';
import { query } from '../db/index.js';
import { getLiveRate } from '../utils/converterUtils.js';

const router = express.Router();

const FIELPAY_FEE_PERCENT = 0.015;
const FLUTTERWAVE_FEE_PERCENT = 0.02;
const PLATFORM_EMAIL = 'deepxverified@gmail.com';

// Helper: Initiate Flutterwave Intra-Wallet Transfer
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
                currency: to,
                debit_currency: from,
                account_bank: "flutterwave",
                account_number: "100640506",
                reference: reference,
                narration: `Conversion Ref: ${reference}`
            })
        });
        return await response.json();
    } catch (err) {
        console.error("Flutterwave API Error:", err);
        return { status: 'error' };
    }
}

// GET /preview - Transparent Fee Preview
router.get('/preview', async (req, res) => {
    const { amount, from, to } = req.query;
    const numericAmount = parseFloat(amount);
    
    if (!numericAmount || numericAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const fielPayFee = numericAmount * FIELPAY_FEE_PERCENT;
    const processingFee = numericAmount * FLUTTERWAVE_FEE_PERCENT;
    const amountToFlw = numericAmount - fielPayFee; 
    
    try {
        const rate = await getLiveRate(from, to, amountToFlw);
        const finalReceived = amountToFlw * rate;
        
        res.json({ 
            rate, 
            fielPayFee: fielPayFee.toFixed(2), 
            processingFee: processingFee.toFixed(2),
            estimatedReceived: finalReceived.toFixed(2) 
        });
    } catch (err) {
        res.status(500).json({ error: "Rate unavailable" });
    }
});


// POST /convert - Execute conversion with USD Limit Check
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();
    const reference = `TXN_${Date.now()}`;
    const DAILY_LIMIT_USD = 1000.00;

    try {
        // 1. Get rate to normalize to USD for limit check
        const rateToUSD = await getLiveRate(fromCurrency, 'USD', 1);
        const amountInUSD = numericAmount * rateToUSD;

        // 2. Gatekeeper: Calculate last 24h total in USD
        const limitRes = await query(`
            SELECT COALESCE(SUM(amount * rate_to_usd), 0) as daily_total_usd 
            FROM public.transactions 
            WHERE transaction_type = 'CONVERSION' 
            AND status = 'SUCCESSFUL' 
            AND created_at > NOW() - INTERVAL '24 hours'
        `);
        
        const currentDailyTotalUSD = parseFloat(limitRes.rows[0].daily_total_usd);
        if (currentDailyTotalUSD + amountInUSD > DAILY_LIMIT_USD) {
            return res.status(403).json({ 
                message: `Daily limit reached. You have used $${currentDailyTotalUSD.toFixed(2)} of $1000 limit.` 
            });
        }

        // Logic for fees
        const fielPayFee = numericAmount * 0.015;
        const amountSentToFlw = numericAmount - fielPayFee; 

        // 3. Database Transaction
        await query('BEGIN');
        
        // Deduct from User
        await query(
            "UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3", 
            [numericAmount, userEmail, fromCurrency]
        );

        // Credit Platform Fee
        await query(
            "INSERT INTO wallets (user_email, currency, available_balance, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_email, currency) DO UPDATE SET available_balance = wallets.available_balance + EXCLUDED.available_balance",
            ['deepxverified@gmail.com', fromCurrency, fielPayFee]
        );

        // Log with rate_to_usd included
        await query(`
            INSERT INTO public.transactions 
            (user_email, transaction_type, amount, fee, currency, status, reference_id, metadata, created_at, rate_to_usd) 
            VALUES ($1, 'CONVERSION', $2, $3, $4, 'PENDING', $5, $6, NOW(), $7)`,
            [userEmail, numericAmount, fielPayFee, fromCurrency, reference, JSON.stringify({ toCurrency }), rateToUSD]
        );
        
        // Trigger FLW
        const flwRes = await triggerFlutterwaveTransfer(amountSentToFlw, fromCurrency, toCurrency, reference);
        
        if (flwRes.status !== 'success') {
            throw new Error("Flutterwave transfer failed");
        }

        await query('COMMIT');
        res.json({ success: true, message: "Conversion successful." });

    } catch (err) {
        await query('ROLLBACK');
        res.status(500).json({ message: "Transaction failed: " + err.message });
    }
});

export default router;