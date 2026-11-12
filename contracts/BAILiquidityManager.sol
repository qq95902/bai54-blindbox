// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BAIPriceOracle} from "./BAIPriceOracle.sol";

interface IBAILiquidityGame {
    function releaseLiquidityBudget(uint64 dayId) external returns (uint256 amount);
}

interface IBAIV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IBAIV2Router {
    function factory() external view returns (address);

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

/// @notice TWAP oracle, liquidity processor, and time-lock in one deployment.
/// @dev Anyone may process finalized budgets; LP receipts are locked for 365 days.
contract BAILiquidityManager is ReentrancyGuard, BAIPriceOracle {
    using SafeERC20 for IERC20;

    uint16 public constant SLIPPAGE_BPS = 500; // Fixed 5% maximum against the 24h TWAP.
    uint16 public constant MAX_SWAP_RESERVE_BPS = 100; // Swap at most 1% of current USDT reserves per call.
    uint256 private constant BPS = 10_000;

    error InvalidConfiguration();
    error BudgetTooSmall();
    error EmptySwapOutput();
    error EmptyLiquidityMint();

    IBAILiquidityGame public immutable game;
    IERC20 public immutable usdtToken;
    IERC20 public immutable baiToken;
    IBAIV2Router public immutable router;
    address public immutable lpBeneficiary;
    address public immutable lpPair;
    uint64 public constant LP_LOCK_DURATION = 365 days;
    mapping(uint64 dayId => bool funded) public roundFunded;
    mapping(uint64 dayId => uint256 amount) public pendingBudget;
    uint256 public totalPendingUSDT;
    uint256 public carryUSDT;
    uint256 public carryBAI;
    uint256 public nextLockId = 1;
    bool public initialLPRecorded;

    struct LPLock { uint128 amount; uint64 unlockAt; bool released; }
    mapping(uint256 lockId => LPLock) public lpLocks;

    struct ChunkResult {
        uint256 newlyReleasedBudget;
        uint256 budgetChunk;
        uint256 usdtToSwap;
        uint256 usdtToPair;
        uint256 baiToPair;
        uint256 usedUSDT;
        uint256 usedBAI;
        uint256 liquidity;
        uint256 lockId;
    }

    event LiquidityProcessed(
        uint64 indexed dayId,
        uint256 newlyReleasedBudget,
        uint256 budgetChunk,
        uint256 usdtSwapped,
        uint256 usdtPaired,
        uint256 baiDesired,
        uint256 lpMinted,
        uint256 lockId,
        uint256 residualUSDT,
        uint256 residualBAI
    );
    event LPLocked(uint256 indexed lockId, uint256 amount, uint64 unlockAt);
    event LPReleased(uint256 indexed lockId, address indexed beneficiary, uint256 amount);

    constructor(
        address game_,
        address usdt_,
        address bai_,
        address router_,
        address lpBeneficiary_,
        address pair_,
        uint64 observationInterval_,
        uint64 twapPeriod_,
        uint64 maxObservationAge_,
        uint256 minPoolValueUsd_
    ) BAIPriceOracle(pair_, bai_, usdt_, observationInterval_, twapPeriod_, maxObservationAge_, minPoolValueUsd_) {
        if (
            game_ == address(0) || usdt_ == address(0) || bai_ == address(0) ||
            router_ == address(0) || lpBeneficiary_ == address(0) || game_.code.length == 0 ||
            usdt_.code.length == 0 || bai_.code.length == 0 || router_.code.length == 0
        ) revert InvalidConfiguration();

        address actualPair = IBAIV2Factory(IBAIV2Router(router_).factory()).getPair(usdt_, bai_);
        if (actualPair == address(0) || actualPair != address(pair)) revert InvalidConfiguration();

        game = IBAILiquidityGame(game_);
        usdtToken = IERC20(usdt_);
        baiToken = IERC20(bai_);
        router = IBAIV2Router(router_);
        lpBeneficiary = lpBeneficiary_;
        lpPair = pair_;
    }

    /// @notice Used by the game to pause new sales if the 24h price or pool floor is unavailable.
    function marketReady() external view returns (bool) {
        try this.twapStatus() returns (bool ready, uint64, uint256) {
            return ready;
        } catch {
            return false;
        }
    }

    function priceOracle() external view returns (address) {
        return address(this);
    }

    function releaseLP(uint256 lockId) external nonReentrant {
        LPLock storage item = lpLocks[lockId];
        if (item.amount == 0 || item.released) revert BudgetTooSmall();
        if (block.timestamp < item.unlockAt) revert BudgetTooSmall();
        item.released = true;
        uint256 amount = item.amount;
        IERC20(lpPair).safeTransfer(lpBeneficiary, amount);
        emit LPReleased(lockId, lpBeneficiary, amount);
    }

    function lockInitialLP(uint256 amount) external returns (uint256 lockId) {
        if (msg.sender != lpBeneficiary || initialLPRecorded || amount == 0 ||
            IERC20(lpPair).balanceOf(address(this)) < amount) revert InvalidConfiguration();
        initialLPRecorded = true;
        lockId = _lockLP(amount);
    }

    function _lockLP(uint256 amount) private returns (uint256 lockId) {
        if (amount == 0 || amount > type(uint128).max) revert EmptyLiquidityMint();
        lockId = nextLockId++;
        uint64 unlockAt = uint64(block.timestamp + LP_LOCK_DURATION);
        lpLocks[lockId] = LPLock(uint128(amount), unlockAt, false);
        emit LPLocked(lockId, amount, unlockAt);
    }

    /// @notice Pull a round's budget once, then process it in bounded permissionless chunks.
    function processLiquidity(uint64 dayId) external nonReentrant returns (uint256 lockId) {
        ChunkResult memory result;
        if (!roundFunded[dayId]) {
            result.newlyReleasedBudget = game.releaseLiquidityBudget(dayId);
            if (result.newlyReleasedBudget < 2) revert BudgetTooSmall();
            roundFunded[dayId] = true;
            pendingBudget[dayId] = result.newlyReleasedBudget;
            totalPendingUSDT += result.newlyReleasedBudget;
        }
        uint256 remaining = pendingBudget[dayId];
        uint256 maxChunk = this.usdtReserve() * MAX_SWAP_RESERVE_BPS * 2 / BPS;
        result.budgetChunk = remaining < maxChunk ? remaining : maxChunk;
        if (result.budgetChunk < 2) revert BudgetTooSmall();

        result.usdtToSwap = result.budgetChunk / 2;
        result.usdtToPair = result.budgetChunk - result.usdtToSwap + carryUSDT;
        _swapForBAI(result.usdtToSwap);
        result.baiToPair = baiToken.balanceOf(address(this)); // Includes prior residual.
        (result.usedUSDT, result.usedBAI, result.liquidity) = _addLiquidity(
            result.usdtToPair,
            result.baiToPair
        );
        if (result.liquidity == 0) revert EmptyLiquidityMint();

        result.lockId = _lockLP(result.liquidity);

        pendingBudget[dayId] = remaining - result.budgetChunk;
        totalPendingUSDT -= result.budgetChunk;
        carryUSDT = usdtToken.balanceOf(address(this)) - totalPendingUSDT;
        carryBAI = baiToken.balanceOf(address(this));

        _emitProcessed(dayId, result);
        return result.lockId;
    }

    function _swapForBAI(uint256 amountIn) private {
        uint256 baiBefore = baiToken.balanceOf(address(this));
        uint256 expectedBai = this.consultUSDT(amountIn);
        uint256 minimumBaiOut = Math.mulDiv(expectedBai, BPS - SLIPPAGE_BPS, BPS);
        usdtToken.forceApprove(address(router), amountIn);
        address[] memory path = new address[](2);
        path[0] = address(usdtToken);
        path[1] = address(baiToken);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn,
            minimumBaiOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        usdtToken.forceApprove(address(router), 0);
        if (baiToken.balanceOf(address(this)) == baiBefore) revert EmptySwapOutput();
    }

    function _addLiquidity(uint256 usdtDesired, uint256 baiDesired)
        private
        returns (uint256 usedUSDT, uint256 usedBAI, uint256 liquidity)
    {
        uint256 minimumUsdtForRatio = this.consult(baiDesired);
        uint256 minimumBaiForRatio = this.consultUSDT(usdtDesired);
        uint256 minUsdt = Math.mulDiv(
            minimumUsdtForRatio < usdtDesired ? minimumUsdtForRatio : usdtDesired,
            BPS - SLIPPAGE_BPS,
            BPS
        );
        uint256 minBai = Math.mulDiv(
            minimumBaiForRatio < baiDesired ? minimumBaiForRatio : baiDesired,
            BPS - SLIPPAGE_BPS,
            BPS
        );
        usdtToken.forceApprove(address(router), usdtDesired);
        baiToken.forceApprove(address(router), baiDesired);
        (usedUSDT, usedBAI, liquidity) = router.addLiquidity(
            address(usdtToken),
            address(baiToken),
            usdtDesired,
            baiDesired,
            minUsdt,
            minBai,
            address(this),
            block.timestamp + 15 minutes
        );
        usdtToken.forceApprove(address(router), 0);
        baiToken.forceApprove(address(router), 0);
    }

    function _emitProcessed(uint64 dayId, ChunkResult memory result) private {
        emit LiquidityProcessed(
            dayId,
            result.newlyReleasedBudget,
            result.budgetChunk,
            result.usdtToSwap,
            result.usdtToPair,
            result.baiToPair,
            result.liquidity,
            result.lockId,
            usdtToken.balanceOf(address(this)),
            baiToken.balanceOf(address(this))
        );
    }
}
