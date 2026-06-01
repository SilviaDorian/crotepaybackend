import { getClient } from '../db/index.js';
import {
    generateVoucherId,
    generateToken,
    generateKey,
    generateBatchRef
} from '../utils/idGenerator.js';

export async function createBulkEscrow(req, res) {
    const { creator_email, employees, description, category } = req.body;

    // 1. Validate input
    if (
        !creator_email ||
        !employees ||
        !Array.isArray(employees) ||
        employees.length === 0
    ) {
        return res.status(400).json({
            error: "Invalid request. Please provide a valid creator email and a list of employees."
        });
    }

    const client = await getClient();

    try {
        await client.query('BEGIN');

        // 2. Verify creator
        const creatorCheck = await client.query(
            "SELECT kyc_tier FROM public.users WHERE email = $1",
            [creator_email]
        );

        if (creatorCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                error: `Account for '${creator_email}' not found.`
            });
        }

        // 3. Validate currencies
        const uniqueCurrencies = [...new Set(employees.map(e => e.currency))];

        const walletCheck = await client.query(
            "SELECT currency FROM wallets WHERE user_email = $1 AND currency = ANY($2)",
            [creator_email, uniqueCurrencies]
        );

        const existingCurrencies = walletCheck.rows.map(r => r.currency);

        for (const curr of uniqueCurrencies) {
            if (!existingCurrencies.includes(curr)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `Wallet for currency '${curr}' is not initialized.`
                });
            }
        }

        // 4. NEW: Batch-level data
        const batchReference = generateBatchRef();
        const batchAccessToken = generateToken();
        const masterReleaseKey = generateKey();

        let totalAmount = 0;

        // 5. Create vouchers
        for (const emp of employees) {
            if (
                !emp.email ||
                !emp.name ||
                !emp.amount ||
                Number(emp.amount) <= 0
            ) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `Invalid data for ${emp.email || 'employee'}.`
                });
            }

            totalAmount += Number(emp.amount);

            const voucherId = generateVoucherId();
            const token = generateToken();
            const releaseKey = generateKey();

            await client.query(
                `
                INSERT INTO public.vouchers (
                    id,
                    creator_email,
                    recipient_email,
                    recipient_name,
                    amount,
                    currency,
                    status,
                    parent_batch_ref,
                    description,
                    category,
                    recipient_access_token,
                    release_key_hash,
                    batch_access_token,
                    master_release_key
                )
                VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10,$11,$12,$13)
                `,
                [
                    voucherId,
                    creator_email,
                    emp.email,
                    emp.name,
                    emp.amount,
                    emp.currency,
                    batchReference,
                    description || 'Bulk Escrow',
                    category || 'General',
                    token,
                    releaseKey,
                    batchAccessToken,
                    masterReleaseKey
                ]
            );
        }

        await client.query('COMMIT');

        // 6. RESPONSE FOR FRONTEND FLOW
        return res.status(201).json({
            success: true,
            batchReference,
            totalAmount: totalAmount.toFixed(2),
            count: employees.length,

            // important for your 3-screen flow
            batchAccessToken,
            masterReleaseKey,

            payment_url: `/batchpayment.html?batch=${batchReference}`
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Bulk Creation Error:", err.message);

        return res.status(500).json({
            error: "An internal error occurred. No vouchers were created."
        });

    } finally {
        client.release();
    }
}