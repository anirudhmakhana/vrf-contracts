// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.18;

contract GelatoVRFInbox {
    event RequestedRandomness(uint256 round, address callback);

    function requestRandomness(uint256 round, address callback) external {
        emit RequestedRandomness(round, callback);
    }
}