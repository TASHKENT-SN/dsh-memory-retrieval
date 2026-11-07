import fs from 'node:fs';

const ROOT = 'D:/Alice/dsh-memory-retrieval';
let s = fs.readFileSync(`${ROOT}/lib/note-tool.mjs`, 'utf8');

// 1) import 词表工具
s = s.replace(
  "import { formatDate } from './collections.mjs';",
  "import { formatDate } from './collections.mjs';\nimport { loadLearned, saveLearned, mergeGroups } from './synonyms.mjs';",
);

// 2) 参数：synonyms
s = s.replace(
  "    list: { type: 'boolean', description: 'List notes written so far instead of adding.' },",
  `    synonyms: {
      type: 'string',
      description:
        'Optional: 2-8 words that mean the SAME thing (comma separated, e.g. "网速慢,卡顿,延迟"). ' +
        'They are written to the learned dictionary in the same call, so you do not need a separate memory_links call.',
    },
    list: { type: 'boolean', description: 'List notes written so far instead of adding.' },`,
);

// 3) 描述补一句
s = s.replace(
  "'Pass list=true to see what you have written. Changes take effect immediately.',",
  "'If you also noticed two words for the same thing, pass synonyms=\"网速慢,卡顿\" and they will be learned in the same call.',\n  'Pass list=true to see what you have written. Changes take effect immediately.',",
);

// 4) 构造器签名：learnedPath + onSynonymsChanged
s = s.replace(
  "export function createNoteTool({ defineTool, sourceOf, skipPatterns }) {",
  "export function createNoteTool({ defineTool, sourceOf, skipPatterns, learnedPath, onSynonymsChanged }) {",
);

// 5) 写入分支：处理 synonyms
const writeBlock = `      // 写入
      if (!args.text) return '要给 text（要记的结论），或者 list=true / origin=id / retire=id。';
      const source = sourceOf ? sourceOf(exec) : null;
      const { note, added, duplicate } = addNote({ text: args.text, kind: args.kind, source });`;

const newWrite = `      // 记同义词（可以和笔记一起写，也可以只写词）
      const learnSynonyms = (raw) => {
        const words = [...new Set(String(raw).split(/[,，、\\s]+/).map((w) => w.trim()).filter((w) => w.length >= 2))];
        if (words.length < 2) return '同义词至少要两个词，例如 synonyms="网速慢,卡顿"。';
        if (!learnedPath) return '当前没有配置词表路径，跳过同义词。';
        const current = loadLearned(learnedPath);
        const groups = mergeGroups(current.groups, words);
        saveLearned(learnedPath, { groups, links: current.links });
        try {
          onSynonymsChanged?.();
        } catch {
          // 刷新失败不影响写入
        }
        const before = current.groups.length;
        return groups.length > before
          ? \`已记同义词：\${words.join(' ≈ ')}（词表 \${groups.length} 组）\`
          : \`已并入已有同义词组：\${words.join(' ≈ ')}（词表 \${groups.length} 组）\`;
      };

      // 只记词、不写笔记
      if (!args.text && args.synonyms) {
        return learnSynonyms(args.synonyms);
      }

      // 写入
      if (!args.text) return '要给 text（要记的结论），或者 list=true / origin=id / retire=id。';
      const source = sourceOf ? sourceOf(exec) : null;
      const { note, added, duplicate } = addNote({ text: args.text, kind: args.kind, source });
      const synonymLine = args.synonyms ? '\\n' + learnSynonyms(args.synonyms) : '';`;

if (writeBlock in s) {
  s = s.replace(writeBlock, newWrite);
} else {
  throw new Error('写入分支锚点未匹配');
}

// 6) 返回值带上词表结果
s = s.replace(
  "      return `已记住 [${note.id}]${where}：${note.text.length > 80 ? note.text.slice(0, 80) + '…' : note.text}`;",
  "      return `已记住 [${note.id}]${where}：${note.text.length > 80 ? note.text.slice(0, 80) + '…' : note.text}${synonymLine}`;",
);

fs.writeFileSync(`${ROOT}/lib/note-tool.mjs`, s, 'utf8');
console.log('note-tool 支持 synonyms');
