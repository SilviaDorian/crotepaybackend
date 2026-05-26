const EMAILJS_SERVICE_ID = 'service_wx42dxx';
const EMAILJS_TEMPLATE_ID = 'template_8pbuyxc';
const EMAILJS_PUBLIC_KEY = 'MrFecWdsSnbLhfL9K';
const EMAILJS_PRIVATE_KEY = '-J8bRmT-323GS6gWkD-B_';

export async function sendAccessEmail(recipientEmail, voucherId, amount, currency, token) {
    const secureLink = `https://fielpay.com/success.html?v_id=${voucherId}&token=${token}`;
    
    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                service_id: EMAILJS_SERVICE_ID,
                template_id: EMAILJS_TEMPLATE_ID,
                user_id: EMAILJS_PUBLIC_KEY,
                accessToken: EMAILJS_PRIVATE_KEY, // EmailJS uses 'accessToken' for backend private key auth
                template_params: {
                    to_email: recipientEmail,
                    voucher_id: voucherId,
                    amount: amount,
                    currency: currency,
                    link: secureLink
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`EmailJS responded with ${response.status}: ${errorText}`);
        }
        
        console.log(`✅ Access email successfully sent to ${recipientEmail}`);
        return true;
    } catch (err) {
        console.error('❌ Email Service Error:', err.message);
        return false;
    }
}