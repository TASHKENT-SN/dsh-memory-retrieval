#!/usr/bin/env node
/**
 * 同义词覆盖率报告：看看现有词表（内置 + 你的 synonyms.json）到底覆盖了多少真实语料。
 *
 * 背景：内置 55 组是"常见技术/运维说法"的抽样，不是全量词库。
 * 盲猜该加哪些词没用——应该拿你自己的会话语料统计一遍：哪些高频词根本没被任何同义词组收进去。
 *
 * 用法：
 *   node tools/synonym-coverage.mjs                      # 统计 ~/.dsh/sessions 下所有会话
 *   node tools/synonym-coverage.mjs --top 30             # 列出 30 个未覆盖高频词
 *   node tools/synonym-coverage.mjs --synonyms ./syn.json  # 带上你的词表一起统计
 *   node tools/synonym-coverage.mjs --text ./corpus.txt   # 用单个文本文件代替会话日志
 *
 * 输出：
 *   - 按出现次数加权的覆盖率（不是"词表里有几个词"）
 *   - 未覆盖的高频词 top N，可直接抄进 synonyms.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GROUPS, loadSynonymGroups } from '../lib/synonyms.mjs';
import { isFunctionPair } from '../lib/collections.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 只统计有信息量的词：至少 2 个字符；纯数字丢掉 */
/** 日期、哈希、编号这类不是"词"，统计进来只会污染报告 */
const NOISE = /^(\d{4}-\d{2}-\d{2}|\d{6,}|[0-9a-f]{8,}|\d+)$/;

export function isCandidate(term) {
  if (!term || term.length < 2) return false;
  if (/^\d+$/.test(term)) return false;
  if (NOISE.test(term)) return false;
  // 「不要」「可以」「不是」这种虚词二元组不算内容词，覆盖率不该被它们稀释
  if (isFunctionPair(term)) return false;
  return true;
}

/** 词项抽取：拉丁词 + 中文二元组（和检索侧口径保持一致） */
/** 唤醒模板/时间戳这类不是用户说的话，统计进去会把报告带偏 */
const TEMPLATE = /^(\s*[【［\[]|Time sampled|Browser time zone|Elapsed since|The approval policy|A skill is)/;
/** 英文功能词 */
const EN_STOP = new Set('the and for this that with not is are was were you your it its of to in on at as by from or if then than only just have has had can will would should could'.split(' '));

export function stripTemplates(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !TEMPLATE.test(line))
    .join('\n');
}

export function termsOfText(text) {
  const out = [];
  const lowered = String(text ?? '').toLowerCase();
  for (const match of lowered.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    if (EN_STOP.has(match[0])) continue;
    if (isCandidate(match[0])) out.push(match[0]);
  }
  for (const run of lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (isCandidate(bigram)) out.push(bigram);
    }
  }
  return out;
}

/**
 * 建一个「是否被词表覆盖」的判定器。
 * 语义与检索侧一致：条目按**包含关系**匹配，所以「网速慢」在表里时，「网速」也算被覆盖。
 */
export function buildCoverage(groups) {
  const words = [];
  for (const group of groups) {
    for (const word of group) {
      const value = String(word ?? '').toLowerCase();
      if (value.length >= 2) words.push(value);
    }
  }
  return (term) => words.some((word) => word.includes(term));
}

/**
 * 统计语料。
 * @returns {{total:number, covered:number, ratio:number, uncovered:Array<{term:string,count:number}>}}
 */
export function summarize(docs, groups, { top = 20 } = {}) {
  const isCovered = buildCoverage(groups);
  const sessionDf = new Map(); // term -> 出现在几个会话里
  const occurrences = new Map();
  let total = 0;
  let covered = 0;
  for (const doc of docs) {
    const seen = new Set();
    for (const term of termsOfText(stripTemplates(doc))) {
      total += 1;
      if (isCovered(term)) covered += 1;
      else {
        occurrences.set(term, (occurrences.get(term) ?? 0) + 1);
        if (!seen.has(term)) { seen.add(term); sessionDf.set(term, (sessionDf.get(term) ?? 0) + 1); }
      }
    }
  }
  const uncovered = [...sessionDf.entries()]
    .map(([term, df]) => ({ term, count: occurrences.get(term) ?? 0, df }))
    .sort((a, b) => b.df - a.df || b.count - a.count)
    .slice(0, top);
  return { total, covered, ratio: total ? covered / total : 0, uncovered };
}

/** 读目录下所有会话日志（纯文本读取，不做 zstd 解码——用调用方传入的已解码文本更简单） */
function readSessionTexts(sessionsDir) {
  const texts = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'session.v4.jsonl.zstd') texts.push(full);
    }
  };
  walk(sessionsDir, 0);
  return texts;
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }

  const groups = args['no-builtin']
    ? []
    : [...DEFAULT_GROUPS];
  if (args.synonyms) {
    const extra = loadSynonymGroups(String(args.synonyms));
    groups.push(...extra);
  }

  let texts = [];
  if (args.text) {
    texts = [fs.readFileSync(String(args.text), 'utf8')];
  } else {
    const sessionsDir = args.sessions
      ? String(args.sessions)
      : path.join(os.homedir(), '.dsh', 'sessions');
    const files = readSessionTexts(sessionsDir);
    if (!files.length) {
      console.error(`没找到会话日志：${sessionsDir}`);
      process.exitCode = 1;
      return;
    }
    const { readSessionMessages } = await import('../lib/sessions.mjs');
    for (const file of files) {
      const sessionId = path.basename(path.dirname(file));
      try {
        const { messages } = readSessionMessages(sessionId);
        // 只统计用户自己说的话：助手的长篇报告会把统计带偏
        // 用户消息里也混着系统注入（技能目录、审批策略变更、时间戳），一并排除
        const INJECTED = /<system-reminder>|available_skills|approval policy|Time sampled|Browser time zone/;
        const userText = messages
          .filter((message) => message.role === 'user' && !INJECTED.test(String(message.text ?? '')))
          .map((message) => message.text)
          .join('\n');
        if (userText.trim()) texts.push(userText);
      } catch {
        // 单个会话读不了就跳过
      }
    }
  }

  const report = summarize(texts, groups, { top: Number(args.top) || 20 });
  const pct = (report.ratio * 100).toFixed(1);
  console.log(`语料：${texts.length} 份，词项 ${report.total} 次`);
  console.log(`词表：${groups.length} 组 / ${groups.reduce((n, g) => n + g.length, 0)} 条`);
  console.log(`覆盖率：${pct}%（按出现次数加权）`);
  if (report.uncovered.length) {
    console.log(`\n未覆盖的内容词（按出现在多少个用户消息里排序，前 ${report.uncovered.length}）：`);
    for (const { term, count, df } of report.uncovered) {
      console.log(`  ${String(df).padStart(3)} 会话 / ${String(count).padStart(5)} 次  ${term}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  });
}
