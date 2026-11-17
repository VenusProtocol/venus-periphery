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
import { SmartDCAMath } from "./SmartDCAMath.sol";
import { ISmartDCA } from "./ISmartDCA.sol";

/**
 * @title SmartDCA
 * @author Venus
 * @notice Monthly dollar cost averaging from a stable (USDT, USDC, U) into an asset (BTCB, ETH, WBNB). A user
 *         deposits once and picks a number of monthly buys. The deposit waits in the stable's yield source.
 *         From the 15th at 00:00 UTC+8 a keeper buys every plan's part for the month in a few swaps through
 *         SwapHelper (route built off chain), each bounded by the keeper's fresh quote, and the bought asset is supplied to its yield source.
 * @dev Accounting is pooled per pair, so no round call loops over plans:
 *      - A plan holds stable units and sells one `slice` of them per round. The pair keeps `dueUnits`, the sum
 *        of the slices in its next round, and `dueBase`, the sum of the bases.
 *      - `startBuy` redeems `dueUnits` in one call. `settle` turns what was bought into units and moves two
 *        indexes, so each plan's share is read from the indexes in constant gas.
 *      - Plans that join or leave a pair are added to or removed from `dueUnits` through per-round
 *        `sliceStarting` and `sliceEnding` sums, applied when that round settles.
 *      This contract never borrows and never enters a market, so nothing it holds is collateral.
 */
contract SmartDCA is ISmartDCA, AccessControlledV8, PausableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice Highest slippage bound governance can set, 1%
    uint16 public constant MAX_SLIPPAGE = 100;

    /// @notice Highest number of parts a round can be split into
    uint8 public constant MAX_SPLIT_N = 50;

    /// @notice Highest number of buys a plan can have
    uint8 public constant MAX_BUYS = 120;

    /// @notice Longest wait before backup addresses can run a round
    uint32 public constant MAX_BACKUP_DELAY = 24 hours;

    /// @notice Core pool Comptroller; Core yield sources must be listed in it
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IComptroller public immutable COMPTROLLER;

    /// @notice Hub directory; Hub yield sources must be registered in it
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IHubRegistry public immutable HUB_REGISTRY;

    /// @notice Oracle that must price both tokens of a new pair
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    ResilientOracleInterface public immutable ORACLE;

    /// @notice SwapHelper every swap goes through; it runs only a multicall signed by its backend signer
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    SwapHelper public immutable SWAP_HELPER;

    /// @notice Fee rate on the interest part of each buy and of a cancel, in basis points
    uint16 public feeRate;

    /// @notice Most a swap can return below the keeper's quote, in basis points
    uint16 public maxSlippage;

    /// @notice Most parts a round can be split into
    uint8 public maxSplitN;

    /// @notice Fewest buys a new plan can have
    uint8 public minBuys;

    /// @notice Most buys a new plan can have
    uint8 public maxBuys;

    /// @notice Wait after a pair's lock time before backup addresses can run its round
    uint32 public backupDelay;

    /// @notice Number of pairs; pair ids run from 1 to `pairCount`
    uint32 public pairCount;

    /// @notice Receives fees and rewards
    address public reserve;

    /// @notice Id of the last plan created; plan ids start at 1
    uint256 public lastPlanId;

    /// @notice Highest fee rate governance can set, in basis points; 20% at launch
    uint16 public maxFeeRate;

    /// @notice Pairs by id
    mapping(uint32 => Pair) public pairs;

    /// @notice Pair id by stable and asset, 0 when none
    mapping(address => mapping(address => uint32)) public pairIdOf;

    /// @notice Rounds by pair and round number
    mapping(uint32 => mapping(uint32 => Round)) public rounds;

    /// @notice Plans by id
    mapping(uint256 => Plan) public plans;

    /// @notice Yield source by token
    mapping(address => Source) public sources;

    /// @notice Token whose yield source is this address (a Hub or a vToken), 0 when none
    mapping(address => address) public tokenOfSource;

    /// @notice Least stable per buy, by stable
    mapping(address => uint256) public minPerBuy;

    /// @notice Addresses that run rounds from the lock time
    mapping(address => bool) public isKeeper;

    /// @notice Addresses that run rounds from the lock time plus `backupDelay`
    mapping(address => bool) public isBackup;

    /// @dev Plan ids by owner
    mapping(address => uint256[]) private _plansOf;

    /// @dev Storage gap for future upgrades
    uint256[36] private __gap;

    /// @notice Sets the external contracts and disables initializers on the implementation
    /// @param comptroller Core pool Comptroller
    /// @param hubRegistry Hub directory
    /// @param oracle ResilientOracle
    /// @param swapHelper SwapHelper that runs the signed swap multicall
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address comptroller, address hubRegistry, address oracle, address swapHelper) {
        if (comptroller == address(0) || hubRegistry == address(0) || oracle == address(0) || swapHelper == address(0))
            revert ZeroAddress();
        COMPTROLLER = IComptroller(comptroller);
        HUB_REGISTRY = IHubRegistry(hubRegistry);
        ORACLE = ResilientOracleInterface(oracle);
        SWAP_HELPER = SwapHelper(swapHelper);
        _disableInitializers();
    }

    /// @notice Initializes the proxy with the launch parameters
    /// @dev Fee rate starts at 0, capped at 20%. Slippage 0.1%, up to 10 parts, 2 to 60 buys, backups after 9 hours.
    /// @param accessControlManager_ AccessControlManager
    /// @param reserve_ Receives fees and rewards
    function initialize(address accessControlManager_, address reserve_) external initializer {
        if (reserve_ == address(0)) revert ZeroAddress();
        __AccessControlled_init(accessControlManager_);
        __Pausable_init();
        __ReentrancyGuard_init();
        reserve = reserve_;
        maxFeeRate = 2_000;
        maxSlippage = 10;
        maxSplitN = 10;
        minBuys = 2;
        maxBuys = 60;
        backupDelay = 9 hours;
    }

    /// @inheritdoc ISmartDCA
    function createPlan(
        uint32 pairId,
        uint256 amount,
        uint8 buys
    ) external nonReentrant whenNotPaused returns (uint256 planId) {
        Pair storage pair = _pair(pairId);
        if (!pair.enabled) revert PairDisabled();
        if (buys < minBuys || buys > maxBuys) revert InvalidBuys();
        if (amount < minPerBuy[pair.stable] * buys) revert DepositTooSmall();

        _advanceEmpty(pairId, pair);
        _touchLock(pairId, pair);

        uint256 received = _pull(pair.stable, amount);
        uint256 units = _deposit(pair.stable, received);
        uint256 slice = units / buys;
        uint256 base = received / buys;
        if (slice == 0 || base == 0) revert DepositTooSmall();

        // The cutoff is the pair's open round: before its lock the plan joins it, from the lock the round after.
        // During an overrun that is the round right after the stuck one, not the calendar month.
        uint32 openRound = pair.lastSettledRound + 1;
        uint32 firstRound = block.timestamp < SmartDCAMath.roundStart(openRound) ? openRound : openRound + 1;
        _addToRound(pairId, pair, firstRound, slice, base);
        Round storage last = rounds[pairId][firstRound + buys - 1];
        last.sliceEnding += slice;
        last.baseEnding += base;

        planId = ++lastPlanId;
        plans[planId] = Plan({
            owner: msg.sender,
            pairId: pairId,
            status: PlanStatus.Active,
            buys: buys,
            buysDone: 0,
            firstRound: firstRound,
            stableUnits: units,
            slice: slice,
            base: base,
            carriedBought: 0,
            withdrawnBought: 0
        });
        _plansOf[msg.sender].push(planId);

        emit PlanCreated(planId, msg.sender, pairId, received, units, slice, base, buys, firstRound);
    }

    /// @inheritdoc ISmartDCA
    function topUp(uint256 planId, uint256 amount) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        uint32 pairId = plan.pairId;
        Pair storage pair = pairs[pairId];
        if (!pair.enabled) revert PairDisabled();

        _advanceEmpty(pairId, pair);
        uint8 roundsDone = _roundsDone(plan, pair);
        if (roundsDone == plan.buys) revert PlanMatured();
        if (_inRunningRound(plan, pair)) revert PlanInRunningRound();

        uint8 buysLeft = plan.buys - roundsDone;
        if (amount == 0 || amount < minPerBuy[pair.stable] * buysLeft) revert DepositTooSmall();

        // Restart the schedule from the next unsettled round, keeping what was bought so far
        plan.carriedBought += _indexBought(plan, pairId, roundsDone);
        plan.buysDone += roundsDone;
        plan.firstRound += roundsDone;
        plan.buys = buysLeft;

        uint256 received = _pull(pair.stable, amount);
        uint256 units = _deposit(pair.stable, received);
        uint256 stableUnits = plan.stableUnits - plan.slice * roundsDone + units;
        uint256 slice = stableUnits / buysLeft;
        uint256 base = plan.base + received / buysLeft;

        uint256 sliceAdded = slice - plan.slice;
        uint256 baseAdded = base - plan.base;
        _addToRound(pairId, pair, plan.firstRound, sliceAdded, baseAdded);
        Round storage last = rounds[pairId][plan.firstRound + buysLeft - 1];
        last.sliceEnding += sliceAdded;
        last.baseEnding += baseAdded;

        plan.stableUnits = stableUnits;
        plan.slice = slice;
        plan.base = base;

        emit PlanToppedUp(planId, received, units, slice, base, buysLeft);
    }

    /// @inheritdoc ISmartDCA
    function withdrawBought(uint256 planId, uint256 amount) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        Pair storage pair = pairs[plan.pairId];

        uint256 bought = _bought(plan, pair);
        // Checked first: with nothing bought the asset's pool can be empty, and `_unitsForAmount` divides by it
        if (bought == 0) revert ZeroAmount();
        uint256 units = amount == type(uint256).max ? bought : _unitsForAmount(pair.asset, amount);
        if (units == 0) revert ZeroAmount();
        if (units > bought) revert InsufficientBought();

        plan.withdrawnBought += units;
        uint256 amountOut = _redeem(pair.asset, units);
        IERC20(pair.asset).safeTransfer(msg.sender, amountOut);

        emit BoughtWithdrawn(planId, units, amountOut);
    }

    /// @inheritdoc ISmartDCA
    function cancel(uint256 planId) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        uint32 pairId = plan.pairId;
        Pair storage pair = pairs[pairId];

        _advanceEmpty(pairId, pair);
        uint8 roundsDone = _roundsDone(plan, pair);
        if (roundsDone == plan.buys) revert PlanMatured();
        if (_inRunningRound(plan, pair)) revert PlanInRunningRound();

        _removeFromRound(pairId, pair, plan.firstRound, plan.slice, plan.base);
        Round storage last = rounds[pairId][plan.firstRound + plan.buys - 1];
        last.sliceEnding -= plan.slice;
        last.baseEnding -= plan.base;

        uint256 bought = _bought(plan, pair);
        uint256 stableUnits = plan.stableUnits - plan.slice * roundsDone;
        uint8 buysLeft = plan.buys - roundsDone;
        plan.status = PlanStatus.Cancelled;
        // Same move as topUp, so the record keeps the buys done; these fields share the status slot
        plan.buysDone += roundsDone;
        plan.firstRound += roundsDone;
        plan.buys = buysLeft;
        plan.withdrawnBought += bought;

        uint256 stableOut = _redeem(pair.stable, stableUnits);
        uint256 principalLeft = plan.base * buysLeft;
        uint256 fee = stableOut > principalLeft ? ((stableOut - principalLeft) * feeRate) / SmartDCAMath.BPS : 0;
        if (fee != 0) {
            IERC20(pair.stable).safeTransfer(reserve, fee);
            emit FeeCollected(pairId, planId, fee);
        }
        IERC20(pair.stable).safeTransfer(msg.sender, stableOut - fee);

        uint256 assetOut;
        if (bought != 0) {
            assetOut = _redeem(pair.asset, bought);
            IERC20(pair.asset).safeTransfer(msg.sender, assetOut);
        }

        emit PlanCancelled(planId, stableOut - fee, fee, assetOut);
    }

    /// @inheritdoc ISmartDCA
    function claim(uint256 planId, bool toCore) external nonReentrant whenNotPaused {
        Plan storage plan = _ownedActivePlan(planId);
        Pair storage pair = pairs[plan.pairId];
        _advanceEmpty(plan.pairId, pair);
        _touchLock(plan.pairId, pair);
        if (_roundsDone(plan, pair) != plan.buys) revert PlanNotMatured();

        uint256 bought = _bought(plan, pair);
        plan.status = PlanStatus.Done;
        plan.withdrawnBought += bought;

        // Stable units left by rounding the slice down: fewer than `buys`, worth under 1 wei with a Hub source
        sources[pair.stable].units -= plan.stableUnits - plan.slice * plan.buys;

        uint256 amountOut;
        if (bought != 0) {
            if (toCore) {
                Source storage source = sources[pair.asset];
                if (source.kind != SourceKind.Core) revert NotCoreSource();
                amountOut = _transferUnits(pair.asset, bought, msg.sender);
            } else {
                amountOut = _redeem(pair.asset, bought);
                IERC20(pair.asset).safeTransfer(msg.sender, amountOut);
            }
        }

        emit PlanClaimed(planId, toCore, amountOut);
    }

    /// @inheritdoc ISmartDCA
    function startBuy(uint32 pairId, uint8 parts) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        if (parts == 0 || parts > maxSplitN) revert InvalidParts();

        // An empty round settles here with no swap
        _advanceEmpty(pairId, pair);
        uint32 round = pair.lastSettledRound + 1;
        if (block.timestamp < SmartDCAMath.roundStart(round)) return;
        _touchLock(pairId, pair);

        Round storage r = rounds[pairId][round];
        if (r.partsTotal != 0) revert BuyAlreadyStarted();

        uint256 stableOut = _redeem(pair.stable, pair.dueUnits);
        if (stableOut == 0) revert ZeroAmount();
        (uint256 fee, uint16 rate) = SmartDCAMath.roundFee(stableOut, pair.dueBase, feeRate);
        uint256 net = stableOut - fee;

        r.partsTotal = parts;
        r.feeRate = rate;
        r.stableOut = stableOut;
        r.net = net;
        r.toSwap = net;

        if (fee != 0) {
            IERC20(pair.stable).safeTransfer(reserve, fee);
            emit FeeCollected(pairId, 0, fee);
        }
        emit BuyStarted(pairId, round, parts, pair.dueUnits, stableOut, net);
    }

    /// @inheritdoc ISmartDCA
    function executeOrder(
        uint32 pairId,
        uint256 quotedOut,
        bytes calldata swapData
    ) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _executingRound(pairId, round);
        if (r.partsDone == r.partsTotal) revert NoPartsLeft();
        if (quotedOut == 0) revert ZeroAmount();

        // An even share of what is left; on the last part that is all of it
        uint256 amountIn = r.toSwap / (r.partsTotal - r.partsDone);

        uint256 minOut = Math.mulDiv(quotedOut, SmartDCAMath.BPS - maxSlippage, SmartDCAMath.BPS);

        // Same flow as LeverageStrategiesManager._performSwap: the signed multicall swaps what SwapHelper holds
        // and sends the asset back here
        IERC20 asset = IERC20(pair.asset);
        IERC20(pair.stable).safeTransfer(address(SWAP_HELPER), amountIn);
        uint256 balanceBefore = asset.balanceOf(address(this));
        (bool success, ) = address(SWAP_HELPER).call(swapData);
        if (!success) revert TokenSwapCallFailed();
        uint256 amountOut = asset.balanceOf(address(this)) - balanceBefore;
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        r.toSwap -= amountIn;
        r.amountOut += amountOut;
        r.partsDone += 1;

        emit OrderExecuted(pairId, round, r.partsDone, amountIn, amountOut, quotedOut, minOut);
    }

    /// @inheritdoc ISmartDCA
    function resplit(uint32 pairId, uint8 parts) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _executingRound(pairId, round);
        if (r.partsDone == r.partsTotal) revert NoPartsLeft();
        if (r.resplitUsed) revert AlreadyResplit();
        if (parts == 0 || parts > maxSplitN) revert InvalidParts();

        r.resplitUsed = true;
        r.partsTotal = r.partsDone + parts;

        emit OrderResplit(pairId, round, r.partsDone, parts);
    }

    /// @inheritdoc ISmartDCA
    function settle(uint32 pairId) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _checkRoundCaller(pair);
        uint32 round = pair.lastSettledRound + 1;
        Round storage r = _executingRound(pairId, round);
        if (r.partsDone != r.partsTotal) revert PartsLeft();

        uint256 boughtUnits = _deposit(pair.asset, r.amountOut);
        (uint256 indexStep, uint256 baseIndexStep) = SmartDCAMath.indexSteps(
            boughtUnits,
            r.stableOut,
            r.net,
            pair.dueUnits,
            r.feeRate
        );

        // The rounding leftover stays in the pool: a plan rounds down once over all its rounds, so it can read
        // up to one unit per round more than a per-round round-down would keep for it
        pair.cumIndex += indexStep;
        pair.cumBaseIndex += baseIndexStep;
        _closeRound(pair, r, round);

        emit PairSettled(
            pairId,
            round,
            r.stableOut,
            r.stableOut - r.net,
            r.amountOut,
            boughtUnits,
            pair.cumIndex,
            pair.cumBaseIndex
        );

        _advanceEmpty(pairId, pair);
    }

    /// @inheritdoc ISmartDCA
    function sync(uint32 pairId) external nonReentrant whenNotPaused {
        Pair storage pair = _pair(pairId);
        _advanceEmpty(pairId, pair);
        _touchLock(pairId, pair);
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
    function setFeeRate(uint16 bps) external {
        _checkAccessAllowed("setFeeRate(uint16)");
        if (bps > maxFeeRate) revert AboveHardCap();
        emit FeeRateUpdated(feeRate, bps);
        feeRate = bps;
    }

    /// @inheritdoc ISmartDCA
    function setMaxFeeRate(uint16 bps) external {
        _checkAccessAllowed("setMaxFeeRate(uint16)");
        if (bps > SmartDCAMath.BPS) revert AboveHardCap();
        if (bps < feeRate) revert InvalidParameter();
        emit MaxFeeRateUpdated(maxFeeRate, bps);
        maxFeeRate = bps;
    }

    /// @inheritdoc ISmartDCA
    function setMaxSlippage(uint16 bps) external {
        _checkAccessAllowed("setMaxSlippage(uint16)");
        if (bps > MAX_SLIPPAGE) revert AboveHardCap();
        emit MaxSlippageUpdated(maxSlippage, bps);
        maxSlippage = bps;
    }

    /// @inheritdoc ISmartDCA
    function setMaxSplitN(uint8 n) external {
        _checkAccessAllowed("setMaxSplitN(uint8)");
        if (n == 0) revert InvalidParameter();
        if (n > MAX_SPLIT_N) revert AboveHardCap();
        emit MaxSplitNUpdated(maxSplitN, n);
        maxSplitN = n;
    }

    /// @inheritdoc ISmartDCA
    function setBackup(address account, bool allowed) external {
        _checkAccessAllowed("setBackup(address,bool)");
        if (account == address(0)) revert ZeroAddress();
        isBackup[account] = allowed;
        emit BackupUpdated(account, allowed);
    }

    /// @inheritdoc ISmartDCA
    function pause() external {
        _checkAccessAllowed("pause()");
        _pause();
    }

    /// @inheritdoc ISmartDCA
    function setYieldSource(address token, SourceKind kind, address source) external nonReentrant {
        _checkAccessAllowed("setYieldSource(address,uint8,address)");
        if (token == address(0) || source == address(0)) revert ZeroAddress();
        if (kind == SourceKind.Hub) {
            if (!HUB_REGISTRY.isHub(source) || IHub(source).asset() != token) revert InvalidSource();
        } else if (kind == SourceKind.Core) {
            (bool isListed, , ) = COMPTROLLER.markets(source);
            if (!isListed || IVToken(source).underlying() != token) revert InvalidSource();
        } else {
            revert InvalidSource();
        }
        Source storage current = sources[token];
        if (current.source == source) revert InvalidSource();

        // Holdings move in the same call; units do not change, so no plan record changes
        uint256 migrated;
        uint256 oldShares = current.shares;
        if (oldShares != 0) {
            _checkTokenUnlocked(token);
            current.shares = 0;
            migrated = _sourceRedeem(current, token, oldShares);
        }
        address oldSource = current.source;
        delete tokenOfSource[oldSource];
        current.kind = kind;
        current.source = source;
        tokenOfSource[source] = token;
        if (migrated != 0) current.shares = _sourceDeposit(current, token, migrated);

        emit YieldSourceUpdated(token, oldSource, kind, source, migrated);
    }

    /// @inheritdoc ISmartDCA
    function setKeeper(address account, bool allowed) external {
        _checkAccessAllowed("setKeeper(address,bool)");
        if (account == address(0)) revert ZeroAddress();
        isKeeper[account] = allowed;
        emit KeeperUpdated(account, allowed);
    }

    /// @inheritdoc ISmartDCA
    function setBackupDelay(uint32 delay) external {
        _checkAccessAllowed("setBackupDelay(uint32)");
        if (delay > MAX_BACKUP_DELAY) revert AboveHardCap();
        emit BackupDelayUpdated(backupDelay, delay);
        backupDelay = delay;
    }

    /// @inheritdoc ISmartDCA
    function setMinPerBuy(address stable, uint256 amount) external {
        _checkAccessAllowed("setMinPerBuy(address,uint256)");
        if (stable == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidParameter();
        emit MinPerBuyUpdated(stable, minPerBuy[stable], amount);
        minPerBuy[stable] = amount;
    }

    /// @inheritdoc ISmartDCA
    function setBuyBounds(uint8 minBuys_, uint8 maxBuys_) external {
        _checkAccessAllowed("setBuyBounds(uint8,uint8)");
        if (minBuys_ == 0 || minBuys_ > maxBuys_) revert InvalidParameter();
        if (maxBuys_ > MAX_BUYS) revert AboveHardCap();
        emit BuyBoundsUpdated(minBuys, maxBuys, minBuys_, maxBuys_);
        minBuys = minBuys_;
        maxBuys = maxBuys_;
    }

    /// @inheritdoc ISmartDCA
    function addPair(address stable, address asset) external returns (uint32 pairId) {
        _checkAccessAllowed("addPair(address,address)");
        if (stable == asset) revert InvalidPair();
        if (sources[stable].kind == SourceKind.None) revert NoYieldSource(stable);
        if (sources[asset].kind == SourceKind.None) revert NoYieldSource(asset);
        if (pairIdOf[stable][asset] != 0) revert PairExists();
        // Without a minimum, a dust plan whose slice redeems 0 would revert every `startBuy` of the pair
        if (minPerBuy[stable] == 0) revert InvalidParameter();
        // Reverts when the oracle cannot price either token
        ORACLE.getPrice(stable);
        ORACLE.getPrice(asset);

        pairId = ++pairCount;
        pairIdOf[stable][asset] = pairId;
        Pair storage pair = pairs[pairId];
        pair.stable = stable;
        pair.asset = asset;
        pair.enabled = true;
        pair.lastSettledRound = SmartDCAMath.currentRound(block.timestamp);

        emit PairAdded(pairId, stable, asset);
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

        // Owed: source shares held for plans, and stable or asset held by a round between startBuy and settle
        uint256 owed;
        address sourceToken = tokenOfSource[token];
        if (sourceToken != address(0)) owed = sources[sourceToken].shares;
        for (uint32 id = 1; id <= pairCount; ++id) {
            Pair storage pair = pairs[id];
            Round storage r = rounds[id][pair.lastSettledRound + 1];
            if (r.partsTotal == 0) continue;
            if (pair.stable == token) owed += r.toSwap;
            if (pair.asset == token) owed += r.amountOut;
        }

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 amount = balance > owed ? balance - owed : 0;
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
        emit TokenSwept(token, to, amount);
    }

    /// @inheritdoc ISmartDCA
    function setReserve(address reserve_) external {
        _checkAccessAllowed("setReserve(address)");
        if (reserve_ == address(0)) revert ZeroAddress();
        emit ReserveUpdated(reserve, reserve_);
        reserve = reserve_;
    }

    /// @inheritdoc ISmartDCA
    function lockTime(uint32 pairId) external view returns (uint256) {
        return SmartDCAMath.roundStart(pairs[pairId].lastSettledRound + 1);
    }

    /// @inheritdoc ISmartDCA
    function getPlansOf(address owner) external view returns (uint256[] memory) {
        return _plansOf[owner];
    }

    /// @dev Settles, with no swap, every round of the pair that has nothing due and whose lock time has passed
    function _advanceEmpty(uint32 pairId, Pair storage pair) internal {
        while (pair.dueUnits == 0) {
            uint32 round = pair.lastSettledRound + 1;
            if (block.timestamp < SmartDCAMath.roundStart(round)) return;
            Round storage r = rounds[pairId][round];
            _closeRound(pair, r, round);
            emit PairSettled(pairId, round, 0, 0, 0, 0, pair.cumIndex, pair.cumBaseIndex);
        }
    }

    /// @dev Records the indexes for `round`, moves the next round's plans in and the ended ones out
    function _closeRound(Pair storage pair, Round storage r, uint32 round) internal {
        r.cumIndexAfter = pair.cumIndex;
        r.cumBaseIndexAfter = pair.cumBaseIndex;
        pair.dueUnits = pair.dueUnits - r.sliceEnding + r.sliceStarting;
        pair.dueBase = pair.dueBase - r.baseEnding + r.baseStarting;
        pair.lastSettledRound = round;
    }

    /// @dev Emits `LockEntered` once per round, from the pair's lock time
    function _touchLock(uint32 pairId, Pair storage pair) internal {
        uint32 round = pair.lastSettledRound + 1;
        if (pair.lockEnteredRound == round || block.timestamp < SmartDCAMath.roundStart(round)) return;
        pair.lockEnteredRound = round;
        emit LockEntered(pairId, round);
    }

    /// @dev Adds a slice to the pair's next round, or parks it until the round before `firstRound` settles
    function _addToRound(uint32 pairId, Pair storage pair, uint32 firstRound, uint256 slice, uint256 base) internal {
        if (firstRound <= pair.lastSettledRound + 1) {
            pair.dueUnits += slice;
            pair.dueBase += base;
        } else {
            Round storage r = rounds[pairId][firstRound - 1];
            r.sliceStarting += slice;
            r.baseStarting += base;
        }
    }

    /// @dev Reverse of `_addToRound`
    function _removeFromRound(
        uint32 pairId,
        Pair storage pair,
        uint32 firstRound,
        uint256 slice,
        uint256 base
    ) internal {
        if (firstRound <= pair.lastSettledRound + 1) {
            pair.dueUnits -= slice;
            pair.dueBase -= base;
        } else {
            Round storage r = rounds[pairId][firstRound - 1];
            r.sliceStarting -= slice;
            r.baseStarting -= base;
        }
    }

    /// @dev Keepers from the pair's lock time, backup addresses from the lock time plus `backupDelay`
    function _checkRoundCaller(Pair storage pair) internal view {
        uint256 lock = SmartDCAMath.roundStart(pair.lastSettledRound + 1);
        if (isKeeper[msg.sender]) {
            if (block.timestamp < lock) revert PairNotLocked();
        } else if (isBackup[msg.sender]) {
            if (block.timestamp < lock + backupDelay) revert BackupTooEarly();
        } else {
            revert NotAllowedCaller();
        }
    }

    /// @dev Reverts while any pair using `token` is past its lock time and not settled
    function _checkTokenUnlocked(address token) internal view {
        for (uint32 id = 1; id <= pairCount; ++id) {
            Pair storage pair = pairs[id];
            if (pair.stable != token && pair.asset != token) continue;
            if (block.timestamp >= SmartDCAMath.roundStart(pair.lastSettledRound + 1)) revert TokenLocked(token);
        }
    }

    function _executingRound(uint32 pairId, uint32 round) internal view returns (Round storage r) {
        r = rounds[pairId][round];
        if (r.partsTotal == 0) revert PairNotExecuting();
    }

    function _pair(uint32 pairId) internal view returns (Pair storage pair) {
        if (pairId == 0 || pairId > pairCount) revert InvalidPair();
        pair = pairs[pairId];
    }

    function _ownedActivePlan(uint256 planId) internal view returns (Plan storage plan) {
        plan = plans[planId];
        if (plan.owner != msg.sender) revert NotPlanOwner();
        if (plan.status != PlanStatus.Active) revert PlanNotActive();
    }

    /// @dev Rounds of the current schedule that have settled
    function _roundsDone(Plan storage plan, Pair storage pair) internal view returns (uint8) {
        return SmartDCAMath.roundsDone(pair.lastSettledRound, plan.firstRound, plan.buys);
    }

    /// @dev True from the lock time of a round the plan is in until that round settles
    function _inRunningRound(Plan storage plan, Pair storage pair) internal view returns (bool) {
        return SmartDCAMath.inRunningRound(pair.lastSettledRound + 1, plan.firstRound, plan.buys, block.timestamp);
    }

    /// @dev Asset units the plan holds now
    function _bought(Plan storage plan, Pair storage pair) internal view returns (uint256) {
        return plan.carriedBought + _indexBought(plan, plan.pairId, _roundsDone(plan, pair)) - plan.withdrawnBought;
    }

    /// @dev Asset units bought in the current schedule's first `roundsDone` rounds
    function _indexBought(Plan storage plan, uint32 pairId, uint8 roundsDone) internal view returns (uint256) {
        if (roundsDone == 0) return 0;
        Round storage before = rounds[pairId][plan.firstRound - 1];
        Round storage last = rounds[pairId][plan.firstRound + roundsDone - 1];
        return
            SmartDCAMath.planBought(
                plan.slice,
                plan.base,
                last.cumIndexAfter - before.cumIndexAfter,
                last.cumBaseIndexAfter - before.cumBaseIndexAfter
            );
    }

    /// @dev Pulls `amount` of `token` from the caller and returns what arrived
    function _pull(address token, uint256 amount) internal returns (uint256) {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Deposits `amount` of `token` into its source and returns the units minted, rounded down
    function _deposit(address token, uint256 amount) internal returns (uint256 units) {
        Source storage s = sources[token];
        uint256 shares = _sourceDeposit(s, token, amount);
        units = s.units == 0 || s.shares == 0 ? shares : Math.mulDiv(shares, s.units, s.shares);
        s.shares += shares;
        s.units += units;
    }

    /// @dev Redeems `units` of `token` from its source and returns the token received
    function _redeem(address token, uint256 units) internal returns (uint256) {
        Source storage s = sources[token];
        uint256 shares = Math.mulDiv(units, s.shares, s.units);
        s.units -= units;
        s.shares -= shares;
        return _sourceRedeem(s, token, shares);
    }

    /// @dev Sends the source shares behind `units` of `token` (a Hub share or a vToken) and returns them
    function _transferUnits(address token, uint256 units, address to) internal returns (uint256 shares) {
        Source storage s = sources[token];
        shares = Math.mulDiv(units, s.shares, s.units);
        s.units -= units;
        s.shares -= shares;
        IERC20(s.source).safeTransfer(to, shares);
    }

    /// @dev Units of `token` worth at least `amount`, rounded up. After a source switch the units to shares ratio
    ///      is not 1, so the redeem that follows can pay a few wei less than `amount`.
    function _unitsForAmount(address token, uint256 amount) internal returns (uint256) {
        Source storage s = sources[token];
        uint256 shares = s.kind == SourceKind.Hub
            ? IHub(s.source).previewWithdraw(amount)
            : Math.mulDiv(amount, 1e18, IVToken(s.source).exchangeRateCurrent(), Math.Rounding.Up);
        return Math.mulDiv(shares, s.units, s.shares, Math.Rounding.Up);
    }

    /// @dev Deposits into the source and returns the shares received, measured as a balance change
    function _sourceDeposit(Source storage s, address token, uint256 amount) internal returns (uint256) {
        address source = s.source;
        uint256 sharesBefore = IERC20(source).balanceOf(address(this));
        IERC20(token).forceApprove(source, amount);
        if (s.kind == SourceKind.Hub) {
            IHub(source).deposit(amount, address(this));
        } else {
            uint256 err = IVToken(source).mint(amount);
            if (err != 0) revert SourceCallFailed(source, err);
        }
        return IERC20(source).balanceOf(address(this)) - sharesBefore;
    }

    /// @dev Redeems shares from the source and returns the token received, measured as a balance change
    function _sourceRedeem(Source storage s, address token, uint256 shares) internal returns (uint256) {
        address source = s.source;
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        if (s.kind == SourceKind.Hub) {
            IHub(source).redeem(shares, address(this), address(this));
        } else {
            uint256 err = IVToken(source).redeem(shares);
            if (err != 0) revert SourceCallFailed(source, err);
        }
        return IERC20(token).balanceOf(address(this)) - balanceBefore;
    }
}
