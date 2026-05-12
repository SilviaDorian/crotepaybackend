import express from 'express';
import axios from 'axios';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();

// Configuration & Exceptions
const OWNER_EMAIL = 'deepxverified@gmail.com';
const BYPASS_EMAILS = ['deepxverified@gmail.com', 'mitounamadike@gmail.com', 'tester@fielpay.com'];
const SERVICE_FEE_PERCENT = 0.07; // 7%

const MIN_LIMITS = {
    'NGN': 5000, 'USD': 50, 'EUR': 50, 'GBP': 50,
    'KES': 500, 'GHS': 50, 'ZAR': 100, 'UGX': 15000, 'RWF': 10000
};

/**
 * 1. GET BANKS BY COUNTRY (Worldwide Flexibility)
 * Call this from frontend when currency changes
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
 */
router.post('/request', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;
    const targetCurrency = currency || 'NGN';
    const isTester = BYPASS_EMAILS.includes(email);
    
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount." });
    }

    const client = await getClient();

    try {
        await client.query('BEGIN');

        const userRes = await client.query(
            `SELECT u.email, u.kyc_tier, w.available_balance, w.daily_withdraw_limit 
             FROM users u 
             JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, 
            [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Account not found.");

        // --- BYPASS LOGIC FOR TESTERS ---
        if (!isTester) {
            if (user.kyc_tier < 2) throw new Error("Tier 2 KYC required.");
            if (parseFloat(amount) > parseFloat(user.daily_withdraw_limit)) throw new Error("Daily limit exceeded.");
            if (parseFloat(user.available_balance) < parseFloat(amount)) throw new Error("Insufficient balance.");
        }

        // Fee Calculation (Always 7% of USD amount)
        const serviceFeeUsd = amount * SERVICE_FEE_PERCENT;
        const netAmountUsd = amount - serviceFeeUsd;

        // Payout via Utility
        const flwResponse = await triggerBankTransfer({
            amount: netAmountUsd,
            currency: targetCurrency, 
            bankCode,
            accountNumber,
            reference: `WD-${Date.now()}-${email.split('@')[0]}`
        });

        // --- MINIMUM LIMIT CHECK (Bypassed for testers) ---
        const minRequired = MIN_LIMITS[targetCurrency] || 50;
        if (!isTester && flwResponse.local_amount < minRequired) {
            throw new Error(`Payout below minimum of ${minRequired} ${targetCurrency}.`);
        }

        // Deduct from DB
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [amount, email]
        );

        // Audit Trail
        await client.query(`
            INSERT INTO transactions (
                user_email, transaction_type, amount_usd, local_currency, local_amount, 
                exchange_rate, status, reference_id, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                email, 'WITHDRAWAL', amount, targetCurrency, 
                flwResponse.local_amount, flwResponse.applied_rate, 'SUCCESS',
                flwResponse.reference || `REF-${Date.now()}`,
                JSON.stringify({ fee_usd: serviceFeeUsd, net_usd: netAmountUsd })
            ]
        );

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            message: "Withdrawal successful.", 
            details: {
                local_payout: `${flwResponse.local_amount} ${targetCurrency}`,
                fee_charged: targetCurrency === 'NGN' ? `Applied at source` : `$${serviceFeeUsd.toFixed(2)}`
            }
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

export default router;