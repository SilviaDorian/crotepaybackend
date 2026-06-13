// run-worker.js  (place this in the ROOT of your project)
import { processBulkEscrowFunding } from './src/controllers/bulkSettlementWorker.js';

async function main() {
    const batchRef = "BATCH-1781345883037-1952";   // Change this if testing a different batch

    console.log(`🚀 Running worker for batch: ${batchRef}`);
    
    try {
        await processBulkEscrowFunding(batchRef);
        console.log("✅ Worker finished successfully!");
    } catch (err) {
        console.error("❌ Worker failed:", err);
    }
    
    process.exit(0);
}

main();