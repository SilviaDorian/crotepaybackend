// import express from 'express';
// import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

// const router = express.Router();

// router.post('/process', async (req, res) => {
//     const { batchRef } = req.body;

//     if (!batchRef) {
//         return res.status(400).json({ success: false, error: "Missing batchRef" });
//     }

//     console.log(`⚡ [AUTOMATIC TRIGGER] Fire-and-forget initialization for batch: ${batchRef}`);

//     // 🔥 THE FIX: Run the worker in the background without 'await'ing it for the response.
//     // This sends a 200 OK back to your frontend immediately while the database works.
//     processBulkEscrowFunding(batchRef)
//         .then(() => {
//             console.log(`✅ [BG WORKER SUCCESS] Finishes processing batch: ${batchRef}`);
//         })
//         .catch((err) => {
//             console.error(`❌ [BG WORKER FAILURE] Error processing batch: ${batchRef}`, err.message);
//         });

//     // Respond instantly to frontend (takes < 5ms, avoiding Vercel timeouts completely)
//     return res.status(200).json({
//         success: true,
//         message: "Bulk escrow funding background sequence successfully initiated."
//     });
// });

// export default router;