import axios from 'axios';

// Simple in-memory cache to store rates for 10 minutes
const rateCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; 

/**
 * Converts any currency amount using Flutterwave's official merchant rates.
 */
export const convertCurrency = async (amount, fromCurrency, toCurrency = 'USD') => {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    // 1. Safety Checks
    if (!amount || parseFloat(amount) === 0) return 0;
    if (from === to) return parseFloat(amount);

    const cacheKey = `${from}_${to}`;
    const cached = rateCache.get(cacheKey);

    // 2. Check Cache
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        return parseFloat((amount * cached.rate).toFixed(2));
    }

    try {
        // 3. Call Flutterwave's Rates API
        const url = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${to}&source_currency=${from}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
            }
        });

        if (response.data && response.data.data) {
            const result = response.data.data.destination_amount;
            const rate = response.data.data.rate;

            // 4. Update Cache
            rateCache.set(cacheKey, {
                rate: rate,
                timestamp: Date.now()
            });

            return result;
        } else {
            throw new Error("Invalid response from provider");
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("❌ Converter Utility Error:", errorMsg);
        
        // Critical: Do not guess rates if the API is down to avoid financial loss
        throw new Error(`Currency conversion failed: ${errorMsg}`);
    }
};

/**
 * Specifically converts a value to USD for ledger tracking.
 */
export const convertToUSD = (amount, fromCurrency) => convertCurrency(amount, fromCurrency, 'USD');

export default { convertCurrency, convertToUSD };