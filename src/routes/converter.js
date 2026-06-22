import express from 'express';
import { query } from '../db/index.js';
import { getLiveRate } from '../utils/converterUtils.js';

const router = express.Router();
const CONVERSION_FEE_PERCENT = 0.02;

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
                currency: to,              // The currency you want to receive (destination)
                debit_currency: from,      // The currency you are spending (source)
                account_bank: "flutterwave",
                account_number: "100640506", // Your Merchant ID
                reference: reference,
                narration: `Conversion Ref: ${reference}`
            })
        });
        return await response.json();
    } catch (err) {
        console.error("Flutterwave Intra-Wallet Transfer Error:", err);
        return { status: 'error' };
    }
}

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
        
        res.json({ 
            rate, 
            fee, 
            convertedAmount: converted 
        });
    } catch (err) {
        console.error("Conversion Preview Error:", err.message);
        res.status(500).json({ error: "Rate unavailable" });
    }
});

// POST /convert - Execute conversion
router.post('/convert', async (req, res) => {
    const { email, amount, fromCurrency, toCurrency } = req.body;
    const numericAmount = parseFloat(amount);
    const userEmail = email.toLowerCase().trim();
    const reference = `TXN_${Date.now()}`;

    try {
        const fee = numericAmount * CONVERSION_FEE_PERCENT;
        const netAmountToConvert = numericAmount - fee; 

        // 1. Check Source Balance
        const walletRes = await query(
            "SELECT available_balance FROM public.wallets WHERE user_email = $1 AND currency = $2",
            [userEmail, fromCurrency]
        );

        if (walletRes.rows.length === 0 || parseFloat(walletRes.rows[0].available_balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient available balance' });
        }

        const rate = await getLiveRate(fromCurrency, toCurrency, netAmountToConvert);
        const convertedAmount = netAmountToConvert * rate;

        // START TRANSACTION
        await query('BEGIN');
        
        // 2. Lock Source Funds
        await query(
            "UPDATE public.wallets SET available_balance = available_balance - $1 WHERE user_email = $2 AND currency = $3", 
            [numericAmount, userEmail, fromCurrency]
        );

        // 3. Log Transaction as PENDING
        await query(`
            INSERT INTO public.transactions 
            (user_email, transaction_type, amount, fee, currency, status, reference_id, metadata, created_at) 
            VALUES ($1, 'CONVERSION', $2, $3, $4, 'PENDING', $5, $6, NOW())`,
            [
                userEmail, 
                numericAmount, 
                fee, 
                fromCurrency, 
                'PENDING', 
                reference,
                JSON.stringify({ toCurrency, convertedAmount })
            ]
        );
        
        // TRIGGER FLUTTERWAVE BEFORE COMMITTING
        const flwRes = await triggerFlutterwaveTransfer(numericAmount, fromCurrency, toCurrency, reference);
        
        if (flwRes.status !== 'success') {
            console.error("FLW Trigger Failed - Rolling Back:", flwRes);
            await query('ROLLBACK'); // Reverts the wallet deduction and the log entry
            return res.status(500).json({ message: "Flutterwave transfer failed, transaction cancelled." });
        }

        // COMMIT ONLY IF FLUTTERWAVE SUCCEEDED
        await query('COMMIT');
        res.json({ success: true, message: "Conversion initiated successfully." });

    } catch (err) {
        await query('ROLLBACK'); // Safety catch for DB errors
        console.error("Conversion Transaction Error:", err);
        res.status(500).json({ message: "Transaction failed: " + err.message });
    }
});

export default router;