import axios from 'axios';

// Simple in-memory cache to store rates for 10 minutes to speed up the UI
const rateCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; 

/**
 * Converts any currency amount using Flutterwave's official merchant rates.
 */
export const convertCurrency = async (amount, fromCurrency, toCurrency = 'USD') => {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) return parseFloat(amount);

    const cacheKey = `${from}_${to}`;
    const cached = rateCache.get(cacheKey);

    // If we have a fresh rate (less than 10 mins old), use it to calculate
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        return parseFloat((amount * cached.rate).toFixed(2));
    }

    try {
        // Call Flutterwave's Rates API
        const url = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${to}&source_currency=${from}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
            }
        });

        if (response.data && response.data.data) {
            const result = response.data.data.destination_amount;
            const rate = response.data.data.rate;

            // Store the rate for future use
            rateCache.set(cacheKey, {
                rate: rate,
                timestamp: Date.now()
            });

            return result;
        } else {
            throw new Error("Invalid response from Flutterwave Rates API");
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("❌ Converter Utility Error:", errorMsg);
        
        // If FLW API is down, we absolutely should not guess the rate.
        throw new Error(`Currency conversion failed: ${errorMsg}`);
    }
};

export const convertToUSD = (amount, fromCurrency) => convertCurrency(amount, fromCurrency, 'USD');

export default { convertCurrency, convertToUSD };