import { pool } from '../db/index.js';
import { generateVoucherId, generateToken, generateKey, generateBatchRef } from '../utils/idGenerator.js';

export async function createBulkEscrow(req, res) {
    const { creator_email, employees, description, category } = req.body;

    // 1. Basic Payload Validation
    if (!creator_email || !employees || !Array.isArray(employees) || employees.length === 0) {
        return res.status(400).json({ error: "Invalid request. Please provide a valid creator email and a list of employees." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start Transaction

        // 2. Verify Creator existence
        const creatorCheck = await client.query("SELECT kyc_tier FROM public.users WHERE email = $1", [creator_email]);
        if (creatorCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Account for '${creator_email}' not found.` });
        }

        // 3. Validate Currencies & Calculate Total Amount
        let totalAmount = 0;
        const uniqueCurrencies = [...new Set(employees.map(e => e.currency))];
        
        const walletCheck = await client.query(
            "SELECT currency FROM wallets WHERE user_email = $1 AND currency = ANY($2)",
            [creator_email, uniqueCurrencies]
        );
        const existingCurrencies = walletCheck.rows.map(r => r.currency);

        for (const curr of uniqueCurrencies) {
            if (!existingCurrencies.includes(curr)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `Wallet for currency '${curr}' is not initialized.` });
            }
        }

        // 4. Batch Insertion Logic
        const batchReference = generateBatchRef();
        
        for (const emp of employees) {
            // Validate individual record data
            if (!emp.email || !emp.name || !emp.amount || Number(emp.amount) <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `Invalid data for ${emp.email || 'employee'}.` });
            }

            totalAmount += Number(emp.amount); // Accumulate total for Flutterwave

            const voucherId = generateVoucherId();
            const token = generateToken();
            const releaseKey = generateKey();

            await client.query(`
                INSERT INTO public.vouchers (
                    id, creator_email, recipient_email, recipient_name, amount, 
                    currency, status, parent_batch_ref, description, category, 
                    recipient_access_token, release_key_hash
                ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10, $11)
            `, [
                voucherId, creator_email, emp.email, emp.name, emp.amount, 
                emp.currency, batchReference, description || 'Bulk Escrow', 
                category || 'General', token, releaseKey
            ]);
        }

        await client.query('COMMIT'); // Commit all changes if successful

        res.status(201).json({ 
            success: true, 
            batchReference, 
            totalAmount: totalAmount.toFixed(2), 
            count: employees.length 
        });

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on any error
        console.error("Bulk Creation Error:", err.message);
        res.status(500).json({ error: "An internal error occurred. No vouchers were created." });
    } finally {
        client.release(); // Return client to pool
    }
}