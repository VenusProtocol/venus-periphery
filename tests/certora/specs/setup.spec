/*
 * Shared setup for the SmartDCA specs.
 *
 * Outside contracts are not real code here. Their effect is modelled in CVL:
 * - ERC20 balances live in the ghost `bal[token][account]`. A transferFrom may deliver less than asked, like a
 *   token that takes a fee on transfer.
 * - A Liquidity Hub mints `assets * 1e24 / rate` shares and pays `shares * rate / 1e24` on redeem.
 * - A Core vToken mints `amount * 1e18 / rate` vTokens and pays `vTokens * rate / 1e18` on redeem.
 *   `rate` is any positive number per source, fixed within one call.
 * - The forceBuy router takes the stable it is given (spending SmartDCA's approval) and returns any amount of
 *   asset.
 * - Keeper swaps reach `SwapHelperMock`: it sends any two token amounts it holds to anyone and may call back into
 *   SmartDCA once. It cannot write SmartDCA's storage, which a real SwapHelper cannot either.
 * - Approvals live in the ghost `allowanceG[token][owner][spender]`. A Hub, vToken or router spends exactly what it
 *   pulls.
 * - The oracle returns a fixed price per token from the ghost `priceOf`. AccessControlManager and Comptroller
 *   return any value.
 * - Any other call the Prover cannot resolve changes nothing (all money functions are `nonReentrant`).
 * - `Math.mulDiv` is replaced by exact integer math (its rounding-up form keeps its own code on top of that), and
 *   `roundStart` by any function that grows with the round.
 *
 * Paths where a modelled call would revert in real code (not enough balance, divide by zero) are dropped. That is
 * sound for the rules here: a reverted call changes no state.
 */

using SwapHelperMock as swapHelperMock;

methods {
    // Harness getters
    function sourceShares(uint32, uint8) external returns (uint256) envfree;
    function sourceUnits(uint32, uint8) external returns (uint256) envfree;
    function sourceAddr(uint32, uint8) external returns (address) envfree;
    function sourceKind(uint32, uint8) external returns (uint8) envfree;
    function pairStable(uint32) external returns (address) envfree;
    function pairAsset(uint32) external returns (address) envfree;
    function lastSettled(uint32) external returns (uint32) envfree;
    function roundStableUnits(uint32) external returns (uint256) envfree;
    function pairEnabled(uint32) external returns (bool) envfree;
    function pairUnitIndex(uint32) external returns (uint256) envfree;
    function pairPrincipalIndex(uint32) external returns (uint256) envfree;
    function roundPartsDone(uint32, uint32) external returns (uint8) envfree;
    function roundStableToSwap(uint32, uint32) external returns (uint256) envfree;
    function roundAssetBought(uint32, uint32) external returns (uint256) envfree;
    function roundUnitIndexAfter(uint32, uint32) external returns (uint256) envfree;
    function roundPrincipalIndexAfter(uint32, uint32) external returns (uint256) envfree;
    function roundPrincipal(uint32) external returns (uint256) envfree;
    function roundPartsTotal(uint32, uint32) external returns (uint8) envfree;
    function roundStableRedeemed(uint32, uint32) external returns (uint256) envfree;
    function roundStableNet(uint32, uint32) external returns (uint256) envfree;
    function roundUnitsJoining(uint32, uint32) external returns (uint256) envfree;
    function roundUnitsEnding(uint32, uint32) external returns (uint256) envfree;
    function roundPrincipalJoining(uint32, uint32) external returns (uint256) envfree;
    function roundPrincipalEnding(uint32, uint32) external returns (uint256) envfree;
    function planCredit(uint256, uint256, uint256, uint256, uint16, uint256, uint256) external returns (uint256) envfree;
    function lastPlanId() external returns (uint256) envfree;
    function planOwner(uint256) external returns (address) envfree;
    function planPair(uint256) external returns (uint32) envfree;
    function planStatus(uint256) external returns (uint8) envfree;
    function planBuys(uint256) external returns (uint8) envfree;
    function planFirstRound(uint256) external returns (uint32) envfree;
    function planScheduleUnits(uint256) external returns (uint256) envfree;
    function planUnitsPerBuy(uint256) external returns (uint256) envfree;
    function planPrincipalPerBuy(uint256) external returns (uint256) envfree;
    function planPaid(uint256) external returns (uint256) envfree;
    function planCarried(uint256) external returns (uint256) envfree;
    function assetUnitsOwed(uint256) external returns (uint256) envfree;
    function buysSettledOf(uint256) external returns (uint8) envfree;
    function owedIn(address) external returns (uint256) envfree;
    function twoPlansCredit(uint256, uint256, uint256, uint16, uint256, uint256, uint256, uint256) external returns (uint256) envfree;
    function roundFeeOf(uint256, uint256, uint16) external returns (uint256) envfree;
    function roundStart(uint32) external returns (uint256) envfree;
    function pairCount() external returns (uint32) envfree;
    function reserve() external returns (address) envfree;
    function feeRateBps() external returns (uint16) envfree;
    function maxFeeRateBps() external returns (uint16) envfree;
    function isKeeper(address) external returns (bool) envfree;
    function allowedRouters(address) external returns (bool) envfree;
    function maxSlippageBps() external returns (uint16) envfree;
    function maxOracleDeviationBps() external returns (uint16) envfree;
    function fallbackSlippageBps() external returns (uint16) envfree;
    function maxParts() external returns (uint8) envfree;
    function paused() external returns (bool) envfree;
    function SWAP_HELPER() external returns (address) envfree;
    function FALLBACK_DELAY() external returns (uint256) envfree;

    // SwapHelper stand-in
    function swapHelperMock.tokenA() external returns (address) envfree;
    function swapHelperMock.tokenB() external returns (address) envfree;
    function swapHelperMock.callsSeen() external returns (uint256) envfree;
    function swapHelperMock.selectorAt(uint256) external returns (uint32) envfree;
    function swapHelperMock.firstArgAt(uint256) external returns (address) envfree;
    function swapHelperMock.secondArgAt(uint256) external returns (address) envfree;
    function swapHelperMock.doCallback() external returns (bool) envfree;
    function swapHelperMock.callbackTarget() external returns (address) envfree;
    function swapHelperMock.callbackSelector() external returns (uint32) envfree;
    function swapHelperMock.callbackSucceeded() external returns (bool) envfree;

    // ERC20
    function _.balanceOf(address account) external => balanceOfCVL(calledContract, account) expect uint256;
    function _.transfer(address to, uint256 amount) external => transferCVL(calledContract, executingContract, to, amount) expect bool;
    function _.transferFrom(address from, address to, uint256 amount) external => transferFromCVL(calledContract, from, to, amount) expect bool;
    function _.approve(address spender, uint256 amount) external => approveCVL(calledContract, executingContract, spender, amount) expect bool;

    // Liquidity Hub
    function _.deposit(uint256 assets, address receiver) external => hubDepositCVL(calledContract, executingContract, assets, receiver) expect uint256;
    function _.redeem(uint256 shares, address receiver, address owner) external => hubRedeemCVL(calledContract, shares, receiver, owner) expect uint256;
    function _.previewWithdraw(uint256 assets) external => hubPreviewWithdrawCVL(calledContract, assets) expect uint256;

    // Core vToken
    function _.mint(uint256 amount) external => vTokenMintCVL(calledContract, executingContract, amount) expect uint256;
    function _.redeem(uint256 vTokens) external => vTokenRedeemCVL(calledContract, executingContract, vTokens) expect uint256;
    function _.exchangeRateCurrent() external => rateOfCVL(calledContract) expect uint256;

    // forceBuy router
    function _.exactInput(IPancakeV3SwapRouter.ExactInputParams params) external => exactInputCVL(calledContract, executingContract, params) expect uint256;

    // Oracle, AccessControlManager, Comptroller
    function _.getPrice(address token) external => priceOfCVL(token) expect uint256;
    function _.isAllowedToCall(address, string) external => NONDET;
    function _.getXVSAddress() external => NONDET;
    function _.claimVenus(address, address[]) external => NONDET;

    // Math
    function Math.mulDiv(uint256 x, uint256 y, uint256 d) internal returns (uint256) => mulDivDownCVL(x, y, d);
    function SmartDCAMath.roundStart(uint256 anchorMonth, uint32 round) internal returns (uint256) => roundStartG(anchorMonth, round);
    function SmartDCAMath.latestStartedMonth(uint256) internal returns (uint256) => NONDET;

    // The keeper swap's low-level call goes to the SwapHelper stand-in
    unresolved external in SmartDCAAdminLib._ => DISPATCH [
        SwapHelperMock.multicall(bytes[], uint256, bytes32, bytes)
    ] default NONDET;

    // The stand-in's call back reaches SmartDCA's money functions (`swapRoundPart` itself is left out: the Prover
    // does not follow a function into itself)
    unresolved external in SwapHelperMock._ => DISPATCH [
        SmartDCAHarness.createPlan(uint32, uint256, uint8, address),
        SmartDCAHarness.topUpPlan(uint256, uint256),
        SmartDCAHarness.withdrawBought(uint256, uint256, bool, address),
        SmartDCAHarness.cancelPlan(uint256, bool, address),
        SmartDCAHarness.claimPlan(uint256, bool, address),
        SmartDCAHarness.startRound(uint32, uint8),
        SmartDCAHarness.resplitRound(uint32, uint8),
        SmartDCAHarness.settleRound(uint32),
        SmartDCAHarness.forceBuy(uint32, uint8),
        SmartDCAHarness.syncPair(uint32),
        SmartDCAHarness.claimRewards(address[]),
        SmartDCAHarness.sweepToken(address, address)
    ] default NONDET;

    // Anything else unknown changes nothing
    unresolved external in _._ => DISPATCH [] default NONDET;
}

/* ---------- ERC20 ---------- */

persistent ghost mapping(address => mapping(address => uint256)) bal;

/// Stable that arrived in the last transferFrom, after any fee on transfer
persistent ghost mathint lastArrived;

function balanceOfCVL(address token, address account) returns uint256 {
    return bal[token][account];
}

function moveCVL(address token, address from, address to, uint256 sent, uint256 arrived) {
    require bal[token][from] >= sent;
    bal[token][from] = assert_uint256(bal[token][from] - sent);
    bal[token][to] = require_uint256(bal[token][to] + arrived);
}

function transferCVL(address token, address from, address to, uint256 amount) returns bool {
    moveCVL(token, from, to, amount, amount);
    return true;
}

function transferFromCVL(address token, address from, address to, uint256 amount) returns bool {
    uint256 fee;
    require fee <= amount;
    moveCVL(token, from, to, amount, assert_uint256(amount - fee));
    lastArrived = amount - fee;
    return true;
}

/// Approvals given by SmartDCA (and anyone else)
persistent ghost mapping(address => mapping(address => mapping(address => uint256))) allowanceG;

function approveCVL(address token, address owner, address spender, uint256 amount) returns bool {
    allowanceG[token][owner][spender] = amount;
    return true;
}

/// A Hub, vToken or router pulling `amount` of `token` from `owner` uses up that much of the approval
function spendAllowanceCVL(address token, address owner, address spender, uint256 amount) {
    // A real token reverts when more is pulled than approved, so those paths are dropped. A missed approve call
    // would leave a deposit path with no reachable state, which the vacuity check reports.
    require allowanceG[token][owner][spender] >= amount;
    allowanceG[token][owner][spender] = assert_uint256(allowanceG[token][owner][spender] - amount);
}

/* ---------- Oracle ---------- */

persistent ghost mapping(address => uint256) priceOf;

function priceOfCVL(address token) returns uint256 {
    return priceOf[token];
}

/* ---------- Yield sources ---------- */

/// Token a Hub or vToken holds
persistent ghost mapping(address => address) underlyingOf;

/// Hub price per 1e24 shares, or vToken exchange rate scaled by 1e18
persistent ghost mapping(address => uint256) rateOf;

function rateOfCVL(address source) returns uint256 {
    return rateOf[source];
}

function hubDepositCVL(address hub, address caller, uint256 assets, address receiver) returns uint256 {
    require rateOf[hub] > 0;
    spendAllowanceCVL(underlyingOf[hub], caller, hub, assets);
    moveCVL(underlyingOf[hub], caller, hub, assets, assets);
    uint256 shares = require_uint256(assets * 10^24 / rateOf[hub]);
    bal[hub][receiver] = require_uint256(bal[hub][receiver] + shares);
    return shares;
}

function hubRedeemCVL(address hub, uint256 shares, address receiver, address owner) returns uint256 {
    require rateOf[hub] > 0;
    require bal[hub][owner] >= shares;
    bal[hub][owner] = assert_uint256(bal[hub][owner] - shares);
    // The Hub pays interest out of thin air in this model, so its own balance is not reduced
    uint256 assets = require_uint256(shares * rateOf[hub] / 10^24);
    bal[underlyingOf[hub]][receiver] = require_uint256(bal[underlyingOf[hub]][receiver] + assets);
    return assets;
}

function hubPreviewWithdrawCVL(address hub, uint256 assets) returns uint256 {
    require rateOf[hub] > 0;
    return require_uint256((assets * 10^24 + rateOf[hub] - 1) / rateOf[hub]);
}

function vTokenMintCVL(address vToken, address caller, uint256 amount) returns uint256 {
    require rateOf[vToken] > 0;
    spendAllowanceCVL(underlyingOf[vToken], caller, vToken, amount);
    moveCVL(underlyingOf[vToken], caller, vToken, amount, amount);
    uint256 minted = require_uint256(amount * 10^18 / rateOf[vToken]);
    bal[vToken][caller] = require_uint256(bal[vToken][caller] + minted);
    return 0;
}

function vTokenRedeemCVL(address vToken, address caller, uint256 vTokens) returns uint256 {
    require rateOf[vToken] > 0;
    require bal[vToken][caller] >= vTokens;
    bal[vToken][caller] = assert_uint256(bal[vToken][caller] - vTokens);
    uint256 amount = require_uint256(vTokens * rateOf[vToken] / 10^18);
    bal[underlyingOf[vToken]][caller] = require_uint256(bal[underlyingOf[vToken]][caller] + amount);
    return 0;
}

/* ---------- forceBuy router ---------- */

/// Tokens the router swaps between; rules set them to the pair's stable and asset
persistent ghost address swapIn;
persistent ghost address swapOut;

function exactInputCVL(address router, address caller, IPancakeV3SwapRouter.ExactInputParams params) returns uint256 {
    uint256 out;
    spendAllowanceCVL(swapIn, caller, router, params.amountIn);
    moveCVL(swapIn, caller, router, params.amountIn, params.amountIn);
    bal[swapOut][params.recipient] = require_uint256(bal[swapOut][params.recipient] + out);
    return out;
}

/* ---------- Math ---------- */

function mulDivDownCVL(uint256 x, uint256 y, uint256 d) returns uint256 {
    require d != 0;
    return require_uint256(x * y / d);
}

/// Start time of each round: any function that grows with the round number
ghost roundStartG(uint256, uint32) returns uint256 {
    axiom forall uint256 a. forall uint32 r1. forall uint32 r2. r1 < r2 => roundStartG(a, r1) < roundStartG(a, r2);
}

/* ---------- Helpers ---------- */

definition STABLE() returns uint8 = 0;
definition ASSET() returns uint8 = 1;
definition ACTIVE() returns uint8 = 1;
definition CLAIMED() returns uint8 = 3;

/// Calls left out of the rules over every function: the SwapHelper stand-in's own functions, the units harness calls,
/// `addPair` (a new pair holds nothing) and `initialize`. `setYieldSource` makes its token calls inside the library's
/// own code, where the Prover cannot tell which function is called and returns arbitrary values; the Foundry source
/// tests and the random walk in `SmartDCA_Fuzz.t.sol` check that a source move keeps the holdings.
definition isExcluded(method f) returns bool =
    f.contract != currentContract ||
    f.selector == sig:depositH(uint32, uint8, uint256).selector ||
    f.selector == sig:burnUnitsH(uint32, uint8, uint256).selector ||
    f.selector == 0xfe332899 || // setYieldSource(uint32,uint8,uint8,address)
    f.selector == 0x907fdd7d || // addPair(address,address,uint8,address,uint8,address)
    f.selector == 0x485cc955;   // initialize(address,address)

/// A pair whose tokens and sources are distinct, whose sources hold the pair's own tokens, and whose rates are set
function requirePairSane(uint32 p) {
    address stable = pairStable(p);
    address asset = pairAsset(p);
    address stableSrc = sourceAddr(p, STABLE());
    address assetSrc = sourceAddr(p, ASSET());
    require stable != asset;
    require stableSrc != assetSrc;
    require stableSrc != stable && stableSrc != asset && assetSrc != stable && assetSrc != asset;
    require underlyingOf[stableSrc] == stable && underlyingOf[assetSrc] == asset;
    require rateOf[stableSrc] > 0 && rateOf[assetSrc] > 0;
    require stable != currentContract && asset != currentContract;
    require stableSrc != currentContract && assetSrc != currentContract;
    require swapHelperMock != stable && swapHelperMock != asset;
    require swapHelperMock != stableSrc && swapHelperMock != assetSrc;
}

/// No token of one pair is a source or the other side's token of the other pair
function requireCrossSane() {
    require pairAsset(1) != pairAsset(2);
    require pairAsset(1) != pairStable(2) && pairAsset(2) != pairStable(1);
    require sourceAddr(1, STABLE()) != pairStable(2) && sourceAddr(1, STABLE()) != pairAsset(2);
    require sourceAddr(1, ASSET()) != pairStable(2) && sourceAddr(1, ASSET()) != pairAsset(2);
    require sourceAddr(2, STABLE()) != pairStable(1) && sourceAddr(2, STABLE()) != pairAsset(1);
    require sourceAddr(2, ASSET()) != pairStable(1) && sourceAddr(2, ASSET()) != pairAsset(1);
    require sourceAddr(1, ASSET()) != sourceAddr(2, ASSET());
    require sourceAddr(1, STABLE()) != sourceAddr(2, ASSET()) && sourceAddr(2, STABLE()) != sourceAddr(1, ASSET());
}

/// Pair of each plan, mirrored from storage so a rule can state it for every plan at once
ghost mapping(uint256 => uint32) planPairG {
    init_state axiom forall uint256 i. planPairG[i] == 0;
}

hook Sload uint32 v plans[KEY uint256 id].pairId {
    require planPairG[id] == v;
}

hook Sstore plans[KEY uint256 id].pairId uint32 v {
    planPairG[id] = v;
}

/// Owner and status of each plan, mirrored from storage so a rule can state them for every plan at once
ghost mapping(uint256 => address) planOwnerG {
    init_state axiom forall uint256 i. planOwnerG[i] == 0;
}

hook Sload address v plans[KEY uint256 id].owner {
    require planOwnerG[id] == v;
}

hook Sstore plans[KEY uint256 id].owner address v {
    planOwnerG[id] = v;
}

ghost mapping(uint256 => ISmartDCA.PlanStatus) planStatusG {
    init_state axiom forall uint256 i. planStatusG[i] == ISmartDCA.PlanStatus.None;
}

hook Sload ISmartDCA.PlanStatus v plans[KEY uint256 id].status {
    require planStatusG[id] == v;
}

hook Sstore plans[KEY uint256 id].status ISmartDCA.PlanStatus v {
    planStatusG[id] = v;
}

/// Plan ids run from 1 to `lastPlanId`. A plan not made yet is empty, and every made plan is on a pair that exists.
function requirePlansSane() {
    uint256 last = lastPlanId();
    uint32 n = pairCount();
    require forall uint256 id. (id == 0 || id > last) =>
        (planOwnerG[id] == 0 && planStatusG[id] == ISmartDCA.PlanStatus.None && planPairG[id] == 0);
    require forall uint256 id. (id >= 1 && id <= last) => (planPairG[id] >= 1 && planPairG[id] <= n);
}

/// A round's record stays empty until `startRound` writes it
function requireRoundEmpty(uint32 p, uint32 r) {
    require roundPartsTotal(p, r) == 0 && roundPartsDone(p, r) == 0;
    require roundStableToSwap(p, r) == 0 && roundAssetBought(p, r) == 0;
    require roundStableRedeemed(p, r) == 0 && roundStableNet(p, r) == 0;
}

/// Only the next round can have started, and its record is empty until it does. Rounds after it are empty.
/// Checked for the four rounds after it: one settle plus the empty rounds the unrolled loop can settle.
function requireLaterRoundsUnstarted(uint32 p) {
    require lastSettled(p) < max_uint32 - 5;
    uint32 next = require_uint32(lastSettled(p) + 1);
    if (roundPartsTotal(p, next) == 0) {
        requireRoundEmpty(p, next);
    }
    requireRoundEmpty(p, require_uint32(next + 1));
    requireRoundEmpty(p, require_uint32(next + 2));
    requireRoundEmpty(p, require_uint32(next + 3));
    requireRoundEmpty(p, require_uint32(next + 4));
}

/// Up to two pairs (the loops are unrolled twice). They may share a stable and its Hub. Fee rates are in range,
/// plans are as `createPlan` leaves them, and no round past a pair's next one has started or holds anything.
function requireSaneSetup() {
    require pairCount() >= 1 && pairCount() <= 2;
    require SWAP_HELPER() == swapHelperMock && swapHelperMock != currentContract;
    // The fee cap is at most 100% and the fee rate at most the cap (`setMaxFeeRate`, `setFeeRate`)
    require maxFeeRateBps() <= 10000 && feeRateBps() <= maxFeeRateBps();
    requirePlansSane();
    // The fallback route, set by governance, swaps one pair's stable for that pair's asset
    require (swapIn == pairStable(1) && swapOut == pairAsset(1)) ||
        (pairCount() == 2 && swapIn == pairStable(2) && swapOut == pairAsset(2));
    requirePairSane(1);
    requireLaterRoundsUnstarted(1);
    if (pairCount() == 2) {
        requirePairSane(2);
        requireLaterRoundsUnstarted(2);
        requireCrossSane();
    }
}

/// A pair id that exists
function requireKnownPair(uint32 p) {
    require p >= 1 && p <= pairCount();
}

/// Stable units an active plan still holds in the stable source: its schedule less the buys already settled, and
/// less the running round's buy once `startRound` has burned it
function unitsHeldByPlan(uint256 x) returns mathint {
    if (planStatus(x) != ACTIVE()) {
        return 0;
    }
    uint32 p = planPair(x);
    require lastSettled(p) < max_uint32;
    uint32 next = require_uint32(lastSettled(p) + 1);
    mathint first = planFirstRound(x);
    bool inStartedRound = roundPartsTotal(p, next) != 0 && first <= to_mathint(next) && next < first + planBuys(x);
    mathint running = inStartedRound ? to_mathint(planUnitsPerBuy(x)) : 0;
    return planScheduleUnits(x) - planUnitsPerBuy(x) * buysSettledOf(x) - running;
}

/// Whether an active plan buys in its pair's next round
function inNextRound(uint256 x) returns bool {
    uint32 p = planPair(x);
    mathint next = lastSettled(p) + 1;
    mathint first = planFirstRound(x);
    return planStatus(x) == ACTIVE() && first <= next && next < first + planBuys(x);
}

/// Stable units and principal a plan puts into its pair's next round
function unitsInNextRound(uint256 x) returns mathint {
    return inNextRound(x) ? to_mathint(planUnitsPerBuy(x)) : 0;
}

function principalInNextRound(uint256 x) returns mathint {
    return inNextRound(x) ? to_mathint(planPrincipalPerBuy(x)) : 0;
}

/// The forceBuy router swaps this pair's stable for its asset
function requireSwapsFor(uint32 p) {
    require swapIn == pairStable(p) && swapOut == pairAsset(p);
}

/// Money functions a swap's call back may try
definition isMoneySelector(uint32 s) returns bool =
    s == sig:createPlan(uint32, uint256, uint8, address).selector ||
    s == sig:topUpPlan(uint256, uint256).selector ||
    s == sig:withdrawBought(uint256, uint256, bool, address).selector ||
    s == sig:cancelPlan(uint256, bool, address).selector ||
    s == sig:claimPlan(uint256, bool, address).selector ||
    s == sig:startRound(uint32, uint8).selector ||
    s == sig:resplitRound(uint32, uint8).selector ||
    s == sig:settleRound(uint32).selector ||
    s == sig:forceBuy(uint32, uint8).selector ||
    s == sig:syncPair(uint32).selector ||
    s == sig:claimRewards(address[]).selector ||
    s == sig:sweepToken(address, address).selector;

/// SwapHelper calls a route may make
definition GENERIC_CALL() returns uint32 = 0x4650c308;
definition APPROVE_MAX() returns uint32 = 0xaec42a17;
definition SWEEP() returns uint32 = 0xb8dc491b;

/// Oracle value of `amount` stable in asset, as SmartDCA computes it
function oracleValue(uint32 p, uint256 amount) returns mathint {
    require priceOf[pairAsset(p)] > 0;
    return amount * priceOf[pairStable(p)] / priceOf[pairAsset(p)];
}
