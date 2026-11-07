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
  tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
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
      tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
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
      tools: { register(t) { tools.set(t.name, t); return () => {}; } },
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
      tools: { register(t) { tools.set(t.name, t); return () => {}; } },
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

fs.rmSync(root, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} 项失败：\n- ${failures.join('\n- ')}` : '\nNOTES OK');
if (failures.length) process.exit(1);
