/**
 * `memory_links` 的测试：模型自己往词表里加同义词。
 *
 * 这是「让模型干语义活」的落点：统计方法在个人语料上失败（见 README），
 * 由模型判断"这两个词是不是一回事"，工具只负责合并、去重、落盘、立即生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWordsTool } from './lib/words-tool.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-words-'));
const learnedPath = path.join(dir, 'learned.json');

const failures = [];
let passed = 0;
const ok = (label, cond) => { if (cond) passed += 1; else failures.push(label); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

let definition = null;
const tools = { register: (def) => { definition = def; return () => {}; } };
const runtime = { cfg: { synonymsEnabled: true, synonymPath: '' }, synonymGroups: [], synonymMap: null };
const diagLines = [];

await registerWordsTool({ tools, learnedPath, runtime, diag: (m) => diagLines.push(m) });

ok('工具注册成功', definition && definition.name === 'memory_links');
ok('声明了 words 参数', Boolean(definition?.parameters?.words ?? definition?.parameters?.properties?.words));
ok('声明了 kind 参数（同义 vs 联想）', Boolean(definition?.parameters?.kind ?? definition?.parameters?.properties?.kind));

const run = (args) => definition.execute(args, { agent: { session: { id: 's1' } } });

// ── 1. 正常加词 ──────────────────────────────────────────────────────────
{
  const out = await run({ words: '网速慢, 卡顿 延迟', note: '用户习惯说网速慢' });
  ok('返回已记住', String(out).includes('已记住'));
  const saved = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  ok('写入 learned.json 一组三个词', saved.groups.length === 1 && saved.groups[0].length === 3);
  ok('立即生效：运行时映射里有卡顿', runtime.synonymMap?.has('卡顿') === true);
  ok('立即生效：卡顿能扩到网速慢', runtime.synonymMap?.get('卡顿')?.has('网速慢') === true);
}

// ── 2. 与已有组有交集时并进去，而不是新建一组 ────────────────────────────
{
  await run({ words: '延迟,掉帧' });
  const saved = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  ok('交集词被合并成一组', saved.groups.length === 1 && saved.groups[0].includes('掉帧'));
}

// ── 3. 词太少要拒绝 ─────────────────────────────────────────────────────
{
  const out = await run({ words: '卡顿' });
  ok('只给一个词时拒绝并提示', String(out).includes('至少'));
}

// ── 4. list 模式 ────────────────────────────────────────────────────────
{
  const out = await run({ list: true });
  ok('list 能列出已学的组', String(out).includes('卡顿') && String(out).includes('≈'));
}

// ── 5. 重复加同一组不会产生两份 ──────────────────────────────────────────
{
  await run({ words: '卡顿,延迟' });
  const saved = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  ok('重复添加不会重复建组', saved.groups.length === 1);
}

console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join(' / ')}` : `\n共 ${passed} 项检查通过`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
if (failures.length) process.exit(1);
console.log('WORDS OK');

// ── 6. kind=related：联想对（不可互换，但可以顺着想到） ──────────────────
{
  const out = await run({ words: '网络,路由器', kind: 'related' });
  ok('联想对写入成功', String(out).includes('联想'));
  const saved = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  ok('存在 links 数组', Array.isArray(saved.links) && saved.links.length === 1);
  ok('联想对里是网络与路由器', saved.links[0].includes('网络') && saved.links[0].includes('路由器'));

  const listOut = await run({ list: true });
  ok('list 能区分同义词与联想', String(listOut).includes('→'));

  const bad = await run({ words: '网络,路由器,光猫', kind: 'related' });
  ok('联想只接受两个词', String(bad).includes('一对'));
}

console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join(' / ')}` : `\n共 ${passed} 项检查通过`);
if (failures.length) process.exit(1);
console.log('WORDS OK');
