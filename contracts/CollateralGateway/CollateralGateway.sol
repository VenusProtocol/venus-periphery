// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IComptroller } from "../Interfaces/IComptroller.sol";
import { IFlashLoanReceiver } from "../Interfaces/IFlashLoanReceiver.sol";
import { IILComptroller } from "../Interfaces/IILComptroller.sol";
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
 * @dev Stateless by design — no proxy, no admin, no funds held between calls. Every call is atomic:
 *      a supply pulls the underlying, deposits it, supplies the shares and credits the receipts
 *      straight to the caller, and a withdraw pays the caller in the same call. If any leg fails the
 *      whole call reverts and the caller keeps what they started with.
 *
 *      Amounts are read back from the contracts rather than assumed. `deposit` reports the shares
 *      it minted, and `mintBehalf` reports only an error code, so the receipts credited to the user
 *      are measured as a balance delta.
 *
 *      The Hub and its market are supplied per call and validated against each other, since a Hub
 *      share token is exactly what its Core market wraps.
 */
contract CollateralGateway is ICollateralGateway, IFlashLoanReceiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Migration in flight, readable by the flash-loan callback. Set for the duration of one
    ///      `supplyFromCollateral` call and cleared before it returns.
    struct Migration {
        address user;
        address vToken;
        uint256 vTokenAmount;
        address hub;
        address vhMarket;
        uint256 minShares;
        uint256 flashAmount;
        uint256 shares;
        uint256 vTokens;
    }

    uint256 private constant EXP_SCALE = 1e18;

    Migration private _migration;

    /// @inheritdoc ICollateralGateway
    function supplyFromWallet(
        address hub,
        uint256 assets,
        address vhMarket,
        uint256 minShares
    ) external nonReentrant returns (uint256 shares) {
        if (hub == address(0) || vhMarket == address(0)) revert ZeroAddress();
        if (assets == 0) revert ZeroAmount();

        address marketUnderlying = IVToken(vhMarket).underlying();
        if (marketUnderlying != hub) revert MarketMismatch(marketUnderlying, hub);

        IERC20 asset = IERC20(IHub(hub).asset());
        asset.safeTransferFrom(msg.sender, address(this), assets);

        _enterCoreMarket(IVToken(vhMarket).comptroller(), vhMarket);

        uint256 vTokens;
        (shares, vTokens) = _depositAndSupply(hub, vhMarket, assets, minShares, msg.sender);

        emit SuppliedFromWallet(msg.sender, hub, vhMarket, assets, shares, vTokens);
    }

    /// @inheritdoc ICollateralGateway
    function supplyFromCollateral(
        address vToken,
        uint256 vTokenAmount,
        address hub,
        address vhMarket,
        uint256 minShares
    ) external nonReentrant returns (uint256 shares) {
        if (vToken == address(0) || hub == address(0) || vhMarket == address(0)) revert ZeroAddress();
        if (vTokenAmount == 0) revert ZeroAmount();

        address asset = IHub(hub).asset();
        {
            address marketUnderlying = IVToken(vhMarket).underlying();
            if (marketUnderlying != hub) revert MarketMismatch(marketUnderlying, hub);

            address vTokenUnderlying = IVToken(vToken).underlying();
            if (vTokenUnderlying != asset) revert AssetMismatch(vTokenUnderlying, asset);
        }

        IComptroller comptroller = IVToken(vToken).comptroller();
        uint256 assetBalanceBefore = IERC20(asset).balanceOf(address(this));

        _enterCoreMarket(comptroller, vhMarket);

        uint256 vTokens;
        if (_wouldCauseShortfall(comptroller, vToken, vTokenAmount)) {
            (shares, vTokens) = _migrateViaFlashLoan(comptroller, vToken, vTokenAmount, hub, vhMarket, minShares);
        } else {
            uint256 assets = _redeemToUnderlying(vToken, vTokenAmount, asset, msg.sender);
            (shares, vTokens) = _depositAndSupply(hub, vhMarket, assets, minShares, msg.sender);
        }

        _requireBalanceKept(asset, assetBalanceBefore);

        emit SuppliedFromCollateral(msg.sender, vToken, hub, vhMarket, vTokenAmount, shares, vTokens);
    }

    /// @inheritdoc ICollateralGateway
    function withdrawPosition(
        address hub,
        address vhMarket,
        uint256 shares,
        uint256 minAssets
    ) external nonReentrant returns (uint256 assets) {
        if (hub == address(0) || vhMarket == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();

        address marketUnderlying = IVToken(vhMarket).underlying();
        if (marketUnderlying != hub) revert MarketMismatch(marketUnderlying, hub);

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
        Migration memory m = _migration;
        if (m.user == address(0) || initiator != address(this)) revert UnexpectedCallback();
        if (msg.sender != address(IVToken(m.vToken).comptroller())) revert UnexpectedCallback();
        if (vTokens.length != 1 || amounts.length != 1 || premiums.length != 1) revert UnexpectedCallback();
        if (address(vTokens[0]) != m.vToken || amounts[0] != m.flashAmount) revert UnexpectedCallback();

        (_migration.shares, _migration.vTokens) = _depositAndSupply(m.hub, m.vhMarket, amounts[0], m.minShares, m.user);

        address asset = IHub(m.hub).asset();
        uint256 proceeds = _redeemToUnderlying(m.vToken, m.vTokenAmount, asset, m.user);

        repayAmounts = new uint256[](1);
        repayAmounts[0] = amounts[0] + premiums[0];
        IERC20(asset).forceApprove(address(vTokens[0]), repayAmounts[0]);

        // Change is measured against this migration's own redeem, never against the balance. Every
        // address here is caller-supplied, so a balance reading would hand a caller anything else
        // the gateway happens to hold.
        if (proceeds > repayAmounts[0]) IERC20(asset).safeTransfer(m.user, proceeds - repayAmounts[0]);

        return (true, repayAmounts);
    }

    /// @dev Reverts when the gateway holds less of `asset` than `balanceBefore`. Every address in a
    ///      migration is caller-supplied, so without this a caller-chosen contract could spend an
    ///      approval the gateway granted against a balance the gateway was already holding.
    function _requireBalanceKept(address asset, uint256 balanceBefore) private view {
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert BalanceSpent(balanceBefore, balanceAfter);
    }

    /// @dev Borrow the position's worth from Core so the replacement collateral exists before the
    ///      old collateral leaves. The rest of the migration runs inside {executeOperation}.
    function _migrateViaFlashLoan(
        IComptroller comptroller,
        address vToken,
        uint256 vTokenAmount,
        address hub,
        address vhMarket,
        uint256 minShares
    ) private returns (uint256 shares, uint256 vTokens) {
        uint256 flashAmount = _flashAmount(comptroller, vToken, vTokenAmount);
        _migration = Migration(msg.sender, vToken, vTokenAmount, hub, vhMarket, minShares, flashAmount, 0, 0);

        IVToken[] memory markets = new IVToken[](1);
        uint256[] memory amounts = new uint256[](1);
        markets[0] = IVToken(vToken);
        amounts[0] = flashAmount;

        comptroller.executeFlashLoan(payable(address(this)), payable(address(this)), markets, amounts, "");
        IERC20(IHub(hub).asset()).forceApprove(vToken, 0);

        shares = _migration.shares;
        vTokens = _migration.vTokens;
        if (vTokens == 0) revert UnexpectedCallback();

        delete _migration;
    }

    /// @dev Deposit `assets` into `hub` and supply the resulting shares to `vhMarket` for
    ///      `receiver`. Returns the shares minted and the market receipts credited.
    function _depositAndSupply(
        address hub,
        address vhMarket,
        uint256 assets,
        uint256 minShares,
        address receiver
    ) private returns (uint256 shares, uint256 vTokens) {
        IERC20 asset = IERC20(IHub(hub).asset());
        asset.forceApprove(hub, assets);
        shares = IHub(hub).deposit(assets, address(this));
        asset.forceApprove(hub, 0);
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
    ///      The vToken count is rounded up, then capped at what the caller holds. Without the cap,
    ///      redeeming a whole position asks for one receipt more than exists, because the mint that
    ///      created it rounded down; the market answers that with an underflow, not an error code.
    ///      A capped or fee-charging market frees less than `shares`, which surfaces to the caller as
    ///      a smaller payout rather than a silent shortfall, since `minAssets` is checked against the
    ///      assets the Hub actually pays out.
    function _freeFromMarket(address hub, address vhMarket, uint256 shares) private returns (uint256 freedShares) {
        uint256 rate = IVToken(vhMarket).exchangeRateCurrent();
        uint256 vTokens = ((shares * EXP_SCALE) + rate - 1) / rate;

        uint256 balance = IVToken(vhMarket).balanceOf(msg.sender);
        if (vTokens > balance) vTokens = balance;

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

        IERC20 underlying = IERC20(IVToken(vToken).underlying());

        // Pull first, then measure. The gateway is a hop the market does not know about, so a
        // fee-on-transfer underlying arrives short and only what landed can be supplied.
        uint256 balanceBefore = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = underlying.balanceOf(address(this)) - balanceBefore;

        uint256 vTokens = _supplyToMarket(address(underlying), vToken, received, msg.sender);
        _enterSpokeMarket(vToken);

        emit SuppliedToSpoke(msg.sender, vToken, received, vTokens);
    }

    /// @dev Enable `vToken` as collateral for the caller. Reverts unless this gateway holds the
    ///      `enterMarketBehalf(address,address)` role on the market's Comptroller.
    function _enterSpokeMarket(address vToken) private {
        IILComptroller(address(IVToken(vToken).comptroller())).enterMarketBehalf(vToken, msg.sender);
    }

    /// @dev Enable `vhMarket` as the caller's collateral, so a supplied position counts from the
    ///      moment it is minted. Reverts unless this gateway holds the
    ///      `enterMarketForAccount(address,address)` role on the market's Comptroller.
    function _enterCoreMarket(IComptroller comptroller, address vhMarket) private {
        uint256 errorCode = comptroller.enterMarketForAccount(msg.sender, vhMarket);
        if (errorCode != 0) revert EnterMarketFailed(vhMarket, errorCode);
    }

    /// @dev True when removing `vTokenAmount` would leave the caller under water. Asks the
    ///      Comptroller the same question the redeem will ask.
    function _wouldCauseShortfall(
        IComptroller comptroller,
        address vToken,
        uint256 vTokenAmount
    ) private view returns (bool) {
        (uint256 errorCode, , uint256 shortfall) = comptroller.getHypotheticalAccountLiquidity(
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
    ///      Every input moves in the gateway's favour. The exchange rate only rises between accruals,
    ///      the Comptroller's redeem fee is subtracted here exactly as the market subtracts it, and
    ///      the loan is scaled down by the market's flash-loan fee, which the market then charges on
    ///      the smaller principal. So the redeem inside the callback always covers the repayment.
    function _flashAmount(
        IComptroller comptroller,
        address vToken,
        uint256 vTokenAmount
    ) private view returns (uint256) {
        uint256 redeemable = (vTokenAmount * IVToken(vToken).exchangeRateStored()) / EXP_SCALE;

        uint256 redeemFee = comptroller.treasuryPercent();
        if (redeemFee != 0) redeemable -= (redeemable * redeemFee) / EXP_SCALE;

        uint256 flashFee = IVToken(vToken).flashLoanFeeMantissa();
        if (flashFee == 0) return redeemable;
        return (redeemable * EXP_SCALE) / (EXP_SCALE + flashFee);
    }
}
