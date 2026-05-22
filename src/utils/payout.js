import axios from 'axios';

/**
 * Triggers the bank payout via Flutterwave.
 * Handles African local transfers, International wire payouts, and Cross-Currency conversions.
 */
export const triggerBankTransfer = async (details) => {
    const { 
        amount, 
        sourceCurrency, 
        targetCurrency, 
        bankCode, 
        accountNumber, 
        reference, 
        isInternational, 
        wirePayload 
    } = details;

    try {
        let finalPayoutAmount = amount;
        let appliedRate = 1.0;

        // --- 1. SMART ROUTING: Only convert if source and target differ ---
        if (sourceCurrency !== targetCurrency) {
            console.log(`[PAYOUT] FX detected: Converting ${amount} ${sourceCurrency} to ${targetCurrency}`);
            
            // Fetch the official live rate from Flutterwave to ensure zero-loss execution
            const rateUrl = `https://api.flutterwave.com/v3/transfers/rates?amount=${amount}&destination_currency=${targetCurrency}&source_currency=${sourceCurrency}`;
            
            const rateResponse = await axios.get(rateUrl, {
                headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
            });

            if (rateResponse.data && rateResponse.data.data) {
                finalPayoutAmount = rateResponse.data.data.destination_amount;
                appliedRate = rateResponse.data.data.rate;
            } else {
                throw new Error("Could not fetch internal FX rate from Flutterwave.");
            }
        } else {
            console.log(`[PAYOUT] Native Lane: Sending ${amount} ${targetCurrency} directly.`);
        }

        // --- 2. PAYLOAD BUILDER: Split Local vs International Wiring Structures ---
        let flwPayload = {};

        if (isInternational && wirePayload) {
            console.log(`[PAYOUT] Processing International Wire payload for Ref: ${reference}`);
            
            // Standard formatting required by Flutterwave for SWIFT/Wire distributions
            flwPayload = {
                account_bank: '000', // Constant formatting fallback required by FLW for wire channels
                account_number: wirePayload.account_number,
                amount: finalPayoutAmount,
                currency: targetCurrency,
                debit_currency: sourceCurrency,
                narration: `FielPay Global Settlement Ref: ${reference}`,
                reference: reference,
                beneficiary_name: wirePayload.beneficiary_name,
                callback_url: `${process.env.BASE_URL}/api/webhooks/flutterwave`,
                meta: [
                    { first_name: wirePayload.beneficiary_name.split(' ')[0] || 'Client' },
                    { last_name: wirePayload.beneficiary_name.split(' ')[1] || 'User' },
                    { beneficiary_address: wirePayload.beneficiary_address },
                    { beneficiary_country: wirePayload.beneficiary_country },
                    { swift_code: wirePayload.swift_code },
                    { bank_name: wirePayload.bank_name }
                ]
            };

            // Conditionally append routing number for US/CA distributions if present
            if (wirePayload.routing_number) {
                flwPayload.meta.push({ routing_number: wirePayload.routing_number });
            }

        } else {
            console.log(`[PAYOUT] Processing African Local payload for Ref: ${reference}`);
            
            // Traditional localized configuration payload
            flwPayload = {
                account_bank: bankCode,
                account_number: accountNumber,
                amount: finalPayoutAmount,
                currency: targetCurrency,
                debit_currency: sourceCurrency,
                reference: reference,
                narration: `FielPay Payout Ref: ${reference}`,
                callback_url: `${process.env.BASE_URL}/api/webhooks/flutterwave`
            };
        }

        // --- 3. EXECUTE TRANSFER ---
        const response = await axios.post(
            'https://api.flutterwave.com/v3/transfers',
            flwPayload,
            {
                headers: { 
                    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // --- 4. RETURN STANDARDIZED DATA OBJECT ---
        return {
            success: true,
            flw_id: response.data?.data?.id,
            applied_rate: appliedRate,
            local_amount: finalPayoutAmount,
            source_amount: amount,
            source_currency: sourceCurrency
        };

    } catch (error) {
        const flwError = error.response?.data?.message || error.message;
        console.error("❌ Transfer Execution Error:", flwError);
        throw new Error(`Payout failed: ${flwError}`);
    }
};

export default { triggerBankTransfer };