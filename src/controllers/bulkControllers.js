import { getClient } from '../db/index.js';
import { generateVoucherId, generateToken, generateKey, generateBatchRef } from '../utils/idGenerator.js';

export async function createBulkEscrow(req, res) {
    const { creator_email, employees, description, category } = req.body;
    if (!creator_email || !Array.isArray(employees) || employees.length === 0) 
        return res.status(400).json({ error: "Invalid request data." });

    const client = await getClient();
    try {
        await client.query('BEGIN');
        const batchReference = generateBatchRef();
        const batchAccessToken = generateToken();
        const masterReleaseKey = generateKey();
        
        for (const emp of employees) {
            await client.query(
                `INSERT INTO public.vouchers (id, creator_email, recipient_email, recipient_name, amount, currency, status, parent_batch_ref, batch_access_token, master_release_key, recipient_access_token, release_key_hash) 
                 VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10,$11)`,
                [generateVoucherId(), creator_email, emp.email.trim(), emp.name.trim(), parseFloat(emp.amount), emp.currency.toUpperCase(), batchReference, batchAccessToken, masterReleaseKey, generateToken(), generateKey()]
            );
        }
        await client.query('COMMIT');
        res.status(201).json({ success: true, batchReference, batchAccessToken, masterReleaseKey });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Batch creation failed." });
    } finally { client.release(); }
}

export async function getBulkBatch(req, res) {
    // FIX: Destructure safely
    const { batchRef } = req.params;
    const { token } = req.query; 

    // FIX: Add explicit check to prevent 400 errors if params are missing
    if (!batchRef || !token) {
        return res.status(400).json({ error: "Missing batch reference or token." });
    }

    const client = await getClient();
    try {
        const { rows } = await client.query(
            "SELECT * FROM public.vouchers WHERE parent_batch_ref = $1 AND batch_access_token = $2",
            [batchRef, token]
        );
        
        if (rows.length === 0) return res.status(403).json({ error: "Access Denied: Invalid batch or token." });
        
        res.json({ success: true, vouchers: rows });
    } catch (err) {
        res.status(500).json({ error: "Database error during retrieval." });
    } finally { client.release(); }
}

// --- REMAINING FUNCTIONS UNCHANGED ---
export async function releaseSingleVoucher(req, res) {
    const { voucher_id, releaseKey } = req.body;
    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        const vResult = await client.query("SELECT * FROM vouchers WHERE id = $1 FOR UPDATE", [voucher_id]);
        const v = vResult.rows[0];
        if (!v || v.release_key_hash !== releaseKey) throw new Error("Invalid voucher or key.");
        if (v.status !== 'LOCKED') throw new Error("Voucher not in locked status.");

        const amount = parseFloat(v.amount);
        const escrowStartTime = new Date(v.locked_at || v.created_at);
        const targetColumn = (new Date() - escrowStartTime) / (1000 * 60 * 60) >= 72 ? 'available_balance' : 'awaiting_settlement';

        await client.query("UPDATE wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2 AND currency = $3", [amount, v.creator_email, v.currency]);
        await client.query(`INSERT INTO wallets (user_email, ${targetColumn}, currency) VALUES ($1, $2, $3) ON CONFLICT (user_email, currency) DO UPDATE SET ${targetColumn} = wallets.${targetColumn} + $2`, [v.creator_email, amount, v.currency]);
        await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [voucher_id]);
        await client.query("INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)", [v.creator_email, v.id, amount, v.currency, `REL-${v.id}`]);
        
        await client.query('COMMIT');
        res.json({ success: true, message: "Individual voucher released." });
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally { if (client) client.release(); }
}

export async function disputeSingleVoucher(req, res) {
    const { voucher_id, reason, story } = req.body;
    try {
        await (await getClient()).query(
            "UPDATE public.vouchers SET status = 'DISPUTED', dispute_reason = $1, dispute_story = $2 WHERE id = $3",
            [reason, story, voucher_id]
        );
        res.json({ success: true, message: "Individual voucher disputed." });
    } catch (err) { res.status(500).json({ error: "Dispute failed." }); }
}

export async function releaseBatch(req, res) {
    const { batchRef, masterReleaseKey } = req.body;
    let client;
    try {
        client = await getClient();
        await client.query('BEGIN');
        const vResult = await client.query("SELECT * FROM vouchers WHERE parent_batch_ref = $1 FOR UPDATE", [batchRef]);
        if (vResult.rows.length === 0 || vResult.rows[0].master_release_key !== masterReleaseKey) throw new Error("Invalid batch or key.");

        for (const v of vResult.rows) {
            if (v.status !== 'LOCKED') continue;
            const amount = parseFloat(v.amount);
            const targetColumn = (new Date() - new Date(v.locked_at || v.created_at)) / (1000 * 60 * 60) >= 72 ? 'available_balance' : 'awaiting_settlement';
            await client.query("UPDATE wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2 AND currency = $3", [amount, v.creator_email, v.currency]);
            await client.query(`INSERT INTO wallets (user_email, ${targetColumn}, currency) VALUES ($1, $2, $3) ON CONFLICT (user_email, currency) DO UPDATE SET ${targetColumn} = wallets.${targetColumn} + $2`, [v.creator_email, amount, v.currency]);
            await client.query("UPDATE vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1", [v.id]);
            await client.query("INSERT INTO transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)", [v.creator_email, v.id, amount, v.currency, `REL-${v.id}`]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: "Batch released." });
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally { if (client) client.release(); }
}

export async function disputeBatch(req, res) {
    const { batchRef, reason, story } = req.body;
    try {
        await (await getClient()).query(
            "UPDATE public.vouchers SET status = 'DISPUTED', dispute_reason = $1, dispute_story = $2 WHERE parent_batch_ref = $3",
            [reason, story, batchRef]
        );
        res.json({ success: true, message: "Entire batch disputed." });
    } catch (err) { res.status(500).json({ error: "Batch dispute failed." }); }
}