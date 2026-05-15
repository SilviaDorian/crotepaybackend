import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 15000,
    max: 20, 
    idleTimeoutMillis: 30000 
};

const pool = new Pool(poolConfig);

// REMOVED: connectWithRetry() call here. 
// We will let the app handle the first connection attempt in app.js or index.js.

pool.on('error', (err) => {
    console.error('❌ UNEXPECTED DATABASE POOL ERROR:', err.message);
});

export const query = (text, params) => pool.query(text, params);

export const runTransaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Transaction Rollback:", e.message);
        throw e;
    } finally {
        client.release();
    }
};

export const getClient = () => pool.connect();

// Utility to test connection without a persistent loop
export const testConnection = async () => {
    try {
        const client = await pool.connect();
        console.log('🐘 Database Connected Successfully');
        client.release();
        return true;
    } catch (err) {
        console.error('❌ DB CONNECTION FAILED:', err.message);
        return false;
    }
};

process.on('SIGINT', async () => {
    await pool.end();
    console.log('🛑 DB Pool ended.');
    process.exit(0);
});

export default pool;