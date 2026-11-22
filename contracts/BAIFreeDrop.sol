// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ImmutableVRFConsumer} from "./ImmutableVRFConsumer.sol";
import {VRFV2PlusClient} from "./vendor/VRFV2PlusClient.sol";

interface IBAIFreeDropPurchaseHistory {
    function hasPurchased(address account) external view returns (bool);
    function purchaseProcessor() external view returns (address);
}

interface IBAIFreeDropPurchaseProcessorIdentity {
    function keeper() external view returns (address);
}

interface IBAIFreeDropBurnable {
    function burn(uint256 amount) external;
}

/// @notice Daily BAI-only gift campaign, separated from the paid game to stay below
///         the EVM deployed-code size limit.
contract BAIFreeDrop is ReentrancyGuard, ImmutableVRFConsumer {
    using SafeERC20 for IERC20;

    uint32 public constant MAX_CLAIMS_PER_DAY = 3_000;
    uint32 public constant MAX_CLAIMS_TOTAL = 200_000;
    uint32 public constant STANDARD_CLAIMS_TOTAL = 195_000;
    uint32 public constant SPECIAL_CLAIMS_TOTAL = 5_000;
    uint32 public constant SETTLE_BATCH_LIMIT = 50;
    uint256 public constant BEIJING_OFFSET = 8 hours;
    uint256 public constant FREE_REWARD_RESERVE = 615_000 ether;
    uint256 public constant REQUEST_RETRY_DELAY = 1 days;

    error InvalidAddress();
    error InvalidConfig();
    error ClaimLimitReached();
    error AlreadyClaimedToday();
    error DrawNotReady();
    error RequestAlreadyActive();
    error InvalidBatch();
    error RandomnessPending();
    error PaidBoxRequired();
    error NothingToClaim();
    error OnlyDeployer();
    error BAITokenAlreadySet();
    error OnlyVrfRetryOperator();

    IERC20 public baiToken;
    address public immutable deployer;
    IBAIFreeDropPurchaseHistory public immutable game;
    bytes32 public immutable vrfKeyHash;
    uint256 public immutable vrfSubscriptionId;
    uint16 public immutable vrfRequestConfirmations;
    uint32 public immutable vrfCallbackGasLimit;

    uint32 public totalClaims;
    uint32 public totalSettled;
    uint32 public remainingStandardClaims = STANDARD_CLAIMS_TOTAL;
    uint32 public remainingSpecialClaims = SPECIAL_CLAIMS_TOTAL;
    uint256 public pendingRewardReserve;
    uint256 public freeRewardReserve = FREE_REWARD_RESERVE;

    mapping(uint64 dayId => address[] claimers) private dayClaimers;
    address[] private claimQueue;
    mapping(uint256 queueIndex => uint64 dayId) private claimDayAtIndex;
    mapping(uint64 dayId => mapping(address account => bool claimed)) public claimedToday;
    mapping(uint64 dayId => bool requested) public drawRequested;
    mapping(uint64 dayId => bool fulfilled) public drawFulfilled;
    mapping(uint64 dayId => uint256 requestId) public activeRequestForDay;
    mapping(uint64 dayId => uint64 requestedAt) public drawRequestedAt;
    mapping(uint64 dayId => uint32 settled) public settledClaimsForDay;
    mapping(uint64 dayId => uint256 seed) private drawSeed;
    mapping(uint256 requestId => uint64 dayId) private dayForRequest;
    mapping(uint64 dayId => mapping(address account => bool settled)) public claimSettled;
    mapping(uint64 dayId => mapping(address account => bool special)) public claimIsSpecial;
    mapping(uint64 dayId => mapping(address account => uint8 amount)) public rewardAmount;
    mapping(address account => uint256 amount) public pendingReward;

    event FreeBoxClaimRegistered(uint64 indexed dayId, address indexed account, uint32 indexed queueIndex);
    event FreeDropDrawRequested(uint64 indexed dayId, uint256 indexed requestId);
    event FreeRewardAssigned(uint64 indexed dayId, address indexed account, uint8 amount, bool special, bool unlocked);
    event PendingRewardClaimed(address indexed account, uint256 amount);
    event UnusedReserveBurned(uint256 amount);
    event BAITokenSet(address indexed token);

    constructor(
        address game_,
        address coordinator_,
        bytes32 keyHash_,
        uint256 subscriptionId_,
        uint16 confirmations_,
        uint32 callbackGasLimit_
    ) ImmutableVRFConsumer(coordinator_) {
        if (game_ == address(0) || coordinator_ == address(0) ||
            game_.code.length == 0 || coordinator_.code.length == 0) {
            revert InvalidAddress();
        }
        if (keyHash_ == bytes32(0) || subscriptionId_ == 0 || confirmations_ == 0 || callbackGasLimit_ == 0) {
            revert InvalidConfig();
        }
        deployer = msg.sender;
        game = IBAIFreeDropPurchaseHistory(game_);
        vrfKeyHash = keyHash_;
        vrfSubscriptionId = subscriptionId_;
        vrfRequestConfirmations = confirmations_;
        vrfCallbackGasLimit = callbackGasLimit_;
    }

    /// @notice Bind the BAI token once after deployment and verify the campaign reserve.
    /// @dev This breaks the deployment-address cycle without leaving a mutable token setting.
    function setBAIToken(address token) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (address(baiToken) != address(0)) revert BAITokenAlreadySet();
        if (token == address(0) || token.code.length == 0 || totalClaims != 0) revert InvalidAddress();
        IERC20 candidate = IERC20(token);
        if (candidate.balanceOf(address(this)) < FREE_REWARD_RESERVE) revert InvalidConfig();
        baiToken = candidate;
        emit BAITokenSet(token);
    }

    /// @notice Register one free reward entry for this Beijing day.
    function claimFreeBox() external {
        if (address(baiToken) == address(0)) revert InvalidConfig();
        if (totalClaims >= MAX_CLAIMS_TOTAL) revert ClaimLimitReached();
        uint64 dayId = currentDayId();
        if (claimedToday[dayId][msg.sender]) revert AlreadyClaimedToday();
        if (dayClaimers[dayId].length >= MAX_CLAIMS_PER_DAY) revert ClaimLimitReached();
        if (baiToken.balanceOf(address(this)) < pendingRewardReserve + freeRewardReserve) {
            revert ClaimLimitReached();
        }
        claimedToday[dayId][msg.sender] = true;
        uint32 queueIndex = totalClaims++;
        dayClaimers[dayId].push(msg.sender);
        claimQueue.push(msg.sender);
        claimDayAtIndex[queueIndex] = dayId;
        emit FreeBoxClaimRegistered(dayId, msg.sender, queueIndex);
    }

    /// @notice Ask Chainlink VRF for one seed after the claim day has ended.
    ///         If fulfillment is delayed for a day, only the deployer or configured purchase Keeper may retry.
    function requestDailyDraw(uint64 dayId) external {
        if (dayClaimers[dayId].length == 0 || block.timestamp < _dayStart(dayId + 1)) revert DrawNotReady();
        if (drawFulfilled[dayId]) revert RequestAlreadyActive();
        if (drawRequested[dayId]) {
            if (block.timestamp < uint256(drawRequestedAt[dayId]) + REQUEST_RETRY_DELAY) {
                revert RequestAlreadyActive();
            }
            // Replacement requests charge the project's VRF subscription.
            // Do not let arbitrary callers drain it during a VRF outage.
            address processor = game.purchaseProcessor();
            if (msg.sender != deployer &&
                (processor == address(0) ||
                    msg.sender != IBAIFreeDropPurchaseProcessorIdentity(processor).keeper())) {
                revert OnlyVrfRetryOperator();
            }
        }
        drawRequested[dayId] = true;
        drawRequestedAt[dayId] = uint64(block.timestamp);
        uint256 requestId = _requestRandomWord();
        activeRequestForDay[dayId] = requestId;
        dayForRequest[requestId] = dayId;
        emit FreeDropDrawRequested(dayId, requestId);
    }

    /// @notice Settle claims in global registration order. This keeps the fixed
    ///         5,000-special / 195,000-standard campaign allocation unbiased.
    function settleBatch(uint32 fromIndex, uint32 count) external nonReentrant {
        if (count == 0 || count > SETTLE_BATCH_LIMIT || fromIndex != totalSettled ||
            uint256(fromIndex) + count > claimQueue.length) revert InvalidBatch();

        for (uint256 i = fromIndex; i < uint256(fromIndex) + count; ++i) {
            address account = claimQueue[i];
            uint64 dayId = claimDayAtIndex[i];
            if (!drawFulfilled[dayId]) revert RandomnessPending();
            uint256 remaining = uint256(remainingStandardClaims) + remainingSpecialClaims;
            if (remaining == 0) revert ClaimLimitReached();
            uint256 seed = drawSeed[dayId];
            bool special = uint256(keccak256(abi.encode(seed, i, "BAI_FREE_TIER"))) % remaining
                < remainingSpecialClaims;
            uint8 amount;
            uint256 categoryReserve;
            if (special) {
                --remainingSpecialClaims;
                amount = uint8(uint256(keccak256(abi.encode(seed, i, "BAI_FREE_AMOUNT"))) % 3 + 4);
                categoryReserve = 6 ether;
            } else {
                --remainingStandardClaims;
                amount = uint8(uint256(keccak256(abi.encode(seed, i, "BAI_FREE_AMOUNT"))) % 3 + 1);
                categoryReserve = 3 ether;
            }
            freeRewardReserve -= categoryReserve;
            uint256 reward = uint256(amount) * 1 ether;
            claimSettled[dayId][account] = true;
            claimIsSpecial[dayId][account] = special;
            rewardAmount[dayId][account] = amount;
            bool unlocked = game.hasPurchased(account);
            if (unlocked) {
                baiToken.safeTransfer(account, reward);
            } else {
                pendingReward[account] += reward;
                pendingRewardReserve += reward;
            }
            ++settledClaimsForDay[dayId];
            emit FreeRewardAssigned(dayId, account, amount, special, unlocked);
        }
        totalSettled += count;
    }

    /// @notice Withdraw accumulated free BAI after at least one paid box purchase.
    function claimPendingReward() external nonReentrant {
        if (!game.hasPurchased(msg.sender)) revert PaidBoxRequired();
        uint256 amount = pendingReward[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingReward[msg.sender] = 0;
        pendingRewardReserve -= amount;
        baiToken.safeTransfer(msg.sender, amount);
        emit PendingRewardClaimed(msg.sender, amount);
    }

    /// @notice Burn unused campaign inventory after every allocated claim has
    ///         settled and every pending reward has been withdrawn.
    function burnUnusedReserve() external nonReentrant {
        if (totalClaims != MAX_CLAIMS_TOTAL || totalSettled != totalClaims ||
            pendingRewardReserve != 0 || freeRewardReserve != 0) revert DrawNotReady();
        uint256 amount = baiToken.balanceOf(address(this));
        if (amount == 0) revert NothingToClaim();
        freeRewardReserve = 0;
        IBAIFreeDropBurnable(address(baiToken)).burn(amount);
        emit UnusedReserveBurned(amount);
    }

    function freeDropStatus(address account) external view returns (
        uint64 dayId,
        uint32 claimsToday,
        uint32 claimsTotal,
        uint256 pending,
        bool didClaimToday,
        bool eligibleToClaim
    ) {
        dayId = currentDayId();
        claimsToday = uint32(dayClaimers[dayId].length);
        claimsTotal = totalClaims;
        pending = pendingReward[account];
        didClaimToday = claimedToday[dayId][account];
        eligibleToClaim = address(baiToken) != address(0) && !didClaimToday && claimsToday < MAX_CLAIMS_PER_DAY &&
            claimsTotal < MAX_CLAIMS_TOTAL &&
            baiToken.balanceOf(address(this)) >= pendingRewardReserve + freeRewardReserve;
    }

    function dayClaimersPage(uint64 dayId, uint32 offset, uint32 limit)
        external view returns (address[] memory page)
    {
        if (limit == 0 || limit > SETTLE_BATCH_LIMIT) revert InvalidBatch();
        address[] storage claimers = dayClaimers[dayId];
        if (offset >= claimers.length) return new address[](0);
        uint256 end = uint256(offset) + limit;
        if (end > claimers.length) end = claimers.length;
        page = new address[](end - offset);
        for (uint256 i; i < page.length; ++i) page[i] = claimers[uint256(offset) + i];
    }

    function currentDayId() public view returns (uint64) {
        return uint64((block.timestamp + BEIJING_OFFSET) / 1 days);
    }

    function _dayStart(uint64 dayId) private pure returns (uint64) {
        return uint64(uint256(dayId) * 1 days - BEIJING_OFFSET);
    }

    function _requestRandomWord() private returns (uint256 requestId) {
        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: vrfKeyHash,
                subId: vrfSubscriptionId,
                requestConfirmations: vrfRequestConfirmations,
                callbackGasLimit: vrfCallbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: true})
                )
            })
        );
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        if (randomWords.length == 0) revert RandomnessPending();
        uint64 dayId = dayForRequest[requestId];
        if (dayId == 0 || activeRequestForDay[dayId] != requestId) return;
        drawSeed[dayId] = randomWords[0];
        drawFulfilled[dayId] = true;
    }
}
