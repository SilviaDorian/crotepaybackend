import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com';

/**
 * POST /api/admin/resolve-dispute
 * Manually move funds based on admin investigation.
 */
router.post('/resolve-dispute', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: "Unauthorized: Invalid Admin Key" });
    }

    const { voucher_id, resolution, adminNote } = req.body; 

    const client = await getClient();

    try {
        await client.query('BEGIN');
        // Ensure search path is correct for Enum types
        await client.query('SET search_path TO public');
        
        const result = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucher_id]);
        const v = result.rows[0];

        if (!v) throw new Error("Voucher not found.");
        if (v.status !== 'DISPUTED') throw new Error("Voucher is not in a DISPUTED state.");

        const amount = parseFloat(v.amount);
        const fee = parseFloat((amount * 0.07).toFixed(4));
        const netAmount = amount - fee;

        if (resolution === 'PAY_CREATOR') {
            // Deduct from Recipient Escrow
            await client.query(
                "UPDATE wallets SET escrow_balance = escrow_balance - $1, updated_at = NOW() WHERE user_email = $2 AND currency = $3",
                [amount, v.recipient_email, v.currency]
            );

            // Add Net to Creator (Using the verified UNIQUE constraint logic)
            await client.query(`
                INSERT INTO wallets (user_email, available_balance, currency) 
                VALUES ($1, $2, $3)
                ON CONFLICT (user_email, currency) DO UPDATE SET 
                available_balance = wallets.available_balance + $2, updated_at = NOW()`,
                [v.creator_email, netAmount, v.currency]
            );

            // Add Fee to Admin
            await client.query(`
                UPDATE wallets SET 
                    available_balance = available_balance + $1, 
                    updated_at = NOW() 
                WHERE user_email = $2 AND currency = $3`,
                [fee, OWNER_EMAIL, v.currency]
            );

            await client.query(`
                UPDATE vouchers 
                SET status = 'RELEASED'::text::voucher_status, 
                    updated_at = NOW(), 
                    description = CONCAT(description, ' | Admin Note: ', $1::text) 
                WHERE id = $2`, 
                [adminNote || "Resolved in favor of creator", voucher_id]
            );

        } else if (resolution === 'REFUND_RECIPIENT') {
            // Buyer Wins - Refund to Available Balance
            await client.query(`
                UPDATE wallets SET 
                    escrow_balance = escrow_balance - $1,
                    available_balance = available_balance + $1,
                    updated_at = NOW()
                WHERE user_email = $2 AND currency = $3`,
                [amount, v.recipient_email, v.currency]
            );

            await client.query(`
                UPDATE vouchers 
                SET status = 'REFUNDED'::text::voucher_status, 
                    updated_at = NOW(), 
                    description = CONCAT(description, ' | Admin Note: ', $1::text) 
                WHERE id = $2`, 
                [adminNote || "Resolved in favor of recipient", voucher_id]
            );

        } else {
            throw new Error("Invalid resolution.");
        }

        // FIXED: amount_usd -> amount | fee_usd -> fee | Added ::text::voucher_status
        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, fee, status, reference_id, currency) 
            VALUES ($1, $2, 'ADMIN_RESOLUTION', $3, $4, 'SUCCESSFUL'::text::voucher_status, $5, $6)`,
            [v.recipient_email, v.id, amount, (resolution === 'PAY_CREATOR' ? fee : 0), `ADM-${v.id}`, v.currency]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `Dispute resolved.` });

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Admin Resolve Error:", e.message);
        res.status(400).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

export default router;