import express from 'express';
import { processBulkEscrowFunding } from '../controllers/bulkSettlementWorker.js';

const router = express.Router();

console.log('🚀 [BOOT] triggerBulkFunding.js file loaded');

// Middleware-level logger
router.use((req, res, next) => {
    console.log('📥 [ROUTER HIT]', {
        method: req.method,
        url: req.originalUrl,
        path: req.path,
        body: req.body
    });
    next();
});

console.log('🧩 [INIT] Registering POST /bulk/trigger-funding route');

// ✅ UPDATED ROUTE (matches your system pattern)
router.post('/bulk/trigger-funding', async (req, res) => {
    console.log('⚡ [ROUTE HIT] POST /bulk/trigger-funding reached');

    const { batchRef } = req.body;

    console.log('📦 [REQUEST BODY]', req.body);

    if (!batchRef || typeof batchRef !== 'string') {
        console.warn('⚠️ [VALIDATION FAILED] Missing or invalid batchRef');

        return res.status(400).json({
            success: false,
            error: "batchRef is required and must be a string"
        });
    }

    console.log(`🔄 [PROCESS START] batchRef = ${batchRef}`);

    try {
        await processBulkEscrowFunding(batchRef);

        console.log(`✅ [PROCESS SUCCESS] batchRef = ${batchRef}`);

        return res.json({
            success: true,
            message: `Batch ${batchRef} funded successfully`,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error(`❌ [PROCESS ERROR] batchRef = ${batchRef}`, err);

        return res.status(500).json({
            success: false,
            error: err.message || 'Internal server error'
        });
    }
});

// Catch-all debug
router.use((req, res) => {
    console.warn('🚨 [ROUTE NOT FOUND INSIDE MODULE]', {
        method: req.method,
        url: req.originalUrl
    });

    res.status(404).json({
        success: false,
        error: 'Route not found inside triggerBulkFunding router'
    });
});

export default router;