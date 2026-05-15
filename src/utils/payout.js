import axios from 'axios';

/**
 * Triggers the bank payout via Flutterwave.
 * Handles both "Same-Currency" transfers and "Cross-Currency" conversions.
 */
export const triggerBankTransfer = async (details) => {
    const { amount, sourceCurrency, targetCurrency, bankCode, accountNumber, reference } = details;

    try {
        let finalPayoutAmount = amount;
        let appliedRate = 1.0;

        // --- 1. SMART ROUTING: Only convert if source and target differ ---
        if (sourceCurrency !== targetCurrency) {
            console.log(`[PAYOUT] FX detected: Converting ${amount} ${sourceCurrency} to ${targetCurrency}`);
            
            // Fetch the official rate from Flutterwave to ensure zero-loss for the merchant
            const rateUrl = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${targetCurrency}&source_currency=${sourceCurrency}`;
            
            const rateResponse = await axios.get(rateUrl, {
                headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
            });

            if (rateResponse.data && rateResponse.data.data) {
                finalPayoutAmount = rateResponse.data.data.destination_amount;
                appliedRate = rateResponse.data.data.rate;
            } else {
                throw new Error("Could not fetch internal FX rate from Flutterwave.");
            }
        } else {
            console.log(`[PAYOUT] Native Lane: Sending ${amount} ${targetCurrency} directly.`);
        }

        // --- 2. EXECUTE TRANSFER ---
        const response = await axios.post(
            'https://api.flutterwave.com/v3/transfers',
            {
                account_bank: bankCode,
                account_number: accountNumber,
                amount: finalPayoutAmount, // The amount in the local currency
                currency: targetCurrency,   // e.g., 'NGN', 'USD', 'GHS'
                reference: reference,
                debit_currency: sourceCurrency, // The currency to deduct from your FLW balance
                callback_url: `${process.env.BASE_URL}/api/webhooks/flutterwave`
            },
            {
                headers: { 
                    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // --- 3. RETURN DATA ---
        return {
            success: true,
            flw_id: response.data.data.id,
            applied_rate: appliedRate,
            local_amount: finalPayoutAmount,
            source_amount: amount,
            source_currency: sourceCurrency
        };

    } catch (error) {
        const flwError = error.response?.data?.message || error.message;
        console.error("❌ Transfer Execution Error:", flwError);
        throw new Error(`Payout failed: ${flwError}`);
    }
};

export default { triggerBankTransfer };