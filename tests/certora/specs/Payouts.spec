import "setup.spec";

/*
 * Payouts: what plans are owed and paid.
 */

/// Calls that pay a plan out
definition paysOut(method f) returns bool =
    f.selector == sig:claimPlan(uint256, bool, address).selector ||
    f.selector == sig:cancelPlan(uint256, bool, address).selector ||
    f.selector == sig:withdrawBought(uint256, uint256, bool, address).selector;

/// A plan's owed amount changes only when a round settles or a call pays it out. A top up, a transfer, a running
/// round's start or swap, and every other call leave it alone.
rule owedChangesOnlyBySettleOrPayout(env e, method f, calldataarg args, uint256 x) filtered { f -> !isExcluded(f) && !paysOut(f) } {
    requireSaneSetup();
    uint32 p = planPair(x);
    requireKnownPair(p);
    require planStatus(x) == ACTIVE();
    uint32 settledBefore = lastSettled(p);
    mathint owedBefore = assetUnitsOwed(x);

    f(e, args);

    require lastSettled(p) == settledBefore;
    assert to_mathint(assetUnitsOwed(x)) == owedBefore;
}

/// Settling rounds outside a plan's schedule (before its first buy or after its last) leaves what it is owed
rule settleOutsideTheScheduleLeavesOwed(env e, uint32 p, uint256 x) {
    requireSaneSetup();
    requireKnownPair(p);
    require planPair(x) == p && planStatus(x) == ACTIVE();
    mathint first = planFirstRound(x);
    mathint last = first + planBuys(x) - 1;
    mathint settledBefore = lastSettled(p);
    mathint owedBefore = assetUnitsOwed(x);

    settleRound(e, p);

    mathint settledAfter = lastSettled(p);
    require last <= settledBefore || first > settledAfter;
    assert to_mathint(assetUnitsOwed(x)) == owedBefore;
}

/// A top up changes neither what the plan is owed nor what any other plan is owed
rule topUpLeavesEveryOwedAmount(env e, uint256 x, uint256 y, uint256 amount) {
    requireSaneSetup();
    requireKnownPair(planPair(x));
    requireKnownPair(planPair(y));
    mathint owedX = assetUnitsOwed(x);
    mathint owedY = assetUnitsOwed(y);
    uint32 settledX = lastSettled(planPair(x));
    uint32 settledY = lastSettled(planPair(y));

    topUpPlan(e, x, amount);
    require lastSettled(planPair(x)) == settledX && lastSettled(planPair(y)) == settledY;

    assert to_mathint(assetUnitsOwed(x)) == owedX;
    assert to_mathint(assetUnitsOwed(y)) == owedY;
}

/// Claim pays exactly what is owed, drops the stable units left by rounding the per-buy amount down, and closes
/// the plan
rule claimPaysOwedOnce(env e, uint256 x, bool toCore, address receiver) {
    requireSaneSetup();
    uint32 p = planPair(x);
    requireKnownPair(p);
    mathint owed = assetUnitsOwed(x);
    mathint paidBefore = planPaid(x);
    mathint leftover = planScheduleUnits(x) - planUnitsPerBuy(x) * planBuys(x);
    mathint unitsBefore = sourceUnits(p, STABLE());
    uint32 settledBefore = lastSettled(p);

    claimPlan(e, x, toCore, receiver);
    require lastSettled(p) == settledBefore;

    assert planPaid(x) - paidBefore == owed;
    assert unitsBefore - sourceUnits(p, STABLE()) == leftover;
    assert planStatus(x) == CLAIMED();
}

/// A plan that is no longer active rejects every plan call
rule closedPlanRejectsEveryCall(env e, uint256 x, uint256 amount, bool toCore, address receiver, address newOwner) {
    require planStatus(x) != ACTIVE();

    claimPlan@withrevert(e, x, toCore, receiver);
    assert lastReverted;
    cancelPlan@withrevert(e, x, toCore, receiver);
    assert lastReverted;
    withdrawBought@withrevert(e, x, amount, toCore, receiver);
    assert lastReverted;
    topUpPlan@withrevert(e, x, amount);
    assert lastReverted;
    transferPlan@withrevert(e, x, newOwner);
    assert lastReverted;
}

/// Cancel removes exactly the plan's units and its per-buy amount from the round totals, keeps no stable, and its
/// fee is at most the plan's own interest on the principal it booked
rule cancelRemovesExactlyThePlan(env e, uint256 x, address receiver) {
    requireSaneSetup();
    uint32 p = planPair(x);
    requireKnownPair(p);
    address stable = pairStable(p);
    address res = reserve();
    require receiver != currentContract && receiver != res && res != currentContract;
    require e.msg.sender != currentContract;
    uint32 settledBefore = lastSettled(p);
    require settledBefore < max_uint32;

    uint8 settled = buysSettledOf(x);
    mathint perBuy = planUnitsPerBuy(x);
    mathint unitsLeft = planScheduleUnits(x) - perBuy * settled;
    mathint principalLeft = planPrincipalPerBuy(x) * (planBuys(x) - settled);
    // After the restart the schedule starts at the plan's next unsettled round
    mathint first = planFirstRound(x) + settled;
    uint32 lastRound = require_uint32(planFirstRound(x) + planBuys(x) - 1);
    bool inTotals = first <= lastSettled(p) + 1;
    uint32 joinRound = require_uint32(first - 1);
    mathint totalsBefore = roundStableUnits(p);
    mathint joiningBefore = roundUnitsJoining(p, joinRound);
    mathint endingBefore = roundUnitsEnding(p, lastRound);
    mathint unitsBefore = sourceUnits(p, STABLE());
    mathint heldBefore = bal[stable][currentContract];
    mathint reserveBefore = bal[stable][res];
    mathint receiverBefore = bal[stable][receiver];

    cancelPlan(e, x, false, receiver);
    // No empty round settled on the way; that moves joining units into the totals and is checked elsewhere
    require lastSettled(p) == settledBefore;

    assert unitsBefore - sourceUnits(p, STABLE()) == unitsLeft;
    assert endingBefore - roundUnitsEnding(p, lastRound) == perBuy;
    assert inTotals => totalsBefore - roundStableUnits(p) == perBuy;
    assert !inTotals => joiningBefore - roundUnitsJoining(p, joinRound) == perBuy;
    assert to_mathint(bal[stable][currentContract]) == heldBefore;
    mathint fee = bal[stable][res] - reserveBefore;
    mathint redeemed = bal[stable][receiver] - receiverBefore + fee;
    assert fee <= (redeemed > principalLeft ? redeemed - principalLeft : 0);
}

/// A top up never lowers the per-buy amount, adds exactly the units it deposited, and books principal from the
/// stable that arrived (a token may take a fee on transfer)
rule topUpBooksExactlyWhatArrived(env e, uint256 x, uint256 amount) {
    requireSaneSetup();
    uint32 p = planPair(x);
    requireKnownPair(p);
    require e.msg.sender != currentContract;
    mathint settled = buysSettledOf(x);
    mathint buysLeft = planBuys(x) - settled;
    mathint perBuyBefore = planUnitsPerBuy(x);
    mathint scheduleBefore = planScheduleUnits(x);
    mathint principalBefore = planPrincipalPerBuy(x);
    mathint unitsBefore = sourceUnits(p, STABLE());
    uint32 settledBefore = lastSettled(p);

    topUpPlan(e, x, amount);
    require lastSettled(p) == settledBefore;

    mathint added = sourceUnits(p, STABLE()) - unitsBefore;
    assert to_mathint(planUnitsPerBuy(x)) >= perBuyBefore;
    assert to_mathint(planScheduleUnits(x)) == scheduleBefore - perBuyBefore * settled + added;
    assert to_mathint(planPrincipalPerBuy(x)) == principalBefore + lastArrived / buysLeft;
}

/// An active plan's schedule always covers its buys, so a top up's new per-buy amount is never below the old one
/// and rounding cannot make a top up revert
invariant scheduleCoversItsBuys(uint256 x)
    planStatus(x) == ACTIVE() => to_mathint(planScheduleUnits(x)) >= planUnitsPerBuy(x) * planBuys(x)
    filtered { f -> !isExcluded(f) }
    {
        preserved with (env e) {
            requireSaneSetup();
            require e.msg.sender != currentContract;
        }
    }

/// A new plan books principal from the stable that arrived, not from the amount asked
rule createPlanBooksPrincipalFromWhatArrived(env e, uint32 p, uint256 amount, uint8 buys, address owner) {
    requireSaneSetup();
    requireKnownPair(p);
    require e.msg.sender != currentContract;

    uint256 x = createPlan(e, p, amount, buys, owner);

    assert to_mathint(planPrincipalPerBuy(x)) == lastArrived / buys;
}

/// Two plans in a round are never credited more asset units than the round minted, whatever their split of units
/// and principal
rule roundCreditsNeverExceedWhatWasBought(
    uint256 assetUnits,
    uint256 stableRedeemed,
    uint16 rateBps,
    uint256 unitsA,
    uint256 principalA,
    uint256 unitsB,
    uint256 principalB
) {
    require rateBps <= 10000;
    require unitsA + unitsB > 0;
    uint256 fee = roundFeeOf(stableRedeemed, require_uint256(principalA + principalB), rateBps);
    uint256 stableNet = require_uint256(stableRedeemed - fee);
    require stableNet > 0;
    // The round charges a rate only when it made interest
    uint16 rateCharged = rateBps;
    if (to_mathint(stableRedeemed) <= principalA + principalB) {
        rateCharged = 0;
    }

    uint256 credited = twoPlansCredit(
        assetUnits,
        stableRedeemed,
        stableNet,
        rateCharged,
        unitsA,
        principalA,
        unitsB,
        principalB
    );

    assert credited <= assetUnits;
}
