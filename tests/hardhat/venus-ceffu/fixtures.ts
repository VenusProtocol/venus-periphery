import { FakeContract, smock } from "@defi-wonderland/smock";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { parseUnits } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";

import {
  FixedRateVault,
  FundRouter,
  IAccessControlManagerV8,
  MockToken,
  VaultFactory,
} from "../../../typechain";

export type VaultInitParams = {
  supplyAsset: string;
  name: string;
  symbol: string;
  ceffuRequestId: string;
  fixedAPY: string | number;
  minCap: string;
  maxCap: string;
  fundraisingStartTime: number;
  fundraisingEndTime: number;
  lockPeriodDuration: number;
  reserveFactorBps: number;
  minUserDeposit: string;
  maxUserDeposit: string;
  gracePeriod: number;
};

export const THIRTY_DAYS = 30 * 24 * 60 * 60;
export const SEVEN_DAYS = 7 * 24 * 60 * 60;

export async function defaultVaultParams(
  tokenAddress: string,
  overrides?: Partial<VaultInitParams>,
): Promise<VaultInitParams> {
  const now = await time.latest();

  return {
    supplyAsset: tokenAddress,
    name: "Venus Fixed Rate USDC #001",
    symbol: "vfrUSDC-001",
    ceffuRequestId: "CR-0001",
    fixedAPY: 500, // 5%
    minCap: parseUnits("1000", 18).toString(),
    maxCap: parseUnits("10000", 18).toString(),
    fundraisingStartTime: now + 60,
    fundraisingEndTime: now + 3600,
    lockPeriodDuration: THIRTY_DAYS,
    reserveFactorBps: 1000, // 10%
    minUserDeposit: parseUnits("100", 18).toString(),
    maxUserDeposit: parseUnits("5000", 18).toString(),
    gracePeriod: SEVEN_DAYS,
    ...overrides,
  };
}

export interface FullSystemFixture {
  owner: SignerWithAddress;
  alice: SignerWithAddress;
  bob: SignerWithAddress;
  treasury: SignerWithAddress;
  ceffuWallet: SignerWithAddress;
  acm: FakeContract<IAccessControlManagerV8>;
  usdcToken: MockToken;
  vaultImpl: FixedRateVault;
  fundRouter: FundRouter;
  factory: VaultFactory;
  vault: FixedRateVault;
  vaultAddress: string;
  params: VaultInitParams;
}

export async function deployFullSystemFixture(): Promise<FullSystemFixture> {
  const [owner, alice, bob, treasury, ceffuWallet] = await ethers.getSigners();

  // Mock ACM — allow all calls by default
  const acm = await smock.fake<IAccessControlManagerV8>("IAccessControlManagerV8");
  acm.isAllowedToCall.returns(true);

  // Real MockToken (18 decimals)
  const MockTokenFactory = await ethers.getContractFactory("MockToken");
  const usdcToken = (await MockTokenFactory.deploy("USD Coin", "USDC", 18)) as MockToken;

  // Real FixedRateVault implementation (for cloning — constructor disables initializers)
  const VaultImplFactory = await ethers.getContractFactory("FixedRateVault");
  const vaultImpl = (await VaultImplFactory.deploy()) as FixedRateVault;

  // Chicken-and-egg: Factory needs FundRouter address, FundRouter needs Factory address.
  // Solve: deploy factory with placeholder fundRouter, then deploy router, then update factory.

  const FundRouterFactory = await ethers.getContractFactory("FundRouter");
  const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");

  // Step 1: Deploy factory with owner as placeholder fundRouter
  const factory = (await upgrades.deployProxy(
    VaultFactoryFactory,
    [acm.address, vaultImpl.address, owner.address],
    { unsafeAllow: ["constructor"] },
  )) as VaultFactory;

  // Step 2: Deploy FundRouter with the real factory address
  const fundRouter = (await upgrades.deployProxy(FundRouterFactory, [acm.address, factory.address], {
    unsafeAllow: ["constructor"],
  })) as FundRouter;

  // Step 3: Update factory to point to the real fundRouter
  await factory.setFundRouter(fundRouter.address);

  // Approve token as an approved asset on FundRouter
  await fundRouter.setAssetApproval(usdcToken.address, true);

  // Mint tokens to alice & bob (100k each)
  const mintAmount = parseUnits("100000", 18);
  await usdcToken.connect(alice).faucet(mintAmount);
  await usdcToken.connect(bob).faucet(mintAmount);

  // Deploy one vault clone via factory
  const params = await defaultVaultParams(usdcToken.address);
  await factory.deployVault(params);

  // Get vault address from the factory mapping (more reliable than event parsing
  // since VaultDeployed has an indexed string which ethers hashes)
  const vaultAddress = await factory.vaultByCeffuRequestId("CR-0001");
  const vault = (await ethers.getContractAt("FixedRateVault", vaultAddress)) as FixedRateVault;

  return {
    owner,
    alice,
    bob,
    treasury,
    ceffuWallet,
    acm,
    usdcToken,
    vaultImpl,
    fundRouter,
    factory,
    vault,
    vaultAddress,
    params,
  };
}
