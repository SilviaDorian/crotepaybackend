import axios from 'axios';

// Constants for platform logic
const CONVERSION_FEE_PERCENT = 0.02; // 2% fee
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const rateCache = new Map();

/**
 * 1. Fetch live rate from Flutterwave
 */
export const getExchangeRate = async (amount, from, to) => {
    const cacheKey = `${from}_${to}`;
    const cached = rateCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        return cached.rate;
    }

    const url = `https://api.flutterwave.com/v3/transfers/rates`;
    const response = await axios.post(url, {
        amount: amount,
        destination_currency: to,
        source_currency: from
    }, {
        headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
    });
    
    if (!response.data?.data) throw new Error("Rate lookup failed.");
    
    const rate = response.data.data.rate;
    rateCache.set(cacheKey, { rate, timestamp: Date.now() });
    return rate;
};

/**
 * 2. Calculate conversion with platform fee
 */
export const calculateConversion = async (amount, fromCurrency, toCurrency) => {
    const fee = amount * CONVERSION_FEE_PERCENT;
    const amountToConvert = amount - fee;
    const rate = await getExchangeRate(amountToConvert, fromCurrency, toCurrency);
    
    return {
        grossAmount: amount,
        fee: fee,
        amountToConvert: amountToConvert,
        rate: rate,
        netDestinationAmount: amountToConvert * rate
    };
};

/**
 * 3. Flutterwave Wallet-to-Wallet Transfer Request
 * This represents the "Physical Liquidity" movement.
 */
export const executeFlutterwaveTransfer = async (amount, from, to) => {
    // Note: You must ensure your Flutterwave merchant setup supports 
    // wallet-to-wallet transfers for these specific currency pairs.
    const url = `https://api.flutterwave.com/v3/transfers`;
    const response = await axios.post(url, {
        account_bank: "FLW", // Indicating internal FLW transfer
        amount: amount,
        currency: to,
        narration: `Conversion from ${from} to ${to}`,
        reference: `conv_${Date.now()}`
    }, {
        headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
    });
    
    return response.data;
};

/**
 * 4. Master Converter Function (Orchestrator)
 * This is what you call from your route handler.
 */
export const processConversion = async (email, amount, from, to) => {
    // A. Perform calculations
    const calc = await calculateConversion(amount, from, to);
    
    // B. Trigger the API call to Flutterwave (Physical Liquidity)
    // We do this immediately to lock in the transfer process
    const flwTransfer = await executeFlutterwaveTransfer(calc.netDestinationAmount, from, to);
    
    return {
        ...calc,
        transferReference: flwTransfer.data.id,
        status: 'PROCESSING' // We return this to save to DB
    };
};

export default { processConversion, calculateConversion };