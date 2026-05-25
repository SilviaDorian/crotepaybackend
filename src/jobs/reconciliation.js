import { query } from '../db/index.js';

// Helper to check Flutterwave status using their list API
async function checkFlutterwaveStatus(reference) {
    try {
        const response = await fetch(`https://api.flutterwave.com/v3/transfers?reference=${reference}`, {
            method: 'GET',
            headers: { 
                'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        const result = await response.json();
        
        // Flutterwave returns a list of transfers. Find the one matching our reference.
        if (result.status === 'success' && result.data.transfers.length > 0) {
            return result.data.transfers[0].status; // e.g., 'SUCCESSFUL' or 'FAILED'
        }
        return 'PENDING';
    } catch (err) {
        console.error("Flutterwave API Error:", err);
        return 'UNKNOWN';
    }
}

export async function runSettlementLogic() {
    console.log("Starting daily reconciliation...");

    const pendingTxs = await query(`
        SELECT * FROM public.transactions 
        WHERE status = 'PENDING' 
        AND created_at < NOW() - INTERVAL '3 days'`);

    for (const tx of pendingTxs.rows) {
        const flwStatus = await checkFlutterwaveStatus(tx.reference);

        if (flwStatus === 'SUCCESSFUL') {
            await finalizeSettlement(tx);
        } else if (flwStatus === 'FAILED') {
            await reverseTransaction(tx);
        }
    }
}

async function finalizeSettlement(tx) {
    try {
        await query('BEGIN');
        await query(`
            UPDATE public.wallets 
            SET awaiting_settlement = awaiting_settlement - $1,
                available_balance = available_balance + $2
            WHERE user_email = $3 AND currency = $4`,
            [tx.amount, tx.converted_amount, tx.user_email, tx.to_currency]
        );
        await query("UPDATE public.transactions SET status = 'SUCCESSFUL' WHERE id = $1", [tx.id]);
        await query('COMMIT');
    } catch (err) { await query('ROLLBACK'); }
}

async function reverseTransaction(tx) {
    try {
        await query('BEGIN');
        await query(`
            UPDATE public.wallets 
            SET awaiting_settlement = awaiting_settlement - $1,
                available_balance = available_balance + $1
            WHERE user_email = $2 AND currency = $3`,
            [tx.amount, tx.user_email, tx.from_currency]
        );
        await query("UPDATE public.transactions SET status = 'FAILED' WHERE id = $1", [tx.id]);
        await query('COMMIT');
    } catch (err) { await query('ROLLBACK'); }
}