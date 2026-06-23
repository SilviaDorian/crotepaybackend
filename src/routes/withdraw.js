import express from 'express';
import axios from 'axios';
import { getClient, query } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js'; 

const router = express.Router();

const BYPASS_EMAILS = ['deepxverified@gmail.com', 'mitounamadike@gmail.com', 'tester@fielpay.com'];
const PLATFORM_EMAIL = 'deepxverified@gmail.com';
const PLATFORM_FEE_PERCENT = 0.05;
const TOTAL_DEDUCTION_PERCENT = 0.07;

const VALIDATION_RATES = {
    'NGN': 1550.00, 'GHS': 14.50, 'KES': 130.00, 'UGX': 3750.00, 'TZS': 2600.00,
    'ZAR': 18.50, 'GBP': 0.79, 'EUR': 0.92, 'USD': 1.00, 'CAD': 1.37,
    'XOF': 600.00, 'RWF': 1300.00, 'ZMW': 27.00, 'MWK': 1730.00, 'XAF': 600.00
};

const checkMinimumLimit = (amount, currency) => {
    const targetCurrency = currency.toUpperCase();
    if (targetCurrency === 'NGN') return amount >= 5000;
    const rate = VALIDATION_RATES[targetCurrency] || 1.0;
    return amount >= (50 * rate);
};

router.get('/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const result = await query(
            `SELECT u.kyc_tier, u.full_name, w.available_balance, w.daily_withdraw_limit, w.currency 
             FROM public.users u
             LEFT JOIN public.wallets w ON u.email = w.user_email
             WHERE u.email = $1`,
            [email]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: "Profile not found." });
        return res.json(result.rows[0]);
    } catch (err) {
        return res.status(500).json({ success: false, error: "Database error." });
    }
});

router.post('/request/african', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;
    const targetCurrency = (currency || 'NGN').toUpperCase();
    const isTester = BYPASS_EMAILS.includes(email);

    if (!amount || isNaN(amount) || !checkMinimumLimit(parseFloat(amount), targetCurrency)) {
        return res.status(400).json({ error: "Minimum withdrawal requirement not met." });
    }

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        
        const userRes = await client.query(
            `SELECT u.kyc_tier, w.available_balance, w.daily_withdraw_limit, w.currency as wallet_currency
             FROM users u JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Wallet profile not found.");

        const requestedAmount = parseFloat(amount);
        const sourceCurrency = user.wallet_currency || 'USD';
        
        const platformFee = requestedAmount * PLATFORM_FEE_PERCENT;
        const netAmount = requestedAmount - (requestedAmount * TOTAL_DEDUCTION_PERCENT);
        const flwRef = `WD-AFR-${Date.now()}-${email.replace('@', '_at_')}`;

        await client.query("UPDATE wallets SET available_balance = available_balance - $1, update_at = NOW() WHERE user_email = $2 AND currency = $3", [requestedAmount, email, sourceCurrency]);
        await client.query("UPDATE wallets SET available_balance = available_balance + $1, update_at = NOW() WHERE user_email = $2 AND currency = $3", [platformFee, PLATFORM_EMAIL, sourceCurrency]);

        await triggerBankTransfer({ amount: netAmount, sourceCurrency, targetCurrency, bankCode, accountNumber, reference: flwRef, isInternational: false });

        await client.query(`INSERT INTO transactions (user_email, transaction_type, amount, fee, status, reference_id, currency, metadata, update_at) VALUES ($1, 'WITHDRAWAL', $2, $3, 'PROCESSING', $4, $5, $6, NOW())`,
            [email, requestedAmount, platformFee, flwRef, sourceCurrency, JSON.stringify({ target_currency: targetCurrency })]);

        await client.query('COMMIT');
        return res.json({ success: true, message: "African payout initialized." });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally { if (client) client.release(); }
});

router.post('/request/international', async (req, res) => {
    const { email, amount, currency, bankName, accountNumber, swiftCode, routingNumber, beneficiaryName, beneficiaryAddress, beneficiaryCountry } = req.body;
    const targetCurrency = (currency || 'USD').toUpperCase();
    
    // Validate minimum limits
    if (!amount || isNaN(amount) || !checkMinimumLimit(parseFloat(amount), targetCurrency)) {
        return res.status(400).json({ error: "Minimum withdrawal requirement not met." });
    }

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        
        const userRes = await client.query(
            `SELECT u.kyc_tier, u.full_name, w.available_balance, w.daily_withdraw_limit, w.currency as wallet_currency
             FROM users u JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Wallet profile not found.");

        const requestedAmount = parseFloat(amount);
        const sourceCurrency = user.wallet_currency || 'USD';
        const platformFee = requestedAmount * PLATFORM_FEE_PERCENT;
        const netAmount = requestedAmount - (requestedAmount * TOTAL_DEDUCTION_PERCENT);
        const flwRef = `WD-INT-${Date.now()}-${email.replace('@', '_at_')}`;

        // 1. Database Audit: Deduct and update balances
        await client.query("UPDATE wallets SET available_balance = available_balance - $1, update_at = NOW() WHERE user_email = $2 AND currency = $3", [requestedAmount, email, sourceCurrency]);
        await client.query("UPDATE wallets SET available_balance = available_balance + $1, update_at = NOW() WHERE user_email = $2 AND currency = $3", [platformFee, PLATFORM_EMAIL, sourceCurrency]);

        // 2. Operational Logging: Log the initiation before triggering transfer
        console.log(`[INTERNATIONAL_WITHDRAWAL_INIT] Reference: ${flwRef} | User: ${email} | Amount: ${netAmount} ${targetCurrency}`);

        await triggerBankTransfer({
            amount: netAmount, sourceCurrency, targetCurrency, reference: flwRef, isInternational: true,
            wirePayload: { 
                account_number: accountNumber, swift_code: swiftCode, bank_name: bankName, 
                beneficiary_name: beneficiaryName || user.full_name, 
                beneficiary_address: beneficiaryAddress, 
                beneficiary_country: beneficiaryCountry, 
                routing_number: routingNumber || '' 
            }
        });

        // 3. Database Audit: Record transaction in 'PROCESSING' state
        await client.query(`INSERT INTO transactions (user_email, transaction_type, amount, fee, status, reference_id, currency, metadata, update_at) VALUES ($1, 'WITHDRAWAL', $2, $3, 'PROCESSING', $4, $5, $6, NOW())`,
            [email, requestedAmount, platformFee, flwRef, sourceCurrency, JSON.stringify({ target_currency: targetCurrency, bank_name: bankName })]);

        await client.query('COMMIT');

        // Return the reference to the frontend
        return res.json({ 
            success: true, 
            message: "International payout initialized.", 
            reference: flwRef 
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(`[INTERNATIONAL_WITHDRAWAL_ERROR] Error: ${err.message}`);
        return res.status(400).json({ error: err.message });
    } finally { 
        if (client) client.release(); 
    }
});

router.get('/status/:ref', async (req, res) => {
    try {
        const { ref } = req.params;
        const result = await query(
            `SELECT status FROM transactions WHERE reference_id = $1`,
            [ref]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false });
        
        return res.json({ 
            success: true, 
            data: { status: result.rows[0].status } 
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: "Database error." });
    }
});

// Add this to your api/index.js or relevant controller file
app.post('/verify-account', async (req, res) => {
    const { accountNumber, bankCode } = req.body;
    
    try {
        // Example implementation using a hypothetical Flutterwave SDK or fetch call
        // Ensure you are using your actual secret keys from process.env
        const response = await fetch(`https://api.flutterwave.com/v3/accounts/resolve`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                account_number: accountNumber,
                account_bank: bankCode
            })
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            res.status(200).json({ success: true, data: data.data });
        } else {
            res.status(400).json({ success: false, message: 'Verification failed' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

export default router;