import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

router.post('/execute', async (req, res) => {
    const { batchRef } = req.body;
    console.log(`DEBUG: Settlement execution started for batch: ${batchRef || 'ALL'}`);

    try {
        // Execute the worker logic directly
        await processBulkEscrowFunding(batchRef);
        
        return res.status(200).json({ 
            success: true, 
            message: "Settlement process completed successfully." 
        });
    } catch (error) {
        console.error("CRITICAL: Settlement execution failed:", error);
        return res.status(500).json({ 
            success: false, 
            message: "Settlement failed: " + error.message 
        });
    }
});

export default router;
