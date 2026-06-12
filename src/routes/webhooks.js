import express from 'express';
import { getClient } from '../db/index.js';
import { processBulkEscrowFunding } from '../services/autoSettler.js'; // Import the new service

const router = express.Router();

router.post('/flutterwave', async (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];

    if (!secretHash || signature !== secretHash) return res.status(200).send('Unauthorized');
    
    const payload = req.body;
    if (!payload?.data) return res.status(200).send('No payload');

    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        if (payload.event !== 'charge.completed' || payload.data.status?.toUpperCase() !== 'SUCCESSFUL') {
            await client.query('COMMIT');
            return res.status(200).send('Ignored');
        }

        const txRef = payload.data.tx_ref?.trim();
        const flutterwaveTxId = String(payload.data.id);
        let batchRef = payload.data.meta?.parent_batch_ref || (txRef.startsWith("BATCH-") ? txRef : null);

        if (batchRef) {
            // 1. Mark everything as LOCKED immediately
            await client.query(
                `UPDATE vouchers SET status = 'LOCKED', locked_at = NOW(), updated_at = NOW() 
                 WHERE parent_batch_ref = $1 AND status = 'PENDING'`,
                [batchRef]
            );

            // 2. Commit the lock so we don't process it again
            await client.query('COMMIT');

            // 3. Trigger the Auto-Settler (Background)
            // We do NOT await this, allowing the webhook to return 200 immediately
            processBulkEscrowFunding(batchRef).catch(err => 
                console.error(`❌ Background settlement failed for ${batchRef}:`, err)
            );

            return res.status(200).send('Batch locked and funding queued');
        }

        // Single flow remains as is...
        await client.query('COMMIT');
        return res.status(200).send('Processed');

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ WEBHOOK ERROR:', err);
        return res.status(500).send('Internal Error');
    } finally {
        if (client) client.release();
    }
});

export default router;