import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSession, makeSessionsRoot } from './test-fixtures.mjs';
import { apply } from './lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(HERE, '.test-config');
fs.mkdirSync(configDir, { recursive: true });
process.env.DSH_MEMORY_RETRIEVAL_DIR = configDir;
// 测试产物不留在仓库里
process.once('exit', () => { try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {} });

const sessionsRoot = makeSessionsRoot(HERE);
process.env.DSH_SESSIONS_DIR = sessionsRoot;

makeSession(sessionsRoot, 'session-other', {
  title: '售后政策会话',
  messages: [
    { role: 'user', text: '我们的退款政策是什么？' },
    { role: 'assistant', text: '退款政策是 7 天内无理由，超过 7 天需要走人工审核。' },
  ],
});

const memoryFile = path.join(HERE, 'memory.test.jsonl');
fs.copyFileSync(path.join(HERE, 'memory.example.jsonl'), memoryFile);

let created;
const ctx = {
  on(event, callback) { if (event === 'agent/created') created = callback; },
  effect(fn) { fn(); },
};

apply(ctx, {
  memoryPath: memoryFile,
  label: 'TestMemory',
  topK: 5,
  maxChars: 800,
  excludeSessionPatterns: ['^session-excluded$'],
  collections: [{ id: 'col-1', name: '售后集合', sessionIds: ['session-ok', 'session-other'] }],
});

/** 注册一个 agent，返回它注册的 section 表 */
function boot(sessionId) {
  const sections = new Map();
  const claims = [];
  const agent = {
    session: { id: sessionId },
    ctx: {
      on(event, callback) { if (event === 'agent/inbox/claimed') claims.push(callback); },
      systemPrompt: {
        section(definition) { sections.set(definition.name, definition); return () => {}; },
      },
    },
  };
  created(agent);
  return { sections, claim: (text) => claims.forEach((fn) => fn({ sessionId, message: { content: [{ type: 'text', text }] } })) };
}

// ── 1. memory.jsonl 注入 ──────────────────────────────────────────────────
const ok = boot('session-ok');
const memorySection = ok.sections.get('memory-retrieval:context');
if (!memorySection) throw new Error('memory section 没有注册');
ok.claim('用户最常喝什么？');
const text = memorySection.text();
if (!text.includes('乌龙茶')) throw new Error('没有命中示例记忆');
if (!text.includes('TestMemory')) throw new Error('label 没有生效');
if (!text.includes('拿不准')) throw new Error('缺少相关性判断提示');

// ── 2. 集合内跨会话检索 ──────────────────────────────────────────────────
const collectionSection = ok.sections.get('memory-retrieval:collections');
if (!collectionSection) throw new Error('collections section 没有注册');
ok.claim('退款政策是怎样的？');
const block = collectionSection.text();
if (!block.includes('售后集合')) throw new Error('注入块没有集合名');
if (!block.includes('7 天内无理由')) throw new Error('没有检索到其它会话的原文');
if (!block.includes('售后政策会话')) throw new Error('注入块没有带上来源会话标题');
if (block.includes('SHOULD-NOT-BE-INDEXED')) throw new Error('runtime-context 快照被错误索引');
if (block.includes('《售后政策会话》') === false) throw new Error('缺少来源标注');

// 同一片段不能每轮都重复贴：第二轮应该被抑制
ok.claim('那退款政策到底怎么规定的？');
if (collectionSection.text() !== '') throw new Error('重复注入没有被抑制（同一片段又贴了一次）');

// ── 2b. recallMidTask=false：同一轮第二步不再注入（只在开口时联想一次）──
const again = ok.sections.get('memory-retrieval:collections');
ok.claim('退款政策到底怎么规定的？');
if (again.text() !== '') throw new Error('recallMidTask=false 时同一轮不应再次注入');

// ── 3. 不属于集合的会话不应有集合块 ──────────────────────────────────────
const outsider = boot('session-outsider');
outsider.claim('退款政策是怎样的？');
const outsiderBlock = outsider.sections.get('memory-retrieval:collections').text();
if (outsiderBlock !== '') throw new Error('非集合成员不应注入集合块');

// ── 4. excludeSessionPatterns ────────────────────────────────────────────
const excluded = boot('session-excluded');
excluded.claim('用户最常喝什么？');
if (excluded.sections.get('memory-retrieval:context').text() !== '') throw new Error('excludeSessionPatterns 没有生效');

// ── 5. 集合总开关 ────────────────────────────────────────────────────────
fs.rmSync(memoryFile, { force: true });
fs.rmSync(configDir, { recursive: true, force: true });
fs.rmSync(sessionsRoot, { recursive: true, force: true });

console.log(block.split('\n').slice(0, 5).join('\n'));
console.log('OK');
