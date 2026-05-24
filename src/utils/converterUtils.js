import axios from 'axios';

export async function getLiveRate(from, to, amount) {
    try {
        const response = await axios.get(
            `https://api.flutterwave.com/v3/rates?from=${from}&to=${to}&amount=${amount || 1}`,
            { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
        );

        // Safety: Log the response in development to verify the path
        // console.log("Flutterwave Rate Response:", response.data);

        // Check if the expected path exists
        const rate = response.data?.data?.rate;
        
        if (rate === undefined) {
            throw new Error("Rate path not found in response");
        }

        return Number(rate);
    } catch (error) {
        console.error("getLiveRate Error:", error.message);
        throw error; // Let the route handler catch this
    }
}