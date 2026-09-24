// ═══════════════════════════════════════════════════════════════════════════
// Centrifuge's live BNB Chain deployment
// ═══════════════════════════════════════════════════════════════════════════
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber, BigNumberish } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { ICentrifugePoolEscrow__factory } from "../../../../typechain/factories/ICentrifugePoolEscrow__factory";
import { ICentrifugeRequestManager__factory } from "../../../../typechain/factories/ICentrifugeRequestManager__factory";
import { ICentrifugeSpoke__factory } from "../../../../typechain/factories/ICentrifugeSpoke__factory";
import { ICentrifugeTransferHook__factory } from "../../../../typechain/factories/ICentrifugeTransferHook__factory";
import { IERC20Metadata__factory } from "../../../../typechain/factories/IERC20Metadata__factory";
import { IERC20__factory } from "../../../../typechain/factories/IERC20__factory";
import { initMainnetUser } from "../utils";

export const CENTRIFUGE_ROOT = "0x7Ed48C31f2fdC40d37407cBaBf0870B2b688368f";
export const CENTRIFUGE_SPOKE = "0xEC3582fcDc34078a4B7a8c75a5a3AE46f48525aB";
export const CENTRIFUGE_MANAGER = "0xF48256AbDDf96EcDDc4B3DbD23E8C1921f9761Ae";

export interface Fund {
  vault: string;
  share: string;
  hook: string;
  poolId: string;
  scId: string;
}

// The two funds VIP-661 registered on the Centrifuge YieldGroup.
export const JTRSY: Fund = {
  vault: "0x6e6B8498415083a4386BE83DD59Edd4366402FFa",
  share: "0xa5d465251fBCc907f5Dd6bB2145488DFC6a2627b",
  hook: "0x21Cdcc686fECd9Fb0d3ee300E555C06497B55EcC",
  poolId: "281474976710662",
  scId: "0x00010000000000060000000000000001",
};

export const JAAA: Fund = {
  vault: "0xcbAfe61d84C6Fb88252a6Adf1C9CB0B9D029cb99",
  share: "0x58F93d6b1EF2F44eC379Cb975657C132CBeD3B6b",
  hook: "0x3C5E7B28c4fF6F0bc8d9A9587992E96401e680A7",
  poolId: "281474976710663",
  scId: "0x00010000000000070000000000000001",
};

// RequestCallbackType discriminants from Centrifuge's RequestCallbackMessageLib. Payloads are
// packed, and the investor travels as a left-aligned bytes32.
const APPROVED_DEPOSITS = 1;
const ISSUED_SHARES = 2;
const REVOKED_SHARES = 3;
const FULFILLED_DEPOSIT = 4;
const FULFILLED_REDEEM = 5;

const asInvestor = (holder: string) => ethers.utils.hexConcat([holder, ethers.constants.HashZero.slice(0, 26)]);

// ═══════════════════════════════════════════════════════════════════════════
// FUND CONTROLS
// ═══════════════════════════════════════════════════════════════════════════

export type FundControls = Awaited<ReturnType<typeof connectFund>>;

/**
 * Bind one live fund and return the levers a scenario needs to play Centrifuge's side: admitting an
 * investor, publishing a NAV, settling a request, and topping up what the pool can pay out.
 */
export async function connectFund(fund: Fund, asset: string, holder: string) {
  const root = await initMainnetUser(CENTRIFUGE_ROOT, parseUnits("10"));

  const spoke = ICentrifugeSpoke__factory.connect(CENTRIFUGE_SPOKE, root);
  const manager = ICentrifugeRequestManager__factory.connect(CENTRIFUGE_MANAGER, root);
  const hook = ICentrifugeTransferHook__factory.connect(fund.hook, root);
  const escrow = ICentrifugePoolEscrow__factory.connect(await manager.poolEscrow(fund.poolId), root);
  const shareToken = IERC20Metadata__factory.connect(fund.share, ethers.provider);

  const assetId = await spoke.assetToId(asset, 0);
  const assetPrice = await spoke.pricePoolPerAsset(fund.poolId, fund.scId, assetId, false);
  const shareUnit = BigNumber.from(10).pow(await shareToken.decimals());

  const callback = (payload: string) => manager.callback(fund.poolId, fund.scId, assetId, payload);
  const investor = asInvestor(holder);

  return {
    shareUnit,

    sharesOf: (): Promise<BigNumber> => shareToken.balanceOf(holder),

    isMember: async (): Promise<boolean> => (await hook.isMember(fund.share, holder)).isValid,

    /** Centrifuge admits `holder` to this fund's share class. Entries expire; pass a horizon to let one lapse. */
    admit: (validUntil: BigNumberish = "18446744073709551615") => hook.updateMember(fund.share, holder, validUntil),

    /** The fund publishes a new NAV. This is what `vault.pricePerShare()` resolves to. */
    publishNav: async (pricePoolPerShare: BigNumberish) => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      return spoke.updatePricePoolPerShare(fund.poolId, fund.scId, pricePoolPerShare, now);
    },

    /** Assets the fund's shares are worth at `price`, and the inverse. */
    assetsFor: (shares: BigNumberish, price: BigNumberish) => BigNumber.from(shares).mul(price).div(shareUnit),
    sharesFor: (assets: BigNumberish, price: BigNumberish) => BigNumber.from(assets).mul(shareUnit).div(price),

    /**
     * The fund manager fills a pending deposit, in the three-message sequence Centrifuge's hub chain
     * emits. Skipping one breaks the balance-sheet accounting the later claim depends on.
     */
    settleDeposit: async (assets: BigNumberish, shares: BigNumberish, price: BigNumberish) => {
      await callback(
        ethers.utils.solidityPack(["uint8", "uint128", "uint128"], [APPROVED_DEPOSITS, assets, assetPrice]),
      );
      await callback(ethers.utils.solidityPack(["uint8", "uint128", "uint128"], [ISSUED_SHARES, shares, price]));
      await callback(
        ethers.utils.solidityPack(
          ["uint8", "bytes32", "uint128", "uint128", "uint128"],
          [FULFILLED_DEPOSIT, investor, assets, shares, 0],
        ),
      );
    },

    /** The fund manager fills a pending redemption. */
    settleRedeem: async (shares: BigNumberish, assets: BigNumberish, price: BigNumberish) => {
      await callback(
        ethers.utils.solidityPack(["uint8", "uint128", "uint128", "uint128"], [REVOKED_SHARES, assets, shares, price]),
      );
      await callback(
        ethers.utils.solidityPack(
          ["uint8", "bytes32", "uint128", "uint128", "uint128"],
          [FULFILLED_REDEEM, investor, assets, shares, 0],
        ),
      );
    },

    /**
     * Raise what the pool can actually pay out by `gain`. Redemptions settle out of the pool's
     * on-chain holding, which is real-world state — on some blocks other investors' reservations
     * already exceed it and no redemption could settle for anyone.
     */
    liftRedemptionLiquidity: async (gain: BigNumberish, funder: SignerWithAddress) => {
      const token = IERC20__factory.connect(asset, funder);
      const target = (await escrow.availableBalanceOf(fund.scId, asset, 0)).add(gain);

      // `availableBalanceOf` is holding minus reservations floored at zero, so one top-up can be
      // swallowed whole by an existing deficit. Repeat until the escrow says the money is spendable.
      for (let i = 0; i < 8; i++) {
        const have = await escrow.availableBalanceOf(fund.scId, asset, 0);
        if (have.gte(target)) return;
        const short = target.sub(have);
        // Tokens first — the escrow pays out of its own balance — then the pool-side accounting.
        await token.transfer(escrow.address, short);
        await escrow.deposit(fund.scId, asset, 0, short);
      }
      throw new Error("could not lift the pool's redemption liquidity");
    },
  };
}
