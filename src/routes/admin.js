import express from 'express';
import { getClient } from '../db/index.js';

const router = express.Router();

router.post('/resolve-dispute', async (req, res) => {
    const { voucherId, resolution, adminNote } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');
        const result = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucherId]);
        const v = result.rows[0];

        if (!v || v.status !== 'DISPUTED') throw new Error("Voucher not in dispute");

        const fee = v.amount * 0.07;
        
        await client.query(`
            UPDATE vouchers SET 
            status = 'RELEASED', resolved_at = NOW(), resolution_notes = $1, final_destination = $2 
            WHERE id = $3`, [adminNote, resolution, voucherId]);

        await client.query("INSERT INTO ledger (voucher_id, amount, currency, entry_type) VALUES ($1, $2, $3, 'ADMIN_FEE')", [voucherId, fee, v.currency]);

        await client.query('COMMIT');
        res.json({ success: true, message: `Dispute resolved for ${resolution}` });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
});

export default router;