// Single entry point -- run all PendlePTVaultAdapter fork tests with:
//   FORKED_NETWORK=bscmainnet npx hardhat test tests/hardhat/Fork/pendlePTVaultAdapter/index.spec.ts --network hardhat
//
// Uses a single forking() call to avoid multiple hardhat_reset invocations
// which would invalidate loadFixture snapshots across spec files.

import { FORK_MAINNET, forking } from "../utils";
import { BLOCK_NUMBER } from "./utils/constants";

// Signal to spec files that they are being loaded from the index runner.
// Each spec file checks this flag and skips its own forking() wrapper.
(global as any).__PENDLE_INDEX_RUNNING = true;

if (FORK_MAINNET) {
  forking(BLOCK_NUMBER, () => {
    // Dynamic require inside forking() callback so spec files register
    // their describe blocks in this single forking context.
    require("./tests/admin.spec");
    require("./tests/deposit.spec");
    require("./tests/withdraw.spec");
    require("./tests/redeemAtMaturity.spec");
    require("./tests/viewFunctions.spec");
  });
}
