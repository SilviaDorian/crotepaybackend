import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { query } from './db/index.js';

// Import Controllers
import { createBulkEscrow, getBulkBatch, finalizeBatch } from './controllers/bulkControllers.js';

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

dotenv.config();

const app = express();
const OWNER_EMAIL = 'deepxverified@gmail.com';

// --- 1. Security & Logging Middleware ---
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
    origin: ['https://fielpay.free.nf', 'http://fielpay.free.nf', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash'],
    credentials: true
}));
app.use(morgan('dev')); 
app.use(express.json());

// --- 2. Routes ---
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

// --- 3. Fixed Bulk Routes ---
// These specific definitions prevent the 400 Bad Request error
app.post('/api/bulk/create', createBulkEscrow);
app.get('/api/bulk/batch/:batchRef', getBulkBatch);
app.post('/api/bulk/finalize', finalizeBatch);
// Add this to your routes in index.js
app.get('/api/bulk/details/:batchRef', getBulkBatchDetails); // Ensure getBatchDetails is imported

// --- 4. Status Route ---
app.get('/', (req, res) => {
    res.json({ 
        status: "Online", 
        project: "FielPay Escrow Engine",
        version: "1.5.0"
    });
});

// --- 5. Inline Cron Logic ---
app.get('/api/cron/cleanup', async (req, res) => {
    try {
        await query(`UPDATE vouchers SET status = 'DISPUTED'::voucher_status WHERE status = 'LOCKED'::voucher_status AND expires_at <= NOW()`);
        res.status(200).send("Cleanup successful");
    } catch (err) {
        res.status(500).send("Cron execution failed");
    }
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Local Development Active on Port ${PORT}`));
}

export default app;