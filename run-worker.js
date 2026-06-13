// run-worker.js
import { processBulkEscrowFunding } from './services/bulksettlementworker.js'; // ← Change path if needed

async function main() {
    const batchRef = "BATCH-1781345883037-1952";   // ← Change if testing another batch

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