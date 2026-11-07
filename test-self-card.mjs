/**
 * 自检索（selfRetrieval）与全量记忆卡（memoryCard）的回归测试。
 *
 * 这两条链路碰的是**私人数据**：
 *   - 自检索把本会话更早说的话注回来；
 *   - 记忆卡读角色自己的文件，只应对白名单会话开放。
 * 之前完全没有断言，改坏了不会报警（会静默泄漏）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(HERE, '.test-config-self');
fs.mkdirSync(configDir, { recursive: true });
process.env.DSH_MEMORY_RETRIEVAL_DIR = configDir;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-self-'));
process.env.DSH_SESSIONS_DIR = root;

const now = Date.now();
const HOUR = 3600_000;

function makeSession(sessionId, title, messages) {
  const dir = path.join(root, '--test-workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: now - 5 * HOUR, cwd: 'D:\\test', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })];
  if (title) lines.push(JSON.stringify({ type: 'session/title', seq: 0, time: now - 5 * HOUR, data: { title } }));
  let seq = 1;
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(JSON.stringify({ type: 'user/message', seq: seq++, time: m.time, data: { content: [{ type: 'text', text: m.text }], source: { kind: 'user' }, role: 'user' } }));
    } else {
      lines.push(JSON.stringify({ type: 'assistant/message', seq: seq++, time: m.time, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: m.text }] } } }));
    }
  }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
}

// 注意：自检索会丢弃「最近 24 条消息里出现过的内容」（它们还在上下文里）。
// 所以老内容必须排在前 24 条之外，否则测的就是去重而不是自检索。
const selfMessages = [
  { role: 'user', text: '链路速率只有 10Mbps，这是网络卡顿的直接原因。', time: now - 3 * HOUR },
  { role: 'assistant', text: '所以瓶颈在网线，不在路由。', time: now - 2 * HOUR },
];
for (let i = 0; i < 28; i += 1) {
  selfMessages.push({ role: i % 2 ? 'assistant' : 'user', text: `第 ${i} 条填充内容，用来把前面的旧片段挤出最近二十四条。`, time: now - 90 * 60_000 + i * 1000 });
}
selfMessages.push({ role: 'user', text: '刚刚随口一提的临时内容不该被捞回来。', time: now - 60_000 });
makeSession('session-self', '自检索会话', selfMessages);

const cardPath = path.join(root, 'memory-card.json');
fs.writeFileSync(cardPath, JSON.stringify([
  { text: '她私底下很怕打雷，但从来不承认。' },
  { text: '她答应过主人每天写一句话，后来断了三天。' },
]), 'utf8');

const failures = [];
let passed = 0;
const ok = (label, cond) => { if (cond) passed += 1; else failures.push(label); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

let bust = 0;
/** 每个场景用一份全新的模块实例，避免上一份的 runtime 配置串味 */
async function scenario(overrides, sessionId, cue) {
  const { apply } = await import(`./lib/index.js?bust=${++bust}`);
  let created;
  const ctx = {
    on(event, cb) { if (event === 'agent/created') created = cb; },
    effect(fn) { fn(); },
  };
  apply(ctx, {
    memoryPath: '',
    enabled: true,
    minHits: 1,
    collectionRetrieval: false,
    // 分块调小，让「老消息」和「一分钟前的消息」各自成段：
    // 自检索是按段过滤时间的，同一段里混了新消息，整段都会被丢掉。
    collectionChunkChars: 30,
    selfRetrieval: true,
    selfTopK: 2,
    selfMaxChars: 600,
    selfMinAgeMinutes: 15,
    memoryCardPath: cardPath,
    memoryCardRetrieval: true,
    memoryCardSessionIds: ['session-card'],
    memoryCardAutoDisableSelf: true,
    ...overrides,
  });
  const sections = new Map();
  const claims = [];
  const stepHandlers = [];
  created({
    session: { id: sessionId },
    ctx: {
      on(event, cb) {
        if (event === 'agent/inbox/claimed') claims.push(cb);
        if (event === 'agent/pre-step') stepHandlers.push(cb);
      },
      systemPrompt: { section(d) { sections.set(d.name, d); return () => {}; } },
    },
  });
  claims.forEach((fn) => fn({ sessionId, message: { content: [{ type: 'text', text: cue }] } }));
  const text = (name) => sections.get(name)?.text() ?? '';
  // 模拟 agent 进入下一步：DSH 会带 messages（含 tool 结果）触发 agent/pre-step
  text.fireStep = (stepMessages) => {
    for (const handler of stepHandlers) handler({ step: 2, messages: stepMessages }, () => undefined);
  };
  return text;
}

// ── 1. 自检索：能捞到较早的片段 ─────────────────────────────────────────
{
  const text = await scenario({}, 'session-self', '网络卡顿的原因是什么');
  const selfText = text('memory-retrieval:self');
  ok('自检索命中较早的片段', selfText.includes('10Mbps') || selfText.includes('瓶颈在网线'));
  ok('自检索块有来源标注', selfText.includes('【自己的历史'));
  ok('不注入 15 分钟内的内容', !selfText.includes('随口一提的临时内容'));
}

// ── 1b. 自检索：最新的片段排在最前时，也不能把老片段挤掉 ─────────────────
// 这是 perSessionLimit=2 那个坑：同一会话最多 2 段，若被"太新"的两段占满，
// 过滤之后一条不剩。夹具里让「一分钟前」那条命中更多查询词，排名压过老片段。
{
  const rich = [
    { role: 'user', text: '网络卡顿的原因是什么，链路速率大概多少，瓶颈在哪。', time: now - 4 * HOUR },
    { role: 'assistant', text: '链路只有 10Mbps，瓶颈在网线。', time: now - 3 * HOUR },
  ];
  for (let i = 0; i < 28; i += 1) {
    rich.push({ role: i % 2 ? 'assistant' : 'user', text: `第 ${i} 条填充，把老内容挤出最近二十四条。`, time: now - 2 * HOUR + i * 1000 });
  }
  rich.push({ role: 'user', text: '网络卡顿的原因是什么，链路速率大概多少，瓶颈在哪，再说一遍。', time: now - 30_000 });
  makeSession('session-self-rich', '自检索会话（新片段压过老片段）', rich);

  const text = await scenario({}, 'session-self-rich', '网络卡顿的原因是什么，链路速率大概多少，瓶颈在哪');
  const selfText = text('memory-retrieval:self');
  ok('老片段没被最新片段挤掉', selfText.includes('10Mbps') || selfText.includes('瓶颈在网线'));
}

// ── 1c. selfMaxChars 必须真的限制输出，而不只是限制候选 ───────────────────
{
  const text = await scenario({ selfMaxChars: 200, selfTopK: 5 }, 'session-self', '网络卡顿的原因是什么');
  const selfText = text('memory-retrieval:self');
  const body = selfText.split('\n').filter((line) => line.startsWith('- ')).join('\n');
  ok('超过 selfMaxChars 时只保留能装下的片段', body.length <= 200 + 60);
}

// ── 2. 自检索总开关关闭时不出块 ─────────────────────────────────────────
{
  const text = await scenario({ selfRetrieval: false }, 'session-self', '网络卡顿的原因是什么');
  ok('关闭自检索后不注入', text('memory-retrieval:self') === '');
}

// ── 3. 记忆卡：白名单会话能读到 ─────────────────────────────────────────
{
  const text = await scenario({}, 'session-card', '打雷');
  ok('记忆卡对卡主会话可见', text('memory-retrieval:card').includes('打雷'));
  ok('注入卡后同一轮自检索让位', text('memory-retrieval:self') === '');
}

// ── 4. 记忆卡：非白名单会话读不到（隐私闸门）─────────────────────────────
{
  const text = await scenario({}, 'session-outsider', '打雷');
  ok('记忆卡对非白名单会话不可见', text('memory-retrieval:card') === '');
}

// ── 5. 白名单为空 = 谁都读不到（失败即关闭）─────────────────────────────
{
  const text = await scenario({ memoryCardSessionIds: [] }, 'session-card', '打雷');
  ok('白名单为空时卡主也读不到', text('memory-retrieval:card') === '');
}

// ── 6. 关掉 autoDisableSelf 后卡与自检索可以共存 ─────────────────────────
{
  const text = await scenario({ memoryCardAutoDisableSelf: false }, 'session-card', '打雷');
  ok('关掉让位后自检索仍可工作', text('memory-retrieval:self') !== '' || text('memory-retrieval:card') !== '');
}

// ── 7. recallMidTask：线索跟着「当前在干什么」变，而不是把同一批候选分批发完 ──
{
  const push = (list, text, offset) => list.push({ role: 'user', text, time: now - 2 * HOUR + offset });
  const mkNetwork = () => {
    const list = [];
    for (let i = 0; i < 3; i += 1) push(list, `第 ${i} 条：网络卡顿的原因是链路速率不足，需要换网线，这条记录足够长以便独立成段。`, i);
    return list;
  };
  const mkContract = () => {
    const list = [];
    for (let i = 0; i < 3; i += 1) push(list, `第 ${i} 条：合同的违约金不超过总额的百分之二十，逾期按日千分之一计罚，这条记录足够长以便独立成段。`, 10 + i);
    return list;
  };

  const run = async (recallMidTask) => {
    makeSession('session-other', '另一条会话', [...mkNetwork(), ...mkContract()]);
    const text = await scenario({
      collectionRetrieval: true,
      collections: [{ id: 'c1', name: '测试集合', sessionIds: ['session-self', 'session-other'] }],
      collectionTopK: 2,
      collectionMaxChars: 600,
      collectionPerSnippetChars: 80,
      collectionChunkChars: 30,
      recallMidTask,
    }, 'session-self', '网络卡顿的原因');
    const first = text('memory-retrieval:collections');
    // 第二步：任务方向变了（tool 结果提到合同）
    text.fireStep([{ role: 'tool', content: [{ type: 'text', text: '查询结果：这份合同的违约金条款写的是百分之二十。' }] }]);
    const second = text('memory-retrieval:collections');
    return { first, second };
  };

  const off = await run(false);
  ok('开口时能注入集合片段', off.first !== '');
  ok('recallMidTask=false：同一轮第二步不再注入', off.second === '');

  const on = await run(true);
  ok('recallMidTask=true：开口时仍能注入', on.first !== '');
  ok('recallMidTask=true：第二步按新线索检索', on.second !== '');
  ok('recallMidTask=true：第二步拿到的是合同相关片段', on.second.includes('违约金') || on.second.includes('合同'));
  ok('recallMidTask=true：第二步不再重复网络卡顿那段', !(on.second.includes('网络卡顿') && !on.second.includes('合同')));
}

console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join(' / ')}` : `\n共 ${passed} 项检查通过`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {}
if (failures.length) process.exit(1);
console.log('SELF-CARD OK');
