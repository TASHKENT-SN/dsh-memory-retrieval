/**
 * memory_note：模型自己判断「这段值得记」之后写下结论。
 *
 * 为什么要模型自己调：判断「什么值得记」本身就是理解上下文之后的判断，
 * 后台按规则抽取做不到，也容易抽错。代价是偶发漏记——可以接受。
 *
 * 每条笔记都带出处（会话 + 时间 + 原话片段），用 origin 可以调回原文核对。
 */
import { addNote, activeNotes, retireNote, findOrigin, notesPath, formatNoteLine } from './notes.mjs';
import { formatDate } from './collections.mjs';
import { loadLearned, saveLearned, mergeGroups } from './synonyms.mjs';

const NAME = 'memory_note';

const PARAMETERS = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'What to remember. A conclusion, not a quote — max 400 chars.' },
    kind: {
      type: 'string',
      enum: ['fact', 'preference', 'decision', 'pitfall'],
      description: 'preference=user likes/dislikes, decision=a choice already made, pitfall=a mistake worth not repeating, fact=everything else.',
    },
    synonyms: {
      type: 'string',
      description:
        'Optional: 2-8 words that mean the SAME thing (comma separated, e.g. "网速慢,卡顿,延迟"). ' +
        'They are written to the learned dictionary in the same call, so no separate memory_links call is needed.',
    },
    list: { type: 'boolean', description: 'List notes written so far instead of adding.' },
    origin: { type: 'string', description: 'Note id (or prefix). Returns the original excerpt the note was based on, so you can verify it.' },
    retire: { type: 'string', description: 'Note id (or prefix) to mark as wrong/obsolete. Not a physical delete.' },
  },
};

const OUTPUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value ?? '') }];
  },
};

const DESCRIPTION = [
  'Record a durable conclusion about the user or the project, so it can be recalled later.',
  'Write only what will still be true next week: preferences, decisions already made, pitfalls, stable facts.',
  'Do not record guesses, transient state, or anything the user asked you to forget.',
  'Every note stores its source (session, time, snippet); origin=id returns that original excerpt for verification.',
  'If you also noticed two words for the same thing, pass synonyms="网速慢,卡顿" and they are learned in the same call.',
  'Pass list=true to see what you have written. Changes take effect immediately.',
].join(' ');

function resolveDefineTool(deps) {
  if (deps?.defineTool) return deps.defineTool;
  try {
    const mod = require('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch {
    // ignore
  }
  return (spec) => spec;
}

/**
 * @param {object} options
 * @param {(spec: object) => object} options.defineTool
 * @param {() => {sessionId:string,title:string,time:number,excerpt:string}} options.sourceOf
 * @param {() => string[]} options.skipPatterns
 */
export function createNoteTool({ defineTool, sourceOf, skipPatterns, learnedPath, onSynonymsChanged }) {
  return resolveDefineTool({ defineTool })({
    name: NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    async execute(args = {}, exec = null) {
      // 列出
      if (args.list) {
        const notes = activeNotes();
        if (!notes.length) return '还没有记过任何笔记。';
        const lines = notes.map((note) => formatNoteLine(note));
        return `已记 ${notes.length} 条：\n${lines.join('\n')}`;
      }

      // 作废
      if (args.retire) {
        const retired = retireNote(args.retire);
        return retired
          ? `已作废 [${retired.id}]：${retired.text}`
          : '没找到这条笔记（可能已经作废或 id 不对）。';
      }

      // 调原文
      if (args.origin) {
        const notes = activeNotes();
        const note = notes.find((item) => item.id === args.origin || item.id.startsWith(String(args.origin)));
        if (!note) return '没找到这条笔记，先 list=true 看看 id。';
        const { messages, reason } = findOrigin(note, { skipPatterns: skipPatterns() });
        if (!messages.length) return `笔记：${note.text}\n调不到原文：${reason}`;
        const body = messages
          .map((msg) => `- [${formatDate(msg.time)}] ${msg.role === 'user' ? '你' : '我'}：${msg.text.slice(0, 300)}`)
          .join('\n');
        return [
          `笔记 [${note.id}]：${note.text}`,
          `出处：${note.source?.title || '未知会话'} · ${formatDate(note.source?.time || 0)}`,
          reason ? `（${reason}）` : '',
          '原文：',
          body,
        ].filter(Boolean).join('\n');
      }

      // 记同义词：可以和笔记一起写，也可以只写词（不写结论）
      const learnSynonyms = (raw) => {
        const words = [...new Set(String(raw).split(/[,，、\s]+/).map((w) => w.trim()).filter((w) => w.length >= 2))];
        if (words.length < 2) return '同义词至少要两个词，例如 synonyms="网速慢,卡顿"。';
        if (!learnedPath) return '当前没有配置词表路径，已跳过同义词。';
        const current = loadLearned(learnedPath);
        const groups = mergeGroups(current.groups, words);
        saveLearned(learnedPath, { groups, links: current.links });
        try {
          onSynonymsChanged?.();
        } catch {
          // 刷新失败不影响写入
        }
        return current.groups.length === groups.length
          ? `已并入同义词组：${words.join(' ≈ ')}（词表 ${groups.length} 组）`
          : `已记同义词：${words.join(' ≈ ')}（词表 ${groups.length} 组）`;
      };

      if (!args.text && args.synonyms) return learnSynonyms(args.synonyms);

      // 写入
      if (!args.text) return '要给 text（要记的结论），或者 list=true / origin=id / retire=id。';
      const source = sourceOf ? sourceOf(exec) : null;
      const { note, added, duplicate } = addNote({ text: args.text, kind: args.kind, source });
      // 同义词要在「重复笔记」之前处理：结论重复了，词表仍可能缺这一对
      const synLine = args.synonyms ? '\n' + learnSynonyms(args.synonyms) : '';
      if (duplicate) return `这条已经记过了：[${note.id}] ${note.text}（没有重复写入）${synLine}`;
      const where = note.source?.title ? `，出处：《${note.source.title}》` : '';
      return `已记住 [${note.id}]${where}：${note.text.length > 80 ? note.text.slice(0, 80) + '…' : note.text}${synLine}`;
    },
  });
}

export const NOTE_TOOL_NAME = NAME;
export { notesPath };
