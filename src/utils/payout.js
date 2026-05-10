import axios from 'axios';

/**
 * Internal helper to fetch live exchange rates.
 */
const getExchangeRate = async (targetCurrency) => {
    try {
        const apiKey = process.env.EXCHANGERATE_API_KEY;
        const response = await axios.get(`https://v6.exchangerate-api.com/v6/${apiKey}/pair/USD/${targetCurrency}`);
        
        if (response.data && response.data.conversion_rate) {
            return response.data.conversion_rate;
        }
        throw new Error("Invalid response from Exchange Rate API");
    } catch (error) {
        console.error("Rate Fetch Error:", error.message);
        throw new Error("Unable to fetch current exchange rates.");
    }
};

/**
 * Triggers the actual bank payout via Flutterwave.
 */
export const triggerBankTransfer = async (details) => {
    const { amount, currency, bankCode, accountNumber, reference } = details;

    try {
        const liveRate = await getExchangeRate(currency);
        const safetyBuffer = 0.995; 
        const appliedRate = liveRate * safetyBuffer;
        const localAmount = Math.floor(amount * appliedRate);

        console.log(`[PAYOUT] Converting $${amount} USD to ${localAmount} ${currency}`);

        const response = await axios.post(
            'https://api.flutterwave.com/v3/transfers',
            {
                account_bank: bankCode,
                account_number: accountNumber,
                amount: localAmount,
                currency: currency,
                reference: reference,
                callback_url: `${process.env.BASE_URL}/api/webhooks/flutterwave`,
                debit_currency: "USD"
            },
            {
                headers: { 
                    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            ...response.data,
            applied_rate: appliedRate,
            local_amount: localAmount,
            usd_amount: amount
        };

    } catch (error) {
        const flwError = error.response?.data?.message || error.message;
        console.error("Transfer Execution Error:", flwError);
        throw new Error(`Payout failed: ${flwError}`);
    }
};

// ADD THIS AT THE VERY BOTTOM TO FIX THE IMPORT ERROR
export default { triggerBankTransfer };