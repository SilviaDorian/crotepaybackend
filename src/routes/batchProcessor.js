import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

// Only this specific POST path will be handled here
router.post('/process', async (req, res) => {
    const { batchRef } = req.body;
    if (!batchRef) return res.status(400).json({ success: false, error: "Missing batchRef" });

    try {
        await processBulkEscrowFunding(batchRef);
        return res.json({ success: true, message: "Batch processed successfully" });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

export default router;