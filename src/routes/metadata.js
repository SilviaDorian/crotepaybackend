import express from 'express';
import axios from 'axios';

const router = express.Router();

/**
 * GET /api/metadata/rates
 * Fetches real-time exchange rates from Flutterwave.
 */
router.get('/rates', async (req, res) => {
    try {
        // Sanitize and provide strict defaults
        const source = (req.query.source || 'USD').toUpperCase().trim();
        const target = (req.query.target || 'NGN').toUpperCase().trim();
        const amount = parseFloat(req.query.amount) || 1;

        // Flutterwave Rate API Endpoint
        const url = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${target}&source_currency=${source}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
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
            throw new Error("Invalid response format from clearing provider.");
        }
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("Exchange Rate Fetch Error:", errorMsg);
        
        res.status(500).json({ 
            success: false, 
            error: "Could not retrieve live exchange rates.",
            details: process.env.NODE_ENV === 'development' ? errorMsg : undefined
        });
    }
});

/**
 * GET /api/metadata/countries
 * Populates frontend dropdowns for withdrawals and transfers.
 */
router.get('/countries', (req, res) => {
    const countries = [
        { name: "Nigeria", code: "NG", currency: "NGN", flag: "🇳🇬" },
        { name: "Ghana", code: "GH", currency: "GHS", flag: "🇬🇭" },
        { name: "Kenya", code: "KE", currency: "KES", flag: "🇰🇪" },
        { name: "United States", code: "US", currency: "USD", flag: "🇺🇸" },
        { name: "United Kingdom", code: "GB", currency: "GBP", flag: "🇬🇧" },
        { name: "Europe", code: "EU", currency: "EUR", flag: "🇪🇺" },
        { name: "Uganda", code: "UG", currency: "UGX", flag: "🇺🇬" },
        { name: "South Africa", code: "ZA", currency: "ZAR", flag: "🇿🇦" }
    ];
    res.json({ success: true, data: countries });
});

export default router;