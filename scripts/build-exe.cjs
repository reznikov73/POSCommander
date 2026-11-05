const { spawnSync } = require('child_process');
const path = require('path');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const output = path.join(process.cwd(), 'release', `build-${stamp}`);
const cli = require.resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [
  cli,
  '--win',
  'nsis',
  '--x64',
  `--config.directories.output=${output}`,
], { stdio: 'inherit', windowsHide: true });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
