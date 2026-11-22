import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const clientSource = fs.readFileSync(new URL('../purchase-vault-client.js', import.meta.url), 'utf8');
const frontendSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const context = { AbortSignal };
vm.runInNewContext(clientSource, context, { filename: 'purchase-vault-client.js' });
const client = context.BAI_PURCHASE_CLIENT;
const buyer = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const referrer = '0x0000000000000000000000000000000000000000';
const vault = '0x7777777777777777777777777777777777777777';
const base = { apiBaseUrl: 'https://api.example.com/', buyer, referrer, chainId: 97, predictedVault: vault };
let assertions = 0;
function check(actual, expected, message) { assert.equal(actual, expected, message); assertions++; }
async function rejects(promise, pattern, message) { await assert.rejects(promise, pattern, message); assertions++; }
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const challengeId = 'a'.repeat(64);
const challengeMessage = 'BAI Blind Box\nAction: Create a buyer-bound USDT deposit address';
const signature = `0x${'ab'.repeat(65)}`;
const validChallenge = { challengeId, message: challengeMessage, expiresAt: new Date(Date.now() + 60_000).toISOString(), chainId: 97 };

try {
  let request;
  const requests = [];
  let signedMessage;
  const registered = await client.registerDepositAddress({
    ...base,
    signMessage: async (message) => { signedMessage = message; return signature; },
    fetchImpl: async (url, options) => {
      request = { url, options };
      requests.push(request);
      return requests.length === 1 ? reply(validChallenge) : reply({ buyer, referrer, vault, chainId: 97 });
    }
  });
  check(registered, vault, 'valid backend registration returns the chain-predicted vault');
  check(request.url, 'https://api.example.com/v1/deposit-address', 'registration targets the public API before payment');
  check(request.options.method, 'POST', 'vault registration is persisted with POST');
  check(JSON.parse(request.options.body).buyer, buyer, 'the registered vault is bound to the connected buyer');
  check(requests[0].url, 'https://api.example.com/v1/deposit-challenge', 'wallet proof is requested only when creating a deposit address');
  check(signedMessage, challengeMessage, 'wallet signs the exact short-lived server challenge');
  check(JSON.parse(request.options.body).signature, signature, 'the one-time signature accompanies address registration');

  await rejects(client.registerDepositAddress({ ...base, signMessage: async () => signature, fetchImpl: async () => reply({ ...validChallenge, chainId: 56 }) }), /no payment was sent/,
    'wrong-chain API response is rejected');
  await rejects(client.registerDepositAddress({ ...base, signMessage: async () => signature, fetchImpl: async (url) => url.endsWith('/v1/deposit-challenge') ? reply(validChallenge) : reply({ buyer: referrer, referrer, vault, chainId: 97 }) }), /does not match the chain/,
    'wrong buyer API response is rejected');
  await rejects(client.registerDepositAddress({ ...base, signMessage: async () => signature, fetchImpl: async (url) => url.endsWith('/v1/deposit-challenge') ? reply(validChallenge) : reply({ buyer, referrer, vault: buyer, chainId: 97 }) }), /does not match the chain/,
    'wrong-vault API response is rejected');
  let referralConflictCalls = 0;
  await rejects(client.registerDepositAddress({ ...base, signMessage: async () => signature, fetchImpl: async (url) => {
    referralConflictCalls++;
    return url.endsWith('/v1/deposit-challenge') ? reply(validChallenge) : reply({ error: 'buyer_referrer_already_bound' }, 409);
  } }), /已绑定|already bound/,
    'referral-binding conflict stops before wallet transfer');
  check(referralConflictCalls, 2, 'the API conflict is surfaced after challenge signing but still before any USDT transfer');
  await rejects(client.registerDepositAddress({ ...base, signMessage: async () => signature, fetchImpl: async () => { throw new Error('Failed to fetch'); } }), /Failed to fetch/,
    'API network failure stops before wallet transfer');

  const usdtFlowStart = frontendSource.indexOf("if(method==='USDT'){");
  const registerAt = frontendSource.indexOf('registerDepositAddress(', usdtFlowStart);
  const transferAt = frontendSource.indexOf("hash=await sendTx(USDT,", usdtFlowStart);
  assert.ok(usdtFlowStart >= 0 && registerAt > usdtFlowStart && transferAt > registerAt,
    'frontend registers and validates the vault before asking the wallet to transfer USDT');
  assertions++;
  assert.ok(frontendSource.includes("rpc('personal_sign'") && frontendSource.includes("methods:['eth_sendTransaction','personal_sign']"),
    'the wallet only receives the message-signing request as part of an explicit USDT address-creation flow');
  assertions++;
  const connectFlowStart = frontendSource.indexOf('async function connectWalletConnect(');
  const connectFlowEnd = frontendSource.indexOf('async function connectBinanceWeb3Legacy', connectFlowStart);
  assert.ok(connectFlowStart >= 0 && connectFlowEnd > connectFlowStart && !frontendSource.slice(connectFlowStart, connectFlowEnd).includes("rpc('personal_sign'"),
    'wallet connection itself does not request a message signature');
  assertions++;
  check(frontendSource.includes('USDT service not configured'), true, 'USDT purchase is gated when the order API origin is missing');
  check(frontendSource.includes('activateReferralVault'), false, 'referral sharing does not require a nonexistent vault-activation transaction');
  check(frontendSource.includes("sendTx(PURCHASE_PROCESSOR,'0xeb72d084'"), true, 'BNB purchases call the current processor buyWithBNB selector');
  check(frontendSource.includes("sendTx(GAME,'0xf75c2a11'"), false, 'the obsolete game-contract BNB purchase selector is removed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

if (!process.exitCode) console.log(JSON.stringify({ simulation: 'Frontend buyer-bound USDT vault registration gate', assertions, passed: assertions, failed: 0 }, null, 2));
