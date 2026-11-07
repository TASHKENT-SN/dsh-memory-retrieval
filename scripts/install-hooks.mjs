#!/usr/bin/env node
/**
 * 把仓库里的钩子模板装进 .git/hooks（.git 不进版本库，所以需要这一步）。
 * 用法：npm run hooks:install
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(here, 'hooks', 'pre-commit');
const dstDir = path.join(here, '.git', 'hooks');
const dst = path.join(dstDir, 'pre-commit');

if (!fs.existsSync(path.join(here, '.git'))) {
  console.error('不是 git 仓库，找不到 .git');
  process.exit(1);
}
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, dst);
try {
  fs.chmodSync(dst, 0o755);
} catch {
  // Windows 上 chmod 可能是空操作，git 自己会认 shebang
}
console.log(`已安装 pre-commit → ${dst}`);
console.log('跳过检查：git commit --no-verify');
