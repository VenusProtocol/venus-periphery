// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { AccessControlManager } from "@venusprotocol/governance-contracts/contracts/Governance/AccessControlManager.sol";

/// @title DCATestAccessControlManager
/// @author Venus
/// @notice The governance AccessControlManager, compiled here so a testnet SmartDCA copy can have an ACM of its own
contract DCATestAccessControlManager is AccessControlManager {}
