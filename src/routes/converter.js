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

// POST /convert - Execute conversion with Fee Split
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();
    const reference = `TXN_${Date.now()}`;

    const fielPayFee = numericAmount * FIELPAY_FEE_PERCENT;
    const amountSentToFlw = numericAmount - fielPayFee; 

    try {
        // 1. Check Source Balance
        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [userEmail, fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient balance' });
        }

        await query('BEGIN');
        
        // 2. Deduct full amount from User
        await query(
            "UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3", 
            [numericAmount, userEmail, fromCurrency]
        );

        // 3. Deposit FielPay Fee into Platform Wallet
        await query(
            `INSERT INTO wallets (user_email, currency, available_balance, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_email, currency) 
             DO UPDATE SET available_balance = wallets.available_balance + EXCLUDED.available_balance, updated_at = NOW()`,
            [PLATFORM_EMAIL, fromCurrency, fielPayFee]
        );

        // 4. Log Transaction
        await query(`
            INSERT INTO public.transactions 
            (user_email, transaction_type, amount, fee, currency, status, reference_id, metadata, created_at) 
            VALUES ($1, 'CONVERSION', $2, $3, $4, 'PENDING', $5, $6, NOW())`,
            [userEmail, numericAmount, fielPayFee, fromCurrency, reference, JSON.stringify({ toCurrency })]
        );
        
        // 5. Trigger Transfer
        const flwRes = await triggerFlutterwaveTransfer(amountSentToFlw, fromCurrency, toCurrency, reference);
        
        if (flwRes.status !== 'success') {
            throw new Error("Flutterwave transfer rejected");
        }

        await query('COMMIT');
        res.json({ success: true, message: "Conversion successful." });

    } catch (err) {
        await query('ROLLBACK');
        res.status(500).json({ message: "Transaction failed: " + err.message });
    }
});

export default router;