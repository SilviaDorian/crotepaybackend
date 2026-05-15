import { getClient } from './src/db/index.js';

async function setup() {
    console.log("--- STARTING DATABASE SETUP ---");
    let client;
    try {
        console.log("Attempting to connect to Database...");
        client = await getClient();
        console.log("✅ Connection Successful!");

        const sql = `
            -- 0. CREATE EXTENSIONS AND ENUMS
            CREATE EXTENSION IF NOT EXISTS "pgcrypto";

            DO $$ BEGIN
                CREATE TYPE voucher_status AS ENUM (
                    'PENDING', 'LOCKED', 'RELEASED', 'DISPUTED', 
                    'PROCESSING', 'SUCCESSFUL', 'FAILED', 'NONE'
                );
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;

            -- 1. USERS TABLE
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT,
                country_name TEXT,
                country_code TEXT,
                preferred_currency VARCHAR(10) DEFAULT 'USD',
                kyc_tier INTEGER DEFAULT 1,
                kyc_status TEXT DEFAULT 'NONE',
                phone_number TEXT,
                phone_verified BOOLEAN DEFAULT FALSE,
                tax_id TEXT,
                document_url TEXT,
                video_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- 2. VOUCHERS TABLE
            CREATE TABLE IF NOT EXISTS vouchers (
                id TEXT PRIMARY KEY,
                creator_email TEXT NOT NULL,
                recipient_email TEXT NOT NULL,
                recipient_name TEXT,
                amount DECIMAL(20, 4) NOT NULL,
                currency VARCHAR(10) NOT NULL, 
                usd_equivalent DECIMAL(20, 4),
                status voucher_status DEFAULT 'PENDING',
                release_key_hash TEXT NOT NULL,
                description TEXT,
                category TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            );

            -- 3. WALLETS TABLE (Multi-currency compliant)
            CREATE TABLE IF NOT EXISTS wallets (
                user_email TEXT NOT NULL,
                currency VARCHAR(10) NOT NULL,
                available_balance DECIMAL(20, 4) DEFAULT 0,
                escrow_balance DECIMAL(20, 4) DEFAULT 0,
                daily_withdraw_limit DECIMAL(20, 4) DEFAULT 500.00,
                max_balance_limit DECIMAL(20, 4) DEFAULT 2000.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_email, currency)
            );

            -- 4. TRANSACTIONS TABLE
            CREATE TABLE IF NOT EXISTS transactions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_email TEXT NOT NULL,
                voucher_id TEXT REFERENCES vouchers(id),
                transaction_type TEXT NOT NULL, 
                amount_usd DECIMAL(20, 4) NOT NULL,
                fee_usd DECIMAL(20, 4) DEFAULT 0,
                currency VARCHAR(10),
                status voucher_status DEFAULT 'SUCCESSFUL',
                reference_id TEXT,
                metadata JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- 5. VERIFICATION CODES
            CREATE TABLE IF NOT EXISTS verification_codes (
                email TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL
            );
        `;

        await client.query(sql);
        console.log("✅ All tables and Types initialized successfully!");

    } catch (err) {
        console.error("❌ SETUP FAILED:", err.message);
    } finally {
        if (client) client.release();
        console.log("--- SETUP FINISHED ---");
        process.exit();
    }
}

setup();