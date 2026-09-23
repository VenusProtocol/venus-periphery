// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ICollateralGateway
 * @author Venus
 * @notice Supplies into a Liquidity Hub and lands the resulting share tokens in the Hub's Core
 *         market, so one call turns an underlying balance into Core collateral. Also supplies
 *         directly into Spoke Pool markets, enabling each as the caller's collateral in the same
 *         call, and redeems a Core position back to the underlying in one call.
 * @dev A single deployment without a proxy serves every Hub of one Core Comptroller, which is
 *      fixed at construction. The vh market is chosen per call and must be listed by that
 *      Comptroller. The Hub is read off it as `underlying()`, since a Hub share token is what its
 *      market wraps.
 */
interface ICollateralGateway {
    /**
     * @notice Emitted on a completed supply.
     * @param user Caller whose underlying was supplied, and the account credited in Core.
     * @param hub Hub the underlying was deposited into.
     * @param vhMarket Core market the Hub shares were supplied to.
     * @param assets Underlying pulled from `user`.
     * @param shares Hub shares minted and supplied on the user's behalf.
     * @param vTokens Market receipts credited to `user`.
     */
    event SuppliedFromWallet(
        address indexed user,
        address indexed hub,
        address indexed vhMarket,
        uint256 assets,
        uint256 shares,
        uint256 vTokens
    );

    /**
     * @notice Emitted on a completed migration from a Core position.
     * @param user Caller whose Core position was migrated, and the account credited in Core.
     * @param vToken Core market the position was redeemed from.
     * @param hub Hub the underlying was deposited into.
     * @param vhMarket Core market the Hub shares were supplied to.
     * @param vTokenAmount Receipts redeemed from `user`'s position.
     * @param shares Hub shares minted and supplied on the user's behalf.
     * @param vTokens Market receipts credited to `user`.
     */
    event SuppliedFromCollateral(
        address indexed user,
        address indexed vToken,
        address indexed hub,
        address vhMarket,
        uint256 vTokenAmount,
        uint256 shares,
        uint256 vTokens
    );

    /**
     * @notice Emitted on a completed supply into a Spoke Pool market.
     * @param user Caller whose underlying was supplied, and the account credited and entered.
     * @param vToken Spoke market the underlying was supplied to.
     * @param assets Underlying that reached the market, after any transfer fee.
     * @param vTokens Market receipts credited to `user`.
     */
    event SuppliedToSpoke(address indexed user, address indexed vToken, uint256 assets, uint256 vTokens);

    /**
     * @notice Emitted on a completed withdraw back to the caller's wallet.
     * @param user Caller whose position was redeemed, and the account paid.
     * @param hub Hub the shares were redeemed from.
     * @param vhMarket Core market the Core portion was freed from.
     * @param walletShares Shares pulled from the caller's wallet.
     * @param freedShares Shares freed out of the Core market.
     * @param assets Underlying paid to the caller.
     */
    event PositionWithdrawn(
        address indexed user,
        address indexed hub,
        address indexed vhMarket,
        uint256 walletShares,
        uint256 freedShares,
        uint256 assets
    );

    /// @notice A required address argument was the zero address.
    error ZeroAddress();

    /// @notice A required amount argument was zero.
    error ZeroAmount();

    /// @notice A Core or Spoke market returned a non-zero (failure) error code on mint.
    error VTokenMintFailed(address market, uint256 errorCode);

    /// @notice The mint credited no receipts to the user.
    error NothingMinted();

    /// @notice The minted shares were below the caller's `minShares` floor.
    error InsufficientShares(uint256 shares, uint256 minShares);

    /// @notice The vToken's underlying does not match the Hub's asset.
    error AssetMismatch(address vTokenUnderlying, address hubAsset);

    /// @notice The Core market returned a non-zero (failure) error code on redeem.
    error VTokenRedeemFailed(address vToken, uint256 errorCode);

    /// @notice The redeem produced no underlying to deposit.
    error NothingReceived();

    /// @notice The Comptroller refused to enable `vhMarket` as the caller's collateral.
    error EnterMarketFailed(address vhMarket, uint256 errorCode);

    /// @notice The flash-loan callback was invoked outside a migration, by a caller other than the
    ///         Comptroller that started one, or with arguments other than the ones requested.
    error UnexpectedCallback();

    /// @notice The Comptroller could not price the caller's position.
    error LiquidityCheckFailed(uint256 errorCode);

    /// @notice A market list was empty, or the amounts alongside it were a different length.
    error InvalidArrayLength();

    /// @notice The redeem paid out less than the caller's `minAssets` floor.
    error InsufficientAssets(uint256 assets, uint256 minAssets);

    /// @notice The call ended with less of the underlying in the gateway than it started with.
    error BalanceSpent(uint256 balanceBefore, uint256 balanceAfter);

    /**
     * @notice Emitted when the owner sweeps tokens that were sent to this contract.
     * @param token Token swept.
     * @param recipient Account the balance was sent to.
     * @param amount Amount swept.
     */
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);

    /// @notice The caller holds fewer receipts than the amount they asked to migrate.
    error InsufficientReceipts(uint256 held, uint256 requested);

    /// @notice The market is not listed by its Comptroller: the Core Comptroller this gateway was
    ///         deployed against, or the Spoke market's own pool Comptroller.
    error MarketNotListed(address market);

    /// @notice The Spoke market is not the one its pool registered for its underlying.
    error MarketNotRegistered(address vToken);

    /**
     * @notice Deposit `assets` of the Hub's underlying and supply the resulting shares into
     *         `vhMarket`, crediting the market receipts to the caller.
     * @dev Caller must first `approve` this gateway to transfer `assets` of the Hub's underlying.
     *      The Hub is `vhMarket.underlying()`. The market is enabled as their collateral in the same
     *      call, which needs this gateway to hold the `enterMarketForAccount(address,address)` role
     *      on the Comptroller.
     * @param assets Underlying to pull from the caller and deposit.
     * @param vhMarket Core market wrapping the Hub to deposit into.
     * @param minShares Minimum acceptable Hub shares (slippage guard).
     * @return shares Hub shares minted and supplied to the market.
     *
     * Reverts if `vhMarket` is not listed, if the deposit yields fewer than `minShares`, or
     * if the mint fails. A full supply cap reverts inside the Comptroller, so a capped market
     * fails the whole call and the caller keeps their underlying.
     *
     * The receipts count as collateral immediately, so the supply earns Hub yield and borrow power
     * from the same call. Entering a market also makes the position seizable in a liquidation.
     */
    function supplyFromWallet(uint256 assets, address vhMarket, uint256 minShares) external returns (uint256 shares);

    /**
     * @notice Redeem `vTokenAmount` from an existing Core position, deposit the underlying into
     *         the Hub `vhMarket` wraps, and supply the resulting shares into `vhMarket`, crediting
     *         the market receipts to the caller.
     * @dev Caller must first grant this gateway `Comptroller.updateDelegate(gateway, true)`, which
     *      lets it redeem the position where it sits, so no allowance over `vToken` is needed.
     *      Enabling `vhMarket` as collateral rides on the gateway's own
     *      `enterMarketForAccount(address,address)` role instead.
     * @param vToken Core market to redeem from.
     * @param vTokenAmount Receipts to redeem. `type(uint256).max` means the caller's whole
     *        balance of `vToken`, read at execution time.
     * @param vhMarket Core market wrapping the Hub to deposit into.
     * @param minShares Minimum acceptable Hub shares (slippage guard).
     * @return shares Hub shares minted and supplied to the market.
     *
     * Reverts if either market is not listed, if `vToken.underlying()` is not the Hub's asset, or
     * if the deposit yields fewer than `minShares`.
     *
     * A caller with no borrows, or whose `vToken` is not entered as collateral, migrates directly.
     * A caller whose borrows the remaining position could not cover goes through a Core flash loan
     * instead, which supplies the replacement collateral before the old collateral leaves, so any
     * amount up to the full balance moves. That path additionally requires this gateway to be
     * allow-listed for flash loans.
     *
     * The delegate grant is pool wide: it lets this gateway redeem and borrow against any Core
     * position the caller holds, not only the two markets named here. The caller revokes it with
     * `updateDelegate(gateway, false)`.
     *
     * `minShares` is not comparable between the paths. The direct path deposits the redeem
     * proceeds; the flash-loan path deposits a floor on them and returns the difference to the
     * caller as underlying.
     */
    function supplyFromCollateral(
        address vToken,
        uint256 vTokenAmount,
        address vhMarket,
        uint256 minShares
    ) external returns (uint256 shares);

    /**
     * @notice Redeem `shares` of the Hub `vhMarket` wraps back to the caller's wallet, taking
     *         whatever the caller holds in their wallet first and freeing the rest out of
     *         `vhMarket`.
     * @dev Caller must first `approve` this gateway for their wallet shares, and grant it
     *      `Comptroller.updateDelegate` if any of `shares` has to come out of `vhMarket`.
     * @param vhMarket Core market wrapping the Hub to redeem from.
     * @param shares Hub shares to redeem in total, across both legs. `type(uint256).max` redeems
     *        the whole wallet balance and every `vhMarket` receipt.
     * @param minAssets Minimum acceptable underlying (slippage guard).
     * @return assets Underlying paid to the caller.
     *
     * Wallet first, so a withdraw the wallet covers on its own never touches Core and leaves the
     * caller's borrow position undisturbed. The Core leg redeems on the caller's behalf, so the
     * Comptroller runs its liquidity check against the caller and rejects a redeem that would leave
     * them under water.
     *
     * The delegate grant is pool wide: it lets this gateway redeem and borrow against any Core
     * position the caller holds, not only the vh market. The gateway only ever redeems to itself and
     * pays the caller in the same transaction, but the grant outlives the call and the caller
     * revokes it with `updateDelegate(gateway, false)`.
     *
     * The Core leg frees at most the receipts the caller holds, so a market that cannot free the
     * full amount pays out less rather than reverting. `minAssets` is the floor on that payout.
     */
    function withdrawPosition(address vhMarket, uint256 shares, uint256 minAssets) external returns (uint256 assets);

    /**
     * @notice Send the whole balance of `token` held by this contract to the owner.
     * @dev No leg of this gateway leaves a balance behind, so this only recovers tokens sent here
     *      by mistake. Reverts when the balance is zero.
     * @param token Token to sweep.
     * @custom:access Only the owner.
     * @custom:event Emits TokenSwept.
     */
    function sweepToken(IERC20 token) external;

    /**
     * @notice Supply each of `amounts` into the matching market in `vTokens`, crediting the
     *         receipts to the caller and enabling every market as the caller's collateral.
     * @dev Caller must first `approve` this gateway to transfer each amount of the matching
     *      market's underlying.
     * @param vTokens Spoke markets to supply to.
     * @param amounts Underlying to pull from the caller per market, index-aligned with `vTokens`.
     *
     * Every market is supplied and entered, or the whole call reverts and the caller keeps their
     * underlying. Markets may belong to different Spoke Pools, since each one's Comptroller is
     * read from the market itself.
     *
     * The entering leg calls `SpokeComptroller.enterMarketForAccount`, which is permissioned, so this
     * gateway has to hold the `enterMarketForAccount(address,address)` role on every Comptroller
     * involved. Until governance grants it, this function reverts and users supply and enter in
     * two calls of their own.
     *
     * Reverts unless each market is the one `PoolRegistry` holds for its pool and underlying, and
     * is still listed by its pool's Comptroller.
     */
    function supplyAndEnterSpokeMarkets(address[] calldata vTokens, uint256[] calldata amounts) external;

    /**
     * @notice Enable each market in `vTokens` as the caller's collateral.
     * @param vTokens Spoke markets to enable.
     *
     * For a caller who already holds the receipts, so has nothing left to supply. Entering a
     * market the caller is already in changes nothing rather than reverting.
     *
     * Carries the same role requirement and market checks as {supplyAndEnterSpokeMarkets}.
     */
    function enterSpokeMarkets(address[] calldata vTokens) external;
}
