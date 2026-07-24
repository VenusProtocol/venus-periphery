import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import chai from "chai";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { FORK_MAINNET, forking, initMainnetUser } from "../../utils";
import {
  COMPTROLLER,
  FAKE_MARKET,
  LISTA_STAKE_MANAGER,
  LISTA_UNBOND_PERIOD,
  PENDLE_ROUTER_V3,
  SLISBNB,
  SLISBNB_UNSTAKE_BLOCK,
} from "../utils/constants";
import { forceConfirmListaRequest, forceGrantListaBot } from "../utils/listaUnstake";
import {
  seedVTokenPosition,
  slisBaseFixture,
  slisMaturedFixture,
  slisRequestedFixture,
} from "../utils/slisBnbFixtures";

const { expect } = chai;

function findEvent(receipt: any, name: string) {
  return receipt.events?.find((e: any) => e.event === name);
}

function describeTests() {
  describe("PendlePTSlisBNBVaultAdapter - Unstake Lifecycle", () => {
    // ── requestWithdraw ─────────────────────────────────────────────────

    describe("requestWithdraw", () => {
      it("redeems the position, hands slisBNB to Lista, and records the request", async () => {
        const { adapter, user, slisbnb, vToken, ptToken, lista, marketAddress, depositVTokenAmount } =
          await loadFixture(slisMaturedFixture);

        const userVTokenBefore = await vToken.balanceOf(user.address);

        const tx = await adapter.connect(user).requestWithdraw(marketAddress, depositVTokenAmount, 0);
        const receipt = await tx.wait();

        // Event
        const ev = findEvent(receipt, "UnstakeRequested");
        expect(ev, "UnstakeRequested not emitted").to.not.be.undefined;
        const uuid: BigNumber = ev!.args!.uuid;
        const slisBnbAmount: BigNumber = ev!.args!.slisBnbAmount;
        expect(ev!.args!.pendleMarket).to.equal(marketAddress);
        expect(ev!.args!.user).to.equal(user.address);
        expect(slisBnbAmount).to.be.gt(0);

        // vTokens were redeemed from the user; adapter is left holding nothing
        expect(userVTokenBefore.sub(await vToken.balanceOf(user.address))).to.equal(depositVTokenAmount);
        expect(await slisbnb.balanceOf(adapter.address)).to.equal(0);
        expect(await ptToken.balanceOf(adapter.address)).to.equal(0);
        expect(await vToken.balanceOf(adapter.address)).to.equal(0);

        // Lista recorded the request for the ADAPTER (not the user)
        const requests = await lista.getUserWithdrawalRequests(adapter.address);
        const listaReq = requests.find((r: any) => r.uuid.eq(uuid));
        expect(listaReq, "Lista did not record the adapter's request").to.not.be.undefined;
        expect(listaReq.amountInSnBnb).to.equal(slisBnbAmount);

        // Adapter ownership + snapshot bookkeeping
        expect(await adapter.unstakeOwner(uuid)).to.equal(user.address);
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([uuid]);

        const record = await adapter.getUnstakeRequest(uuid);
        expect(record.user).to.equal(user.address);
        expect(record.amountInSnBnb).to.equal(slisBnbAmount);
        expect(record.startTime).to.be.gt(0);
        expect(record.claimableAt).to.equal(record.startTime.add(LISTA_UNBOND_PERIOD));

        // Not yet confirmed by Lista's bot pointer
        expect(await adapter.isClaimable(uuid)).to.be.false;
      });

      it("reverts with ZeroAmount when vTokenAmount is 0", async () => {
        const { adapter, user, marketAddress } = await loadFixture(slisMaturedFixture);
        await expect(adapter.connect(user).requestWithdraw(marketAddress, 0, 0)).to.be.revertedWithCustomError(
          adapter,
          "ZeroAmount",
        );
      });

      it("reverts with MarketNotRegistered for an unknown market", async () => {
        const { adapter, user } = await loadFixture(slisBaseFixture);
        await expect(adapter.connect(user).requestWithdraw(FAKE_MARKET, 1, 0))
          .to.be.revertedWithCustomError(adapter, "MarketNotRegistered")
          .withArgs(FAKE_MARKET);
      });

      it("reverts when the adapter is paused", async () => {
        const { adapter, owner, user, marketAddress } = await loadFixture(slisBaseFixture);
        await adapter.connect(owner).pause();
        await expect(adapter.connect(user).requestWithdraw(marketAddress, 1, 0)).to.be.revertedWith("Pausable: paused");
      });

      it("reverts when minSlisBnbOut exceeds the redeemable amount (slippage)", async () => {
        const { adapter, user, marketAddress, depositVTokenAmount } = await loadFixture(slisMaturedFixture);
        const absurdMin = parseUnits("1000000", 18);
        await expect(adapter.connect(user).requestWithdraw(marketAddress, depositVTokenAmount, absurdMin)).to.be
          .reverted;
      });

      it("reverts when the user has not delegated to the adapter", async () => {
        const { adapter, user, comptroller, marketAddress, depositVTokenAmount } =
          await loadFixture(slisMaturedFixture);
        // Revoke the delegation the fixture set up, so the adapter's redeemBehalf is rejected.
        await comptroller.connect(user).updateDelegate(adapter.address, false);
        await expect(adapter.connect(user).requestWithdraw(marketAddress, depositVTokenAmount, 0)).to.be.reverted;
      });
    });

    // ── claimUnstaked ───────────────────────────────────────────────────

    describe("claimUnstaked", () => {
      it("reverts with UnstakeRequestNotFound for an unknown uuid", async () => {
        const { adapter, user } = await loadFixture(slisRequestedFixture);
        const unknown = 999999999;
        await expect(adapter.connect(user).claimUnstaked(unknown))
          .to.be.revertedWithCustomError(adapter, "UnstakeRequestNotFound")
          .withArgs(unknown);
      });

      it("reverts while Lista has not yet confirmed the request", async () => {
        const { adapter, user, uuid } = await loadFixture(slisRequestedFixture);
        // Request exists on the adapter's Lista array but uuid >= nextConfirmedRequestUUID,
        // so Lista's claimWithdraw rejects it.
        expect(await adapter.isClaimable(uuid)).to.be.false;
        await expect(adapter.connect(user).claimUnstaked(uuid)).to.be.revertedWith("Not able to claim yet");
      });

      it("pays the owner the exact locked BNB once confirmed, callable by anyone", async () => {
        const { adapter, user, uuid, expectedBnb } = await loadFixture(slisRequestedFixture);
        const [, claimer] = await ethers.getSigners();

        await forceConfirmListaRequest(uuid);
        expect(await adapter.isClaimable(uuid)).to.be.true;

        const ownerBnbBefore = await ethers.provider.getBalance(user.address);

        // A third party finalizes; BNB must still go to the recorded owner, never the caller.
        const tx = await adapter.connect(claimer).claimUnstaked(uuid);
        const receipt = await tx.wait();

        expect((await ethers.provider.getBalance(user.address)).sub(ownerBnbBefore)).to.equal(expectedBnb);
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);

        // Record cleared
        expect(await adapter.unstakeOwner(uuid)).to.equal(ethers.constants.AddressZero);
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([]);
        expect(await adapter.isClaimable(uuid)).to.be.false;

        const cleared = await adapter.getUnstakeRequest(uuid);
        expect(cleared.user).to.equal(ethers.constants.AddressZero);
        expect(cleared.amountInSnBnb).to.equal(0);
        expect(cleared.startTime).to.equal(0);
        expect(cleared.claimableAt).to.equal(0);

        const ev = findEvent(receipt, "UnstakeClaimed");
        expect(ev, "UnstakeClaimed not emitted").to.not.be.undefined;
        expect(ev!.args!.uuid).to.equal(uuid);
        expect(ev!.args!.user).to.equal(user.address);
        expect(ev!.args!.bnbAmount).to.equal(expectedBnb);
      });

      it("forwards the snapshot when Lista's bot already claimed via claimWithdrawFor (orphan path)", async () => {
        const { adapter, user, uuid, idx, expectedBnb, lista } = await loadFixture(slisRequestedFixture);
        const [, claimer, botSigner] = await ethers.getSigners();

        await forceConfirmListaRequest(uuid);
        await forceGrantListaBot(botSigner.address);

        // Bot claims on the adapter's behalf: Lista pays the ADAPTER the request-time-locked
        // BNB and swap-pops the entry out of the adapter's request array.
        const adapterBnbBefore = await ethers.provider.getBalance(adapter.address);
        await lista.connect(botSigner).claimWithdrawFor(adapter.address, idx);

        expect((await ethers.provider.getBalance(adapter.address)).sub(adapterBnbBefore)).to.equal(expectedBnb);
        const requestsAfter = await lista.getUserWithdrawalRequests(adapter.address);
        expect(
          requestsAfter.find((r: any) => r.uuid.eq(uuid)),
          "uuid should have left Lista's array",
        ).to.be.undefined;

        // Adapter record survives as an orphan: the uuid is gone from Lista but the owner is still recorded.
        expect(await adapter.unstakeOwner(uuid)).to.equal(user.address);

        // claimUnstaked must detect the orphan and forward the pooled snapshot (the request-time-locked amount).
        const ownerBnbBefore = await ethers.provider.getBalance(user.address);
        const tx = await adapter.connect(claimer).claimUnstaked(uuid);
        const receipt = await tx.wait();

        expect((await ethers.provider.getBalance(user.address)).sub(ownerBnbBefore)).to.equal(expectedBnb);
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);
        expect(await adapter.unstakeOwner(uuid)).to.equal(ethers.constants.AddressZero);
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([]);

        const ev = findEvent(receipt, "UnstakeClaimed");
        expect(ev!.args!.bnbAmount).to.equal(expectedBnb);
      });

      it("isolates pooled BNB across a mixed orphan + normal claim (no cross-contamination)", async () => {
        const { adapter, user, lista, marketAddress, depositVTokenAmount } = await loadFixture(slisMaturedFixture);
        const [, claimer, botSigner] = await ethers.getSigners();

        const firstAmount = depositVTokenAmount.div(2);
        const secondAmount = depositVTokenAmount.sub(firstAmount);

        const rA = await (await adapter.connect(user).requestWithdraw(marketAddress, firstAmount, 0)).wait();
        const rB = await (await adapter.connect(user).requestWithdraw(marketAddress, secondAmount, 0)).wait();
        const uuidA: BigNumber = findEvent(rA, "UnstakeRequested")!.args!.uuid;
        const uuidB: BigNumber = findEvent(rB, "UnstakeRequested")!.args!.uuid;

        // Snapshot each request's locked BNB and Lista index before any claim.
        const reqs = await lista.getUserWithdrawalRequests(adapter.address);
        const idxA = reqs.findIndex((r: any) => r.uuid.eq(uuidA));
        const [, expectedA] = await lista.getUserRequestStatus(adapter.address, idxA);
        const [, expectedB] = await lista.getUserRequestStatus(
          adapter.address,
          reqs.findIndex((r: any) => r.uuid.eq(uuidB)),
        );

        await forceConfirmListaRequest(uuidB); // uuidA < uuidB, so this confirms both
        await forceGrantListaBot(botSigner.address);

        // 1. Bot claims A on the adapter's behalf: A's BNB is now POOLED on the adapter, A is orphaned.
        const adapterBefore = await ethers.provider.getBalance(adapter.address);
        await lista.connect(botSigner).claimWithdrawFor(adapter.address, idxA);
        expect((await ethers.provider.getBalance(adapter.address)).sub(adapterBefore)).to.equal(expectedA);
        expect(await adapter.unstakeOwner(uuidA)).to.equal(user.address); // orphan record survives

        // 2. Claim B through the NORMAL (found) path. balanceBefore now includes A's pooled BNB, so the
        //    balance delta must isolate B's payout and leave A's pool untouched.
        const userBeforeB = await ethers.provider.getBalance(user.address);
        await adapter.connect(claimer).claimUnstaked(uuidB);
        expect((await ethers.provider.getBalance(user.address)).sub(userBeforeB)).to.equal(expectedB);
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(expectedA); // A's pool did not leak into B

        // 3. Claim A through the ORPHAN path: forwards exactly A's snapshot from the remaining pool.
        const userBeforeA = await ethers.provider.getBalance(user.address);
        await adapter.connect(claimer).claimUnstaked(uuidA);
        expect((await ethers.provider.getBalance(user.address)).sub(userBeforeA)).to.equal(expectedA);
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([]);
      });

      it("reverts on a second claim of the same uuid", async () => {
        const { adapter, uuid } = await loadFixture(slisRequestedFixture);
        const [, claimer] = await ethers.getSigners();

        await forceConfirmListaRequest(uuid);
        await adapter.connect(claimer).claimUnstaked(uuid);

        await expect(adapter.connect(claimer).claimUnstaked(uuid))
          .to.be.revertedWithCustomError(adapter, "UnstakeRequestNotFound")
          .withArgs(uuid);
      });

      it("resolves the live index per claim when Lista compacts its array (multiple requests)", async () => {
        const { adapter, user, lista, marketAddress, depositVTokenAmount } = await loadFixture(slisMaturedFixture);
        const [, claimer] = await ethers.getSigners();

        const firstAmount = depositVTokenAmount.div(2);
        const secondAmount = depositVTokenAmount.sub(firstAmount);

        const rcpt1 = await (await adapter.connect(user).requestWithdraw(marketAddress, firstAmount, 0)).wait();
        const rcpt2 = await (await adapter.connect(user).requestWithdraw(marketAddress, secondAmount, 0)).wait();
        const uuidA: BigNumber = findEvent(rcpt1, "UnstakeRequested")!.args!.uuid;
        const uuidB: BigNumber = findEvent(rcpt2, "UnstakeRequested")!.args!.uuid;
        expect(uuidB).to.be.gt(uuidA);

        // Both queued under the adapter, both tracked for the user
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([uuidA, uuidB]);

        const requests = await lista.getUserWithdrawalRequests(adapter.address);
        const idxA = requests.findIndex((r: any) => r.uuid.eq(uuidA));
        const idxB = requests.findIndex((r: any) => r.uuid.eq(uuidB));
        const [, expectedA] = await lista.getUserRequestStatus(adapter.address, idxA);
        const [, expectedB] = await lista.getUserRequestStatus(adapter.address, idxB);

        // Confirm up to the later uuid (covers both).
        await forceConfirmListaRequest(uuidB);

        // Claim A first. Lista swap-pops it, moving B to a different index; the adapter must
        // re-resolve B's index on the next claim rather than reusing a stale one.
        const ownerBefore = await ethers.provider.getBalance(user.address);
        await adapter.connect(claimer).claimUnstaked(uuidA);
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([uuidB]);

        await adapter.connect(claimer).claimUnstaked(uuidB);
        expect(await adapter.getUserUuids(user.address)).to.deep.equal([]);

        expect((await ethers.provider.getBalance(user.address)).sub(ownerBefore)).to.equal(expectedA.add(expectedB));
        expect(await ethers.provider.getBalance(adapter.address)).to.equal(0);
      });

      it("still pays out while the adapter is paused (claim is intentionally not pausable)", async () => {
        const { adapter, owner, user, uuid, expectedBnb } = await loadFixture(slisRequestedFixture);
        const [, claimer] = await ethers.getSigners();

        await forceConfirmListaRequest(uuid);
        await adapter.connect(owner).pause();

        const ownerBnbBefore = await ethers.provider.getBalance(user.address);
        await adapter.connect(claimer).claimUnstaked(uuid);

        expect((await ethers.provider.getBalance(user.address)).sub(ownerBnbBefore)).to.equal(expectedBnb);
        expect(await adapter.unstakeOwner(uuid)).to.equal(ethers.constants.AddressZero);
      });

      it("routes each owner's BNB to the correct recipient with two distinct owners", async () => {
        const base = await loadFixture(slisMaturedFixture);
        const { adapter, user: user1, lista, marketAddress, depositVTokenAmount } = base;
        const [, claimer] = await ethers.getSigners();
        // Use a clean impersonated EOA as the second owner: some hardhat default signer addresses
        // collide with contracts deployed on the BSC fork, which would revert the native payout.
        const user2 = await initMainnetUser("0x00000000000000000000000000000000000a11ce", parseUnits("10", 18));

        // Seed a second, independent vToken position for user2.
        const user2VTokens = await seedVTokenPosition(base, user2, parseUnits("8", 18));

        const r1 = await (await adapter.connect(user1).requestWithdraw(marketAddress, depositVTokenAmount, 0)).wait();
        const r2 = await (await adapter.connect(user2).requestWithdraw(marketAddress, user2VTokens, 0)).wait();
        const uuid1: BigNumber = findEvent(r1, "UnstakeRequested")!.args!.uuid;
        const uuid2: BigNumber = findEvent(r2, "UnstakeRequested")!.args!.uuid;

        expect(await adapter.unstakeOwner(uuid1)).to.equal(user1.address);
        expect(await adapter.unstakeOwner(uuid2)).to.equal(user2.address);

        const requests = await lista.getUserWithdrawalRequests(adapter.address);
        const [, expected1] = await lista.getUserRequestStatus(
          adapter.address,
          requests.findIndex((r: any) => r.uuid.eq(uuid1)),
        );
        const [, expected2] = await lista.getUserRequestStatus(
          adapter.address,
          requests.findIndex((r: any) => r.uuid.eq(uuid2)),
        );

        await forceConfirmListaRequest(uuid2); // uuid1 < uuid2, so this confirms both

        const u1Before = await ethers.provider.getBalance(user1.address);
        const u2Before = await ethers.provider.getBalance(user2.address);
        await adapter.connect(claimer).claimUnstaked(uuid1);
        await adapter.connect(claimer).claimUnstaked(uuid2);

        expect((await ethers.provider.getBalance(user1.address)).sub(u1Before)).to.equal(expected1);
        expect((await ethers.provider.getBalance(user2.address)).sub(u2Before)).to.equal(expected2);
      });
    });

    // ── constructor & immutables ────────────────────────────────────────

    describe("constructor & immutables", () => {
      it("reverts on a zero slisBNB, Lista StakeManager, or unbond period", async () => {
        const { adapter } = await loadFixture(slisBaseFixture);
        const Factory = await ethers.getContractFactory("PendlePTSlisBNBVaultAdapter");

        await expect(
          Factory.deploy(
            PENDLE_ROUTER_V3,
            COMPTROLLER,
            ethers.constants.AddressZero,
            LISTA_STAKE_MANAGER,
            LISTA_UNBOND_PERIOD,
          ),
        ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        await expect(
          Factory.deploy(PENDLE_ROUTER_V3, COMPTROLLER, SLISBNB, ethers.constants.AddressZero, LISTA_UNBOND_PERIOD),
        ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
        await expect(
          Factory.deploy(PENDLE_ROUTER_V3, COMPTROLLER, SLISBNB, LISTA_STAKE_MANAGER, 0),
        ).to.be.revertedWithCustomError(adapter, "ZeroAmount");
      });

      it("exposes the configured immutables", async () => {
        const { adapter } = await loadFixture(slisBaseFixture);
        expect(await adapter.SLIS_BNB()).to.equal(SLISBNB);
        expect(await adapter.LISTA_STAKE_MANAGER()).to.equal(LISTA_STAKE_MANAGER);
        expect(await adapter.UNBOND_PERIOD()).to.equal(LISTA_UNBOND_PERIOD);
      });
    });
  });
}

// Standalone suite. Runs at a post-maturity block distinct from the shared (pre-maturity)
// BLOCK_NUMBER the index runner forks at, so it is intentionally NOT wired into index.spec.ts
// (the index uses a single forking() call; a second hardhat_reset would invalidate its snapshots).
//   FORKED_NETWORK=bscmainnet npx hardhat test \
//     tests/hardhat/Fork/pendlePTVaultAdapter/tests/PendlePTSlisBNBVaultAdapter.spec.ts --network hardhat
if (FORK_MAINNET) {
  forking(SLISBNB_UNSTAKE_BLOCK, () => {
    describeTests();
  });
}
