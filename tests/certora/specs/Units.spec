import "setup.spec";

/*
 * Units math: rounding never helps the caller. Holds in shares per unit, not in tokens.
 */

/// A deposit's units round down, so the shares behind each existing unit never go down
rule depositNeverLowersSharesPerUnit(env e, uint32 p, uint8 side, uint256 amount) {
    requireSaneSetup();
    requireKnownPair(p);
    require side <= 1;
    require e.msg.sender != currentContract;
    mathint sharesBefore = sourceShares(p, side);
    mathint unitsBefore = sourceUnits(p, side);
    require sharesBefore > 0 && unitsBefore > 0;

    depositH(e, p, side, amount);

    mathint sharesAfter = sourceShares(p, side);
    mathint unitsAfter = sourceUnits(p, side);
    // sharesAfter / unitsAfter >= sharesBefore / unitsBefore, without the division
    assert sharesAfter * unitsBefore >= sharesBefore * unitsAfter;
}

/// A burn's shares round down, so the shares behind each remaining unit never go down, and burning every unit
/// takes every share
rule burnNeverLowersSharesPerUnitLeft(env e, uint32 p, uint8 side, uint256 units) {
    require side <= 1;
    mathint sharesBefore = sourceShares(p, side);
    mathint unitsBefore = sourceUnits(p, side);

    uint256 shares = burnUnitsH(e, p, side, units);

    mathint sharesAfter = sourceShares(p, side);
    mathint unitsAfter = sourceUnits(p, side);
    assert shares * unitsBefore <= units * sharesBefore;
    assert sharesAfter * unitsBefore >= sharesBefore * unitsAfter;
    assert unitsAfter == 0 => sharesAfter == 0;
}

/// A partial withdraw burns between 1 and the owed units, and pays at least the amount asked
rule withdrawPaysAtLeastTheAmountAsked(env e, uint256 planId, uint256 amount, address receiver) {
    requireSaneSetup();
    require amount != max_uint256;
    uint32 p = planPair(planId);
    requireKnownPair(p);
    address asset = pairAsset(p);
    require receiver != currentContract && receiver != sourceAddr(p, ASSET());
    mathint owed = assetUnitsOwed(planId);
    mathint paidBefore = planPaid(planId);
    mathint receivedBefore = bal[asset][receiver];

    withdrawBought(e, planId, amount, false, receiver);

    mathint burned = planPaid(planId) - paidBefore;
    assert burned >= 1 && burned <= owed;
    assert bal[asset][receiver] - receivedBefore >= to_mathint(amount);
}
