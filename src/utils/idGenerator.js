import crypto from 'crypto';

export const generateVoucherId = () => `VC-${crypto.randomInt(100000, 999999)}`;
export const generateToken = () => crypto.randomBytes(32).toString('hex');
export const generateKey = () => crypto.randomBytes(8).toString('hex');
export const generateBatchRef = () => `BATCH-${Date.now()}-${crypto.randomInt(1000, 9999)}`;