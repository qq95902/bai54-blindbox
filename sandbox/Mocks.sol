// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVRFCoordinatorV2Plus} from "../contracts/vendor/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../contracts/vendor/VRFV2PlusClient.sol";

interface IRandomConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

contract SandboxUSDT is ERC20 {
    constructor() ERC20("Sandbox USDT", "sUSDT") {}
    function decimals() public pure override returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function batchMint(address[] calldata recipients, uint256 amountEach) external {
        for (uint256 i; i < recipients.length; ++i) _mint(recipients[i], amountEach);
    }
}

contract SandboxVRF is IVRFCoordinatorV2Plus {
    uint256 public nextRequestId = 1;
    mapping(uint256 => address) public consumerFor;
    mapping(uint256 => bool) public fulfilled;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata) external returns (uint256 id) {
        id = nextRequestId++;
        consumerFor[id] = msg.sender;
    }
    function fulfill(uint256 id, uint256 word) external {
        require(consumerFor[id] != address(0) && !fulfilled[id], "unknown/already fulfilled");
        fulfilled[id] = true;
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IRandomConsumer(consumerFor[id]).rawFulfillRandomWords(id, words);
    }
    function getSubscription(uint256) external view returns (uint96, uint96, uint64, address, address[] memory) {
        return (type(uint96).max, type(uint96).max, 0, address(this), new address[](0));
    }
    function addConsumer(uint256, address) external pure {}
}

contract SandboxFactory {
    address public pair;
    function setPair(address pair_) external { pair = pair_; }
    function getPair(address, address) external view returns (address) { return pair; }
}

contract SandboxRouter {
    address public immutable usdt;
    address public immutable WETH;
    uint256 public weiPerUSDT = 1e15; // quote: 1 USDT costs 0.001 BNB in this local scenario
    constructor(address usdt_, address weth_) { usdt = usdt_; WETH = weth_; }
    function setWeiPerUSDT(uint256 value) external { require(value > 0); weiPerUSDT = value; }
    function getAmountsIn(uint256 amountOut, address[] calldata) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountOut / 1e18 * weiPerUSDT;
        amounts[1] = amountOut;
    }
    function swapETHForExactTokens(uint256 amountOut, address[] calldata, address to, uint256)
        external payable returns (uint256[] memory amounts)
    {
        uint256 required = amountOut / 1e18 * weiPerUSDT;
        require(msg.value >= required, "insufficient BNB");
        if (msg.value > required) {
            (bool refunded,) = payable(msg.sender).call{value: msg.value - required}("");
            require(refunded, "BNB refund failed");
        }
        require(IERC20(usdt).transfer(to, amountOut), "USDT transfer failed");
        amounts = new uint256[](2);
        amounts[0] = required;
        amounts[1] = amountOut;
    }
    receive() external payable {}
}

contract SandboxLiquidityProcessor {
    address public immutable game;
    address public immutable usdtToken;
    address public immutable baiToken;
    bool public marketReady;
    mapping(uint64 => uint256) public released;
    constructor(address game_, address usdt_, address bai_) { game = game_; usdtToken = usdt_; baiToken = bai_; }
    function priceOracle() external view returns (address) { return address(this); }
    function setMarketReady(bool ready) external { marketReady = ready; }
    function consultUSDT(uint256 amount) external pure returns (uint256) { return amount; }
    function processLiquidity(uint64 dayId) external {
        require(released[dayId] == 0, "already processed");
        released[dayId] = IGameBudget(game).releaseLiquidityBudget(dayId);
    }
}

interface IGameBudget { function releaseLiquidityBudget(uint64 dayId) external returns (uint256); }
