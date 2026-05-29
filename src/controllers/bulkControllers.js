import { query } from '../db/index.js';
import crypto from 'crypto';

export async function createBulkEscrow(req, res) {
    const { creator_email, employees, description, category } = req.body;

    // 1. Basic Payload Validation
    if (!creator_email || !employees || !Array.isArray(employees)) {
        return res.status(400).json({ error: "Invalid request. Please provide a valid creator email and a list of employees." });
    }

    try {
        // 2. Verify Creator existence
        const creatorCheck = await query("SELECT kyc_tier FROM public.users WHERE email = $1", [creator_email]);
        if (creatorCheck.rows.length === 0) {
            return res.status(404).json({ error: `The account associated with '${creator_email}' does not exist.` });
        }

        // 3. Currency/Wallet Validation
        const uniqueCurrencies = [...new Set(employees.map(e => e.currency))];
        const walletCheck = await query(
            "SELECT currency FROM wallets WHERE user_email = $1 AND currency = ANY($2)",
            [creator_email, uniqueCurrencies]
        );
        const existingCurrencies = walletCheck.rows.map(r => r.currency);

        for (const curr of uniqueCurrencies) {
            if (!existingCurrencies.includes(curr)) {
                return res.status(400).json({ 
                    error: `Wallet for currency '${curr}' is not initialized. Please set up your '${curr}' wallet before proceeding.` 
                });
            }
        }

        // 4. Batch Insertion Logic
        const batchReference = `BATCH-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
        
        for (const emp of employees) {
            // Friendly validation for employee entries
            if (!emp.email || !emp.name) {
                return res.status(400).json({ error: "Every employee must have a name and an email address." });
            }
            if (!emp.amount || isNaN(emp.amount) || Number(emp.amount) <= 0) {
                return res.status(400).json({ error: `Invalid amount provided for ${emp.email}. Amount must be greater than zero.` });
            }

            const voucherId = `VC-${crypto.randomInt(100000, 999999)}`;
            const token = crypto.randomBytes(32).toString('hex');
            const releaseKey = crypto.randomBytes(8).toString('hex');

            await query(`
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

        res.status(201).json({ 
            success: true, 
            message: `Successfully processed ${employees.length} vouchers.`,
            batchReference, 
            count: employees.length 
        });

    } catch (err) {
        console.error("Bulk Creation Error:", err.message);
        res.status(500).json({ error: "An internal server error occurred while processing your bulk request." });
    }
}