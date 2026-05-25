import { query } from '../db/index.js';
import cron from 'node-cron';

// Helper to check Flutterwave status
async function checkFlutterwaveTransaction(reference) {
    try {
        const response = await fetch(`https://api.flutterwave.com/v3/transfers?reference=${reference}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` }
        });
        const data = await response.json();
        // Assuming FLW returns success in the data object for the transfer
        return data.data && data.data[0] ? data.data[0].status : 'PENDING';
    } catch (err) {
        console.error("Error verifying with Flutterwave:", err);
        return 'UNKNOWN';
    }
}

export const startSettlementJob = () => {
    // Runs at 01:00 AM daily
    cron.schedule('0 1 * * *', async () => {
        console.log("Running Settlement Reconciliation Job...");

        try {
            // Find transactions PENDING for >= 3 business days
            // Note: Adjust the interval based on your specific SQL needs
            const pendingTxs = await query(`
                SELECT * FROM public.transactions 
                WHERE status = 'PENDING' 
                AND created_at < NOW() - INTERVAL '3 days'`);

            for (const tx of pendingTxs.rows) {
                const flwStatus = await checkFlutterwaveTransaction(tx.reference);

                if (flwStatus === 'SUCCESSFUL') {
                    await finalizeSettlement(tx);
                } else if (flwStatus === 'FAILED') {
                    await reverseTransaction(tx);
                }
            }
        } catch (err) {
            console.error("Reconciliation Job Error:", err);
        }
    });
};

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
        console.log(`Settled TX: ${tx.id}`);
    } catch (err) {
        await query('ROLLBACK');
    }
}

async function reverseTransaction(tx) {
    try {
        await query('BEGIN');
        // Reverse funds back to original wallet
        await query(`
            UPDATE public.wallets 
            SET awaiting_settlement = awaiting_settlement - $1,
                available_balance = available_balance + $1
            WHERE user_email = $2 AND currency = $3`,
            [tx.amount, tx.user_email, tx.from_currency]
        );
        await query("UPDATE public.transactions SET status = 'FAILED' WHERE id = $1", [tx.id]);
        await query('COMMIT');
        console.log(`Reversed TX: ${tx.id}`);
    } catch (err) {
        await query('ROLLBACK');
    }
}