import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

router.post('/trigger-bulk-funding', async (req, res) => {
    const { batchRef } = req.body;

    if (!batchRef || typeof batchRef !== 'string') {
        console.warn('⚠️ [TRIGGER] Missing or invalid batchRef');
        return res.status(400).json({ 
            success: false, 
            error: "batchRef is required and must be a string" 
        });
    }

    console.log(`🔄 [TRIGGER ENDPOINT] Received request for batch: ${batchRef}`);

    try {
        await processBulkEscrowFunding(batchRef);
        
        console.log(`✅ [TRIGGER ENDPOINT] Successfully processed batch: ${batchRef}`);
        return res.json({ 
            success: true, 
            message: `Batch ${batchRef} funded successfully`,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error(`❌ [TRIGGER ENDPOINT] Failed for ${batchRef}:`, err.message);
        return res.status(500).json({ 
            success: false, 
            error: err.message || 'Internal server error'
        });
    }
});

export default router;