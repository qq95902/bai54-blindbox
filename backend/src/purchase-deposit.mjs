import { ethers } from 'ethers';

/** Apply the Keeper's policy to one on-chain registered USDT deposit. */
export async function processRegisteredDeposit({ processor, game, action, depositId, chainTimestamp }) {
  if (!processor || !depositId || !Number.isSafeInteger(chainTimestamp) || chainTimestamp < 0) {
    throw new TypeError('PROCESS_REGISTERED_DEPOSIT_ARGUMENTS_INVALID');
  }
  const item = await processor.deposits(depositId);
  if (!item.buyer || item.buyer === ethers.ZeroAddress || item.settled || item.refunded) return 'terminal';

  const amount = BigInt(item.amount);
  const price = BigInt(await game.boxPrice());
  if (price <= 0n) throw new Error('GAME_BOX_PRICE_ZERO');
  const boxes = amount / price;
  const invalidAmount = amount % price !== 0n || boxes < 1n || boxes > 10n;
  if (invalidAmount) {
    await action(`purchase:refund-invalid:${depositId}`, 'refund_invalid_usdt_deposit',
      () => processor.refundInvalidDeposit(depositId));
    return 'refund_invalid';
  }

  const refundDelay = Number(await processor.DEPOSIT_REFUND_DELAY());
  if (!Number.isSafeInteger(refundDelay) || refundDelay <= 0) throw new Error('PURCHASE_REFUND_DELAY_INVALID');
  if (chainTimestamp > Number(item.registeredAt) + refundDelay) {
    await action(`purchase:refund-expired:${depositId}`, 'refund_expired_usdt_deposit',
      () => processor.refundExpiredDeposit(depositId));
    return 'refund_expired';
  }

  await action(`purchase:settle:${depositId}`, 'settle_usdt_deposit',
    () => processor.settleDeposit(depositId));
  return 'settle';
}
