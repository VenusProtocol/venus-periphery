// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { AccessControlledV8 } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlledV8.sol";
import { ResilientOracleInterface } from "@venusprotocol/oracle/contracts/interfaces/OracleInterface.sol";

import { IHub } from "../CollateralGateway/IHub.sol";
import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IHubRegistry } from "../Interfaces/IHubLiquidity.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { SwapHelper } from "../SwapHelper/SwapHelper.sol";
import { SmartDCAAdminLib } from "./SmartDCAAdminLib.sol";
import { SmartDCAMath } from "./SmartDCAMath.sol";
import { ISmartDCA } from "./ISmartDCA.sol";

/**
 * @title SmartDCA
 * @author Venus
 * @notice Dollar cost averaging from a stable (USDT, USDC or U) into an asset (BTCB, ETH or WBNB). A user deposits
 *         once and picks how many monthly buys to make. Until each buy, the deposit earns interest in the pair's
 *         stable source (a Liquidity Hub at launch). Once a month a keeper buys for every plan of a pair at once, and
 *         the asset bought is supplied to the pair's asset source (Core at launch), where it keeps earning until
 *         the user takes it out. Each pair has its own two sources, set by governance.
 * @dev How one month runs for one pair:
 *      1. Lock. On the 15th at 00:00 UTC+8 the pair's round locks. Plans in it cannot top up or cancel until it
 *         settles, and new plans join next month's round instead.
 *      2. `startRound`. A keeper redeems the round's stable from the yield source and sends the fee to the Reserve.
 *         The fee is a share of the interest only, never of principal.
 *      3. `swapRoundPart`. The keeper swaps that stable for the asset in 1 to `maxParts` parts through SwapHelper,
 *         on routes built and signed off chain. Each part must return at least the keeper's fresh quote less
 *         `maxSlippageBps`.
 *      4. `settleRound`. The asset bought is supplied to its yield source and the round closes.
 *
 *      No call loops over plans. Every plan sells the same number of stable units in each of its buys, so a pair
 *      only stores the totals of its next round (`roundStableUnits`, `roundPrincipal`). Settling a round adds the
 *      asset bought per stable unit sold to a running index, and a plan's asset is its units per buy times how much
 *      the index grew over its rounds. A plan that starts or ends in a later round is added to or removed from the
 *      totals when the round before it settles, through that round's `stableUnitsJoining` and `stableUnitsEnding`.
 *      So every call costs the same gas however many plans a pair has.
 *
 *      SmartDCA never borrows and never enables a market as collateral, so nothing it holds can be liquidated.
 *
 *      {SmartDCAAdminLib} is linked for EIP-170 headroom; a library declares no state, so it cannot shift this layout.
 * @custom:oz-upgrades-unsafe-allow external-library-linking
 */
contract SmartDCA is ISmartDCA, AccessControlledV8, PausableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice Highest slippage bound governance can set, for keeper swaps and for `forceBuy`, in basis points (1%)
    uint16 public constant MAX_SLIPPAGE_BPS = 100;

    /// @notice Highest number of parts a round can be split into
    uint8 public constant MAX_PARTS = 50;

    /// @notice Highest number of buys a plan can have (10 years of monthly buys)
    uint8 public constant MAX_BUYS = 120;

    /// @notice Time after a round's start before `forceBuy` can run it, so the keeper always goes first
    uint256 public constant FALLBACK_DELAY = 24 hours;

    /// @notice Core pool Comptroller; Core yield sources must be listed in it
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IComptroller public immutable COMPTROLLER;

    /// @notice Hub registry; Hub yield sources must be registered in it
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IHubRegistry public immutable HUB_REGISTRY;

    /// @notice Oracle that must price both tokens of a new pair
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ResilientOracleInterface public immutable ORACLE;

    /// @notice SwapHelper every swap goes through; it only runs a multicall signed by its backend signer
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    SwapHelper public immutable SWAP_HELPER;

    /// @notice Fee rate on the interest part of each buy and of a cancel, in basis points
    uint16 public feeRateBps;

    /// @notice Most a swap can return below the keeper's quote, in basis points
    uint16 public maxSlippageBps;

    /// @notice Most parts a round can be split into
    uint8 public maxParts;

    /// @notice Fewest buys a new plan can have
    uint8 public minBuys;

    /// @notice Most buys a new plan can have
    uint8 public maxBuys;

    /// @notice Number of pairs; pair ids run from 1 to `pairCount`
    uint32 public pairCount;

    /// @notice Receives fees and rewards
    address public reserve;

    /// @notice Highest fee rate governance can set, in basis points; 20% at launch
    uint16 public maxFeeRateBps;

    /// @notice Most a `forceBuy` swap can return below the oracle price, in basis points
    uint16 public fallbackSlippageBps;

    /// @notice Month of round 0, counted as `year * 12 + (month - 1)`; set once at deploy
    uint32 public anchorMonth;

    /// @notice Id of the last plan created; plan ids start at 1
    uint256 public lastPlanId;

    /// @notice Pairs by id
    mapping(uint32 pairId => Pair) public pairs;

    /// @notice Pair id by stable and asset, 0 when none
    mapping(address stable => mapping(address asset => uint32 pairId)) public pairIdByTokens;

    /// @notice Rounds by pair and round number
    mapping(uint32 pairId => mapping(uint32 round => Round)) public rounds;

    /// @notice Plans by id
    mapping(uint256 planId => Plan) public plans;

    /// @notice Yield source of each side of each pair
    mapping(uint32 pairId => mapping(Side side => YieldSource)) public yieldSources;

    /// @notice Least stable amount per buy, in the stable's decimals
    mapping(address stable => uint256 amount) public minAmountPerBuy;

    /// @notice Addresses that run rounds from the lock time
    mapping(address account => bool) public isKeeper;

    /// @dev Plan ids each owner holds
    mapping(address owner => uint256[] planIds) private _planIdsByOwner;

    /// @notice PancakeSwap V3 route of each pair, used only by `forceBuy`
    mapping(uint32 pairId => FallbackRoute) public fallbackRoutes;

    /// @notice Routers a keeper swap may call or approve
    mapping(address router => bool) public allowedRouters;

    /// @dev Storage gap for future upgrades; with the 13 slots above, SmartDCA's own state takes 50 slots
    uint256[37] private __gap;

    /**
     * @notice Sets the external contracts and disables initializers on the implementation
     * @param comptroller Core pool Comptroller
     * @param hubRegistry Liquidity Hub registry
     * @param oracle ResilientOracle
     * @param swapHelper SwapHelper that runs the signed swap multicall
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor(address comptroller, address hubRegistry, address oracle, address swapHelper) {
        if (comptroller == address(0) || hubRegistry == address(0) || oracle == address(0) || swapHelper == address(0))
            revert ZeroAddress();
        COMPTROLLER = IComptroller(comptroller);
        HUB_REGISTRY = IHubRegistry(hubRegistry);
        ORACLE = ResilientOracleInterface(oracle);
        SWAP_HELPER = SwapHelper(swapHelper);
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy with the launch parameters
     * @dev Fee rate 0 with a cap of 20%, slippage bound 0.1%, up to 10 parts per round, 2 to 60 buys per plan, and a
     *      0.5% slippage bound for `forceBuy`
     * @param accessControlManager_ AccessControlManager
     * @param reserve_ Receives fees and rewards
     */
    function initialize(address accessControlManager_, address reserve_) external initializer {
        if (reserve_ == address(0)) revert ZeroAddress();
        __AccessControlled_init(accessControlManager_);
        __Pausable_init();
        __ReentrancyGuard_init();
        reserve = reserve_;
        maxFeeRateBps = 2_000;
        maxSlippageBps = 10;
        maxParts = 10;
        minBuys = 2;
        maxBuys = 60;
        fallbackSlippageBps = 50;
        // Round 0 is the latest 15th already passed, so every later round is still ahead
        anchorMonth = uint32(SmartDCAMath.latestStartedMonth(block.timestamp));
    }

    /// @inheritdoc ISmartDCA
    function createPlan(
        uint32 pairId,
        uint256 amount,
        uint8 buys,
        address owner
    ) external nonReentrant whenNotPaused returns (uint256 planId) {
        if (owner == address(0)) revert ZeroAddress();
        Pair storage pair = _pair(pairId);
        if (!pair.enabled) revert PairDisabled();
        if (buys < minBuys || buys > maxBuys) revert InvalidBuys(buys, minBuys, maxBuys);
        uint256 minimum = minAmountPerBuy[pair.stable] * buys;
        if (amount < minimum) revert DepositTooSmall(amount, minimum);

        _settleEmptyRounds(pairId, pair);
        _emitRoundLocked(pairId, pair);

        uint256 received = _pullToken(pair.stable, amount);
        uint256 stableUnits = _deposit(yieldSources[pairId][Side.Stable], pair.stable, received);
        uint256 stableUnitsPerBuy = stableUnits / buys;
        uint256 principalPerBuy = received / buys;
        if (stableUnitsPerBuy == 0 || principalPerBuy == 0) revert DepositTooSmall(received, minimum);

        // Before the next round's lock the plan joins it, from the lock on the round after. During an overrun that
        // is the round right after the running one, not the calendar month.
        uint32 nextRound = pair.lastSettledRound + 1;
        uint32 firstRound = block.timestamp < roundStart(nextRound) ? nextRound : nextRound + 1;
        _addToRound(pairId, pair, firstRound, stableUnitsPerBuy, principalPerBuy);
        Round storage last = rounds[pairId][firstRound + buys - 1];
        last.stableUnitsEnding += stableUnitsPerBuy;
        last.principalEnding += principalPerBuy;

        planId = ++lastPlanId;
        plans[planId] = Plan({
            owner: owner,
            pairId: pairId,
            status: PlanStatus.Active,
            scheduleBuys: buys,
            buysBeforeSchedule: 0,
            scheduleFirstRound: firstRound,
            scheduleStableUnits: stableUnits,
            stableUnitsPerBuy: stableUnitsPerBuy,
            principalPerBuy: principalPerBuy,
            assetUnitsCarried: 0,
            assetUnitsPaid: 0
        });
        _planIdsByOwner[owner].push(planId);

        emit PlanCreated(
            planId,
            owner,
            pairId,
            received,
            stableUnits,
            stableUnitsPerBuy,
            principalPerBuy,
            buys,
            firstRound
        );
    }

    /// @inheritdoc ISmartDCA
    function topUpPlan(uint256 planId, uint256 amount) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        uint32 pairId = plan.pairId;
        Pair storage pair = pairs[pairId];
        if (!pair.enabled) revert PairDisabled();

        _settleEmptyRounds(pairId, pair);
        uint8 buysSettled = _buysSettled(plan, pair);
        if (buysSettled == plan.scheduleBuys) revert PlanMatured();
        if (_inRunningRound(plan, pair)) revert PlanInRunningRound();

        uint8 buysLeft = plan.scheduleBuys - buysSettled;
        uint256 minimum = minAmountPerBuy[pair.stable] * buysLeft;
        if (amount < minimum) revert DepositTooSmall(amount, minimum);

        // Restart the schedule from the next unsettled round, keeping what was bought so far
        plan.assetUnitsCarried += _assetUnitsFromIndex(plan, pairId, buysSettled);
        plan.buysBeforeSchedule += buysSettled;
        plan.scheduleFirstRound += buysSettled;
        plan.scheduleBuys = buysLeft;

        uint256 received = _pullToken(pair.stable, amount);
        uint256 stableUnitsAdded = _deposit(yieldSources[pairId][Side.Stable], pair.stable, received);
        uint256 stableUnits = plan.scheduleStableUnits - plan.stableUnitsPerBuy * buysSettled + stableUnitsAdded;
        uint256 stableUnitsPerBuy = stableUnits / buysLeft;
        uint256 principalPerBuy = plan.principalPerBuy + received / buysLeft;

        // Only the increase per buy moves; the plan's old amounts are already in the round totals
        uint256 perBuyIncrease = stableUnitsPerBuy - plan.stableUnitsPerBuy;
        uint256 principalIncrease = principalPerBuy - plan.principalPerBuy;
        _addToRound(pairId, pair, plan.scheduleFirstRound, perBuyIncrease, principalIncrease);
        Round storage last = rounds[pairId][plan.scheduleFirstRound + buysLeft - 1];
        last.stableUnitsEnding += perBuyIncrease;
        last.principalEnding += principalIncrease;

        plan.scheduleStableUnits = stableUnits;
        plan.stableUnitsPerBuy = stableUnitsPerBuy;
        plan.principalPerBuy = principalPerBuy;

        emit PlanToppedUp(planId, received, stableUnitsAdded, stableUnitsPerBuy, principalPerBuy, buysLeft);
    }

    /// @inheritdoc ISmartDCA
    function withdrawBought(uint256 planId, uint256 amount, address receiver) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        if (receiver == address(0)) revert ZeroAddress();
        Pair storage pair = pairs[plan.pairId];
        YieldSource storage assetSource = yieldSources[plan.pairId][Side.Asset];

        uint256 assetUnitsOwed = _assetUnitsOwed(plan, pair);
        // Checked first: with nothing bought the asset's source can hold nothing, and `_unitsForAmount` divides by it
        if (assetUnitsOwed == 0) revert ZeroAmount();
        uint256 assetUnits = amount == type(uint256).max ? assetUnitsOwed : _unitsForAmount(assetSource, amount);
        if (assetUnits == 0) revert ZeroAmount();
        if (assetUnits > assetUnitsOwed) revert WithdrawExceedsBought(assetUnits, assetUnitsOwed);

        plan.assetUnitsPaid += assetUnits;
        uint256 assetAmount = _redeem(assetSource, pair.asset, assetUnits);
        IERC20(pair.asset).safeTransfer(receiver, assetAmount);

        emit BoughtWithdrawn(planId, receiver, assetUnits, assetAmount);
    }

    /// @inheritdoc ISmartDCA
    function cancelPlan(uint256 planId, address receiver) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        if (receiver == address(0)) revert ZeroAddress();
        uint32 pairId = plan.pairId;
        Pair storage pair = pairs[pairId];

        _settleEmptyRounds(pairId, pair);
        uint8 buysSettled = _buysSettled(plan, pair);
        if (buysSettled == plan.scheduleBuys) revert PlanMatured();
        if (_inRunningRound(plan, pair)) revert PlanInRunningRound();

        _removeFromRound(pairId, pair, plan.scheduleFirstRound, plan.stableUnitsPerBuy, plan.principalPerBuy);
        Round storage last = rounds[pairId][plan.scheduleFirstRound + plan.scheduleBuys - 1];
        last.stableUnitsEnding -= plan.stableUnitsPerBuy;
        last.principalEnding -= plan.principalPerBuy;

        uint256 assetUnitsOwed = _assetUnitsOwed(plan, pair);
        uint256 stableUnitsLeft = plan.scheduleStableUnits - plan.stableUnitsPerBuy * buysSettled;
        uint8 buysLeft = plan.scheduleBuys - buysSettled;
        plan.status = PlanStatus.Cancelled;
        // Moved the same way as a top up, so the record keeps how many buys settled
        plan.buysBeforeSchedule += buysSettled;
        plan.scheduleFirstRound += buysSettled;
        plan.scheduleBuys = buysLeft;
        plan.assetUnitsPaid += assetUnitsOwed;

        uint256 stableRedeemed = _redeem(yieldSources[pairId][Side.Stable], pair.stable, stableUnitsLeft);
        uint256 principalLeft = plan.principalPerBuy * buysLeft;
        (uint256 fee, ) = SmartDCAMath.roundFee(stableRedeemed, principalLeft, feeRateBps);
        if (fee != 0) {
            IERC20(pair.stable).safeTransfer(reserve, fee);
            emit CancelFeeCollected(pairId, planId, fee);
        }
        IERC20(pair.stable).safeTransfer(receiver, stableRedeemed - fee);

        uint256 assetAmount;
        if (assetUnitsOwed != 0) {
            assetAmount = _redeem(yieldSources[pairId][Side.Asset], pair.asset, assetUnitsOwed);
            IERC20(pair.asset).safeTransfer(receiver, assetAmount);
        }

        emit PlanCancelled(planId, receiver, stableRedeemed - fee, fee, assetAmount);
    }

    /// @inheritdoc ISmartDCA
    function claimPlan(uint256 planId, bool toCore, address receiver) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        if (receiver == address(0)) revert ZeroAddress();
        Pair storage pair = pairs[plan.pairId];
        _settleEmptyRounds(plan.pairId, pair);
        _emitRoundLocked(plan.pairId, pair);
        if (_buysSettled(plan, pair) != plan.scheduleBuys) revert PlanNotMatured();

        uint256 assetUnitsOwed = _assetUnitsOwed(plan, pair);
        plan.status = PlanStatus.Claimed;
        plan.assetUnitsPaid += assetUnitsOwed;

        // Stable units left by rounding `stableUnitsPerBuy` down: fewer than `scheduleBuys`, each worth under 1 wei
        // on a Hub and about 2e8 wei on a Core vToken
        yieldSources[plan.pairId][Side.Stable].unitsIssued -=
            plan.scheduleStableUnits - plan.stableUnitsPerBuy * plan.scheduleBuys;

        uint256 amount;
        if (assetUnitsOwed != 0) {
            YieldSource storage assetSource = yieldSources[plan.pairId][Side.Asset];
            if (toCore) {
                if (assetSource.kind != SourceKind.Core) revert NotCoreSource();
                amount = _transferUnits(assetSource, assetUnitsOwed, receiver);
            } else {
                amount = _redeem(assetSource, pair.asset, assetUnitsOwed);
                IERC20(pair.asset).safeTransfer(receiver, amount);
            }
        }

        emit PlanClaimed(planId, receiver, toCore, amount);
    }

    /// @inheritdoc ISmartDCA
    function transferPlan(uint256 planId, address newOwner) external whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        if (newOwner == address(0)) revert ZeroAddress();

        // The id is in the caller's list, since they own the plan: move the last id into its place and drop the last
        uint256[] storage ids = _planIdsByOwner[msg.sender];
        uint256 i;
        while (ids[i] != planId) ++i;
        ids[i] = ids[ids.length - 1];
        ids.pop();

        plan.owner = newOwner;
        _planIdsByOwner[newOwner].push(planId);
        emit PlanTransferred(planId, msg.sender, newOwner);
    }

    /// @inheritdoc ISmartDCA
    function startRound(uint32 pairId, uint8 parts) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        _startRound(pairId, pair, parts);
    }

    /// @inheritdoc ISmartDCA
    function swapRoundPart(
        uint32 pairId,
        uint256 quotedOut,
        bytes calldata swapData
    ) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _startedRound(pairId, round);
        if (r.partsDone == r.partsTotal) revert NoPartsLeft();
        if (quotedOut == 0) revert ZeroAmount();

        // An even share of what is left; on the last part that is all of it
        uint256 stableIn = r.stableToSwap / (r.partsTotal - r.partsDone);
        uint256 minOut = Math.mulDiv(quotedOut, SmartDCAMath.BPS - maxSlippageBps, SmartDCAMath.BPS);
        uint256 assetOut = SmartDCAAdminLib.keeperSwap(
            allowedRouters,
            pair,
            address(SWAP_HELPER),
            stableIn,
            minOut,
            swapData
        );

        r.stableToSwap -= stableIn;
        r.assetBought += assetOut;
        r.partsDone += 1;

        emit RoundPartSwapped(pairId, round, r.partsDone, stableIn, assetOut, quotedOut, minOut);
    }

    /// @inheritdoc ISmartDCA
    function resplitRound(uint32 pairId, uint8 parts) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _startedRound(pairId, round);
        if (r.partsDone == r.partsTotal) revert NoPartsLeft();
        if (r.resplitUsed) revert AlreadyResplit();
        if (parts == 0 || parts > maxParts) revert InvalidParts();

        r.resplitUsed = true;
        r.partsTotal = r.partsDone + parts;

        emit RoundResplit(pairId, round, r.partsDone, parts);
    }

    /// @inheritdoc ISmartDCA
    function settleRound(uint32 pairId) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        _settleRound(pairId, pair);
    }

    /// @inheritdoc ISmartDCA
    function forceBuy(uint32 pairId, uint8 parts) external nonReentrant whenNotPaused {
        _checkAccessAllowed("forceBuy(uint32,uint8)");
        Pair storage pair = _pair(pairId);
        if (fallbackRoutes[pairId].router == address(0)) revert NoFallbackRoute(pairId);
        uint256 forceBuyFrom = roundStart(pair.lastSettledRound + 1) + FALLBACK_DELAY;
        if (block.timestamp < forceBuyFrom) revert RoundNotStarted(forceBuyFrom);

        if (rounds[pairId][pair.lastSettledRound + 1].partsTotal == 0) _startRound(pairId, pair, parts);
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _startedRound(pairId, round);
        // Skipped when the keeper swapped every part but did not settle
        if (r.partsDone != r.partsTotal) {
            // An even share of what is left; on the last part that is all of it
            uint256 stableIn = r.stableToSwap / (r.partsTotal - r.partsDone);
            (uint256 assetOut, uint256 quotedOut, uint256 minOut) = SmartDCAAdminLib.fallbackSwap(
                fallbackRoutes[pairId],
                pair,
                ORACLE,
                stableIn,
                fallbackSlippageBps
            );
            r.stableToSwap -= stableIn;
            r.assetBought += assetOut;
            r.partsDone += 1;
            emit RoundPartSwapped(pairId, round, r.partsDone, stableIn, assetOut, quotedOut, minOut);
        }
        if (r.partsDone == r.partsTotal) _settleRound(pairId, pair);
    }

    /// @inheritdoc ISmartDCA
    function syncPair(uint32 pairId) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _settleEmptyRounds(pairId, pair);
        _emitRoundLocked(pairId, pair);
    }

    /// @inheritdoc ISmartDCA
    function claimRewards(address[] calldata vTokens) external nonReentrant {
        IERC20 xvs = IERC20(COMPTROLLER.getXVSAddress());
        uint256 balanceBefore = xvs.balanceOf(address(this));
        COMPTROLLER.claimVenus(address(this), vTokens);
        uint256 amount = xvs.balanceOf(address(this)) - balanceBefore;
        if (amount != 0) xvs.safeTransfer(reserve, amount);
        emit RewardsClaimed(amount);
    }

    /// @inheritdoc ISmartDCA
    function setFeeRate(uint16 newFeeRateBps) external {
        _checkAccessAllowed("setFeeRate(uint16)");
        if (newFeeRateBps > maxFeeRateBps) revert AboveHardCap();
        emit FeeRateUpdated(feeRateBps, newFeeRateBps);
        feeRateBps = newFeeRateBps;
    }

    /// @inheritdoc ISmartDCA
    function setMaxFeeRate(uint16 newMaxFeeRateBps) external {
        _checkAccessAllowed("setMaxFeeRate(uint16)");
        if (newMaxFeeRateBps > SmartDCAMath.BPS) revert AboveHardCap();
        if (newMaxFeeRateBps < feeRateBps) revert InvalidParameter();
        emit MaxFeeRateUpdated(maxFeeRateBps, newMaxFeeRateBps);
        maxFeeRateBps = newMaxFeeRateBps;
    }

    /// @inheritdoc ISmartDCA
    function setMaxSlippage(uint16 newMaxSlippageBps) external {
        _checkAccessAllowed("setMaxSlippage(uint16)");
        if (newMaxSlippageBps > MAX_SLIPPAGE_BPS) revert AboveHardCap();
        emit MaxSlippageUpdated(maxSlippageBps, newMaxSlippageBps);
        maxSlippageBps = newMaxSlippageBps;
    }

    /// @inheritdoc ISmartDCA
    function setMaxParts(uint8 newMaxParts) external {
        _checkAccessAllowed("setMaxParts(uint8)");
        if (newMaxParts == 0) revert InvalidParameter();
        if (newMaxParts > MAX_PARTS) revert AboveHardCap();
        emit MaxPartsUpdated(maxParts, newMaxParts);
        maxParts = newMaxParts;
    }

    /// @inheritdoc ISmartDCA
    function pause() external {
        _checkAccessAllowed("pause()");
        _pause();
    }

    /// @inheritdoc ISmartDCA
    function setYieldSource(uint32 pairId, Side side, SourceKind kind, address source) external nonReentrant {
        _checkAccessAllowed("setYieldSource(uint32,uint8,uint8,address)");
        SmartDCAAdminLib.setYieldSource(
            _pair(pairId),
            yieldSources[pairId][side],
            pairId,
            side,
            kind,
            source,
            HUB_REGISTRY,
            COMPTROLLER,
            block.timestamp >= roundStart(_pair(pairId).lastSettledRound + 1)
        );
    }

    /// @inheritdoc ISmartDCA
    function setKeeper(address account, bool allowed) external {
        _checkAccessAllowed("setKeeper(address,bool)");
        if (account == address(0)) revert ZeroAddress();
        isKeeper[account] = allowed;
        emit KeeperUpdated(account, allowed);
    }

    /// @inheritdoc ISmartDCA
    function setMinAmountPerBuy(address stable, uint256 newAmount) external {
        _checkAccessAllowed("setMinAmountPerBuy(address,uint256)");
        if (stable == address(0)) revert ZeroAddress();
        if (newAmount == 0) revert InvalidParameter();
        emit MinAmountPerBuyUpdated(stable, minAmountPerBuy[stable], newAmount);
        minAmountPerBuy[stable] = newAmount;
    }

    /// @inheritdoc ISmartDCA
    function setBuyBounds(uint8 newMinBuys, uint8 newMaxBuys) external {
        _checkAccessAllowed("setBuyBounds(uint8,uint8)");
        if (newMinBuys == 0 || newMinBuys > newMaxBuys) revert InvalidParameter();
        if (newMaxBuys > MAX_BUYS) revert AboveHardCap();
        emit BuyBoundsUpdated(minBuys, maxBuys, newMinBuys, newMaxBuys);
        minBuys = newMinBuys;
        maxBuys = newMaxBuys;
    }

    /// @inheritdoc ISmartDCA
    function addPair(
        address stable,
        address asset,
        SourceKind stableKind,
        address stableSource,
        SourceKind assetKind,
        address assetSource
    ) external returns (uint32 pairId) {
        _checkAccessAllowed("addPair(address,address,uint8,address,uint8,address)");
        if (stable == asset) revert SameTokens();
        if (pairIdByTokens[stable][asset] != 0) revert PairExists();
        // Without a minimum, a dust plan whose units per buy redeem 0 would revert every `startRound` of the pair
        if (minAmountPerBuy[stable] == 0) revert InvalidParameter();
        pairId = ++pairCount;
        pairIdByTokens[stable][asset] = pairId;
        // The pair's first round is the next to start
        pairs[pairId].lastSettledRound = uint32(SmartDCAMath.latestStartedMonth(block.timestamp) - anchorMonth);
        SmartDCAAdminLib.addPair(
            pairs[pairId],
            yieldSources[pairId],
            pairId,
            stable,
            asset,
            ORACLE,
            HUB_REGISTRY,
            COMPTROLLER,
            stableKind,
            stableSource,
            assetKind,
            assetSource
        );
    }

    /// @inheritdoc ISmartDCA
    function setPairEnabled(uint32 pairId, bool enabled) external {
        _checkAccessAllowed("setPairEnabled(uint32,bool)");
        _pair(pairId).enabled = enabled;
        emit PairEnabledUpdated(pairId, enabled);
    }

    /// @inheritdoc ISmartDCA
    function unpause() external {
        _checkAccessAllowed("unpause()");
        _unpause();
    }

    /// @inheritdoc ISmartDCA
    function sweepToken(address token, address to) external nonReentrant {
        _checkAccessAllowed("sweepToken(address,address)");
        if (to == address(0)) revert ZeroAddress();

        uint256 owed = SmartDCAAdminLib.owedInToken(pairs, rounds, yieldSources, pairCount, token);
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 amount = balance > owed ? balance - owed : 0;
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
        emit TokenSwept(token, to, amount);
    }

    /// @inheritdoc ISmartDCA
    function setFallbackRoute(uint32 pairId, address router, bytes calldata path) external {
        _checkAccessAllowed("setFallbackRoute(uint32,address,bytes)");
        _pair(pairId);
        SmartDCAAdminLib.setFallbackRoute(fallbackRoutes[pairId], pairId, router, path);
    }

    /// @inheritdoc ISmartDCA
    function setFallbackSlippage(uint16 newSlippageBps) external {
        _checkAccessAllowed("setFallbackSlippage(uint16)");
        if (newSlippageBps > MAX_SLIPPAGE_BPS) revert AboveHardCap();
        emit FallbackSlippageUpdated(fallbackSlippageBps, newSlippageBps);
        fallbackSlippageBps = newSlippageBps;
    }

    /// @inheritdoc ISmartDCA
    function setAllowedRouter(address router, bool allowed) external {
        _checkAccessAllowed("setAllowedRouter(address,bool)");
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = allowed;
        emit RouterAllowlisted(router, allowed);
    }

    /// @inheritdoc ISmartDCA
    function setReserve(address newReserve) external {
        _checkAccessAllowed("setReserve(address)");
        if (newReserve == address(0)) revert ZeroAddress();
        emit ReserveUpdated(reserve, newReserve);
        reserve = newReserve;
    }

    /// @inheritdoc ISmartDCA
    function nextLockTime(uint32 pairId) external view returns (uint256) {
        return roundStart(pairs[pairId].lastSettledRound + 1);
    }

    /// @inheritdoc ISmartDCA
    function getPlanIds(address owner) external view returns (uint256[] memory) {
        return _planIdsByOwner[owner];
    }

    /// @inheritdoc ISmartDCA
    function roundStart(uint32 round) public view returns (uint256) {
        return SmartDCAMath.roundStart(anchorMonth, round);
    }

    /// @dev Body of `startRound`, after the caller check
    function _startRound(uint32 pairId, Pair storage pair, uint8 parts) internal {
        if (parts == 0 || parts > maxParts) revert InvalidParts();

        // Rounds with nothing to buy settle here with no swap
        _settleEmptyRounds(pairId, pair);
        uint32 round = pair.lastSettledRound + 1;
        if (block.timestamp < roundStart(round)) return;
        _emitRoundLocked(pairId, pair);

        Round storage r = rounds[pairId][round];
        if (r.partsTotal != 0) revert RoundAlreadyStarted(pairId);

        uint256 stableRedeemed = _redeem(yieldSources[pairId][Side.Stable], pair.stable, pair.roundStableUnits);
        if (stableRedeemed == 0) revert ZeroAmount();
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(stableRedeemed, pair.roundPrincipal, feeRateBps);
        uint256 stableNet = stableRedeemed - fee;

        r.partsTotal = parts;
        r.feeRateBps = rate;
        r.stableRedeemed = stableRedeemed;
        r.stableNet = stableNet;
        r.stableToSwap = stableNet;

        if (fee != 0) {
            IERC20(pair.stable).safeTransfer(reserve, fee);
            emit RoundFeeCollected(pairId, round, fee);
        }
        emit RoundStarted(
            pairId,
            round,
            parts,
            pair.roundStableUnits,
            stableRedeemed,
            pair.roundPrincipal,
            rate,
            stableNet
        );
    }

    /// @dev Body of `settleRound`, after the caller check
    function _settleRound(uint32 pairId, Pair storage pair) internal {
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _startedRound(pairId, round);
        if (r.partsDone != r.partsTotal) revert PartsLeft();

        uint256 assetUnits = _deposit(yieldSources[pairId][Side.Asset], pair.asset, r.assetBought);
        (uint256 perUnitStep, uint256 perPrincipalStep) = SmartDCAMath.roundIndexSteps(
            assetUnits,
            r.stableRedeemed,
            r.stableNet,
            pair.roundStableUnits,
            r.feeRateBps
        );

        // The rounding leftover stays in the pool: a plan rounds down once over all its rounds, so it can read
        // up to one unit per round more than a per-round round-down would keep for it
        pair.assetPerUnitIndex += perUnitStep;
        pair.assetPerPrincipalIndex += perPrincipalStep;
        _closeRound(pair, r, round);

        emit RoundSettled(
            pairId,
            round,
            r.stableRedeemed,
            r.stableRedeemed - r.stableNet,
            r.assetBought,
            assetUnits,
            pair.assetPerUnitIndex,
            pair.assetPerPrincipalIndex
        );

        _settleEmptyRounds(pairId, pair);
    }

    /// @dev Settles, with no swap, every round of the pair that has nothing to buy and whose lock time has passed
    function _settleEmptyRounds(uint32 pairId, Pair storage pair) internal {
        while (pair.roundStableUnits == 0) {
            uint32 round = pair.lastSettledRound + 1;
            if (block.timestamp < roundStart(round)) return;
            Round storage r = rounds[pairId][round];
            _closeRound(pair, r, round);
            emit RoundSettled(pairId, round, 0, 0, 0, 0, pair.assetPerUnitIndex, pair.assetPerPrincipalIndex);
        }
    }

    /// @dev Records the indexes for `round`, adds the plans that start next and removes the ones that ended
    function _closeRound(Pair storage pair, Round storage r, uint32 round) internal {
        r.assetPerUnitIndexAfter = pair.assetPerUnitIndex;
        r.assetPerPrincipalIndexAfter = pair.assetPerPrincipalIndex;
        pair.roundStableUnits = pair.roundStableUnits - r.stableUnitsEnding + r.stableUnitsJoining;
        pair.roundPrincipal = pair.roundPrincipal - r.principalEnding + r.principalJoining;
        pair.lastSettledRound = round;
    }

    /// @dev Emits `RoundLocked` once per round with plans, from the round's lock time
    function _emitRoundLocked(uint32 pairId, Pair storage pair) internal {
        uint32 round = pair.lastSettledRound + 1;
        if (pair.lockEmittedRound == round || block.timestamp < roundStart(round)) return;
        pair.lockEmittedRound = round;
        emit RoundLocked(pairId, round);
    }

    /// @dev Adds a plan's amounts per buy to the pair's next round, or, for a later first round, to the joining
    ///      totals of the round before it
    function _addToRound(
        uint32 pairId,
        Pair storage pair,
        uint32 firstRound,
        uint256 stableUnitsPerBuy,
        uint256 principalPerBuy
    ) internal {
        if (firstRound <= pair.lastSettledRound + 1) {
            pair.roundStableUnits += stableUnitsPerBuy;
            pair.roundPrincipal += principalPerBuy;
        } else {
            Round storage r = rounds[pairId][firstRound - 1];
            r.stableUnitsJoining += stableUnitsPerBuy;
            r.principalJoining += principalPerBuy;
        }
    }

    /// @dev Reverse of `_addToRound`
    function _removeFromRound(
        uint32 pairId,
        Pair storage pair,
        uint32 firstRound,
        uint256 stableUnitsPerBuy,
        uint256 principalPerBuy
    ) internal {
        if (firstRound <= pair.lastSettledRound + 1) {
            pair.roundStableUnits -= stableUnitsPerBuy;
            pair.roundPrincipal -= principalPerBuy;
        } else {
            Round storage r = rounds[pairId][firstRound - 1];
            r.stableUnitsJoining -= stableUnitsPerBuy;
            r.principalJoining -= principalPerBuy;
        }
    }

    /// @dev Pulls `amount` of `token` from the caller and returns what arrived
    function _pullToken(address token, uint256 amount) internal returns (uint256) {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Deposits `amount` of `token` into the pair side's source `s` and returns the units minted, rounded down
    function _deposit(YieldSource storage s, address token, uint256 amount) internal returns (uint256 units) {
        uint256 shares = SmartDCAAdminLib.sourceDeposit(s, token, amount);
        units = s.unitsIssued == 0 || s.sharesHeld == 0 ? shares : Math.mulDiv(shares, s.unitsIssued, s.sharesHeld);
        s.sharesHeld += shares;
        s.unitsIssued += units;
    }

    /// @dev Redeems `units` from the pair side's source `s` and returns the amount of `token` received
    function _redeem(YieldSource storage s, address token, uint256 units) internal returns (uint256) {
        uint256 shares = Math.mulDiv(units, s.sharesHeld, s.unitsIssued);
        s.unitsIssued -= units;
        s.sharesHeld -= shares;
        return SmartDCAAdminLib.sourceRedeem(s, token, shares);
    }

    /// @dev Sends `to` the source shares behind `units` of `s` (Hub shares or vTokens) and returns them
    function _transferUnits(YieldSource storage s, uint256 units, address to) internal returns (uint256 shares) {
        shares = Math.mulDiv(units, s.sharesHeld, s.unitsIssued);
        s.unitsIssued -= units;
        s.sharesHeld -= shares;
        IERC20(s.sourceAddress).safeTransfer(to, shares);
    }

    /// @dev Units of `s` worth at least `amount`, rounded up. After a source switch one unit is not one share,
    ///      so the redeem that follows can pay a few wei less than `amount`. Not a view: Core's rate is accrued first.
    function _unitsForAmount(YieldSource storage s, uint256 amount) internal returns (uint256) {
        uint256 shares = s.kind == SourceKind.Hub
            ? IHub(s.sourceAddress).previewWithdraw(amount)
            : Math.mulDiv(amount, 1e18, IVToken(s.sourceAddress).exchangeRateCurrent(), Math.Rounding.Up);
        return Math.mulDiv(shares, s.unitsIssued, s.sharesHeld, Math.Rounding.Up);
    }

    /// @dev Only keepers, and only from the round's start time
    function _checkRoundCaller(Pair storage pair) internal view {
        if (!isKeeper[msg.sender]) revert NotRoundCaller(msg.sender);
        _requireRoundStarted(pair.lastSettledRound + 1);
    }

    /// @dev Reverts before the round's start time
    function _requireRoundStarted(uint32 round) internal view {
        uint256 startsAt = roundStart(round);
        if (block.timestamp < startsAt) revert RoundNotStarted(startsAt);
    }

    /// @dev The round, once `startRound` has run for it
    function _startedRound(uint32 pairId, uint32 round) internal view returns (Round storage r) {
        r = rounds[pairId][round];
        if (r.partsTotal == 0) revert StartRoundNotCalled(pairId);
    }

    /// @dev The pair, for a known id
    function _pair(uint32 pairId) internal view returns (Pair storage pair) {
        if (pairId == 0 || pairId > pairCount) revert UnknownPair(pairId);
        pair = pairs[pairId];
    }

    /// @dev The plan, when the caller owns it and it is active
    function _ownedActivePlan(uint256 planId) internal view returns (Plan storage plan) {
        plan = plans[planId];
        if (plan.owner != msg.sender) revert NotPlanOwner();
        if (plan.status != PlanStatus.Active) revert PlanNotActive();
    }

    /// @dev Buys of the current schedule that have settled
    function _buysSettled(Plan storage plan, Pair storage pair) internal view returns (uint8) {
        return SmartDCAMath.buysSettled(pair.lastSettledRound, plan.scheduleFirstRound, plan.scheduleBuys);
    }

    /// @dev True from the lock time of a round the plan is in until that round settles
    function _inRunningRound(Plan storage plan, Pair storage pair) internal view returns (bool) {
        return
            SmartDCAMath.inRunningRound(
                pair.lastSettledRound + 1,
                plan.scheduleFirstRound,
                plan.scheduleBuys,
                block.timestamp >= roundStart(pair.lastSettledRound + 1)
            );
    }

    /// @dev Asset units the plan holds now: bought and not yet paid out
    function _assetUnitsOwed(Plan storage plan, Pair storage pair) internal view returns (uint256) {
        uint256 fromIndex = _assetUnitsFromIndex(plan, plan.pairId, _buysSettled(plan, pair));
        return plan.assetUnitsCarried + fromIndex - plan.assetUnitsPaid;
    }

    /// @dev Asset units bought in the first `buysSettled` rounds of the current schedule, read from the indexes
    function _assetUnitsFromIndex(Plan storage plan, uint32 pairId, uint8 buysSettled) internal view returns (uint256) {
        if (buysSettled == 0) return 0;
        Round storage before = rounds[pairId][plan.scheduleFirstRound - 1];
        Round storage last = rounds[pairId][plan.scheduleFirstRound + buysSettled - 1];
        return
            SmartDCAMath.assetUnitsBought(
                plan.stableUnitsPerBuy,
                plan.principalPerBuy,
                last.assetPerUnitIndexAfter - before.assetPerUnitIndexAfter,
                last.assetPerPrincipalIndexAfter - before.assetPerPrincipalIndexAfter
            );
    }
}
