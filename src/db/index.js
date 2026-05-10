import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 15000, // Increased to 15s for slower networks
    max: 20, 
    idleTimeoutMillis: 30000 
};

const pool = new Pool(poolConfig);

// Improved Connection Test with Retry
const connectWithRetry = () => {
    pool.connect((err, client, release) => {
        if (err) {
            console.error('❌ DB CONNECTION FAILED. Retrying in 5 seconds...', err.message);
            setTimeout(connectWithRetry, 5000); // Retry every 5 seconds
        } else {
            console.log('🐘 Database Connected Successfully');
            release();
        }
    });
};

connectWithRetry();

pool.on('error', (err) => {
    // This handles errors on idle clients in the pool
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

process.on('SIGINT', async () => {
    await pool.end();
    console.log('🛑 DB Pool ended.');
    process.exit(0);
});

export default pool;