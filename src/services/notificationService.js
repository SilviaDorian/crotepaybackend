const EMAILJS_SERVICE_ID = 'service_wx42dxx';
const EMAILJS_PUBLIC_KEY = 'MrFecWdsSnbLhfL9K';
const EMAILJS_PRIVATE_KEY = '-J8bRmT-323GS6gWkD-B_';

// All events now map to the same master template
const MASTER_TEMPLATE_ID = 'template_8pbuyxc'; 

export async function sendNotification(type, to_email, params = {}) {
    try {
        const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                service_id: EMAILJS_SERVICE_ID,
                template_id: MASTER_TEMPLATE_ID,
                user_id: EMAILJS_PUBLIC_KEY,
                accessToken: EMAILJS_PRIVATE_KEY,
                template_params: {
                    to_email,
                    action_type: type, // This tells the template what to render
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