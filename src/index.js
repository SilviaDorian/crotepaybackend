import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
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
const OWNER_PASSWORD = 'Chioma1993';

// --- 1. Database Initialization & Global Sync ---
const syncDatabase = async () => {
    try {
        console.log("🛠️  Running Global Database Sync...");
        
        const tableSchema = `
            CREATE TABLE IF NOT EXISTS users (
                email VARCHAR(255) PRIMARY KEY,
                password_hash TEXT NOT NULL,
                full_name VARCHAR(255),
                phone_number VARCHAR(20),
                country_code CHAR(2), 
                country_name VARCHAR(100),
                preferred_currency VARCHAR(10) DEFAULT 'USD',
                kyc_tier INTEGER DEFAULT 1, 
                kyc_status VARCHAR(20) DEFAULT 'UNVERIFIED', 
                tax_id VARCHAR(50), 
                is_pep BOOLEAN DEFAULT FALSE, 
                document_url TEXT,
                phone_verified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS wallets (
                user_email VARCHAR(255) PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
                available_balance DECIMAL(20, 4) DEFAULT 0.0000,
                escrow_balance DECIMAL(20, 4) DEFAULT 0.0000,
                currency VARCHAR(10) DEFAULT 'USD',
                daily_withdraw_limit DECIMAL(20, 4) DEFAULT 0.0000,
                max_balance_limit DECIMAL(20, 4) DEFAULT 500.0000,
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS vouchers (
                id VARCHAR(100) PRIMARY KEY,
                creator_email VARCHAR(255),
                recipient_email VARCHAR(255),
                amount DECIMAL(20, 4) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                status VARCHAR(20) DEFAULT 'PENDING',
                description TEXT,
                dispute_reason TEXT,
                release_key_hash TEXT,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_email VARCHAR(255) REFERENCES users(email) ON DELETE CASCADE,
                voucher_id VARCHAR(100) REFERENCES vouchers(id) ON DELETE SET NULL,
                transaction_type VARCHAR(50) NOT NULL, 
                amount_usd DECIMAL(20, 4) NOT NULL,
                local_amount DECIMAL(20, 4),
                local_currency VARCHAR(10),
                exchange_rate DECIMAL(20, 6),
                fee_usd DECIMAL(20, 4) DEFAULT 0.0000,
                status VARCHAR(20) DEFAULT 'PENDING',
                reference_id VARCHAR(255) UNIQUE,
                metadata JSONB,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_email);
            CREATE INDEX IF NOT EXISTS idx_transactions_voucher ON transactions(voucher_id);
            CREATE INDEX IF NOT EXISTS idx_transactions_ref ON transactions(reference_id);
        `;
        await query(tableSchema);

        // --- SEED/SYNC OWNER ACCOUNT ---
        const userCheck = await query("SELECT email FROM users WHERE email = $1", [OWNER_EMAIL]);
        if (userCheck.rows.length === 0) {
            console.log("👤 Initializing Owner account (Tier 3 - Unlimited)...");
            const hashedPw = await bcrypt.hash(OWNER_PASSWORD, 10);
            
            await query(
                `INSERT INTO users (email, password_hash, full_name, country_name, country_code, preferred_currency, kyc_tier, kyc_status, phone_verified) 
                 VALUES ($1, $2, $3, $4, $5, $6, 3, 'VERIFIED', true)`,
                [OWNER_EMAIL, hashedPw, 'System Owner', 'Nigeria', 'NG', 'USD']
            );
        }

        // --- INITIALIZE OWNER WALLET (Revenue Account) ---
        await query(
            `INSERT INTO wallets (user_email, currency, available_balance, daily_withdraw_limit, max_balance_limit) 
             VALUES ($1, 'USD', 0.00, 999999999, 999999999) 
             ON CONFLICT (user_email) DO UPDATE SET daily_withdraw_limit = 999999999`,
            [OWNER_EMAIL]
        );

        console.log("✅ Database and Owner Revenue Wallet ready.");
    } catch (err) {
        console.error("🚨 DB SYNC ERROR:", err.message);
    }
};

syncDatabase();

// --- 2. Middleware ---
app.use(helmet()); 
app.use(cors()); 
app.use(express.json());
app.use(morgan('dev')); 

// --- 3. Routes ---
app.use('/api/webhooks', webhookRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/revenue', revenueRoutes);

// --- 4. Status Route ---
app.get('/', (req, res) => {
    res.json({ 
        status: "Online", 
        project: "Escrow Backend Engine",
        version: "1.4.2",
        owner_account: OWNER_EMAIL,
        audit_trail: "Active"
    });
});

// --- 5. Automation (Cron Job) ---
cron.schedule('0 0 * * *', async () => {
    console.log("CRON: Auto-disputing expired vouchers...");
    try {
        await query(`
            UPDATE vouchers 
            SET status = 'DISPUTED', 
                dispute_reason = 'Auto-dispute: Window expired'
            WHERE status = 'LOCKED' AND expires_at <= NOW()
        `);
    } catch (err) {
        console.error("CRON ERROR:", err.message);
    }
});

// --- 6. Server Start ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Backend Active on Port ${PORT}`);
    console.log(`💰 Revenue collected in USD, withdrawable in Local Currency`);
});