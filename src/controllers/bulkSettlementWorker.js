import { getClient } from '../db/index.js';
import { sendNotification } from '../services/notificationService.js'; // Ensure path is correct

async function creditEscrowWallet(client, voucher) {
    const amount = Number(voucher.amount);
    const ref = `BULK-ESCROW-${voucher.id}`;

    await client.query(
        `INSERT INTO public.wallets 
         (user_email, currency, escrow_balance, available_balance, awaiting_settlement, updated_at)
         VALUES ($1, $2, $3, 0, 0, NOW())
         ON CONFLICT (user_email, currency) 
         DO UPDATE SET 
             escrow_balance = wallets.escrow_balance + EXCLUDED.escrow_balance,
             updated_at = NOW()`,
        [voucher.recipient_email, voucher.currency.toUpperCase(), amount]
    );

    await client.query(
        `INSERT INTO public.transactions 
         (user_email, voucher_id, transaction_type, amount, currency, status, reference_id, created_at, updated_at)
         VALUES ($1, $2, 'ESCROW_DEPOSIT', $3, $4, 'SUCCESSFUL', $5, NOW(), NOW())
         ON CONFLICT (reference_id) DO NOTHING`,
        [voucher.recipient_email, voucher.id, amount, voucher.currency, ref]
    );

    await client.query(
        `UPDATE public.vouchers 
         SET escrow_funded = true, updated_at = NOW() 
         WHERE id = $1`,
        [voucher.id]
    );
}

export async function processBulkEscrowFunding(batchRef = null) {
    let client;

    console.log(`[WORKER] Started at ${new Date().toISOString()} | Batch: ${batchRef || 'ALL'}`);

    try {
        console.log(`🚀 BULK WORKER START for batch: ${batchRef || 'ALL_PENDING'}`);

        client = await getClient();
        await client.query('BEGIN');
        await client.query('SET search_path TO public');

        const result = await client.query(
            `
            SELECT * FROM public.vouchers
            WHERE status = 'LOCKED'
              AND parent_batch_ref IS NOT NULL
              AND ($1::text IS NULL OR parent_batch_ref = $1)
              AND (escrow_funded IS FALSE OR escrow_funded IS NULL)
            FOR UPDATE SKIP LOCKED
            `,
            [batchRef]
        );

        console.log(`📦 Found ${result.rows.length} unfunded locked vouchers`);

        let fundedCount = 0;

        for (const voucher of result.rows) {
            try {
                await creditEscrowWallet(client, voucher);
                fundedCount++;
                console.log(`✅ FUNDED → ${voucher.recipient_email} | ${voucher.amount} ${voucher.currency} (${voucher.id})`);

                // --- TRIGGER NOTIFICATION HERE ---
        // We use recipient_email and the voucher details available in the loop
        sendNotification('VOUCHER_LOCKED', voucher.recipient_email, {
            full_name: voucher.recipient_name || 'User', // Ensure your DB select gets this
            voucher_ref: voucher.id,
            amount: voucher.amount,
            currency: voucher.currency,
            cta_link: "https://fielpay.free.nf/login.html"
        }).catch(err => console.error(`❌ Failed to send bulk lock email to ${voucher.recipient_email}:`, err));
        
            } catch (e) {
                console.error(`❌ Failed voucher ${voucher.id}:`, e.message);
            }
        }

        await client.query('COMMIT');
        console.log(`✅ BULK WORKER COMPLETED | Batch: ${batchRef} | Funded: ${fundedCount} vouchers`);

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ BULK WORKER CRITICAL ERROR:', err.message);
    } finally {
        if (client) client.release();
    }
}