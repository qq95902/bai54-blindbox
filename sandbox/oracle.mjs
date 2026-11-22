import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';

const root = path.resolve(import.meta.dirname, '..');
const mockSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract OracleToken {
    function decimals() external pure returns (uint8) { return 18; }
}

contract OraclePair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private timestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address token0_, address token1_, uint112 reserve0_, uint112 reserve1_) {
        token0 = token0_;
        token1 = token1_;
        reserve0 = reserve0_;
        reserve1 = reserve1_;
        timestampLast = uint32(block.timestamp);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, timestampLast);
    }

    function setReserves(uint112 next0, uint112 next1) external {
        uint32 now32 = uint32(block.timestamp);
        uint32 elapsed;
        unchecked { elapsed = now32 - timestampLast; }
        if (elapsed != 0 && reserve0 != 0 && reserve1 != 0) {
            unchecked {
                price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
                price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
            }
        }
        reserve0 = next0;
        reserve1 = next1;
        timestampLast = now32;
    }
}
`;

const sources = {
  'contracts/BAIPriceOracle.sol': { content: fs.readFileSync(path.join(root, 'contracts/BAIPriceOracle.sol'), 'utf8') },
  'sandbox/OracleMocks.sol': { content: mockSource }
};
const input = {
  language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
};
function findImports(importPath) {
  const resolved = importPath.startsWith('@openzeppelin/') ? path.join(root, 'node_modules', importPath) : path.join(root, importPath);
  try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
  catch { return { error: `Import not found: ${importPath}` }; }
}
const compiled = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (compiled.errors ?? []).filter((item) => item.severity === 'error');
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));

const chainProvider = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31338, hardfork: 'shanghai' }, wallet: { totalAccounts: 2 } });
const provider = new BrowserProvider(chainProvider);
const signer = await provider.getSigner();
const report = { simulation: 'BAI TWAP oracle readiness, staleness, and spot-manipulation boundaries', assertions: 0, passed: 0, failed: 0, checks: [] };
function check(value, name) {
  if (!value) { report.failed++; throw new Error(`FAILED: ${name}`); }
  report.assertions++; report.passed++; report.checks.push(name);
}
async function deploy(source, name, args = []) {
  const item = compiled.contracts[source][name];
  const instance = await new ContractFactory(item.abi, `0x${item.evm.bytecode.object}`, signer).deploy(...args);
  await instance.waitForDeployment();
  return instance;
}
async function advance(seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}
async function expectRevert(action, name) {
  try { await action(); } catch { check(true, name); return; }
  check(false, name);
}

try {
  const bai = await deploy('sandbox/OracleMocks.sol', 'OracleToken');
  const usdt = await deploy('sandbox/OracleMocks.sol', 'OracleToken');
  const baiAddress = await bai.getAddress();
  const usdtAddress = await usdt.getAddress();
  const one = parseEther('1');
  const pair = await deploy('sandbox/OracleMocks.sol', 'OraclePair', [baiAddress, usdtAddress, 1000n * one, 2000n * one]);
  const oracle = await deploy('contracts/BAIPriceOracle.sol', 'BAIPriceOracle', [
    await pair.getAddress(), baiAddress, usdtAddress, 5, 15, 120, 1000
  ]);

  await expectRevert(() => oracle.consult(one), 'a quote is unavailable before the first valid observation');
  await (await oracle.update()).wait();
  check((await oracle.observationCount()) === 1n, 'first permissionless observation is recorded');
  await advance(15);
  const status = await oracle.twapStatus();
  check(status.ready && status.age >= 15n, 'TWAP becomes ready only after the full 15 second window');
  check((await oracle.consult(one)) === 2n * one, 'consult returns the time-weighted USDT price');
  check((await oracle.consultUSDT(one)) === one / 2n, 'inverse USDT quote uses the same TWAP');

  await (await pair.setReserves(1000n * one, 100000n * one)).wait();
  check((await oracle.consult(one)) === 2n * one, 'a same-block spot reserve jump cannot instantly change the mature TWAP');
  await advance(16);
  const mixedPrice = await oracle.consult(one);
  check(mixedPrice > 2n * one && mixedPrice < 100n * one, 'a sustained price change enters the TWAP gradually over elapsed time');

  await (await pair.setReserves(one, one)).wait();
  const shallow = await oracle.twapStatus();
  check(!shallow.ready, 'market readiness fails closed when current pool value falls below the configured floor');
  await (await pair.setReserves(1000n * one, 100000n * one)).wait();
  await advance(121);
  const stale = await oracle.twapStatus();
  check(!stale.ready, 'TWAP fails closed when the selected observation exceeds maximum age');

  console.log(JSON.stringify(report, null, 2));
} finally {
  await chainProvider.disconnect();
}
