// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IBAIV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

/// @notice Permissionless rolling TWAP oracle for one BAI/USDT V2 pair.
/// @dev Deployment parameters define the observation cadence, TWAP window,
///      maximum observation age, and minimum pool value. Production deployments
///      should use a 24h TWAP and a suitably deep minimum pool.
contract BAIPriceOracle {
    uint8 public constant OBSERVATION_CAPACITY = 48;
    uint256 private constant Q112 = uint256(1) << 112;

    error InvalidPair();
    error InvalidOracleConfig();
    error InvalidTokenDecimals();
    error InsufficientReserves();
    error ObservationNotReady();
    error PoolBelowMinimum();

    struct Observation {
        uint64 timestamp;
        uint256 priceCumulative;
    }

    IBAIV2Pair public immutable pair;
    address public immutable bai;
    address public immutable usdt;
    uint8 public immutable usdtDecimals;
    bool public immutable baiIsToken0;
    uint64 public immutable observationInterval;
    uint64 public immutable twapPeriod;
    uint64 public immutable maxObservationAge;
    uint256 public immutable minPoolValueUsd;

    Observation[48] private observations;
    uint8 public observationCursor;
    uint8 public observationCount;
    uint64 public lastObservationHour;

    event ObservationRecorded(uint64 indexed timestamp, uint256 priceCumulative);

    constructor(
        address pair_,
        address bai_,
        address usdt_,
        uint64 observationInterval_,
        uint64 twapPeriod_,
        uint64 maxObservationAge_,
        uint256 minPoolValueUsd_
    ) {
        if (pair_ == address(0) || bai_ == address(0) || usdt_ == address(0) || bai_ == usdt_) {
            revert InvalidPair();
        }
        if (
            observationInterval_ == 0 || twapPeriod_ < observationInterval_ ||
            maxObservationAge_ < twapPeriod_ || minPoolValueUsd_ == 0
        ) revert InvalidOracleConfig();
        IBAIV2Pair pairContract = IBAIV2Pair(pair_);
        address token0 = pairContract.token0();
        address token1 = pairContract.token1();
        if (!((token0 == bai_ && token1 == usdt_) || (token1 == bai_ && token0 == usdt_))) {
            revert InvalidPair();
        }
        uint8 decimals_ = IERC20Metadata(usdt_).decimals();
        if (decimals_ > 18) revert InvalidTokenDecimals();

        pair = pairContract;
        bai = bai_;
        usdt = usdt_;
        usdtDecimals = decimals_;
        baiIsToken0 = token0 == bai_;
        observationInterval = observationInterval_;
        twapPeriod = twapPeriod_;
        maxObservationAge = maxObservationAge_;
        minPoolValueUsd = minPoolValueUsd_;
    }

    /// @notice Record at most one cumulative-price observation per hour.
    function update() external {
        uint64 hourId = uint64(block.timestamp / observationInterval);
        if (observationCount != 0 && hourId == lastObservationHour) return;

        (uint256 cumulative, uint112 reserve0, uint112 reserve1) = _currentCumulative();
        if (reserve0 == 0 || reserve1 == 0) revert InsufficientReserves();

        observations[observationCursor] = Observation({
            timestamp: uint64(block.timestamp),
            priceCumulative: cumulative
        });
        observationCursor = uint8((uint256(observationCursor) + 1) % OBSERVATION_CAPACITY);
        if (observationCount < OBSERVATION_CAPACITY) ++observationCount;
        lastObservationHour = hourId;
        emit ObservationRecorded(uint64(block.timestamp), cumulative);
    }

    /// @notice Return USDT raw units for a BAI amount using the mature 24h TWAP.
    function consult(uint256 baiAmount) external view returns (uint256 usdtAmount) {
        if (baiAmount == 0) return 0;
        (uint256 averagePrice, uint64 elapsed) = _twapPrice();
        usdtAmount = Math.mulDiv(baiAmount, averagePrice, Q112);
        if (usdtAmount == 0) revert PoolBelowMinimum();
        _enforcePoolFloor(averagePrice);
        elapsed; // Exposed in the observation validity check; suppress unused warnings.
    }

    /// @notice Return BAI raw units for a USDT amount using the same mature TWAP.
    function consultUSDT(uint256 usdtAmount) external view returns (uint256 baiAmount) {
        if (usdtAmount == 0) return 0;
        (uint256 averagePrice,) = _twapPrice();
        baiAmount = Math.mulDiv(usdtAmount, Q112, averagePrice);
        if (baiAmount == 0) revert PoolBelowMinimum();
        _enforcePoolFloor(averagePrice);
    }

    /// @notice Current USDT reserve, used only to bound each LP-processing chunk.
    function usdtReserve() external view returns (uint256 reserveUSDT) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        reserveUSDT = baiIsToken0 ? uint256(reserve1) : uint256(reserve0);
    }

    /// @notice Return TWAP age and quote for diagnostic displays.
    function twapStatus() external view returns (bool ready, uint64 age, uint256 averagePriceX112) {
        try this.readTwap() returns (uint256 price, uint64 elapsed) {
            if (!_poolAboveFloor(price)) return (false, elapsed, price);
            return (true, elapsed, price);
        } catch {
            return (false, 0, 0);
        }
    }

    function readTwap() external view returns (uint256 averagePriceX112, uint64 elapsed) {
        return _twapPrice();
    }

    function _twapPrice() private view returns (uint256 averagePriceX112, uint64 elapsed) {
        if (observationCount == 0 || block.timestamp < twapPeriod) revert ObservationNotReady();
        uint64 target = uint64(block.timestamp - twapPeriod);
        bool found;
        Observation memory selected;
        for (uint256 i; i < OBSERVATION_CAPACITY; ++i) {
            Observation memory item = observations[i];
            if (item.timestamp != 0 && item.timestamp <= target && (!found || item.timestamp > selected.timestamp)) {
                selected = item;
                found = true;
            }
        }
        if (!found) revert ObservationNotReady();

        uint64 now_ = uint64(block.timestamp);
        elapsed = now_ - selected.timestamp;
        if (elapsed < twapPeriod || elapsed > maxObservationAge) revert ObservationNotReady();

        (uint256 currentCumulative,,) = _currentCumulative();
        unchecked {
            uint256 cumulativeDelta = currentCumulative - selected.priceCumulative;
            averagePriceX112 = cumulativeDelta / elapsed;
        }
        if (averagePriceX112 == 0) revert ObservationNotReady();
    }

    function _enforcePoolFloor(uint256 averagePriceX112) private view {
        if (!_poolAboveFloor(averagePriceX112)) revert PoolBelowMinimum();
    }

    function _poolAboveFloor(uint256 averagePriceX112) private view returns (bool) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        (uint256 reserveBAI, uint256 reserveUSDT) = baiIsToken0
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));
        uint256 baiReserveValue = Math.mulDiv(reserveBAI, averagePriceX112, Q112);
        uint256 minimumPoolValue = minPoolValueUsd * (10 ** uint256(usdtDecimals));
        return reserveUSDT + baiReserveValue >= minimumPoolValue;
    }

    function _currentCumulative()
        private
        view
        returns (uint256 cumulative, uint112 reserve0, uint112 reserve1)
    {
        uint32 timestamp;
        uint32 timestampLast;
        (reserve0, reserve1, timestampLast) = pair.getReserves();
        timestamp = uint32(block.timestamp);
        cumulative = baiIsToken0 ? pair.price0CumulativeLast() : pair.price1CumulativeLast();

        if (timestamp != timestampLast && reserve0 != 0 && reserve1 != 0) {
            uint32 elapsed;
            unchecked {
                elapsed = timestamp - timestampLast;
                uint256 priceX112 = baiIsToken0
                    ? (uint256(reserve1) << 112) / reserve0
                    : (uint256(reserve0) << 112) / reserve1;
                cumulative += priceX112 * elapsed;
            }
        }
    }
}
