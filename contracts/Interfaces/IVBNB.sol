// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IVToken } from "../Interfaces/IVToken.sol";

interface IVBNB is IVToken {
    function repayBorrowBehalf(address borrower) external payable;

    function liquidateBorrow(address borrower, IVToken vTokenCollateral) external payable;
}
