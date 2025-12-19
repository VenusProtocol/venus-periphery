// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.25;

import { IAccessControlManagerV8 } from "@venusprotocol/governance-contracts/contracts/Governance/IAccessControlManagerV8.sol";
import { ComptrollerMock } from "@venusprotocol/venus-protocol/contracts/test/ComptrollerMock.sol";
import { VBNB } from "@venusprotocol/venus-protocol/contracts/Tokens/VTokens/VBNB.sol";
import { Diamond } from "@venusprotocol/venus-protocol/contracts/Comptroller/Diamond/Diamond.sol";
import { MockVBNB } from "@venusprotocol/venus-protocol/contracts/test/MockVBNB.sol";
import { VBep20Harness } from "@venusprotocol/venus-protocol/contracts/test/VBep20Harness.sol";
import { ComptrollerLens } from "@venusprotocol/venus-protocol/contracts/Lens/ComptrollerLens.sol";
import { ChainlinkOracle } from "@venusprotocol/oracle/contracts/oracles/ChainlinkOracle.sol";
import { BinanceOracle } from "@venusprotocol/oracle/contracts/oracles/BinanceOracle.sol";
