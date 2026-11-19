// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

/**
 * @title ISmartDCA
 * @author Venus
 * @notice Types, events, errors and external functions of SmartDCA. Every function is documented here; the contract
 *         only inherits the docs.
 * @dev Every amount in SmartDCA is one of four kinds, and its name says which:
 *      - Token amount (`stableAmount`, `assetAmount`): wei of a token, for example USDT or BTCB.
 *      - Source share (`sharesHeld`): what SmartDCA holds in a yield source, a Hub share or a Core vToken.
 *      - Unit (`stableUnits`, `assetUnits`): a plan's claim on SmartDCA's shares of one token. Interest raises the
 *        value of a unit, never the number of units, so a plan's units only change when it deposits or is paid.
 *      - Principal (`principal`): stable a plan deposited for one buy, PRD letter B. The fee is only taken on what
 *        a buy redeems above its principal, so it never touches principal.
 *
 *      Other terms:
 *      - Stable: the token a plan pays with (USDT, USDC, U). Asset: the token it buys (BTCB, ETH, WBNB).
 *      - Pair: one stable and one asset. Each pair has its own rounds.
 *      - Round: one buy of a pair, numbered from a pair's first round on. The first round locks on the 15th at
 *        00:00 UTC+8; each later one locks `buyInterval` after the lock time of the round before it, however late
 *        that round ran. From its lock time the
 *        keeper redeems, swaps and settles it.
 *      - Schedule: the buys a plan has left. A top up restarts the schedule over the buys left, so a plan stores
 *        its current schedule and, apart from it, what it bought before.
 */
interface ISmartDCA {
    /// @notice Kind of yield source a token waits and earns in
    enum SourceKind {
        None,
        Hub,
        Core
    }

    /// @notice Side of a pair: the stable it sells or the asset it buys. Each side has its own yield source.
    enum Side {
        Stable,
        Asset
    }

    /// @notice Stored plan status. A plan is Matured when it is Active and every buy has settled; that is computed,
    ///         not stored.
    enum PlanStatus {
        None,
        Active,
        Cancelled,
        Claimed
    }

    /**
     * @notice Where one side of one pair waits and earns, and how much SmartDCA holds there for it
     * @dev Kept per pair, so two pairs with the same stable can use different sources, and moving one pair's source
     *      leaves the other pairs alone.
     * @param kind Hub or Core
     * @param sourceAddress The Liquidity Hub, or the Core vToken
     * @param sharesHeld Source shares SmartDCA holds for this pair side, counted in storage so donations are ignored
     * @param unitsIssued Units of this pair side owed to plans and rounds. One unit is backed by
     *        `sharesHeld / unitsIssued` shares.
     */
    struct YieldSource {
        SourceKind kind;
        address sourceAddress;
        uint256 sharesHeld;
        uint256 unitsIssued;
    }

    /**
     * @notice A stable to asset pair and the totals of its next round
     * @param stable Token sold
     * @param asset Token bought
     * @param enabled False stops new plans and top ups; running plans keep buying
     * @param nextLockTime Lock time of the next round: the 15th at 00:00 UTC+8 for the first round, then the lock
     *        time of the round before it plus `buyInterval`
     * @param lastSettledRound Last round that settled. The pair's next round is `lastSettledRound + 1`.
     * @param lockEmittedRound Last round `RoundLocked` was emitted for
     * @param roundStableUnits Stable units the next round sells: the sum of `stableUnitsPerBuy` over its plans
     * @param roundPrincipal Principal of the next round: the sum of `principalPerBuy` over its plans
     * @param assetPerUnitIndex Asset units bought per stable unit sold, summed over every settled round, scaled 1e36
     * @param assetPerPrincipalIndex Asset units bought per wei of principal, summed over every settled round, scaled
     *        1e36. It only grows in rounds that took a fee.
     */
    struct Pair {
        address stable;
        uint64 nextLockTime;
        address asset;
        bool enabled;
        uint32 lastSettledRound;
        uint32 lockEmittedRound;
        uint256 roundStableUnits;
        uint256 roundPrincipal;
        uint256 assetPerUnitIndex;
        uint256 assetPerPrincipalIndex;
    }

    /**
     * @notice One round of a pair
     * @param partsTotal Parts the round is split into; 0 until `startRound`
     * @param partsDone Parts swapped so far
     * @param resplitUsed Whether `resplitRound` was called
     * @param feeRateBps Fee rate the round charged, in basis points; 0 when it redeemed no more than its principal
     * @param stableRedeemed Stable amount `startRound` redeemed for the round's stable units
     * @param stableNet `stableRedeemed` less the fee: the stable amount the round swaps
     * @param stableToSwap Part of `stableNet` not swapped yet
     * @param assetBought Asset amount the swaps returned so far
     * @param stableUnitsJoining Stable units per buy of plans whose first round is the one after this. They are
     *        added to the pair's totals when this round settles.
     * @param principalJoining Principal per buy of the same plans
     * @param stableUnitsEnding Stable units per buy of plans whose last buy is this round. They are removed from the
     *        pair's totals when this round settles.
     * @param principalEnding Principal per buy of the same plans
     * @param assetPerUnitIndexAfter `Pair.assetPerUnitIndex` once this round settled
     * @param assetPerPrincipalIndexAfter `Pair.assetPerPrincipalIndex` once this round settled
     */
    struct Round {
        uint8 partsTotal;
        uint8 partsDone;
        bool resplitUsed;
        uint16 feeRateBps;
        uint256 stableRedeemed;
        uint256 stableNet;
        uint256 stableToSwap;
        uint256 assetBought;
        uint256 stableUnitsJoining;
        uint256 principalJoining;
        uint256 stableUnitsEnding;
        uint256 principalEnding;
        uint256 assetPerUnitIndexAfter;
        uint256 assetPerPrincipalIndexAfter;
    }

    /**
     * @notice A pair's PancakeSwap V3 route for `forceBuy`, set by governance
     * @param router PancakeSwap V3 SwapRouter; zero means the pair has no route and `forceBuy` reverts
     * @param path Pools from the stable to the asset, packed as `stable, fee, asset` or with more hops
     */
    struct FallbackRoute {
        address router;
        bytes path;
    }

    /**
     * @notice A plan. Round calls never write it; its progress is read from the pair and round records.
     * @dev A top up restarts the schedule: what was bought so far moves to `assetUnitsCarried`, and the `schedule`
     *      fields then describe only the buys still left. The plan's buys in total are
     *      `buysBeforeSchedule + scheduleBuys`.
     * @param owner Plan owner, the only account that can act on it
     * @param pairId Pair the plan buys on
     * @param status Stored status
     * @param scheduleBuys Buys in the current schedule
     * @param buysBeforeSchedule Buys that settled before the current schedule started
     * @param scheduleFirstRound First round of the current schedule
     * @param scheduleStableUnits Stable units the plan held when the current schedule started
     * @param stableUnitsPerBuy Stable units sold in each buy, `scheduleStableUnits / scheduleBuys` rounded down
     * @param principalPerBuy Principal in each buy (PRD B)
     * @param assetUnitsCarried Asset units bought before the current schedule started
     * @param assetUnitsPaid Asset units paid out by `withdrawBought`, `cancelPlan` and `claimPlan`
     */
    struct Plan {
        address owner;
        uint32 pairId;
        PlanStatus status;
        uint8 scheduleBuys;
        uint8 buysBeforeSchedule;
        uint32 scheduleFirstRound;
        uint256 scheduleStableUnits;
        uint256 stableUnitsPerBuy;
        uint256 principalPerBuy;
        uint256 assetUnitsCarried;
        uint256 assetUnitsPaid;
    }

    /**
     * @notice Emitted when a plan is created
     * @param planId The new plan
     * @param owner Owner of the plan
     * @param pairId Pair the plan buys on
     * @param stableAmount Stable amount received
     * @param stableUnits Stable units minted for `stableAmount`
     * @param stableUnitsPerBuy Stable units sold in each buy
     * @param principalPerBuy Principal in each buy
     * @param buys Number of buys
     * @param firstRound First round the plan buys in
     */
    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        uint32 indexed pairId,
        uint256 stableAmount,
        uint256 stableUnits,
        uint256 stableUnitsPerBuy,
        uint256 principalPerBuy,
        uint8 buys,
        uint32 firstRound
    );

    /**
     * @notice Emitted when a plan is topped up; its schedule restarts with `buysLeft` buys
     * @param planId The plan
     * @param stableAmount Stable amount received
     * @param stableUnits Stable units minted for `stableAmount`
     * @param stableUnitsPerBuy New stable units sold in each buy
     * @param principalPerBuy New principal in each buy
     * @param buysLeft Buys in the restarted schedule
     */
    event PlanToppedUp(
        uint256 indexed planId,
        uint256 stableAmount,
        uint256 stableUnits,
        uint256 stableUnitsPerBuy,
        uint256 principalPerBuy,
        uint8 buysLeft
    );

    /**
     * @notice Emitted when bought asset is withdrawn from an active plan
     * @param planId The plan
     * @param assetUnits Asset units taken from the plan
     * @param assetAmount Asset amount paid to the owner
     */
    event BoughtWithdrawn(uint256 indexed planId, uint256 assetUnits, uint256 assetAmount);

    /**
     * @notice Emitted when a plan is cancelled
     * @param planId The plan
     * @param stableAmount Stable amount paid to the owner, after `fee`
     * @param fee Stable amount sent to the Reserve
     * @param assetAmount Bought asset paid to the owner
     */
    event PlanCancelled(uint256 indexed planId, uint256 stableAmount, uint256 fee, uint256 assetAmount);

    /**
     * @notice Emitted when a matured plan is claimed
     * @param planId The plan
     * @param toCore True when paid as the asset's Core vToken, false when paid as the asset
     * @param amount vTokens or asset amount paid to the owner
     */
    event PlanClaimed(uint256 indexed planId, bool toCore, uint256 amount);

    /**
     * @notice Emitted when a plan moves to a new owner
     * @param planId The plan
     * @param from Previous owner
     * @param to New owner
     */
    event PlanTransferred(uint256 indexed planId, address indexed from, address indexed to);

    /**
     * @notice Emitted once per round, by the first call from the round's lock time that touches the pair
     *         (`createPlan`, `claimPlan`, `startRound` or `syncPair`)
     * @param pairId The pair
     * @param round The round that locked
     */
    event RoundLocked(uint32 indexed pairId, uint32 indexed round);

    /**
     * @notice Emitted when a round redeems its stable and takes its fee
     * @param pairId The pair
     * @param round The round
     * @param parts Parts the round is split into
     * @param roundStableUnits Stable units redeemed
     * @param stableRedeemed Stable amount received for them
     * @param roundPrincipal Principal of the round's plans; the fee is taken on `stableRedeemed` above it
     * @param feeRateBps Fee rate charged, in basis points; 0 when `stableRedeemed` is not above `roundPrincipal`
     * @param stableNet Stable amount left to swap after the fee
     */
    event RoundStarted(
        uint32 indexed pairId,
        uint32 indexed round,
        uint8 parts,
        uint256 roundStableUnits,
        uint256 stableRedeemed,
        uint256 roundPrincipal,
        uint16 feeRateBps,
        uint256 stableNet
    );

    /**
     * @notice Emitted for each swapped part of a round
     * @param pairId The pair
     * @param round The round
     * @param part Number of the part, from 1
     * @param stableIn Stable amount sold
     * @param assetOut Asset amount received
     * @param quotedOut Asset amount the keeper's quote promised for `stableIn`, or in `forceBuy` its oracle value
     * @param minOut Least asset amount allowed: `quotedOut` less `maxSlippageBps`, or in `forceBuy` less
     *        `fallbackSlippageBps`
     */
    event RoundPartSwapped(
        uint32 indexed pairId,
        uint32 indexed round,
        uint8 part,
        uint256 stableIn,
        uint256 assetOut,
        uint256 quotedOut,
        uint256 minOut
    );

    /**
     * @notice Emitted when the parts left of a round are split again
     * @param pairId The pair
     * @param round The round
     * @param partsDone Parts already swapped
     * @param newParts Parts the rest is split into
     */
    event RoundResplit(uint32 indexed pairId, uint32 indexed round, uint8 partsDone, uint8 newParts);

    /**
     * @notice Emitted when a round settles. A round with nothing to buy settles with every amount 0.
     * @param pairId The pair
     * @param round The round
     * @param stableRedeemed Stable amount the round redeemed
     * @param fee Stable amount the round sent to the Reserve
     * @param assetBought Asset amount the round bought
     * @param assetUnits Asset units minted for `assetBought`
     * @param assetPerUnitIndex `Pair.assetPerUnitIndex` after the round
     * @param assetPerPrincipalIndex `Pair.assetPerPrincipalIndex` after the round
     */
    event RoundSettled(
        uint32 indexed pairId,
        uint32 indexed round,
        uint256 stableRedeemed,
        uint256 fee,
        uint256 assetBought,
        uint256 assetUnits,
        uint256 assetPerUnitIndex,
        uint256 assetPerPrincipalIndex
    );

    /**
     * @notice Emitted when a round sends its fee to the Reserve
     * @param pairId The pair
     * @param round The round
     * @param amount Stable amount sent
     */
    event RoundFeeCollected(uint32 indexed pairId, uint32 indexed round, uint256 amount);

    /**
     * @notice Emitted when a cancel sends its fee to the Reserve
     * @param pairId The plan's pair
     * @param planId The cancelled plan
     * @param amount Stable amount sent
     */
    event CancelFeeCollected(uint32 indexed pairId, uint256 indexed planId, uint256 amount);

    /**
     * @notice Emitted when XVS rewards are claimed and sent to the Reserve
     * @param amount XVS sent
     */
    event RewardsClaimed(uint256 amount);

    /**
     * @notice Emitted when governance adds a pair
     * @param pairId The new pair
     * @param stable Token sold
     * @param asset Token bought
     */
    event PairAdded(uint32 indexed pairId, address indexed stable, address indexed asset);

    /**
     * @notice Emitted when a pair is enabled or disabled
     * @param pairId The pair
     * @param enabled True when new plans and top ups are allowed
     */
    event PairEnabledUpdated(uint32 indexed pairId, bool enabled);

    /**
     * @notice Emitted when the yield source of one side of a pair is set
     * @param pairId The pair
     * @param side Stable or Asset
     * @param oldSource Previous source, 0 when none
     * @param kind Kind of the new source
     * @param newSource New source
     * @param migratedAmount Token amount moved from the old source to the new one
     */
    event YieldSourceUpdated(
        uint32 indexed pairId,
        Side side,
        address oldSource,
        SourceKind kind,
        address newSource,
        uint256 migratedAmount
    );

    /**
     * @notice Emitted when the fee rate changes
     * @param oldFeeRateBps Previous rate, in basis points
     * @param newFeeRateBps New rate, in basis points
     */
    event FeeRateUpdated(uint16 oldFeeRateBps, uint16 newFeeRateBps);

    /**
     * @notice Emitted when the fee rate cap changes
     * @param oldMaxFeeRateBps Previous cap, in basis points
     * @param newMaxFeeRateBps New cap, in basis points
     */
    event MaxFeeRateUpdated(uint16 oldMaxFeeRateBps, uint16 newMaxFeeRateBps);

    /**
     * @notice Emitted when the slippage bound changes
     * @param oldMaxSlippageBps Previous bound, in basis points
     * @param newMaxSlippageBps New bound, in basis points
     */
    event MaxSlippageUpdated(uint16 oldMaxSlippageBps, uint16 newMaxSlippageBps);

    /**
     * @notice Emitted when the most parts a round can be split into changes
     * @param oldMaxParts Previous value
     * @param newMaxParts New value
     */
    event MaxPartsUpdated(uint8 oldMaxParts, uint8 newMaxParts);

    /**
     * @notice Emitted when a stable's least amount per buy changes
     * @param stable The stable
     * @param oldAmount Previous minimum, in the stable's decimals
     * @param newAmount New minimum, in the stable's decimals
     */
    event MinAmountPerBuyUpdated(address indexed stable, uint256 oldAmount, uint256 newAmount);

    /**
     * @notice Emitted when the allowed number of buys for a new plan changes
     * @param oldMinBuys Previous fewest buys
     * @param oldMaxBuys Previous most buys
     * @param newMinBuys New fewest buys
     * @param newMaxBuys New most buys
     */
    event BuyBoundsUpdated(uint8 oldMinBuys, uint8 oldMaxBuys, uint8 newMinBuys, uint8 newMaxBuys);

    /**
     * @notice Emitted when a keeper is added or removed
     * @param account The keeper
     * @param allowed True when added
     */
    event KeeperUpdated(address indexed account, bool allowed);

    /**
     * @notice Emitted when the Reserve address changes
     * @param oldReserve Previous Reserve
     * @param newReserve New Reserve
     */
    event ReserveUpdated(address oldReserve, address newReserve);

    /**
     * @notice Emitted when tokens not owed to plans or rounds are swept
     * @param token The token
     * @param to Receiver
     * @param amount Amount sent
     */
    event TokenSwept(address indexed token, address indexed to, uint256 amount);

    /**
     * @notice Emitted when a pair's `forceBuy` route is set
     * @param pairId The pair
     * @param router PancakeSwap V3 SwapRouter, zero to remove the route
     * @param path Packed pool path from the stable to the asset
     */
    event FallbackRouteUpdated(uint32 indexed pairId, address router, bytes path);

    /**
     * @notice Emitted when the `forceBuy` slippage bound changes
     * @param oldSlippageBps Previous bound, in basis points
     * @param newSlippageBps New bound, in basis points
     */
    event FallbackSlippageUpdated(uint16 oldSlippageBps, uint16 newSlippageBps);

    /**
     * @notice Emitted when the gap between buys changes
     * @param oldInterval Previous gap, in seconds
     * @param newInterval New gap, in seconds
     */
    event BuyIntervalUpdated(uint32 oldInterval, uint32 newInterval);

    /// @notice An address argument was zero.
    error ZeroAddress();

    /// @notice An amount was zero, or a round or withdraw would move nothing.
    error ZeroAmount();

    /// @notice No pair has this id.
    error UnknownPair(uint32 pairId);

    /// @notice A pair was added with the same token as stable and asset.
    error SameTokens();

    /// @notice A plan was created or topped up on a disabled pair.
    error PairDisabled();

    /// @notice A pair with this stable and asset already exists.
    error PairExists();

    /// @notice The call to SwapHelper reverted.
    error SwapFailed();

    /// @notice The swap call did not sell the whole part: some of the stable came back to SmartDCA or stayed in
    ///         SwapHelper.
    error PartNotFullySwapped(uint256 stableIn, uint256 stableSpent);

    /// @notice The yield source is not a registered Hub, or not a listed Core vToken, of the token.
    error InvalidSource(address source);

    /// @notice The yield source is already the source of this pair side.
    error SourceUnchanged();

    /// @notice A pair's source cannot move while the pair is past its lock time and not settled.
    error PairLocked(uint32 pairId);

    /// @notice A keeper called a round function before the round's lock time.
    error RoundNotLocked(uint32 pairId, uint256 lockTime);

    /// @notice The round function needs a started round, and `startRound` has not run yet.
    error RoundNotStarted(uint32 pairId);

    /// @notice `startRound` already ran for the pair's next round.
    error RoundAlreadyStarted(uint32 pairId);

    /// @notice The caller is not a keeper.
    error NotRoundCaller(address caller);

    /// @notice The number of parts is 0 or above `maxParts`.
    error InvalidParts();

    /// @notice Every part of the round is already swapped.
    error NoPartsLeft();

    /// @notice The round cannot settle while it has parts left to swap.
    error PartsLeft();

    /// @notice The round was already resplit once.
    error AlreadyResplit();

    /// @notice The swap returned less than the quote less `maxSlippageBps`.
    error SlippageExceeded(uint256 assetOut, uint256 minOut);

    /// @notice The number of buys is outside `minBuys` to `maxBuys`.
    error InvalidBuys(uint8 buys, uint8 minBuys, uint8 maxBuys);

    /// @notice The deposit is under `minAmountPerBuy` times the buys, or too small to sell one unit per buy.
    error DepositTooSmall(uint256 amount, uint256 minimum);

    /// @notice The caller does not own the plan.
    error NotPlanOwner();

    /// @notice The plan is cancelled, claimed or unknown.
    error PlanNotActive();

    /// @notice The plan is in a round past its lock time that has not settled.
    error PlanInRunningRound();

    /// @notice Every buy of the plan has settled, so it can only be claimed.
    error PlanMatured();

    /// @notice The plan still has buys to settle.
    error PlanNotMatured();

    /// @notice The withdraw asks for more asset units than the plan has bought.
    error WithdrawExceedsBought(uint256 requestedUnits, uint256 availableUnits);

    /// @notice A claim to Core was asked for while the asset is not held in Core.
    error NotCoreSource();

    /// @notice A Core vToken returned a non-zero error code.
    error SourceCallFailed(address source, uint256 errorCode);

    /// @notice A parameter is above its hard cap.
    error AboveHardCap();

    /// @notice A parameter is outside its allowed range.
    error InvalidParameter();

    /// @notice `forceBuy` was called on a pair with no route.
    error NoFallbackRoute(uint32 pairId);

    /**
     * @notice Deposits `amount` of the pair's stable and starts a plan of `buys` buys, one per round.
     * @dev Caller must first `approve` SmartDCA for `amount` of the stable. The deposit goes into the pair's stable
     *      source and the plan holds units of it. Each buy sells the same number of units, so a buy's stable amount
     *      grows with the interest earned while waiting.
     *
     *      The plan's first round is the pair's next round when called before that round's lock time, and the round
     *      after it from the lock time on.
     *
     *      Reverts if the pair is unknown or disabled, if `buys` is outside `minBuys` to `maxBuys`, or if `amount` is
     *      under `minAmountPerBuy` of the stable times `buys`.
     * @param pairId Pair to buy on
     * @param amount Stable amount to deposit, in the stable's decimals
     * @param buys Number of buys
     * @return planId The new plan
     * @custom:event Emits PlanCreated, and RoundLocked on the first call of a locked round.
     */
    function createPlan(uint32 pairId, uint256 amount, uint8 buys) external returns (uint256 planId);

    /**
     * @notice Adds `amount` of stable to a plan and spreads everything still waiting over the buys left.
     * @dev Caller must own the plan and first `approve` SmartDCA for `amount`. The schedule restarts: what was bought
     *      so far is kept aside, and the stable still waiting plus the new deposit is split evenly over the buys left.
     *
     *      Reverts if the plan is in a round past its lock time that has not settled, if every buy has settled, if
     *      the pair is disabled, or if `amount` is under `minAmountPerBuy` times the buys left.
     * @param planId The plan
     * @param amount Stable amount to add, in the stable's decimals
     * @custom:event Emits PlanToppedUp.
     */
    function topUpPlan(uint256 planId, uint256 amount) external;

    /**
     * @notice Pays the plan owner `amount` of the asset bought so far, or all of it with `type(uint256).max`.
     * @dev Allowed while the plan's round is running: a running round's buy only counts once it settles. A partial
     *      amount is converted to units rounded up, so after a source switch the owner can receive a few wei less
     *      than `amount`.
     * @param planId The plan
     * @param amount Asset amount to withdraw, in the asset's decimals
     * @custom:event Emits BoughtWithdrawn.
     */
    function withdrawBought(uint256 planId, uint256 amount) external;

    /**
     * @notice Ends a plan. Pays back the stable still waiting, less the fee on its interest, and all bought asset.
     * @dev The fee is `feeRateBps` of what the waiting stable redeems above its principal, so a cancel never takes a
     *      fee from principal. Reverts if the plan is in a round past its lock time that has not settled, or if
     *      every buy has settled (claim it instead).
     * @param planId The plan
     * @custom:event Emits PlanCancelled, and CancelFeeCollected when the fee is not zero.
     */
    function cancelPlan(uint256 planId) external;

    /**
     * @notice Pays out a plan whose buys have all settled, and closes it.
     * @dev With `toCore`, the owner receives the asset's Core vTokens and keeps earning; collateral is not enabled for
     *      them. Up to `scheduleBuys - 1` stable units are left by rounding the per-buy amount down; they are worth
     *      under 1 wei and are dropped here.
     * @param planId The plan
     * @param toCore True to pay as vTokens, false to pay as the asset
     * @custom:event Emits PlanClaimed.
     */
    function claimPlan(uint256 planId, bool toCore) external;

    /**
     * @notice Gives an active plan to `newOwner`, who can then top it up, withdraw, cancel and claim it.
     * @dev Only the owner changes; no funds or round totals move, so it works during a lock too.
     * @param planId The plan
     * @param newOwner The new owner
     * @custom:event Emits PlanTransferred.
     */
    function transferPlan(uint256 planId, address newOwner) external;

    /**
     * @notice Starts the pair's next round: redeems its stable units from the yield source and sends the fee to the
     *         Reserve.
     * @dev Keepers can call from the round's lock time.
     *      Rounds with nothing to buy are settled first. If the round after them is not locked yet, the call returns
     *      with nothing done.
     *
     *      The fee is `feeRateBps` of what the round redeems above its principal, and the rate is fixed for the
     *      round here. Reverts if the round already started, or if the redeem returns nothing.
     * @param pairId The pair
     * @param parts Parts to split the swap into, 1 to `maxParts`
     * @custom:event Emits RoundStarted, and RoundFeeCollected when the fee is not zero.
     */
    function startRound(uint32 pairId, uint8 parts) external;

    /**
     * @notice Swaps the next part of the running round through SwapHelper.
     * @dev Each part sells an even share of what is left, `stableToSwap / parts left`, so the last part sells the
     *      rest. The swap must return at least `quotedOut` less `maxSlippageBps`, and the whole part must be sold:
     *      no stable may come back to SmartDCA or stay in SwapHelper.
     * @param pairId The pair
     * @param quotedOut Fresh quote for this part's stable, in the asset's decimals, with pool fees already taken;
     *        must not be 0
     * @param swapData `SwapHelper.multicall` calldata built off chain for this part and signed for SmartDCA as the
     *        caller. It must sell the part's stable and send the asset to SmartDCA.
     * @custom:event Emits RoundPartSwapped.
     */
    function swapRoundPart(uint32 pairId, uint256 quotedOut, bytes calldata swapData) external;

    /**
     * @notice Splits the parts left of the running round into `parts` new parts. Allowed once per round.
     * @param pairId The pair
     * @param parts New number of parts left, 1 to `maxParts`
     * @custom:event Emits RoundResplit.
     */
    function resplitRound(uint32 pairId, uint8 parts) external;

    /**
     * @notice Settles the running round once every part is swapped: supplies what it bought to the pair's asset
     *         source and moves the pair's indexes, which credits every plan in the round.
     * @dev Reverts while the asset's source refuses the deposit (a Core supply cap or a mint pause); the keeper
     *      retries until it goes through. Rounds with nothing to buy that are already past their lock time are
     *      settled right after.
     * @param pairId The pair
     * @custom:event Emits RoundSettled.
     */
    function settleRound(uint32 pairId) external;

    /**
     * @notice Runs one part of the pair's round without the keeper or the backend: starts the round if needed, swaps
     *         the next part on the pair's PancakeSwap V3 route, and settles the round after its last part.
     * @dev Callable from the round's lock time until it settles; before the lock it reverts with `RoundNotStarted`.
     *      For a crisis such as the keeper or the backend being down. The swap needs no signed route:
     *      it approves only the part's stable, calls the router's `exactInput`, and reverts if the asset that arrived
     *      is below the oracle value of the part less `fallbackSlippageBps`. `parts = 1` runs the whole round in one
     *      call; a large round takes more parts so the pool can recover between them. The keeper can keep running
     *      the same round, since both share its part count, and a round whose parts are all swapped only settles.
     *      TBD with the team: PancakeSwap V3 SwapRouter as the router, and the 0.5% default.
     * @param pairId The pair
     * @param parts Parts to split the round into, 1 to `maxParts`; ignored once the round has started
     * @custom:access Controlled by AccessControlManager (Guardian and Normal Timelock)
     * @custom:event Emits RoundStarted on the first part, RoundPartSwapped, and RoundSettled after the last part.
     */
    function forceBuy(uint32 pairId, uint8 parts) external;

    /**
     * @notice Settles the pair's rounds with nothing to buy, and emits `RoundLocked` once the next round is locked.
     *         Callable by anyone.
     * @param pairId The pair
     * @custom:event Emits RoundSettled for each empty round, and RoundLocked once per round.
     */
    function syncPair(uint32 pairId) external;

    /**
     * @notice Claims XVS rewards on `vTokens` and sends them to the Reserve. Callable by anyone.
     * @param vTokens Core markets to claim in
     * @custom:event Emits RewardsClaimed.
     */
    function claimRewards(address[] calldata vTokens) external;

    /**
     * @notice Sets the fee rate on the interest part of each buy and cancel.
     * @param newFeeRateBps New rate in basis points, up to `maxFeeRateBps`
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits FeeRateUpdated.
     */
    function setFeeRate(uint16 newFeeRateBps) external;

    /**
     * @notice Sets the cap on the fee rate.
     * @param newMaxFeeRateBps New cap in basis points, up to 10,000 (100%) and not below the current fee rate
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MaxFeeRateUpdated.
     */
    function setMaxFeeRate(uint16 newMaxFeeRateBps) external;

    /**
     * @notice Sets how far below the keeper's quote a swap can return.
     * @param newMaxSlippageBps New bound in basis points, up to `MAX_SLIPPAGE_BPS`
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MaxSlippageUpdated.
     */
    function setMaxSlippage(uint16 newMaxSlippageBps) external;

    /**
     * @notice Sets the most parts a round can be split into.
     * @param newMaxParts New value, 1 to `MAX_PARTS`
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MaxPartsUpdated.
     */
    function setMaxParts(uint8 newMaxParts) external;

    /**
     * @notice Pauses every user and round call. Views and admin setters keep working.
     * @custom:access Controlled by AccessControlManager
     */
    function pause() external;

    /**
     * @notice Sets where one side of a pair waits and earns, and moves that pair side's holdings there in the same
     *         call. Other pairs with the same token keep their own source.
     * @dev Plans hold units, and the move keeps the number of units, so no plan changes. Reverts while the pair is
     *      past its lock time and not settled.
     * @param pairId The pair
     * @param side Stable or Asset
     * @param kind Hub or Core
     * @param source A Hub registered in the Hub registry for the side's token, or a Core vToken listed in the
     *        Comptroller whose underlying is that token
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits YieldSourceUpdated.
     */
    function setYieldSource(uint32 pairId, Side side, SourceKind kind, address source) external;

    /**
     * @notice Adds or removes a keeper. Keepers run rounds from the lock time.
     * @param account The keeper
     * @param allowed True to add, false to remove
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits KeeperUpdated.
     */
    function setKeeper(address account, bool allowed) external;

    /**
     * @notice Sets the least stable amount per buy for a stable. A plan of `n` buys needs at least `n` times this.
     * @dev Must be set before the stable's first pair is added.
     * @param stable The stable
     * @param newAmount New minimum in the stable's decimals, above 0
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits MinAmountPerBuyUpdated.
     */
    function setMinAmountPerBuy(address stable, uint256 newAmount) external;

    /**
     * @notice Sets the fewest and most buys a new plan can have. Existing plans do not change.
     * @param newMinBuys Fewest buys, above 0
     * @param newMaxBuys Most buys, at least `newMinBuys` and up to `MAX_BUYS`
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits BuyBoundsUpdated.
     */
    function setBuyBounds(uint8 newMinBuys, uint8 newMaxBuys) external;

    /**
     * @notice Adds a pair with the yield source of each side. Its first round is the next one to lock.
     * @dev Both tokens need a price in the oracle, and the stable a `minAmountPerBuy`. Each source is checked as in
     *      `setYieldSource`.
     * @param stable Token sold
     * @param asset Token bought
     * @param stableKind Kind of the stable's source, Hub or Core
     * @param stableSource Where the stable waits, a Liquidity Hub at launch
     * @param assetKind Kind of the asset's source, Hub or Core
     * @param assetSource Where the asset bought is held, a Core vToken at launch
     * @return pairId The new pair
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits PairAdded, then YieldSourceUpdated for each side.
     */
    function addPair(
        address stable,
        address asset,
        SourceKind stableKind,
        address stableSource,
        SourceKind assetKind,
        address assetSource
    ) external returns (uint32 pairId);

    /**
     * @notice Enables or disables new plans and top ups on a pair. Running plans keep buying either way.
     * @param pairId The pair
     * @param enabled True to allow new plans and top ups
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits PairEnabledUpdated.
     */
    function setPairEnabled(uint32 pairId, bool enabled) external;

    /**
     * @notice Unpauses user and round calls.
     * @custom:access Controlled by AccessControlManager
     */
    function unpause() external;

    /**
     * @notice Sends `to` the balance of `token` that is not owed to plans or running rounds.
     * @dev Owed is the source shares held for plans, and the stable or asset a running round holds between
     *      `startRound` and `settleRound`.
     * @param token The token
     * @param to Receiver
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits TokenSwept.
     */
    function sweepToken(address token, address to) external;

    /**
     * @notice Sets the route `forceBuy` swaps a pair on.
     * @dev Not checked against the pair's tokens: a path that does not start with the stable cannot pull it, and one
     *      that does not end with the asset adds nothing to SmartDCA's asset balance, so the swap reverts either way.
     * @param pairId The pair
     * @param router PancakeSwap V3 SwapRouter, zero to remove the route
     * @param path Packed pool path from the stable to the asset, for example `abi.encodePacked(USDT, 500, BTCB)`
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits FallbackRouteUpdated.
     */
    function setFallbackRoute(uint32 pairId, address router, bytes calldata path) external;

    /**
     * @notice Sets how far below the oracle price a `forceBuy` swap can return.
     * @param newSlippageBps New bound in basis points, up to `MAX_SLIPPAGE_BPS`
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits FallbackSlippageUpdated.
     */
    function setFallbackSlippage(uint16 newSlippageBps) external;

    /**
     * @notice Sets the gap between buys, for every pair.
     * @dev Each pair's next lock time is already stored, so it does not move. The new gap applies from that lock
     *      time on.
     * @param intervalDays New gap in whole days, from `MIN_BUY_INTERVAL_DAYS` to `MAX_BUY_INTERVAL_DAYS`. Whole days
     *        keep a round started on time at 00:00 UTC+8.
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits BuyIntervalUpdated.
     */
    function setBuyInterval(uint16 intervalDays) external;

    /**
     * @notice Sets the address that receives fees and rewards.
     * @param newReserve New Reserve
     * @custom:access Controlled by AccessControlManager
     * @custom:event Emits ReserveUpdated.
     */
    function setReserve(address newReserve) external;

    /**
     * @notice Lock time of the pair's next round.
     * @param pairId The pair
     * @return Unix timestamp; the 15th at 00:00 UTC+8 for a pair's first round, then the lock time of the round
     *         before plus `buyInterval`
     */
    function nextLockTime(uint32 pairId) external view returns (uint256);

    /**
     * @notice Ids of the plans `owner` holds.
     * @param owner The owner
     * @return Plan ids, including cancelled and claimed plans; a transfer changes their order
     */
    function getPlanIds(address owner) external view returns (uint256[] memory);
}
