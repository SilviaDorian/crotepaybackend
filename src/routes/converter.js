import axios from 'axios';

/**
 * Converts any currency amount to a target currency (default USD) 
 * using Flutterwave's official merchant rates.
 */
export const convertCurrency = async (amount, fromCurrency, toCurrency = 'USD') => {
    // 1. If currencies match, no API call needed
    if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) {
        return parseFloat(amount);
    }

    try {
        // 2. Call Flutterwave's Rates API
        // This ensures the value in your DB matches the value FLW actually holds
        const url = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${toCurrency}&source_currency=${fromCurrency}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
            }
        });

        if (response.data && response.data.data) {
            // We return the destination_amount (the actual value after conversion)
            return response.data.data.destination_amount;
        } else {
            throw new Error("Invalid response from Flutterwave Rates API");
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("❌ Converter Utility Error:", errorMsg);
        
        // Safety Fallback: 
        // In a production fintech app, you never want to "guess" a rate.
        // It is better to throw an error and stop the transaction than to use a wrong rate.
        throw new Error(`Currency conversion failed: ${errorMsg}`);
    }
};

// Keeping the function name similar to your original for easier refactoring
export const convertToUSD = (amount, fromCurrency) => convertCurrency(amount, fromCurrency, 'USD');

export default { convertCurrency, convertToUSD };