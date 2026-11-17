// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

/**
 * @title ISmartDCA
 * @author Venus
 * @notice Types, events, errors and external functions of SmartDCA
 * @dev Terms used below:
 *      - unit: a share of SmartDCA's pooled holdings of one token in its yield source. Interest raises the value
 *        of a unit, not the number of units.
 *      - slice: stable units a plan sells per buy, `units / buys`.
 *      - base (B): stable a plan puts into each buy, `amount / buys`. The fee is only taken on what a buy
 *        redeems above its base.
 *      - round: one monthly buy of a pair. It locks on the 15th at 00:00 UTC+8.
 */
interface ISmartDCA {
    /// @notice Where a token waits and earns
    enum SourceKind {
        None,
        Hub,
        Core
    }

    /// @notice Stored plan status. Matured is computed: Active with every buy settled.
    enum PlanStatus {
        None,
        Active,
        Cancelled,
        Done
    }

    /// @notice Yield source of a token
    /// @param kind Hub or Core
    /// @param source The Hub, or the Core vToken
    /// @param shares Source shares SmartDCA holds for this token, counted in storage so donations are ignored
    /// @param units Units owed to plans and rounds
    struct Source {
        SourceKind kind;
        address source;
        uint256 shares;
        uint256 units;
    }

    /// @notice A stable to asset pair
    /// @param stable Token sold
    /// @param asset Token bought
    /// @param enabled False stops new plans and top ups
    /// @param lastSettledRound Last settled round. The pair buys round `lastSettledRound + 1` next.
    /// @param lockEnteredRound Last round `LockEntered` was emitted for
    /// @param dueUnits Sum of the slices in the next round
    /// @param dueBase Sum of the bases in the next round
    /// @param cumIndex Bought units per stable unit of slice since the pair was added, scaled 1e36
    /// @param cumBaseIndex Bought units per unit of base since the pair was added, scaled 1e36
    struct Pair {
        address stable;
        address asset;
        bool enabled;
        uint32 lastSettledRound;
        uint32 lockEnteredRound;
        uint256 dueUnits;
        uint256 dueBase;
        uint256 cumIndex;
        uint256 cumBaseIndex;
    }

    /// @notice One round of a pair
    /// @param partsTotal Parts the round is split into; 0 until `startBuy`
    /// @param partsDone Parts swapped
    /// @param resplitUsed Whether `resplit` was called
    /// @param feeRate Fee rate charged at `startBuy`, 0 when there was no interest
    /// @param stableOut Stable received for the round's units
    /// @param net `stableOut - fee`, the sum of every plan's pending amount
    /// @param toSwap Part of `net` not swapped yet
    /// @param amountOut Asset bought so far
    /// @param sliceStarting Slices of plans that join the pair after this round settles
    /// @param baseStarting Bases of those plans
    /// @param sliceEnding Slices of plans whose last buy is this round
    /// @param baseEnding Bases of those plans
    /// @param cumIndexAfter `Pair.cumIndex` once this round settled
    /// @param cumBaseIndexAfter `Pair.cumBaseIndex` once this round settled
    struct Round {
        uint8 partsTotal;
        uint8 partsDone;
        bool resplitUsed;
        uint16 feeRate;
        uint256 stableOut;
        uint256 net;
        uint256 toSwap;
        uint256 amountOut;
        uint256 sliceStarting;
        uint256 baseStarting;
        uint256 sliceEnding;
        uint256 baseEnding;
        uint256 cumIndexAfter;
        uint256 cumBaseIndexAfter;
    }

    /// @notice A plan. Round calls never write it; its progress is read from the pair and round records.
    /// @dev A top up restarts the schedule: what was bought so far moves to `carriedBought`, and `firstRound`,
    ///      `buys`, `stableUnits`, `slice` and `base` describe the buys still left.
    /// @param owner Plan owner
    /// @param pairId Pair the plan buys on
    /// @param status Stored status
    /// @param buys Buys in the current schedule
    /// @param buysDone Buys settled before the current schedule
    /// @param firstRound First round of the current schedule
    /// @param stableUnits Stable units at the start of the current schedule
    /// @param slice Stable units sold per buy
    /// @param base Stable put into each buy (B)
    /// @param carriedBought Asset units bought before the current schedule
    /// @param withdrawnBought Asset units paid out
    struct Plan {
        address owner;
        uint32 pairId;
        PlanStatus status;
        uint8 buys;
        uint8 buysDone;
        uint32 firstRound;
        uint256 stableUnits;
        uint256 slice;
        uint256 base;
        uint256 carriedBought;
        uint256 withdrawnBought;
    }

    /// @notice Emitted when a plan is created
    /// @param planId The new plan
    /// @param owner Owner of the plan
    /// @param pairId Pair the plan buys on
    /// @param amount Stable received
    /// @param units Stable units minted for `amount`
    /// @param slice Stable units sold per buy
    /// @param base Stable put into each buy
    /// @param buys Number of buys
    /// @param firstRound First round the plan buys in
    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        uint32 indexed pairId,
        uint256 amount,
        uint256 units,
        uint256 slice,
        uint256 base,
        uint8 buys,
        uint32 firstRound
    );

    /// @notice Emitted when a plan is topped up; the schedule restarts with `buysLeft` buys
    /// @param planId The plan
    /// @param amount Stable received
    /// @param units Stable units minted for `amount`
    /// @param slice New stable units sold per buy
    /// @param base New stable put into each buy
    /// @param buysLeft Buys in the restarted schedule
    event PlanToppedUp(
        uint256 indexed planId,
        uint256 amount,
        uint256 units,
        uint256 slice,
        uint256 base,
        uint8 buysLeft
    );

    /// @notice Emitted when bought asset is withdrawn
    /// @param planId The plan
    /// @param units Asset units taken from the pool
    /// @param amountOut Asset paid to the owner
    event BoughtWithdrawn(uint256 indexed planId, uint256 units, uint256 amountOut);

    /// @notice Emitted when a plan is cancelled
    /// @param planId The plan
    /// @param stableOut Stable paid to the owner, after `fee`
    /// @param fee Fee sent to the Reserve
    /// @param assetOut Bought asset paid to the owner
    event PlanCancelled(uint256 indexed planId, uint256 stableOut, uint256 fee, uint256 assetOut);

    /// @notice Emitted when a matured plan is claimed
    /// @param planId The plan
    /// @param toCore True when paid as vTokens, false when paid as the asset
    /// @param amountOut vTokens or asset paid to the owner
    event PlanClaimed(uint256 indexed planId, bool toCore, uint256 amountOut);

    /// @notice Emitted once per round, by the first `sync`, `createPlan`, `claim` or `startBuy` from the pair's lock time
    /// @param pairId The pair
    /// @param round The round that entered its lock
    event LockEntered(uint32 indexed pairId, uint32 indexed round);

    /// @notice Emitted when a round redeems its stable
    /// @param pairId The pair
    /// @param round The round
    /// @param parts Parts the round is split into
    /// @param dueUnits Stable units redeemed
    /// @param stableOut Stable received
    /// @param net Stable left to swap after the fee
    event BuyStarted(
        uint32 indexed pairId,
        uint32 indexed round,
        uint8 parts,
        uint256 dueUnits,
        uint256 stableOut,
        uint256 net
    );

    /// @notice Emitted for each swapped part of a round
    /// @param pairId The pair
    /// @param round The round
    /// @param part Number of the part, from 1
    /// @param amountIn Stable sold
    /// @param amountOut Asset received
    /// @param quotedOut Asset the keeper's quote promised for `amountIn`
    /// @param minOut Least asset allowed: `quotedOut` less `maxSlippage`
    event OrderExecuted(
        uint32 indexed pairId,
        uint32 indexed round,
        uint8 part,
        uint256 amountIn,
        uint256 amountOut,
        uint256 quotedOut,
        uint256 minOut
    );

    /// @notice Emitted when the parts left of a round are split again
    /// @param pairId The pair
    /// @param round The round
    /// @param partsDone Parts already swapped
    /// @param newParts Parts the rest is split into
    event OrderResplit(uint32 indexed pairId, uint32 indexed round, uint8 partsDone, uint8 newParts);

    /// @notice Emitted when a round settles; an empty round settles with all amounts 0
    /// @param pairId The pair
    /// @param round The round
    /// @param stableOut Stable the round redeemed
    /// @param fee Fee the round took
    /// @param amountOut Asset the round bought
    /// @param boughtUnits Asset units minted for the round
    /// @param cumIndex Pair slice index after the round
    /// @param cumBaseIndex Pair base index after the round
    event PairSettled(
        uint32 indexed pairId,
        uint32 indexed round,
        uint256 stableOut,
        uint256 fee,
        uint256 amountOut,
        uint256 boughtUnits,
        uint256 cumIndex,
        uint256 cumBaseIndex
    );

    /// @notice Emitted when a fee goes to the Reserve
    /// @param pairId The pair
    /// @param planId 0 for a round fee, the plan for a cancel fee
    /// @param amount Fee sent
    event FeeCollected(uint32 indexed pairId, uint256 indexed planId, uint256 amount);

    /// @notice Emitted when XVS rewards are claimed and sent to the Reserve
    /// @param amount XVS sent
    event RewardsClaimed(uint256 amount);

    /// @notice Emitted when governance adds a pair
    /// @param pairId The new pair
    /// @param stable Token sold
    /// @param asset Token bought
    event PairAdded(uint32 indexed pairId, address indexed stable, address indexed asset);

    /// @notice Emitted when a pair is enabled or disabled
    /// @param pairId The pair
    /// @param enabled True when new plans and top ups are allowed
    event PairEnabledUpdated(uint32 indexed pairId, bool enabled);

    /// @notice Emitted when a token's yield source is set
    /// @param token The token
    /// @param oldSource Previous source, 0 when none
    /// @param kind Kind of the new source
    /// @param newSource New source
    /// @param migratedAmount Token moved from the old source to the new one
    event YieldSourceUpdated(
        address indexed token,
        address oldSource,
        SourceKind kind,
        address newSource,
        uint256 migratedAmount
    );

    /// @notice Emitted when the fee rate changes
    /// @param oldFeeRate Previous rate, in basis points
    /// @param newFeeRate New rate, in basis points
    event FeeRateUpdated(uint16 oldFeeRate, uint16 newFeeRate);

    /// @notice Emitted when the fee rate cap changes
    /// @param oldMaxFeeRate Previous cap, in basis points
    /// @param newMaxFeeRate New cap, in basis points
    event MaxFeeRateUpdated(uint16 oldMaxFeeRate, uint16 newMaxFeeRate);

    /// @notice Emitted when the slippage bound changes
    /// @param oldMaxSlippage Previous bound, in basis points
    /// @param newMaxSlippage New bound, in basis points
    event MaxSlippageUpdated(uint16 oldMaxSlippage, uint16 newMaxSlippage);

    /// @notice Emitted when the most parts per round changes
    /// @param oldMaxSplitN Previous value
    /// @param newMaxSplitN New value
    event MaxSplitNUpdated(uint8 oldMaxSplitN, uint8 newMaxSplitN);

    /// @notice Emitted when the backup delay changes
    /// @param oldDelay Previous delay, in seconds
    /// @param newDelay New delay, in seconds
    event BackupDelayUpdated(uint32 oldDelay, uint32 newDelay);

    /// @notice Emitted when a stable's minimum per buy changes
    /// @param stable The stable
    /// @param oldAmount Previous minimum
    /// @param newAmount New minimum
    event MinPerBuyUpdated(address indexed stable, uint256 oldAmount, uint256 newAmount);

    /// @notice Emitted when the allowed number of buys changes
    /// @param oldMinBuys Previous fewest buys
    /// @param oldMaxBuys Previous most buys
    /// @param newMinBuys New fewest buys
    /// @param newMaxBuys New most buys
    event BuyBoundsUpdated(uint8 oldMinBuys, uint8 oldMaxBuys, uint8 newMinBuys, uint8 newMaxBuys);

    /// @notice Emitted when a keeper is added or removed
    /// @param account The keeper
    /// @param allowed True when added
    event KeeperUpdated(address indexed account, bool allowed);

    /// @notice Emitted when a backup address is added or removed
    /// @param account The backup address
    /// @param allowed True when added
    event BackupUpdated(address indexed account, bool allowed);

    /// @notice Emitted when the Reserve address changes
    /// @param oldReserve Previous Reserve
    /// @param newReserve New Reserve
    event ReserveUpdated(address oldReserve, address newReserve);

    /// @notice Emitted when tokens not owed to plans or rounds are swept
    /// @param token The token
    /// @param to Receiver
    /// @param amount Amount sent
    event TokenSwept(address indexed token, address indexed to, uint256 amount);

    /// @notice Thrown when an address argument is zero
    error ZeroAddress();

    /// @notice Thrown when an amount is zero, or a round or withdraw would move nothing
    error ZeroAmount();

    /// @notice Thrown for an unknown pair id, or a pair whose tokens are the same
    error InvalidPair();

    /// @notice Thrown when creating or topping up a plan on a disabled pair
    error PairDisabled();

    /// @notice Thrown when adding a pair that already exists
    error PairExists();

    /// @notice Thrown when the call to SwapHelper reverts
    error TokenSwapCallFailed();

    /// @notice Thrown when a token has no yield source
    /// @param token The token
    error NoYieldSource(address token);

    /// @notice Thrown when a yield source is not a registered Hub or listed vToken of the token, or is unchanged
    error InvalidSource();

    /// @notice Thrown when moving a token's source while a pair using it is past its lock time
    /// @param token The token
    error TokenLocked(address token);

    /// @notice Thrown when a keeper calls a round function before the pair's lock time
    error PairNotLocked();

    /// @notice Thrown when a round function needs a started round and there is none
    error PairNotExecuting();

    /// @notice Thrown when `startBuy` is called twice for a round
    error BuyAlreadyStarted();

    /// @notice Thrown when a round function is called by an address that is neither keeper nor backup
    error NotAllowedCaller();

    /// @notice Thrown when a backup address calls before the lock time plus `backupDelay`
    error BackupTooEarly();

    /// @notice Thrown when parts are 0 or above `maxSplitN`
    error InvalidParts();

    /// @notice Thrown when every part of the round is already swapped
    error NoPartsLeft();

    /// @notice Thrown when settling a round with parts left to swap
    error PartsLeft();

    /// @notice Thrown when a round is resplit a second time
    error AlreadyResplit();

    /// @notice Thrown when a swap returns less than the quote less `maxSlippage`
    /// @param amountOut Asset received
    /// @param minOut Least asset the bound allowed
    error SlippageExceeded(uint256 amountOut, uint256 minOut);

    /// @notice Thrown when the number of buys is outside `minBuys` to `maxBuys`
    error InvalidBuys();

    /// @notice Thrown when a deposit is under `minPerBuy` per buy, or too small to fill a slice
    error DepositTooSmall();

    /// @notice Thrown when the caller does not own the plan
    error NotPlanOwner();

    /// @notice Thrown when the plan is cancelled, claimed or unknown
    error PlanNotActive();

    /// @notice Thrown when the plan is in a round past its lock time that has not settled
    error PlanInRunningRound();

    /// @notice Thrown when topping up or cancelling a plan whose buys have all settled
    error PlanMatured();

    /// @notice Thrown when claiming a plan with buys still to settle
    error PlanNotMatured();

    /// @notice Thrown when withdrawing more than the plan has bought
    error InsufficientBought();

    /// @notice Thrown when claiming to Core while the asset is not held in Core
    error NotCoreSource();

    /// @notice Thrown when a Core vToken returns a non-zero error code
    /// @param source The vToken
    /// @param errorCode The code it returned
    error SourceCallFailed(address source, uint256 errorCode);

    /// @notice Thrown when a parameter is above its hard cap
    error AboveHardCap();

    /// @notice Thrown when a parameter is out of its allowed range
    error InvalidParameter();

    /**
     * @notice Deposits `amount` of the pair's stable and starts a plan of `buys` monthly buys. Before the
     *         pair's open round locks the plan joins it, from the lock the round after it.
     * @param pairId Pair to buy on
     * @param amount Stable to deposit
     * @param buys Number of monthly buys
     * @return planId The new plan
     */
    function createPlan(uint32 pairId, uint256 amount, uint8 buys) external returns (uint256 planId);

    /// @notice Adds stable to a plan and spreads it over the buys left; not while the plan is in a running round
    /// @param planId The plan
    /// @param amount Stable to add
    function topUp(uint256 planId, uint256 amount) external;

    /// @notice Pays out `amount` of the bought asset, or all of it with `type(uint256).max`. Allowed during the
    ///         lock too; a running round's buy counts only once it settles.
    /// @param planId The plan
    /// @param amount Asset to withdraw
    function withdrawBought(uint256 planId, uint256 amount) external;

    /// @notice Ends a plan: pays back the stable still waiting, less the fee on its interest, and the bought asset
    /// @param planId The plan
    function cancel(uint256 planId) external;

    /// @notice Pays out a plan whose buys have all settled
    /// @param planId The plan
    /// @param toCore True to pay as vTokens, false to pay as the asset
    function claim(uint256 planId, bool toCore) external;

    /// @notice Redeems the round's stable and takes the fee; settles empty rounds first, and returns with nothing
    ///         done when the next round is then not locked yet. Keepers from the lock time, backup addresses from
    ///         the lock time plus `backupDelay`.
    /// @param pairId The pair
    /// @param parts Parts to split the round into, 1 to `maxSplitN`
    function startBuy(uint32 pairId, uint8 parts) external;

    /// @notice Swaps the next part of the round through SwapHelper; it must return at least `quotedOut` less
    ///         `maxSlippage`
    /// @param pairId The pair
    /// @param quotedOut Fresh aggregator quote for this part's stable, fees already taken; must not be 0
    /// @param swapData `SwapHelper.multicall` calldata built off chain for this part, signed for SmartDCA as the
    ///        caller; it must swap the part's stable and send the asset to SmartDCA
    function executeOrder(uint32 pairId, uint256 quotedOut, bytes calldata swapData) external;

    /// @notice Splits the parts left into `parts` new parts; once per round
    /// @param pairId The pair
    /// @param parts New number of parts left, 1 to `maxSplitN`
    function resplit(uint32 pairId, uint8 parts) external;

    /// @notice Supplies what the round bought and moves the pair's indexes
    /// @param pairId The pair
    function settle(uint32 pairId) external;

    /// @notice Settles empty rounds and emits `LockEntered`; callable by anyone
    /// @param pairId The pair
    function sync(uint32 pairId) external;

    /// @notice Claims XVS rewards on `vTokens` and sends them to the Reserve; callable by anyone
    /// @param vTokens Markets to claim in
    function claimRewards(address[] calldata vTokens) external;

    /// @notice Sets the fee rate on interest, up to `maxFeeRate`
    /// @param bps New rate, in basis points
    function setFeeRate(uint16 bps) external;

    /// @notice Sets the fee rate cap, up to 100% and not below the current fee rate
    /// @param bps New cap, in basis points
    function setMaxFeeRate(uint16 bps) external;

    /// @notice Sets the slippage bound, up to `MAX_SLIPPAGE`
    /// @param bps New bound, in basis points
    function setMaxSlippage(uint16 bps) external;

    /// @notice Sets the most parts a round can be split into
    /// @param n New value, 1 to `MAX_SPLIT_N`
    function setMaxSplitN(uint8 n) external;

    /// @notice Adds or removes a backup address
    /// @param account The backup address
    /// @param allowed True to add, false to remove
    function setBackup(address account, bool allowed) external;

    /// @notice Pauses user and round calls
    function pause() external;

    /// @notice Sets where `token` waits and earns, moving its current holdings there; plans do not change
    /// @param token The token
    /// @param kind Hub or Core
    /// @param source A registered Hub or a listed Core vToken of `token`
    function setYieldSource(address token, SourceKind kind, address source) external;

    /// @notice Adds or removes a keeper
    /// @param account The keeper
    /// @param allowed True to add, false to remove
    function setKeeper(address account, bool allowed) external;

    /// @notice Sets the wait before backup addresses can run a round, up to `MAX_BACKUP_DELAY`
    /// @param delay New delay, in seconds
    function setBackupDelay(uint32 delay) external;

    /// @notice Sets the least stable per buy for a stable; must be set before the stable's first pair
    /// @param stable The stable
    /// @param amount New minimum, above 0
    function setMinPerBuy(address stable, uint256 amount) external;

    /// @notice Sets the fewest and most buys a new plan can have, up to `MAX_BUYS`
    /// @param minBuys Fewest buys, above 0
    /// @param maxBuys Most buys, at least `minBuys`
    function setBuyBounds(uint8 minBuys, uint8 maxBuys) external;

    /// @notice Adds a pair; both tokens need a yield source and an oracle price, the stable a `minPerBuy`
    /// @param stable Token sold
    /// @param asset Token bought
    /// @return pairId The new pair
    function addPair(address stable, address asset) external returns (uint32 pairId);

    /// @notice Enables or disables new plans and top ups on a pair
    /// @param pairId The pair
    /// @param enabled True to allow new plans and top ups
    function setPairEnabled(uint32 pairId, bool enabled) external;

    /// @notice Unpauses user and round calls
    function unpause() external;

    /// @notice Sends `to` the balance of `token` that is not owed to plans or running rounds
    /// @param token The token
    /// @param to Receiver
    function sweepToken(address token, address to) external;

    /// @notice Sets the address that receives fees and rewards
    /// @param reserve New Reserve
    function setReserve(address reserve) external;

    /// @notice Lock time of the pair's next round
    /// @param pairId The pair
    /// @return Timestamp of the lock time
    function lockTime(uint32 pairId) external view returns (uint256);

    /// @notice Plan ids created by `owner`
    /// @param owner The owner
    /// @return Plan ids, oldest first
    function getPlansOf(address owner) external view returns (uint256[] memory);
}
