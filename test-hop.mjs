/**
 * 联想第二跳：语境里提到 A，才顺藤摸到用户登记过的 B（网络 → 路由器）。
 *
 * 这是同义词之外的第二类关系：
 *   - 同义词是"替换"，可以在查询时直接扩展；
 *   - 联想是"下一跳"，必须由语境激活，否则每次问网络都会把路由器相关内容拉进来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { apply } from './lib/index.js';

const configDir = path.join(os.tmpdir(), 'mr-hop-' + Date.now());
fs.mkdirSync(configDir, { recursive: true });
process.env.DSH_MEMORY_RETRIEVAL_DIR = configDir;
fs.writeFileSync(path.join(configDir, 'learned.json'), JSON.stringify({ groups: [], links: [['网络', '路由器']] }), 'utf8');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-hop-sessions-'));
process.env.DSH_SESSIONS_DIR = root;

const now = Date.now();
function makeSession(sessionId, title, messages) {
  const dir = path.join(root, '--test-workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: now - 7200_000, cwd: 'D:\\test', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })];
  if (title) lines.push(JSON.stringify({ type: 'session/title', seq: 0, time: now - 7200_000, data: { title } }));
  let seq = 1;
  for (const m of messages) {
    if (m.role === 'user') lines.push(JSON.stringify({ type: 'user/message', seq: seq++, time: m.time, data: { content: [{ type: 'text', text: m.text }], source: { kind: 'user' }, role: 'user' } }));
    else lines.push(JSON.stringify({ type: 'assistant/message', seq: seq++, time: m.time, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: m.text }] } } }));
  }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
}

// 别的会话：一段讲网络，一段讲路由器（两者不是同一件事）
makeSession('session-other', '网络与设备', [
  { role: 'user', text: '家里的网络最近特别卡，测速只有 90 兆。', time: now - 6000_000 },
  { role: 'user', text: '第 0 条无关填充：今天天气不错，顺手记一下。', time: now - 4500000 },
  { role: 'assistant', text: '第 1 条无关填充：今天天气不错，顺手记一下。', time: now - 4499000 },
  { role: 'user', text: '第 2 条无关填充：今天天气不错，顺手记一下。', time: now - 4498000 },
  { role: 'assistant', text: '第 3 条无关填充：今天天气不错，顺手记一下。', time: now - 4497000 },
  { role: 'user', text: '第 4 条无关填充：今天天气不错，顺手记一下。', time: now - 4496000 },
  { role: 'assistant', text: '第 5 条无关填充：今天天气不错，顺手记一下。', time: now - 4495000 },
  { role: 'user', text: '第 6 条无关填充：今天天气不错，顺手记一下。', time: now - 4494000 },
  { role: 'assistant', text: '第 7 条无关填充：今天天气不错，顺手记一下。', time: now - 4493000 },
  { role: 'user', text: '第 8 条无关填充：今天天气不错，顺手记一下。', time: now - 4492000 },
  { role: 'assistant', text: '第 9 条无关填充：今天天气不错，顺手记一下。', time: now - 4491000 },
  { role: 'user', text: '路由器的 WAN 口如果协商成百兆，速度就上不去，先看这个。', time: now - 2000_000 },
]);

let created;
const ctx = { on(event, cb) { if (event === 'agent/created') created = cb; }, effect(fn) { fn(); } };
apply(ctx, {
  memoryPath: '',
  enabled: true,
  collectionRetrieval: true,
  collections: [{ id: 'c-hop', name: '联想测试', sessionIds: ['session-me', 'session-other'] }],
  collectionTopK: 2,
  collectionMaxChars: 600,
  collectionPerSnippetChars: 200,
  collectionChunkChars: 60,
  relatedHops: true,
  relatedTopK: 1,
  relatedMaxChars: 300,
  selfRetrieval: false,
  minHits: 1,
  // 夹具语料很小：单个词项 idf 撑不到 1，默认 minScore 会把所有命中挡掉
  minScore: 0.3,
});

const failures = [];
let passed = 0;
const ok = (label, cond) => { if (cond) passed += 1; else failures.push(label); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

function boot(sessionId, cue) {
  const sections = new Map();
  const claims = [];
  created({
    session: { id: sessionId },
    ctx: {
      on(event, cb) { if (event === 'agent/inbox/claimed') claims.push(cb); },
      systemPrompt: { section(d) { sections.set(d.name, d); return () => {}; } },
    },
  });
  claims.forEach((fn) => fn({ sessionId, message: { content: [{ type: 'text', text: cue }] } }));
  return sections.get('memory-retrieval:collections')?.text() ?? '';
}

// ── 1. 提到「网络」→ 第二跳把「路由器」那段摸出来 ────────────────────────
{
  const text = boot('session-me', '网络卡是怎么回事');
  ok('主检索命中网络相关内容', text.includes('90 兆') || text.includes('网络最近特别卡'));
  ok('第二跳出现「顺带想起」块', text.includes('顺带想起'));
  ok('第二跳带上了联想来源', text.includes('网络'));
  ok('第二跳内容是路由器那段', text.includes('路由器的 WAN 口'));
}

// ── 2. 没提到「网络」→ 不该凭空联想 ─────────────────────────────────────
{
  const text = boot('session-me', '电池健康度怎么查');
  ok('无关话题不触发联想', !text.includes('顺带想起') && !text.includes('路由器'));
}

// ── 3. 语境里已经出现「路由器」→ 反向也能想到「网络」 ─────────────────────
{
  const text = boot('session-me', '路由器 WAN 口是什么');
  ok('反向联想也可用', text.includes('顺带想起'));
}

console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join(' / ')}` : `\n共 ${passed} 项检查通过`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
if (failures.length) process.exit(1);
console.log('HOP OK');
