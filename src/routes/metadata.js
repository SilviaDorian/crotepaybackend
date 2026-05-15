import express from 'express';
import axios from 'axios';

const router = express.Router();

/**
 * GET /api/metadata/rates
 * Fetches real-time exchange rates from Flutterwave.
 * This ensures the frontend matches the actual payout engine.
 */
router.get('/rates', async (req, res) => {
    try {
        const { source = 'USD', target = 'NGN', amount = 1 } = req.query;

        // We use Flutterwave's rate endpoint instead of an external 3rd party
        const url = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${target}&source_currency=${source}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`
            }
        });

        if (response.data && response.data.data) {
            const data = response.data.data;
            res.json({
                success: true,
                base: source,
                target: target,
                rate: data.rate,
                converted_amount: data.destination_amount,
                flutterwave_fee: data.flutterwave_fee,
                timestamp: new Date().toISOString()
            });
        } else {
            throw new Error("Invalid response from Flutterwave Rates API");
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("Exchange Rate Fetch Error:", errorMsg);
        
        // Fallback: If Flutterwave is down, you can return a 500 or a cached rate
        res.status(500).json({ 
            success: false, 
            error: "Could not retrieve live exchange rates from the clearing provider." 
        });
    }
});

/**
 * GET /api/metadata/supported-countries
 * Useful for the frontend to populate withdrawal country dropdowns
 */
router.get('/countries', (req, res) => {
    const countries = [
        { name: "Nigeria", code: "NG", currency: "NGN" },
        { name: "Ghana", code: "GH", currency: "GHS" },
        { name: "Kenya", code: "KE", currency: "KES" },
        { name: "United States", code: "US", currency: "USD" },
        { name: "United Kingdom", code: "GB", currency: "GBP" },
        { name: "Europe", code: "EU", currency: "EUR" },
        { name: "Uganda", code: "UG", currency: "UGX" },
        { name: "South Africa", code: "ZA", currency: "ZAR" }
    ];
    res.json({ success: true, data: countries });
});

export default router;