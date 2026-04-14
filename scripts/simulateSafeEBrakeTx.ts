/**
 * simulateSafeEBrakeTx.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Simulates the EBrake Safe TX Builder JSON on a forked network.
 * Forks at the block recorded in the metadata, impersonates the Safe, executes
 * all transactions, then verifies the expected state changes on the comptroller.
 *
 * USAGE
 * ─────
 *   npx hardhat test scripts/simulateSafeEBrakeTx.ts
 *
 * PREREQUISITES
 * ─────────────
 *   ARCHIVE_NODE_<network> env var must be set (same as when running the generator).
 *   The following files must exist (produced by generateSafeEBrakeJson.ts):
 *     helpers/data/safeEBrakeTxBuilder.json
 *     helpers/data/safeEBrakeTxMetadata.json
 */
import "@nomicfoundation/hardhat-chai-matchers";
import { expect } from "chai";
import type { BigNumber, Contract } from "ethers";
import * as fs from "fs";
import { ethers, network } from "hardhat";
import * as path from "path";

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const EBRAKE_ABI = [
  "function IS_ISOLATED_POOL() view returns (bool)",
  "function accessControlManager() view returns (address)",
  "function pauseActions(address[],uint8[])",
  "function pauseFlashLoan()",
  "function revokeFlashLoanAccess(address)",
  "function disablePoolBorrow(uint96,address)",
  "function decreaseCF(address,uint256)",
  "function decreaseCF(address,uint96,uint256)",
  "function setMarketBorrowCaps(address[],uint256[])",
  "function setMarketSupplyCaps(address[],uint256[])",
  "error Unauthorized(address caller, address contractAddress, string functionSig)",
];

const ACM_ABI = ["function isAllowedToCall(address account, string calldata functionSig) view returns (bool)"];

// Covers all read calls needed across IL and BSC core pool comptrollers.
const COMPTROLLER_READ_ABI = [
  // Shared (IComptroller)
  "function actionPaused(address,uint8) view returns (bool)",
  "function borrowCaps(address) view returns (uint256)",
  "function supplyCaps(address) view returns (uint256)",
  // IL (IILComptroller) — 3-value tuple
  "function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, uint256 liquidationThresholdMantissa)",
  // BSC core pool (ICorePoolComptroller)
  "function poolMarkets(uint96,address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function corePoolId() view returns (uint96)",
  "function flashLoanPaused() view returns (bool)",
  "function authorizedFlashLoan(address) view returns (bool)",
];

// ─── Load JSON files ──────────────────────────────────────────────────────────

const TX_BUILDER_FILE = path.resolve(__dirname, "../helpers/data/safeEBrakeTxBuilder.json");
const METADATA_FILE = path.resolve(__dirname, "../helpers/data/safeEBrakeTxMetadata.json");

interface TxBuilderJson {
  chainId: string;
  meta: { createdFromSafeAddress: string };
  transactions: Array<{ to: string; value: string; data: string }>;
  blockNumber: number;
}

interface EBrakeMetadata {
  eBrakeAddress: string;
  comptrollerAddress: string;
  network: string;
  operation: string;
  blockNumber: number;
  symbols: Record<string, string>;
}

if (!fs.existsSync(TX_BUILDER_FILE)) {
  throw new Error(`Missing ${TX_BUILDER_FILE}. Run generateSafeEBrakeJson.ts first.`);
}
if (!fs.existsSync(METADATA_FILE)) {
  throw new Error(`Missing ${METADATA_FILE}. Run generateSafeEBrakeJson.ts first.`);
}

const txBuilder: TxBuilderJson = JSON.parse(fs.readFileSync(TX_BUILDER_FILE, "utf-8"));
const metadata: EBrakeMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf-8"));

// Decode calldata at load time (pure ABI decoding — no network needed)
const eBrakeIface = new ethers.utils.Interface(EBRAKE_ABI);
const decoded = txBuilder.transactions.map(tx => ({
  ...tx,
  parsed: eBrakeIface.parseTransaction({ data: tx.data }),
}));

// ─── Test suite ──────────────────────────────────────────────────────────────

describe(`EBrake TX Simulation — ${metadata.operation} on ${metadata.network} (block ${metadata.blockNumber})`, () => {
  let eBrakeContract: Contract;
  let comptroller: Contract;
  let isIsolatedPool: boolean;

  before(async () => {
    // --fork <network> sets FORKED_NETWORK via the hardhat.config.ts task override.
    // Fall back to the network recorded in the metadata JSON.
    const forkNetwork = process.env.FORKED_NETWORK || metadata.network;
    const archiveNodeUrl = process.env[`ARCHIVE_NODE_${forkNetwork}`];
    if (!archiveNodeUrl) {
      throw new Error(
        `ARCHIVE_NODE_${forkNetwork} environment variable is not set.\n` +
          `Set it to an archive RPC URL for ${forkNetwork} and retry.`,
      );
    }

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: archiveNodeUrl,
            blockNumber: metadata.blockNumber,
          },
        },
      ],
    });

    eBrakeContract = new ethers.Contract(metadata.eBrakeAddress, EBRAKE_ABI, ethers.provider);
    isIsolatedPool = await eBrakeContract.IS_ISOLATED_POOL();
    comptroller = new ethers.Contract(metadata.comptrollerAddress, COMPTROLLER_READ_ABI, ethers.provider);

    // ACM pre-flight: verify the Safe is authorized for every function in the batch
    const safeAddress = txBuilder.meta.createdFromSafeAddress;
    const acmAddress: string = await eBrakeContract.accessControlManager();
    const acm = new ethers.Contract(acmAddress, ACM_ABI, ethers.provider);
    const uniqueSigs = [
      ...new Set(decoded.map(({ parsed }) => parsed.functionFragment.format(ethers.utils.FormatTypes.sighash))),
    ];
    const unauthorized: string[] = [];
    for (const sig of uniqueSigs) {
      const allowed: boolean = await acm.isAllowedToCall(safeAddress, sig);
      if (!allowed) unauthorized.push(sig);
    }
    if (unauthorized.length > 0) {
      throw new Error(
        `ACM check failed — Safe ${safeAddress} is not authorized to call:\n` +
          unauthorized.map(s => `  - ${s}`).join("\n") +
          `\n\nGrant permissions via governance before executing.`,
      );
    }
    console.log(`\nACM:          ${acmAddress} (authorized)`);

    console.log(`\nNetwork:      ${metadata.network}`);
    console.log(`Block:        ${metadata.blockNumber}`);
    console.log(`Operation:    ${metadata.operation}`);
    console.log(`EBrake:       ${metadata.eBrakeAddress}`);
    console.log(`Comptroller:  ${metadata.comptrollerAddress}`);
    console.log(`Safe:         ${txBuilder.meta.createdFromSafeAddress}`);
    console.log(`IS_ISOLATED:  ${isIsolatedPool}`);
    console.log(`Transactions: ${txBuilder.transactions.length}`);
  });

  it("all transactions execute without reverting", async () => {
    const safeAddress = txBuilder.meta.createdFromSafeAddress;

    await network.provider.send("hardhat_setBalance", [safeAddress, "0x1000000000000000000"]);
    await network.provider.send("hardhat_impersonateAccount", [safeAddress]);
    const safeSigner = await ethers.getSigner(safeAddress);
    const eBrakeWithSafe = eBrakeContract.connect(safeSigner);

    for (let i = 0; i < decoded.length; i++) {
      const { parsed } = decoded[i];
      const sig = parsed.functionFragment.format(ethers.utils.FormatTypes.sighash);
      try {
        const txResponse = await eBrakeWithSafe[sig](...parsed.args);
        const receipt = await txResponse.wait();
        console.log(`  tx[${i}] ${sig}: gas=${receipt.gasUsed.toString()} hash=${receipt.transactionHash}`);
        expect(receipt.status, `tx[${i}] (${sig}) reverted`).to.equal(1);
      } catch (err: unknown) {
        const e = err as { errorName?: string; errorArgs?: [string, string, string] };
        if (e.errorName === "Unauthorized") {
          const [caller, , functionSig] = e.errorArgs!;
          throw new Error(
            `Caller not authorised: ${caller} cannot call "${functionSig}" on EBrake (${metadata.eBrakeAddress})`,
          );
        }
        throw err;
      }
    }
  });

  it("state reflects expected changes on comptroller", async () => {
    for (const { parsed } of decoded) {
      const name = parsed.name;

      if (name === "pauseActions") {
        const [markets, actions] = parsed.args as [string[], number[]];
        for (const market of markets) {
          const sym = metadata.symbols[market] || market;
          for (const action of actions) {
            const paused = await comptroller.actionPaused(market, action);
            expect(paused, `actionPaused(${sym}, action=${action}) should be true`).to.be.true;
          }
        }
      } else if (name === "decreaseCF" && parsed.args.length === 2) {
        // decreaseCF(address vToken, uint256 newCF) — all pools (BSC) or IL
        const [vToken, newCF] = parsed.args as [string, BigNumber];
        const sym = metadata.symbols[vToken] || vToken;
        if (isIsolatedPool) {
          const market = await comptroller.markets(vToken);
          expect(market.collateralFactorMantissa.toString(), `CF for ${sym}`).to.equal(newCF.toString());
        } else {
          const corePoolId: BigNumber = await comptroller.corePoolId();
          const market = await comptroller.poolMarkets(corePoolId, vToken);
          expect(market.collateralFactorMantissa.toString(), `CF for ${sym} (pool ${corePoolId})`).to.equal(
            newCF.toString(),
          );
        }
      } else if (name === "decreaseCF" && parsed.args.length === 3) {
        // decreaseCF(address vToken, uint96 poolId, uint256 newCF) — single pool
        const [vToken, poolId, newCF] = parsed.args as [string, BigNumber, BigNumber];
        const sym = metadata.symbols[vToken] || vToken;
        const market = await comptroller.poolMarkets(poolId, vToken);
        expect(market.collateralFactorMantissa.toString(), `CF for ${sym} (pool ${poolId})`).to.equal(newCF.toString());
      } else if (name === "setMarketBorrowCaps") {
        const [markets, caps] = parsed.args as [string[], BigNumber[]];
        for (let i = 0; i < markets.length; i++) {
          const sym = metadata.symbols[markets[i]] || markets[i];
          const actual = await comptroller.borrowCaps(markets[i]);
          expect(actual.toString(), `borrowCap for ${sym}`).to.equal(caps[i].toString());
        }
      } else if (name === "setMarketSupplyCaps") {
        const [markets, caps] = parsed.args as [string[], BigNumber[]];
        for (let i = 0; i < markets.length; i++) {
          const sym = metadata.symbols[markets[i]] || markets[i];
          const actual = await comptroller.supplyCaps(markets[i]);
          expect(actual.toString(), `supplyCap for ${sym}`).to.equal(caps[i].toString());
        }
      } else if (name === "pauseFlashLoan") {
        const paused = await comptroller.flashLoanPaused();
        expect(paused, "flashLoanPaused should be true").to.be.true;
      } else if (name === "revokeFlashLoanAccess") {
        const [account] = parsed.args as [string];
        const authorized = await comptroller.authorizedFlashLoan(account);
        expect(authorized, `authorizedFlashLoan(${account}) should be false`).to.be.false;
      } else if (name === "disablePoolBorrow") {
        const [poolId, vToken] = parsed.args as [BigNumber, string];
        const sym = metadata.symbols[vToken] || vToken;
        const market = await comptroller.poolMarkets(poolId, vToken);
        expect(market.isBorrowAllowed, `isBorrowAllowed for ${sym} (pool ${poolId}) should be false`).to.be.false;
      }
    }
  });
});
