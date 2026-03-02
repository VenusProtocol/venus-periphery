import { impersonateAccount, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  ACCESS_CONTROL_MANAGER,
  BSC_CHAIN_ID,
  COMPTROLLER,
  NORMAL_TIMELOCK,
  PENDLE_MARKET,
  PENDLE_ROUTER_V3,
  SLISBNB,
  VTOKEN_PT_CLISBNBX_25JUN2026,
  WBNB,
  WBNB_WHALE,
} from "./constants";
import {
  getSlisbnbViaListaDeposit,
  increaseListaOracleTimeDeltaTolerance,
  increaseVenusOracleMaxStalePeriod,
} from "./helpers";
import { getPendleSwapParams } from "./pendleApi";

// ── Fixture Return Types ────────────────────────────────────────────────

export interface BaseFixture {
  adapter: Contract;
  owner: SignerWithAddress;
  user: SignerWithAddress;
  wbnb: Contract;
  slisbnb: Contract;
  vToken: Contract;
  ptToken: Contract;
  comptroller: Contract;
  marketAddress: string;
}

export interface DepositedFixture extends BaseFixture {
  depositPtAmount: BigNumber;
  depositVTokenAmount: BigNumber;
}

export type MaturedWithDepositsFixture = DepositedFixture;

// ── Base Fixture ────────────────────────────────────────────────────────
//
// Deploys adapter behind TransparentUpgradeableProxy, registers the
// PT-clisBNBx-25JUN2026 market, acquires slisBNB for the user.

export async function baseFixture(): Promise<BaseFixture> {
  const [owner] = await ethers.getSigners();

  // Impersonate whale as user
  await impersonateAccount(WBNB_WHALE);
  await setBalance(WBNB_WHALE, parseUnits("100", 18));
  const user = await ethers.getSigner(WBNB_WHALE);

  // Contract instances
  const wbnb = await ethers.getContractAt("IERC20", WBNB);
  const slisbnb = await ethers.getContractAt("IERC20", SLISBNB);
  const vToken = await ethers.getContractAt("IVenusVToken", VTOKEN_PT_CLISBNBX_25JUN2026);
  const comptroller = await ethers.getContractAt("IMarketFacet", COMPTROLLER);

  // Use the mainnet ACM — NORMAL_TIMELOCK holds DEFAULT_ADMIN_ROLE
  const acm = await ethers.getContractAt(
    ["function giveCallPermission(address, string, address) external"],
    ACCESS_CONTROL_MANAGER,
  );
  await impersonateAccount(NORMAL_TIMELOCK);
  await setBalance(NORMAL_TIMELOCK, parseUnits("1", 18));
  const timelockSigner = await ethers.getSigner(NORMAL_TIMELOCK);

  // Deploy implementation
  const PendlePTVaultAdapter = await ethers.getContractFactory("PendlePTVaultAdapter");
  const implementation = await PendlePTVaultAdapter.deploy(PENDLE_ROUTER_V3, COMPTROLLER);
  await implementation.deployed();

  // Deploy proxy
  const proxyAdminAddress = "0x0000000000000000000000000000000000000001";
  const data = implementation.interface.encodeFunctionData("initialize", [ACCESS_CONTROL_MANAGER]);
  const TransparentUpgradeableProxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
  );
  const proxy = await TransparentUpgradeableProxy.deploy(implementation.address, proxyAdminAddress, data);
  await proxy.deployed();

  const adapter = await ethers.getContractAt("PendlePTVaultAdapter", proxy.address);

  // Grant ACM permissions to the owner via impersonated NORMAL_TIMELOCK (holds DEFAULT_ADMIN_ROLE)
  const acmGuardedFunctions = [
    "addMarket(address,address)",
    "pause()",
    "unpause()",
  ];
  for (const funcSig of acmGuardedFunctions) {
    await acm.connect(timelockSigner).giveCallPermission(adapter.address, funcSig, owner.address);
  }

  // Register market
  await adapter.connect(owner).addMarket(PENDLE_MARKET, VTOKEN_PT_CLISBNBX_25JUN2026);

  // Get PT token
  const marketConfig = await adapter.getMarketConfig(PENDLE_MARKET);
  const ptToken = await ethers.getContractAt("IERC20", marketConfig.pt);

  // Acquire slisBNB for user (15 BNB worth -- enough for all deposit tests)
  await getSlisbnbViaListaDeposit(user, slisbnb, parseUnits("15", 18));

  return {
    adapter,
    owner,
    user,
    wbnb,
    slisbnb,
    vToken,
    ptToken,
    comptroller,
    marketAddress: PENDLE_MARKET,
  };
}

// ── Deposited Fixture ───────────────────────────────────────────────────
//
// Extends baseFixture: deposits 5 slisBNB through the adapter to obtain
// vTokens. Delegation is enabled. Use this for withdraw tests.

export async function depositedFixture(): Promise<DepositedFixture> {
  const base = await baseFixture();
  const depositAmount = parseUnits("5", 18);

  // Fetch swap params from Pendle API
  const marketConfig = await base.adapter.getMarketConfig(base.marketAddress);
  const { minPtOut, approxParams, tokenInput, limitOrderData } = await getPendleSwapParams(
    BSC_CHAIN_ID,
    SLISBNB,
    marketConfig.pt,
    depositAmount,
    base.user.address,
    0.03,
    false,
  );

  // Approve adapter and enable delegation
  await base.slisbnb.connect(base.user).approve(base.adapter.address, depositAmount);
  await base.comptroller.connect(base.user).updateDelegate(base.adapter.address, true);

  // Deposit to get vTokens
  const tx = await base.adapter
    .connect(base.user)
    .deposit(base.marketAddress, minPtOut, approxParams, tokenInput, limitOrderData);
  const receipt = await tx.wait();

  // Extract deposit amounts from event
  const depositedEvent = receipt.events?.find((e: any) => e.event === "Deposited");
  const depositPtAmount: BigNumber = depositedEvent!.args!.ptAmount;
  const depositVTokenAmount: BigNumber = depositedEvent!.args!.vTokenAmount;

  return {
    ...base,
    depositPtAmount,
    depositVTokenAmount,
  };
}

// ── Matured With Deposits Fixture ───────────────────────────────────────
//
// Extends depositedFixture: fixes oracle staleness and time-travels past
// PT maturity. Use this for redeemAtMaturity tests.

export async function maturedWithDepositsFixture(): Promise<MaturedWithDepositsFixture> {
  const deposited = await depositedFixture();

  // Fix oracle staleness BEFORE time travel
  await increaseVenusOracleMaxStalePeriod();
  await increaseListaOracleTimeDeltaTolerance();

  // Time travel past maturity
  const marketConfig = await deposited.adapter.getMarketConfig(deposited.marketAddress);
  const maturity = marketConfig.maturity.toNumber();
  await time.increaseTo(maturity + 1);

  return deposited;
}
