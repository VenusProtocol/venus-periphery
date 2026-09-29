pragma solidity ^0.8.0;

// This file is needed to make hardhat and typechain generate artifacts for
// contracts we depend on (e.g. in tests or deployments) but not use directly.
// Another way to do this would be to use hardhat-dependency-compiler, but
// since we only have a couple of dependencies, installing a separate package
// seems an overhead.

import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { BeaconProxy } from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { MockToken } from "@venusprotocol/venus-protocol/contracts/test/MockToken.sol";
import { IAccessControlManagerV8 } from "@venusprotocol/governance-contracts/contracts/Governance/IAccessControlManagerV8.sol";
import { Comptroller } from "@venusprotocol/isolated-pools/contracts/Comptroller.sol";
import { VToken } from "@venusprotocol/isolated-pools/contracts/VToken.sol";
import { PoolRegistry } from "@venusprotocol/isolated-pools/contracts/Pool/PoolRegistry.sol";
import { Shortfall } from "@venusprotocol/isolated-pools/contracts/Shortfall/Shortfall.sol";
import { ProtocolShareReserve } from "@venusprotocol/protocol-reserve/contracts/ProtocolReserve/ProtocolShareReserve.sol";
import { MockPriceOracle } from "@venusprotocol/isolated-pools/contracts/test/Mocks/MockPriceOracle.sol";
import { VTokenHarness } from "@venusprotocol/isolated-pools/contracts/test/VTokenHarness.sol";
