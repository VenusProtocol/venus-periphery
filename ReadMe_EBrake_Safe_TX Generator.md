# EBrake Safe TX Generator + Fork Simulator

Emergency-response tooling for Venus Protocol. Build a Gnosis Safe batch that drives the on-chain `EBrake` contract directly (no governance VIP, no timelock), simulate it on a forked network, then upload the JSON to the Safe UI for signing.

---

## Production — use this during an incident

### Prerequisites

- **Node.js ≥ 18** / **yarn**
- **`ARCHIVE_NODE_<network>`** set in `.env` — archive RPC for the target network (Alchemy / Ankr / drpc / QuickNode). Example:
  ```bash
  ARCHIVE_NODE_bscmainnet=https://bnb-mainnet.g.alchemy.com/v2/<KEY>
  ARCHIVE_NODE_ethereum=https://eth-mainnet.g.alchemy.com/v2/<KEY>
  # one per network you operate on — name must match hardhat.config.ts
  ```
- **Gnosis Safe owner key** on the incident-response Safe for the target network.

### Commands

```bash
# 1. Generate the Safe batch — interactive prompts walk you through operations / markets / values
npx hardhat run helpers/generateSafeEBrakeJson.ts --network <network>

# 2. (Optional) Simulate on a fork — asserts post-execution on-chain state
#    Safe Wallet has built-in simulation too; use this for a deeper state check when time allows
npx hardhat test scripts/simulateSafeEBrakeTx.ts --fork <network>

# 3. Sign
#    Safe UI → Apps → Transaction Builder → import helpers/data/safeEBrakeTxBuilder.json
#    Review decoded args against helpers/data/safeEBrakeTxMetadata.json, then sign + execute
```

Replace `<network>` with the target network name (e.g. `bscmainnet`, `ethereum`, `arbitrumone`). See the network support matrix below.

---

## 1. Troubleshooting

### `ARCHIVE_NODE_<network> environment variable is not set`

Set the appropriate env var in `.env` and re-run. The network name must match the one used in `hardhat.config.ts`.

### `No known hardfork for execution on historical block N in chain with id X`

Hardhat doesn't know the chain's hardfork timeline. Add the chain to the `networks.hardhat.chains` map in `hardhat.config.ts`:

```ts
chains: {
  <chainId>: { hardforkHistory: { cancun: 0 } },
  // ...
}
```

### `Markets file empty / missing entries for selected markets`

Occurs in file-mode for CF / caps inputs. Either:

- Delete the file and re-run (auto-regenerates a template with current on-chain values), or
- Manually add the missing `{symbol|address: value}` entries and re-run.

### `Symbol collision(s) detected`

Two vTokens on the same comptroller return identical `symbol()`. Rare; indicates a mis-configured market. Investigate manually — the generator refuses to build a markets file with ambiguous keys.

### Simulation passes, but on-chain execution reverts

Most likely: the chain state moved between generation and execution (e.g. someone else already paused one of the markets, so `pauseActions` is idempotent but `decreaseCF` reverts because `newCF >= currentCF` now). Regenerate the batch against the latest block and re-simulate.

---

## 2. Network support matrix

EBrake deployment status is maintained in `deployments/<network>/EBrake.json`. Quick reference:

| Network         | Chain ID | Deployed | Pool type                                     |
| --------------- | -------- | -------- | --------------------------------------------- |
| bscmainnet      | 56       | ✅       | Core diamond (core + e-mode pools + IL pools) |
| bsctestnet      | 97       | ✅       | Core diamond                                  |
| ethereum        | 1        | ✅       | Isolated Lending                              |
| sepolia         | 11155111 | ✅       | Isolated Lending                              |
| arbitrumone     | 42161    | ✅       | Isolated Lending                              |
| arbitrumsepolia | 421614   | ✅       | Isolated Lending                              |
| basemainnet     | 8453     | ✅       | Isolated Lending                              |
| basesepolia     | 84532    | ✅       | Isolated Lending                              |

Pool-specific operations (`decrease_cf_pool`, `pause_flash_loan`, `revoke_flash_loan`, `disable_pool_borrow`) are only shown in the generator when `IS_ISOLATED_POOL === false` (i.e. BSC core diamond).

---

## 3. Generated artifacts

All under `helpers/data/`, gitignored, overwritten per run:

| File                                                                                   | Purpose                                                                                 |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `safeEBrakeTxBuilder.json`                                                             | Gnosis Safe TX Builder import payload (upload this).                                    |
| `safeEBrakeTxMetadata.json`                                                            | Audit trail: EBrake address, network, block, symbols, operations. Simulator reads this. |
| `cf_values.json` / `cf_values_pool<id>.json` / `borrow_caps.json` / `supply_caps.json` | File-mode value input templates for CF / caps steps.                                    |

Templates are auto-generated (pre-filled with current on-chain values) on first file-mode run; subsequent runs read them.

---

## 4. Safety principles

1. **Simulate before signing when time allows.** Safe Wallet's built-in simulation checks for reverts; the hardhat simulator additionally asserts post-execution state. Use at least one before signing.
2. **Verify the Safe + domain separator on hardware wallets.** Prevents replay and wrong-chain signing.
3. **Keep the metadata file next to the builder file during review.** Decoded calldata is easier to misread than the human-readable operation list.
4. **Regenerate if state has moved.** If more than a few blocks pass between generation and signing, re-run the simulator at the latest block — a previously-valid batch can become invalid.
5. **Run on a testnet first when possible.** bsctestnet has the same diamond layout as bscmainnet for drills.

---

## 5. What is EBrake?

`EBrake` is a Venus contract that lets a designated Gnosis Safe trigger emergency actions on a comptroller with a single signature — no timelock, no governance proposal. Intended use: stop a developing incident _now_, then follow up with a normal governance flow to restore or finalize state.

Supported operations:

| Category          | Operation                            | Target function                               |
| ----------------- | ------------------------------------ | --------------------------------------------- |
| Pause markets     | Pause one or more actions per market | `pauseActions(address[], uint8[])`            |
| Collateral factor | Reduce CF across all pools           | `decreaseCF(address, uint256)`                |
| Caps              | Reduce borrow/supply caps            | `setMarketBorrowCaps` / `setMarketSupplyCaps` |
| BSC diamond only  | Decrease CF per pool                 | `decreaseCF(address, uint96, uint256)`        |
| BSC diamond only  | Pause flash loans                    | `pauseFlashLoan()`                            |
| BSC diamond only  | Revoke flash-loan access             | `revokeFlashLoanAccess(address)`              |
| BSC diamond only  | Disable pool borrow                  | `disablePoolBorrow(uint96, address)`          |

EBrake reverts if the caller doesn't have the right permission in the AccessControlManager (ACM).
