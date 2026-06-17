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
import converterRoutes from './routes/converter.js';
import withdrawRoutes from './routes/withdraw.js';
import ledgerTriggerRoutes from './routes/ledgerTrigger.js';

dotenv.config();

const app = express();
const OWNER_EMAIL = 'deepxverified@gmail.com';

/* =========================================================
   VERCEL-SAFE CORS (MANUAL + BULLETPROOF)
========================================================= */

// MUST be first middleware
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "https://fielpay.free.nf");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, verif-hash");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

/* =========================================================
   SECURITY & LOGGING
========================================================= */

app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
);

app.use(morgan('dev'));
app.use(express.json());

/* =========================================================
   ROUTES
========================================================= */

app.use('/api/webhooks', webhookRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/converter', converterRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/revenue', revenueRoutes);
app.use('/api/settle-clearance', ledgerTriggerRoutes);

/* =========================================================
   BULK OPERATIONS
========================================================= */

app.post('/api/bulk/create', createBulkEscrow);
app.get('/api/bulk/batch/:batchRef', getBulkBatch);
app.get('/api/bulk/details/:batchRef', getBatchDetails);
app.post('/api/vouchers/release', releaseSingleVoucher);
app.post('/api/vouchers/dispute', disputeSingleVoucher);
app.post('/api/bulk/release', releaseBatch);
app.post('/api/bulk/dispute', disputeBatch);

/* =========================================================
   STATUS
========================================================= */

app.get('/', (req, res) => {
    res.json({
        status: 'Online',
        project: 'FielPay Escrow Engine',
        version: '1.5.0'
    });
});

/* =========================================================
   LOCAL DEV ONLY
========================================================= */

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Local Development Active on Port ${PORT}`);
    });
}

export default app;
