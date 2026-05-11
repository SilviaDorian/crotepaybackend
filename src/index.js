import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { query } from './db/index.js';

// Import Routes
import historyRoutes from './routes/history.js';
import revenueRoutes from './routes/revenue.js';
import webhookRoutes from './routes/webhooks.js';
import userRoutes from './routes/users.js';
import voucherRoutes from './routes/vouchers.js';
import adminRoutes from './routes/admin.js';
import withdrawRoutes from './routes/withdraw.js';

dotenv.config();

const app = express();

const OWNER_EMAIL = 'deepxverified@gmail.com';

// --- 1. Middleware ---
app.use(helmet()); 
app.use(cors()); 
app.use(express.json());
app.use(morgan('dev')); 

// --- 2. Routes ---
app.use('/api/webhooks', webhookRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/revenue', revenueRoutes);

// --- 3. Status Route ---
app.get('/', (req, res) => {
    res.json({ 
        status: "Online", 
        project: "CrotePay Escrow Engine",
        environment: process.env.NODE_ENV || "development",
        version: "1.4.3",
        owner_account: OWNER_EMAIL
    });
});

// --- 4. Cron Logic (Refactored for Serverless) ---
// Note: node-cron doesn't work on Vercel. 
// You can call this endpoint via a Vercel Cron Job.
app.get('/api/cron/cleanup', async (req, res) => {
    console.log("CRON: Auto-disputing expired vouchers...");
    try {
        await query(`
            UPDATE vouchers 
            SET status = 'DISPUTED', 
                dispute_reason = 'Auto-dispute: Window expired'
            WHERE status = 'LOCKED' AND expires_at <= NOW()
        `);
        res.status(200).send("Cleanup successful");
    } catch (err) {
        console.error("CRON ERROR:", err.message);
        res.status(500).send("Cron execution failed");
    }
});

// --- 5. Server Start (Conditional) ---
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Local Development Active on Port ${PORT}`);
    });
}

// --- 6. Vercel Export ---
export default app;