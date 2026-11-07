/**
 * 笔记层：模型自己记下的结论 + 出处 + 调回原文。
 *
 * 这一层的价值不在"多存了一份数据"，而在：
 *   1. 它已经理解过上下文，是结论，不是原文；
 *   2. 每条带出处，可以顺着调回原文核对（不信任凭记忆的解释）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { apply } from './lib/index.js';
import { addNote, activeNotes, retireNote, searchNotes, findOrigin, notesPath } from './lib/notes.mjs';

const configDir = path.join(os.tmpdir(), 'mr-notes-' + Date.now());
fs.mkdirSync(configDir, { recursive: true });
process.env.DSH_MEMORY_RETRIEVAL_DIR = configDir;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-notes-sessions-'));
process.env.DSH_SESSIONS_DIR = root;

const now = Date.now();
function makeSession(sessionId, title, messages) {
  const dir = path.join(root, '--ws--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: now - 7200_000, cwd: 'D:\\t', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })];
  if (title) lines.push(JSON.stringify({ type: 'session/title', seq: 0, time: now - 7200_000, data: { title } }));
  let seq = 1;
  for (const m of messages) {
    if (m.role === 'user') lines.push(JSON.stringify({ type: 'user/message', seq: seq++, time: m.time, data: { content: [{ type: 'text', text: m.text }], source: { kind: 'user' }, role: 'user' } }));
    else lines.push(JSON.stringify({ type: 'assistant/message', seq: seq++, time: m.time, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: m.text }] } } }));
  }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
}

// DSH 的注册契约：工具必须声明 output { schema, render }。
// 之前 memory_note 漏了它，线上直接注册失败——用同样的校验把这类问题挡在测试里。
function registerChecked(map, tool) {
  if (!tool?.output || !tool.output.schema || typeof tool.output.render !== 'function') {
    throw new Error(`tool "${tool?.name}" must declare output { schema, render }`);
  }
  map.set(tool.name, tool);
  return () => {};
}

const failures = [];
function ok(label, pass) {
  if (!pass) failures.push(label);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
}

// ── 1. 存储层：写入 / 去重 / 作废 ─────────────────────────────────────
{
  const file = path.join(configDir, 'notes-unit.jsonl');
  const first = addNote({ text: '这个项目用 pnpm，不用 npm', kind: 'decision', source: { sessionId: 's1', title: '会话甲', time: now, excerpt: '我们说好用 pnpm' } }, file);
  ok('写入返回 id', !!first.note.id && first.added);
  ok('来源被保存', first.note.source?.title === '会话甲' && first.note.source?.excerpt.includes('pnpm'));

  const again = addNote({ text: '这个项目用 pnpm，不用 npm', kind: 'decision' }, file);
  ok('同样内容不重复写入', again.duplicate === true && again.added === false);
  ok('文件里只有一条', fs.readFileSync(file, 'utf8').trim().split('\n').length === 1);

  ok('list 能读到', activeNotes(file).length === 1);
  const retired = retireNote(first.note.id, file);
  ok('作废成功', !!retired);
  ok('作废后不再出现', activeNotes(file).length === 0);
  ok('作废是追记而不是物理删除', fs.readFileSync(file, 'utf8').trim().split('\n').length === 2);
}

// ── 2. 检索：按线索挑相关笔记 ───────────────────────────────────────
{
  const notes = [
    { id: 'a1', text: '这个项目用 pnpm 不用 npm', kind: 'decision', createdAt: now, retired: false },
    { id: 'b2', text: '这台机器的网络走 Wi-Fi 6E，握手 2402', kind: 'fact', createdAt: now, retired: false },
  ];
  const hit = searchNotes(notes, '为什么 pnpm 装不上依赖', { topK: 2 });
  ok('相关笔记排在前面', hit.length === 1 && hit[0].note.id === 'a1');
  const miss = searchNotes(notes, '今晚吃什么', { topK: 2 });
  ok('无关线索不返回笔记', miss.length === 0);
}

// ── 3. 出处可以调回原文 ─────────────────────────────────────────────
{
  const quote = '我们说好用 pnpm 管依赖，别用 npm 混着装。';
  makeSession('session-note', '笔记测试会话', [
    { role: 'user', text: '前面随便聊点别的。', time: now - 900_000 },
    { role: 'user', text: quote, time: now - 600_000 },
    { role: 'assistant', text: '好，那就 pnpm。', time: now - 599_000 },
  ]);
  const file = path.join(configDir, 'notes-origin.jsonl');
  const { note } = addNote({ text: '项目用 pnpm', kind: 'decision', source: { sessionId: 'session-note', title: '笔记测试会话', time: now - 600_000, excerpt: quote } }, file);
  const origin = findOrigin(note, { skipPatterns: [] });
  ok('调到了原文', origin.messages.some((m) => m.text.includes('pnpm 管依赖')));
  ok('是围绕原话的那几条', origin.messages.length >= 2);
  const orphan = findOrigin({ text: '无出处', source: null }, {});
  ok('没有出处时明说调不到', orphan.messages.length === 0 && !!orphan.reason);
}

// ── 4. 注入：最高优先级 + 每轮一次 ──────────────────────────────────
let created;
const sections = new Map();
const tools = new Map();
const ctx = {
  on(event, cb) { if (event === 'agent/created') created = cb; },
  effect(fn) { fn(); },
  tools: { register(tool) { return registerChecked(tools, tool); } },
};
await apply(ctx, {
  memoryPath: '',
  enabled: true,
  collections: [],
  collectionRetrieval: false,
  selfRetrieval: false,
  notesTopK: 3,
  notesMaxChars: 600,
});

// 主会话里没有笔记时不该出现这一段
{
  const claims = [];
  created({
    session: { id: 'session-empty' },
    ctx: {
      on(event, cb) { if (event === 'agent/inbox/claimed') claims.push(cb); },
      systemPrompt: { section(d) { sections.set(d.name, d); return () => {}; } },
      tools: { register(tool) { return registerChecked(tools, tool); } },
    },
  });
  claims.forEach((fn) => fn({ sessionId: 'session-empty', message: { content: [{ type: 'text', text: '随便问问' }] } }));
  const text = sections.get('memory-retrieval:notes')?.text() ?? '';
  ok('没有笔记时不注入空块', text === '');
}

// 写一条笔记，再让主会话问相关问题
{
  const tool = tools.get('memory_note');
  ok('memory_note 已注册', !!tool);
  ok('memory_note 声明了 output（DSH 的硬要求）', !!tool?.output?.schema && typeof tool.output.render === 'function');
  const written = await tool.execute({ text: '这个项目用 pnpm 不用 npm', kind: 'decision' });
  ok('工具写入成功', written.includes('已记住'));
  const listed = await tool.execute({ list: true });
  ok('list 能看到', listed.includes('pnpm'));

  const claims = [];
  const agentSections = new Map();
  created({
    session: { id: 'session-note' },
    ctx: {
      on(event, cb) { if (event === 'agent/inbox/claimed') claims.push(cb); },
      systemPrompt: { section(d) { agentSections.set(d.name, d); return () => {}; } },
      tools: { register(t) { return registerChecked(tools, t); } },
    },
  });
  claims.forEach((fn) => fn({ sessionId: 'session-note', message: { content: [{ type: 'text', text: 'pnpm 装依赖怎么又失败了' }] } }));
  const section = agentSections.get('memory-retrieval:notes');
  ok('笔记段已注册（order 0）', !!section && section.order === 0);
  const block = section.text();
  ok('注入了笔记块', block.includes('【笔记 · 我自己记下的】'));
  ok('带出处', block.includes('出处：'));
  ok('带 id，可以调原文', /\[[0-9a-f]+\]/.test(block));
  ok('明确要求不确定就调原文', block.includes('memory_note(origin='));
  ok('同一轮不重复注入', section.text() === '');
}

// ── 5. 笔记跟着来源会话走：同集合可见，集合外不可见 ─────────────────
{
  const file = path.join(configDir, 'notes.jsonl');
  addNote({ text: '甲会话的私事：周末去看牙', kind: 'fact', source: { sessionId: 'session-other', title: '会话乙', time: now, excerpt: '' } }, file);
  addNote({ text: '丙会话的事：项目用 pnpm', kind: 'decision', source: { sessionId: 'session-third', title: '会话丙', time: now, excerpt: '' } }, file);

  const claims = [];
  const agentSections = new Map();
  created({
    session: { id: 'session-note' },
    ctx: {
      on(event, cb) { if (event === 'agent/inbox/claimed') claims.push(cb); },
      systemPrompt: { section(d) { agentSections.set(d.name, d); return () => {}; } },
      tools: { register(t) { return registerChecked(tools, t); } },
    },
  });
  claims.forEach((fn) => fn({ sessionId: 'session-note', message: { content: [{ type: 'text', text: '看牙和 pnpm 都聊一下' }] } }));
  const block = agentSections.get('memory-retrieval:notes').text();
  ok('集合外的笔记不进来', !block.includes('周末去看牙'));
  ok('本会话的笔记仍在', block.includes('pnpm'));
}

// ── 6. 集合内其它会话的笔记：进了同一个池子 ─────────────────────────
{
  addNote({ text: '部署在周五，别安排在周一', kind: 'decision', source: { sessionId: 'session-third', title: '会话丙', time: now, excerpt: '' } }, path.join(configDir, 'notes.jsonl'));

  let created2;
  const ctx2 = { on(event, cb) { if (event === 'agent/created') created2 = cb; }, effect(fn) { fn(); }, tools: { register() { return () => {}; } } };
  await apply(ctx2, {
    memoryPath: '',
    enabled: true,
    collections: [{ id: 'c-notes', name: '笔记集合', sessionIds: ['session-note', 'session-third'] }],
    collectionRetrieval: false,
    selfRetrieval: false,
  });

  const claims = [];
  const agentSections = new Map();
  created2({
    session: { id: 'session-note' },
    ctx: {
      on(event, cb) { if (event === 'agent/inbox/claimed') claims.push(cb); },
      systemPrompt: { section(d) { agentSections.set(d.name, d); return () => {}; } },
      tools: { register() { return () => {}; } },
    },
  });
  claims.forEach((fn) => fn({ sessionId: 'session-note', message: { content: [{ type: 'text', text: '部署安排在什么时候' }] } }));
  const block = agentSections.get('memory-retrieval:notes').text();
  ok('同集合会话的笔记进池子', block.includes('部署在周五'));
  ok('并标了来自哪本会话', block.includes('《会话丙》'));
}

// ── 7. 主动查：memory_recall(scope=notes) ──────────────────────────
{
  let created3;
  const tools3 = new Map();
  const ctx3 = { on(event, cb) { if (event === 'agent/created') created3 = cb; }, effect(fn) { fn(); }, tools: { register(t) { return registerChecked(tools3, t); } } };
  await apply(ctx3, {
    memoryPath: '',
    enabled: true,
    collections: [{ id: 'c-notes2', name: '笔记集合', sessionIds: ['session-note', 'session-third'] }],
    collectionRetrieval: false,
    selfRetrieval: false,
  });

  const recall = tools3.get('memory_recall');
  ok('memory_recall 已注册', !!recall);
  const exec = { agent: { session: { id: 'session-note' } } };

  const hit = await recall.execute({ query: 'pnpm 依赖', scope: 'notes', topK: 5 }, exec);
  ok('scope=notes 能查到笔记', hit.includes('pnpm'));
  ok('结果带 id，可调原文', /id=[0-9a-f]+/.test(hit));

  const outsider = await recall.execute({ query: '看牙 周末', scope: 'notes', topK: 5 }, exec);
  ok('集合外的笔记查不到', !outsider.includes('周末去看牙'));

  const all = await recall.execute({ query: 'pnpm 依赖', scope: 'all', topK: 5 }, exec);
  ok('scope=all 也包含笔记', all.includes('pnpm'));

  const empty = await recall.execute({ query: '完全无关的词汇xyz', scope: 'notes', topK: 5 }, exec);
  ok('查不到时明说', empty.includes('没有和'));
}

// ── 8. 集合检索里也能拿到成员会话的笔记 ────────────────────────────
{
  makeSession('session-third', '会话丙', [
    { role: 'user', text: '部署就定在周五，别安排周一。', time: now - 5000_000 },
  ]);
  let created4;
  const tools4 = new Map();
  const ctx4 = { on(event, cb) { if (event === 'agent/created') created4 = cb; }, effect(fn) { fn(); }, tools: { register(t) { return registerChecked(tools4, t); } } };
  await apply(ctx4, {
    memoryPath: '',
    enabled: true,
    collections: [{ id: 'c-notes3', name: '笔记集合', sessionIds: ['session-note', 'session-third'] }],
    collectionRetrieval: true,
    selfRetrieval: false,
  });
  const recall4 = tools4.get('memory_recall');
  const res = await recall4.execute({ query: '部署安排在哪天', scope: 'collections', topK: 5 }, { agent: { session: { id: 'session-note' } } });
  ok('集合检索能拿到别人的笔记', res.includes('部署在周五'));
  ok('并标明来自笔记', res.includes('笔记'));
}

// ── 9. 出处片段太短时，不要假装精确 ────────────────────────────────
{
  makeSession('session-short', '短消息会话', [
    { role: 'user', text: '1', time: now - 100_000 },
    { role: 'user', text: '这条比较长一些，可以用来当锚点，里面有个特征词：铅笔。', time: now - 90_000 },
  ]);
  const shortNote = {
    id: 'short1',
    text: '随口记的一条',
    kind: 'fact',
    source: { sessionId: 'session-short', title: '短消息会话', time: now - 100_000, excerpt: '1' },
  };
  const res = findOrigin(shortNote, { skipPatterns: [] });
  ok('一个字的出处不当锚点', res.messages.length >= 1);
  ok('会说明是按时间取的', !!res.reason);

  const longNote = {
    id: 'long1',
    text: '记了铅笔的事',
    kind: 'fact',
    source: { sessionId: 'session-short', title: '短消息会话', time: now - 90_000, excerpt: '这条比较长一些，可以用来当锚点' },
  };
  const hit = findOrigin(longNote, { skipPatterns: [] });
  ok('够长的出处能精确命中', hit.messages.some((m) => m.text.includes('铅笔')));
}

// ── 10. 时间窗口内的命中，不能因为下标错位而切到别的消息 ────────────
{
  // 全量消息里目标在第 4 条，但在「±5 分钟窗口」里它是第 1 条。
  // 早先的实现直接拿窗口下标去切全量数组，会切到日志开头。
  const t = now - 3600_000;
  makeSession('session-window', '窗口错位会话', [
    { role: 'user', text: '很早以前的第一句填充，不该被当成原文。', time: t - 400_000 },
    { role: 'user', text: '很早以前的第二句填充，也不该出现。', time: t - 300_000 },
    { role: 'user', text: '这句是真正的原文锚点：周末去修自行车。', time: t },
    { role: 'assistant', text: '好，周末修车。', time: t + 30_000 },
  ]);
  const note = {
    id: 'win1',
    text: '周末要修车',
    kind: 'fact',
    source: { sessionId: 'session-window', title: '窗口错位会话', time: t, excerpt: '这句是真正的原文锚点' },
  };
  const res = findOrigin(note, { skipPatterns: [] });
  const joined = res.messages.map((m) => m.text).join('\n');
  ok('窗口内命中时返回的是目标消息', joined.includes('周末去修自行车'));
  ok('不会切到日志开头那几条', !joined.includes('第一句填充'));
}

// ── 11. memory_note 顺手记同义词（方案 B）──────────────────────────
{
  const { createNoteTool } = await import('./lib/note-tool.mjs');
  const learned = path.join(configDir, 'learned-syn.jsonl'.replace('.jsonl', '.json'));
  let refreshed = 0;
  const tool = createNoteTool({
    sourceOf: () => null,
    skipPatterns: () => [],
    learnedPath: learned,
    onSynonymsChanged: () => { refreshed += 1; },
  });

  const r1 = await tool.execute({ text: '这个项目用 pnpm 不用 npm', kind: 'decision', synonyms: '网速慢,卡顿,延迟' });
  ok('写笔记时顺带记了同义词', r1.includes('同义词'));
  const saved = JSON.parse(fs.readFileSync(learned, 'utf8'));
  ok('同义词进了 learned.json', saved.groups.some((g) => g.includes('网速慢') && g.includes('卡顿')));
  ok('写词后触发了刷新', refreshed === 1);

  const r2 = await tool.execute({ text: '另一个结论', synonyms: '卡顿,掉帧' });
  const saved2 = JSON.parse(fs.readFileSync(learned, 'utf8'));
  ok('与已有词有交集时并进同一组', saved2.groups.some((g) => g.includes('网速慢') && g.includes('掉帧')));

  const r3 = await tool.execute({ text: '只记词不写笔记', synonyms: '路由器,光猫' });
  ok('只给 synonyms 也能写', r3.includes('同义词'));
  const saved3 = JSON.parse(fs.readFileSync(learned, 'utf8'));
  ok('单给词也进表', saved3.groups.some((g) => g.includes('路由器')));

  const r4 = await tool.execute({ synonyms: '只有一个词' });
  ok('少于两个词会被拒绝', r4.includes('两个词'));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} 项失败：\n- ${failures.join('\n- ')}` : '\nNOTES OK');
if (failures.length) process.exit(1);
