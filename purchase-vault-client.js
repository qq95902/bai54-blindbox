(() => {
  const addressPattern = /^0x[\da-f]{40}$/i;
  const errorMessages = {
    rate_limited: ['请求过于频繁，请稍后再试。', 'Too many requests. Try again shortly.'],
    deposit_signature_expired_or_mismatched: ['签名请求已过期或与当前钱包/邀请人不匹配，请重试。', 'The signing request expired or does not match this wallet and referrer. Try again.'],
    deposit_signature_invalid: ['钱包签名验证失败，请确认使用当前连接的钱包。', 'Wallet signature verification failed. Confirm the connected wallet and try again.'],
    deposit_signature_already_used: ['此签名已使用，请重新发起购买。', 'This signature was already used. Start the purchase again.'],
    deposit_signature_origin_mismatch: ['签名来源与当前网站不匹配，请刷新页面后重试。', 'The signature origin does not match this site. Refresh and try again.'],
    valid_deposit_signature_required: ['收款地址需要有效的钱包消息签名，本次未扣款。', 'A valid wallet message signature is required for this deposit address; no payment was sent.'],
    public_site_origin_not_configured: ['服务尚未配置网站来源，请联系项目方。', 'The service has no configured site origin. Contact the project team.'],
    referrer_not_eligible: ['邀请人尚未购买过盲盒，不能绑定为邀请人。', 'The inviter has not purchased a box and is not eligible.'],
    buyer_referrer_already_bound: ['本钱包已绑定其他邀请人，不能更改。', 'This wallet is already bound to a different inviter.'],
    self_referral_not_allowed: ['不能填写自己的钱包地址作为邀请人。', 'You cannot refer yourself.']
  };

  async function registerDepositAddress({ apiBaseUrl, buyer, referrer, chainId, predictedVault, signMessage, language = 'zh', fetchImpl = fetch }) {
    const base = String(apiBaseUrl || '').replace(/\/$/, '');
    const validAddress = (value) => addressPattern.test(String(value || ''));
    if (!base || !validAddress(buyer) || !validAddress(referrer) || !validAddress(predictedVault) || !Number.isSafeInteger(Number(chainId))) {
      throw new Error('订单金库登记参数无效，本次未扣款。 / Invalid order-vault registration parameters; no payment was sent.');
    }

    if (typeof signMessage !== 'function') throw new Error('请在钱包中签署一次收款地址验证消息；不会花费 Gas 或授权代币。 / Sign one deposit-address verification message in your wallet; this costs no gas and grants no token allowance.');
    const requestOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ buyer, referrer }),
      cache: 'no-store'
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') requestOptions.signal = AbortSignal.timeout(12000);
    const challengeResponse = await fetchImpl(`${base}/v1/deposit-challenge`, requestOptions);
    const challenge = await challengeResponse.json().catch(() => ({}));
    if (!challengeResponse.ok || Number(challenge.chainId) !== Number(chainId) ||
        !/^[A-Za-z0-9_-]{1,1900}\.[0-9a-f]{64}$/i.test(String(challenge.challengeId || '')) || typeof challenge.message !== 'string' ||
        !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) {
      const message = errorMessages[challenge.error];
      throw new Error(message ? message[language === 'en' ? 1 : 0] : `收款地址验证请求失败（${challenge.error || `HTTP ${challengeResponse.status}`}）；本次未扣款。 / Could not create the deposit-address challenge; no payment was sent.`);
    }
    const signature = await signMessage(challenge.message);
    if (!/^0x[0-9a-f]{130}$/i.test(String(signature || ''))) throw new Error('钱包返回的签名格式无效，本次未扣款。 / The wallet returned an invalid signature; no payment was sent.');
    const registrationOptions = { ...requestOptions, body: JSON.stringify({ buyer, referrer, challengeId: challenge.challengeId, signature }) };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') registrationOptions.signal = AbortSignal.timeout(12000);
    const response = await fetchImpl(`${base}/v1/deposit-address`, {
      ...registrationOptions
    });
    const registration = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = errorMessages[registration.error];
      throw new Error(message ? message[language === 'en' ? 1 : 0] : `订单金库登记失败（${registration.error || `HTTP ${response.status}`}），本次未扣款。 / Order vault registration failed; no payment was sent.`);
    }
    if (Number(registration.chainId) !== Number(chainId) || registration.buyer?.toLowerCase() !== buyer.toLowerCase() ||
        registration.referrer?.toLowerCase() !== referrer.toLowerCase() || !validAddress(registration.vault) ||
        registration.vault.toLowerCase() !== predictedVault.toLowerCase()) {
      throw new Error('订单服务返回的钱包、网络或收款金库与链上信息不匹配，本次未扣款。 / The API returned a wallet, network, or vault that does not match the chain; no payment was sent.');
    }
    return registration.vault;
  }

  globalThis.BAI_PURCHASE_CLIENT = Object.freeze({ registerDepositAddress });
})();
