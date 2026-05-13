import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();
const OWNER_EMAIL = 'deepxverified@gmail.com';

/**
 * POST /api/admin/resolve-dispute
 * Manually move funds based on admin investigation.
 */
router.post('/resolve-dispute', async (req, res) => {
    // SECURITY: Admin Key Check
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: "Unauthorized: Invalid Admin Key" });
    }

    const { voucherId, resolution, adminNote } = req.body; 
    // resolution: 'PAY_CREATOR' (Seller wins) or 'REFUND_RECIPIENT' (Buyer wins)

    const client = await getClient();

    try {
        await client.query('BEGIN');
        
        // 1. Lock the voucher for processing
        const result = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucherId]);
        const v = result.rows[0];

        if (!v || v.status !== 'DISPUTED') {
            throw new Error("Voucher is not in a DISPUTED state.");
        }

        const amount = parseFloat(v.amount);
        const fee = parseFloat((amount * 0.07).toFixed(4));
        const netAmount = amount - fee;

        if (resolution === 'PAY_CREATOR') {
            /**
             * CASE 1: Seller Wins
             * Money moves from Recipient's Escrow to Creator's Available.
             */
            
            // Deduct from Recipient (Buyer) Escrow
            await client.query(
                "UPDATE wallets SET escrow_balance = escrow_balance - $1, updated_at = NOW() WHERE user_email = $2",
                [amount, v.recipient_email]
            );

            // Add Net to Creator (Seller) Available
            await client.query(
                "UPDATE wallets SET available_balance = available_balance + $1, updated_at = NOW() WHERE user_email = $2",
                [netAmount, v.creator_email]
            );

            // Add Fee to Admin
            await client.query(
                "UPDATE wallets SET available_balance = available_balance + $1, updated_at = NOW() WHERE user_email = $2",
                [fee, OWNER_EMAIL]
            );

            await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW(), admin_notes = $1 WHERE id = $2", [adminNote, voucherId]);

        } else if (resolution === 'REFUND_RECIPIENT') {
            /**
             * CASE 2: Buyer Wins
             * Money moves from Recipient's Escrow back to Recipient's Available.
             * (Note: You may choose to still take a small fee or refund 100%)
             */
            
            await client.query(`
                UPDATE wallets SET 
                    escrow_balance = escrow_balance - $1,
                    available_balance = available_balance + $1,
                    updated_at = NOW()
                WHERE user_email = $2`,
                [amount, v.recipient_email]
            );

            await client.query("UPDATE vouchers SET status = 'REFUNDED', updated_at = NOW(), admin_notes = $1 WHERE id = $2", [adminNote, voucherId]);

        } else {
            throw new Error("Invalid resolution. Use 'PAY_CREATOR' or 'REFUND_RECIPIENT'.");
        }

        // 2. Log the Admin Action in Transactions
        await client.query(`
            INSERT INTO transactions (user_email, voucher_id, transaction_type, amount_usd, status, reference_id) 
            VALUES ($1, $2, $3, $4, $5, $6)`,
            [v.recipient_email, v.id, 'ADMIN_RESOLUTION', amount, 'SUCCESSFUL', `ADM-${v.id}`]
        );

        await client.query('COMMIT');
        res.json({ 
            success: true, 
            message: `Dispute resolved via ${resolution}. Ledger updated.` 
        });

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Admin Resolve Error:", e.message);
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});

export default router;