import "setup.spec";

/*
 * Pairs: a call on one pair changes nothing on another pair. Two pairs may share a stable and its Hub.
 */

/// Any round or plan call on pair `p` leaves pair `q`'s totals, indexes, sources, running round and plans as they
/// were
rule callOnOnePairLeavesTheOtherAlone(
    env e,
    uint8 which,
    uint32 p,
    uint32 q,
    uint256 x,
    uint256 y,
    uint8 parts,
    uint256 quotedOut,
    bytes swapData,
    uint256 amount,
    uint8 buys,
    address owner,
    bool toCore,
    address receiver
) {
    require pairCount() == 2;
    requireSaneSetup();
    requireKnownPair(p);
    requireKnownPair(q);
    require p != q;
    require planPair(x) == p;
    require planPair(y) == q;
    // `y` already exists, so a new plan cannot take its id
    require y <= lastPlanId();

    uint32 settledBefore = lastSettled(q);
    require settledBefore < max_uint32;
    uint32 nq = require_uint32(settledBefore + 1);
    uint256 unitsBefore = roundStableUnits(q);
    uint256 principalBefore = roundPrincipal(q);
    uint256 unitIndexBefore = pairUnitIndex(q);
    uint256 principalIndexBefore = pairPrincipalIndex(q);
    uint256 stableSharesBefore = sourceShares(q, STABLE());
    uint256 stableSrcUnitsBefore = sourceUnits(q, STABLE());
    uint256 assetSharesBefore = sourceShares(q, ASSET());
    uint256 assetSrcUnitsBefore = sourceUnits(q, ASSET());
    uint8 partsTotalBefore = roundPartsTotal(q, nq);
    uint8 partsDoneBefore = roundPartsDone(q, nq);
    uint256 toSwapBefore = roundStableToSwap(q, nq);
    uint256 boughtBefore = roundAssetBought(q, nq);
    uint256 owedBefore = assetUnitsOwed(y);
    uint256 paidBefore = planPaid(y);
    uint8 statusBefore = planStatus(y);

    if (which == 0) {
        startRound(e, p, parts);
    } else if (which == 1) {
        swapRoundPart(e, p, quotedOut, swapData);
    } else if (which == 2) {
        resplitRound(e, p, parts);
    } else if (which == 3) {
        settleRound(e, p);
    } else if (which == 4) {
        forceBuy(e, p, parts);
    } else if (which == 5) {
        syncPair(e, p);
    } else if (which == 6) {
        createPlan(e, p, amount, buys, owner);
    } else if (which == 7) {
        topUpPlan(e, x, amount);
    } else if (which == 8) {
        cancelPlan(e, x, toCore, receiver);
    } else if (which == 9) {
        withdrawBought(e, x, amount, toCore, receiver);
    } else {
        claimPlan(e, x, toCore, receiver);
    }

    assert lastSettled(q) == settledBefore;
    assert roundStableUnits(q) == unitsBefore;
    assert roundPrincipal(q) == principalBefore;
    assert pairUnitIndex(q) == unitIndexBefore;
    assert pairPrincipalIndex(q) == principalIndexBefore;
    assert sourceShares(q, STABLE()) == stableSharesBefore;
    assert sourceUnits(q, STABLE()) == stableSrcUnitsBefore;
    assert sourceShares(q, ASSET()) == assetSharesBefore;
    assert sourceUnits(q, ASSET()) == assetSrcUnitsBefore;
    assert roundPartsTotal(q, nq) == partsTotalBefore;
    assert roundPartsDone(q, nq) == partsDoneBefore;
    assert roundStableToSwap(q, nq) == toSwapBefore;
    assert roundAssetBought(q, nq) == boughtBefore;
    assert assetUnitsOwed(y) == owedBefore;
    assert planPaid(y) == paidBefore;
    assert planStatus(y) == statusBefore;
}
