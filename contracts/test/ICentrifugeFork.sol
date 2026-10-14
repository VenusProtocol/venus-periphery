// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

/**
 * @title Centrifuge fork-test surface
 * @author Venus
 * @notice What a fork test needs to play Centrifuge's side of a Liquidity Hub position: admitting an
 *         investor, publishing a NAV, settling a request, and funding what the pool can pay out.
 * @dev These are Centrifuge's own contracts, not Venus's. Every function here is `auth`-gated on
 *      Centrifuge's Root, which is how its cross-chain messages land, so a fork test reaches them by
 *      impersonating Root rather than by faking anything.
 *
 *      Hand-copied, so nothing cross-checks the selectors at build time; a drifted signature reverts
 *      against the live deployment.
 */
interface ICentrifugeSpoke {
    /// @notice Publishes a share class's NAV. This is what the vault's `pricePerShare()` resolves to.
    function updatePricePoolPerShare(uint64 poolId, bytes16 scId, uint128 price, uint64 computedAt) external;

    function pricePoolPerAsset(
        uint64 poolId,
        bytes16 scId,
        uint128 assetId,
        bool checkValidity
    ) external view returns (uint128 price);

    function assetToId(address asset, uint256 tokenId) external view returns (uint128 assetId);
}

interface ICentrifugeRequestManager {
    /// @notice Delivers one `RequestCallbackMessageLib` message, the way the hub chain does.
    function callback(uint64 poolId, bytes16 scId, uint128 assetId, bytes calldata payload) external;

    function poolEscrow(uint64 poolId) external view returns (address escrow);
}

interface ICentrifugeTransferHook {
    /// @notice Admits `user` to a share class until `validUntil`. Entries expire.
    function updateMember(address token, address user, uint64 validUntil) external;

    function isMember(address token, address user) external view returns (bool isValid, uint64 validUntil);
}

interface ICentrifugePoolEscrow {
    /// @notice Records assets already transferred in as spendable pool holding.
    function deposit(bytes16 scId, address asset, uint256 tokenId, uint128 amount) external;

    /// @notice Holding minus reservations, floored at zero: what a redemption can actually be paid from.
    function availableBalanceOf(bytes16 scId, address asset, uint256 tokenId) external view returns (uint128 available);
}
