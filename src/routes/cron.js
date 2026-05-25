import express from 'express';
import { runSettlementLogic } from '../jobs/reconciliation.js';

const router = express.Router();

router.get('/reconcile', async (req, res) => {
    // SECURITY: Only allow Vercel to trigger this
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send("Unauthorized");
    }

    await runSettlementLogic();
    res.status(200).send("Reconciliation complete");
});

export default router;