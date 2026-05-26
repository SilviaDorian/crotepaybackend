import fetch from 'node-fetch'; // Ensure you have node-fetch installed

const EMAILJS_SERVICE_ID = 'service_wx42dxx';
const EMAILJS_TEMPLATE_ID = 'template_8pbuyxc';
const EMAILJS_PRIVATE_KEY = '-J8bRmT-323GS6gWkD-B_'; // This is actually the Private Key needed for server-side

export async function sendAccessEmail(recipientEmail, voucherId, amount, currency, token) {
    const secureLink = `https://fielpay.com/success.html?v_id=${voucherId}&token=${token}`;
    
    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: EMAILJS_SERVICE_ID,
                template_id: EMAILJS_TEMPLATE_ID,
                user_id: EMAILJS_PRIVATE_KEY, // Note: Use your API Key here
                template_params: {
                    to_email: recipientEmail,
                    voucher_id: voucherId,
                    amount: amount,
                    currency: currency,
                    link: secureLink
                }
            })
        });

        if (!response.ok) throw new Error('Failed to send email');
        console.log(`✅ Access email sent to ${recipientEmail}`);
    } catch (err) {
        console.error('❌ Email Service Error:', err.message);
    }
}