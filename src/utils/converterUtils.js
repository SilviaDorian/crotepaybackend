import axios from 'axios';

// Helper to get real Flutterwave rate
export async function getLiveRate(from, to, amount) {
    const response = await axios.post(
        'https://api.flutterwave.com/v3/transfers/rates',
        { source_currency: from, destination_currency: to, amount: amount || 1 },
        { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );
    return Number(response.data?.data?.rate);
}