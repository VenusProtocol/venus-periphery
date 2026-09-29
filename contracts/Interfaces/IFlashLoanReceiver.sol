// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.25;

import { IVToken } from "./IVToken.sol";

interface IFlashLoanReceiver {
    /**
     * @notice Executes an operation after receiving the flash-borrowed assets.
     * @dev Implementation of this function must ensure at least the premium (fee) is repaid within the same transaction.
     *      Any unpaid balance (principal + premium - repaid amount) will be added to the onBehalf address's borrow balance.
     * @param vTokens The vToken contracts corresponding to the flash-borrowed underlying assets.
     * @param amounts The amounts of each underlying asset that were flash-borrowed.
     * @param premiums The premiums (fees) associated with each flash-borrowed asset.
     * @param initiator The address that initiated the flash loan.
     * @param onBehalf The address of the user whose debt position will be used for any unpaid flash loan balance.
     * @param param Additional parameters encoded as bytes. These can be used to pass custom data to the receiver contract.
     * @return success True if the operation succeeds (regardless of repayment amount), false if the operation fails.
     * @return repayAmounts Array of uint256 representing the amounts to be repaid for each asset. The receiver contract
     *         must approve these amounts to the respective vToken contracts before this function returns.
     */
    function executeOperation(
        IVToken[] calldata vTokens,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        address onBehalf,
        bytes calldata param
    ) external returns (bool success, uint256[] memory repayAmounts);
}
