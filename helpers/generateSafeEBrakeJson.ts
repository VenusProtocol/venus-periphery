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
 * OUTPUT
 * ──────
 * Written to helpers/data/:
 *   safeEBrakeTxBuilder[_cf].json   — import this into Gnosis Safe TX Builder UI
 *   safeEBrakeTxMetadata[_cf].json  — audit trail (EBrake address, network, block, symbols)
 *
 * OUTPUT
 * ──────
 * Written to helpers/data/:
 *   safeEBrakeTxBuilder.json   — import this into Gnosis Safe TX Builder UI
 *   safeEBrakeTxMetadata.json  — audit trail (EBrake address, network, block, symbols)
 *
 * You will be prompted for the Safe address that should sign the transaction.
 * Use the correct Safe for the operation (e.g. GUARDIAN for pauses,
 * CRITICAL_GUARDIAN for CF/cap changes on BSC).
 */
import type { BigNumber } from "ethers";
import * as fs from "fs";
import { ethers, network } from "hardhat";
import * as path from "path";
import * as readline from "readline";

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

const MARKETS_FILE = path.resolve(__dirname, "data", "markets.json");
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

export interface EBrakeInput {
  eBrakeAddress: string;
  comptrollerAddress: string;
  isIsolatedPool: boolean;
  network: string;
  chainId: number;
  operation: EBrakeOperation;
  marketAddresses: string[];
  symbols: Map<string, string>;
  pauseActions?: number[];
  newCF?: string;
  poolId?: number;
  newCaps?: Map<string, string>;
  revokeAccounts?: string[];
  safeAddress: string;
  blockNumber: number;
}

interface EBrakeMetadata {
  eBrakeAddress: string;
  comptrollerAddress: string;
  network: string;
  operation: EBrakeOperation;
  blockNumber: number;
  createdAt: string;
  symbols: Record<string, string>;
}

export interface ExportResult {
  label: string;
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
    console.log(`Invalid selection "${answer}". Please enter a number between 1 and ${options.length}.`);
  }
};

const pickMultiple = async (prompt: string, options: { name: string; value: string }[]): Promise<string[]> => {
  console.log(`\n${prompt}`);
  options.forEach(opt => console.log(`  ${opt.value}. ${opt.name}`));
  const validValues = new Set(options.map(o => o.value));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log("Enter comma-separated values or 'all' for all:");
    const answer = await ask("> ");
    if (answer.toLowerCase() === "all") return options.map(o => o.value);
    const tokens = answer
      .split(",")
      .map(n => n.trim())
      .filter(v => v.length > 0);
    if (tokens.length === 0) {
      console.log("No values entered. Please try again.");
      continue;
    }
    const invalid = tokens.filter(v => !validValues.has(v));
    if (invalid.length > 0) {
      console.log(`Invalid value(s): ${invalid.join(", ")}. Valid options are: ${[...validValues].join(", ")}.`);
      continue;
    }
    return [...new Set(tokens)];
  }
};

const askYesNo = async (prompt: string): Promise<boolean> => {
  console.log(`\n${prompt}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await ask("(y/n): ")).toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log(`Invalid input "${answer}". Please enter y or n.`);
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
      console.log("No addresses entered. Please try again.");
      continue;
    }
    const invalid = tokens.filter(a => !ethers.utils.isAddress(a));
    if (invalid.length > 0) {
      console.log(`Invalid address(es): ${invalid.join(", ")}. Please enter valid Ethereum addresses.`);
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
      console.log(`Invalid uint256 "${answer}". Please enter a non-negative integer.`);
    }
  }
};

const askPoolId = async (prompt: string): Promise<number> => {
  console.log(`\n${prompt}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("> ");
    const n = parseInt(answer, 10);
    if (!isNaN(n) && n >= 0) return n;
    console.log(`Invalid pool ID "${answer}". Please enter a non-negative integer.`);
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
      console.log(`  Skipping unlisted market: ${market}`);
    }
  }
  console.log(`  Found ${addresses.length} listed market(s)`);
  return { addresses, symbols };
};

const formatMantissa = (mantissa: BigNumber): string => {
  const pct = parseFloat(ethers.utils.formatUnits(mantissa, 18)) * 100;
  return `${mantissa.toString()} (${pct.toFixed(2)}%)`;
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

const loadMarketsFromFile = (): string[] => {
  if (!fs.existsSync(MARKETS_FILE)) return [];
  let content: unknown;
  try {
    content = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf-8"));
  } catch (error) {
    console.error(`Failed to parse ${MARKETS_FILE}: ${(error as Error).message}`);
    rl.close();
    process.exit(1);
  }
  if (!Array.isArray(content)) {
    console.error(`${MARKETS_FILE} must contain a JSON array of addresses.`);
    rl.close();
    process.exit(1);
  }
  const invalid = content.filter((addr: string) => !ethers.utils.isAddress(addr));
  if (invalid.length > 0) {
    console.error(`Invalid address(es) in ${MARKETS_FILE}: ${invalid.join(", ")}`);
    console.error("Fix the file and run again.");
    rl.close();
    process.exit(1);
  }
  return [...new Set(content as string[])];
};

const saveMarketsToFile = (addresses: string[]) => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(MARKETS_FILE, JSON.stringify(addresses, null, 2));
  console.log(`Markets saved to ${MARKETS_FILE} (${addresses.length} addresses)`);
};

// ─── Network helpers ─────────────────────────────────────────────────────────

const getEBrakeAddress = async (networkName: string): Promise<string> => {
  // Try to load from hardhat-deploy artifact
  const artifactPath = path.resolve(__dirname, "..", "deployments", networkName, "EBrake.json");
  if (fs.existsSync(artifactPath)) {
    try {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as { address: string };
      if (ethers.utils.isAddress(artifact.address)) {
        console.log(`EBrake address from deployment artifact: ${artifact.address}`);
        return artifact.address;
      }
    } catch {
      // Fall through to manual prompt
    }
  }
  console.log(`No EBrake deployment artifact found for network "${networkName}".`);
  const entered = await ask("Enter EBrake proxy address manually: ");
  if (!ethers.utils.isAddress(entered)) {
    console.error("Invalid address!");
    rl.close();
    process.exit(1);
  }
  return entered;
};

// Defined here (before askSafeAddress) so it can be used for the hint
const isCriticalOperation = (operation: EBrakeOperation): boolean =>
  operation === "decrease_cf" ||
  operation === "decrease_cf_pool" ||
  operation === "set_borrow_caps" ||
  operation === "set_supply_caps";

const askSafeAddress = async (networkName: string, operation: EBrakeOperation): Promise<string> => {
  const hint =
    isCriticalOperation(operation) && networkName === "bscmainnet"
      ? "  (use CRITICAL_GUARDIAN Safe for CF/cap operations on BSC)"
      : "  (use GUARDIAN Safe)";
  console.log(`\nEnter the Gnosis Safe address that will sign this transaction.${hint}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask("> ");
    if (ethers.utils.isAddress(answer)) return answer;
    console.log(`Invalid address "${answer}". Please enter a valid Ethereum address.`);
  }
};

// ─── Market selection helper ─────────────────────────────────────────────────

const selectMarkets = async (
  comptroller: string,
  isIsolatedPool: boolean,
): Promise<{ marketAddresses: string[]; symbols: Map<string, string> }> => {
  const marketMode = await pickOne("How to load markets?", [
    "Fetch all markets from comptroller (saves to helpers/data/markets.json)",
    "Use addresses from helpers/data/markets.json (edit the file manually first)",
    "Enter addresses manually in CLI",
  ]);

  let marketAddresses: string[] = [];
  let symbols = new Map<string, string>();

  if (marketMode.startsWith("Fetch")) {
    console.log("\nQuerying comptroller for all markets...");
    const allMarkets = await fetchAllMarkets(comptroller, isIsolatedPool);
    const result = await filterListedAndFetchSymbols(comptroller, isIsolatedPool, allMarkets, false);
    marketAddresses = result.addresses;
    symbols = result.symbols;
    console.log(`Found ${marketAddresses.length} listed market(s):`);
    marketAddresses.forEach(addr => console.log(`  ${symbols.get(addr)} (${addr})`));
    saveMarketsToFile(marketAddresses);
  } else if (marketMode.startsWith("Use")) {
    const loaded = loadMarketsFromFile();
    if (loaded.length === 0) {
      console.error(`\nNo addresses found in ${MARKETS_FILE}.`);
      console.log("Add vToken addresses to the file and run again.");
      rl.close();
      process.exit(1);
    }
    console.log(`\nLoaded ${loaded.length} address(es) from ${MARKETS_FILE}`);
    const result = await filterListedAndFetchSymbols(comptroller, isIsolatedPool, loaded, true);
    marketAddresses = result.addresses;
    symbols = result.symbols;
    marketAddresses.forEach(addr => console.log(`  ${symbols.get(addr)} (${addr})`));
  } else {
    const entered = await pickValidAddresses("Enter market addresses (comma-separated):");
    const result = await filterListedAndFetchSymbols(comptroller, isIsolatedPool, entered, true);
    marketAddresses = result.addresses;
    symbols = result.symbols;
    console.log(`\nUsing ${marketAddresses.length} address(es):`);
    marketAddresses.forEach(addr => console.log(`  ${symbols.get(addr)} (${addr})`));
  }

  if (marketAddresses.length === 0) {
    console.error("\nNo listed markets found. Exiting.");
    rl.close();
    process.exit(1);
  }

  return { marketAddresses, symbols };
};

// ─── Phase 1: Gather Input ───────────────────────────────────────────────────

export const gatherInput = async (): Promise<EBrakeInput> => {
  const networkName = network.name;
  const chainId = network.config.chainId;
  if (!chainId) {
    console.error(`No chainId configured for network "${networkName}".`);
    rl.close();
    process.exit(1);
  }

  console.log(`=== Safe EBrake JSON Generator (${networkName}, chain ${chainId}) ===\n`);

  // 1. Resolve EBrake address
  const eBrakeAddress = await getEBrakeAddress(networkName);

  // 2. Read IS_ISOLATED_POOL and COMPTROLLER from the contract
  const eBrake = new ethers.Contract(eBrakeAddress, EBRAKE_ABI, ethers.provider);
  const [isIsolatedPool, comptrollerAddress]: [boolean, string] = await Promise.all([
    retry(() => eBrake.IS_ISOLATED_POOL()),
    retry(() => eBrake.COMPTROLLER()),
  ]);
  console.log(`  IS_ISOLATED_POOL: ${isIsolatedPool}`);
  console.log(`  COMPTROLLER:      ${comptrollerAddress}\n`);

  // 3. Operation menu — BSC-only options shown only when !isIsolatedPool
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

  const operationLabel = await pickOne(
    "Select operation:",
    operationChoices.map(c => c.label),
  );
  const operation = operationChoices.find(c => c.label === operationLabel)!.value;

  // 4. Operation-specific input gathering
  let marketAddresses: string[] = [];
  let symbols = new Map<string, string>();
  let pauseActions: number[] | undefined;
  let newCF: string | undefined;
  let poolId: number | undefined;
  let newCaps: Map<string, string> | undefined;
  let revokeAccounts: string[] | undefined;

  if (operation === "pause_flash_loan") {
    // No market selection needed
    const confirmed = await askYesNo("Pause all flash loans on the core pool?");
    if (!confirmed) {
      console.log("Aborted.");
      rl.close();
      process.exit(0);
    }
  } else if (operation === "revoke_flash_loan") {
    // Ask for accounts to revoke
    revokeAccounts = await pickValidAddresses(
      "Enter account address(es) to revoke flash loan access from (comma-separated):",
    );
    console.log(`\nRevoking flash loan access from ${revokeAccounts.length} account(s).`);
  } else {
    // All other operations need market selection
    console.log("\n--- Market Selection ---");
    const result = await selectMarkets(comptrollerAddress, isIsolatedPool);
    marketAddresses = result.marketAddresses;
    symbols = result.symbols;

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
        console.error("No actions selected. Exiting.");
        rl.close();
        process.exit(1);
      }
    } else if (operation === "decrease_cf") {
      // Fetch and display current CFs
      console.log("\nQuerying current collateral factors...");
      await Promise.all(
        marketAddresses.map(async vToken => {
          const symbol = symbols.get(vToken) || vToken;
          const { cf, lt } = await fetchCurrentCF(comptrollerAddress, vToken, isIsolatedPool);
          console.log(`  ${symbol} (${vToken})`);
          console.log(`    CF: ${formatMantissa(cf)}`);
          console.log(`    LT: ${formatMantissa(lt)}`);
        }),
      );
      newCF = await askUint256(
        "Enter new CF mantissa to apply to all selected markets\n(e.g. 750000000000000000 = 75%, 0 = block new borrows):",
      );
    } else if (operation === "decrease_cf_pool") {
      poolId = await askPoolId("Enter pool ID (0 = core pool, >0 = e-mode pool ID):");
      // Fetch and display current CFs for the specific pool
      console.log(`\nQuerying current CFs for pool ${poolId}...`);
      await Promise.all(
        marketAddresses.map(async vToken => {
          const symbol = symbols.get(vToken) || vToken;
          try {
            const { cf, lt } = await fetchCurrentCF(comptrollerAddress, vToken, isIsolatedPool, poolId);
            console.log(`  ${symbol} (${vToken})`);
            console.log(`    CF (pool ${poolId}): ${formatMantissa(cf)}`);
            console.log(`    LT (pool ${poolId}): ${formatMantissa(lt)}`);
          } catch {
            console.log(`  ${symbol} (${vToken}) — not listed in pool ${poolId}, will revert`);
          }
        }),
      );
      newCF = await askUint256("Enter new CF mantissa to apply to all selected markets in this pool:");
    } else if (operation === "set_borrow_caps") {
      // Fetch and display current borrow caps, then ask per market
      console.log("\nQuerying current borrow caps...");
      newCaps = new Map<string, string>();
      for (const vToken of marketAddresses) {
        const symbol = symbols.get(vToken) || vToken;
        const { borrowCap } = await fetchCurrentCaps(comptrollerAddress, vToken, isIsolatedPool);
        console.log(`\n  ${symbol} (${vToken})`);
        console.log(`    Current borrow cap: ${borrowCap.toString()}`);
        const cap = await askUint256(`  Enter new borrow cap for ${symbol} (must be < ${borrowCap.toString()}):`);
        newCaps.set(vToken, cap);
      }
    } else if (operation === "set_supply_caps") {
      // Fetch and display current supply caps, then ask per market
      console.log("\nQuerying current supply caps...");
      newCaps = new Map<string, string>();
      for (const vToken of marketAddresses) {
        const symbol = symbols.get(vToken) || vToken;
        const { supplyCap } = await fetchCurrentCaps(comptrollerAddress, vToken, isIsolatedPool);
        console.log(`\n  ${symbol} (${vToken})`);
        console.log(`    Current supply cap: ${supplyCap.toString()}`);
        const cap = await askUint256(`  Enter new supply cap for ${symbol} (must be < ${supplyCap.toString()}):`);
        newCaps.set(vToken, cap);
      }
    } else if (operation === "disable_pool_borrow") {
      poolId = await askPoolId("Enter pool ID to disable borrowing in (0 = core pool, >0 = e-mode pool ID):");
    }
  }

  const safeAddress = await askSafeAddress(networkName, operation);
  const blockNumber = await ethers.provider.getBlockNumber();

  return {
    eBrakeAddress,
    comptrollerAddress,
    isIsolatedPool,
    network: networkName,
    chainId,
    operation,
    marketAddresses,
    symbols,
    pauseActions,
    newCF,
    poolId,
    newCaps,
    revokeAccounts,
    safeAddress,
    blockNumber,
  };
};

// ─── Phase 2: Generate Commands ──────────────────────────────────────────────

export const generateCommands = (input: EBrakeInput): EBrakeCommand[] => {
  const { operation, marketAddresses, symbols, pauseActions, newCF, poolId, newCaps, revokeAccounts } = input;
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
      if (!newCF) break;
      for (const vToken of marketAddresses) {
        const symbol = symbols.get(vToken) || vToken;
        console.log(`  ${symbol} → decreaseCF(${vToken}, ${newCF})`);
        commands.push({
          signature: "decreaseCF(address,uint256)",
          params: [vToken, newCF],
        });
      }
      break;
    }

    case "decrease_cf_pool": {
      if (!newCF || poolId === undefined) break;
      for (const vToken of marketAddresses) {
        const symbol = symbols.get(vToken) || vToken;
        console.log(`  ${symbol} → decreaseCF(${vToken}, poolId=${poolId}, ${newCF})`);
        commands.push({
          signature: "decreaseCF(address,uint96,uint256)",
          params: [vToken, poolId, newCF],
        });
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
      if (poolId === undefined) break;
      for (const vToken of marketAddresses) {
        const symbol = symbols.get(vToken) || vToken;
        console.log(`  ${symbol} → disablePoolBorrow(poolId=${poolId}, ${vToken})`);
        commands.push({
          signature: "disablePoolBorrow(uint96,address)",
          params: [poolId, vToken],
        });
      }
      break;
    }
  }

  return commands;
};

// ─── Phase 3: Export JSON ─────────────────────────────────────────────────────

export const exportJson = async (
  commands: EBrakeCommand[],
  input: EBrakeInput,
  safeAddress: string,
  suffix?: string,
): Promise<ExportResult | null> => {
  if (commands.length === 0) {
    console.log(`No commands generated${suffix ? ` for ${suffix}` : ""}. Skipping.`);
    return null;
  }

  const label = suffix || "";
  const txBuilderFile = path.resolve(OUTPUT_DIR, `safeEBrakeTxBuilder${label}.json`);
  const metadataFile = path.resolve(OUTPUT_DIR, `safeEBrakeTxMetadata${label}.json`);

  // Direct calldata encoding — no governance VIP wrapper
  const iface = new ethers.utils.Interface(EBRAKE_ABI);
  const txData = commands.map(cmd => ({
    to: input.eBrakeAddress,
    value: "0",
    data: iface.encodeFunctionData(cmd.signature, cmd.params),
  }));

  const outputJson = buildSafeBatch(safeAddress, txData, input.chainId, input.blockNumber);

  const symbolsRecord: Record<string, string> = {};
  input.symbols.forEach((sym, addr) => {
    symbolsRecord[addr] = sym;
  });

  const metadata: EBrakeMetadata = {
    eBrakeAddress: input.eBrakeAddress,
    comptrollerAddress: input.comptrollerAddress,
    network: input.network,
    operation: input.operation,
    blockNumber: input.blockNumber,
    createdAt: new Date().toISOString(),
    symbols: symbolsRecord,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(txBuilderFile, JSON.stringify(outputJson, null, 2));
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

  return { label, txBuilderFile, metadataFile, txCount: commands.length, safeAddress };
};

// ─── Phase 4: Orchestration ──────────────────────────────────────────────────

export const orchestrate = async (input: EBrakeInput): Promise<ExportResult[]> => {
  const results: ExportResult[] = [];

  console.log("\n--- Generating commands ---");
  const commands = generateCommands(input);

  const result = await exportJson(commands, input, input.safeAddress);
  if (result) results.push(result);

  return results;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const printResults = (results: ExportResult[], networkName: string) => {
  console.log("\n=== Output ===");
  for (const r of results) {
    console.log(`\n  ${r.label || "(default)"}`);
    console.log(`    Safe TX Builder JSON: ${r.txBuilderFile}`);
    console.log(`    Metadata:             ${r.metadataFile}`);
    console.log(`    Transactions:         ${r.txCount}`);
    console.log(`    Safe address:         ${r.safeAddress}`);
    console.log(`    Simulate:             npx hardhat test scripts/simulateSafeEBrakeTx.ts --fork ${networkName}`);
  }
};

export const main = async () => {
  const input = await gatherInput();

  console.log("\n--- Processing ---");

  const results = await orchestrate(input);

  if (results.length > 0) {
    printResults(results, input.network);
  }

  rl.close();
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
