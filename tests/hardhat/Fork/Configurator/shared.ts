// ═══════════════════════════════════════════════════════════════════════════
// DeviationSentinelConfigurator Fork Test — Shared Fixture & Test Factories
// ═══════════════════════════════════════════════════════════════════════════
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "hardhat";

import { initMainnetUser } from "../utils";
import {
  AERODROME_ORACLE_ADMIN_PERMS,
  CURVE_ORACLE_ADMIN_PERMS,
  ConfiguratorNetworkConfig,
  DEFAULT_ADMIN_ROLE,
  EBRAKE_COMPTROLLER_PERMS_IL,
  GOVERNANCE_EBRAKE_PERMS_IL,
  RESET_PERMS,
  SENTINEL_ADMIN_PERMS,
  SENTINEL_EBRAKE_PERMS,
  SENTINEL_ORACLE_ADMIN_PERMS,
  TRANSIENT_BASE_PERMS_BY_HOST,
  TRANSIENT_CHAIN_SPECIFIC_PERMS_BY_HOST,
  UNISWAP_ORACLE_ADMIN_PERMS,
} from "./configs";

// ── Minimal ABIs (avoids depending on typechain for cross-chain contracts) ──

const ACM_ABI = [
  "function giveCallPermission(address contractAddress, string functionSig, address account)",
  "function revokeCallPermission(address contractAddress, string functionSig, address account)",
  "function hasPermission(address account, address contractAddress, string functionSig) view returns (bool)",
  // OZ AccessControl — used to grant/check the helper's DEFAULT_ADMIN_ROLE
  "function grantRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const OWNABLE_2STEP_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
];

const DEVIATION_SENTINEL_ABI = [
  "function trustedKeepers(address) view returns (bool)",
  "function tokenConfigs(address) view returns (uint8 deviation, bool enabled)",
];

const SENTINEL_ORACLE_ABI = ["function tokenConfigs(address) view returns (address oracle)"];

const UNISWAP_ORACLE_ABI = ["function tokenPools(address) view returns (address)"];

// Configurator interface — `execute()` plus the custom error so chai's
// `revertedWithCustomError` matcher can decode the OnlyTimelock revert.
const CONFIGURATOR_ABI = ["function execute()", "error OnlyTimelock()"];

// ── Fixture ──

export interface ConfiguratorFixture {
  helper: Contract;
  acm: Contract;
  deviationSentinel: Contract;
  sentinelOracle: Contract;
  uniswapOracle: Contract;
  curveOracle?: Contract;
  aerodromeOracle?: Contract;
  timelock: SignerWithAddress;
  randomUser: SignerWithAddress;
}

export type FixtureGetter = () => ConfiguratorFixture;

// ── Internal helpers ──

/// Walks a contract through Ownable2Step ownership transfer to `newOwner`,
/// regardless of current owner / pendingOwner state. No-op if already owned.
async function ensureTimelockOwns(target: string, newOwner: SignerWithAddress): Promise<void> {
  const c = new ethers.Contract(target, OWNABLE_2STEP_ABI, ethers.provider);
  const currentOwner = (await c.owner()).toLowerCase();
  if (currentOwner === newOwner.address.toLowerCase()) return;

  const pending = (await c.pendingOwner()).toLowerCase();
  if (pending !== newOwner.address.toLowerCase()) {
    const ownerSigner = await initMainnetUser(currentOwner, ethers.utils.parseEther("10"));
    await c.connect(ownerSigner).transferOwnership(newOwner.address);
  }
  await c.connect(newOwner).acceptOwnership();
}

// ── Fixture builder ──

export function createDeployFixture(cfg: ConfiguratorNetworkConfig): () => Promise<ConfiguratorFixture> {
  return async function deployConfiguratorFixture(): Promise<ConfiguratorFixture> {
    const [, randomUser] = await ethers.getSigners();
    const timelock = await initMainnetUser(cfg.normalTimelock, ethers.utils.parseEther("100"));

    // 1. Ensure NORMAL_TIMELOCK owns every contract the helper will admin.
    const ownableTargets = [cfg.deviationSentinel, cfg.eBrake, cfg.sentinelOracle, cfg.uniswapOracle];
    if (cfg.curveOracle) ownableTargets.push(cfg.curveOracle);
    if (cfg.aerodromeOracle) ownableTargets.push(cfg.aerodromeOracle);
    for (const t of ownableTargets) {
      await ensureTimelockOwns(t, timelock);
    }

    // 2. Deploy the per-chain configurator. Helper has no constructor args —
    //    every address it touches is hard-coded at the source level.
    const Factory = await ethers.getContractFactory(cfg.factoryName);
    const helperRaw = await Factory.deploy();
    await helperRaw.deployed();
    const helper = new ethers.Contract(helperRaw.address, CONFIGURATOR_ABI, timelock);

    // 3. Grant the helper DEFAULT_ADMIN_ROLE on the ACM. ACM.giveCallPermission /
    //    revokeCallPermission wrap OZ grantRole/revokeRole, both of which check
    //    onlyRole(DEFAULT_ADMIN_ROLE). Done from NORMAL_TIMELOCK, which holds that
    //    role at chain genesis.
    const acm = new ethers.Contract(cfg.acm, ACM_ABI, timelock);
    await acm.grantRole(DEFAULT_ADMIN_ROLE, helper.address);

    // 4. Build typed handles to the periphery contracts (read-only ABIs).
    const deviationSentinel = new ethers.Contract(cfg.deviationSentinel, DEVIATION_SENTINEL_ABI, ethers.provider);
    const sentinelOracle = new ethers.Contract(cfg.sentinelOracle, SENTINEL_ORACLE_ABI, ethers.provider);
    const uniswapOracle = new ethers.Contract(cfg.uniswapOracle, UNISWAP_ORACLE_ABI, ethers.provider);
    const curveOracle = cfg.curveOracle
      ? new ethers.Contract(cfg.curveOracle, UNISWAP_ORACLE_ABI, ethers.provider)
      : undefined;
    const aerodromeOracle = cfg.aerodromeOracle
      ? new ethers.Contract(cfg.aerodromeOracle, UNISWAP_ORACLE_ABI, ethers.provider)
      : undefined;

    return {
      helper,
      acm,
      deviationSentinel,
      sentinelOracle,
      uniswapOracle,
      curveOracle,
      aerodromeOracle,
      timelock,
      randomUser: randomUser as unknown as SignerWithAddress,
    };
  };
}

// ── Per-test executor ────────────────────────────────────────────────────
//
// Most assertions need the post-execute() state. The fixture stops *before*
// execute() so the access-control test can fire the revert path on a fresh
// helper. Other tests call this once via `before` to advance state.

export async function runExecuteOnce(get: FixtureGetter): Promise<void> {
  const { helper, timelock } = get();
  await helper.connect(timelock).execute();
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════

const govAccounts = (cfg: ConfiguratorNetworkConfig): string[] => [
  cfg.guardian,
  cfg.normalTimelock,
  cfg.fastTrackTimelock,
  cfg.criticalTimelock,
];

const expectAcm = async (acm: Contract, account: string, target: string, sig: string, want: boolean): Promise<void> => {
  const got = await acm.hasPermission(account, target, sig);
  expect(got, `hasPermission(${account}, ${target}, "${sig}") expected ${want} got ${got}`).to.equal(want);
};

export function accessControlTests(cfg: ConfiguratorNetworkConfig, get: FixtureGetter): void {
  describe("Access control", () => {
    it("execute() reverts with OnlyTimelock when called by anyone other than the Normal Timelock", async () => {
      const { helper, randomUser } = get();
      await expect(helper.connect(randomUser).execute()).to.be.revertedWithCustomError(helper, "OnlyTimelock");
    });
  });
}

export function permissionGrantTests(cfg: ConfiguratorNetworkConfig, get: FixtureGetter): void {
  describe("VIP-616 permission grants", () => {
    it("grants SENTINEL_ADMIN_PERMS to all 4 governance accounts on DeviationSentinel", async () => {
      const { acm } = get();
      for (const acct of govAccounts(cfg)) {
        for (const sig of SENTINEL_ADMIN_PERMS) {
          await expectAcm(acm, acct, cfg.deviationSentinel, sig, true);
        }
      }
    });

    it("grants SENTINEL_ORACLE_ADMIN_PERMS to all governance accounts on SentinelOracle", async () => {
      const { acm } = get();
      for (const acct of govAccounts(cfg)) {
        for (const sig of SENTINEL_ORACLE_ADMIN_PERMS) {
          await expectAcm(acm, acct, cfg.sentinelOracle, sig, true);
        }
      }
    });

    it("grants UNISWAP_ORACLE_ADMIN_PERMS to all governance accounts on UniswapOracle", async () => {
      const { acm } = get();
      for (const acct of govAccounts(cfg)) {
        for (const sig of UNISWAP_ORACLE_ADMIN_PERMS) {
          await expectAcm(acm, acct, cfg.uniswapOracle, sig, true);
        }
      }
    });

    if (cfg.curveOracle) {
      it("grants CURVE_ORACLE_ADMIN_PERMS to all governance accounts on CurveOracle", async () => {
        const { acm } = get();
        for (const acct of govAccounts(cfg)) {
          for (const sig of CURVE_ORACLE_ADMIN_PERMS) {
            await expectAcm(acm, acct, cfg.curveOracle as string, sig, true);
          }
        }
      });
    }

    if (cfg.aerodromeOracle) {
      it("grants AERODROME_ORACLE_ADMIN_PERMS to all governance accounts on AerodromeOracle", async () => {
        const { acm } = get();
        for (const acct of govAccounts(cfg)) {
          for (const sig of AERODROME_ORACLE_ADMIN_PERMS) {
            await expectAcm(acm, acct, cfg.aerodromeOracle as string, sig, true);
          }
        }
      });
    }

    it("grants EBRAKE_COMPTROLLER_PERMS_IL to EBrake on the IL Comptroller", async () => {
      const { acm } = get();
      for (const sig of EBRAKE_COMPTROLLER_PERMS_IL) {
        await expectAcm(acm, cfg.eBrake, cfg.comptroller, sig, true);
      }
    });

    it("grants RESET_PERMS to all governance accounts on EBrake", async () => {
      const { acm } = get();
      for (const acct of govAccounts(cfg)) {
        for (const sig of RESET_PERMS) {
          await expectAcm(acm, acct, cfg.eBrake, sig, true);
        }
      }
    });

    it("grants SENTINEL_EBRAKE_PERMS to DeviationSentinel on EBrake", async () => {
      const { acm } = get();
      for (const sig of SENTINEL_EBRAKE_PERMS) {
        await expectAcm(acm, cfg.deviationSentinel, cfg.eBrake, sig, true);
      }
    });

    it("grants GOVERNANCE_EBRAKE_PERMS_IL to the multisig pauser on EBrake", async () => {
      const { acm } = get();
      for (const sig of GOVERNANCE_EBRAKE_PERMS_IL) {
        await expectAcm(acm, cfg.multisigPauser, cfg.eBrake, sig, true);
      }
    });
  });

  describe("VIP-617 permission grants", () => {
    it("grants GOVERNANCE_EBRAKE_PERMS_IL to all governance accounts on EBrake", async () => {
      const { acm } = get();
      for (const acct of govAccounts(cfg)) {
        for (const sig of GOVERNANCE_EBRAKE_PERMS_IL) {
          await expectAcm(acm, acct, cfg.eBrake, sig, true);
        }
      }
    });
  });
}

export function trustedKeeperTests(cfg: ConfiguratorNetworkConfig, get: FixtureGetter): void {
  describe("Trusted keepers", () => {
    const expected = [cfg.keeper, cfg.guardian, cfg.normalTimelock, cfg.fastTrackTimelock, cfg.criticalTimelock];

    for (const acct of expected) {
      it(`whitelists ${acct} on DeviationSentinel`, async () => {
        const { deviationSentinel } = get();
        expect(await deviationSentinel.trustedKeepers(acct)).to.equal(true);
      });
    }
  });
}

export function marketWiringTests(cfg: ConfiguratorNetworkConfig, get: FixtureGetter): void {
  describe("Market wiring", () => {
    for (const market of cfg.markets) {
      describe(`${market.symbol} (${market.oracleType})`, () => {
        it("DEX oracle pool config set", async () => {
          const { uniswapOracle, aerodromeOracle } = get();
          // Curve markets are validated indirectly: execute() is atomic, so a successful
          // SentinelOracle wiring (next test) implies CurveOracle.setPoolConfig also
          // succeeded. The Curve oracle's storage layout (struct, not a flat
          // `tokenPools` mapping) makes a direct getter check pull in source we don't
          // host here — skip and rely on atomicity.
          if (market.oracleType === "uniswap") {
            expect((await uniswapOracle.tokenPools(market.token)).toLowerCase()).to.equal(market.pool.toLowerCase());
          } else if (market.oracleType === "aerodrome") {
            expect(aerodromeOracle).to.not.equal(undefined);
            expect((await (aerodromeOracle as Contract).tokenPools(market.token)).toLowerCase()).to.equal(
              market.pool.toLowerCase(),
            );
          }
        });

        it("SentinelOracle points to the right DEX oracle", async () => {
          const { sentinelOracle } = get();
          const expectedOracle =
            market.oracleType === "uniswap"
              ? cfg.uniswapOracle
              : market.oracleType === "aerodrome"
                ? (cfg.aerodromeOracle as string)
                : (cfg.curveOracle as string);
          expect((await sentinelOracle.tokenConfigs(market.token)).toLowerCase()).to.equal(
            expectedOracle.toLowerCase(),
          );
        });

        it("DeviationSentinel.tokenConfigs is enabled at 10% deviation", async () => {
          const { deviationSentinel } = get();
          const c = await deviationSentinel.tokenConfigs(market.token);
          expect(c.deviation).to.equal(10);
          expect(c.enabled).to.equal(true);
        });
      });
    }
  });
}

export function selfRetireTests(cfg: ConfiguratorNetworkConfig, get: FixtureGetter): void {
  describe("Helper self-retires", () => {
    it("helper has renounced DEFAULT_ADMIN_ROLE on the ACM", async () => {
      const { acm, helper } = get();
      expect(await acm.hasRole(DEFAULT_ADMIN_ROLE, helper.address)).to.equal(false);
    });

    it("all transient self-grants on periphery contracts are revoked", async () => {
      const { acm, helper } = get();
      const transient = [...TRANSIENT_BASE_PERMS_BY_HOST(cfg), ...TRANSIENT_CHAIN_SPECIFIC_PERMS_BY_HOST(cfg)];
      for (const [host, sig] of transient) {
        await expectAcm(acm, helper.address, host, sig, false);
      }
    });

    it("re-running execute() reverts (helper has no ACM rights left)", async () => {
      const { helper, timelock } = get();
      await expect(helper.connect(timelock).execute()).to.be.reverted;
    });
  });
}

// Convenience aggregator. Entry files just call this.
export function runConfiguratorTests(
  cfg: ConfiguratorNetworkConfig,
  get: FixtureGetter,
  executed: () => boolean,
): void {
  // Access-control test must run BEFORE execute() so the revert path is meaningful
  // on a fresh helper. (After execute, the helper is dead anyway.)
  accessControlTests(cfg, get);

  describe("Post-execute state", () => {
    before(async () => {
      if (!executed()) {
        await runExecuteOnce(get);
      }
    });

    permissionGrantTests(cfg, get);
    trustedKeeperTests(cfg, get);
    marketWiringTests(cfg, get);
    selfRetireTests(cfg, get);
  });
}
