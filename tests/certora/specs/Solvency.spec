import "setup.spec";

/*
 * Solvency: the records match the balances, and the plans' claims fit in the records.
 */

/// For every token, SmartDCA holds at least what `sweepToken` counts as owed: each source's shares, plus the
/// stable and asset of each running round. Two pairs may share a stable and its Hub.
invariant heldCoversOwed(address token)
    to_mathint(bal[token][currentContract]) >= to_mathint(owedIn(token))
    filtered { f -> !isExcluded(f) }
    {
        preserved with (env e) {
            requireSaneSetup();
            require e.msg.sender != currentContract;
        }
    }

/// `sweepToken` takes only the extra: SmartDCA is left holding exactly what it owes, and the receiver gets the rest
rule sweepTakesOnlyTheExtra(env e, address token, address to) {
    requireSaneSetup();
    require to != currentContract;
    require bal[token][currentContract] >= owedIn(token);
    mathint heldBefore = bal[token][currentContract];
    mathint toBefore = bal[token][to];

    sweepToken(e, token, to);

    assert to_mathint(bal[token][currentContract]) == to_mathint(owedIn(token));
    assert bal[token][to] - toBefore == heldBefore - bal[token][currentContract];
}

/// A source's record never rises by more shares than arrived at SmartDCA, and never falls by fewer than left it.
/// So a record cannot grow from nothing, and shares cannot leave without the record dropping. Shares sent straight
/// to SmartDCA (by a swap route, or a plan owner naming SmartDCA as the receiver) raise the balance and no record,
/// which `heldCoversOwed` covers. `sweepToken` is left out: it moves only that extra.
rule sharesBookedFromWhatArrived(env e, method f, calldataarg args, uint8 side) filtered {
    f -> !isExcluded(f) && f.selector != sig:sweepToken(address, address).selector
} {
    requireSaneSetup();
    // One pair: two pairs may share a Hub, and then one pair's record is only part of the Hub balance
    require pairCount() == 1;
    require side <= 1;
    require e.msg.sender != currentContract;
    address src = sourceAddr(1, side);
    mathint heldBefore = bal[src][currentContract];
    mathint bookedBefore = sourceShares(1, side);

    f(e, args);

    assert bal[src][currentContract] - heldBefore >= sourceShares(1, side) - bookedBefore;
}

/// The pair's other plans are not active, so `a` and `b` are the only plans holding units
function requireOnlyActivePlans(uint32 p, uint256 a, uint256 b) {
    require forall uint256 id. (id != a && id != b && planPairG[id] == p) =>
        planStatusG[id] != ISmartDCA.PlanStatus.Active;
}

/// Stable units and principal an active plan books as joining round `r` (its first round is `r + 1`, after the
/// next round) or ending in round `r` (its last round)
function unitsJoining(uint256 x, uint32 r) returns mathint {
    return planStatus(x) == ACTIVE() && to_mathint(planFirstRound(x)) == r + 1 ? to_mathint(planUnitsPerBuy(x)) : 0;
}

function principalJoining(uint256 x, uint32 r) returns mathint {
    return planStatus(x) == ACTIVE() && to_mathint(planFirstRound(x)) == r + 1 ? to_mathint(planPrincipalPerBuy(x)) : 0;
}

function unitsEnding(uint256 x, uint32 r) returns mathint {
    return planStatus(x) == ACTIVE() && planFirstRound(x) + planBuys(x) - 1 == to_mathint(r) ? to_mathint(planUnitsPerBuy(x)) : 0;
}

function principalEnding(uint256 x, uint32 r) returns mathint {
    return planStatus(x) == ACTIVE() && planFirstRound(x) + planBuys(x) - 1 == to_mathint(r) ? to_mathint(planPrincipalPerBuy(x)) : 0;
}

/// Round `r`'s joining and ending totals are exactly what `a` and `b` booked there
function requireRoundBooked(uint32 p, uint256 a, uint256 b, uint32 r) {
    require to_mathint(roundUnitsJoining(p, r)) == unitsJoining(a, r) + unitsJoining(b, r);
    require to_mathint(roundPrincipalJoining(p, r)) == principalJoining(a, r) + principalJoining(b, r);
    require to_mathint(roundUnitsEnding(p, r)) == unitsEnding(a, r) + unitsEnding(b, r);
    require to_mathint(roundPrincipalEnding(p, r)) == principalEnding(a, r) + principalEnding(b, r);
}

/// A pair whose only active plans are `a` and `b`, with its books as `createPlan`, `topUpPlan` and `cancelPlan`
/// leave them: the next round's totals are exactly the two plans' amounts per buy, the rounds a call can close hold
/// exactly what the two plans booked there, and the last closed round stored the pair's current indexes
function requireTwoPlanPair(uint32 p, uint256 a, uint256 b) {
    require a != b;
    requireKnownPair(p);
    require planPair(a) == p && planPair(b) == p;
    requireOnlyActivePlans(p, a, b);
    // `createPlan` rejects a plan with no units per buy, and a schedule always has a buy left
    require planStatus(a) == ACTIVE() => (planUnitsPerBuy(a) > 0 && planBuys(a) > 0);
    require planStatus(b) == ACTIVE() => (planUnitsPerBuy(b) > 0 && planBuys(b) > 0);
    // Proven by `scheduleCoversItsBuys` in Payouts
    require planStatus(a) == ACTIVE() => to_mathint(planScheduleUnits(a)) >= planUnitsPerBuy(a) * planBuys(a);
    require planStatus(b) == ACTIVE() => to_mathint(planScheduleUnits(b)) >= planUnitsPerBuy(b) * planBuys(b);
    require to_mathint(roundStableUnits(p)) == unitsInNextRound(a) + unitsInNextRound(b);
    require to_mathint(roundPrincipal(p)) == principalInNextRound(a) + principalInNextRound(b);
    uint32 next = require_uint32(lastSettled(p) + 1);
    requireRoundBooked(p, a, b, next);
    requireRoundBooked(p, a, b, require_uint32(next + 1));
    requireRoundBooked(p, a, b, require_uint32(next + 2));
    requireRoundBooked(p, a, b, require_uint32(next + 3));
    require roundUnitIndexAfter(p, lastSettled(p)) == pairUnitIndex(p);
    require roundPrincipalIndexAfter(p, lastSettled(p)) == pairPrincipalIndex(p);
}

definition INDEX_SCALE() returns mathint = 10^36;

/// A plan's owed asset units times `INDEX_SCALE`, before the one round-down `assetUnitsOwed` makes. 0 once the plan
/// is not active.
function owedScaled(uint256 x) returns mathint {
    if (planStatus(x) != ACTIVE()) {
        return 0;
    }
    uint32 p = planPair(x);
    uint8 settled = buysSettledOf(x);
    mathint fromIndex = 0;
    if (settled > 0) {
        uint32 before = require_uint32(planFirstRound(x) - 1);
        uint32 last = require_uint32(planFirstRound(x) + settled - 1);
        fromIndex =
            planUnitsPerBuy(x) * (roundUnitIndexAfter(p, last) - roundUnitIndexAfter(p, before)) +
            planPrincipalPerBuy(x) * (roundPrincipalIndexAfter(p, last) - roundPrincipalIndexAfter(p, before));
    }
    return (planCarried(x) - planPaid(x)) * INDEX_SCALE() + fromIndex;
}

/// A pair whose only active plans are `a` and `b` never owes them more asset units than its asset source issued.
/// Checked on the exact amounts (before rounding down), since a plan rounds down once over all its rounds. Checked
/// as a step: if it holds before any call, it holds after. It does not prove that the starting state can be reached.
rule twoPlansFitTheAssetUnits(env e, method f, calldataarg args, uint256 a, uint256 b) filtered { f -> !isExcluded(f) } {
    requireSaneSetup();
    uint32 p = planPair(a);
    requireTwoPlanPair(p, a, b);
    require owedScaled(a) + owedScaled(b) <= sourceUnits(p, ASSET()) * INDEX_SCALE();

    f(e, args);

    assert owedScaled(a) + owedScaled(b) <= sourceUnits(p, ASSET()) * INDEX_SCALE();
}

/// A pair whose only active plans are `a` and `b`: its stable units issued equal the units the two plans still hold.
/// Same step check as above. A plan made by the call itself would be a third plan, so `createPlan` is left out.
rule twoPlansMatchTheStableUnits(env e, method f, calldataarg args, uint256 a, uint256 b) filtered {
    f -> !isExcluded(f) && f.selector != sig:createPlan(uint32, uint256, uint8, address).selector
} {
    requireSaneSetup();
    uint32 p = planPair(a);
    requireTwoPlanPair(p, a, b);
    require unitsHeldByPlan(a) + unitsHeldByPlan(b) == to_mathint(sourceUnits(p, STABLE()));

    f(e, args);

    assert unitsHeldByPlan(a) + unitsHeldByPlan(b) == to_mathint(sourceUnits(p, STABLE()));
}
