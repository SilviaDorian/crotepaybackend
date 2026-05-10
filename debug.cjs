const { Pool } = require('pg');

console.log(">>> [1] ENGINE STARTED");

const pool = new Pool({
    connectionString: "postgresql://escrow_jgw6_user:bkNiNDwFnZ4uqCYaMJ4QegK2UF8OTgie@dpg-d7v2u0gsfn5c73dahdg0-a.oregon-postgres.render.com/escrow_jgw6?ssl=true",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
});

async function main() {
    console.log(">>> [2] ATTEMPTING HANDSHAKE...");
    try {
        const client = await pool.connect();
        console.log(">>> [3] SUCCESS! DATABASE CONNECTED.");
        
        await client.query('SELECT NOW()');
        console.log(">>> [4] QUERY EXECUTED.");
        
        client.release();
    } catch (err) {
        console.error(">>> [X] ERROR:", err.message);
    } finally {
        await pool.end();
        console.log(">>> [5] SCRIPT COMPLETE.");
        process.exit();
    }
}

main();