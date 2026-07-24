// Fixtures for the slisBNB-specialized child adapter (PendlePTSlisBNBVaultAdapter).
//
// Deploys the CHILD (with its five constructor immutables) so the Lista unstake lifecycle
// (requestWithdraw / claimUnstaked) is exercised against the real deployed Lista StakeManager
// and Pendle router on a fork.
//
// The pinned fork block is already PAST the PT market's maturity, which is the natural state
// for unstaking: a user redeems a matured PT position and unstakes the slisBNB. Because PT can
// no longer be minted or swapped-into post-expiry, the vToken position is seeded by borrowing
// real PT from the market's AMM reserve and supplying it into Venus — fully on-chain, no
// time-sensitive Pendle hosted API.
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import {
  ACCESS_CONTROL_MANAGER,
  COMPTROLLER,
  LISTA_STAKE_MANAGER,
  LISTA_UNBOND_PERIOD,
  NORMAL_TIMELOCK,
  PENDLE_MARKET,
  PENDLE_ROUTER_V3,
  SLISBNB,
  VTOKEN_PT_CLISBNBX_25JUN2026,
  WBNB_WHALE,
} from "./constants";
import { increaseListaOracleTimeDeltaTolerance, increaseVenusOracleMaxStalePeriod } from "./helpers";
import { getListaManager } from "./listaUnstake";

// ── Fixture Return Types ────────────────────────────────────────────────

export interface SlisBaseFixture {
  adapter: Contract;
  owner: SignerWithAddress;
  user: SignerWithAddress;
  slisbnb: Contract;
  vToken: Contract;
  ptToken: Contract;
  comptroller: Contract;
  lista: Contract;
  marketAddress: string;
}

export interface SlisDepositedFixture extends SlisBaseFixture {
  depositPtAmount: BigNumber;
  depositVTokenAmount: BigNumber;
}

export type SlisMaturedFixture = SlisDepositedFixture;

export interface SlisRequestedFixture extends SlisMaturedFixture {
  uuid: BigNumber;
  idx: number;
  // BNB Lista locked for the request at request time (== the adapter's amountInBnb snapshot,
  // read back from Lista since the adapter does not expose it).
  expectedBnb: BigNumber;
  amountInSnBnb: BigNumber;
}

// ── Market registration (post-maturity) ─────────────────────────────────
//
// addMarket() refuses an already-matured market (MarketAlreadyMatured) and Pendle's expiry()
// is immutable, so at a post-maturity fork the market that was registered on mainnet pre-maturity
// is reproduced by writing the adapter's `markets` mapping directly. The token addresses and
// maturity are read from the real Pendle market; the `markets` slot is located by fingerprint and
// every write is confirmed through the contract's own getters (a layout shift fails loudly).

const slotHex = (v: BigNumber | number) => ethers.utils.hexZeroPad(BigNumber.from(v).toHexString(), 32);
const wordOf = (v: BigNumber | number | string) => ethers.utils.hexZeroPad(BigNumber.from(v).toHexString(), 32);
const addrWord = (a: string) => ethers.utils.hexZeroPad(a, 32);

async function forceRegisterMarket(adapter: Contract, market: string, vToken: string): Promise<void> {
  const ipMarket = await ethers.getContractAt(
    [
      "function readTokens() view returns (address SY, address PT, address YT)",
      "function expiry() view returns (uint256)",
    ],
    market,
  );
  const [sy, pt, yt] = await ipMarket.readTokens();
  const maturity: BigNumber = await ipMarket.expiry();

  const coder = ethers.utils.defaultAbiCoder;

  // Locate the `markets` mapping slot: write the pt field at keccak(market, n) and confirm via the
  // real markets(market).pt getter; restore on a miss so no unrelated storage is left mutated.
  let base: BigNumber | null = null;
  let mappingSlot = 0;
  for (let n = 0; n < 384; n++) {
    const candidate = BigNumber.from(ethers.utils.keccak256(coder.encode(["address", "uint256"], [market, n])));
    const prev = await ethers.provider.getStorageAt(adapter.address, slotHex(candidate));
    await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(candidate), addrWord(pt)]);
    if ((await adapter.markets(market)).pt.toLowerCase() === pt.toLowerCase()) {
      base = candidate;
      mappingSlot = n;
      break;
    }
    await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(candidate), prev]);
  }
  if (base === null) throw new Error("forceRegisterMarket: could not locate markets mapping slot");

  // Struct fields: pt(+0, already set), sy(+1), yt(+2), vToken(+3), maturity(+4).
  await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(base.add(1)), addrWord(sy)]);
  await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(base.add(2)), addrWord(yt)]);
  await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(base.add(3)), addrWord(vToken)]);
  await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(base.add(4)), wordOf(maturity)]);

  // marketList is declared immediately after markets => slot (mappingSlot + 1): length 1, element[0]=market.
  const listSlot = mappingSlot + 1;
  await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(listSlot), wordOf(1)]);
  const elem0 = BigNumber.from(ethers.utils.keccak256(slotHex(listSlot)));
  await ethers.provider.send("hardhat_setStorageAt", [adapter.address, slotHex(elem0), addrWord(market)]);

  // Confirm the whole registration through the public getters.
  const cfg = await adapter.markets(market);
  const all: string[] = await adapter.getAllMarkets();
  const ok =
    cfg.pt.toLowerCase() === pt.toLowerCase() &&
    cfg.sy.toLowerCase() === sy.toLowerCase() &&
    cfg.yt.toLowerCase() === yt.toLowerCase() &&
    cfg.vToken.toLowerCase() === vToken.toLowerCase() &&
    cfg.maturity.eq(maturity) &&
    all.length === 1 &&
    all[0].toLowerCase() === market.toLowerCase();
  if (!ok) throw new Error("forceRegisterMarket: registration verification failed");
}

// ── Base Fixture ────────────────────────────────────────────────────────
//
// Deploys the child adapter behind TransparentUpgradeableProxy and registers the
// PT-clisBNBx-25JUN2026 market (via storage, since the fork block is post-maturity). No deposit yet.

export async function slisBaseFixture(): Promise<SlisBaseFixture> {
  const [owner] = await ethers.getSigners();

  // Impersonate whale as user (just needs gas; the vToken position is seeded below)
  await impersonateAccount(WBNB_WHALE);
  await setBalance(WBNB_WHALE, parseUnits("100", 18));
  const user = await ethers.getSigner(WBNB_WHALE);

  const slisbnb = await ethers.getContractAt("IERC20", SLISBNB);
  const vToken = await ethers.getContractAt("IVenusVToken", VTOKEN_PT_CLISBNBX_25JUN2026);
  const comptroller = await ethers.getContractAt("IMarketFacet", COMPTROLLER);
  const lista = await getListaManager();

  // Use the mainnet ACM — NORMAL_TIMELOCK holds DEFAULT_ADMIN_ROLE
  const acm = await ethers.getContractAt(
    ["function giveCallPermission(address, string, address) external"],
    ACCESS_CONTROL_MANAGER,
  );
  await impersonateAccount(NORMAL_TIMELOCK);
  await setBalance(NORMAL_TIMELOCK, parseUnits("1", 18));
  const timelockSigner = await ethers.getSigner(NORMAL_TIMELOCK);

  // Deploy implementation with the child's five constructor immutables
  const Factory = await ethers.getContractFactory("PendlePTSlisBNBVaultAdapter");
  const implementation = await Factory.deploy(
    PENDLE_ROUTER_V3,
    COMPTROLLER,
    SLISBNB,
    LISTA_STAKE_MANAGER,
    LISTA_UNBOND_PERIOD,
  );
  await implementation.deployed();

  // Deploy proxy
  const proxyAdminAddress = "0x0000000000000000000000000000000000000001";
  const data = implementation.interface.encodeFunctionData("initialize", [ACCESS_CONTROL_MANAGER]);
  const TransparentUpgradeableProxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
  );
  const proxy = await TransparentUpgradeableProxy.deploy(implementation.address, proxyAdminAddress, data);
  await proxy.deployed();

  const adapter = await ethers.getContractAt("PendlePTSlisBNBVaultAdapter", proxy.address);

  // Grant ACM permissions to the owner via impersonated NORMAL_TIMELOCK (holds DEFAULT_ADMIN_ROLE).
  // requestWithdraw / claimUnstaked are not access-controlled, so only the inherited admin
  // functions need a grant.
  const acmGuardedFunctions = ["addMarket(address,address)", "pause()", "unpause()"];
  for (const funcSig of acmGuardedFunctions) {
    await acm.connect(timelockSigner).giveCallPermission(adapter.address, funcSig, owner.address);
  }

  await forceRegisterMarket(adapter, PENDLE_MARKET, VTOKEN_PT_CLISBNBX_25JUN2026);

  const marketConfig = await adapter.markets(PENDLE_MARKET);
  const ptToken = await ethers.getContractAt("IERC20", marketConfig.pt);

  return {
    adapter,
    owner,
    user,
    slisbnb,
    vToken,
    ptToken,
    comptroller,
    lista,
    marketAddress: PENDLE_MARKET,
  };
}

// ── vToken seeding ──────────────────────────────────────────────────────
//
// Creates a real Venus vToken position for `account`. Post-expiry PT can't be minted or swapped
// into, so PT is borrowed from the market's AMM reserve (harmless on a fork; no AMM invariant is
// asserted) and supplied into Venus via the real mint. Leaves the account delegated to the adapter
// so it can redeemBehalf during requestWithdraw. Returns the vTokens minted.

export async function seedVTokenPosition(
  base: { adapter: Contract; ptToken: Contract; vToken: Contract; comptroller: Contract },
  account: SignerWithAddress,
  seedPt: BigNumber,
): Promise<BigNumber> {
  await impersonateAccount(PENDLE_MARKET);
  await setBalance(PENDLE_MARKET, parseUnits("1", 18));
  const marketSigner = await ethers.getSigner(PENDLE_MARKET);
  await base.ptToken.connect(marketSigner).transfer(account.address, seedPt);

  const vTokenMintable = await ethers.getContractAt(["function mint(uint256) returns (uint256)"], base.vToken.address);
  await base.ptToken.connect(account).approve(base.vToken.address, seedPt);
  const before = await base.vToken.balanceOf(account.address);
  await vTokenMintable.connect(account).mint(seedPt);
  const minted = (await base.vToken.balanceOf(account.address)).sub(before);
  if (minted.isZero()) throw new Error("seedVTokenPosition: vToken mint produced 0 vTokens");

  await base.comptroller.connect(account).updateDelegate(base.adapter.address, true);
  return minted;
}

// ── Deposited Fixture ───────────────────────────────────────────────────
//
// Extends slisBaseFixture: seeds the user with a Venus vToken position backed by real PT and
// relaxes oracle staleness so the redeem holds up over a long fork run.

export async function slisDepositedFixture(): Promise<SlisDepositedFixture> {
  const base = await slisBaseFixture();
  const depositPtAmount = parseUnits("10", 18);
  const depositVTokenAmount = await seedVTokenPosition(base, base.user, depositPtAmount);

  // Widen oracle staleness tolerance (both Venus and Lista). Over a long fork run, newly mined
  // blocks drift ahead of the slisBNB/BNB feed timestamps; without this the redeem's resilient-oracle
  // price reads start reverting ("invalid resilient oracle price") once a test runs late enough.
  await increaseVenusOracleMaxStalePeriod();
  await increaseListaOracleTimeDeltaTolerance();

  return { ...base, depositPtAmount, depositVTokenAmount };
}

// ── Matured Fixture ─────────────────────────────────────────────────────
//
// The pinned fork block is already past PT maturity, so the seeded position is matured as-is;
// this alias keeps the test intent explicit.

export async function slisMaturedFixture(): Promise<SlisMaturedFixture> {
  return slisDepositedFixture();
}

// ── Requested Fixture ───────────────────────────────────────────────────
//
// Extends slisMaturedFixture: redeems the full vToken position and enqueues a single Lista
// unstake. The request is NOT yet confirmed (claims still revert) — claim tests drive
// confirmation themselves via forceConfirmListaRequest.

export async function slisRequestedFixture(): Promise<SlisRequestedFixture> {
  const matured = await slisMaturedFixture();

  const tx = await matured.adapter.connect(matured.user).requestWithdraw(
    matured.marketAddress,
    matured.depositVTokenAmount,
    0, // minSlisBnbOut: post-maturity PT->slisBNB is 1:1; assertions check the actual amount
  );
  const receipt = await tx.wait();

  const requestedEvent = receipt.events?.find((e: any) => e.event === "UnstakeRequested");
  const uuid: BigNumber = requestedEvent!.args!.uuid;

  // Resolve the adapter's index in Lista's request array and snapshot the locked BNB.
  const requests = await matured.lista.getUserWithdrawalRequests(matured.adapter.address);
  const idx = requests.findIndex((r: any) => r.uuid.eq(uuid));
  const [, expectedBnb] = await matured.lista.getUserRequestStatus(matured.adapter.address, idx);
  const amountInSnBnb: BigNumber = requests[idx].amountInSnBnb;

  return { ...matured, uuid, idx, expectedBnb, amountInSnBnb };
}
