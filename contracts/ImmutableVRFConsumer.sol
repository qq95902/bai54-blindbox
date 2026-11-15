// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVRFCoordinatorV2Plus} from "./vendor/IVRFCoordinatorV2Plus.sol";

/// @notice VRF consumer with a coordinator fixed at deployment.
/// @dev Unlike Chainlink's migratable base, this contract deliberately exposes
///      no owner or coordinator migration function. Coordinator changes require
///      deploying a new consumer and explicitly moving the application.
abstract contract ImmutableVRFConsumer {
    error InvalidCoordinator();
    error OnlyCoordinator(address caller, address coordinator);

    IVRFCoordinatorV2Plus public immutable s_vrfCoordinator;

    constructor(address coordinator_) {
        if (coordinator_ == address(0) || coordinator_.code.length == 0) {
            revert InvalidCoordinator();
        }
        s_vrfCoordinator = IVRFCoordinatorV2Plus(coordinator_);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal virtual;

    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(s_vrfCoordinator)) {
            revert OnlyCoordinator(msg.sender, address(s_vrfCoordinator));
        }
        fulfillRandomWords(requestId, randomWords);
    }
}
