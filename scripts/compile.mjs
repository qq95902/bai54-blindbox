import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = process.cwd();
const contractsDir = path.join(root, 'contracts');
const outputDir = path.join(root, 'artifacts', 'mainnet');
const sources = {};

function addSolidityFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) addSolidityFiles(fullPath);
    else if (entry.name.endsWith('.sol')) {
      const sourceName = path.relative(root, fullPath).split(path.sep).join('/');
      sources[sourceName] = { content: fs.readFileSync(fullPath, 'utf8') };
    }
  }
}

function resolveImport(importPath) {
  const candidates = [path.resolve(root, importPath), path.resolve(root, 'node_modules', importPath)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
  }
  return { error: `Import not found: ${importPath}` };
}

addSolidityFiles(contractsDir);
const settings = {
  optimizer: { enabled: true, runs: 1 },
  viaIR: true,
  metadata: { bytecodeHash: 'none' },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
};
const input = { language: 'Solidity', sources, settings };
const result = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const errors = (result.errors || []).filter((item) => item.severity === 'error');
for (const item of result.errors || []) {
  if (item.severity === 'error') process.stderr.write(`${item.formattedMessage}\n`);
}
if (errors.length) process.exit(1);

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
const summary = { compiler: solc.version(), settings, contracts: {} };
for (const [sourceName, contracts] of Object.entries(result.contracts || {})) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!artifact.evm.bytecode.object) continue;
    const deployedBytes = artifact.evm.deployedBytecode.object.length / 2;
    const item = { contractName, sourceName, abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
    fs.writeFileSync(path.join(outputDir, `${contractName}.json`), `${JSON.stringify(item, null, 2)}\n`);
    summary.contracts[contractName] = { sourceName, deployedBytes };
    process.stdout.write(`${contractName}: ${deployedBytes} deployed bytes\n`);
    if (deployedBytes > 24_576) {
      process.stderr.write(`${contractName} exceeds the EVM deployed-code limit\n`);
      process.exitCode = 1;
    }
  }
}
fs.writeFileSync(path.join(outputDir, 'build-info.json'), `${JSON.stringify(summary, null, 2)}\n`);
