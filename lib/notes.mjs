/**
 * 笔记层：模型自己判断「这段值得记」之后写下的结论。
 *
 * 和别的来源的区别：
 *   - 集合/自检索给的是**原文片段**，未加工；
 *   - 笔记是模型理解上下文之后的**结论**，所以检索时排在最前。
 *
 * 每条都带出处（会话 + 时间 + 原话片段），可以顺着它调回原文核对。
 * 存储是 append-only 的 JSONL，删改只做「标记作废」，不物理删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.mjs';
import { hashTerm, termsOf, formatDate } from './collections.mjs';
import { readSessionMessages } from './sessions.mjs';

export function notesPath() {
  return process.env.DSH_MEMORY_RETRIEVAL_NOTES || path.join(configDir(), 'notes.jsonl');
}

const KINDS = new Set(['fact', 'preference', 'decision', 'pitfall']);
const KIND_WEIGHT = { preference: 1.45, decision: 1.35, pitfall: 1.2, fact: 1 };

export function normalizeKind(kind) {
  const k = String(kind || 'fact').trim().toLowerCase();
  return KINDS.has(k) ? k : 'fact';
}

/** 去掉首尾空白与多余换行，便于哈希去重。 */
function canonical(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function noteId(text) {
  return hashTerm(canonical(text).toLowerCase()).toString(16);
}

export function loadNotes(file = notesPath()) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const note = JSON.parse(trimmed);
      if (note && note.text) out.push(note);
    } catch {
      // 坏行跳过：笔记坏了不该让整个插件起不来
    }
  }
  return out;
}

function appendNote(note, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(note)}\n`, 'utf8');
}

/**
 * 记一条笔记。同样的内容（哈希相同）只记一次，重复调用把旧的那条「重新激活」。
 * @returns {{note: object, added: boolean, duplicate: boolean}}
 */
export function addNote({ text, kind = 'fact', source = null }, file = notesPath()) {
  const body = canonical(text);
  if (!body) throw new Error('笔记内容不能为空');
  if (body.length > 400) throw new Error('笔记太长（上限 400 字）——笔记是结论，不是摘抄');

  const id = noteId(body);
  const existing = loadNotes(file).filter((note) => note.id === id && !note.retired);
  if (existing.length) {
    return { note: existing[existing.length - 1], added: false, duplicate: true };
  }

  const note = {
    id,
    text: body,
    kind: normalizeKind(kind),
    source: source
      ? {
          sessionId: source.sessionId || '',
          title: source.title || '',
          time: Number(source.time) || Date.now(),
          excerpt: String(source.excerpt || '').slice(0, 160),
        }
      : null,
    createdAt: Date.now(),
    retired: false,
  };
  appendNote(note, file);
  return { note, added: true, duplicate: false };
}

/** 标记作废（不物理删除，保留可追溯）。 */
export function retireNote(id, file = notesPath()) {
  const notes = loadNotes(file);
  const target = notes.find((note) => note.id === String(id) || note.id?.startsWith(String(id)));
  if (!target || target.retired) return null;
  appendNote({ ...target, retired: true, retiredAt: Date.now() }, file);
  return target;
}

/** 有效笔记（同一 id 后写的覆盖先写的）。 */
export function activeNotes(file = notesPath()) {
  const map = new Map();
  for (const note of loadNotes(file)) map.set(note.id, note);
  return [...map.values()].filter((note) => !note.retired);
}

/**
 * 按当前线索给笔记打分。
 * 笔记短、条数少，直接用词项重叠 + 类别权重 + 时间衰减，不做倒排。
 */
export function searchNotes(notes, cue, { topK = 3, maxChars = 600, synonymMap = null } = {}) {
  // termsOf 返回的是 Uint32Array（哈希后的词项），没有 .has —— 必须转成 Set 再判断
  const cueTerms = new Set(termsOf(cue || ''));
  if (!cueTerms.size) return [];

  const expanded = new Set(cueTerms);
  if (synonymMap) {
    for (const term of cueTerms) {
      const group = synonymMap.get(term);
      if (group) for (const word of group.terms || group) expanded.add(word);
    }
  }

  const now = Date.now();
  const picked = [];
  for (const note of notes) {
    const noteTerms = new Set(termsOf(`${note.text} ${note.kind}`));
    let hits = 0;
    for (const term of expanded) if (noteTerms.has(term)) hits += 1;
    if (!hits) continue;

    const ageDays = Math.max(0, (now - (note.createdAt || now)) / 86400000);
    const recency = 1 / (1 + ageDays / 30);
    const score = hits * (KIND_WEIGHT[note.kind] || 1) * recency;
    picked.push({ note, score, hits });
  }

  picked.sort((a, b) => b.score - a.score);
  const out = [];
  let used = 0;
  for (const item of picked.slice(0, topK)) {
    const line = formatNoteLine(item.note);
    if (out.length && used + line.length > maxChars) break;
    out.push(item);
    used += line.length;
  }
  return out;
}

export function formatNoteLine(note) {
  const where = note.source
    ? `出处：《${note.source.title || note.source.sessionId}》 ${note.source.time ? formatDate(note.source.time) : ''}`
    : '出处：未记录';
  return `- [${note.id}] ${note.text}\n  ${where} · ${note.kind}`;
}

export function formatNotesBlock(results, { askWhenUnsure = true } = {}) {
  if (!results.length) return '';
  const lines = [
    '【笔记 · 我自己记下的】',
    '下面不是原文，是我以前理解过之后记下来的结论——可以当成事实线索直接参考。',
  ];
  if (askWhenUnsure) {
    lines.push('每条都带出处；不确定或与原文冲突时，用 memory_note(origin="<id>") 调出原文核对，不要凭记忆硬解释。');
  }
  for (const item of results) lines.push(formatNoteLine(item.note));
  return lines.join('\n');
}

/**
 * 顺着出处找回原文：按时间窗 + 原话片段在会话日志里定位。
 * 找不到就明说，不要编。
 */
export function findOrigin(note, { skipPatterns = [], windowMs = 5 * 60 * 1000 } = {}) {
  const source = note?.source;
  if (!source?.sessionId) return { messages: [], reason: '这条笔记没有记录出处' };

  const { messages } = readSessionMessages(source.sessionId, { skipPatterns });
  if (!messages.length) return { messages: [], reason: '会话日志读不到（可能已删除或还没落盘）' };

  // 探针太短没有区分度（"1" 能匹配任何日志），这种时候直接按时间取，
  // 并在返回值里说明，避免给出一个看似精确、其实错位的"原文"。
  const rawProbe = String(source.excerpt || '').replace(/\s+/g, '').slice(0, 12);
  const probe = rawProbe.length >= 6 ? rawProbe : '';
  const near = messages.filter((msg) => !source.time || Math.abs(msg.time - source.time) <= windowMs);
  const pool = near.length ? near : messages;
  // 注意：anchor 是 pool 里的下标，而 pool 可能是 near（时间窗口）的子集。
  // 直接拿它切 messages 会错位——切到日志开头几条。必须先把消息对象映射回 messages。
  const anchorIndex = probe
    ? pool.findIndex((msg) => msg.text.replace(/\s+/g, '').includes(probe))
    : -1;


  const anchor = anchorIndex < 0 ? -1 : messages.indexOf(pool[anchorIndex]);

  if (anchor < 0) {
    // 没有原话片段就退回「时间最近的两条」，并说明是按时间定位的
    const sorted = [...pool].sort((a, b) => Math.abs(a.time - source.time) - Math.abs(b.time - source.time)).slice(0, 2);
    return { messages: sorted, reason: probe ? '没找到原话，按时间附近取的' : '这条笔记没存原话片段，按时间取的' };
  }

  // 锚点放第一位（这就是"原文"），后面最多跟一条回应。
  // 之前是 anchor-1 起切三条，锚点被挤到第三条，前面还常有一条超长回复，读起来像错位。
  const picked = anchor >= 0 ? [messages[anchor]] : [];
  if (messages[anchor + 1]) picked.push(messages[anchor + 1]);
  return { messages: picked, reason: '' };
}
