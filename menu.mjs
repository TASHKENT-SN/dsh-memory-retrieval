#!/usr/bin/env node
/**
 * dsh-memory-retrieval 设置菜单。
 *
 *   node menu.mjs               交互菜单
 *   node menu.mjs --show        打印当前配置
 *   node menu.mjs --set topK=8  改一项（可重复 --set）
 *
 * 配置写入 ~/.dsh/dsh-memory-retrieval/config.json；
 * 插件在下次加载/重启 DSH 时读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { defaultMemoryPath } from './lib/retrieval.mjs';
import { defaultConfig, normalizeConfig, readUserConfig, userConfigPath, writeUserConfig } from './lib/config.mjs';

const argv = process.argv.slice(2);

function resolvedMemoryPath(cfg) {
  const raw = String(cfg.memoryPath || '').trim();
  if (!raw) return defaultMemoryPath();
  return raw.startsWith('~/') ? path.join(process.env.USERPROFILE || process.env.HOME || '.', raw.slice(2)) : path.resolve(raw);
}

function parseValue(key, raw) {
  if (key === 'enabled' || key === 'askWhenUnsure') {
    if (/^(1|true|on|yes|y)$/i.test(raw)) return true;
    if (/^(0|false|off|no|n)$/i.test(raw)) return false;
    throw new Error(`${key} 需要 true/false`);
  }
  if (['topK', 'maxChars', 'minScore', 'perRecordChars'].includes(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${key} 需要数字`);
    return n;
  }
  if (['includeSessionPatterns', 'excludeSessionPatterns'].includes(key)) {
    return raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!(key in defaultConfig())) throw new Error(`未知配置项：${key}`);
  return raw;
}

function setOne(cfg, key, raw) {
  const next = { ...cfg, [key]: parseValue(key, raw) };
  return normalizeConfig(next);
}

if (argv.includes('--show')) {
  const cfg = readUserConfig();
  console.log(JSON.stringify({ ...cfg, effectiveMemoryPath: resolvedMemoryPath(cfg), configFile: userConfigPath() }, null, 2));
  process.exit(0);
}

if (argv.includes('--set')) {
  let cfg = readUserConfig();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--set') continue;
    const pair = argv[i + 1] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error('--set 用法：--set key=value');
    cfg = setOne(cfg, pair.slice(0, eq), pair.slice(eq + 1));
  }
  const saved = writeUserConfig(cfg);
  console.log(JSON.stringify({ ...saved, effectiveMemoryPath: resolvedMemoryPath(saved), configFile: userConfigPath() }, null, 2));
  process.exit(0);
}

function line(label, value) {
  return `${label.padEnd(4)} ${value}`;
}

function show(cfg) {
  const memory = resolvedMemoryPath(cfg);
  let count = '（文件不存在）';
  try {
    count = `${fs.readFileSync(memory, 'utf8').split('\n').filter(Boolean).length} 条`;
  } catch {}
  console.log('');
  console.log('=== dsh-memory-retrieval 设置 ===');
  console.log(line('1.', `总开关：${cfg.enabled ? '开' : '关'}`));
  console.log(line('2.', `标签：${cfg.label}`));
  console.log(line('3.', `记忆文件：${memory}（${count}）`));
  console.log(line('4.', `topK：${cfg.topK}`));
  console.log(line('5.', `maxChars：${cfg.maxChars}`));
  console.log(line('6.', `minScore：${cfg.minScore}`));
  console.log(line('7.', `单条截断：${cfg.perRecordChars} 字`));
  console.log(line('8.', `拿不准时询问用户：${cfg.askWhenUnsure ? '开' : '关'}`));
  console.log(line('9.', `只在这些会话启用：${cfg.includeSessionPatterns.join(', ') || '（全部）'}`));
  console.log(line('10.', `排除这些会话：${cfg.excludeSessionPatterns.join(', ') || '（无）'}`));
  console.log(line('11.', '保存并退出'));
  console.log(line('0.', '退出不保存'));
  console.log('');
}

async function askNumber(rl, label, current, min, max) {
  const answer = (await rl.question(`${label} [${current}]：`)).trim();
  if (!answer) return current;
  const n = Number(answer);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} 需要在 ${min}~${max} 之间`);
  return n;
}

async function main() {
  let cfg = readUserConfig();
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      show(cfg);
      const choice = (await rl.question('选择要修改的项，回车=保存退出：')).trim();
      if (!choice || choice === '11') {
        writeUserConfig(cfg);
        console.log(`已保存：${userConfigPath()}\n重启 DSH 后生效。`);
        return;
      }
      if (choice === '0' || choice.toLowerCase() === 'q') {
        console.log('未保存。');
        return;
      }
      try {
        if (choice === '1') cfg = { ...cfg, enabled: !cfg.enabled };
        else if (choice === '2') {
          const v = (await rl.question(`标签 [${cfg.label}]：`)).trim();
          if (v) cfg = { ...cfg, label: v };
        } else if (choice === '3') {
          const v = (await rl.question(`记忆文件（留空=默认 ${defaultMemoryPath()}）：`)).trim();
          cfg = { ...cfg, memoryPath: v };
        } else if (choice === '4') cfg = { ...cfg, topK: await askNumber(rl, 'topK', cfg.topK, 1, 20) };
        else if (choice === '5') cfg = { ...cfg, maxChars: await askNumber(rl, 'maxChars', cfg.maxChars, 200, 4000) };
        else if (choice === '6') cfg = { ...cfg, minScore: await askNumber(rl, 'minScore', cfg.minScore, 0, 100) };
        else if (choice === '7') cfg = { ...cfg, perRecordChars: await askNumber(rl, '单条截断字数', cfg.perRecordChars, 60, 1000) };
        else if (choice === '8') cfg = { ...cfg, askWhenUnsure: !cfg.askWhenUnsure };
        else if (choice === '9') {
          const v = (await rl.question('只在这些会话启用（正则，逗号分隔，留空=全部）：')).trim();
          cfg = { ...cfg, includeSessionPatterns: v ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [] };
        } else if (choice === '10') {
          const v = (await rl.question('排除这些会话（正则，逗号分隔，留空=无）：')).trim();
          cfg = { ...cfg, excludeSessionPatterns: v ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [] };
        } else {
          console.log('没有这个选项。');
          continue;
        }
        cfg = normalizeConfig(cfg);
        for (const pattern of [...cfg.includeSessionPatterns, ...cfg.excludeSessionPatterns]) {
          try { new RegExp(pattern); } catch { throw new Error(`无效正则：${pattern}`); }
        }
      } catch (error) {
        console.log(`修改失败：${error?.message ?? error}`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
