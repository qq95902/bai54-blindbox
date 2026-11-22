export const eventAbis = {
  game: [
    'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
    'event BoxesPurchased(uint64 indexed dayId,address indexed buyer,uint256 firstTokenId,uint8 amount,uint256 usdtPaid)',
    'event ReferralUSDTAccrued(uint64 indexed dayId,address indexed referrer,address indexed buyer,uint256 amount)',
    'event ReferralUSDTClaimed(address indexed referrer,uint256 amount)',
    'event DrawRequested(uint64 indexed dayId,uint256 indexed requestId)',
    'event WinningFacesDrawn(uint64 indexed dayId,uint256 winningMask)',
    'event BoxRevealed(uint64 indexed dayId,uint256 indexed tokenId,uint8 face,bool winning)',
    'event DrawFinalized(uint64 indexed dayId,uint256 boxes,uint256 rolloverUSDT)',
    'event SynthesisRequested(uint256 indexed synthesisId,address indexed owner,uint8 outputTier,uint256 baiFee)',
    'event SynthesisCompleted(uint256 indexed synthesisId,bool success,uint256 outputTokenId,uint8 outputTier)',
    'event SynthesisCancelled(uint256 indexed synthesisId,address indexed owner)',
    'event ListingCreated(uint256 indexed tokenId,address indexed seller,uint256 priceUSDT)',
    'event ListingCancelled(uint256 indexed tokenId,address indexed seller)',
    'event CardPurchased(uint256 indexed tokenId,address indexed seller,address indexed buyer,uint256 priceUSDT)'
  ],
  freeDrop: [
    'event FreeBoxClaimRegistered(uint64 indexed dayId,address indexed account,uint32 indexed queueIndex)',
    'event FreeDropDrawRequested(uint64 indexed dayId,uint256 indexed requestId)',
    'event FreeRewardAssigned(uint64 indexed dayId,address indexed account,uint8 amount,bool special,bool unlocked)'
  ],
  liquidityManager: [
    'event LiquidityProcessed(uint64 indexed dayId,uint256 newlyReleasedBudget,uint256 budgetChunk,uint256 usdtSwapped,uint256 usdtPaired,uint256 baiDesired,uint256 lpMinted,uint256 lockId,uint256 residualUSDT,uint256 residualBAI)',
    'event ObservationRecorded(uint64 indexed timestamp,uint256 priceCumulative)'
  ],
  purchaseProcessor: [
    'event DepositVaultCreated(address indexed buyer,address indexed referrer,address indexed vault)',
    'event DepositRegistered(bytes32 indexed depositId,address indexed buyer,address indexed referrer,address vault,uint256 amount,uint64 registeredAt)',
    'event DepositSettled(bytes32 indexed depositId,address indexed buyer,address indexed referrer,uint8 boxes,uint256 amount)',
    'event DepositRefunded(bytes32 indexed depositId,address indexed buyer,uint256 amount,uint8 reason)',
    'event UnregisteredTransferRefundAuthorized(bytes32 indexed depositId,address indexed buyer,address indexed vault,address reportedSender,uint256 amount)',
    'event UnregisteredTransferReturned(bytes32 indexed depositId,address indexed buyer,address indexed vault,uint256 amount)',
    'event BNBPurchase(address indexed buyer,uint8 boxes,uint256 usdtPaid,uint256 bnbSpent)'
  ],
  usdt: [
    'event Transfer(address indexed from,address indexed to,uint256 value)'
  ]
};

export const gameAbi = [
  'function vrfSubscriptionId() view returns (uint256)',
  'function s_vrfCoordinator() view returns (address)',
  'function rounds(uint64) view returns (uint64 salesClose,uint64 drawRequestedAt,uint32 boxCount,uint32 settledCount,uint256 totalUSDT,uint256 liquidityBudget,uint256 winningMask,uint256 desiredBaiPerLoser,uint256 baiRewardPerLoser,bool drawRequested,bool randomnessLoaded,bool finalized,bool liquidityBudgetReleased,uint256 rolloverUSDT,uint32 loserCount)',
  'function roundRandomnessFulfilled(uint64) view returns (bool)',
  'function requestForDay(uint64) view returns (uint256)',
  'function requestDraw(uint64)',
  'function loadRandomness(uint64)',
  'function settleBatch(uint64,uint32,uint32)',
  'function finalizeDraw(uint64)',
  'function releaseLiquidityBudget(uint64) returns (uint256)',
  'function forgeRandomnessFulfilled(uint256) view returns (bool)',
  'function syntheses(uint256) view returns (address owner,uint64 requestedAt,uint128 fee,uint8 outputTier,bool completed,bool cancelled)',
  'function completeSynthesis(uint256)',
  'function cancelExpiredSynthesis(uint256)'
];

export const freeDropAbi = [
  'function vrfSubscriptionId() view returns (uint256)',
  'function s_vrfCoordinator() view returns (address)',
  'function totalClaims() view returns (uint32)',
  'function totalSettled() view returns (uint32)',
  'function currentDayId() view returns (uint64)',
  'function drawRequested(uint64) view returns (bool)',
  'function drawRequestedAt(uint64) view returns (uint64)',
  'function drawFulfilled(uint64) view returns (bool)',
  'function requestDailyDraw(uint64)',
  'function settleBatch(uint32,uint32)'
];

export const managerAbi = [
  'function roundFunded(uint64) view returns (bool)',
  'function pendingBudget(uint64) view returns (uint256)',
  'function processLiquidity(uint64) returns (uint256)'
];

export const managerStatusAbi = [
  'function marketReady() view returns (bool)',
  'function twapStatus() view returns (bool ready,uint64 age,uint256 averagePriceX112)',
  'function observationCount() view returns (uint8)',
  'function observationInterval() view returns (uint64)',
  'function twapPeriod() view returns (uint64)',
  'function maxObservationAge() view returns (uint64)'
];

export const oracleAbi = ['function update()', 'function observationInterval() view returns (uint64)'];

export const purchaseProcessorAbi = [
  'function keeper() view returns (address)',
  'function usdtToken() view returns (address)',
  'function game() view returns (address)',
  'function predictVault(address buyer,address referrer) view returns (address)',
  'function buyerForVault(address vault) view returns (address)',
  'function referrerForVault(address vault) view returns (address)',
  'function authorizeUnregisteredTransferRefund(bytes32 depositId,address buyer,address referrer,address sender,address vault,uint256 amount)',
  'function returnUnregisteredTransfer(bytes32 depositId)',
  'function unregisteredRefunds(bytes32) view returns (address buyer,address vault,uint256 amount,bool returned)',
  'function deposits(bytes32) view returns (address buyer,address vault,address referrer,uint256 amount,uint64 registeredAt,bool settled,bool refunded)',
  'function registerDeposit(bytes32 depositId,address buyer,address referrer,address vault,uint256 amount)',
  'function settleDeposit(bytes32 depositId)',
  'function refundInvalidDeposit(bytes32 depositId)',
  'function refundExpiredDeposit(bytes32 depositId)',
  'function DEPOSIT_REFUND_DELAY() view returns (uint64)',
  'function MAX_BOXES_PER_DEPOSIT() view returns (uint8)'
];
