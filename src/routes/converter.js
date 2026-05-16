import axios from 'axios';

// Simple in-memory cache to store rates for 10 minutes
const rateCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; 

/**
 * Converts any currency amount using Flutterwave's official merchant rates.
 * Use this only when a user explicitly requests an exchange or a cross-currency withdrawal.
 */
export const convertCurrency = async (amount, fromCurrency, toCurrency = 'USD') => {
    // 1. Basic Validation
    if (!amount || isNaN(amount) || parseFloat(amount) === 0) return 0;
    
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) return parseFloat(amount);

    // 2. Check Cache
    const cacheKey = `${from}_${to}`;
    const cached = rateCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        return parseFloat((amount * cached.rate).toFixed(2));
    }

    try {
        // 3. Call Flutterwave's Rates API
        // Note: amount is passed to FLW to get the exact destination total including their precision
        const url = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${to}&source_currency=${from}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
            }
        });

        if (response.data && response.data.data) {
            const result = response.data.data.destination_amount;
            const rate = response.data.data.rate;

            // 4. Update Cache for future calls
            rateCache.set(cacheKey, {
                rate: rate,
                timestamp: Date.now()
            });

            return result;
        } else {
            throw new Error("Invalid response from Flutterwave");
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("❌ Currency Exchange Error:", errorMsg);
        
        // Critical: We throw the error so the UI doesn't process a transaction with a 'fake' rate.
        throw new Error(`Exchange rate unavailable: ${errorMsg}`);
    }
};

/**
 * Helper for internal USD ledger checks if needed in the future.
 */
export const convertToUSD = (amount, fromCurrency) => convertCurrency(amount, fromCurrency, 'USD');

export default { convertCurrency, convertToUSD };