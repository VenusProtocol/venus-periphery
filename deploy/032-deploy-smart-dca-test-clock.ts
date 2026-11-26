import { ethers } from "ethers";
import hre from "hardhat";
import { DeployFunction } from "hardhat-deploy/dist/types";
import { DeployResult, DeploymentsExtension } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig } from "../helpers/deploymentConfig";

/** A separate SmartDCA on a 10 minute clock for the backend's rehearsals; testnet only. */
const SUPPORTED_NETWORKS = ["bsctestnet"];

const ROUND_LENGTH = 10 * 60;
const FORCE_BUY_DELAY = 60 * 60;

/** Keeper of the copy, backend signer of its SwapHelper, and the account every admin function is granted to. */
const OPERATOR = "0xeb7C78B4FE5DEC386983e86F14733D7F675983c2";

// Pairs and settings of VIP-684 (vips `vips/vip-684/bsctestnet.ts`)
const USDT = "0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c";
const USDC = "0x16227D60f7a0e586C66B005219dfc887D13C9531";
const U = "0x180Bc1a9843A65D4116e44886FD3558515a56A49";
const BTCB = "0xA808e341e8e723DC6BA0Bb5204Bafc2330d7B8e4";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const HUB_USDT = "0x7cE6ADF754D0eC81A6CF8ACd9C7454F45077dc61";
const vUSDC = "0xD5C4C2e2facBEB59D0216D0595d63FcDc6F9A1a7";
const vU = "0x93969F17d4c1C7B22000eA26D5C2766E0f616D90";
const vBTC = "0xb6e9322C49FD75a367Fcb17B0Fcd62C5070EbCBe";
const vWBNB = "0xd9E77847ec815E56ae2B9E69596C69b6972b0B1C";
const PCS_V3_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const HUB = 1;
const CORE = 2;
const PAIRS: [string, string, number, string, number, string][] = [
  [USDT, BTCB, HUB, HUB_USDT, CORE, vBTC],
  [USDT, WBNB, HUB, HUB_USDT, CORE, vWBNB],
  [USDC, BTCB, CORE, vUSDC, CORE, vBTC],
  [USDC, WBNB, CORE, vUSDC, CORE, vWBNB],
  [U, BTCB, CORE, vU, CORE, vBTC],
  [U, WBNB, CORE, vU, CORE, vWBNB],
];
const USDT_WBNB_PAIR_ID = 2;
const USDT_WBNB_PATH = ethers.utils.solidityPack(["address", "uint24", "address"], [USDT, 100, WBNB]);
const ALLOWED_ROUTERS = [PCS_V3_ROUTER, USDT, USDC, U, BTCB, WBNB];
const MIN_AMOUNT_PER_BUY: [string, ethers.BigNumber][] = [
  [USDT, ethers.utils.parseUnits("10", 6)],
  [USDC, ethers.utils.parseUnits("10", 6)],
  [U, ethers.utils.parseUnits("10", 18)],
];
const FEE_RATE_BPS = 0;
const MAX_ORACLE_DEVIATION_BPS = 100;
const SMART_DCA_PERMISSIONS = [
  "addPair(address,address,uint8,address,uint8,address)",
  "setYieldSource(uint32,uint8,uint8,address)",
  "setPairEnabled(uint32,bool)",
  "setMinAmountPerBuy(address,uint256)",
  "setBuyBounds(uint8,uint8)",
  "setKeeper(address,bool)",
  "setAllowedRouter(address,bool)",
  "setFallbackRoute(uint32,address,bytes)",
  "setFallbackSlippage(uint16)",
  "setMaxSlippage(uint16)",
  "setMaxOracleDeviation(uint16)",
  "setMaxParts(uint8)",
  "setFeeRate(uint16)",
  "setMaxFeeRate(uint16)",
  "setReserve(address)",
  "sweepToken(address,address)",
  "pause()",
  "unpause()",
  "forceBuy(uint32,uint8)",
];
const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero;

const ACM = "SmartDCA_DCATest_AccessControlManager";
const SWAP_HELPER = "SwapHelper_DCATest";
const DCA = "SmartDCA_DCATest";

interface Ctx {
  deployments: DeploymentsExtension;
  deployer: string;
  live: boolean;
}

async function verify(address: string | undefined, constructorArguments: unknown[]): Promise<void> {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (e) {
    console.log(`verify failed: ${(e as Error).message}`);
  }
}

async function deployVerified(
  { deployments, deployer, live }: Ctx,
  name: string,
  contract: string,
  args: unknown[],
): Promise<DeployResult> {
  const result = await deployments.deploy(name, { contract, from: deployer, log: true, args });
  if (result.newlyDeployed && live) await verify(result.address, args);
  return result;
}

async function deployCopy(ctx: Ctx, networkName: string): Promise<DeployResult> {
  const { deployments, deployer, live } = ctx;
  const ADDRESSES = await getConfig(networkName);
  const { HubRegistry, ResilientOracle } = ADDRESSES.preconfiguredAddresses;
  const comptroller = (await deployments.get("Unitroller")).address;
  const reserve = (await deployments.get("VTreasury")).address;

  const acm = await deployVerified(ctx, ACM, "DCATestAccessControlManager", []);
  const swapHelper = await deployVerified(ctx, SWAP_HELPER, "SwapHelper", [OPERATOR]);
  const adminLib = await deployVerified(ctx, "SmartDCAAdminLib_DCATest", "SmartDCAAdminLib", []);

  const latest = await hre.ethers.provider.getBlock("latest");
  const anchorTime = latest.timestamp - (latest.timestamp % ROUND_LENGTH);
  const args = [
    comptroller,
    HubRegistry,
    ResilientOracle,
    swapHelper.address,
    ROUND_LENGTH,
    anchorTime,
    FORCE_BUY_DELAY,
  ];
  const proxyAdmin = await hre.artifacts.readArtifact(
    "hardhat-deploy/solc_0.8/openzeppelin/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
  );
  const dca = await deployments.deploy(DCA, {
    contract: "SmartDCATestClock",
    from: deployer,
    log: true,
    args,
    libraries: { SmartDCAAdminLib: adminLib.address },
    proxy: {
      owner: deployer,
      proxyContract: "OptimizedTransparentUpgradeableProxy",
      execute: { methodName: "initialize", args: [acm.address, reserve] },
      viaAdminContract: { name: "SmartDCA_DCATest_ProxyAdmin", artifact: proxyAdmin },
    },
  });
  if (dca.newlyDeployed && live) await verify(dca.implementation, args);
  return dca;
}

/** Every admin function to the operator and, for the configuration, the deployer; the operator administers the ACM. */
async function grantPermissions({ deployments, deployer }: Ctx, dca: string): Promise<void> {
  const { execute, read } = deployments;
  for (const account of [OPERATOR, deployer]) {
    for (const sig of SMART_DCA_PERMISSIONS) {
      if (await read(ACM, "hasPermission", account, dca, sig)) continue;
      await execute(ACM, { from: deployer, log: true }, "giveCallPermission", dca, sig, account);
    }
  }
  if (!(await read(ACM, "hasRole", DEFAULT_ADMIN_ROLE, OPERATOR))) {
    await execute(ACM, { from: deployer, log: true }, "grantRole", DEFAULT_ADMIN_ROLE, OPERATOR);
  }
}

/** The configuration of VIP-684 with the operator as keeper; every step is skipped once done. */
async function configure({ deployments, deployer }: Ctx): Promise<void> {
  const { execute, read } = deployments;
  const run = (method: string, ...args: unknown[]) => execute(DCA, { from: deployer, log: true }, method, ...args);
  for (const [stable, amount] of MIN_AMOUNT_PER_BUY) {
    if ((await read(DCA, "minAmountPerBuy", stable)).eq(0)) await run("setMinAmountPerBuy", stable, amount);
  }
  if ((await read(DCA, "feeRateBps")) !== FEE_RATE_BPS) await run("setFeeRate", FEE_RATE_BPS);
  if ((await read(DCA, "maxOracleDeviationBps")) !== MAX_ORACLE_DEVIATION_BPS) {
    await run("setMaxOracleDeviation", MAX_ORACLE_DEVIATION_BPS);
  }
  const pairCount = Number(await read(DCA, "pairCount"));
  for (const pair of PAIRS.slice(pairCount)) await run("addPair", ...pair);
  const route = await read(DCA, "fallbackRoutes", USDT_WBNB_PAIR_ID);
  if (route.router === ethers.constants.AddressZero) {
    await run("setFallbackRoute", USDT_WBNB_PAIR_ID, PCS_V3_ROUTER, USDT_WBNB_PATH);
  }
  if (!(await read(DCA, "isKeeper", OPERATOR))) await run("setKeeper", OPERATOR, true);
  for (const router of ALLOWED_ROUTERS) {
    if (!(await read(DCA, "allowedRouters", router))) await run("setAllowedRouter", router, true);
  }
}

/** Both contracts are Ownable2Step: the operator completes each transfer with `acceptOwnership`. */
async function handOver({ deployments, deployer }: Ctx): Promise<void> {
  for (const name of [DCA, SWAP_HELPER]) {
    const owner = await deployments.read(name, "owner");
    const pending = await deployments.read(name, "pendingOwner");
    if (owner === deployer && pending !== OPERATOR) {
      await deployments.execute(name, { from: deployer, log: true }, "transferOwnership", OPERATOR);
    }
  }
}

/**
 * Deploys, under names of their own so the live testnet records stay untouched, an AccessControlManager for the copy,
 * a SwapHelper signed by the operator, SmartDCAAdminLib and the SmartDCATestClock proxy behind a ProxyAdmin of its own;
 * then configures the copy like VIP-684 and hands every role to the operator. The existing SmartDCALens serves it.
 */
const func: DeployFunction = async function ({ getNamedAccounts, deployments, network }: HardhatRuntimeEnvironment) {
  const { deployer } = await getNamedAccounts();
  const ctx: Ctx = { deployments, deployer, live: network.live };
  const dca = await deployCopy(ctx, hre.getNetworkName());
  await grantPermissions(ctx, dca.address);
  await configure(ctx);
  await handOver(ctx);
  const lens = (await deployments.get("SmartDCALens")).address;
  deployments.log(`SmartDCA copy ${dca.address} (lens ${lens}); ${OPERATOR} accepts ownership with acceptOwnership()`);
};

export default func;
func.tags = ["smart-dca-test-clock"];
func.skip = async (hre: HardhatRuntimeEnvironment) => !SUPPORTED_NETWORKS.includes(hre.getNetworkName());
