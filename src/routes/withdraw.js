import express from 'express';
import { query, getClient } from '../db/index.js';
import { triggerBankTransfer } from '../utils/payout.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com';

router.post('/request', async (req, res) => {
    const { email, amount, bankCode, accountNumber, currency } = req.body;
    
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number." });
    }

    const client = await getClient();

    try {
        await client.query('BEGIN');

        // Fetch User and Wallet with Row Locking
        const userRes = await client.query(
            `SELECT u.email, u.kyc_tier, w.available_balance, w.daily_withdraw_limit 
             FROM users u 
             JOIN wallets w ON u.email = w.user_email 
             WHERE u.email = $1 FOR UPDATE`, 
            [email]
        );
        
        const user = userRes.rows[0];
        if (!user) throw new Error("Account not found.");

        // KYC Tier 2 Verification (Owner is exempt as they are Tier 3)
        if (user.kyc_tier < 2 && user.email !== OWNER_EMAIL) {
            return res.status(403).json({ error: "Tier 2 KYC required for withdrawals." });
        }

        // Daily Limit Check (Exempts Owner)
        if (user.email !== OWNER_EMAIL && parseFloat(amount) > parseFloat(user.daily_withdraw_limit)) {
            throw new Error(`Daily limit exceeded ($${user.daily_withdraw_limit}).`);
        }

        // Balance Check
        if (parseFloat(user.available_balance) < parseFloat(amount)) {
            throw new Error("Insufficient available balance.");
        }

        // 1. Deduct USD from available wallet balance
        await client.query(
            "UPDATE wallets SET available_balance = available_balance - $1, updated_at = NOW() WHERE user_email = $2",
            [amount, email]
        );

        const reference = `WD-${Date.now()}-${email.split('@')[0]}`;

        // 2. Log Initial Transaction as PENDING
        await client.query(`
            INSERT INTO transactions (
                user_email, 
                transaction_type, 
                amount_usd, 
                local_currency, 
                status, 
                reference_id
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [email, 'WITHDRAWAL', amount, currency || 'NGN', 'PENDING', reference]
        );

        // 3. Trigger conversion and transfer via utility
        const flwResponse = await triggerBankTransfer({
            amount: parseFloat(amount),
            currency: currency || 'NGN', 
            bankCode,
            accountNumber,
            reference
        });

        // 4. Update Transaction with conversion details
        await client.query(`
            UPDATE transactions SET 
                local_amount = $1,
                exchange_rate = $2,
                metadata = $3,
                updated_at = NOW()
            WHERE reference_id = $4`,
            [
                flwResponse.local_amount, 
                flwResponse.applied_rate, 
                JSON.stringify(flwResponse), 
                reference
            ]
        );

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            message: "Withdrawal initiated successfully.", 
            details: {
                usd_deducted: amount,
                local_sent: flwResponse.local_amount,
                rate_applied: flwResponse.applied_rate,
                currency: currency || 'NGN',
                reference: reference
            }
        });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Withdrawal Error:", err.message);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// THIS LINE MUST BE THE LAST LINE OF THE FILE
export default router;