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


// POST /convert - Execute International Payout
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency, bankCode, accountNumber } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();
    const reference = `TXN_${Date.now()}`;
    const DAILY_LIMIT_USD = 1000.00;

    let client;
    try {
        client = await getClient(); // Ensure connection pooling
        
        // 1. Rate & Limit Validation
        const rateToUSD = await getLiveRate(fromCurrency, 'USD', 1);
        const amountInUSD = numericAmount * rateToUSD;

        const limitRes = await client.query(`
            SELECT COALESCE(SUM(amount * rate_to_usd), 0) as daily_total_usd 
            FROM public.transactions 
            WHERE user_email = $1 
            AND transaction_type = 'CONVERSION' 
            AND status = 'SUCCESSFUL' 
            AND created_at > NOW() - INTERVAL '24 hours'`, [userEmail]
        );
        
        if (parseFloat(limitRes.rows[0].daily_total_usd) + amountInUSD > DAILY_LIMIT_USD) {
            return res.status(403).json({ success: false, message: "Daily limit exceeded." });
        }

        const fielPayFee = numericAmount * 0.015;
        const amountToTransfer = numericAmount - fielPayFee;

        // 2. Start Atomic Transaction
        await client.query('BEGIN');
        
        // Deduct from User
        const updateRes = await client.query(
            "UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3 AND available_balance >= $1", 
            [numericAmount, userEmail, fromCurrency]
        );
        if (updateRes.rowCount === 0) throw new Error("Insufficient funds.");

        // Record Transaction as 'PENDING'
        await client.query(`
            INSERT INTO public.transactions (user_email, transaction_type, amount, fee, currency, status, reference_id, created_at, rate_to_usd) 
            VALUES ($1, 'CONVERSION', $2, $3, $4, 'PENDING', $5, NOW(), $6)`,
            [userEmail, numericAmount, fielPayFee, fromCurrency, reference, rateToUSD]
        );

        // 3. Trigger Flutterwave Direct Transfer
        // This maps exactly to the documentation for cross-currency payouts
        const flwRes = await triggerDirectTransfer({
            action: "instant",
            payment_instruction: {
                source_currency: fromCurrency,
                amount: { applies_to: "source_currency", value: amountToTransfer },
                recipient: { bank: { account_number: accountNumber, code: bankCode } },
                destination_currency: toCurrency
            },
            type: "bank",
            reference: reference
        });
        
        if (flwRes.status !== 'success') throw new Error("Flutterwave transfer initiation failed.");

        await client.query('COMMIT');
        res.json({ success: true, message: "Payout initialized.", reference });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(`[TXN_ERROR] ${reference}:`, err.message);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        if (client) client.release();
    }
});

// Add this route to your express/node backend
router.get('/utils/banks', async (req, res) => {
    const { country } = req.query;
    try {
        const response = await fetch(`https://api.flutterwave.com/v3/banks/${country || 'NG'}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

export default router;