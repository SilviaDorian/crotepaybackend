import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { query } from './db/index.js';

// Import Controllers
import {
    createBulkEscrow,
    getBulkBatch,
    getBatchDetails,
    releaseSingleVoucher,
    releaseBatch,
    disputeBatch,
    disputeSingleVoucher
} from './controllers/bulkControllers.js';

import { processBulkEscrowFunding } from './controllers/bulkSettlementWorker.js';

// Import Routes (Note: Removed batchProcessorRoutes to prevent conflict)
import historyRoutes from './routes/history.js';
import revenueRoutes from './routes/revenue.js';
import webhookRoutes from './routes/webhooks.js';
import userRoutes from './routes/users.js';
import voucherRoutes from './routes/vouchers.js';
import walletRoutes from './routes/wallets.js';
import adminRoutes from './routes/admin.js';
import cronRoutes from './routes/cron.js';
import converterRoutes from './routes/converter.js';
import withdrawRoutes from './routes/withdraw.js';

dotenv.config();

const app = express();

// --- Security & Logging ---
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
    origin: ['https://fielpay.free.nf', 'http://fielpay.free.nf', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash'],
    credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());

// --- ROUTES: Priority Direct Route ---
// Placed at the top to ensure it is registered before any middleware routers
app.post('/api/batch/process', async (req, res) => {
    console.log("⚡ [DIRECT CORE ROUTE] Received automatic request for batch:", req.body.batchRef);
    const { batchRef } = req.body;
    
    if (!batchRef || typeof batchRef !== 'string') {
        return res.status(400).json({ success: false, error: "Invalid batch reference." });
    }

    // Fire-and-forget: Start process, respond to frontend immediately
    processBulkEscrowFunding(batchRef)
        .then(() => console.log(`✅ [BG WORKER] Batch ${batchRef} processed.`))
        .catch((err) => console.error(`❌ [BG WORKER] Batch ${batchRef} failed:`, err.message));

    return res.status(200).json({ success: true, message: "Sequence initiated." });
});

// --- Standard Routes ---
app.use('/api/webhooks', webhookRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/converter', converterRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/revenue', revenueRoutes);
app.use('/api/cron', cronRoutes);

// --- Bulk Operations ---
app.post('/api/bulk/create', createBulkEscrow);
app.get('/api/bulk/batch/:batchRef', getBulkBatch);
app.get('/api/bulk/details/:batchRef', getBatchDetails);
app.post('/api/vouchers/release', releaseSingleVoucher);
app.post('/api/vouchers/dispute', disputeSingleVoucher);
app.post('/api/bulk/release', releaseBatch);
app.post('/api/bulk/dispute', disputeBatch);

// --- Default Healthcheck ---
app.get('/', (req, res) => res.json({ status: 'Online', project: 'FielPay', version: '1.5.0' }));

// --- Worker Loop & Server Start ---
setInterval(async () => {
    try { await processBulkEscrowFunding(); } catch (err) { console.error('❌ Worker loop error:', err.message); }
}, 3000);

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Development Active on Port ${PORT}`));
}

export default app;