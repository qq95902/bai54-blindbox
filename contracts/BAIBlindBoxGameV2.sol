// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IBAIV2RouterForGame {
    function WETH() external view returns (address);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external payable returns (uint256[] memory amounts);
}

interface IBAIMarketReadiness {
    function marketReady() external view returns (bool);
    function priceOracle() external view returns (address);
}

interface IBAIRewardOracle {
    function consultUSDT(uint256 usdtAmount) external view returns (uint256 baiAmount);
}

interface IBAIRewardToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

/// @notice BAI purchase, box receipt, and daily card reveal core.
/// @dev Engineering milestone only. Production NFT metadata and automation are
///      not yet implemented; do not deploy this contract to accept production funds.
contract BAIBlindBoxGameV2 is ERC721, ReentrancyGuard, VRFConsumerBaseV2Plus {
    using SafeERC20 for IERC20Metadata;

    uint256 public constant MAX_BOXES_PER_WALLET_PER_DAY = 10;
    uint256 public constant MAX_BOXES_PER_DAY = 2_000;
    uint256 public constant BEIJING_OFFSET = 8 hours;
    uint256 public constant SETTLE_BATCH_LIMIT = 50;
    uint256 public constant PRIZE_BPS = 2_200;
    uint256 public constant LIQUIDITY_BPS = 7_800;
    uint256 public constant STANDARD_PRIZE_BPS = 2_000;
    uint256 public constant JOKER_PRIZE_BPS = 100;
    uint8 public constant TIER_R = 0;
    uint8 public constant TIER_S = 1;
    uint8 public constant TIER_SR = 2;
    uint8 public constant TIER_SSR = 3;
    uint256 public constant SYNTHESIS_TIMEOUT = 7 days;
    uint8 public constant BOX_UNREVEALED = type(uint8).max;
    uint256 private constant ALL_FACE_BITS = (uint256(1) << 54) - 1;

    error InvalidAddress();
    error InvalidAmount();
    error WalletDailyLimit();
    error RoundDailyLimit();
    error RoundNotFound();
    error SalesStillOpen();
    error DrawAlreadyRequested();
    error RandomnessPending();
    error RandomnessAlreadyLoaded();
    error InvalidBatch();
    error DrawNotFinalized();
    error NotWinningBox();
    error AlreadyClaimed();
    error WinningCardLocked();
    error InvalidReferrer();
    error OnlyDeployer();
    error LiquidityProcessorAlreadySet();
    error OnlyLiquidityProcessor();
    error LiquidityBudgetAlreadyReleased();
    error MarketUnavailable();
    error BAITokenAlreadySet();
    error BAITokenNotSet();
    error RewardAlreadyClaimed();
    error NotLosingBox();
    error InvalidSynthesis();
    error SynthesisNotReady();
    error SynthesisAlreadyCompleted();
    error SynthesisExpired();
    error SynthesisNotExpired();
    error OnlyBAIToken();
    error InvalidListing();
    error NotSeller();
    error NotListed();
    error SelfPurchase();
    error SlippageExceeded();
    error UnexpectedBNB();

    struct Round {
        uint64 salesClose;
        uint32 boxCount;
        uint32 settledCount;
        uint256 totalUSDT;
        uint256 liquidityBudget;
        uint256 winningMask;
        uint256 desiredBaiPerLoser;
        uint256 baiRewardPerLoser;
        bool drawRequested;
        bool randomnessLoaded;
        bool finalized;
        bool liquidityBudgetReleased;
        uint256 rolloverUSDT;
        uint32 loserCount;
    }

    struct Synthesis {
        address owner;
        uint64 requestedAt;
        uint128 fee;
        uint8 outputTier;
        bool completed;
        bool cancelled;
    }

    struct WeightCheckpoint {
        uint64 timestamp;
        uint64 weight;
    }

    IERC20Metadata public immutable usdt;
    address public immutable deployer;
    bytes32 public immutable vrfKeyHash;
    uint256 public immutable vrfSubscriptionId;
    uint16 public immutable vrfRequestConfirmations;
    uint32 public immutable vrfCallbackGasLimit;
    IBAIV2RouterForGame public immutable router;
    address public liquidityProcessor;
    uint256 public immutable boxPrice;
    uint256 public immutable usdtUnit;
    uint256 public nextTokenId = 1;
    IBAIRewardToken public baiToken;
    uint256 public reservedBAI;
    uint256 public nextSynthesisId = 1;
    uint256 public unallocatedBAI;

    struct Listing { address seller; uint128 priceUSDT; bool active; }
    mapping(uint256 tokenId => Listing) public listings;
    mapping(uint64 dayId => uint256 seed) private roundSeed;
    mapping(uint64 dayId => bool fulfilled) public roundRandomnessFulfilled;
    mapping(uint64 dayId => uint256 requestId) public requestForDay;
    mapping(uint256 forgeId => uint256 seed) private forgeSeed;
    mapping(uint256 forgeId => bool fulfilled) public forgeRandomnessFulfilled;
    mapping(uint256 forgeId => uint256 requestId) public requestForForge;
    mapping(uint256 requestId => uint64 dayId) private dayForRequest;
    mapping(uint256 requestId => uint256 forgeId) private forgeForRequest;
    mapping(uint256 requestId => bool isForge) private requestIsForge;
    mapping(uint64 dayId => uint256 amount) public dailyDividendPool;
    mapping(uint64 dayId => mapping(address account => bool claimed)) public dividendClaimed;
    mapping(uint64 dayId => uint256 amount) public dividendClaimedAmount;

    mapping(uint64 dayId => Round) public rounds;
    mapping(uint64 dayId => mapping(address wallet => uint8 count)) public boughtByWallet;
    mapping(address wallet => bool purchasedBefore) public hasPurchased;
    mapping(address wallet => address referrer) public referrerOf;
    mapping(uint64 dayId => uint256[] tokenIds) private roundBoxes;
    mapping(uint256 tokenId => uint64 dayId) public boxRound;
    mapping(uint256 tokenId => address buyer) public purchaseBuyer;
    mapping(uint256 tokenId => uint8 face) public revealedFace;
    mapping(uint256 tokenId => bool winning) public isWinningBox;
    mapping(uint256 tokenId => bool claimed) public prizeClaimed;
    mapping(uint256 tokenId => bool claimed) public baiRewardClaimed;
    mapping(uint256 tokenId => uint8 tier) public cardTier;
    mapping(uint256 tokenId => bool synthesized) public isSynthesized;
    mapping(uint256 synthesisId => Synthesis) public syntheses;
    mapping(uint256 synthesisId => uint256[4] tokenIds) private synthesisCards;
    mapping(address account => uint64 weight) public dividendWeightOf;
    uint64 public totalDividendWeight;
    mapping(address account => WeightCheckpoint[]) private dividendWeightCheckpoints;
    WeightCheckpoint[] private totalDividendWeightCheckpoints;
    mapping(uint64 dayId => mapping(uint8 face => uint32 count)) public winningCountByFace;
    mapping(uint64 dayId => mapping(uint8 face => uint256 amount)) public prizePoolByFace;
    mapping(uint64 dayId => mapping(uint8 face => uint32 count)) public claimedWinnerCountByFace;
    mapping(uint8 face => uint256 amount) public rolloverByFace;
    uint256 public prizeRoundingCarryUSDT;

    event BoxesPurchased(
        uint64 indexed dayId,
        address indexed buyer,
        uint256 firstTokenId,
        uint8 amount,
        uint256 usdtPaid
    );
    event DrawRequested(uint64 indexed dayId, uint256 indexed requestId);
    event WinningFacesDrawn(uint64 indexed dayId, uint256 winningMask);
    event BoxRevealed(uint64 indexed dayId, uint256 indexed tokenId, uint8 face, bool winning);
    event DrawFinalized(uint64 indexed dayId, uint256 boxes, uint256 rolloverUSDT);
    event PrizeClaimed(uint64 indexed dayId, uint256 indexed tokenId, address indexed owner, uint256 amount);
    event PrizeRolloverUpdated(uint8 indexed face, uint256 rolloverAmount);
    event LiquidityProcessorSet(address indexed processor);
    event LiquidityBudgetReleased(uint64 indexed dayId, address indexed processor, uint256 amount);
    event BAITokenSet(address indexed token);
    event BAIRewardClaimed(
        uint64 indexed dayId,
        uint256 indexed tokenId,
        address indexed owner,
        uint256 ownerAmount,
        uint256 burnedAmount
    );
    event SynthesisRequested(uint256 indexed synthesisId, address indexed owner, uint8 outputTier, uint256 baiFee);
    event SynthesisCompleted(uint256 indexed synthesisId, bool success, uint256 outputTokenId, uint8 outputTier);
    event SynthesisCancelled(uint256 indexed synthesisId, address indexed owner);
    event ListingCreated(uint256 indexed tokenId, address indexed seller, uint256 priceUSDT);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event CardPurchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 priceUSDT);
    event DividendReceived(uint64 indexed dayId, uint256 amount, uint256 totalPool);
    event DividendClaimed(uint64 indexed dayId, address indexed account, uint256 amount);
    event DividendQueued(uint256 amount, uint256 queuedTotal);

    constructor(
        address usdt_,
        address coordinator_,
        bytes32 keyHash_,
        uint256 subscriptionId_,
        uint16 confirmations_,
        uint32 callbackGasLimit_,
        address router_
    )
        ERC721("BAI Blind Box", "BAIBOX")
        VRFConsumerBaseV2Plus(coordinator_)
    {
        if (usdt_ == address(0) || router_ == address(0) || confirmations_ == 0 || callbackGasLimit_ == 0) {
            revert InvalidAddress();
        }
        deployer = msg.sender;
        usdt = IERC20Metadata(usdt_);
        vrfKeyHash = keyHash_;
        vrfSubscriptionId = subscriptionId_;
        vrfRequestConfirmations = confirmations_;
        vrfCallbackGasLimit = callbackGasLimit_;
        router = IBAIV2RouterForGame(router_);
        uint8 tokenDecimals = usdt.decimals();
        if (tokenDecimals > 18) revert InvalidAmount();
        usdtUnit = 10 ** uint256(tokenDecimals);
        boxPrice = 10 * (10 ** uint256(tokenDecimals));
    }

    /// @notice One-time token wiring before any boxes are sold.
    function setBAIToken(address token) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (address(baiToken) != address(0)) revert BAITokenAlreadySet();
        if (token == address(0) || token.code.length == 0 || nextTokenId != 1) revert InvalidAddress();
        baiToken = IBAIRewardToken(token);
        emit BAITokenSet(token);
    }

    /// @notice One-time deployment wiring; must be set before the first sale.
    function setLiquidityProcessor(address processor) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (liquidityProcessor != address(0)) revert LiquidityProcessorAlreadySet();
        if (processor == address(0) || processor.code.length == 0 || nextTokenId != 1) {
            revert InvalidAddress();
        }
        liquidityProcessor = processor;
        emit LiquidityProcessorSet(processor);
    }

    /// @notice Pay 10 USDT per box and receive the unopened box NFT atomically.
    function buyBoxes(uint8 amount, address referrer) external nonReentrant {
        _buyBoxesWithUSDT(msg.sender, amount, referrer);
    }

    /// @notice Pay exactly one box price in USDT and mint one unopened box NFT atomically.
    /// @dev This is a contract call, not a plain ERC-20 transfer. The buyer must first
    ///      approve this contract to spend at least `boxPrice` USDT.
    function buyOneBox(address referrer) external nonReentrant {
        _buyBoxesWithUSDT(msg.sender, 1, referrer);
    }

    function _buyBoxesWithUSDT(address buyer, uint8 amount, address referrer) private {
        uint256 totalCost = boxPrice * amount;
        _checkPurchase(amount);
        usdt.safeTransferFrom(buyer, address(this), totalCost);
        _recordPurchase(buyer, amount, referrer, totalCost);
    }

    /// @notice Pay with native BNB; the router atomically swaps only the exact USDT cost.
    /// @dev `maxBNBIn` caps slippage. Prize and liquidity accounting remain in USDT.
    function buyBoxesWithBNB(uint8 amount, address referrer, uint256 maxBNBIn) external payable nonReentrant {
        _checkPurchase(amount);
        uint256 totalCost = boxPrice * amount;
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(usdt);
        uint256[] memory quote = router.getAmountsIn(totalCost, path);
        if (quote.length != 2 || quote[0] > maxBNBIn || msg.value > maxBNBIn || msg.value < quote[0]) {
            revert SlippageExceeded();
        }
        uint256[] memory amounts = router.swapETHForExactTokens{value: msg.value}(
            totalCost, path, address(this), block.timestamp + 5 minutes
        );
        if (amounts.length != 2 || amounts[0] > maxBNBIn || amounts[0] > msg.value) revert SlippageExceeded();
        uint256 refund = msg.value - amounts[0];
        if (refund != 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            if (!refunded) revert UnexpectedBNB();
        }
        _recordPurchase(msg.sender, amount, referrer, totalCost);
    }

    receive() external payable {
        if (msg.sender != address(router)) revert UnexpectedBNB();
    }

    function _checkPurchase(uint8 amount) private view {
        if (amount == 0 || amount > MAX_BOXES_PER_WALLET_PER_DAY) revert InvalidAmount();
        if (liquidityProcessor == address(0) || !IBAIMarketReadiness(liquidityProcessor).marketReady()) {
            revert MarketUnavailable();
        }
        if (address(baiToken) == address(0)) revert BAITokenNotSet();
    }

    function _recordPurchase(address buyer, uint8 amount, address referrer, uint256 totalCost) private {
        if (!hasPurchased[buyer] && referrer != address(0)) {
            if (referrer == buyer || !hasPurchased[referrer]) revert InvalidReferrer();
            referrerOf[buyer] = referrer;
        }
        uint64 dayId = _beijingDayId(block.timestamp);
        Round storage round = rounds[dayId];
        if (round.salesClose == 0) round.salesClose = uint64((uint256(dayId) + 1) * 1 days - BEIJING_OFFSET);
        if (round.boxCount == 0) {
            address oracle = IBAIMarketReadiness(liquidityProcessor).priceOracle();
            round.desiredBaiPerLoser = IBAIRewardOracle(oracle).consultUSDT(usdtUnit);
        }
        uint8 alreadyBought = boughtByWallet[dayId][buyer];
        if (uint256(alreadyBought) + amount > MAX_BOXES_PER_WALLET_PER_DAY) revert WalletDailyLimit();
        if (uint256(round.boxCount) + amount > MAX_BOXES_PER_DAY) revert RoundDailyLimit();
        boughtByWallet[dayId][buyer] = alreadyBought + amount;
        hasPurchased[buyer] = true;
        round.totalUSDT += totalCost;
        uint256 firstTokenId = nextTokenId;
        for (uint256 i; i < amount; ++i) {
            uint256 tokenId = nextTokenId++;
            boxRound[tokenId] = dayId;
            purchaseBuyer[tokenId] = buyer;
            revealedFace[tokenId] = BOX_UNREVEALED;
            roundBoxes[dayId].push(tokenId);
            _safeMint(buyer, tokenId);
        }
        round.boxCount += amount;
        emit BoxesPurchased(dayId, buyer, firstTokenId, amount, totalCost);
    }

    /// @notice Anyone can close a completed Beijing-day round and request VRF.
    function requestDraw(uint64 dayId) external {
        Round storage round = rounds[dayId];
        if (round.boxCount == 0 || round.salesClose == 0) revert RoundNotFound();
        if (block.timestamp < round.salesClose) revert SalesStillOpen();
        if (round.drawRequested) revert DrawAlreadyRequested();
        round.drawRequested = true;
        uint256 requestId = _requestRandomWord();
        requestForDay[dayId] = requestId;
        dayForRequest[requestId] = dayId;
        emit DrawRequested(dayId, requestId);
    }

    /// @notice Anyone may publish the fulfilled seed and the 14 winning faces.
    function loadRandomness(uint64 dayId) external {
        Round storage round = rounds[dayId];
        if (!round.drawRequested) revert RoundNotFound();
        if (round.randomnessLoaded) revert RandomnessAlreadyLoaded();
        if (!roundRandomnessFulfilled[dayId]) revert RandomnessPending();

        uint256 seed = roundSeed[dayId];
        round.winningMask = _makeWinningMask(seed, dayId);
        round.randomnessLoaded = true;
        emit WinningFacesDrawn(dayId, round.winningMask);
    }

    /// @notice Reveal a bounded range of box NFTs after the draw seed is ready.
    function settleBatch(uint64 dayId, uint32 fromIndex, uint32 count) external {
        Round storage round = rounds[dayId];
        if (!round.randomnessLoaded || round.finalized) revert RandomnessPending();
        if (
            count == 0 || count > SETTLE_BATCH_LIMIT ||
            uint256(fromIndex) + count > round.boxCount
        ) revert InvalidBatch();

        uint256[] storage ids = roundBoxes[dayId];
        uint256 seed = roundSeed[dayId];
        for (uint256 i = fromIndex; i < uint256(fromIndex) + count; ++i) {
            uint256 tokenId = ids[i];
            if (revealedFace[tokenId] != BOX_UNREVEALED) revert InvalidBatch();
            uint8 face = uint8(uint256(keccak256(abi.encode(seed, dayId, tokenId))) % 54);
            bool won = (round.winningMask & (uint256(1) << face)) != 0;
            revealedFace[tokenId] = face;
            isWinningBox[tokenId] = won;
            if (won) winningCountByFace[dayId][face] += 1;
            else round.loserCount += 1;
            ++round.settledCount;
            emit BoxRevealed(dayId, tokenId, face, won);
        }
    }

    /// @notice Finish card assignment and account for unmatched face budgets.
    function finalizeDraw(uint64 dayId) external {
        Round storage round = rounds[dayId];
        if (round.settledCount != round.boxCount || round.boxCount == 0) revert InvalidBatch();
        if (round.finalized) revert DrawNotFinalized();

        uint256 standardPool = round.totalUSDT * STANDARD_PRIZE_BPS / 10_000;
        uint256 standardFaceBudget = standardPool / 12;
        uint256 jokerBudget = round.totalUSDT * JOKER_PRIZE_BPS / 10_000;
        uint256 prizeBudget = round.totalUSDT * PRIZE_BPS / 10_000;
        uint256 faceBudgets = standardFaceBudget * 12 + jokerBudget * 2;
        // Carry division dust until face 0 is selected; it is then paid or
        // rolled over by the same rules as that face's regular budget.
        prizeRoundingCarryUSDT += prizeBudget - faceBudgets;

        for (uint8 face; face < 54; ++face) {
            if ((round.winningMask & (uint256(1) << face)) == 0) continue;
            uint256 baseFaceBudget = face >= 52 ? jokerBudget : standardFaceBudget;
            if (face == 0) {
                baseFaceBudget += prizeRoundingCarryUSDT;
                prizeRoundingCarryUSDT = 0;
            }
            uint256 faceBudget = baseFaceBudget + rolloverByFace[face];
            if (winningCountByFace[dayId][face] != 0) {
                prizePoolByFace[dayId][face] = faceBudget;
                rolloverByFace[face] = 0;
            } else {
                rolloverByFace[face] = faceBudget;
                round.rolloverUSDT += faceBudget;
                emit PrizeRolloverUpdated(face, faceBudget);
            }
        }
        round.liquidityBudget = round.totalUSDT * LIQUIDITY_BPS / 10_000;
        if (round.loserCount != 0 && round.desiredBaiPerLoser != 0) {
            uint256 inventory = baiToken.balanceOf(address(this));
            uint256 available = inventory > reservedBAI ? inventory - reservedBAI : 0;
            uint256 maxPerLoser = available / (uint256(round.loserCount) * 2);
            round.baiRewardPerLoser = round.desiredBaiPerLoser < maxPerLoser
                ? round.desiredBaiPerLoser
                : maxPerLoser;
            uint256 reservation = round.baiRewardPerLoser * round.loserCount * 2;
            reservedBAI += reservation;
        }
        round.finalized = true;
        emit DrawFinalized(dayId, round.boxCount, round.rolloverUSDT);
    }

    /// @notice Release the fixed 78% budget to the configured LP processor once.
    function releaseLiquidityBudget(uint64 dayId) external nonReentrant returns (uint256 amount) {
        if (msg.sender != liquidityProcessor || liquidityProcessor == address(0)) {
            revert OnlyLiquidityProcessor();
        }
        Round storage round = rounds[dayId];
        if (!round.finalized) revert DrawNotFinalized();
        if (round.liquidityBudgetReleased) revert LiquidityBudgetAlreadyReleased();
        round.liquidityBudgetReleased = true;
        amount = round.liquidityBudget;
        usdt.safeTransfer(liquidityProcessor, amount);
        emit LiquidityBudgetReleased(dayId, liquidityProcessor, amount);
    }

    /// @notice Winning box owner claims an equal share of that face's USDT pool.
    function claimPrize(uint256 tokenId) external nonReentrant {
        address tokenOwner = ownerOf(tokenId);
        if (tokenOwner != msg.sender) revert InvalidAddress();
        uint64 dayId = boxRound[tokenId];
        Round storage round = rounds[dayId];
        if (!round.finalized) revert DrawNotFinalized();
        if (!isWinningBox[tokenId]) revert NotWinningBox();
        if (prizeClaimed[tokenId]) revert AlreadyClaimed();

        uint8 face = revealedFace[tokenId];
        uint256 facePool = prizePoolByFace[dayId][face];
        uint32 faceWinners = winningCountByFace[dayId][face];
        uint256 amount = facePool / faceWinners;
        prizeClaimed[tokenId] = true;
        claimedWinnerCountByFace[dayId][face] += 1;
        usdt.safeTransfer(msg.sender, amount);
        emit PrizeClaimed(dayId, tokenId, msg.sender, amount);
        if (claimedWinnerCountByFace[dayId][face] == faceWinners) {
            uint256 dust = facePool - amount * faceWinners;
            if (dust != 0) {
                rolloverByFace[face] += dust;
                emit PrizeRolloverUpdated(face, rolloverByFace[face]);
            }
        }
    }

    /// @notice Claim the box's BAI award; inviter shares come out of the same 1 USDT-value award.
    function claimBAIReward(uint256 tokenId) external nonReentrant {
        address tokenOwner = ownerOf(tokenId);
        if (tokenOwner != msg.sender) revert InvalidAddress();
        uint64 dayId = boxRound[tokenId];
        Round storage round = rounds[dayId];
        if (!round.finalized) revert DrawNotFinalized();
        if (isWinningBox[tokenId]) revert NotLosingBox();
        if (baiRewardClaimed[tokenId]) revert RewardAlreadyClaimed();
        baiRewardClaimed[tokenId] = true;

        uint256 baseAward = round.baiRewardPerLoser;
        if (baseAward == 0) return;
        reservedBAI -= baseAward * 2;

        address buyer = purchaseBuyer[tokenId];
        address level1 = referrerOf[buyer];
        address level2 = level1 == address(0) ? address(0) : referrerOf[level1];
        address level3 = level2 == address(0) ? address(0) : referrerOf[level2];
        uint256 level1Award = level1 == address(0) ? 0 : baseAward * 5 / 100;
        uint256 level2Award = level2 == address(0) ? 0 : baseAward * 3 / 100;
        uint256 level3Award = level3 == address(0) ? 0 : baseAward / 100;
        uint256 ownerAward = baseAward - level1Award - level2Award - level3Award;

        if (ownerAward != 0 && !baiToken.transfer(tokenOwner, ownerAward)) revert InvalidAddress();
        if (level1Award != 0 && !baiToken.transfer(level1, level1Award)) revert InvalidAddress();
        if (level2Award != 0 && !baiToken.transfer(level2, level2Award)) revert InvalidAddress();
        if (level3Award != 0 && !baiToken.transfer(level3, level3Award)) revert InvalidAddress();
        baiToken.burn(baseAward);
        emit BAIRewardClaimed(dayId, tokenId, tokenOwner, ownerAward, baseAward);
    }

    /// @notice Escrow any four revealed non-winning cards and pay the tier fee to attempt synthesis.
    /// @dev The output tier is one level above the highest input tier, capped at SSR.
    function requestSynthesis(uint256[4] calldata tokenIds)
        external
        nonReentrant
        returns (uint256 synthesisId)
    {
        if (address(baiToken) == address(0)) revert BAITokenNotSet();
        uint8 highestInputTier;
        for (uint256 i; i < 4; ++i) {
            uint256 tokenId = tokenIds[i];
            if (
                _ownerOf(tokenId) != msg.sender ||
                revealedFace[tokenId] == BOX_UNREVEALED ||
                isWinningBox[tokenId]
            ) revert InvalidSynthesis();
            for (uint256 j; j < i; ++j) {
                if (tokenIds[j] == tokenId) revert InvalidSynthesis();
            }
            if (cardTier[tokenId] > highestInputTier) highestInputTier = cardTier[tokenId];
        }

        uint8 outputTier = highestInputTier >= TIER_SSR ? TIER_SSR : highestInputTier + 1;
        uint128 fee = _synthesisFee(outputTier);
        if (!baiToken.transferFrom(msg.sender, address(this), fee)) revert InvalidSynthesis();

        synthesisId = nextSynthesisId++;
        syntheses[synthesisId] = Synthesis({
            owner: msg.sender,
            requestedAt: uint64(block.timestamp),
            fee: fee,
            outputTier: outputTier,
            completed: false,
            cancelled: false
        });
        for (uint256 i; i < 4; ++i) {
            synthesisCards[synthesisId][i] = tokenIds[i];
            _transfer(msg.sender, address(this), tokenIds[i]);
        }
        uint256 requestId = _requestRandomWord();
        requestForForge[synthesisId] = requestId;
        forgeForRequest[requestId] = synthesisId;
        requestIsForge[requestId] = true;
        emit SynthesisRequested(synthesisId, msg.sender, outputTier, fee);
    }

    /// @notice Finalize an attempt after Chainlink VRF returns; anyone can submit this transaction.
    function completeSynthesis(uint256 synthesisId) external nonReentrant {
        Synthesis storage item = syntheses[synthesisId];
        if (item.owner == address(0) || item.cancelled) revert InvalidSynthesis();
        if (item.completed) revert SynthesisAlreadyCompleted();
        if (!forgeRandomnessFulfilled[synthesisId]) revert SynthesisNotReady();

        uint256 seed = forgeSeed[synthesisId];
        item.completed = true;
        uint256[4] storage inputs = synthesisCards[synthesisId];
        for (uint256 i; i < 4; ++i) _burn(inputs[i]);
        baiToken.burn(item.fee);

        bool success = (seed & 1) == 0;
        uint256 outputTokenId;
        if (success) {
            outputTokenId = nextTokenId++;
            uint8 face = uint8(uint256(keccak256(abi.encode(seed, synthesisId, "BAI_SYNTH_FACE"))) % 54);
            revealedFace[outputTokenId] = face;
            cardTier[outputTokenId] = item.outputTier;
            isSynthesized[outputTokenId] = true;
            _safeMint(item.owner, outputTokenId);
        }
        emit SynthesisCompleted(synthesisId, success, outputTokenId, item.outputTier);
    }

    /// @notice Refund inputs and BAI fee if the VRF request remains unfulfilled for seven days.
    function cancelExpiredSynthesis(uint256 synthesisId) external nonReentrant {
        Synthesis storage item = syntheses[synthesisId];
        if (item.owner == address(0) || item.cancelled) revert InvalidSynthesis();
        if (item.completed) revert SynthesisAlreadyCompleted();
        if (forgeRandomnessFulfilled[synthesisId]) revert SynthesisNotReady();
        if (block.timestamp < uint256(item.requestedAt) + SYNTHESIS_TIMEOUT) revert SynthesisNotExpired();

        item.cancelled = true;
        uint256[4] storage inputs = synthesisCards[synthesisId];
        for (uint256 i; i < 4; ++i) _transfer(address(this), item.owner, inputs[i]);
        if (!baiToken.transfer(item.owner, item.fee)) revert InvalidSynthesis();
        emit SynthesisCancelled(synthesisId, item.owner);
    }

    function _synthesisFee(uint8 outputTier) private pure returns (uint128) {
        if (outputTier == TIER_S) return uint128(10 ether);
        if (outputTier == TIER_SR) return uint128(25 ether);
        return uint128(50 ether);
    }

    function boxesOfRound(uint64 dayId) external view returns (uint256[] memory) {
        return roundBoxes[dayId];
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
        if (requestIsForge[requestId]) {
            uint256 forgeId = forgeForRequest[requestId];
            if (forgeId == 0 || requestForForge[forgeId] != requestId) revert RandomnessPending();
            forgeSeed[forgeId] = randomWords[0];
            forgeRandomnessFulfilled[forgeId] = true;
        } else {
            uint64 dayId = dayForRequest[requestId];
            if (dayId == 0 || requestForDay[dayId] != requestId) revert RandomnessPending();
            roundSeed[dayId] = randomWords[0];
            roundRandomnessFulfilled[dayId] = true;
        }
    }

    /// @notice Called by BAI token after its dividend tax has reached this contract.
    function notifyReward(uint256 amount) external {
        if (msg.sender != address(baiToken)) revert OnlyBAIToken();
        if (amount == 0) return;
        uint64 dayId = _beijingDayId(block.timestamp);
        if (getTotalDividendWeightAt(_dayStart(dayId)) == 0) {
            unallocatedBAI += amount;
            emit DividendQueued(amount, unallocatedBAI);
            return;
        }
        uint256 allocation = amount + unallocatedBAI;
        unallocatedBAI = 0;
        dailyDividendPool[dayId] += allocation;
        emit DividendReceived(dayId, allocation, dailyDividendPool[dayId]);
    }

    function claimDividend(uint64 dayId) external nonReentrant returns (uint256 amount) {
        if (dayId >= _beijingDayId(block.timestamp) || dividendClaimed[dayId][msg.sender]) revert RewardAlreadyClaimed();
        uint256 totalWeight = getTotalDividendWeightAt(_dayStart(dayId));
        uint256 accountWeight = getDividendWeightAt(msg.sender, _dayStart(dayId));
        uint256 pool = dailyDividendPool[dayId];
        if (totalWeight == 0 || accountWeight == 0 || pool == 0) revert RewardAlreadyClaimed();
        amount = pool * accountWeight / totalWeight;
        if (amount == 0) revert RewardAlreadyClaimed();
        dividendClaimed[dayId][msg.sender] = true;
        dividendClaimedAmount[dayId] += amount;
        if (!baiToken.transfer(msg.sender, amount)) revert InvalidAddress();
        emit DividendClaimed(dayId, msg.sender, amount);
    }

    function claimableDividend(uint64 dayId, address account) external view returns (uint256) {
        if (dayId >= _beijingDayId(block.timestamp) || dividendClaimed[dayId][account]) return 0;
        uint256 totalWeight = getTotalDividendWeightAt(_dayStart(dayId));
        if (totalWeight == 0) return 0;
        return dailyDividendPool[dayId] * getDividendWeightAt(account, _dayStart(dayId)) / totalWeight;
    }

    /// @notice Escrow a revealed losing card for a fixed USDT price.
    function listCard(uint256 tokenId, uint256 priceUSDT) external nonReentrant {
        if (priceUSDT == 0 || priceUSDT > type(uint128).max) revert InvalidListing();
        if (_ownerOf(tokenId) != msg.sender || revealedFace[tokenId] == BOX_UNREVEALED ||
            isWinningBox[tokenId] || isSynthesized[tokenId] || listings[tokenId].active) revert InvalidListing();
        listings[tokenId] = Listing(msg.sender, uint128(priceUSDT), true);
        _transfer(msg.sender, address(this), tokenId);
        emit ListingCreated(tokenId, msg.sender, priceUSDT);
    }

    function buyListedCard(uint256 tokenId) external nonReentrant {
        Listing memory item = listings[tokenId];
        if (!item.active) revert NotListed();
        if (item.seller == msg.sender) revert SelfPurchase();
        delete listings[tokenId];
        usdt.safeTransferFrom(msg.sender, item.seller, item.priceUSDT);
        _transfer(address(this), msg.sender, tokenId);
        emit CardPurchased(tokenId, item.seller, msg.sender, item.priceUSDT);
    }

    function cancelCardListing(uint256 tokenId) external nonReentrant {
        Listing memory item = listings[tokenId];
        if (!item.active) revert NotListed();
        if (item.seller != msg.sender) revert NotSeller();
        delete listings[tokenId];
        _transfer(address(this), msg.sender, tokenId);
        emit ListingCancelled(tokenId, msg.sender);
    }

    function _dayStart(uint64 dayId) private pure returns (uint64) {
        return uint64(uint256(dayId) * 1 days - BEIJING_OFFSET);
    }

    function _makeWinningMask(uint256 seed, uint64 dayId) private pure returns (uint256 mask) {
        uint8[52] memory deck;
        for (uint8 i; i < 52; ++i) deck[i] = i;

        // Partial Fisher-Yates: select 12 unique standard-card faces.
        for (uint256 i; i < 12; ++i) {
            uint256 j = i + (uint256(keccak256(abi.encode(seed, dayId, i, "WIN"))) % (52 - i));
            (deck[i], deck[j]) = (deck[j], deck[i]);
            mask |= uint256(1) << deck[i];
        }
        mask |= uint256(1) << 52; // Big Joker is always included.
        mask |= uint256(1) << 53; // Small Joker is always included.
        return mask & ALL_FACE_BITS;
    }

    function _beijingDayId(uint256 timestamp) private pure returns (uint64) {
        return uint64((timestamp + BEIJING_OFFSET) / 1 days);
    }

    /// @dev Winning cards stay in the owner's wallet and cannot be transferred.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (revealedFace[tokenId] == BOX_UNREVEALED) revert WinningCardLocked();
            if (isWinningBox[tokenId]) revert WinningCardLocked();
        }
        bool dividendEligible = cardTier[tokenId] >= TIER_SR;
        if (dividendEligible && from != address(0) && from != address(this)) {
            _changeDividendWeight(from, false);
        }
        address previousOwner = super._update(to, tokenId, auth);
        if (dividendEligible && to != address(0) && to != address(this)) {
            _changeDividendWeight(to, true);
        }
        return previousOwner;
    }

    /// @notice Historical eligible NFT weight just before the timestamp boundary.
    function getDividendWeightAt(address account, uint64 timestamp) public view returns (uint256) {
        return _weightAt(dividendWeightCheckpoints[account], timestamp);
    }

    function getTotalDividendWeightAt(uint64 timestamp) public view returns (uint256) {
        return _weightAt(totalDividendWeightCheckpoints, timestamp);
    }

    function _changeDividendWeight(address account, bool increase) private {
        if (increase) {
            dividendWeightOf[account] += 1;
            totalDividendWeight += 1;
        } else {
            dividendWeightOf[account] -= 1;
            totalDividendWeight -= 1;
        }
        uint64 timestamp = uint64(block.timestamp);
        _writeCheckpoint(dividendWeightCheckpoints[account], timestamp, dividendWeightOf[account]);
        _writeCheckpoint(totalDividendWeightCheckpoints, timestamp, totalDividendWeight);
    }

    function _writeCheckpoint(
        WeightCheckpoint[] storage checkpoints,
        uint64 timestamp,
        uint64 weight
    ) private {
        uint256 length = checkpoints.length;
        if (length != 0 && checkpoints[length - 1].timestamp == timestamp) {
            checkpoints[length - 1].weight = weight;
        } else {
            checkpoints.push(WeightCheckpoint({timestamp: timestamp, weight: weight}));
        }
    }

    function _weightAt(WeightCheckpoint[] storage checkpoints, uint64 timestamp)
        private
        view
        returns (uint256)
    {
        uint256 low;
        uint256 high = checkpoints.length;
        // Strictly-before semantics make the snapshot independent of
        // transaction ordering within a block at the exact boundary second.
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (checkpoints[mid].timestamp < timestamp) low = mid + 1;
            else high = mid;
        }
        return low == 0 ? 0 : checkpoints[low - 1].weight;
    }
}
