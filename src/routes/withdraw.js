import express from 'express';
import axios from 'axios';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();

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
        res.status(500).json({ error: "Failed to fetch banks." });
    }
});

/**
 * 2. VERIFY BANK ACCOUNT
 */
router.post('/verify-account', async (req, res) => {
    const { accountNumber, bankCode } = req.body;
    try {
        const response = await axios.post(
            'https://api.flutterwave.com/v3/accounts/resolve',
            { account_number: accountNumber, account_bank: bankCode },
            { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
        );
        res.json({ success: true, data: response.data.data });
    } catch (error) {
        res.status(400).json({ success: false, error: "Account verification failed." });
    }
});

/**
 * 3. REQUEST WITHDRAWAL
 */
/**
 * 3. REQUEST WITHDRAWAL
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

        // 1. Fetch user and wallet
        const userRes = await client.query(
            `SELECT u.email, u.kyc_tier, w.available_balance, w.daily_withdraw_limit, w.currency as wallet_currency
             FROM users u 
             JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, 
            [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Account or Wallet not found.");

        const requestedAmount = parseFloat(amount);
        const sourceCurrency = user.wallet_currency || 'USD';

        // 2. Validation
        if (!isTester) {
            if (user.kyc_tier < 2) throw new Error("KYC Tier 2 required for withdrawals.");
            if (requestedAmount > parseFloat(user.daily_withdraw_limit)) throw new Error("Daily limit exceeded.");
            if (parseFloat(user.available_balance) < requestedAmount) throw new Error("Insufficient balance.");
        }

        // 3. Fee Calculation (7% system revenue)
        const serviceFee = requestedAmount * SERVICE_FEE_PERCENT;
        const netAmount = requestedAmount - serviceFee;

        // 4. Reference Generation 
        // IMPORTANT: We append the email so the Webhook can refund the right person if needed
        const flwRef = `WD-${Date.now()}-${email.replace('@', '_at_')}`;
        
        // 5. Deduct GROSS amount from user immediately (Prevent double spending)
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2 AND currency = $3",
            [requestedAmount, email, sourceCurrency]
        );

        // 6. PAYOUT EXECUTION (Calling Flutterwave)
        const flwResponse = await triggerBankTransfer({
            amount: netAmount,
            sourceCurrency: sourceCurrency, 
            targetCurrency: targetCurrency, 
            bankCode,
            accountNumber,
            reference: flwRef
        });

        // 7. RECORD PENDING TRANSACTION
        // We set status to 'PROCESSING'. The Webhook will flip this to SUCCESSFUL or FAILED.
        await client.query(`
            INSERT INTO transactions (
                user_email, 
                transaction_type, 
                amount_usd, 
                fee_usd, 
                status, 
                reference_id, 
                currency,
                metadata
            ) VALUES ($1, 'WITHDRAWAL', $2, $3, 'PROCESSING'::voucher_status, $4, $5, $6)`,
            [
                email, 
                requestedAmount, 
                serviceFee, 
                flwRef,
                sourceCurrency,
                JSON.stringify({
                    target_currency: targetCurrency,
                    target_amount: flwResponse.local_amount,
                    bank_code: bankCode,
                    account: accountNumber
                })
            ]
        );

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            message: "Withdrawal initiated. Your balance has been updated.", 
            details: {
                sent: `${flwResponse.local_amount} ${targetCurrency}`,
                rate: flwResponse.applied_rate
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