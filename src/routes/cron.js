// import express from 'express';
// import { runSettlementLogic } from '../jobs/reconciliation.js';

// const router = express.Router();

// router.get('/reconcile', async (req, res) => {
//     // 1. SECURITY: Ensure the request is coming from your scheduled service
//     const auth = req.headers.authorization;
//     if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
//         console.warn(`[${new Date().toISOString()}] Unauthorized reconciliation attempt.`);
//         return res.status(401).json({ error: "Unauthorized" });
//     }

//     try {
//         console.log(`[${new Date().toISOString()}] Starting scheduled reconciliation...`);
        
//         // 2. Execute logic asynchronously
//         await runSettlementLogic();
        
//         console.log(`[${new Date().toISOString()}] Reconciliation complete.`);
//         return res.status(200).json({ success: true, message: "Reconciliation complete" });
        
//     } catch (error) {
//         // 3. Centralized Error Logging for better debugging
//         console.error(`[${new Date().toISOString()}] CRITICAL Reconciliation Error:`, error);
        
//         return res.status(500).json({ 
//             success: false, 
//             message: "Reconciliation failed", 
//             error: error.message 
//         });
//     }
// });

// export default router;
