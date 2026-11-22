// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

interface IBAIPurchaseGame {
    function boxPrice() external view returns (uint256);
    function hasPurchased(address wallet) external view returns (bool);
    function buyBoxesFromProcessor(address buyer, uint8 amount, address referrer) external;
}

interface IBAIPurchaseRouter {
    function WETH() external view returns (address);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external payable returns (uint256[] memory amounts);
}

/// @notice Deterministic receive-only USDT vault. ERC20 transfers do not call this contract.
contract BAIDepositVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdtToken;
    address public immutable processor;
    address public immutable buyer;
    address public immutable referrer;

    error OnlyProcessor();

    constructor(address processor_, address usdt_, address buyer_, address referrer_) {
        processor = processor_;
        usdtToken = IERC20(usdt_);
        buyer = buyer_;
        referrer = referrer_;
    }

    function release(address recipient, uint256 amount) external {
        if (msg.sender != processor) revert OnlyProcessor();
        usdtToken.safeTransfer(recipient, amount);
    }
}

/// @notice BNB purchase router and Keeper-gated settlement for plain USDT transfers.
/// @dev A raw BEP20 transfer cannot execute recipient code. The backend must index its
///      Transfer event, wait for confirmations, then register the observed deposit here.
contract BAIPurchaseProcessor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant DEPOSIT_REFUND_DELAY = 1 days;
    uint8 public constant MAX_BOXES_PER_DEPOSIT = 10;

    IERC20 public immutable usdtToken;
    IBAIPurchaseGame public immutable game;
    IBAIPurchaseRouter public immutable router;
    address public immutable keeper;
    address public immutable deployer;
    uint256 private bnbPurchaseNonce;

    struct Deposit {
        address buyer;
        address vault;
        address referrer;
        uint256 amount;
        uint64 registeredAt;
        bool settled;
        bool refunded;
    }

    struct UnregisteredRefund {
        address buyer;
        address vault;
        uint256 amount;
        bool returned;
    }

    mapping(address buyer => mapping(address referrer => address vault)) public vaultForBuyer;
    mapping(address vault => address buyer) public buyerForVault;
    mapping(address vault => address referrer) public referrerForVault;
    mapping(address vault => bool registered) public isDepositVault;
    mapping(address vault => uint256 amount) public reservedInVault;
    mapping(bytes32 depositId => Deposit) public deposits;
    mapping(bytes32 depositId => UnregisteredRefund) public unregisteredRefunds;
    mapping(address vault => uint256 amount) public reservedUnregisteredRefunds;

    error InvalidAddress();
    error InvalidDeposit();
    error DepositAlreadyRegistered();
    error DepositNotFound();
    error DepositExpired();
    error DepositNotExpired();
    error InvalidDepositAmount();
    error DepositAmountUnavailable();
    error OnlyKeeper();
    error OnlyDeployer();
    error ReferrerNotEligible();
    error SlippageExceeded();
    error UnexpectedBNB();
    error TransferAlreadyReturned();

    event DepositVaultCreated(address indexed buyer, address indexed referrer, address indexed vault);
    event DepositRegistered(
        bytes32 indexed depositId,
        address indexed buyer,
        address indexed referrer,
        address vault,
        uint256 amount,
        uint64 registeredAt
    );
    event DepositSettled(bytes32 indexed depositId, address indexed buyer, address indexed referrer, uint8 boxes, uint256 amount);
    event DepositRefunded(bytes32 indexed depositId, address indexed buyer, uint256 amount, uint8 reason);
    event UnregisteredTransferRefundAuthorized(bytes32 indexed depositId, address indexed buyer, address indexed vault, address reportedSender, uint256 amount);
    event UnregisteredTransferReturned(bytes32 indexed depositId, address indexed buyer, address indexed vault, uint256 amount);
    event BNBPurchase(address indexed buyer, uint8 boxes, uint256 usdtPaid, uint256 bnbSpent);

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert OnlyKeeper();
        _;
    }

    constructor(address usdt_, address game_, address router_, address keeper_) {
        if (usdt_ == address(0) || game_ == address(0) || router_ == address(0) || keeper_ == address(0) ||
            usdt_.code.length == 0 || game_.code.length == 0 || router_.code.length == 0) revert InvalidAddress();
        usdtToken = IERC20(usdt_);
        game = IBAIPurchaseGame(game_);
        router = IBAIPurchaseRouter(router_);
        keeper = keeper_;
        deployer = msg.sender;
    }

    receive() external payable {
        if (msg.sender != address(router)) revert UnexpectedBNB();
    }

    /// @notice A deterministic receiving address bound to one buyer and one referral choice.
    /// @dev The address may receive ERC20 before its vault code is deployed. Registration deploys it.
    function predictVault(address buyer, address referrer) public view returns (address) {
        if (buyer == address(0) || (referrer != address(0) && (referrer == buyer || !game.hasPurchased(referrer)))) {
            revert InvalidDeposit();
        }
        bytes32 salt = _salt(buyer, referrer);
        bytes32 initCodeHash = keccak256(abi.encodePacked(
            type(BAIDepositVault).creationCode,
            abi.encode(address(this), address(usdtToken), buyer, referrer)
        ));
        return Create2.computeAddress(salt, initCodeHash, address(this));
    }

    /// @notice Anyone can deploy the deterministic vault before a transfer; no funds or approval are required.
    function createDepositVault(address buyer, address referrer) external returns (address) {
        return _createVault(buyer, referrer);
    }

    /// @notice Keeper records a confirmed USDT Transfer log. The vault cryptographically binds its buyer/referrer.
    function registerDeposit(bytes32 depositId, address buyer, address referrer, address vault, uint256 amount) external onlyKeeper {
        if (depositId == bytes32(0) || amount == 0 || vault != predictVault(buyer, referrer)) revert InvalidDeposit();
        if (unregisteredRefunds[depositId].buyer != address(0)) revert TransferAlreadyReturned();
        if (deposits[depositId].buyer != address(0)) revert DepositAlreadyRegistered();
        _createVault(buyer, referrer);
        uint256 balance = usdtToken.balanceOf(vault);
        if (balance < reservedInVault[vault] + amount) revert DepositAmountUnavailable();
        deposits[depositId] = Deposit({
            buyer: buyer,
            vault: vault,
            referrer: referrer,
            amount: amount,
            registeredAt: uint64(block.timestamp),
            settled: false,
            refunded: false
        });
        reservedInVault[vault] += amount;
        emit DepositRegistered(depositId, buyer, referrer, vault, amount, uint64(block.timestamp));
    }

    /// @notice Keeper marks a sender-mismatched transfer for return to the vault's bound buyer.
    /// @dev The reported sender is indexed for diagnostics only. A Keeper key can never choose the refund recipient.
    function authorizeUnregisteredTransferRefund(
        bytes32 depositId, address buyer, address referrer, address sender, address vault, uint256 amount
    ) external onlyKeeper {
        if (depositId == bytes32(0) || buyer == address(0) || sender == address(0) || sender == buyer || amount == 0 ||
            vault != predictVault(buyer, referrer)) revert InvalidDeposit();
        if (deposits[depositId].buyer != address(0) || unregisteredRefunds[depositId].buyer != address(0)) {
            revert DepositAlreadyRegistered();
        }
        _createVault(buyer, referrer);
        uint256 alreadyReserved = reservedInVault[vault] + reservedUnregisteredRefunds[vault];
        if (usdtToken.balanceOf(vault) < alreadyReserved + amount) revert DepositAmountUnavailable();
        unregisteredRefunds[depositId] = UnregisteredRefund({buyer: buyer, vault: vault, amount: amount, returned: false});
        reservedUnregisteredRefunds[vault] += amount;
        emit UnregisteredTransferRefundAuthorized(depositId, buyer, vault, sender, amount);
    }

    /// @notice Anyone may trigger an authorized refund; funds always go to the deterministic vault's bound buyer.
    function returnUnregisteredTransfer(bytes32 depositId) external nonReentrant {
        UnregisteredRefund storage item = unregisteredRefunds[depositId];
        if (item.buyer == address(0) || item.returned) revert DepositNotFound();
        item.returned = true;
        reservedUnregisteredRefunds[item.vault] -= item.amount;
        BAIDepositVault(item.vault).release(item.buyer, item.amount);
        emit UnregisteredTransferReturned(depositId, item.buyer, item.vault, item.amount);
    }

    /// @notice Anyone may settle a valid deposit; a paused market leaves it pending until it can settle or refund.
    function settleDeposit(bytes32 depositId) external nonReentrant {
        Deposit storage item = deposits[depositId];
        if (item.buyer == address(0) || item.settled || item.refunded) revert DepositNotFound();
        if (block.timestamp > uint256(item.registeredAt) + DEPOSIT_REFUND_DELAY) revert DepositExpired();
        uint256 price = game.boxPrice();
        if (item.amount % price != 0) revert InvalidDepositAmount();
        uint256 boxes = uint256(item.amount) / price;
        if (boxes == 0 || boxes > MAX_BOXES_PER_DEPOSIT) revert InvalidDepositAmount();

        item.settled = true;
        reservedInVault[item.vault] -= item.amount;
        BAIDepositVault(item.vault).release(address(this), item.amount);
        usdtToken.safeTransfer(address(game), item.amount);
        game.buyBoxesFromProcessor(item.buyer, uint8(boxes), item.referrer);
        emit DepositSettled(depositId, item.buyer, item.referrer, uint8(boxes), item.amount);
    }

    /// @notice Return an unusable transfer (less than one box, fractional box, or over the per-transfer cap).
    function refundInvalidDeposit(bytes32 depositId) external onlyKeeper nonReentrant {
        Deposit storage item = deposits[depositId];
        if (item.buyer == address(0) || item.settled || item.refunded) revert DepositNotFound();
        uint256 price = game.boxPrice();
        uint256 boxes = uint256(item.amount) / price;
        if (boxes != 0 && uint256(item.amount) % price == 0 && boxes <= MAX_BOXES_PER_DEPOSIT) {
            revert InvalidDepositAmount();
        }
        _refund(depositId, item, 1);
    }

    /// @notice Refund deposits that could not be settled within one day (for example, market paused or daily cap reached).
    function refundExpiredDeposit(bytes32 depositId) external nonReentrant {
        Deposit storage item = deposits[depositId];
        if (item.buyer == address(0) || item.settled || item.refunded) revert DepositNotFound();
        if (block.timestamp <= uint256(item.registeredAt) + DEPOSIT_REFUND_DELAY) revert DepositNotExpired();
        _refund(depositId, item, 2);
    }

    /// @notice One-transaction BNB purchase path; USDT allowance is not needed.
    function buyWithBNB(uint8 boxes, address referrer, uint256 maxBNBIn) external payable nonReentrant {
        if (boxes == 0 || boxes > MAX_BOXES_PER_DEPOSIT || msg.value == 0 || msg.value > maxBNBIn) revert InvalidDepositAmount();
        uint256 cost = game.boxPrice() * boxes;
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(usdtToken);
        uint256[] memory quote = router.getAmountsIn(cost, path);
        if (quote.length != 2 || quote[0] > maxBNBIn || msg.value < quote[0]) revert SlippageExceeded();
        uint256[] memory amounts = router.swapETHForExactTokens{value: msg.value}(
            cost, path, address(this), block.timestamp + 5 minutes
        );
        if (amounts.length != 2 || amounts[0] > maxBNBIn || amounts[0] > msg.value) revert SlippageExceeded();
        uint256 refund = msg.value - amounts[0];
        if (refund != 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            if (!refunded) revert UnexpectedBNB();
        }
        usdtToken.safeTransfer(address(game), cost);
        game.buyBoxesFromProcessor(msg.sender, boxes, referrer);
        emit BNBPurchase(msg.sender, boxes, cost, amounts[0]);
    }

    function _createVault(address buyer, address referrer) private returns (address vault) {
        vault = predictVault(buyer, referrer);
        if (isDepositVault[vault]) return vault;
        if (vault.code.length == 0) {
            new BAIDepositVault{salt: _salt(buyer, referrer)}(address(this), address(usdtToken), buyer, referrer);
        }
        isDepositVault[vault] = true;
        vaultForBuyer[buyer][referrer] = vault;
        buyerForVault[vault] = buyer;
        referrerForVault[vault] = referrer;
        emit DepositVaultCreated(buyer, referrer, vault);
    }

    function _refund(bytes32 depositId, Deposit storage item, uint8 reason) private {
        item.refunded = true;
        reservedInVault[item.vault] -= item.amount;
        BAIDepositVault(item.vault).release(item.buyer, item.amount);
        emit DepositRefunded(depositId, item.buyer, item.amount, reason);
    }

    function _salt(address buyer, address referrer) private pure returns (bytes32) {
        return keccak256(abi.encode(buyer, referrer));
    }
}
