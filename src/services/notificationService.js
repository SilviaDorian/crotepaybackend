const EMAILJS_SERVICE_ID = 'service_wx42dxx';
const EMAILJS_PUBLIC_KEY = 'MrFecWdsSnbLhfL9K';
const EMAILJS_PRIVATE_KEY = '-J8bRmT-323GS6gWkD-B_';
const MASTER_TEMPLATE_ID = 'template_8pbuyxc';

const EMAIL_CONFIG = {
    WELCOME: {
        title: 'Welcome to FielPay!',
        getMessage: p => `Hi ${p.full_name}, your account has been successfully created.`,
        getDetails: () => '',
        getButton: p => `<a href="${p.cta_link || '#'}" class="btn">Get Started</a>`
    },
    PASSWORD_RESET: {
        title: 'Reset your password',
        getMessage: () => 'We received a request to reset your password. If this was not you, please ignore this email.',
        getDetails: () => '',
        getButton: p => `<a href="${p.cta_link || '#'}" class="btn">Reset Password</a>`
    },
    VOUCHER_LOCKED: {
        title: 'Payment Secured',
        getMessage: () => 'Your transaction has been verified and funds are now safely held in FielPay Escrow.',
        getDetails: p => `
            <table style="width:100%; border-collapse:collapse; margin:25px 0;">
                <tr><td style="color:#717E84; font-weight:600; padding:10px 0;">Voucher ID</td><td style="font-weight:800; text-align:right;">${p.voucher_ref || 'N/A'}</td></tr>
                <tr><td style="color:#717E84; font-weight:600; padding:10px 0;">Amount</td><td style="font-weight:800; text-align:right;">${p.currency || ''} ${p.amount || '0'}</td></tr>
            </table>`,
        getButton: p => `<a href="${p.cta_link || '#'}" class="btn">Access Secure Vault</a>`
    },
    VOUCHER_RELEASED: {
        title: 'Funds Released',
        getMessage: p => `The funds for voucher ${p.voucher_ref || ''} have been successfully released.`,
        getDetails: p => `
            <table style="width:100%; border-collapse:collapse; margin:25px 0;">
                <tr><td style="color:#717E84; font-weight:600; padding:10px 0;">Voucher ID</td><td style="font-weight:800; text-align:right;">${p.voucher_ref || 'N/A'}</td></tr>
                <tr><td style="color:#717E84; font-weight:600; padding:10px 0;">Amount</td><td style="font-weight:800; text-align:right;">${p.currency || ''} ${p.amount || '0'}</td></tr>
            </table>`,
        getButton: () => ''
    }
};

export async function sendNotification(type, to_email, params = {}) {
    const config = EMAIL_CONFIG[type] || { 
        title: 'FielPay Notification', 
        getMessage: () => 'You have received a new notification.',
        getDetails: () => '',
        getButton: () => ''
    };

    const template_params = {
        to_email,
        title: config.title,
        message: config.getMessage(params),
        details: config.getDetails(params),
        button: config.getButton(params),
        ...params 
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
                template_params
            })
        });

        if (!response.ok) throw new Error(await response.text());
        return true;
    } catch (err) {
        console.error(`❌ Notification Error (${type}):`, err.message);
        return false;
    }
}