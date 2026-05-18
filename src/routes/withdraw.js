import express from 'express';
import axios from 'axios';
import { getClient, query } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js'; 

const router = express.Router();

const BYPASS_EMAILS = ['deepxverified@gmail.com', 'mitounamadike@gmail.com', 'tester@fielpay.com'];
const SERVICE_FEE_PERCENT = 0.07; 

/**
 * NEW: GET WALLET & KYC PROFILE BY USER EMAIL
 * Resolves the frontend 404 on /api/wallets/:email 
 * (Ensure this router is mounted as app.use('/api/wallets', walletRouter) or app.use('/api/withdraw', withdrawRouter))
 */
router.get('/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const result = await query(
            `SELECT u.kyc_tier, w.available_balance, w.daily_withdraw_limit, w.currency 
             FROM public.users u
             LEFT JOIN public.wallets w ON u.email = w.user_email
             WHERE u.email = $1`,
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Wallet or account profile not found." });
        }

        // Return a clean JSON payload matching frontend expected values
        return res.json(result.rows[0]);
    } catch (err) {
        console.error("Wallet Sync API Fetch Error:", err.message);
        return res.status(500).json({ success: false, error: "Internal database verification connection dropped." });
    }
});

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
router.post('/request', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;
    const targetCurrency = currency || 'NGN';
    const isTester = BYPASS_EMAILS.includes(email);
    
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid withdrawal amount." });
    }

    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const userRes = await client.query(
            `SELECT u.email, u.kyc_tier, w.available_balance, w.daily_withdraw_limit, w.currency as wallet_currency
             FROM public.users u 
             JOIN public.wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, 
            [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Account or Wallet profile matching parameter arrays not found.");

        const requestedAmount = parseFloat(amount);
        const sourceCurrency = user.wallet_currency || 'NGN';

        if (!isTester) {
            if (user.kyc_tier < 2) throw new Error("KYC Tier 2 required for withdrawals.");
            if (requestedAmount > parseFloat(user.daily_withdraw_limit)) throw new Error("Daily settlement operating limits exceeded.");
            if (parseFloat(user.available_balance) < requestedAmount) throw new Error("Insufficient transactional balance engine exception.");
        }

        const serviceFee = requestedAmount * SERVICE_FEE_PERCENT;
        const netAmount = requestedAmount - serviceFee;

        const flwRef = `WD-${Date.now()}-${email.replace('@', '_at_')}`;
        
        // Step A: Deduct funds internally
        // Database Schema Fallback alignment: Using update_at to prevent runtime exceptions
        await client.query(
            `UPDATE public.wallets 
             SET available_balance = available_balance - $1, update_at = NOW() 
             WHERE user_email = $2 AND currency = $3`,
            [requestedAmount, email, sourceCurrency]
        );

        // Step B: Call Flutterwave Utility
        const flwResponse = await triggerBankTransfer({
            amount: netAmount,
            sourceCurrency: sourceCurrency, 
            targetCurrency: targetCurrency, 
            bankCode,
            accountNumber,
            reference: flwRef
        });

        // Step C: Record transaction 
        await client.query(`
            INSERT INTO public.transactions (
                user_email, transaction_type, amount, fee, status, reference_id, currency, metadata, update_at
            ) VALUES ($1, 'WITHDRAWAL', $2, $3, 'PROCESSING'::text::voucher_status, $4, $5, $6, NOW())`,
            [
                email, requestedAmount, serviceFee, flwRef, sourceCurrency,
                JSON.stringify({
                    target_currency: targetCurrency,
                    target_amount: flwResponse?.local_amount || netAmount,
                    bank_code: bankCode,
                    account: accountNumber
                })
            ]
        );

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            message: "Withdrawal successfully initialized.", 
            details: {
                sent: `${flwResponse?.local_amount || netAmount} ${targetCurrency}`,
                rate: flwResponse?.applied_rate || 1.0
            }
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Core Withdrawal Engine Exception:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

export default router;