import "setup.spec";

/*
 * Rounds: from lock until settle, the round's totals do not change; rounds move forward one at a time; a round's
 * parts add up to its net stable.
 */

/// From the lock time of a pair's next round until that round settles, no call changes the round's total units or
/// total principal. Plans made during the lock join the round after.
rule roundTotalsFrozenFromLockToSettle(env e, method f, calldataarg args, uint32 p) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    requireKnownPair(p);
    uint32 settledBefore = lastSettled(p);
    require settledBefore < max_uint32;
    require e.block.timestamp >= roundStart(require_uint32(settledBefore + 1));
    mathint unitsBefore = roundStableUnits(p);
    mathint principalBefore = roundPrincipal(p);

    f(e, args);

    require lastSettled(p) == settledBefore;
    assert to_mathint(roundStableUnits(p)) == unitsBefore;
    assert to_mathint(roundPrincipal(p)) == principalBefore;
}

/// Once `startRound` has run, the round's redeemed and net stable stay fixed until it settles
rule startedRoundRecordFrozen(env e, method f, calldataarg args, uint32 p) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    requireKnownPair(p);
    uint32 settledBefore = lastSettled(p);
    require settledBefore < max_uint32;
    uint32 round = require_uint32(settledBefore + 1);
    require roundPartsTotal(p, round) != 0;
    mathint redeemedBefore = roundStableRedeemed(p, round);
    mathint netBefore = roundStableNet(p, round);

    f(e, args);

    assert to_mathint(roundStableRedeemed(p, round)) == redeemedBefore;
    assert to_mathint(roundStableNet(p, round)) == netBefore;
}

/// The last settled round never goes back, and a pair's indexes never go down
rule settledRoundAndIndexesOnlyGrow(env e, method f, calldataarg args, uint32 p) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    requireKnownPair(p);
    uint32 settledBefore = lastSettled(p);
    uint256 unitIndexBefore = pairUnitIndex(p);
    uint256 principalIndexBefore = pairPrincipalIndex(p);

    f(e, args);

    assert lastSettled(p) >= settledBefore;
    assert pairUnitIndex(p) >= unitIndexBefore;
    assert pairPrincipalIndex(p) >= principalIndexBefore;
}

/// Every round a call closes stores the pair's indexes, and a later closed round never stores lower ones
rule closedRoundStoresTheIndexes(env e, method f, calldataarg args, uint32 p) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    requireKnownPair(p);
    uint32 settledBefore = lastSettled(p);

    f(e, args);

    uint32 settledAfter = lastSettled(p);
    assert settledAfter > settledBefore => (
        roundUnitIndexAfter(p, settledAfter) == pairUnitIndex(p) &&
        roundPrincipalIndexAfter(p, settledAfter) == pairPrincipalIndex(p)
    );
    assert settledAfter > settledBefore + 1 => (
        roundUnitIndexAfter(p, require_uint32(settledAfter - 1)) <= roundUnitIndexAfter(p, settledAfter) &&
        roundPrincipalIndexAfter(p, require_uint32(settledAfter - 1)) <= roundPrincipalIndexAfter(p, settledAfter)
    );
}

/// A closed round's record is never written again
rule closedRoundNeverWritten(env e, method f, calldataarg args, uint32 p, uint32 r) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    requireKnownPair(p);
    require r <= lastSettled(p);
    uint8 partsTotalBefore = roundPartsTotal(p, r);
    uint8 partsDoneBefore = roundPartsDone(p, r);
    uint256 redeemedBefore = roundStableRedeemed(p, r);
    uint256 netBefore = roundStableNet(p, r);
    uint256 toSwapBefore = roundStableToSwap(p, r);
    uint256 boughtBefore = roundAssetBought(p, r);
    uint256 joiningBefore = roundUnitsJoining(p, r);
    uint256 endingBefore = roundUnitsEnding(p, r);
    uint256 unitIndexBefore = roundUnitIndexAfter(p, r);
    uint256 principalIndexBefore = roundPrincipalIndexAfter(p, r);

    f(e, args);

    assert roundPartsTotal(p, r) == partsTotalBefore;
    assert roundPartsDone(p, r) == partsDoneBefore;
    assert roundStableRedeemed(p, r) == redeemedBefore;
    assert roundStableNet(p, r) == netBefore;
    assert roundStableToSwap(p, r) == toSwapBefore;
    assert roundAssetBought(p, r) == boughtBefore;
    assert roundUnitsJoining(p, r) == joiningBefore;
    assert roundUnitsEnding(p, r) == endingBefore;
    assert roundUnitIndexAfter(p, r) == unitIndexBefore;
    assert roundPrincipalIndexAfter(p, r) == principalIndexBefore;
}

/// `startRound` on a round that already started reverts
rule startRoundRunsOncePerRound(env e, uint32 p, uint8 parts) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    require roundPartsTotal(p, next) != 0;
    // The round has plans, so no empty round settles first
    require roundStableUnits(p) != 0;

    startRound@withrevert(e, p, parts);

    assert lastReverted;
}

/// In a started round, parts done never pass the split, the stable left to swap never grows or passes the net,
/// and once every part is done none is left. So the parts sold add up to the net stable.
rule roundPartsAddUpToTheNet(env e, method f, calldataarg args, uint32 p) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    requireKnownPair(p);
    uint32 settledBefore = lastSettled(p);
    require settledBefore < max_uint32;
    uint32 next = require_uint32(settledBefore + 1);
    require roundPartsTotal(p, next) != 0;
    require roundPartsDone(p, next) <= roundPartsTotal(p, next);
    require roundStableToSwap(p, next) <= roundStableNet(p, next);
    require roundPartsDone(p, next) == roundPartsTotal(p, next) => roundStableToSwap(p, next) == 0;
    uint256 toSwapBefore = roundStableToSwap(p, next);

    f(e, args);

    require lastSettled(p) == settledBefore;
    assert roundPartsDone(p, next) <= roundPartsTotal(p, next);
    assert roundStableToSwap(p, next) <= toSwapBefore;
    assert roundStableToSwap(p, next) <= roundStableNet(p, next);
    assert roundPartsDone(p, next) == roundPartsTotal(p, next) => roundStableToSwap(p, next) == 0;
}

/// A round settles only once every part is done
rule settleNeedsEveryPart(env e, uint32 p) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    require roundPartsDone(p, next) != roundPartsTotal(p, next);

    settleRound@withrevert(e, p);

    assert lastReverted;
}
