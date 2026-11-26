import "setup.spec";

/*
 * Access and timing: round calls work only for a keeper from the round's start; plans made from the lock join the
 * round after; a plan in the running round cannot top up or cancel.
 */

/// Calls that stop while SmartDCA is paused
definition isPausable(method f) returns bool =
    f.selector == sig:createPlan(uint32, uint256, uint8, address).selector ||
    f.selector == sig:topUpPlan(uint256, uint256).selector ||
    f.selector == sig:withdrawBought(uint256, uint256, bool, address).selector ||
    f.selector == sig:cancelPlan(uint256, bool, address).selector ||
    f.selector == sig:claimPlan(uint256, bool, address).selector ||
    f.selector == sig:transferPlan(uint256, address).selector ||
    f.selector == sig:startRound(uint32, uint8).selector ||
    f.selector == sig:swapRoundPart(uint32, uint256, bytes).selector ||
    f.selector == sig:resplitRound(uint32, uint8).selector ||
    f.selector == sig:settleRound(uint32).selector ||
    f.selector == sig:forceBuy(uint32, uint8).selector ||
    f.selector == sig:syncPair(uint32).selector;

/// `startRound`, `swapRoundPart`, `resplitRound` and `settleRound` revert unless the caller is a keeper and the
/// pair's next round has started
rule roundCallsNeedKeeperAndStart(
    env e,
    uint32 p,
    uint8 which,
    uint8 parts,
    uint256 quotedOut,
    bytes swapData
) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    bool allowed = isKeeper(e.msg.sender) && e.block.timestamp >= roundStart(next);

    if (which == 0) {
        startRound@withrevert(e, p, parts);
    } else if (which == 1) {
        swapRoundPart@withrevert(e, p, quotedOut, swapData);
    } else if (which == 2) {
        resplitRound@withrevert(e, p, parts);
    } else {
        settleRound@withrevert(e, p);
    }

    assert !allowed => lastReverted;
}

/// `forceBuy` reverts until `FALLBACK_DELAY` after the round's start
rule forceBuyWaitsForTheDelay(env e, uint32 p, uint8 parts) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    require e.block.timestamp < roundStart(next) + FALLBACK_DELAY();

    forceBuy@withrevert(e, p, parts);

    assert lastReverted;
}

/// A plan made before the next round's lock joins that round; one made from the lock joins the round after, so it
/// is never in a running round and can still cancel
rule planMadeFromLockJoinsTheRoundAfter(env e, uint32 p, uint256 amount, uint8 buys, address owner) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastPlanId() < max_uint256;
    uint256 id = require_uint256(lastPlanId() + 1);

    createPlan(e, p, amount, buys, owner);

    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    assert lastPlanId() == id;
    assert e.block.timestamp >= roundStart(next) => to_mathint(planFirstRound(id)) == next + 1;
    assert e.block.timestamp < roundStart(next) => planFirstRound(id) == next;
    assert !inRunningRoundOf(e, id);
}

/// A plan in its pair's running round cannot top up or cancel
rule runningRoundBlocksTopUpAndCancel(env e, uint256 x, bool cancel, uint256 amount, bool toCore, address receiver) {
    requireSaneSetup();
    uint32 p = planPair(x);
    requireKnownPair(p);
    // The round has plans, so no empty round settles in the call
    require roundStableUnits(p) != 0;
    require inRunningRoundOf(e, x);

    if (cancel) {
        cancelPlan@withrevert(e, x, toCore, receiver);
    } else {
        topUpPlan@withrevert(e, x, amount);
    }

    assert lastReverted;
}

/// A top up on a disabled pair reverts
rule topUpRevertsOnDisabledPair(env e, uint256 x, uint256 amount) {
    requireSaneSetup();
    require !pairEnabled(planPair(x));

    topUpPlan@withrevert(e, x, amount);

    assert lastReverted;
}

/// While paused, every plan and round call reverts
rule pausedBlocksPlanAndRoundCalls(env e, method f, calldataarg args) filtered { f -> isPausable(f) } {
    requireSaneSetup();
    require paused();

    f@withrevert(e, args);

    assert lastReverted;
}
