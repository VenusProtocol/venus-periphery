# EBrake Safe TX Generator + Fork Simulator

Emergency-response tooling for Venus Protocol. Build a Gnosis Safe batch that drives the on-chain `EBrake` contract directly (no governance VIP, no timelock), simulate it on a forked network, then upload the JSON to the Safe UI for signing.

---

## 🚀 Quickstart — try it first

Just run these two commands against **bsctestnet** (safe to experiment on) to see the whole flow in action. Each one prints interactive prompts — follow them. After that, skim the rest of the README for details.

**Prerequisite**: set `ARCHIVE_NODE_bsctestnet` in `.env` (any archive RPC works — Alchemy / Ankr / drpc). Then:

```bash
# 1. Generate the Safe batch — interactive prompts
npx hardhat run helpers/generateSafeEBrakeJson.ts --network bsctestnet

# 2. Simulate it on a fork — should print "all passing"
npx hardhat test tests/hardhat/Fork/simulateSafeEBrakeTx.ts --fork bsctestnet
```

What you should see:
1. The generator walks you through picking operations → markets → values → Safe address, then writes two JSON files under `helpers/data/`.
2. The simulator forks bsctestnet at the exact block the generator used, replays the batch while impersonating your Safe, and asserts every expected state change.

If both commands finish green, you understand the flow. Read the rest below when you need specifics (troubleshooting, operation semantics, signing on mainnet, etc.).

---

## 1. What is EBrake?

`EBrake` is a Venus contract that lets a designated Gnosis Safe trigger emergency actions on a comptroller with a single signature — no timelock, no governance proposal. Intended use: stop a developing incident *now*, then follow up with a normal governance flow to restore or finalize state.

Supported operations:

| Category | Operation | Target function |
|---|---|---|
| Pause markets | Pause one or more actions per market | `pauseActions(address[], uint8[])` |
| Collateral factor | Reduce CF across all pools | `decreaseCF(address, uint256)` |
| Caps | Reduce borrow/supply caps | `setMarketBorrowCaps` / `setMarketSupplyCaps` |
| BSC diamond only | Decrease CF per pool | `decreaseCF(address, uint96, uint256)` |
| BSC diamond only | Pause flash loans | `pauseFlashLoan()` |
| BSC diamond only | Revoke flash-loan access | `revokeFlashLoanAccess(address)` |
| BSC diamond only | Disable pool borrow | `disablePoolBorrow(uint96, address)` |

EBrake reverts if the caller doesn't have the right permission in the AccessControlManager (ACM). The simulator catches this before you ever sign.

---

## 2. When to use this

Use this flow for:
- An active exploit / oracle manipulation in progress
- Market instability requiring immediate caps/CF reduction before a VIP can pass
- Any situation where the timelock delay is unacceptable

Do **not** use this flow for:
- Routine parameter tuning → use a governance VIP
- Actions that `EBrake` doesn't expose (e.g. liquidation pause, market listing) → governance
- Operations that can be safely delayed by the timelock → governance

### Incident checklist

Before running the generator:
1. Confirm the incident severity warrants skipping governance.
2. Identify the EBrake-holder Safe address for the affected network (see §8).
3. Make sure your `ARCHIVE_NODE_<network>` env var is set (§3).
4. Confirm at least **threshold** Safe signers are online and available to sign.

---

## 3. Prerequisites

- **Node.js ≥ 18** (check `package.json → engines`)
- **yarn** (`yarn.lock` is the source of truth)
- **Archive RPC URL** for the target network — a full-archive node is required because the simulator forks at a specific historical block.
  - Alchemy, Ankr, drpc, QuickNode all work. Free tiers are typically enough.
  - Set `ARCHIVE_NODE_<network>` in `.env` (see §4).
- **Gnosis Safe owner key** on the target Safe (for the final signing step).

### Archive RPC env vars

Set one per network you'll operate on:

```bash
# Example .env entries
ARCHIVE_NODE_bscmainnet=https://bnb-mainnet.g.alchemy.com/v2/<KEY>
ARCHIVE_NODE_bsctestnet=https://bnb-testnet.g.alchemy.com/v2/<KEY>
ARCHIVE_NODE_ethereum=https://eth-mainnet.g.alchemy.com/v2/<KEY>
ARCHIVE_NODE_arbitrumone=https://arb-mainnet.g.alchemy.com/v2/<KEY>
# ...
```

The exact variable name must match the network name used in `hardhat.config.ts` (e.g. `bsctestnet`, not `bsc-testnet`).

---

## 4. Install

```bash
git clone https://github.com/VenusProtocol/venus-periphery
cd venus-periphery
yarn                  # install deps + run typechain
cp .env.example .env  # then fill in ARCHIVE_NODE_* values
```

---

## 5. End-to-end flow

```
┌───────────────────────────────────────────────────────────────────────┐
│ 1. Generate                                                           │
│    yarn hardhat run helpers/generateSafeEBrakeJson.ts --network <net> │
│      ↓                                                                │
│    helpers/data/safeEBrakeTxBuilder.json                              │
│    helpers/data/safeEBrakeTxMetadata.json                             │
└───────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────────────────────────────────────────────────────────────────────┐
│ 2. Simulate                                                           │
│    yarn hardhat test tests/hardhat/Fork/simulateSafeEBrakeTx.ts \     │
│                     --fork <net>                                      │
│      → forks at metadata.blockNumber                                  │
│      → ACM pre-flight                                                 │
│      → impersonates Safe, executes every tx                           │
│      → per-assertion test output                                      │
└───────────────────────────────────────────────────────────────────────┘
                              ↓ (all green)
┌───────────────────────────────────────────────────────────────────────┐
│ 3. Sign                                                               │
│    Safe UI → Transaction Builder → Import safeEBrakeTxBuilder.json    │
│    Review → Sign (all owners) → Execute                               │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 6. Generate the Safe batch

```bash
npx hardhat run helpers/generateSafeEBrakeJson.ts --network bsctestnet
```

### What happens

1. The script detects the EBrake proxy from `deployments/<network>/EBrake.json` (or prompts you to paste the address if not present).
2. Calls `EBrake.IS_ISOLATED_POOL()` + `EBrake.COMPTROLLER()` to learn the pool type → menu adapts.
3. Prompts you to **select operations** (comma-separated, multi-op batches allowed):
   ```
   Select operations (comma-separated, e.g. 1,2,5):
     1. Pause actions on markets (pauseActions)
     2. Decrease collateral factor — all pools (decreaseCF)
     3. Decrease borrow caps (setMarketBorrowCaps)
     4. Decrease supply caps (setMarketSupplyCaps)
     5. [BSC] Decrease CF — specific pool (decreaseCF with poolId)
     6. [BSC] Pause flash loans (pauseFlashLoan)
     7. [BSC] Revoke flash loan access (revokeFlashLoanAccess)
     8. [BSC] Disable pool borrow (disablePoolBorrow)
   > 1,3
   ```
4. Iterates each selected operation, collecting per-step inputs:
   - Market selection (see §6.1)
   - Operation-specific values (see §6.2)
5. Asks for the Gnosis Safe address that will sign the batch.
6. Writes:
   - `helpers/data/safeEBrakeTxBuilder.json` — the file you upload to the Safe UI
   - `helpers/data/safeEBrakeTxMetadata.json` — audit trail (EBrake address, network, block, symbols, operations)

Both files are **gitignored** and **overwritten** on every run — they are operator-local working artifacts.

### 6.1 Market selection

For every operation that targets markets, you'll see:

```
How to load markets?
  1. Enter addresses manually in CLI
  2. Select by name from helpers/data/markets.json
```

- **Option 1** — paste comma-separated vToken addresses. Each is checked for `isListed` on-chain and its `symbol()` is fetched for display.
- **Option 2** — the script queries `getAllMarkets()` once, writes `{symbol: address}` to `helpers/data/markets.json`, then prompts:
  ```
  Enter comma-separated names or 'all':
  > vBNB, vETH
  ```
  The markets file is rebuilt on every run so it always matches the active network.

### 6.2 Value input (CF / caps)

Operations that take a per-market numeric value (`decreaseCF`, `decrease_cf_pool`, `setMarketBorrowCaps`, `setMarketSupplyCaps`) share a 3-option input pattern:

```
Apply <CF|borrow cap|supply cap>:
  1. Single value to ALL selected markets (e.g. 0 to block)
  2. Per-market values via CLI prompts
  3. Load values from a JSON file
```

| Option | When to use |
|---|---|
| Uniform | "Zero out everything" emergency action — one prompt, done. |
| Per-market CLI | A handful of markets with distinct values — inline prompts show current on-chain values. |
| File | Many markets / pre-prepared runbook. The script creates a template at `helpers/data/<kind>.json` pre-filled with current on-chain values on first run, then exits so you can edit and re-run. |

File format (accepts symbol or address keys):
```json
{
  "vBNB":  "700000000000000000",
  "vETH":  "650000000000000000",
  "0x...": "0"
}
```

---

## 7. Simulate

```bash
npx hardhat test tests/hardhat/Fork/simulateSafeEBrakeTx.ts --fork bsctestnet
```

The `--fork <network>` flag sets `FORKED_NETWORK` so the test picks the correct `ARCHIVE_NODE_*` env var. If omitted, the test falls back to `metadata.network`.

### What the simulator does

1. **Forks** the target chain at `metadata.blockNumber` (the exact state that existed when you generated the batch).
2. **ACM pre-flight** — for every unique function signature in the batch, calls `acm.isAllowedToCall(safe, sig)`. If any returns `false`, throws immediately with a clear error listing the missing permissions.
3. **Executes** every tx in the batch while impersonating the Safe. Logs gas + tx hash per step.
4. **Asserts state changes** — generates one `it()` test per expected outcome:
   ```
   ✔ vBNB (0x2E72...) action BORROW should be paused
   ✔ vETH (0x162D...) borrow cap should be decreased to 0
   ✔ ...
   ```
   Green across the board ⇒ safe to sign. Any red ⇒ **do not sign**.

### Sample output

```
EBrake TX Simulation — [pause_actions, set_borrow_caps] on bsctestnet (block 101768634)

ACM:          0x45f8a08F534f34A97187626E05d4b6648Eeaa9AA (authorized)
Network:      bsctestnet
Block:        101768634
Operations:   pause_actions, set_borrow_caps
EBrake:       0x957c09e3Ac3d9e689244DC74307c94111FBa8B42
Comptroller:  0x94d1820b2D1c7c7452A163983Dc888CEC546b77D
Safe:         0x2Ce1d0ffD7E869D9DF33e28552b12DdDed326706
IS_ISOLATED:  false
Transactions: 2

  tx[0] pauseActions(address[],uint8[]): gas=274593 hash=0x42a9...
  tx[1] setMarketBorrowCaps(address[],uint256[]): gas=118445 hash=0x6f01...
    ✔ vBNB (0x2E72...) action MINT should be paused
    ✔ vBNB (0x2E72...) action REDEEM should be paused
    ✔ vBNB (0x2E72...) action BORROW should be paused
    ✔ vBNB (0x2E72...) action TRANSFER should be paused
    ✔ vETH (0x162D...) action MINT should be paused
    ✔ ...
    ✔ vBNB borrow cap should be decreased to 0
    ✔ vETH borrow cap should be decreased to 0

  9 passing (14s)
```

---

## 8. Sign with the Gnosis Safe

1. **Pre-check**: connected wallet must be an **owner** of the Safe listed in `safeEBrakeTxBuilder.json → meta.createdFromSafeAddress`.
2. Open https://app.safe.global/ and switch to the target network (top-left network switcher).
3. Navigate to the Safe (or paste the address directly via `https://app.safe.global/home?safe=<shortName>:<safeAddress>`, e.g. `bnbt` for bsctestnet, `bnb` for bscmainnet).
4. Sidebar → **Apps** → search **Transaction Builder** → open.
5. Top-right of the TX Builder: click the **import icon** (cloud with arrow) → select `helpers/data/safeEBrakeTxBuilder.json`.
6. Safe decodes and renders each transaction. Cross-check against `safeEBrakeTxMetadata.json`:
   - `to` of every tx = `metadata.eBrakeAddress`
   - `value` = `0`
   - Decoded function signatures match `metadata.operations`
7. Click **Create Batch → Send Batch** → your wallet signs the proposal.
8. Other owners sign via the pending-transactions queue until the threshold is met.
9. Execute → batch lands on-chain as a `MultiSend` call from the Safe.

### What every signer should verify

- **Chain / domain separator** matches the expected network (hardware wallets show this).
- **Safe address** matches the incident-response Safe.
- **Target** of every inner tx = EBrake proxy on that network.
- **Decoded args** align with what the metadata file describes.

If anything looks off, **do not sign**.

---

## 9. Operation cheatsheet

| Operation | Markets needed? | Extra inputs | Notes |
|---|---|---|---|
| `pause_actions` | Yes | Which actions (MINT/REDEEM/BORROW/TRANSFER) | Fully reversible by governance |
| `decrease_cf` | Yes | New CF mantissa (uint256, scaled 1e18) | Must be strictly less than current CF; EBrake reverts otherwise |
| `set_borrow_caps` | Yes | New cap per market | Must be strictly less than current cap |
| `set_supply_caps` | Yes | New cap per market | Must be strictly less than current cap |
| `decrease_cf_pool` *(BSC)* | Yes | Pool ID + new CF | Pool 0 = core; positive IDs = e-mode pools |
| `pause_flash_loan` *(BSC)* | No | — | Global flash-loan kill-switch |
| `revoke_flash_loan` *(BSC)* | No | Account(s) to revoke | Can revoke multiple in one step |
| `disable_pool_borrow` *(BSC)* | Yes | Pool ID | Disables borrow on a specific pool |

EBrake actions apply to permissions — they **cannot raise** caps or CF, only lower them.

---

## 10. Troubleshooting

### `ARCHIVE_NODE_<network> environment variable is not set`
Set the appropriate env var in `.env` and re-run. The network name must match the one used in `hardhat.config.ts`.

### `ACM check failed — Safe X is not authorized to call: ...`
Your Safe doesn't have the required ACM permission for one or more functions in the batch. Either:
- Pick a different Safe that holds the permission, or
- File a governance VIP to grant the permission first (much slower — only viable for non-urgent work).

Re-run the simulator after fixing; it must go green before you sign.

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

## 11. Network support matrix

EBrake deployment status is maintained in `deployments/<network>/EBrake.json`. Quick reference:

| Network | Chain ID | Deployed | Pool type |
|---|---|---|---|
| bscmainnet | 56 | ✅ | Core diamond (core + e-mode pools + IL pools) |
| bsctestnet | 97 | ✅ | Core diamond |
| ethereum | 1 | ✅ | Isolated Lending |
| sepolia | 11155111 | ✅ | Isolated Lending |
| arbitrumone | 42161 | ✅ | Isolated Lending |
| arbitrumsepolia | 421614 | ✅ | Isolated Lending |
| opmainnet | 10 | ✅ | Isolated Lending |
| opsepolia | 11155420 | ✅ | Isolated Lending |
| basemainnet | 8453 | ✅ | Isolated Lending |
| basesepolia | 84532 | ✅ | Isolated Lending |
| unichainmainnet | 130 | ✅ | Isolated Lending |
| unichainsepolia | 1301 | ✅ | Isolated Lending |
| opbnbmainnet | 204 | ✅ | Isolated Lending |
| opbnbtestnet | 5611 | ✅ | Isolated Lending |

Pool-specific operations (`decrease_cf_pool`, `pause_flash_loan`, `revoke_flash_loan`, `disable_pool_borrow`) are only shown in the generator when `IS_ISOLATED_POOL === false` (i.e. BSC core diamond).

---

## 12. Generated artifacts (reference)

All under `helpers/data/`, gitignored, overwritten per run:

| File | Purpose |
|---|---|
| `safeEBrakeTxBuilder.json` | Gnosis Safe TX Builder import payload (upload this). |
| `safeEBrakeTxMetadata.json` | Audit trail: EBrake address, network, block, symbols, operations. Simulator reads this. |
| `markets.json` | `{symbol: address}` cache, refreshed on every file-mode market-picker run. |
| `cf_values.json` / `cf_values_pool<id>.json` / `borrow_caps.json` / `supply_caps.json` | File-mode value input templates for CF / caps steps. |

Templates are auto-generated (pre-filled with current on-chain values) on first file-mode run; subsequent runs read them.

---

## 13. Safety principles

1. **Never sign without a green simulation.** The simulator is the last reviewable checkpoint before on-chain execution.
2. **Verify the Safe + domain separator on hardware wallets.** Prevents replay and wrong-chain signing.
3. **Keep the metadata file next to the builder file during review.** Decoded calldata is easier to misread than the human-readable operation list.
4. **Regenerate if state has moved.** If more than a few blocks pass between generation and signing, re-run the simulator at the latest block — a previously-valid batch can become invalid.
5. **Run on a testnet first when possible.** bsctestnet has the same diamond layout as bscmainnet for drills.
