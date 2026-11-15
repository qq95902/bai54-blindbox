// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {VRFV2PlusClient} from "./VRFV2PlusClient.sol";

/// @notice Minimal Chainlink VRF v2.5 coordinator interface used by BAI.
interface IVRFCoordinatorV2Plus {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId);

    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers);

    function addConsumer(uint256 subId, address consumer) external;
}
