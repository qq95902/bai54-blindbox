import { build } from 'esbuild';

await build({
  entryPoints: ['src/wallet-connect-entry.mjs'],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  outfile: 'wallet-connect.js'
});
