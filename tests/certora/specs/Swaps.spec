import "setup.spec";

/*
 * Swaps, assuming the keeper key and the backend signer are both stolen: the route is any SwapHelper multicall,
 * and the stand-in SwapHelper can move any tokens it holds and call back into SmartDCA.
 */

/// Stable the running round's next part sells
function nextPartStableIn(uint32 p, uint32 next) returns mathint {
    return roundStableToSwap(p, next) / (roundPartsTotal(p, next) - roundPartsDone(p, next));
}

/// A started round with a part left to swap and at least one more after it, so the call does not settle
function requirePartLeft(uint32 p, uint32 next, bool keepOneMore) {
    require roundPartsTotal(p, next) != 0;
    require keepOneMore
        ? roundPartsDone(p, next) + 1 < to_mathint(roundPartsTotal(p, next))
        : roundPartsDone(p, next) < roundPartsTotal(p, next);
}

/// A keeper part sells exactly its share of the round's stable, takes no more stable than that from SmartDCA,
/// books exactly the asset that arrived, and lowers no other token SmartDCA holds
rule keeperPartMovesOnlyItsOwnTokens(env e, uint32 p, uint256 quotedOut, bytes swapData, address other) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    requirePartLeft(p, next, false);
    address stable = pairStable(p);
    address asset = pairAsset(p);
    require other != stable && other != asset;

    mathint stableIn = nextPartStableIn(p, next);
    uint256 toSwapBefore = roundStableToSwap(p, next);
    uint256 boughtBefore = roundAssetBought(p, next);
    uint256 stableBalBefore = bal[stable][currentContract];
    uint256 assetBalBefore = bal[asset][currentContract];
    uint256 otherBalBefore = bal[other][currentContract];

    swapRoundPart(e, p, quotedOut, swapData);

    assert toSwapBefore - roundStableToSwap(p, next) == stableIn;
    assert stableBalBefore - bal[stable][currentContract] <= stableIn;
    assert roundAssetBought(p, next) - boughtBefore == bal[asset][currentContract] - assetBalBefore;
    assert bal[other][currentContract] >= otherBalBefore;
}

/// A keeper part books at least the oracle value of its stable less the allowed band, whatever quote is passed
rule keeperPartPaysAtLeastTheOracleFloor(env e, uint32 p, uint256 quotedOut, bytes swapData) {
    requireSaneSetup();
    requireKnownPair(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    requirePartLeft(p, next, false);
    require maxOracleDeviationBps() < 10000;

    uint256 stableIn = require_uint256(nextPartStableIn(p, next));
    mathint floor = oracleValue(p, stableIn) * (10000 - maxOracleDeviationBps()) / 10000;
    uint256 boughtBefore = roundAssetBought(p, next);

    swapRoundPart(e, p, quotedOut, swapData);

    assert roundAssetBought(p, next) - boughtBefore >= floor;
}

/// `forceBuy` sells the whole part and books at least the oracle value less the fallback slippage
rule forceBuySellsTheWholePartAboveTheFloor(env e, uint32 p) {
    requireSaneSetup();
    requireKnownPair(p);
    requireSwapsFor(p);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    requirePartLeft(p, next, true);

    uint256 stableIn = require_uint256(nextPartStableIn(p, next));
    mathint floor = oracleValue(p, stableIn) * (10000 - fallbackSlippageBps()) / 10000;
    uint256 toSwapBefore = roundStableToSwap(p, next);
    uint256 boughtBefore = roundAssetBought(p, next);

    forceBuy(e, p, 0);

    assert toSwapBefore - roundStableToSwap(p, next) == to_mathint(stableIn);
    assert roundAssetBought(p, next) - boughtBefore >= floor;
}

/// Every call in a route that goes through names only allowed routers for `genericCall` and `approveMax`, and
/// `sweep` sends only the pair's stable or asset, only to SmartDCA
rule keeperRouteOnlyReachesAllowedRouters(env e, uint32 p, uint256 quotedOut, bytes swapData, uint256 i) {
    requireSaneSetup();
    requireKnownPair(p);

    swapRoundPart(e, p, quotedOut, swapData);

    require i < swapHelperMock.callsSeen();
    uint32 selector = swapHelperMock.selectorAt(i);
    address first = swapHelperMock.firstArgAt(i);
    address second = swapHelperMock.secondArgAt(i);
    assert selector == GENERIC_CALL() => allowedRouters(first);
    assert selector == APPROVE_MAX() => allowedRouters(second);
    assert selector == SWEEP() => ((first == pairStable(p) || first == pairAsset(p)) && second == currentContract);
}

/// A call back into any SmartDCA money function during a swap fails
rule swapCallbackCannotReenter(env e, uint32 p, uint256 quotedOut, bytes swapData) {
    requireSaneSetup();
    requireKnownPair(p);
    // A call back to any other address does not reach SmartDCA
    require swapHelperMock.callbackTarget() == currentContract;

    swapRoundPart(e, p, quotedOut, swapData);

    assert (swapHelperMock.doCallback() && isMoneySelector(swapHelperMock.callbackSelector())) =>
        !swapHelperMock.callbackSucceeded();
}

/// No call leaves an approval from SmartDCA open: what it approves, the Hub, vToken or router spends in full
rule noApprovalLeftOpen(env e, method f, calldataarg args, address token, address spender) filtered {
    f -> !isExcluded(f)
} {
    requireSaneSetup();
    require allowanceG[token][currentContract][spender] == 0;

    f(e, args);

    assert allowanceG[token][currentContract][spender] == 0;
}
