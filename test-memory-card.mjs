/**
 * 全量记忆卡的两种落盘形态：
 *   - .json  一个数组或 { records: [...] }
 *   - .jsonl 一行一条（全量归档用这种，818 条）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMemoryCard } from './lib/memory-card.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-card-'));
const failures = [];
function ok(label, pass) {
  if (!pass) failures.push(label);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
}

const rec = (i, text) => ({ id: `m${i}`, title: `标题${i}`, text, tags: ['t'], importance: i });

// 1) 普通 JSON 数组
const jsonFile = path.join(dir, 'card.json');
fs.writeFileSync(jsonFile, JSON.stringify([rec(1, '第一条'), rec(2, '第二条')]), 'utf8');
ok('JSON 数组读得出 2 条', loadMemoryCard(jsonFile).length === 2);

// 2) { records: [...] }
const wrapped = path.join(dir, 'card-records.json');
fs.writeFileSync(wrapped, JSON.stringify({ records: [rec(1, 'a'), rec(2, 'b'), rec(3, 'c')] }), 'utf8');
ok('{ records } 读得出 3 条', loadMemoryCard(wrapped).length === 3);

// 3) JSONL：一行一条
const jsonl = path.join(dir, 'card-full.jsonl');
const lines = [];
for (let i = 1; i <= 50; i += 1) lines.push(JSON.stringify(rec(i, `全量第 ${i} 条`)));
fs.writeFileSync(jsonl, `${lines.join('\n')}\n`, 'utf8');
ok('JSONL 读得出 50 条', loadMemoryCard(jsonl).length === 50);

// 4) JSONL 里的坏行被跳过，不影响其它行
const broken = path.join(dir, 'card-broken.jsonl');
fs.writeFileSync(broken, `${JSON.stringify(rec(1, 'ok'))}\n{坏行\n${JSON.stringify(rec(2, 'ok2'))}\n`, 'utf8');
ok('JSONL 坏行跳过、其余照读', loadMemoryCard(broken).length === 2);

// 5) 归档记录里的关键字段被归一化
const sample = loadMemoryCard(jsonl)[0];
ok('取到了正文', sample.text.includes('全量第 1 条'));
ok('取到了 id', sample.id === 'm1');
ok('tags 保留了', Array.isArray(sample.tags) && sample.tags.includes('t'));

// 6) 空文件 / 不存在
const empty = path.join(dir, 'empty.jsonl');
fs.writeFileSync(empty, '', 'utf8');
ok('空文件返回空数组', loadMemoryCard(empty).length === 0);
ok('不存在的文件返回空数组', loadMemoryCard(path.join(dir, 'nope.json')).length === 0);

// 7) 缓存命中：改文件后 mtime/size 变化应重新读
const cacheFile = path.join(dir, 'cache.jsonl');
fs.writeFileSync(cacheFile, `${JSON.stringify(rec(1, 'x'))}\n`, 'utf8');
const first = loadMemoryCard(cacheFile).length;
fs.writeFileSync(cacheFile, `${JSON.stringify(rec(1, 'x'))}\n${JSON.stringify(rec(2, 'y'))}\n`, 'utf8');
ok('文件变化后缓存失效', first === 1 && loadMemoryCard(cacheFile).length === 2);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} 项失败：\n- ${failures.join('\n- ')}` : '\nCARD OK');
if (failures.length) process.exit(1);
