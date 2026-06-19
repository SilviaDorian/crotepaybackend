const EMAILJS_SERVICE_ID = 'service_wx42dxx';
const EMAILJS_PUBLIC_KEY = 'MrFecWdsSnbLhfL9K';
const EMAILJS_PRIVATE_KEY = '-J8bRmT-323GS6gWkD-B_';

// All events now map to the same master template
const MASTER_TEMPLATE_ID = 'template_8pbuyxc'; 

export async function sendNotification(type, to_email, params = {}) {
    // Generate boolean flags based on the type to avoid complex helper logic in EmailJS
    const template_params = {
        to_email,
        action_type_WELCOME: type === 'WELCOME',
        action_type_VOUCHER_LOCKED: type === 'VOUCHER_LOCKED',
        action_type_VOUCHER_RELEASED: type === 'VOUCHER_RELEASED',
        action_type_PASSWORD_RESET: type === 'PASSWORD_RESET',
        ...params // dynamically spreads: link, full_name, voucher_ref, amount, currency, etc.
    };

    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: EMAILJS_SERVICE_ID,
                template_id: MASTER_TEMPLATE_ID,
                user_id: EMAILJS_PUBLIC_KEY,
                accessToken: EMAILJS_PRIVATE_KEY,
                template_params: template_params
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`EmailJS failed: ${errorText}`);
        }
        
        console.log(`✅ Notification (${type}) sent to ${to_email}`);
        return true;
    } catch (err) {
        console.error(`❌ Notification Error (${type}):`, err.message);
        return false;
    }
}