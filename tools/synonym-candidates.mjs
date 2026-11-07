#!/usr/bin/env node
/**
 * 从本地语料里挖「同义词候选」。
 *
 * 试过两条路，结论先写在这：
 *   1. **按二元组算覆盖率**：没有意义。中文里出现最多的永远是「自己/可以/因为」这类泛词，
 *      它们不需要同义词，覆盖率数字只会被它们稀释（实测 2.5%，且 top 全是这类词）。
 *   2. **按「X，也叫 Y」抽取**：不引号锚定时精度很差——中文没有词边界，
 *      正则会连动宾短语一起抓进来（「保存 ≈ 清空」「出头 ≈ 两百万」）。
 *
 * 所以只保留高精度的一类：**带引号的术语**。「X」（也叫「Y」）这种写法里，
 * 引号本身就是天然边界，几乎不会误抓。产量低，但基本都是真的。
 *
 * 用法：
 *   node tools/synonym-candidates.mjs            # 扫 ~/.dsh/sessions
 *   node tools/synonym-candidates.mjs --top 40
 *   node tools/synonym-candidates.mjs --out ./candidates.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const OPEN = '「『“"`\'（(\\[《';
const CLOSE = '」』”"`\'）)\\]》';

/** 引号包住的短词；两侧引号必须是同一类，这里放宽为"任意闭引号"也能用 */
function quoted(body) {
  return `[${OPEN}]${body}[${CLOSE}]`;
}

const CONNECTORS = '也叫|又称|也叫作|又叫|俗称|简称|也就是|即';

const PATTERNS = [
  // 「X」（也叫「Y」）
  new RegExp(`${quoted('([^' + CLOSE + ']{2,12})')}\\s*[（(]\\s*(?:${CONNECTORS})\\s*${quoted('([^' + CLOSE + ']{2,12})')}\\s*[）)]`, 'g'),
  // 「X」，也叫「Y」
  new RegExp(`${quoted('([^' + CLOSE + ']{2,12})')}\\s*[，,]\\s*(?:${CONNECTORS})\\s*${quoted('([^' + CLOSE + ']{2,12})')}`, 'g'),
  // X（也叫 Y）—— X 是英文/数字术语时边界清楚，可以不加引号
  new RegExp(`(?<=^|[\\s，。；：、！？）】\\]"'])([A-Za-z][A-Za-z0-9._+-]{1,15})\\s*[（(]\\s*(?:${CONNECTORS})\\s*([^）)]{2,24}?)\\s*[）)]`, 'g'),
];

// 允许别名里带单个空格（"DeepSeek Harness"），否则英文全称会被丢掉
const MIN_LEN = 2;
const MAX_LEN = 24; // 「DeepSeek Harness」这种全称要能进来

const WORD = /^[\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9._+ -]*$/;

function acceptable(word) {
  if (!word) return false;
  const value = word.trim();
  if (value.length < MIN_LEN || value.length > MAX_LEN) return false;
  if (!WORD.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  return true;
}

/**
 * 从一段文本里抽取候选同义词对。
 * @returns {{groups: string[][], hits: Array<{a:string,b:string,context:string}>}}
 */
export function extractPairs(text) {
  const groups = new Map();
  const hits = [];
  const source = String(text ?? '');
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const a = match[1]?.trim();
      const b = match[2]?.trim();
      if (!acceptable(a) || !acceptable(b) || a === b) continue;
      const key = [a, b].sort().join('\u0001');
      if (groups.has(key)) continue;
      groups.set(key, [a, b]);
      const at = Math.max(0, match.index - 24);
      hits.push({ a, b, context: source.slice(at, match.index + match[0].length + 12).replace(/\s+/g, ' ') });
    }
  }
  return { groups: [...groups.values()], hits };
}

function readSessionIds(sessionsDir) {
  const ids = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'session.v4.jsonl.zstd') ids.push(path.basename(path.dirname(full)));
    }
  };
  walk(sessionsDir, 0);
  return ids;
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }

  let texts = [];
  if (args.text) {
    texts = [fs.readFileSync(String(args.text), 'utf8')];
  } else {
    const sessionsDir = args.sessions ? String(args.sessions) : path.join(os.homedir(), '.dsh', 'sessions');
    const ids = readSessionIds(sessionsDir);
    if (!ids.length) {
      console.error(`没找到会话日志：${sessionsDir}`);
      process.exitCode = 1;
      return;
    }
    const { readSessionMessages } = await import('../lib/sessions.mjs');
    for (const id of ids) {
      try {
        const { messages } = readSessionMessages(id);
        texts.push(messages.map((message) => message.text).join('\n'));
      } catch { /* 单个会话读不了就跳过 */ }
    }
  }

  const merged = new Map();
  const hits = [];
  for (const text of texts) {
    const result = extractPairs(text);
    for (const group of result.groups) merged.set([...group].sort().join('\u0001'), group);
    hits.push(...result.hits);
  }
  let groups = [...merged.values()];
  const limit = Number(args.top) || 0;
  if (limit) groups = groups.slice(0, limit);

  console.log(`扫了 ${texts.length} 份语料，找到 ${merged.size} 组带引号的等价表述`);
  for (const group of groups) console.log(`  ${group.join('  ≈  ')}`);
  if (!merged.size) {
    console.log('\n没有命中：说明你的语料里没有人用「X（也叫 Y）」这种写法。');
    console.log('这种情况下，词表只能靠人工补，或导入外部词库（tools/import-synonyms.mjs）。');
  }

  const out = args.out ? String(args.out) : '';
  if (out) {
    fs.writeFileSync(out, `${JSON.stringify({ groups }, null, 2)}\n`, 'utf8');
    console.log(`\n已写入 ${out}（格式与 synonyms.json 一致，确认后再合并）`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  });
}
