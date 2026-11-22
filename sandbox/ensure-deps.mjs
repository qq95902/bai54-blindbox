import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sandboxDirectory = import.meta.dirname;
const ganacheManifest = path.join(sandboxDirectory, 'node_modules', 'ganache', 'package.json');

if (!fs.existsSync(ganacheManifest)) {
  process.stdout.write('Installing isolated local-sandbox dependencies...\n');
  execFileSync('npm', [
    'ci', '--prefix', sandboxDirectory, '--ignore-scripts', '--no-audit', '--no-fund'
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache || path.join(os.tmpdir(), 'bai-sandbox-npm-cache')
    }
  });
}
