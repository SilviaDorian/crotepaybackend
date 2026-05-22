import express from 'express';
import axios from 'axios';
import { getClient, query } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js'; 

const router = express.Router();

const BYPASS_EMAILS = ['deepxverified@gmail.com', 'mitounamadike@gmail.com', 'tester@fielpay.com'];
const SERVICE_FEE_PERCENT = 0.07; 

// Statically mapped rates for floor check calculations (Fallback validation baseline)
const VALIDATION_RATES = {
    'NGN': 1550.00, 'GHS': 14.50, 'KES': 130.00, 'UGX': 3750.00, 'TZS': 2600.00,
    'ZAR': 18.50, 'GBP': 0.79, 'EUR': 0.92, 'USD': 1.00, 'CAD': 1.37,
    'XOF': 600.00, 'RWF': 1300.00, 'ZMW': 27.00, 'MWK': 1730.00, 'XAF': 600.00
};

/**
 * UTILITY: Calculates the $50 equivalent or static rule floor balance limits
 */
const checkMinimumLimit = (amount, currency) => {
    const targetCurrency = currency.toUpperCase();
    if (targetCurrency === 'NGN') {
        return amount >= 5000;
    }
    const rate = VALIDATION_RATES[targetCurrency] || 1.0;
    const minLimitInCurrency = 50 * rate;
    return amount >= minLimitInCurrency;
};

/**
 * 1. GET WALLET & PROFILE
 */
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
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Wallet profile not found." });
        }
        return res.json(result.rows[0]);
    } catch (err) {
        console.error("Wallet Sync API Fetch Error:", err.message);
        return res.status(500).json({ success: false, error: "Internal database query exception." });
    }
});

/**
 * 2. GET BANKS BY COUNTRY
 */
router.get('/banks/:country', async (req, res) => {
    try {
        const countryCode = req.params.country ? req.params.country.toUpperCase() : 'NG';
        let flwUrl = `https://api.flutterwave.com/v3/banks/${countryCode}`;
        
        if (['US', 'GB', 'EU', 'CA'].includes(countryCode)) {
            flwUrl += '?type=international';
        }

        const response = await axios.get(flwUrl, {
            headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` },
            timeout: 9000
        });
        return res.json(response.data?.data || []);
    } catch (error) {
        console.error(`Flutterwave Bank Registry Exception for ${req.params.country}:`, error.message);
        return res.json([]); 
    }
});

/**
 * 3. VERIFY AFRICAN LOCAL BANK ACCOUNT
 */
router.post('/verify-account', async (req, res) => {
    const { accountNumber, bankCode } = req.body;
    try {
        const response = await axios.post(
            'https://api.flutterwave.com/v3/accounts/resolve',
            { account_number: accountNumber, account_bank: bankCode },
            { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }, timeout: 9000 }
        );
        return res.json({ success: true, data: response.data.data });
    } catch (error) {
        return res.status(400).json({ success: false, error: "Account verification failed." });
    }
});

/**
 * 4. ROUTE: PROCESS AFRICAN LOCAL PAYOUTS
 */
router.post('/request/african', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;
    const targetCurrency = (currency || 'NGN').toUpperCase();
    const isTester = BYPASS_EMAILS.includes(email);

    if (!amount || isNaN(amount) || !checkMinimumLimit(parseFloat(amount), targetCurrency)) {
        return res.status(400).json({ 
            error: targetCurrency === 'NGN' ? "Minimum withdrawal is 5000 NGN." : `Minimum withdrawal equivalent value is $50 USD.` 
        });
    }

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const userRes = await client.query(
            `SELECT u.kyc_tier, w.available_balance, w.daily_withdraw_limit, w.currency as wallet_currency
             FROM users u JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, [email]
        );
        
        const user = userRes.rows[0];
        if (!user) {
            return res.status(404).json({ error: "Account or Wallet profile not found." });
        }

        const requestedAmount = parseFloat(amount);
        const sourceCurrency = user.wallet_currency || 'USD';

        if (!isTester) {
            if (user.kyc_tier < 2) throw new Error("KYC Tier 2 required for payouts.");
            if (requestedAmount > parseFloat(user.daily_withdraw_limit)) throw new Error("Daily settlement operating limits exceeded.");
            if (parseFloat(user.available_balance) < requestedAmount) throw new Error("Insufficient transactional balance.");
        }

        const serviceFee = requestedAmount * SERVICE_FEE_PERCENT;
        const netAmount = requestedAmount - serviceFee;
        const flwRef = `WD-AFR-${Date.now()}-${email.replace('@', '_at_')}`;

        // Deduct Funds Internally (Using standardized update_at query string fallback parameters safely)
        const walletQuery = "UPDATE wallets SET available_balance = available_balance - $1, update_at = NOW() WHERE user_email = $2 AND currency = $3";
        await client.query(walletQuery, [requestedAmount, email, sourceCurrency]);

        // Call Flutterwave Utility
        await triggerBankTransfer({
            amount: netAmount,
            sourceCurrency, 
            targetCurrency, 
            bankCode,
            accountNumber,
            reference: flwRef,
            isInternational: false
        });

        // Record Ledger Entry
        const txnQuery = `INSERT INTO transactions (user_email, transaction_type, amount, fee, status, reference_id, currency, metadata, update_at) 
                          VALUES ($1, 'WITHDRAWAL', $2, $3, 'PROCESSING'::text::voucher_status, $4, $5, $6, NOW())`;
        const metaPayload = JSON.stringify({ target_currency: targetCurrency, bank_code: bankCode, account: accountNumber });
        
        await client.query(txnQuery, [email, requestedAmount, serviceFee, flwRef, sourceCurrency, metaPayload]);

        await client.query('COMMIT');
        return res.json({ success: true, message: "African payout initialized.", details: { sent: `${netAmount} ${targetCurrency}` } });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * 5. ROUTE: PROCESS INTERNATIONAL WIRE/SWIFT PAYOUTS
 */
router.post('/request/international', async (req, res) => {
    const { 
        email, amount, currency, 
        bankName, accountNumber, swiftCode, routingNumber, 
        beneficiaryName, beneficiaryAddress, beneficiaryCountry 
    } = req.body;
    
    const targetCurrency = (currency || 'USD').toUpperCase();
    const isTester = BYPASS_EMAILS.includes(email);

    if (!amount || isNaN(amount) || !checkMinimumLimit(parseFloat(amount), targetCurrency)) {
        return res.status(400).json({ error: `Minimum international withdrawal amount matching floor guidelines is $50 equivalent.` });
    }

    if (!bankName || !accountNumber || !swiftCode || !beneficiaryAddress || !beneficiaryCountry) {
        return res.status(400).json({ error: "Missing required international clearing telemetry (SWIFT, Bank Name, Address)." });
    }

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        // Added u.full_name selection explicitly to fix fallback resolution crash
        const userRes = await client.query(
            `SELECT u.kyc_tier, u.full_name, w.available_balance, w.daily_withdraw_limit, w.currency as wallet_currency
             FROM users u JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, [email]
        );
        
        const user = userRes.rows[0];
        if (!user) {
            return res.status(404).json({ error: "Account or Ledger mapping profile not found." });
        }

        const requestedAmount = parseFloat(amount);
        const sourceCurrency = user.wallet_currency || 'USD';

        if (!isTester) {
            if (user.kyc_tier < 2) throw new Error("KYC Tier 2 required for international wire clearances.");
            if (requestedAmount > parseFloat(user.daily_withdraw_limit)) throw new Error("Daily operational settlement limit reached.");
            if (parseFloat(user.available_balance) < requestedAmount) throw new Error("Insufficient clear funds available in balance.");
        }

        const serviceFee = requestedAmount * SERVICE_FEE_PERCENT;
        const netAmount = requestedAmount - serviceFee;
        const flwRef = `WD-INT-${Date.now()}-${email.replace('@', '_at_')}`;

        // Deduct Internal Funds safely
        const walletQuery = "UPDATE wallets SET available_balance = available_balance - $1, update_at = NOW() WHERE user_email = $2 AND currency = $3";
        await client.query(walletQuery, [requestedAmount, email, sourceCurrency]);

        // Call Flutterwave Passing Explicit Wire Payload Fields
        await triggerBankTransfer({
            amount: netAmount,
            sourceCurrency,
            targetCurrency,
            reference: flwRef,
            isInternational: true,
            wirePayload: {
                account_number: accountNumber,
                routing_number: routingNumber || '',
                swift_code: swiftCode,
                bank_name: bankName,
                beneficiary_name: beneficiaryName || user.full_name || 'FielPay User',
                beneficiary_address: beneficiaryAddress,
                beneficiary_country: beneficiaryCountry
            }
        });

        // Log Comprehensive Transaction Meta Context to database ledger
        const txnQuery = `INSERT INTO transactions (user_email, transaction_type, amount, fee, status, reference_id, currency, metadata, update_at) 
                          VALUES ($1, 'WITHDRAWAL', $2, $3, 'PROCESSING'::text::voucher_status, $4, $5, $6, NOW())`;
        const metaPayload = JSON.stringify({
            target_currency: targetCurrency,
            clearing_mechanism: 'SWIFT_WIRE',
            bank_name: bankName,
            swift_code: swiftCode,
            account_hashed: accountNumber.slice(-4).padStart(accountNumber.length, '*')
        });

        await client.query(txnQuery, [email, requestedAmount, serviceFee, flwRef, sourceCurrency, metaPayload]);

        await client.query('COMMIT');
        return res.json({ success: true, message: "International wire layout processing initialized.", reference: flwRef });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * 6. ROUTE: GET WITHDRAWAL STATUS FOR LONG-POLLING UI
 */
router.get('/status/:referenceId', async (req, res) => {
    try {
        const { referenceId } = req.params;

        const result = await query(
            `SELECT status, error_reason FROM public.transactions WHERE reference_id = $1`,
            [referenceId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: "Transaction reference target not found inside historical logs." 
            });
        }

        const txRow = result.rows[0];
        
        let calculatedState = 'PROCESSING';
        if (txRow.status === 'SUCCESSFUL' || txRow.status === 'LOCKED') {
            calculatedState = 'SUCCESSFUL';
        } else if (txRow.status === 'FAILED' || txRow.status === 'CANCELLED') {
            calculatedState = 'FAILED';
        }

        return res.json({
            success: true,
            data: {
                reference_id: referenceId,
                status: calculatedState,
                failure_reason: txRow.error_reason || 'Network payload rejected by clearance handler.'
            }
        });

    } catch (err) {
        console.error("Ledger Status Check Failure:", err.message);
        return res.status(500).json({ 
            success: false, 
            error: "Internal transactional status lookup exception." 
        });
    }
});

export default router;