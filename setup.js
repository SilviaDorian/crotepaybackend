import { getClient } from './src/db/index.js';

async function setup() {
    console.log("--- STARTING DATABASE SETUP ---");
    let client;
    try {
        console.log("Attempting to connect to Render...");
        client = await getClient();
        console.log("✅ Connection Successful!");

        const sql = `
            -- 1. VOUCHERS TABLE: Tracks the payment request
            CREATE TABLE IF NOT EXISTS vouchers (
                id TEXT PRIMARY KEY, -- Using custom IDs like VC-123456
                creator_email TEXT NOT NULL, -- The Seller/Service Provider
                recipient_email TEXT NOT NULL, -- The Client/Payer
                recipient_name TEXT,
                amount DECIMAL(20, 4) NOT NULL,
                currency VARCHAR(10) NOT NULL, 
                status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, LOCKED, RELEASED, DISPUTED
                release_key_hash TEXT NOT NULL,
                description TEXT,
                category TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            );

            -- 2. WALLETS TABLE: The Digital Ledger
            -- This tracks 'value' owned by users in your system
            CREATE TABLE IF NOT EXISTS wallets (
                user_email TEXT PRIMARY KEY,
                available_balance DECIMAL(20, 4) DEFAULT 0, -- Funds ready to withdraw
                escrow_balance DECIMAL(20, 4) DEFAULT 0,    -- Funds currently held in escrow
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- 3. TRANSACTIONS TABLE: History of all ledger movements
            CREATE TABLE IF NOT EXISTS transactions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_email TEXT NOT NULL,
                voucher_id TEXT REFERENCES vouchers(id),
                transaction_type VARCHAR(50) NOT NULL, -- 'ESCROW_PAYMENT', 'ESCROW_RELEASE', 'WITHDRAWAL'
                amount_usd DECIMAL(20, 4) NOT NULL,
                fee_usd DECIMAL(20, 4) DEFAULT 0,
                status VARCHAR(20) DEFAULT 'SUCCESSFUL',
                reference_id TEXT, -- Flutterwave TX ID or internal ref
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await client.query(sql);
        console.log("✅ Tables 'vouchers', 'wallets', and 'transactions' initialized!");

    } catch (err) {
        console.error("❌ SETUP FAILED:", err.message);
    } finally {
        if (client) client.release();
        console.log("--- SETUP FINISHED ---");
        process.exit();
    }
}

setup();