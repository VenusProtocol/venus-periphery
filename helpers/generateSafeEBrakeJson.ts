/**
 * generateSafeEBrakeJson.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates a Gnosis Safe TX Builder JSON for emergency actions via EBrake.
 * The Safe calls EBrake directly — no governance VIP or timelock involved.
 * One signature is enough to trigger the action immediately.
 *
 * USAGE
 * ─────
 * npx hardhat run helpers/generateSafeEBrakeJson.ts --network <network>
 *
 * Examples:
 *   npx hardhat run helpers/generateSafeEBrakeJson.ts --network bscmainnet
 *   npx hardhat run helpers/generateSafeEBrakeJson.ts --network ethereum
 *   npx hardhat run helpers/generateSafeEBrakeJson.ts --network arbitrumone
 *
 * SUPPORTED NETWORKS
 * ──────────────────
 * Any network configured in hardhat.config.ts with a live RPC endpoint.
 * The EBrake proxy address is auto-detected from deployments/<network>/EBrake.json
 * if it exists; otherwise you will be prompted to enter it manually.
 *
 * OPERATIONS
 * ──────────
 *   All chains:
 *     - Pause actions on markets         (pauseActions)
 *     - Decrease collateral factor       (decreaseCF — all pools)
 *     - Decrease borrow caps             (setMarketBorrowCaps)
 *     - Decrease supply caps             (setMarketSupplyCaps)
 *
 *   BSC mainnet only (Diamond comptroller):
 *     - Decrease CF for a specific pool  (decreaseCF with poolId)
 *     - Pause flash loans                (pauseFlashLoan)
 *     - Revoke flash loan access         (revokeFlashLoanAccess)
 *     - Disable pool borrow              (disablePoolBorrow)
 *
 * Multiple operations can be batched in a single run (e.g. pause + decrease CF).
 *
 * OUTPUT
 * ──────
 * Written to helpers/data/ (gitignored, overwritten on every run):
 *   safeEBrakeTxBuilder.json   — import this into the Gnosis Safe TX Builder UI
 *   safeEBrakeTxMetadata.json  — audit trail (EBrake address, network, block, symbols, operations)
 *   cf_values.json / cf_values_pool<id>.json / borrow_caps.json / supply_caps.json
 *                              — per-market value templates (file-mode input for CF / caps steps)
 *
 * You will be prompted for the Safe address that should sign the transaction.
 */
import type { BigNumber } from "ethers";
import * as fs from "fs";
import { ethers, network } from "hardhat";
import * as path from "path";
import * as readline from "readline";

// ─── Terminal colors ─────────────────────────────────────────────────────────

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const colorWrap =
  (code: string) =>
  (s: string): string =>
    colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;
const red = colorWrap("31");
const green = colorWrap("32");
const yellow = colorWrap("33");
const cyan = colorWrap("36");
const bold = colorWrap("1");

// ─── Retry helper ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function retry<T = any>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        console.log(`  RPC call failed (attempt ${attempt}/${retries}), retrying in ${delayMs / 1000}s...`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(__dirname, "data");

const EBRAKE_ABI = [
  "function IS_ISOLATED_POOL() view returns (bool)",
  "function COMPTROLLER() view returns (address)",
  "function pauseActions(address[],uint8[])",
  "function pauseSupply(address)",
  "function pauseRedeem(address)",
  "function pauseBorrow(address)",
  "function pauseTransfer(address)",
  "function pauseFlashLoan()",
  "function disablePoolBorrow(uint96,address)",
  "function revokeFlashLoanAccess(address)",
  "function decreaseCF(address,uint256)",
  "function decreaseCF(address,uint96,uint256)",
  "function setMarketBorrowCaps(address[],uint256[])",
  "function setMarketSupplyCaps(address[],uint256[])",
];

// ABIs used for on-chain queries (current CF / caps display)
const BSC_COMPTROLLER_QUERY_ABI = [
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function poolMarkets(uint96,address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function corePoolId() view returns (uint96)",
  "function lastPoolId() view returns (uint96)",
  "function borrowCaps(address) view returns (uint256)",
  "function supplyCaps(address) view returns (uint256)",
];

const IL_COMPTROLLER_QUERY_ABI = [
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  "function borrowCaps(address) view returns (uint256)",
  "function supplyCaps(address) view returns (uint256)",
];

// Only MINT, REDEEM, BORROW, TRANSFER are allowed by EBrake (REPAY/SEIZE/LIQUIDATE are forbidden)
const ALLOWED_PAUSE_ACTIONS: Record<string, number> = {
  MINT: 0,
  REDEEM: 1,
  BORROW: 2,
  TRANSFER: 6,
};

// ─── Safe TX Builder JSON ────────────────────────────────────────────────────

const buildSafeBatch = (
  safeAddress: string,
  transactions: { to: string; value: string; data: string }[],
  chainId: number,
  blockNumber: number,
): object => {
  const createdAt = Date.now();
  const txs = transactions.map(tx => ({
    to: tx.to,
    value: tx.value,
    data: tx.data,
    contractMethod: null,
    contractInputsValues: null,
  }));
  const metaBase = {
    name: "Transactions Batch",
    description: "",
    txBuilderVersion: "1.8.0",
    createdFromSafeAddress: safeAddress,
    createdFromOwnerAddress: "",
  };
  // Checksum matches the format expected by the Safe TX Builder UI
  const checksum = ethers.utils.id(
    JSON.stringify({ version: "1.0", chainId: chainId.toString(), createdAt, meta: metaBase, transactions: txs }),
  );
  return {
    version: "1.0",
    chainId: chainId.toString(),
    createdAt,
    meta: { ...metaBase, checksum },
    transactions: txs,
    blockNumber,
  };
};

// ─── Types ───────────────────────────────────────────────────────────────────

type EBrakeOperation =
  | "pause_actions"
  | "decrease_cf"
  | "decrease_cf_pool"
  | "set_borrow_caps"
  | "set_supply_caps"
  | "pause_flash_loan"
  | "revoke_flash_loan"
  | "disable_pool_borrow";

export interface EBrakeCommand {
  signature: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any[];
}

export interface EBrakeStep {
  operation: EBrakeOperation;
  marketAddresses: string[];
  symbols: Map<string, string>;
  pauseActions?: number[];
  newCFs?: Map<string, string>; // per-market CF mantissa (decrease_cf)
  // decrease_cf_pool: per (market, poolId) CF mantissa — a market listed in multiple
  // pools can take a different new CF per pool.
  newCFsByPool?: Map<string, Map<number, string>>;
  // For decrease_cf_pool + disable_pool_borrow: every pool each market is listed in.
  // commandsForStep fans out one tx per (market, pool) pair.
  poolIdsByMarket?: Map<string, number[]>;
  newCaps?: Map<string, string>;
  revokeAccounts?: string[];
}

export interface EBrakeBatchInput {
  eBrakeAddress: string;
  comptrollerAddress: string;
  isIsolatedPool: boolean;
  network: string;
  chainId: number;
  safeAddress: string;
  blockNumber: number;
  steps: EBrakeStep[];
}

interface EBrakeMetadata {
  eBrakeAddress: string;
  comptrollerAddress: string;
  network: string;
  operations: EBrakeOperation[];
  blockNumber: number;
  createdAt: string;
  symbols: Record<string, string>;
}

export interface ExportResult {
  txBuilderFile: string;
  metadataFile: string;
  txCount: number;
  safeAddress: string;
}

// ─── CLI helpers ─────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (question: string): Promise<string> =>
  new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));

const pickOne = async (prompt: string, options: string[]): Promise<string> => {
  console.log(`\n${prompt}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("Enter number: ");
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx];
    }
    console.log(red(`Invalid selection "${answer}". Please enter a number between 1 and ${options.length}.`));
  }
};

const pickMultiple = async (
  prompt: string,
  options: { name: string; value: string }[],
  { allowAll = true, preserveOrder = false }: { allowAll?: boolean; preserveOrder?: boolean } = {},
): Promise<string[]> => {
  console.log(`\n${prompt}`);
  options.forEach(opt => console.log(`  ${opt.value}. ${opt.name}`));
  const validValues = new Set(options.map(o => o.value));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log(allowAll ? "Enter comma-separated values or 'all' for all:" : "Enter comma-separated values:");
    const answer = await ask("> ");
    if (allowAll && answer.toLowerCase() === "all") return options.map(o => o.value);
    const tokens = answer
      .split(",")
      .map(n => n.trim())
      .filter(v => v.length > 0);
    if (tokens.length === 0) {
      console.log(red("No values entered. Please try again."));
      continue;
    }
    const invalid = tokens.filter(v => !validValues.has(v));
    if (invalid.length > 0) {
      console.log(red(`Invalid value(s): ${invalid.join(", ")}. Valid options are: ${[...validValues].join(", ")}.`));
      continue;
    }
    // preserveOrder=true keeps duplicates and caller's order (e.g., "1,3,2" stays [1,3,2]).
    return preserveOrder ? tokens : [...new Set(tokens)];
  }
};

const askYesNo = async (prompt: string): Promise<boolean> => {
  console.log(`\n${prompt}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await ask("(y/n): ")).toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log(red(`Invalid input "${answer}". Please enter y or n.`));
  }
};

const pickValidAddresses = async (prompt: string): Promise<string[]> => {
  console.log(`\n${prompt}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("> ");
    const tokens = answer
      .split(",")
      .map(a => a.trim())
      .filter(a => a.length > 0);
    if (tokens.length === 0) {
      console.log(red("No addresses entered. Please try again."));
      continue;
    }
    const invalid = tokens.filter(a => !ethers.utils.isAddress(a));
    if (invalid.length > 0) {
      console.log(red(`Invalid address(es): ${invalid.join(", ")}. Please enter valid Ethereum addresses.`));
      continue;
    }
    return [...new Set(tokens)];
  }
};

const askUint256 = async (prompt: string): Promise<string> => {
  console.log(`\n${prompt}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("> ");
    try {
      const bn = ethers.BigNumber.from(answer);
      if (bn.lt(0)) throw new Error("negative");
      return bn.toString();
    } catch {
      console.log(red(`Invalid uint256 "${answer}". Please enter a non-negative integer.`));
    }
  }
};

// ─── On-chain query helpers ──────────────────────────────────────────────────

const VTOKEN_ABI = ["function symbol() view returns (string)"];

const fetchSymbol = async (vToken: string): Promise<string> => {
  try {
    const contract = new ethers.Contract(vToken, VTOKEN_ABI, ethers.provider);
    return await retry(() => contract.symbol());
  } catch {
    return `MARKET_${vToken.slice(2, 8).toUpperCase()}`;
  }
};

const fetchAllMarkets = async (comptroller: string, isIsolatedPool: boolean): Promise<string[]> => {
  const abi = isIsolatedPool ? IL_COMPTROLLER_QUERY_ABI : BSC_COMPTROLLER_QUERY_ABI;
  const contract = new ethers.Contract(comptroller, abi, ethers.provider);
  const allMarkets: string[] = await retry(() => contract.getAllMarkets());
  console.log(`Found ${allMarkets.length} market(s) on comptroller.`);
  return allMarkets;
};

const filterListedAndFetchSymbols = async (
  comptroller: string,
  isIsolatedPool: boolean,
  markets: string[],
  logUnlisted: boolean,
): Promise<{ addresses: string[]; symbols: Map<string, string> }> => {
  const abi = isIsolatedPool ? IL_COMPTROLLER_QUERY_ABI : BSC_COMPTROLLER_QUERY_ABI;
  const contract = new ethers.Contract(comptroller, abi, ethers.provider);
  console.log(`Checking ${markets.length} market(s)...`);
  const results = await Promise.all(
    markets.map(async market => {
      const { isListed } = await retry(() => contract.markets(market));
      if (isListed) {
        const symbol = await fetchSymbol(market);
        return { market, isListed: true, symbol };
      }
      return { market, isListed: false, symbol: "" };
    }),
  );
  const addresses: string[] = [];
  const symbols = new Map<string, string>();
  for (const { market, isListed, symbol } of results) {
    if (isListed) {
      addresses.push(market);
      symbols.set(market, symbol);
    } else if (logUnlisted) {
      console.log(yellow(`  Skipping unlisted market: ${market}`));
    }
  }
  console.log(green(`  Found ${addresses.length} listed market(s)`));
  return { addresses, symbols };
};

const fetchCurrentCF = async (
  comptroller: string,
  vToken: string,
  isIsolatedPool: boolean,
  poolId?: number,
): Promise<{ cf: BigNumber; lt: BigNumber }> => {
  if (isIsolatedPool) {
    const contract = new ethers.Contract(comptroller, IL_COMPTROLLER_QUERY_ABI, ethers.provider);
    const data = await retry(() => contract.markets(vToken));
    return { cf: data.collateralFactorMantissa, lt: data.liquidationThresholdMantissa };
  } else {
    const contract = new ethers.Contract(comptroller, BSC_COMPTROLLER_QUERY_ABI, ethers.provider);
    const actualPoolId = poolId !== undefined ? poolId : (await retry(() => contract.corePoolId())).toNumber();
    const data = await retry(() => contract.poolMarkets(actualPoolId, vToken));
    return { cf: data.collateralFactorMantissa, lt: data.liquidationThresholdMantissa };
  }
};

const fetchCurrentCaps = async (
  comptroller: string,
  vToken: string,
  isIsolatedPool: boolean,
): Promise<{ borrowCap: BigNumber; supplyCap: BigNumber }> => {
  const abi = isIsolatedPool ? IL_COMPTROLLER_QUERY_ABI : BSC_COMPTROLLER_QUERY_ABI;
  const contract = new ethers.Contract(comptroller, abi, ethers.provider);
  const [borrowCap, supplyCap] = await Promise.all([
    retry(() => contract.borrowCaps(vToken)),
    retry(() => contract.supplyCaps(vToken)),
  ]);
  return { borrowCap, supplyCap };
};

// ─── Markets file helpers ────────────────────────────────────────────────────

type NetworkMarkets = Record<string, string>; // symbol → vTokenAddress

const buildMarketsFromChain = async (comptroller: string, isIsolatedPool: boolean): Promise<NetworkMarkets> => {
  console.log("\nQuerying comptroller for all markets...");
  const allMarkets = await fetchAllMarkets(comptroller, isIsolatedPool);
  const { addresses, symbols } = await filterListedAndFetchSymbols(comptroller, isIsolatedPool, allMarkets, false);
  const markets: NetworkMarkets = {};
  const collisions: string[] = [];
  for (const addr of addresses) {
    const sym = symbols.get(addr)!;
    if (markets[sym]) {
      collisions.push(`${sym}: ${markets[sym]} and ${addr}`);
    } else {
      markets[sym] = addr;
    }
  }
  if (collisions.length > 0) {
    console.error(red("Symbol collision(s) detected:"));
    collisions.forEach(c => console.error(red(`  ${c}`)));
    console.error(red("Cannot build markets map with duplicate symbol keys."));
    rl.close();
    process.exit(1);
  }
  return markets;
};

// ─── Network helpers ─────────────────────────────────────────────────────────

const getEBrakeAddress = async (networkName: string): Promise<string> => {
  // Try to load from hardhat-deploy artifact
  const artifactPath = path.resolve(__dirname, "..", "deployments", networkName, "EBrake.json");
  if (fs.existsSync(artifactPath)) {
    try {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as { address: string };
      if (ethers.utils.isAddress(artifact.address)) {
        console.log(green(`EBrake address from deployment artifact: ${artifact.address}`));
        return artifact.address;
      }
    } catch {
      // Fall through to manual prompt
    }
  }
  console.log(`No EBrake deployment artifact found for network "${networkName}".`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const entered = await ask("Enter EBrake proxy address manually: ");
    if (ethers.utils.isAddress(entered)) return entered;
    console.log(red(`Invalid address "${entered}". Please enter a valid Ethereum address.`));
  }
};

const DEFAULT_SAFE_ADDRESS = "0xCCa5a587eBDBe80f23c8610F2e53B03158e62948";

const askSafeAddress = async (): Promise<string> => {
  console.log("\nEnter the Gnosis Safe address that will sign this transaction.");
  console.log(`Press Enter to use the default: ${DEFAULT_SAFE_ADDRESS}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await ask("> ")).trim();
    if (answer === "") return DEFAULT_SAFE_ADDRESS;
    if (ethers.utils.isAddress(answer)) return answer;
    console.log(red(`Invalid address "${answer}". Please enter a valid Ethereum address.`));
  }
};

// ─── Market selection helper ─────────────────────────────────────────────────

const pickSymbols = async (entries: Array<[string, string]>): Promise<Array<[string, string]>> => {
  const validSymbols = new Set(entries.map(([s]) => s));
  console.log("\nEnter comma-separated names or 'all':");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("> ");
    if (answer.trim().toLowerCase() === "all") return entries;
    const tokens = answer
      .split(",")
      .map(n => n.trim())
      .filter(v => v.length > 0);
    if (tokens.length === 0) {
      console.log(red("No names entered. Please try again."));
      continue;
    }
    const invalid = tokens.filter(t => !validSymbols.has(t));
    if (invalid.length > 0) {
      console.log(red(`Unknown symbol(s): ${invalid.join(", ")}. Valid symbols: ${[...validSymbols].join(", ")}.`));
      continue;
    }
    const dedup = [...new Set(tokens)];
    return dedup.map(sym => entries.find(([s]) => s === sym)!);
  }
};

// Asks operator to pick which pool IDs a market should act on. Called per
// market after market selection — prevents blind fan-out to every pool the
// market happens to be listed in when only a subset is intended.
const pickPoolIds = async (sym: string, available: number[]): Promise<number[]> => {
  const validSet = new Set(available);
  console.log(cyan(`\n${sym} is listed in pool(s): [${available.join(", ")}]`));
  console.log("Enter comma-separated pool IDs or 'all':");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("> ");
    const t = answer.trim().toLowerCase();
    if (t === "all") return available;
    const tokens = answer
      .split(",")
      .map(s => s.trim())
      .filter(v => v.length > 0);
    if (tokens.length === 0) {
      console.log(red("No pool IDs entered. Please try again."));
      continue;
    }
    const parsed = tokens.map(Number);
    const invalid = parsed.filter(n => !Number.isInteger(n) || !validSet.has(n));
    if (invalid.length > 0) {
      console.log(red(`Invalid or out-of-range pool ID(s): ${invalid.join(", ")}. Valid: ${available.join(", ")}.`));
      continue;
    }
    return [...new Set(parsed)];
  }
};

const selectMarkets = async (
  ctx: StepContext,
): Promise<{ marketAddresses: string[]; symbols: Map<string, string> }> => {
  const { comptrollerAddress: comptroller, isIsolatedPool } = ctx;
  const marketMode = await pickOne("How to load markets?", [
    "Enter addresses manually in CLI",
    "Select by name (auto-fetch all listed markets on first use, cached for this run)",
  ]);

  let marketAddresses: string[] = [];
  let symbols = new Map<string, string>();

  if (marketMode.startsWith("Enter")) {
    const entered = await pickValidAddresses("Enter market addresses (comma-separated):");
    const result = await filterListedAndFetchSymbols(comptroller, isIsolatedPool, entered, true);
    marketAddresses = result.addresses;
    symbols = result.symbols;
    console.log(`\nUsing ${marketAddresses.length} address(es):`);
    marketAddresses.forEach(addr => console.log(`  ${symbols.get(addr)} (${addr})`));
  } else {
    let networkMarkets = ctx.marketsCache;
    if (!networkMarkets) {
      networkMarkets = await buildMarketsFromChain(comptroller, isIsolatedPool);
      ctx.marketsCache = networkMarkets;
    } else {
      console.log(`Reusing ${Object.keys(networkMarkets).length} market(s) fetched earlier in this run.`);
    }
    const entries = Object.entries(networkMarkets);
    console.log(`Available markets: ${entries.map(([sym]) => sym).join(", ")}`);
    const selected = await pickSymbols(entries);
    marketAddresses = selected.map(([, addr]) => addr);
    symbols = new Map(selected.map(([sym, addr]) => [addr, sym]));
    console.log(`\nSelected ${marketAddresses.length} market(s):`);
    selected.forEach(([sym, addr]) => console.log(`  ${sym} (${addr})`));
  }

  if (marketAddresses.length === 0) {
    console.error(red("\nNo listed markets found. Exiting."));
    rl.close();
    process.exit(1);
  }

  return { marketAddresses, symbols };
};

// ─── BSC core-diamond pool enumeration ───────────────────────────────────────

interface BscPool {
  poolId: number;
  addresses: string[];
  symbols: Map<string, string>;
}

// A market can be listed in multiple pools (core + e-mode) with different
// settings, so we walk every (poolId, market) pair via poolMarkets().isListed.
// markets().marketPoolId only surfaces one pool per market and would miss the others.
const enumerateBscPools = async (comptroller: string): Promise<BscPool[]> => {
  const contract = new ethers.Contract(comptroller, BSC_COMPTROLLER_QUERY_ABI, ethers.provider);
  const [allMarkets, lastPoolIdBn]: [string[], BigNumber] = await Promise.all([
    retry(() => contract.getAllMarkets()),
    retry(() => contract.lastPoolId()),
  ]);
  const lastPoolId = lastPoolIdBn.toNumber();
  console.log(`Scanning ${allMarkets.length} market(s) across ${lastPoolId + 1} pool(s)...`);

  // Fetch each symbol once — a market in multiple pools reuses the same symbol.
  const symbolEntries = await Promise.all(allMarkets.map(async m => [m, await fetchSymbol(m)] as const));
  const symbolMap = new Map(symbolEntries);

  const pools: BscPool[] = [];
  for (let poolId = 0; poolId <= lastPoolId; poolId++) {
    const listed = await Promise.all(
      allMarkets.map(async market => {
        const data = await retry(() => contract.poolMarkets(poolId, market));
        return data.isListed ? market : null;
      }),
    );
    const addresses = listed.filter((m): m is string => m !== null);
    if (addresses.length === 0) continue;
    const poolSymbols = new Map<string, string>();
    addresses.forEach(a => poolSymbols.set(a, symbolMap.get(a) ?? a));
    pools.push({ poolId, addresses, symbols: poolSymbols });
  }
  return pools;
};

// Lists pools for context, then asks the operator to pick markets from the
// cross-pool union. Each picked market is mapped to the pool IDs it's listed in,
// so commandsForStep can fan out one tx per (market, pool) pair. Pools without
// the market are skipped automatically — they never appear in poolIdsByMarket.
const pickBscMarketsFanOut = async (
  ctx: StepContext,
): Promise<{
  marketAddresses: string[];
  symbols: Map<string, string>;
  poolIdsByMarket: Map<string, number[]>;
}> => {
  let pools = ctx.bscPoolsCache;
  if (!pools) {
    pools = await enumerateBscPools(ctx.comptrollerAddress);
    ctx.bscPoolsCache = pools;
  } else {
    console.log(`Reusing ${pools.length} pool(s) fetched earlier in this run.`);
  }
  if (pools.length === 0) {
    console.error(red("\nNo listed markets found on any pool. Exiting."));
    rl.close();
    process.exit(1);
  }

  // Build {market → [poolIds]} and {symbol ↔ address} across the union.
  const poolsByMarket = new Map<string, number[]>();
  const addressToSymbol = new Map<string, string>();
  for (const p of pools) {
    for (const addr of p.addresses) {
      const list = poolsByMarket.get(addr) ?? [];
      list.push(p.poolId);
      poolsByMarket.set(addr, list);
      addressToSymbol.set(addr, p.symbols.get(addr) ?? addr);
    }
  }

  const lastPoolId = Math.max(...pools.map(p => p.poolId));
  const allSymbols = Array.from(addressToSymbol.values()).join(", ");
  console.log(cyan(`\n${pools.length} pools available (lastPoolId = ${lastPoolId})`));
  console.log(`Available markets: ${allSymbols}`);

  const entries: Array<[string, string]> = Array.from(addressToSymbol, ([addr, sym]) => [sym, addr]);
  const selected = await pickSymbols(entries);

  const marketAddresses = selected.map(([, addr]) => addr);
  const symbols = new Map(selected.map(([sym, addr]) => [addr, sym]));

  // Per-market pool picker: operator chooses which pool IDs to act on.
  // Markets listed in a single pool skip the prompt (nothing to pick).
  console.log(cyan("\n--- Pool selection per market ---"));
  const poolIdsByMarket = new Map<string, number[]>();
  for (const addr of marketAddresses) {
    const sym = symbols.get(addr) ?? addr;
    const available = poolsByMarket.get(addr) ?? [];
    if (available.length <= 1) {
      poolIdsByMarket.set(addr, available);
      if (available.length === 1) {
        console.log(`${sym} → pool [${available[0]}] (only pool, no selection needed)`);
      }
      continue;
    }
    const picked = await pickPoolIds(sym, available);
    poolIdsByMarket.set(addr, picked);
  }

  console.log(cyan("\nFan-out plan:"));
  let totalTxs = 0;
  for (const addr of marketAddresses) {
    const sym = symbols.get(addr) ?? addr;
    const ids = poolIdsByMarket.get(addr) ?? [];
    totalTxs += ids.length;
    console.log(`  ${sym} → pool(s) [${ids.join(", ")}]`);
  }

  // Guard against fat-finger 'all' on a market with many pools — explicit
  // confirm before the batch is generated.
  const proceed = await askYesNo(`About to fan out ${totalTxs} tx(s) across the selection. Proceed?`);
  if (!proceed) {
    console.log(yellow("Aborted by operator. No batch generated."));
    rl.close();
    process.exit(0);
  }

  return { marketAddresses, symbols, poolIdsByMarket };
};

// ─── Phase 1: Gather Input ───────────────────────────────────────────────────

interface StepContext {
  comptrollerAddress: string;
  isIsolatedPool: boolean;
  // In-memory caches shared across steps in a single run. Reset every invocation
  // of the script, so multi-step batches don't refetch while avoiding any
  // persisted cross-network staleness.
  marketsCache?: NetworkMarkets;
  bscPoolsCache?: BscPool[];
}

interface PerMarketValueConfig {
  kind: string; // display label: "CF", "borrow cap", "supply cap"
  defaultFilename: string; // e.g. "bsctestnet_cf_values.json"
  fetchCurrent: (market: string) => Promise<string>;
}

// Collect per-market values (CF or cap) via one of three modes: uniform, per-market CLI, or file.
const gatherPerMarketValues = async (
  markets: string[],
  symbols: Map<string, string>,
  cfg: PerMarketValueConfig,
): Promise<Map<string, string>> => {
  const mode = await pickOne(`Apply ${cfg.kind}:`, [
    `Single value to ALL selected markets (e.g. 0 to block)`,
    `Per-market values via CLI prompts`,
    `Load values from a JSON file`,
  ]);

  const result = new Map<string, string>();

  const fetchAllCurrent = async (): Promise<Map<string, string>> => {
    const entries = await Promise.all(markets.map(async m => [m, await cfg.fetchCurrent(m)] as const));
    return new Map(entries);
  };

  if (mode.startsWith("Single")) {
    const value = await askUint256(`Enter new ${cfg.kind} for all selected markets:`);
    markets.forEach(m => result.set(m, value));
  } else if (mode.startsWith("Per-market")) {
    const current = await fetchAllCurrent();
    for (const m of markets) {
      const sym = symbols.get(m) || m;
      const value = await askUint256(`  ${sym} [current: ${current.get(m)}]:`);
      result.set(m, value);
    }
  } else {
    const defaultPath = path.resolve(OUTPUT_DIR, cfg.defaultFilename);

    // Re-prompt on any validation failure so a typo in the path or the file's
    // contents doesn't force the operator to restart the whole flow.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log(`\nEnter path to ${cfg.kind} values file (press enter for default: ${defaultPath})`);
      const entered = await ask("> ");
      const filePath = entered.length > 0 ? entered : defaultPath;

      if (!fs.existsSync(filePath)) {
        const confirm = await askYesNo(`${filePath} not found. Generate template there?`);
        if (!confirm) continue;
        console.log(`\nGenerating template with current on-chain ${cfg.kind} values...`);
        const current = await fetchAllCurrent();
        const template: Record<string, string> = {};
        for (const m of markets) {
          const sym = symbols.get(m) || m;
          template[sym] = current.get(m) ?? "0";
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + "\n");
        console.log(green(`\nTemplate written to ${filePath}`));
        console.log(`Edit the values (they currently match on-chain ${cfg.kind}) and re-run.`);
        rl.close();
        process.exit(0);
      }

      let content: unknown;
      try {
        content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch (error) {
        console.error(red(`Failed to parse ${filePath}: ${(error as Error).message}`));
        continue;
      }
      if (typeof content !== "object" || content === null || Array.isArray(content)) {
        console.error(red(`${filePath} must contain a JSON object mapping symbol-or-address → value.`));
        continue;
      }

      // Accept either symbol keys or address keys. Build lookup from the current selection.
      const symbolToAddress = new Map<string, string>();
      symbols.forEach((sym, addr) => symbolToAddress.set(sym, addr));
      const selectionSet = new Set(markets);

      let invalid = false;
      result.clear();
      for (const [key, rawValue] of Object.entries(content as Record<string, unknown>)) {
        const addr = ethers.utils.isAddress(key) ? key : symbolToAddress.get(key);
        if (!addr || !selectionSet.has(addr)) {
          console.log(yellow(`  Ignoring "${key}" — not in current selection`));
          continue;
        }
        try {
          const bn = ethers.BigNumber.from(rawValue);
          if (bn.lt(0)) throw new Error("negative");
          result.set(addr, bn.toString());
        } catch {
          console.error(red(`Invalid ${cfg.kind} value for "${key}": ${String(rawValue)}`));
          invalid = true;
          break;
        }
      }
      if (invalid) continue;

      const missing = markets.filter(m => !result.has(m)).map(m => symbols.get(m) || m);
      if (missing.length > 0) {
        console.error(red(`\nFile missing entries for selected markets: ${missing.join(", ")}`));
        console.error(red(`Add entries to ${filePath} and re-try.`));
        continue;
      }

      const current = await fetchAllCurrent();
      console.log("\nWill apply:");
      for (const m of markets) {
        const sym = symbols.get(m) || m;
        console.log(`  ${sym}  new=${result.get(m)}  [current: ${current.get(m)}]`);
      }
      break;
    }
  }

  return result;
};

interface PerPoolValueConfig {
  kind: string;
  defaultFilename: string;
  fetchCurrent: (market: string, poolId: number) => Promise<string>;
}

// Collect per (market, poolId) values for ops that act on a market-in-pool tuple
// (decrease_cf_pool). Without this, a market listed in N pools would reuse the
// same value across all pools, making the per-pool op indistinguishable from the
// all-pools variant.
const gatherPerPoolValues = async (
  markets: string[],
  symbols: Map<string, string>,
  poolIdsByMarket: Map<string, number[]>,
  cfg: PerPoolValueConfig,
): Promise<Map<string, Map<number, string>>> => {
  const pairs: Array<{ market: string; poolId: number }> = [];
  for (const m of markets) {
    for (const pid of poolIdsByMarket.get(m) ?? []) pairs.push({ market: m, poolId: pid });
  }

  const mode = await pickOne(`Apply ${cfg.kind}:`, [
    `Single value to ALL selected (market, pool) pairs (e.g. 0 to block)`,
    `Per-pair values via CLI prompts`,
    `Load values from a JSON file`,
  ]);

  const result = new Map<string, Map<number, string>>();
  const setVal = (market: string, poolId: number, value: string) => {
    let inner = result.get(market);
    if (!inner) {
      inner = new Map<number, string>();
      result.set(market, inner);
    }
    inner.set(poolId, value);
  };

  const fetchAllCurrent = async (): Promise<Map<string, Map<number, string>>> => {
    const out = new Map<string, Map<number, string>>();
    await Promise.all(
      pairs.map(async ({ market, poolId }) => {
        const v = await cfg.fetchCurrent(market, poolId);
        let inner = out.get(market);
        if (!inner) {
          inner = new Map<number, string>();
          out.set(market, inner);
        }
        inner.set(poolId, v);
      }),
    );
    return out;
  };

  if (mode.startsWith("Single")) {
    const value = await askUint256(`Enter new ${cfg.kind} for all selected (market, pool) pairs:`);
    for (const { market, poolId } of pairs) setVal(market, poolId, value);
  } else if (mode.startsWith("Per-pair")) {
    const current = await fetchAllCurrent();
    for (const { market, poolId } of pairs) {
      const sym = symbols.get(market) || market;
      const cur = current.get(market)?.get(poolId) ?? "(unknown)";
      const value = await askUint256(`  ${sym} pool=${poolId} [current: ${cur}]:`);
      setVal(market, poolId, value);
    }
  } else {
    const defaultPath = path.resolve(OUTPUT_DIR, cfg.defaultFilename);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log(`\nEnter path to ${cfg.kind} values file (press enter for default: ${defaultPath})`);
      const entered = await ask("> ");
      const filePath = entered.length > 0 ? entered : defaultPath;

      if (!fs.existsSync(filePath)) {
        const confirm = await askYesNo(`${filePath} not found. Generate template there?`);
        if (!confirm) continue;
        console.log(`\nGenerating template with current on-chain ${cfg.kind} values...`);
        const current = await fetchAllCurrent();
        const template: Record<string, Record<string, string>> = {};
        for (const { market, poolId } of pairs) {
          const sym = symbols.get(market) || market;
          template[sym] ??= {};
          template[sym][String(poolId)] = current.get(market)?.get(poolId) ?? "0";
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + "\n");
        console.log(green(`\nTemplate written to ${filePath}`));
        console.log(`Edit the values (they currently match on-chain ${cfg.kind}) and re-run.`);
        rl.close();
        process.exit(0);
      }

      let content: unknown;
      try {
        content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch (error) {
        console.error(red(`Failed to parse ${filePath}: ${(error as Error).message}`));
        continue;
      }
      if (typeof content !== "object" || content === null || Array.isArray(content)) {
        console.error(red(`${filePath} must contain a JSON object mapping symbol-or-address → {poolId: value}.`));
        continue;
      }

      const symbolToAddress = new Map<string, string>();
      symbols.forEach((sym, addr) => symbolToAddress.set(sym, addr));
      const selectionSet = new Set(markets);

      let invalid = false;
      result.clear();
      for (const [key, rawInner] of Object.entries(content as Record<string, unknown>)) {
        const addr = ethers.utils.isAddress(key) ? key : symbolToAddress.get(key);
        if (!addr || !selectionSet.has(addr)) {
          console.log(yellow(`  Ignoring "${key}" — not in current selection`));
          continue;
        }
        if (typeof rawInner !== "object" || rawInner === null || Array.isArray(rawInner)) {
          console.error(red(`Entry for "${key}" must be an object {poolId: value}.`));
          invalid = true;
          break;
        }
        const allowedPools = new Set(poolIdsByMarket.get(addr) ?? []);
        for (const [pidKey, rawValue] of Object.entries(rawInner as Record<string, unknown>)) {
          const pid = Number(pidKey);
          if (!Number.isInteger(pid) || !allowedPools.has(pid)) {
            console.log(yellow(`  Ignoring "${key}" poolId "${pidKey}" — market not listed in that pool`));
            continue;
          }
          try {
            const bn = ethers.BigNumber.from(rawValue);
            if (bn.lt(0)) throw new Error("negative");
            setVal(addr, pid, bn.toString());
          } catch {
            console.error(red(`Invalid ${cfg.kind} value for "${key}" pool ${pid}: ${String(rawValue)}`));
            invalid = true;
            break;
          }
        }
        if (invalid) break;
      }
      if (invalid) continue;

      const missing: string[] = [];
      for (const { market, poolId } of pairs) {
        if (!result.get(market)?.has(poolId)) {
          missing.push(`${symbols.get(market) || market} pool=${poolId}`);
        }
      }
      if (missing.length > 0) {
        console.error(red(`\nFile missing entries for: ${missing.join(", ")}`));
        console.error(red(`Add entries to ${filePath} and re-try.`));
        continue;
      }

      const current = await fetchAllCurrent();
      console.log("\nWill apply:");
      for (const { market, poolId } of pairs) {
        const sym = symbols.get(market) || market;
        const cur = current.get(market)?.get(poolId) ?? "(unknown)";
        const val = result.get(market)?.get(poolId) ?? "";
        console.log(`  ${sym} pool=${poolId}  new=${val}  [current: ${cur}]`);
      }
      break;
    }
  }

  return result;
};

// Collect the per-operation inputs (markets, actions, CFs, caps, etc.) for a single step.
const gatherStep = async (operation: EBrakeOperation, ctx: StepContext): Promise<EBrakeStep> => {
  const { comptrollerAddress, isIsolatedPool } = ctx;
  let marketAddresses: string[] = [];
  let symbols = new Map<string, string>();
  let pauseActions: number[] | undefined;
  let newCFs: Map<string, string> | undefined;
  let newCFsByPool: Map<string, Map<number, string>> | undefined;
  let poolIdsByMarket: Map<string, number[]> | undefined;
  let newCaps: Map<string, string> | undefined;
  let revokeAccounts: string[] | undefined;

  if (operation === "pause_flash_loan") {
    const confirmed = await askYesNo("Pause all flash loans on the core pool?");
    if (!confirmed) {
      console.log("Aborted.");
      rl.close();
      process.exit(0);
    }
  } else if (operation === "revoke_flash_loan") {
    revokeAccounts = await pickValidAddresses(
      "Enter account address(es) to revoke flash loan access from (comma-separated):",
    );
    console.log(`\nRevoking flash loan access from ${revokeAccounts.length} account(s).`);
  } else {
    if (operation === "decrease_cf_pool" || operation === "disable_pool_borrow") {
      console.log(cyan("\n--- Pool & Market Selection ---"));
      const picked = await pickBscMarketsFanOut(ctx);
      poolIdsByMarket = picked.poolIdsByMarket;
      marketAddresses = picked.marketAddresses;
      symbols = picked.symbols;
    } else {
      console.log(cyan("\n--- Market Selection ---"));
      const result = await selectMarkets(ctx);
      marketAddresses = result.marketAddresses;
      symbols = result.symbols;
    }

    if (operation === "pause_actions") {
      const actionOptions = Object.entries(ALLOWED_PAUSE_ACTIONS).map(([name, value]) => ({
        name,
        value: String(value),
      }));
      const selected = await pickMultiple(
        "Select actions to pause (only MINT/REDEEM/BORROW/TRANSFER are allowed by EBrake):",
        actionOptions,
      );
      pauseActions = selected.map(Number);
      if (pauseActions.length === 0) {
        console.error(red("No actions selected. Exiting."));
        rl.close();
        process.exit(1);
      }
    } else if (operation === "decrease_cf") {
      newCFs = await gatherPerMarketValues(marketAddresses, symbols, {
        kind: "CF",
        defaultFilename: "cf_values.json",
        fetchCurrent: async m => {
          try {
            const { cf } = await fetchCurrentCF(comptrollerAddress, m, isIsolatedPool);
            return cf.toString();
          } catch {
            return "(not listed)";
          }
        },
      });
    } else if (operation === "decrease_cf_pool") {
      if (!poolIdsByMarket) throw new Error("poolIdsByMarket missing for decrease_cf_pool");
      newCFsByPool = await gatherPerPoolValues(marketAddresses, symbols, poolIdsByMarket, {
        kind: "CF",
        defaultFilename: "cf_values_per_pool.json",
        fetchCurrent: async (m, pid) => {
          try {
            const { cf } = await fetchCurrentCF(comptrollerAddress, m, isIsolatedPool, pid);
            return cf.toString();
          } catch {
            return "(not listed)";
          }
        },
      });
    } else if (operation === "set_borrow_caps") {
      newCaps = await gatherPerMarketValues(marketAddresses, symbols, {
        kind: "borrow cap",
        defaultFilename: "borrow_caps.json",
        fetchCurrent: async m => {
          const { borrowCap } = await fetchCurrentCaps(comptrollerAddress, m, isIsolatedPool);
          return borrowCap.toString();
        },
      });
    } else if (operation === "set_supply_caps") {
      newCaps = await gatherPerMarketValues(marketAddresses, symbols, {
        kind: "supply cap",
        defaultFilename: "supply_caps.json",
        fetchCurrent: async m => {
          const { supplyCap } = await fetchCurrentCaps(comptrollerAddress, m, isIsolatedPool);
          return supplyCap.toString();
        },
      });
    }
  }

  return {
    operation,
    marketAddresses,
    symbols,
    pauseActions,
    newCFs,
    newCFsByPool,
    poolIdsByMarket,
    newCaps,
    revokeAccounts,
  };
};

export const gatherInput = async (): Promise<EBrakeBatchInput> => {
  const networkName = network.name;
  const chainId = network.config.chainId;
  if (!chainId) {
    console.error(red(`No chainId configured for network "${networkName}".`));
    rl.close();
    process.exit(1);
  }

  console.log(cyan(`=== Safe EBrake JSON Generator (${networkName}, chain ${chainId}) ===\n`));

  // 1. Resolve EBrake address + probe
  const eBrakeAddress = await getEBrakeAddress(networkName);
  const eBrake = new ethers.Contract(eBrakeAddress, EBRAKE_ABI, ethers.provider);
  const [isIsolatedPool, comptrollerAddress]: [boolean, string] = await Promise.all([
    retry(() => eBrake.IS_ISOLATED_POOL()),
    retry(() => eBrake.COMPTROLLER()),
  ]);
  console.log(`  IS_ISOLATED_POOL: ${isIsolatedPool}`);
  console.log(`  COMPTROLLER:      ${comptrollerAddress}\n`);

  // 2. Operation menu — BSC-only options shown only when !isIsolatedPool
  const operationChoices: { label: string; value: EBrakeOperation }[] = [
    { label: "Pause actions on markets (pauseActions)", value: "pause_actions" },
    { label: "Decrease collateral factor — all pools (decreaseCF)", value: "decrease_cf" },
    { label: "Decrease borrow caps (setMarketBorrowCaps)", value: "set_borrow_caps" },
    { label: "Decrease supply caps (setMarketSupplyCaps)", value: "set_supply_caps" },
  ];
  if (!isIsolatedPool) {
    operationChoices.push(
      { label: "[BSC] Decrease CF — specific pool (decreaseCF with poolId)", value: "decrease_cf_pool" },
      { label: "[BSC] Pause flash loans (pauseFlashLoan)", value: "pause_flash_loan" },
      { label: "[BSC] Revoke flash loan access (revokeFlashLoanAccess)", value: "revoke_flash_loan" },
      { label: "[BSC] Disable pool borrow (disablePoolBorrow)", value: "disable_pool_borrow" },
    );
  }

  // 3. Upfront multi-select: pick ALL operations to batch.
  //    Order-preserving + duplicates allowed (same op twice with different markets is valid).
  const choiceOptions = operationChoices.map((c, i) => ({ name: c.label, value: String(i + 1) }));
  const selectedIndices = await pickMultiple("Select operations (comma-separated, e.g. 1,2,5):", choiceOptions, {
    allowAll: false,
    preserveOrder: true,
  });
  const selectedOps = selectedIndices.map(i => operationChoices[parseInt(i, 10) - 1].value);

  // 4. Iterate selected operations, collecting per-step inputs.
  const ctx: StepContext = { comptrollerAddress, isIsolatedPool };
  const steps: EBrakeStep[] = [];
  for (let i = 0; i < selectedOps.length; i++) {
    const op = selectedOps[i];
    console.log(cyan(`\n─── Step ${i + 1}/${selectedOps.length}: ${op} ───`));
    steps.push(await gatherStep(op, ctx));
  }

  // 6. Ask for the Safe (once) using the first step's role hint.
  const safeAddress = await askSafeAddress();
  const blockNumber = await ethers.provider.getBlockNumber();

  return {
    eBrakeAddress,
    comptrollerAddress,
    isIsolatedPool,
    network: networkName,
    chainId,
    steps,
    safeAddress,
    blockNumber,
  };
};

// ─── Phase 2: Generate Commands ──────────────────────────────────────────────

const commandsForStep = (step: EBrakeStep): EBrakeCommand[] => {
  const {
    operation,
    marketAddresses,
    symbols,
    pauseActions,
    newCFs,
    newCFsByPool,
    poolIdsByMarket,
    newCaps,
    revokeAccounts,
  } = step;
  const commands: EBrakeCommand[] = [];

  switch (operation) {
    case "pause_actions": {
      if (!pauseActions || pauseActions.length === 0) break;
      const actionNames = pauseActions
        .map(a => Object.entries(ALLOWED_PAUSE_ACTIONS).find(([, v]) => v === a)?.[0] || String(a))
        .join(", ");
      console.log(`\nAdding pauseActions for ${marketAddresses.length} market(s): [${actionNames}]`);
      commands.push({
        signature: "pauseActions(address[],uint8[])",
        params: [marketAddresses, pauseActions],
      });
      break;
    }

    case "decrease_cf": {
      if (!newCFs || newCFs.size === 0) break;
      for (const [vToken, cf] of newCFs) {
        const symbol = symbols.get(vToken) || vToken;
        console.log(`  ${symbol} → decreaseCF(${vToken}, ${cf})`);
        commands.push({
          signature: "decreaseCF(address,uint256)",
          params: [vToken, cf],
        });
      }
      break;
    }

    case "decrease_cf_pool": {
      if (!newCFsByPool || newCFsByPool.size === 0) break;
      for (const [vToken, byPool] of newCFsByPool) {
        const symbol = symbols.get(vToken) || vToken;
        for (const [pid, cf] of byPool) {
          console.log(`  ${symbol} → decreaseCF(${vToken}, poolId=${pid}, ${cf})`);
          commands.push({
            signature: "decreaseCF(address,uint96,uint256)",
            params: [vToken, pid, cf],
          });
        }
      }
      break;
    }

    case "set_borrow_caps": {
      if (!newCaps || newCaps.size === 0) break;
      const markets = [...newCaps.keys()];
      const caps = markets.map(m => newCaps.get(m)!);
      console.log(`\nAdding setMarketBorrowCaps for ${markets.length} market(s)`);
      commands.push({
        signature: "setMarketBorrowCaps(address[],uint256[])",
        params: [markets, caps],
      });
      break;
    }

    case "set_supply_caps": {
      if (!newCaps || newCaps.size === 0) break;
      const markets = [...newCaps.keys()];
      const caps = markets.map(m => newCaps.get(m)!);
      console.log(`\nAdding setMarketSupplyCaps for ${markets.length} market(s)`);
      commands.push({
        signature: "setMarketSupplyCaps(address[],uint256[])",
        params: [markets, caps],
      });
      break;
    }

    case "pause_flash_loan": {
      console.log("\nAdding pauseFlashLoan()");
      commands.push({ signature: "pauseFlashLoan()", params: [] });
      break;
    }

    case "revoke_flash_loan": {
      if (!revokeAccounts || revokeAccounts.length === 0) break;
      for (const account of revokeAccounts) {
        console.log(`  → revokeFlashLoanAccess(${account})`);
        commands.push({
          signature: "revokeFlashLoanAccess(address)",
          params: [account],
        });
      }
      break;
    }

    case "disable_pool_borrow": {
      if (!poolIdsByMarket) break;
      for (const vToken of marketAddresses) {
        const symbol = symbols.get(vToken) || vToken;
        const poolIds = poolIdsByMarket.get(vToken) ?? [];
        for (const pid of poolIds) {
          console.log(`  ${symbol} → disablePoolBorrow(poolId=${pid}, ${vToken})`);
          commands.push({
            signature: "disablePoolBorrow(uint96,address)",
            params: [pid, vToken],
          });
        }
      }
      break;
    }
  }

  return commands;
};

export const generateCommands = (batch: EBrakeBatchInput): EBrakeCommand[] =>
  batch.steps.flatMap((step, i) => {
    console.log(`\n[Step ${i + 1}/${batch.steps.length}] ${step.operation}`);
    return commandsForStep(step);
  });

// ─── Phase 3: Export JSON ─────────────────────────────────────────────────────

export const exportJson = async (
  commands: EBrakeCommand[],
  batch: EBrakeBatchInput,
  safeAddress: string,
): Promise<ExportResult | null> => {
  if (commands.length === 0) {
    console.log("No commands generated. Skipping.");
    return null;
  }

  const txBuilderFile = path.resolve(OUTPUT_DIR, `safeEBrakeTxBuilder.json`);
  const metadataFile = path.resolve(OUTPUT_DIR, `safeEBrakeTxMetadata.json`);

  // Direct calldata encoding — no governance VIP wrapper
  const iface = new ethers.utils.Interface(EBRAKE_ABI);
  const txData = commands.map(cmd => ({
    to: batch.eBrakeAddress,
    value: "0",
    data: iface.encodeFunctionData(cmd.signature, cmd.params),
  }));

  const outputJson = buildSafeBatch(safeAddress, txData, batch.chainId, batch.blockNumber);

  // Merge symbols across all steps (a given address may appear in multiple steps;
  // last write wins, but they should be identical since symbols come from chain).
  const symbolsRecord: Record<string, string> = {};
  for (const step of batch.steps) {
    step.symbols.forEach((sym, addr) => {
      symbolsRecord[addr] = sym;
    });
  }

  const metadata: EBrakeMetadata = {
    eBrakeAddress: batch.eBrakeAddress,
    comptrollerAddress: batch.comptrollerAddress,
    network: batch.network,
    operations: batch.steps.map(s => s.operation),
    blockNumber: batch.blockNumber,
    createdAt: new Date().toISOString(),
    symbols: symbolsRecord,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(txBuilderFile, JSON.stringify(outputJson, null, 2));
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

  return { txBuilderFile, metadataFile, txCount: commands.length, safeAddress };
};

// ─── Phase 4: Orchestration ──────────────────────────────────────────────────

const printBatchSummary = (batch: EBrakeBatchInput, txCount: number) => {
  console.log(cyan("\n─── Batch summary ───"));
  batch.steps.forEach((step, i) => {
    console.log(`  [${i + 1}/${batch.steps.length}] ${step.operation}`);
  });
  console.log(`  Total transactions: ${txCount}`);
  console.log(`  Network: ${batch.network} (chain ${batch.chainId})`);
  console.log(`  EBrake:  ${batch.eBrakeAddress}`);
  console.log(`  Safe:    ${batch.safeAddress}`);
};

export const orchestrate = async (batch: EBrakeBatchInput): Promise<ExportResult | null> => {
  console.log(cyan("\n--- Generating commands ---"));
  const commands = generateCommands(batch);
  printBatchSummary(batch, commands.length);
  return exportJson(commands, batch, batch.safeAddress);
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const printResult = (r: ExportResult, networkName: string) => {
  console.log(cyan("\n=== Output ==="));
  console.log(`  Safe TX Builder JSON: ${r.txBuilderFile}`);
  console.log(`  Metadata:             ${r.metadataFile}`);
  console.log(`  Transactions:         ${r.txCount}`);
  console.log(`  Safe address:         ${r.safeAddress}`);
  console.log(
    `  Simulate:             ${bold(`npx hardhat test scripts/simulateSafeEBrakeTx.ts --fork ${networkName}`)}`,
  );
};

export const main = async () => {
  const input = await gatherInput();

  console.log(cyan("\n--- Processing ---"));

  const result = await orchestrate(input);

  if (result) {
    printResult(result, input.network);
  }

  rl.close();
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
