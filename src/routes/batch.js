import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

// Changed to GET to support the diagnostic testing
router.get('/process', async (req, res) => {
    // Read batchRef from query parameters instead of body
    const { batchRef } = req.query; 
    
    if (!batchRef) {
        return res.status(400).json({ success: false, error: "Missing batchRef" });
    }

    // Trigger the worker
    processBulkEscrowFunding(batchRef)
        .then(() => console.log(`✅ Batch ${batchRef} processed.`))
        .catch(console.error);

    return res.status(200).json({ success: true, message: "Initiated" });
});

export default router;