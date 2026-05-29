import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { query } from './db/index.js';
import { createBulkEscrow } from './controllers/BulkController.js'; // Add this line


// Import Routes
import historyRoutes from './routes/history.js';
import revenueRoutes from './routes/revenue.js';
import webhookRoutes from './routes/webhooks.js';
import userRoutes from './routes/users.js';
import voucherRoutes from './routes/vouchers.js';
import walletRoutes from './routes/wallets.js';
import adminRoutes from './routes/admin.js';
import cronRoutes from './routes/cron.js'; // The new trigger route
import converterRoutes from './routes/converter.js';
import withdrawRoutes from './routes/withdraw.js';

dotenv.config();

const app = express();
const OWNER_EMAIL = 'deepxverified@gmail.com';

// --- 1. Security & Logging Middleware ---
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
})); 

app.use(cors({
    origin: [
        'https://fielpay.free.nf', 
        'http://fielpay.free.nf',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'verif-hash'],
    credentials: true
}));

app.use(morgan('dev')); 

// --- 2. Routes ---
app.use(express.json());

app.use('/api/webhooks', webhookRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/converter', converterRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/revenue', revenueRoutes);
app.use('/api/cron', cronRoutes); // Mounts the reconciliation trigger
app.use('/api/bulk', express.json(), (req, res) => {
    // This allows you to call createBulkEscrow directly
    createBulkEscrow(req, res);
});

// --- 3. Status Route ---
app.get('/', (req, res) => {
    res.json({ 
        status: "Online", 
        project: "FielPay Escrow Engine",
        environment: process.env.NODE_ENV || "development",
        version: "1.5.0",
        owner_account: OWNER_EMAIL
    });
});

// --- 4. Inline Cron Logic (Sync with ENUMs) ---
app.get('/api/cron/cleanup', async (req, res) => {
    console.log("CRON: Auto-disputing expired vouchers...");
    try {
        await query(`
            UPDATE vouchers 
            SET status = 'DISPUTED'::voucher_status, 
                description = CONCAT(description, ' | Auto-dispute: Window expired')
            WHERE status = 'LOCKED'::voucher_status AND expires_at <= NOW()
        `);
        res.status(200).send("Cleanup successful");
    } catch (err) {
        console.error("CRON ERROR:", err.message);
        res.status(500).send("Cron execution failed");
    }
});

// --- 5. Server Start ---
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Local Development Active on Port ${PORT}`);
    });
}

export default app;