import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

router.post('/execute', async (req, res) => {
    console.log("🚀 Ledger trigger started");

    try {
        await processBulkEscrowFunding(); // 🔥 THIS WAS MISSING

        console.log("✅ Bulk settlement completed");

        return res.status(200).json({
            success: true,
            message: "Bulk escrow funding completed"
        });

    } catch (err) {
        console.error("❌ Ledger trigger failed:", err.message);

        return res.status(500).json({
            success: false,
            message: "Settlement failed"
        });
    }
});

export default router;
