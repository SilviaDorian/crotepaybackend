import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { query } from './db/index.js';
import adminRouter from './routes/admin.js'; // Make sure the path is correct

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

// --- 1. Security & Logging Middleware ---
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// --- CORS Configuration ---
const corsOptions = {
    origin: ['https://fielpay.free.nf', 'http://fielpay.free.nf', 'http://localhost:3000', 'https://fielpdrwho.netlify.app',],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash', 'x-admin-key'],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Explicitly handle preflight

app.use(morgan('dev')); 
app.use(express.json());

// --- Routes (All prefixed removed to match frontend requests) ---
app.use('/webhooks', webhookRoutes);
app.use('/users', userRoutes);
app.use('/vouchers', voucherRoutes);
app.use('/admin', adminRoutes);
app.use('/withdraw', withdrawRoutes);
app.use('/converter', converterRoutes);
app.use('/history', historyRoutes);
app.use('/wallets', walletRoutes);
app.use('/revenue', revenueRoutes);
app.use('/settle-clearance', ledgerTriggerRoutes);
app.use('/api/admin', adminRouter); // This MUST exist

// --- Bulk Operations (All prefixed removed) ---
app.post('/bulk/create', createBulkEscrow);
app.get('/bulk/batch/:batchRef', getBulkBatch);
app.get('/bulk/details/:batchRef', getBatchDetails);
app.post('/vouchers/release', releaseSingleVoucher);
app.post('/vouchers/dispute', disputeSingleVoucher);
app.post('/bulk/release', releaseBatch);
app.post('/bulk/dispute', disputeBatch);

// --- Status ---
app.get('/', (req, res) => {
    res.json({
        status: 'Online',
        project: 'FielPay Escrow Engine',
        version: '1.5.0'
    });
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Local Development Active on Port ${PORT}`);
    });
}

export default app;
