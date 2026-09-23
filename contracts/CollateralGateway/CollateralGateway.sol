// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IFlashLoanReceiver } from "../Interfaces/IFlashLoanReceiver.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
import { IPoolRegistry } from "../Interfaces/IPoolRegistry.sol";
import { IVToken } from "../Interfaces/IVToken.sol";
import { ICollateralGateway } from "./ICollateralGateway.sol";
import { IHub } from "./IHub.sol";

/**
 * @title CollateralGateway
 * @author Venus
 * @notice Turns an underlying balance into collateral in one call. For Core, deposit into a
 *         Liquidity Hub and supply the resulting Hub shares into that Hub's Core market on the
 *         caller's behalf. For a Spoke Pool, supply the underlying itself and enable the market as
 *         the caller's collateral in the same call. Runs the Core supply in reverse too: a withdraw
 *         redeems wallet shares before it touches the market.
 * @dev No proxy and no funds held between calls. The owner can only sweep tokens sent here by
 *      mistake. Every call is atomic:
 *      a supply pulls the underlying, deposits it, supplies the shares and credits the receipts
 *      straight to the caller, and a withdraw pays the caller in the same call. If any leg fails the
 *      whole call reverts and the caller keeps what they started with.
 *
 *      Redeem and mint amounts are read back from the contracts rather than assumed, because
 *      `redeemBehalf` and `mintBehalf` report only an error code. A supply from the wallet deposits
 *      the amount it pulled, since the underlying of a listed market does not charge a transfer fee.
 *
 *      The vh market is chosen per call and must be listed by the Comptroller this gateway was
 *      deployed against. The Hub is read off it as `vhMarket.underlying()`, since a Hub share
 *      token is exactly what its Core market wraps.
 */
contract CollateralGateway is ICollateralGateway, IFlashLoanReceiver, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 private constant EXP_SCALE = 1e18;

    /// @notice The Isolated Pools registry every Spoke market in a call is checked against.
    IPoolRegistry public immutable POOL_REGISTRY;

    /// @notice The Core Comptroller that every Core function of this gateway runs against.
    IComptroller public immutable COMPTROLLER;

    /// @dev The migration in flight, readable by the flash-loan callback. Written just before
    ///      `supplyFromCollateral` takes a flash loan and dropped with the transaction. A zero
    ///      `_migrationUser` means no migration is in flight.
    address transient _migrationUser;
    address transient _migrationVToken;
    uint256 transient _migrationVTokenAmount;
    address transient _migrationHub;
    address transient _migrationAsset;
    address transient _migrationVhMarket;
    uint256 transient _migrationMinShares;
    uint256 transient _migrationFlashAmount;
    uint256 transient _migrationShares;
    uint256 transient _migrationVTokens;

    /// @param comptroller The Core Comptroller. Reverts on the zero address.
    /// @param poolRegistry The Isolated Pools registry. Reverts on the zero address.
    /// @param owner_ Account that may sweep tokens sent to this contract. Reverts on the zero address.
    constructor(IComptroller comptroller, IPoolRegistry poolRegistry, address owner_) {
        if (address(comptroller) == address(0) || address(poolRegistry) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }

        COMPTROLLER = comptroller;
        POOL_REGISTRY = poolRegistry;
        _transferOwnership(owner_);
    }

    /// @inheritdoc ICollateralGateway
    function supplyFromWallet(
        uint256 assets,
        address vhMarket,
        uint256 minShares
    ) external nonReentrant returns (uint256 shares) {
        if (vhMarket == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();

        _requireListed(vhMarket);

        address hub = IVToken(vhMarket).underlying();
        IERC20 asset = IERC20(IHub(hub).asset());
        asset.safeTransferFrom(msg.sender, address(this), assets);

        _enterCoreMarket(vhMarket);

        uint256 vTokens;
        (shares, vTokens) = _depositAndSupply(hub, address(asset), vhMarket, assets, minShares, msg.sender);

        emit SuppliedFromWallet(msg.sender, hub, vhMarket, assets, shares, vTokens);
    }

    /// @inheritdoc ICollateralGateway
    function supplyFromCollateral(
        address vToken,
        uint256 vTokenAmount,
        address vhMarket,
        uint256 minShares
    ) external nonReentrant returns (uint256 shares) {
        if (vToken == address(0) || vhMarket == address(0)) revert ZeroAddress();
        if (vTokenAmount == 0) revert ZeroAmount();

        _requireListed(vhMarket);
        _requireListed(vToken);

        address hub = IVToken(vhMarket).underlying();
        address asset = IHub(hub).asset();
        {
            address vTokenUnderlying = IVToken(vToken).underlying();
            if (vTokenUnderlying != asset) revert AssetMismatch(vTokenUnderlying, asset);

            uint256 held = IVToken(vToken).balanceOf(msg.sender);
            if (vTokenAmount == type(uint256).max) vTokenAmount = held;
            if (vTokenAmount == 0) revert ZeroAmount();
            if (held < vTokenAmount) revert InsufficientReceipts(held, vTokenAmount);
        }

        uint256 assetBalanceBefore = IERC20(asset).balanceOf(address(this));

        // `redeemBehalf` accrues this market before it runs its own liquidity check, so the check
        // below has to read the accrued state to reach the same answer.
        IVToken(vToken).accrueInterest();

        _enterCoreMarket(vhMarket);

        uint256 vTokens;
        if (_wouldCauseShortfall(vToken, vTokenAmount)) {
            (shares, vTokens) = _migrateViaFlashLoan(vToken, vTokenAmount, hub, asset, vhMarket, minShares);
        } else {
            uint256 assets = _redeemToUnderlying(vToken, vTokenAmount, asset, msg.sender);
            (shares, vTokens) = _depositAndSupply(hub, asset, vhMarket, assets, minShares, msg.sender);
        }

        _requireBalanceKept(asset, assetBalanceBefore);

        emit SuppliedFromCollateral(msg.sender, vToken, hub, vhMarket, vTokenAmount, shares, vTokens);
    }

    /// @inheritdoc ICollateralGateway
    function withdrawPosition(
        address vhMarket,
        uint256 shares,
        uint256 minAssets
    ) external nonReentrant returns (uint256 assets) {
        if (vhMarket == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();

        _requireListed(vhMarket);

        address hub = IVToken(vhMarket).underlying();

        uint256 walletShares = IERC20(hub).balanceOf(msg.sender);
        if (walletShares > shares) walletShares = shares;
        if (walletShares != 0) IERC20(hub).safeTransferFrom(msg.sender, address(this), walletShares);

        uint256 freedShares;
        if (walletShares < shares) freedShares = _freeFromMarket(hub, vhMarket, shares - walletShares);

        assets = IHub(hub).redeem(walletShares + freedShares, msg.sender, address(this));
        if (assets < minAssets) revert InsufficientAssets(assets, minAssets);

        emit PositionWithdrawn(msg.sender, hub, vhMarket, walletShares, freedShares, assets);
    }

    /// @inheritdoc ICollateralGateway
    function supplyAndEnterSpokeMarkets(address[] calldata vTokens, uint256[] calldata amounts) external nonReentrant {
        uint256 len = vTokens.length;
        if (len == 0 || len != amounts.length) revert InvalidArrayLength();

        for (uint256 i; i < len; ++i) {
            _supplyAndEnterSpokeMarket(vTokens[i], amounts[i]);
        }
    }

    /// @inheritdoc ICollateralGateway
    function enterSpokeMarkets(address[] calldata vTokens) external {
        uint256 len = vTokens.length;
        if (len == 0) revert InvalidArrayLength();

        for (uint256 i; i < len; ++i) {
            _enterSpokeMarket(vTokens[i]);
        }
    }

    /// @inheritdoc IFlashLoanReceiver
    /// @dev Not `nonReentrant`: `supplyFromCollateral` already holds that guard when the Comptroller
    ///      calls back, so taking it again would revert. Access is gated instead on a migration being
    ///      in flight and on the arguments matching what {_migrateViaFlashLoan} requested.
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address,
        bytes calldata
    ) external override returns (bool success, uint256[] memory repayAmounts) {
        address user = _migrationUser;
        address vToken = _migrationVToken;
        if (user == address(0) || initiator != address(this)) revert UnexpectedCallback();
        if (msg.sender != address(COMPTROLLER)) revert UnexpectedCallback();
        if (vTokens.length != 1 || amounts.length != 1 || premiums.length != 1) revert UnexpectedCallback();
        if (address(vTokens[0]) != vToken || amounts[0] != _migrationFlashAmount) revert UnexpectedCallback();

        address asset = _migrationAsset;
        (_migrationShares, _migrationVTokens) = _depositAndSupply(
            _migrationHub,
            asset,
            _migrationVhMarket,
            amounts[0],
            _migrationMinShares,
            user
        );

        uint256 proceeds = _redeemToUnderlying(vToken, _migrationVTokenAmount, asset, user);

        repayAmounts = new uint256[](1);
        repayAmounts[0] = amounts[0] + premiums[0];
        IERC20(asset).forceApprove(address(vTokens[0]), repayAmounts[0]);

        // Change is this migration's redeem minus the repayment, not the gateway's balance, so
        // tokens already sitting here, such as a stray transfer awaiting a sweep, never go to a caller.
        if (proceeds > repayAmounts[0]) IERC20(asset).safeTransfer(user, proceeds - repayAmounts[0]);

        return (true, repayAmounts);
    }

    /// @inheritdoc ICollateralGateway
    function sweepToken(IERC20 token) external onlyOwner nonReentrant {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();

        address recipient = owner();
        token.safeTransfer(recipient, balance);

        emit TokenSwept(address(token), recipient, balance);
    }

    /// @dev Reverts when the gateway holds less of `asset` than `balanceBefore`, meaning a market
    ///      or Hub in this migration spent tokens the gateway held before the call.
    function _requireBalanceKept(address asset, uint256 balanceBefore) private view {
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert BalanceSpent(balanceBefore, balanceAfter);
    }

    /// @dev Borrow the position's worth from Core so the replacement collateral exists before the
    ///      old collateral leaves. The rest of the migration runs inside {executeOperation}.
    function _migrateViaFlashLoan(
        address vToken,
        uint256 vTokenAmount,
        address hub,
        address asset,
        address vhMarket,
        uint256 minShares
    ) private returns (uint256 shares, uint256 vTokens) {
        uint256 flashAmount = _flashAmount(vToken, vTokenAmount);

        _migrationUser = msg.sender;
        _migrationVToken = vToken;
        _migrationVTokenAmount = vTokenAmount;
        _migrationHub = hub;
        _migrationAsset = asset;
        _migrationVhMarket = vhMarket;
        _migrationMinShares = minShares;
        _migrationFlashAmount = flashAmount;

        IVToken[] memory markets = new IVToken[](1);
        uint256[] memory amounts = new uint256[](1);
        markets[0] = IVToken(vToken);
        amounts[0] = flashAmount;

        COMPTROLLER.executeFlashLoan(payable(address(this)), payable(address(this)), markets, amounts, "");
        IERC20(asset).forceApprove(vToken, 0);

        shares = _migrationShares;
        vTokens = _migrationVTokens;
        if (vTokens == 0) revert UnexpectedCallback();
    }

    /// @dev Deposit `assets` into `hub` and supply the resulting shares to `vhMarket` for
    ///      `receiver`. Returns the shares minted and the market receipts credited.
    function _depositAndSupply(
        address hub,
        address asset,
        address vhMarket,
        uint256 assets,
        uint256 minShares,
        address receiver
    ) private returns (uint256 shares, uint256 vTokens) {
        IERC20(asset).forceApprove(hub, assets);
        shares = IHub(hub).deposit(assets, address(this));
        IERC20(asset).forceApprove(hub, 0);
        if (shares < minShares) revert InsufficientShares(shares, minShares);

        vTokens = _supplyToMarket(hub, vhMarket, shares, receiver);
    }

    /// @dev Redeem `vTokenAmount` of `from`'s position and take the underlying. Returns the
    ///      underlying received, measured as a balance delta because `redeemBehalf` reports only an
    ///      error code and the Comptroller can net out a treasury fee.
    ///
    ///      `redeemBehalf` burns the receipts where they sit and pays the caller, so the gateway
    ///      needs a delegate grant from `from` rather than an allowance over their receipts.
    function _redeemToUnderlying(
        address vToken,
        uint256 vTokenAmount,
        address asset,
        address from
    ) private returns (uint256 assets) {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        uint256 errorCode = IVToken(vToken).redeemBehalf(from, vTokenAmount);
        if (errorCode != 0) revert VTokenRedeemFailed(vToken, errorCode);

        assets = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (assets == 0) revert NothingReceived();
    }

    /// @dev Supply `amount` of `token` to `market`, crediting the receipts to `receiver`. Returns
    ///      the receipts credited, measured as a balance delta because `mintBehalf` reports only an
    ///      error code.
    function _supplyToMarket(
        address token,
        address market,
        uint256 amount,
        address receiver
    ) private returns (uint256 vTokens) {
        IERC20(token).forceApprove(market, amount);

        uint256 balanceBefore = IVToken(market).balanceOf(receiver);
        uint256 errorCode = IVToken(market).mintBehalf(receiver, amount);
        IERC20(token).forceApprove(market, 0);
        if (errorCode != 0) revert VTokenMintFailed(market, errorCode);

        vTokens = IVToken(market).balanceOf(receiver) - balanceBefore;
        if (vTokens == 0) revert NothingMinted();
    }

    /// @dev Redeem enough of the caller's `vhMarket` position to free `shares` of `hub`. Returns
    ///      the shares actually freed, measured as a balance delta because `redeemBehalf` reports
    ///      only an error code.
    ///
    ///      `shares` worth more than the caller's receipts redeems all of them, so
    ///      `type(uint256).max` empties the position. Otherwise the vToken count is rounded up.
    ///      Rounding up alone would ask for one receipt more than exists on a whole position,
    ///      because the mint that created it rounded down; the market answers that with an
    ///      underflow, not an error code. A capped or fee-charging market frees less than `shares`,
    ///      which surfaces to the caller as a smaller payout rather than a silent shortfall, since
    ///      `minAssets` is checked against the assets the Hub actually pays out.
    function _freeFromMarket(address hub, address vhMarket, uint256 shares) private returns (uint256 freedShares) {
        uint256 rate = IVToken(vhMarket).exchangeRateCurrent();
        uint256 balance = IVToken(vhMarket).balanceOf(msg.sender);

        uint256 vTokens = balance;
        if (shares <= (balance * rate) / EXP_SCALE) vTokens = ((shares * EXP_SCALE) + rate - 1) / rate;

        uint256 balanceBefore = IERC20(hub).balanceOf(address(this));
        uint256 errorCode = IVToken(vhMarket).redeemBehalf(msg.sender, vTokens);
        if (errorCode != 0) revert VTokenRedeemFailed(vhMarket, errorCode);

        freedShares = IERC20(hub).balanceOf(address(this)) - balanceBefore;
        if (freedShares == 0) revert NothingReceived();
    }

    /// @dev Supply `amount` of `vToken`'s underlying for the caller and enable the market as their
    ///      collateral.
    function _supplyAndEnterSpokeMarket(address vToken, uint256 amount) private {
        if (vToken == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        IILComptroller comptroller = _requireSpokeMarket(vToken);
        IERC20 underlying = IERC20(IVToken(vToken).underlying());

        // Pull first, then measure, so the market is only ever asked to mint what the gateway holds.
        uint256 balanceBefore = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = underlying.balanceOf(address(this)) - balanceBefore;

        uint256 vTokens = _supplyToMarket(address(underlying), vToken, received, msg.sender);
        comptroller.enterMarketForAccount(msg.sender, vToken);

        emit SuppliedToSpoke(msg.sender, vToken, received, vTokens);
    }

    /// @dev Enable `vToken` as collateral for the caller. Reverts unless this gateway holds the
    ///      `enterMarketForAccount(address,address)` role on the market's Comptroller.
    function _enterSpokeMarket(address vToken) private {
        _requireSpokeMarket(vToken).enterMarketForAccount(msg.sender, vToken);
    }

    /// @dev Reverts unless `vToken` is the market its own pool registered for its own underlying,
    ///      and is still listed there. Returns that pool's Comptroller.
    ///
    ///      The registry is the only address here this gateway trusts, so it is what makes the rest
    ///      of the answer mean anything: a market that names its own Comptroller would otherwise be
    ///      vouching for itself. The listing check is separate because the registry keeps an entry
    ///      after `unlistMarket`.
    function _requireSpokeMarket(address vToken) private view returns (IILComptroller comptroller) {
        comptroller = IILComptroller(address(IVToken(vToken).comptroller()));

        address registered = POOL_REGISTRY.getVTokenForAsset(address(comptroller), IVToken(vToken).underlying());
        if (registered != vToken) revert MarketNotRegistered(vToken);
        if (!comptroller.markets(vToken).isListed) revert MarketNotListed(vToken);
    }

    /// @dev Reverts unless `market` is a market of {COMPTROLLER}. Everything else on the Core path
    ///      is read off the markets named in the call: the hub is `vhMarket.underlying()` and the
    ///      asset is the hub's, so an unlisted market would leave all three caller-chosen.
    function _requireListed(address market) private view {
        (bool isListed, , ) = COMPTROLLER.markets(market);
        if (!isListed) revert MarketNotListed(market);
    }

    /// @dev Enable `vhMarket` as the caller's collateral, so a supplied position counts from the
    ///      moment it is minted. Reverts unless this gateway holds the
    ///      `enterMarketForAccount(address,address)` role on the market's Comptroller.
    function _enterCoreMarket(address vhMarket) private {
        uint256 errorCode = COMPTROLLER.enterMarketForAccount(msg.sender, vhMarket);
        if (errorCode != 0) revert EnterMarketFailed(vhMarket, errorCode);
    }

    /// @dev True when removing `vTokenAmount` would leave the caller under water. Asks the
    ///      Comptroller the same question the redeem will ask, so a market the caller never entered
    ///      is always false: it backs no borrow, and the redeem skips the liquidity check for it.
    function _wouldCauseShortfall(address vToken, uint256 vTokenAmount) private view returns (bool) {
        if (!COMPTROLLER.checkMembership(msg.sender, IVToken(vToken))) return false;

        (uint256 errorCode, , uint256 shortfall) = COMPTROLLER.getHypotheticalAccountLiquidity(
            msg.sender,
            vToken,
            vTokenAmount,
            0
        );

        if (errorCode != 0) revert LiquidityCheckFailed(errorCode);
        return shortfall != 0;
    }

    /// @dev How much to borrow so that the loan plus its flash-loan fee is covered by what the
    ///      redeem of `vTokenAmount` pays out.
    ///
    ///      Every input moves in the gateway's favour. The stored exchange rate is read after the
    ///      entry point accrued the market, the Comptroller's redeem fee is subtracted here exactly
    ///      as the market subtracts it, and the loan is scaled down by the market's flash-loan fee,
    ///      which the market then charges on the smaller principal. So the redeem inside the
    ///      callback always covers the repayment.
    function _flashAmount(address vToken, uint256 vTokenAmount) private view returns (uint256) {
        uint256 redeemable = (vTokenAmount * IVToken(vToken).exchangeRateStored()) / EXP_SCALE;

        uint256 redeemFee = COMPTROLLER.treasuryPercent();
        if (redeemFee != 0) redeemable -= (redeemable * redeemFee) / EXP_SCALE;

        uint256 flashFee = IVToken(vToken).flashLoanFeeMantissa();
        if (flashFee == 0) return redeemable;
        return (redeemable * EXP_SCALE) / (EXP_SCALE + flashFee);
    }
}
