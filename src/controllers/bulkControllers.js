import { getClient } from '../db/index.js';
import { sendNotification } from '../services/notificationService.js'; // Ensure path is correct
import { generateVoucherId, generateToken, generateKey, generateBatchRef } from '../utils/idGenerator.js';

// --- BATCH CREATION ---
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
                `INSERT INTO public.vouchers 
                (id, creator_email, recipient_email, recipient_name, amount, currency, status, parent_batch_ref, batch_access_token, master_release_key, recipient_access_token, release_key_hash, locked_at) 
                 VALUES ($1,$2,$3,$4,$5,$6,'LOCKED',$7,$8,$9,$10,$11, NOW())`,
                [
                    generateVoucherId(),
                    creator_email,
                    emp.email.trim(),
                    emp.name.trim(),
                    parseFloat(emp.amount),
                    emp.currency.toUpperCase(),
                    batchReference,
                    batchAccessToken,
                    masterReleaseKey,
                    generateToken(),
                    generateKey()
                ]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, batchReference, batchAccessToken, masterReleaseKey });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Batch creation failed." });
    } finally {
        client.release();
    }
}

// --- SECURE BATCH RETRIEVAL ---
export async function getBulkBatch(req, res) {
    const batchRef = req.params.batchRef || req.url.split('/')[4]?.split('?')[0];
    const token = req.query.token;

    if (!batchRef || !token) {
        return res.status(400).json({ error: "Missing batch reference or token." });
    }

    const client = await getClient();
    try {
        const { rows } = await client.query(
            "SELECT * FROM public.vouchers WHERE parent_batch_ref = $1 AND batch_access_token = $2",
            [batchRef, token]
        );

        if (rows.length === 0) return res.status(403).json({ error: "Access Denied." });
        res.json({ success: true, vouchers: rows });

    } catch (err) {
        res.status(500).json({ error: "Database error." });
    } finally {
        client.release();
    }
}

export async function getBatchDetails(req, res) {
    const { batchRef } = req.params;
    const { token } = req.query;

    if (!batchRef || !token)
        return res.status(400).json({ error: "Missing credentials." });

    const client = await getClient();
    try {
        const { rows } = await client.query(
            "SELECT * FROM public.vouchers WHERE parent_batch_ref = $1 AND batch_access_token = $2",
            [batchRef, token]
        );

        if (rows.length === 0) return res.status(403).json({ error: "Access Denied." });

        res.json({
            success: true,
            batchRef: rows[0].parent_batch_ref,
            masterKey: rows[0].master_release_key,
            status: rows[0].status,
            vouchers: rows
        });

    } catch (err) {
        res.status(500).json({ error: "Database error." });
    } finally {
        client.release();
    }
}

// --- SINGLE VOUCHER RELEASE ---
export async function releaseSingleVoucher(req, res) {
    const { voucher_id, releaseKey } = req.body;
    let client;

    try {
        client = await getClient();
        await client.query('BEGIN');

        // Logic: Check 72 hours from locked_at
        const vResult = await client.query(
            "SELECT *, (EXTRACT(EPOCH FROM (NOW() - locked_at)) / 3600) >= 72 as is_over_72 FROM public.vouchers WHERE id = $1 FOR UPDATE",
            [voucher_id]
        );

        const v = vResult.rows[0];
        if (!v || v.release_key_hash !== releaseKey)
            throw new Error("Invalid voucher or key.");

        if (v.status !== 'LOCKED')
            throw new Error("Voucher not in locked status.");

        const amount = parseFloat(v.amount);
        const targetColumn = v.is_over_72 ? 'available_balance' : 'awaiting_settlement';

        await client.query(
            "UPDATE public.wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2 AND currency = $3",
            [amount, v.recipient_email, v.currency]
        );

        await client.query(
            `UPDATE public.wallets 
             SET ${targetColumn} = ${targetColumn} + $1 
             WHERE user_email = $2 AND currency = $3`,
            [amount, v.recipient_email, v.currency]
        );

        await client.query(
            "UPDATE public.vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1",
            [v.id]
        );

        await client.query(
            "INSERT INTO public.transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)",
            [v.recipient_email, v.id, amount, v.currency, `REL-${v.id}`]
        );

        await client.query('COMMIT');

      // --- TRIGGER RELEASE NOTIFICATION HERE ---
try {
    await sendNotification('VOUCHER_RELEASED', v.recipient_email, {
        voucher_ref: v.id,
        amount: amount,
        currency: v.currency
    });
    console.log(`✅ VOUCHER_RELEASED notification sent to ${v.recipient_email}`);
} catch (err) {
    console.error(`❌ Failed to send VOUCHER_RELEASED email to ${v.recipient_email}:`, err);
}
        res.json({ success: true, message: "Voucher released successfully." });

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
}

export async function disputeSingleVoucher(req, res) {
    const { voucher_id, reason, story } = req.body;

    try {
        await (await getClient()).query(
            "UPDATE public.vouchers SET status = 'DISPUTED', dispute_reason = $1, dispute_story = $2 WHERE id = $3",
            [reason, story, voucher_id]
        );
        res.json({ success: true, message: "Individual voucher disputed." });
    } catch (err) {
        res.status(500).json({ error: "Dispute failed." });
    }
}

// --- 🔥 FIXED: RACE-PROOF BATCH RELEASE ---
export async function releaseBatch(req, res) {
    const { batchRef, masterReleaseKey } = req.body;
    const client = await getClient();

    try {
        await client.query('BEGIN');

        const vResult = await client.query(
            "SELECT *, (EXTRACT(EPOCH FROM (NOW() - locked_at)) / 3600) >= 72 as is_over_72 FROM public.vouchers WHERE parent_batch_ref = $1 FOR UPDATE",
            [batchRef]
        );

        if (vResult.rows.length === 0 || vResult.rows[0].master_release_key !== masterReleaseKey) {
            throw new Error("Invalid batch or key.");
        }

        for (const v of vResult.rows) {
            if (v.status !== 'LOCKED') continue;

            const amount = parseFloat(v.amount);
            const targetColumn = v.is_over_72 ? 'available_balance' : 'awaiting_settlement';

            await client.query(
                "UPDATE public.wallets SET escrow_balance = escrow_balance - $1 WHERE user_email = $2 AND currency = $3",
                [amount, v.recipient_email, v.currency]
            );

            await client.query(
                `UPDATE public.wallets 
                 SET ${targetColumn} = ${targetColumn} + $1 
                 WHERE user_email = $2 AND currency = $3`,
                [amount, v.recipient_email, v.currency]
            );

            await client.query(
                "UPDATE public.vouchers SET status = 'RELEASED', updated_at = NOW() WHERE id = $1",
                [v.id]
            );

            await client.query(
                "INSERT INTO public.transactions (user_email, voucher_id, transaction_type, amount, currency, status, reference_id) VALUES ($1, $2, 'ESCROW_RELEASE', $3, $4, 'SUCCESSFUL', $5)",
                [v.recipient_email, v.id, amount, v.currency, `REL-${v.id}`]
            );
        }

        await client.query('COMMIT');

        // --- TRIGGER RELEASE NOTIFICATION HERE ---
try {
    await sendNotification('VOUCHER_RELEASED', v.recipient_email, {
        voucher_ref: v.id,
        amount: amount,
        currency: v.currency
    });
    console.log(`✅ VOUCHER_RELEASED notification sent to ${v.recipient_email}`);
} catch (err) {
    console.error(`❌ Failed to send release email for ${v.id}:`, err);
}

  
        res.json({ success: true, message: "Batch released successfully." });

    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: e.message });
    } finally {
        client.release();
    }
}

export async function disputeBatch(req, res) {
    const { batchRef, token, reason, story } = req.body;
    if (!batchRef || !token) return res.status(400).json({ success: false, message: "Missing required fields." });

    try {
        const client = await getClient();
        const authCheck = await client.query(
            "SELECT id FROM public.vouchers WHERE parent_batch_ref = $1 AND batch_access_token = $2 LIMIT 1",
            [batchRef, token]
        );

        if (authCheck.rowCount === 0) return res.status(403).json({ success: false, message: "Unauthorized." });

        await client.query(
            `UPDATE public.vouchers SET status = 'DISPUTED', dispute_reason = $1, dispute_story = $2 WHERE parent_batch_ref = $3`,
            [reason, story, batchRef]
        );

        res.json({ success: true, message: "Entire batch disputed successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: "Batch dispute failed." });
    }
}