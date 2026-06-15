import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

// NEW ENDPOINT: /api/settle-clearance/execute
router.post('/execute', async (req, res) => {
    // We pass the identifier in the body via POST for maximum safety
    const { clearanceReference } = req.body;

    if (!clearanceReference) {
        return res.status(400).json({ 
            success: false, 
            error: "Execution blocked: Missing clearance transaction reference." 
        });
    }

    try {
        console.log(`🚀 [Ledger Trigger] Initializing payout chain for: ${clearanceReference}`);
        
        // Fire the worker loop logic asynchronously so frontend doesn't time out
        processBulkEscrowFunding(clearanceReference)
            .then(() => console.log(`✅ [Ledger Trigger] Distribution sequence completed for ${clearanceReference}`))
            .catch((err) => console.error(`❌ [Ledger Trigger] Worker Execution Error:`, err.message));

        // Immediately return success to the UI
        return res.status(200).json({ 
            success: true, 
            message: "Settlement pipeline successfully initialized." 
        });
        
    } catch (error) {
        console.error(`❌ [Ledger Trigger] Critical Pipeline Failure:`, error);
        return res.status(500).json({ 
            success: false, 
            error: "Internal pipeline initiation failure." 
        });
    }
});

export default router;