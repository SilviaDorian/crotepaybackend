// utils/notifications.js
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Configure VAPID
webpush.setVapidDetails(
    'mailto:fielpayservices@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

async function notifyUser(userEmail, message) {
    const { data, error } = await supabase
        .from('subscriptions')
        .select('subscription_data')
        .eq('email', userEmail)
        .single();

    if (data) {
        try {
            const payload = JSON.stringify({ title: 'FielPay Update', body: message });
            await webpush.sendNotification(data.subscription_data, payload);
        } catch (err) {
            if (err.statusCode === 410) {
                await supabase.from('subscriptions').delete().eq('email', userEmail);
            }
        }
    }
}

module.exports = { notifyUser };