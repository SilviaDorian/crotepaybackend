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

// Import Routes
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
import batchProcessorRoutes from './routes/batchProcessor.js';

dotenv.config();

const app = express();
const OWNER_EMAIL = 'deepxverified@gmail.com';

// --- Security & Logging ---
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
);

app.use(
    cors({
        origin: [
            'https://fielpay.free.nf',
            'http://fielpay.free.nf',
            'http://localhost:3000'
        ],
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash'],
        credentials: true
    })
);

app.use(morgan('dev'));
app.use(express.json());

// --- Routes ---
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
app.use('/api/batch', batchProcessorRoutes);

// --- Bulk Operations ---
app.post('/api/bulk/create', createBulkEscrow);
app.get('/api/bulk/batch/:batchRef', getBulkBatch);
app.get('/api/bulk/details/:batchRef', getBatchDetails);
app.post('/api/vouchers/release', releaseSingleVoucher);
app.post('/api/vouchers/dispute', disputeSingleVoucher);
app.post('/api/bulk/release', releaseBatch);
app.post('/api/bulk/dispute', disputeBatch);

// --- Status ---
app.get('/', (req, res) => {
    res.json({
        status: 'Online',
        project: 'FielPay Escrow Engine',
        version: '1.5.0'
    });
});

// --- Cron cleanup ---
app.get('/api/cron/cleanup', async (req, res) => {
    try {
        await query(`
            UPDATE vouchers
            SET status = 'DISPUTED'
            WHERE status = 'LOCKED'
            AND expires_at <= NOW()
        `);

        res.status(200).send('Cleanup successful');
    } catch (err) {
        res.status(500).send('Cron execution failed');
    }
});

// --- Worker loop ---
setInterval(async () => {
    try {
        await processBulkEscrowFunding();
    } catch (err) {
        console.error('❌ BULK SETTLEMENT WORKER FAILURE:', err.message);
    }
}, 3000);

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Local Development Active on Port ${PORT}`);
    });
}

export default app;