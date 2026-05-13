import express from 'express';
import axios from 'axios';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();

// Configuration & Exceptions
const OWNER_EMAIL = 'deepxverified@gmail.com';
const BYPASS_EMAILS = ['deepxverified@gmail.com', 'mitounamadike@gmail.com', 'tester@fielpay.com'];
const SERVICE_FEE_PERCENT = 0.07; // 7% System Fee

const MIN_LIMITS = {
    'NGN': 5000, 'USD': 50, 'EUR': 50, 'GBP': 50,
    'KES': 500, 'GHS': 50, 'ZAR': 100, 'UGX': 15000, 'RWF': 10000
};

/**
 * 1. GET BANKS BY COUNTRY
 */
router.get('/banks/:country', async (req, res) => {
    try {
        const response = await axios.get(`https://api.flutterwave.com/v3/banks/${req.params.country}`, {
            headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
        });
        res.json({ success: true, data: response.data.data });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch banks for this region." });
    }
});

/**
 * 2. VERIFY BANK ACCOUNT
 */
router.post('/verify-account', async (req, res) => {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) return res.status(400).json({ error: "Details missing." });

    try {
        const response = await axios.post(
            'https://api.flutterwave.com/v3/accounts/resolve',
            { account_number: accountNumber, account_bank: bankCode },
            { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
        );
        res.json({ success: true, data: response.data.data });
    } catch (error) {
        res.status(400).json({ success: false, error: "Resolution service unavailable." });
    }
});

/**
 * 3. REQUEST WITHDRAWAL
 * Deducts from Available Balance and triggers physical transfer.
 */
router.post('/request', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;
    const targetCurrency = currency || 'NGN';
    const isTester = BYPASS_EMAILS.includes(email);
    
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid withdrawal amount." });
    }

    const client = await getClient();

    try {
        await client.query('BEGIN');

        // Fetch user and wallet details
        const userRes = await client.query(
            `SELECT u.email, u.kyc_tier, w.available_balance, w.daily_withdraw_limit 
             FROM users u 
             JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, 
            [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Account or Wallet not found.");

        const requestedAmount = parseFloat(amount);

        // --- VALIDATION (Bypassed for testers) ---
        if (!isTester) {
            if (user.kyc_tier < 2) throw new Error("KYC Tier 2 (Identity Verification) required for withdrawals.");
            if (requestedAmount > parseFloat(user.daily_withdraw_limit)) throw new Error("Daily withdrawal limit exceeded.");
            if (parseFloat(user.available_balance) < requestedAmount) throw new Error("Insufficient available balance.");
        }

        // --- FEE LOGIC ---
        // The ledger records the GROSS amount being deducted
        const serviceFeeUsd = requestedAmount * SERVICE_FEE_PERCENT;
        const netAmountUsd = requestedAmount - serviceFeeUsd;

        // --- PAYOUT EXECUTION ---
        // We pass the net amount (after 7% fee) to the bank transfer utility
        const flwResponse = await triggerBankTransfer({
            amount: netAmountUsd,
            currency: targetCurrency, 
            bankCode,
            accountNumber,
            // ID formatted for Webhook tracking: WD-TIME-EMAIL
            reference: `WD-${Date.now()}-${email.split('@')[0]}`
        });

        // --- MINIMUM LIMIT CHECK ---
        const minRequired = MIN_LIMITS[targetCurrency] || 50;
        if (!isTester && flwResponse.local_amount < minRequired) {
            throw new Error(`The converted payout is below the regional minimum of ${minRequired} ${targetCurrency}.`);
        }

        // --- LEDGER UPDATE ---
        // Deduct the full amount from the digital ledger
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [requestedAmount, email]
        );

        // --- RECORD TRANSACTION ---
        await client.query(`
            INSERT INTO transactions (
                user_email, transaction_type, amount_usd, fee_usd, status, reference_id, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                email, 
                'WITHDRAWAL', 
                requestedAmount, 
                serviceFeeUsd, 
                'PENDING', // Set to PENDING until Flutterwave Webhook confirms success
                flwResponse.reference,
                JSON.stringify({
                    local_currency: targetCurrency,
                    local_amount: flwResponse.local_amount,
                    exchange_rate: flwResponse.applied_rate
                })
            ]
        );

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            message: "Withdrawal initiated. Your bank account will be credited shortly.", 
            details: {
                net_payout: `${flwResponse.local_amount} ${targetCurrency}`,
                exchange_rate: flwResponse.applied_rate
            }
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Withdrawal Error:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

export default router;