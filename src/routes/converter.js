import express from 'express';
import axios from 'axios';

const router = express.Router();

const CONVERSION_FEE_PERCENT = 0.008; // 0.8%
const CACHE_DURATION = 10 * 60 * 1000;

const rateCache = new Map();

/**
 * ============================================
 * GET EXCHANGE RATE
 * ============================================
 */
async function getExchangeRate(from, to, amount = 1) {

    const cacheKey = `${from}_${to}`;

    const cached = rateCache.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.timestamp < CACHE_DURATION
    ) {
        return cached.rate;
    }

    try {

        const response = await axios.post(
            'https://api.flutterwave.com/v3/transfers/rates',
            {
                source_currency: from,
                destination_currency: to,
                amount
            },
            {
                headers: {
                    Authorization:
                        `Bearer ${process.env.FLW_SECRET_KEY}`
                }
            }
        );

        const rate = Number(
            response.data?.data?.rate
        );

        if (!rate) {
            throw new Error('Rate unavailable');
        }

        rateCache.set(cacheKey, {
            rate,
            timestamp: Date.now()
        });

        return rate;

    } catch (err) {

        console.error(err.message);

        throw new Error('Failed to fetch rate');
    }
}

/**
 * ============================================
 * PREVIEW CONVERSION
 * ============================================
 */
router.get('/preview', async (req, res) => {

    try {

        const {
            amount,
            from,
            to
        } = req.query;

        const numericAmount = Number(amount);

        if (!numericAmount || numericAmount <= 0) {
            return res.status(400).json({
                message:'Invalid amount'
            });
        }

        const fee =
            numericAmount *
            CONVERSION_FEE_PERCENT;

        const amountAfterFee =
            numericAmount - fee;

        const rate =
            await getExchangeRate(
                from,
                to,
                amountAfterFee
            );

        const convertedAmount =
            Number(
                (
                    amountAfterFee * rate
                ).toFixed(2)
            );

        return res.json({
            amount:numericAmount,
            fee,
            amountAfterFee,
            rate,
            convertedAmount
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            message:err.message
        });
    }
});

/**
 * ============================================
 * PROCESS CONVERSION
 * ============================================
 */
router.post('/convert', async (req, res) => {

    try {

        const {
            email,
            amount,
            fromCurrency,
            toCurrency
        } = req.body;

        const numericAmount = Number(amount);

        if (!numericAmount || numericAmount <= 0) {
            return res.status(400).json({
                message:'Invalid amount'
            });
        }

        if (fromCurrency === toCurrency) {
            return res.status(400).json({
                message:'Currencies cannot match'
            });
        }

        /**
         * ====================================
         * FETCH USER WALLETS
         * ====================================
         */

        const walletResponse = await axios.get(
            `${process.env.API_BASE_URL}/history/wallets?email=${email}`
        );

        const wallets = walletResponse.data;

        /**
         * SOURCE WALLET
         */

        const sourceWallet =
            wallets.find(
                w =>
                    w.currency === fromCurrency
            );

        if (!sourceWallet) {

            return res.status(404).json({
                message:
                    `${fromCurrency} wallet not found`
            });
        }

        /**
         * BALANCE CHECK
         */

        if (
            Number(sourceWallet.available_balance)
            < numericAmount
        ) {

            return res.status(400).json({
                message:'Insufficient balance'
            });
        }

        /**
         * CONVERSION CALCULATIONS
         */

        const fee =
            numericAmount *
            CONVERSION_FEE_PERCENT;

        const amountAfterFee =
            numericAmount - fee;

        const rate =
            await getExchangeRate(
                fromCurrency,
                toCurrency,
                amountAfterFee
            );

        const convertedAmount =
            Number(
                (
                    amountAfterFee * rate
                ).toFixed(2)
            );

        /**
         * ====================================
         * UPDATE SOURCE WALLET
         * ====================================
         */

        await axios.post(
            `${process.env.API_BASE_URL}/wallet/update`,
            {
                email,
                currency: fromCurrency,
                available_balance:
                    Number(
                        sourceWallet.available_balance
                    ) - numericAmount
            }
        );

        /**
         * ====================================
         * DESTINATION WALLET
         * ====================================
         */

        let destinationWallet =
            wallets.find(
                w =>
                    w.currency === toCurrency
            );

        /**
         * CREATE DESTINATION WALLET
         */

        if (!destinationWallet) {

            await axios.post(
                `${process.env.API_BASE_URL}/wallet/create`,
                {
                    email,
                    currency: toCurrency
                }
            );

            destinationWallet = {
                available_balance:0
            };
        }

        /**
         * CREDIT DESTINATION
         */

        await axios.post(
            `${process.env.API_BASE_URL}/wallet/update`,
            {
                email,
                currency: toCurrency,
                available_balance:
                    Number(
                        destinationWallet.available_balance || 0
                    ) + convertedAmount
            }
        );

        /**
         * ====================================
         * SAVE TRANSACTION
         * ====================================
         */

        await axios.post(
            `${process.env.API_BASE_URL}/transactions/create`,
            {
                email,

                type:'CONVERSION',

                status:'SUCCESS',

                from_currency:fromCurrency,

                to_currency:toCurrency,

                source_amount:numericAmount,

                destination_amount:convertedAmount,

                fee,

                rate,

                created_at:
                    new Date().toISOString()
            }
        );

        /**
         * ====================================
         * OPTIONAL FLUTTERWAVE TRANSFER
         * ====================================
         */

        let flutterwaveTransfer = null;

        try {

            const flw =
                await axios.post(
                    'https://api.flutterwave.com/v3/transfers',
                    {
                        account_bank:'flutterwave',

                        amount:convertedAmount,

                        currency:toCurrency,

                        narration:
                            `${fromCurrency} to ${toCurrency} conversion`,

                        reference:
                            `conv_${Date.now()}`
                    },
                    {
                        headers:{
                            Authorization:
                                `Bearer ${process.env.FLW_SECRET_KEY}`
                        }
                    }
                );

            flutterwaveTransfer =
                flw.data;

        } catch (err) {

            console.error(
                'Flutterwave Transfer Failed:',
                err.message
            );
        }

        /**
         * SUCCESS RESPONSE
         */

        return res.json({

            success:true,

            conversion:{
                amount:numericAmount,
                fee,
                amountAfterFee,
                rate,
                convertedAmount
            },

            flutterwaveTransfer
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success:false,
            message:err.message
        });
    }
});

export default router;