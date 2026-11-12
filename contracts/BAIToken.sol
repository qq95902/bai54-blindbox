// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IBAIDexFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IBAIDividendNotifier {
    function notifyReward(uint256 amount) external;
}

/// @notice Fixed-supply BAI token with a fixed 2% tax on the configured BAI/USDT pair.
/// @dev No owner, proxy, mint, fee setter, or tax-recipient setter exists.
contract BAIToken is ERC20, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 2_000_000 ether;
    uint256 public constant INITIAL_LIQUIDITY_ALLOCATION = 400_000 ether;
    uint256 public constant GAME_REWARD_ALLOCATION = 985_000 ether;
    uint256 public constant FREE_DROP_ALLOCATION = 615_000 ether;
    uint256 public constant TRADE_TAX_BPS = 200;
    uint256 public constant OPERATIONS_TAX_BPS = 100;
    uint256 public constant DIVIDEND_TAX_BPS = 100;

    error InvalidAddress();
    error AllocationMismatch();

    IBAIDexFactory public immutable dexFactory;
    address public immutable quoteToken;
    address public immutable operationsTreasury;
    address public immutable dividendVault;

    event TradeTaxCollected(address indexed from, address indexed to, uint256 operationsAmount, uint256 dividendAmount);

    constructor(
        address dexFactory_,
        address quoteToken_,
        address initialLiquidityReceiver_,
        address gameRewardInventory_,
        address freeDropReceiver_,
        address operationsTreasury_,
        address dividendVault_
    ) ERC20("BAI", "BAI") {
        if (
            dexFactory_ == address(0) || dexFactory_.code.length == 0 ||
            quoteToken_ == address(0) || initialLiquidityReceiver_ == address(0) ||
            gameRewardInventory_ == address(0) || freeDropReceiver_ == address(0) ||
            freeDropReceiver_.code.length == 0 || operationsTreasury_ == address(0) ||
            dividendVault_ == address(0) || dividendVault_.code.length == 0 ||
            operationsTreasury_ == dividendVault_
        ) revert InvalidAddress();
        if (INITIAL_LIQUIDITY_ALLOCATION + GAME_REWARD_ALLOCATION + FREE_DROP_ALLOCATION != TOTAL_SUPPLY) {
            revert AllocationMismatch();
        }

        dexFactory = IBAIDexFactory(dexFactory_);
        quoteToken = quoteToken_;
        operationsTreasury = operationsTreasury_;
        dividendVault = dividendVault_;

        _mint(initialLiquidityReceiver_, INITIAL_LIQUIDITY_ALLOCATION);
        _mint(gameRewardInventory_, GAME_REWARD_ALLOCATION);
        _mint(freeDropReceiver_, FREE_DROP_ALLOCATION);
    }

    /// @dev Tax is applied only when a transfer touches the BAI/quote-token
    ///      pair returned by the immutable DEX factory. Ordinary transfers,
    ///      game claims, and card trades do not touch the pair and are untaxed.
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        address pair = dexFactory.getPair(address(this), quoteToken);
        if (pair == address(0) || (from != pair && to != pair)) {
            super._update(from, to, value);
            return;
        }

        uint256 operationsAmount = value * OPERATIONS_TAX_BPS / 10_000;
        uint256 dividendAmount = value * DIVIDEND_TAX_BPS / 10_000;
        uint256 totalTax = operationsAmount + dividendAmount;
        if (totalTax == 0) {
            super._update(from, to, value);
            return;
        }

        super._update(from, operationsTreasury, operationsAmount);
        super._update(from, dividendVault, dividendAmount);
        super._update(from, to, value - totalTax);
        if (dividendAmount != 0) IBAIDividendNotifier(dividendVault).notifyReward(dividendAmount);
        emit TradeTaxCollected(from, to, operationsAmount, dividendAmount);
    }
}
