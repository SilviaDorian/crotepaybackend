const EMAILJS_SERVICE_ID = 'service_wx42dxx';
const EMAILJS_PUBLIC_KEY = 'MrFecWdsSnbLhfL9K';
const EMAILJS_PRIVATE_KEY = '-J8bRmT-323GS6gWkD-B_';

// Mapping types to specific EmailJS Template IDs
const TEMPLATE_MAP = {
    REGISTRATION: 'template_reg',
    VOUCHER_CREATED: 'template_voucher_new',
    FUNDS_MOVED: 'template_funds_moved',
    WITHDRAWAL: 'template_withdrawal',
    CONVERSION: 'template_conversion'
};

export async function sendNotification(type, to_email, params = {}) {
    const template_id = TEMPLATE_MAP[type];
    
    if (!template_id) {
        console.error(`❌ Notification type ${type} not supported.`);
        return false;
    }

    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: EMAILJS_SERVICE_ID,
                template_id: template_id,
                user_id: EMAILJS_PUBLIC_KEY,
                accessToken: EMAILJS_PRIVATE_KEY,
                template_params: {
                    to_email,
                    ...params
                }
            })
        });

        if (!response.ok) throw new Error(`EmailJS failed: ${await response.text()}`);
        
        console.log(`✅ Notification (${type}) sent to ${to_email}`);
        return true;
    } catch (err) {
        console.error(`❌ Notification Error (${type}):`, err.message);
        return false;
    }
}