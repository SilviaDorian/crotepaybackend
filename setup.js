import { getClient } from './src/db/index.js';

async function setup() {
    console.log("--- STARTING DATABASE SETUP ---");
    let client;
    try {
        console.log("Attempting to connect to Render...");
        client = await getClient();
        console.log("✅ Connection Successful!");

        const sql = `
            CREATE TABLE IF NOT EXISTS vouchers (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                payer_email TEXT NOT NULL,
                recipient_email TEXT NOT NULL,
                amount DECIMAL(20, 2) NOT NULL,
                currency VARCHAR(5) NOT NULL, 
                status VARCHAR(20) DEFAULT 'PENDING',
                release_key_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ledger (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                voucher_id UUID REFERENCES vouchers(id),
                amount DECIMAL(20, 2) NOT NULL,
                currency VARCHAR(5) NOT NULL,
                entry_type VARCHAR(20) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await client.query(sql);
        console.log("✅ Tables 'vouchers' and 'ledger' created successfully!");

    } catch (err) {
        console.error("❌ SETUP FAILED:", err.message);
    } finally {
        if (client) client.release();
        console.log("--- SETUP FINISHED ---");
        process.exit();
    }
}

setup();