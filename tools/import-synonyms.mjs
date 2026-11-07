#!/usr/bin/env node
/**
 * 把外部同义词表转成本插件的 synonyms.json。
 *
 * 设计前提：**本仓库不附带任何第三方词库**。用户自己按对方许可取得数据，
 * 再用这个脚本转换成本地文件。脚本只做格式转换，不联网、不内置任何词表内容。
 *
 * 支持三种输入：
 *   1. 词林风格：每行 "Aa01A01= 人 士 人物 人士"
 *   2. 纯文本：每行一组，"安装 部署 装好"（空格/制表符/逗号/顿号分隔）
 *   3. 本插件输出格式：{"groups": [["安装","部署"], ...]}
 *
 * 用法：
 *   node tools/import-synonyms.mjs --in ./cilin.txt --out ~/.dsh/dsh-memory-retrieval/synonyms.json
 *   node tools/import-synonyms.mjs --in ./words.txt --out E:/dsh/synonyms.json --max-group 6
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_GROUPS } from '../lib/synonyms.mjs';

/** 词林那种 "Aa01A01=" / "Aa01A01=" 编码前缀 */
const CODE_PREFIX = /^[A-Za-z][A-Za-z0-9]{2,}[=@#]?\s+/;
/** 只接受中文、字母、数字、连字符、下划线组成的词 */
const WORD = /^[\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9_-]*$/;

export function normalizeWord(raw) {
  const word = String(raw ?? '')
    .trim()
    .replace(/^[*^#\s]+/, '')
    .replace(/[，,、;；]+$/, '');
  if (!word || word.length < 2 || word.length > 12) return '';
  if (!WORD.test(word)) return '';
  return word.toLowerCase();
}

/** 一行拆词：兼容词林的行内空格、逗号分隔、顿号分隔 */
export function splitLine(line) {
  const text = String(line ?? '')
    .replace(CODE_PREFIX, '')
    .replace(/^\s*[A-Za-z][A-Za-z0-9]{2,}[=@#]?\s*$/, '')
    .trim();
  if (!text || text.startsWith('#')) return [];
  return text
    .split(/[\s,，、;；|\/]+/)
    .map(normalizeWord)
    .filter(Boolean);
}

/**
 * 把可能很大的组切成若干小组，避免一个词扩出几十个变体。
 * @param {string[][]} groups 原始分组
 * @param {{maxGroup?: number}} options
 */
export function convert(groups, options = {}) {
  const maxGroup = Math.max(2, Number(options.maxGroup) || 6);
  const out = [];
  const seen = new Set();

  for (const group of groups) {
    const words = [...new Set((group || []).map(normalizeWord).filter(Boolean))];
    if (words.length < 2) continue;
    // 大组按 maxGroup 切块，每块内两两互为同义
    for (let i = 0; i < words.length; i += maxGroup) {
      const chunk = words.slice(i, i + maxGroup);
      if (chunk.length < 2) continue;
      const key = [...chunk].sort().join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(chunk);
    }
  }
  return out;
}

export function parseInput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    const groups = Array.isArray(parsed) ? parsed : parsed?.groups;
    if (!Array.isArray(groups)) throw new Error('JSON 里没有 groups 数组');
    return groups.map((group) => (Array.isArray(group) ? group.map(String) : []));
  }
  return trimmed.split(/\r?\n/).map(splitLine).filter((words) => words.length >= 2);
}

function expandPath(file) {
  const raw = String(file ?? '');
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  if (!args.in || !args.out) {
    console.error('用法: node tools/import-synonyms.mjs --in <源文件> --out <synonyms.json> [--max-group 6]');
    process.exit(1);
  }
  const inputPath = expandPath(args.in);
  const outputPath = expandPath(args.out);
  const text = fs.readFileSync(inputPath, 'utf8');
  const groups = convert(parseInput(text), { maxGroup: Number(args['max-group']) || 6 });
  if (!groups.length) {
    console.error('没有解析出任何同义词组；检查文件格式（每行一组，或词林格式）。');
    process.exit(2);
  }
  // 默认把内置技术词表并进来：词林这类通用语料缺「卡顿 / 报错 / 网速」等新词
  const merged = args['no-merge-builtin']
    ? groups
    : [...DEFAULT_GROUPS.map((group) => group.map((word) => word.toLowerCase())), ...groups];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({ groups: merged }, null, 2)}\n`, 'utf8');
  const words = new Set(merged.flat());
  console.log(`已写入 ${outputPath}`);
  console.log(`  组数 ${merged.length} · 词条 ${words.size} · 每组最多 ${Number(args['max-group']) || 6} 个词`);
  if (!args['no-merge-builtin']) console.log(`  （已并入内置 ${DEFAULT_GROUPS.length} 组技术词；加 --no-merge-builtin 可关闭）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main(process.argv.slice(2));
}
