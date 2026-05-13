const axios = require('axios');

/**
 * Converts any currency amount to USD for internal accounting
 */
const convertToUSD = async (amount, fromCurrency) => {
    if (fromCurrency === 'USD') return parseFloat(amount);

    try {
        const apiKey = process.env.EXCHANGERATE_API_KEY;
        const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/${fromCurrency}/USD/${amount}`;
        const response = await axios.get(url);

        return response.data.conversion_result;
    } catch (error) {
        console.error("Conversion Utility Error:", error.message);
        // Fallback: If API fails, you might want to throw an error or use a cached rate
        throw new Error("Currency conversion failed");
    }
};

module.exports = { convertToUSD };