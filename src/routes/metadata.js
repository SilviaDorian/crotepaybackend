const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/rates', async (req, res) => {
    try {
        const target = req.query.target || 'USD';
        const apiKey = process.env.EXCHANGERATE_API_KEY;
        
        // Calling the External Exchange Rate API
        const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${target}`;
        const response = await axios.get(url);

        if (response.data.result === "success") {
            res.json({
                base: target,
                rates: response.data.conversion_rates,
                timestamp: response.data.time_last_update_unix
            });
        } else {
            throw new Error("Failed to fetch from Exchange Rate API");
        }
    } catch (error) {
        console.error("Exchange Rate Error:", error.message);
        res.status(500).json({ error: "Could not retrieve exchange rates" });
    }
});

module.exports = router;