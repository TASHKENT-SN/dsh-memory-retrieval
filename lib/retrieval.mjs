/**
 * 通用本地记忆检索（零 API、零 embedding）。
 *
 * 记忆格式：JSONL，每行 { id?, title?, text, tags?, importance?, at? }。
 * 检索：拉丁词/编号整词 + 中文 Intl.Segmenter 词 + 连续汉字 bigram。
 * 只负责返回候选；是否相关、要不要问用户，由模型在 prompt 里判断。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultMemoryPath() {
  return path.join(os.homedir(), '.dsh', 'dsh-memory-retrieval', 'memory.jsonl');
}

export const DEFAULT_MEMORY = defaultMemoryPath();

const STOP = new Set([
  '什么', '怎么', '为什么', '哪个', '哪里', '是否', '多少', '一下', '一个', '这个', '那个',
  '我们', '你们', '他们', '自己', '现在', '时候', '可以', '需要', '知道', '记得', '告诉',
  '的', '了', '是', '在', '有', '和', '与', '及', '或', '就', '都', '也', '很', '还', '又',
  '我', '你', '他', '她', '它', '这', '那', '吗', '呢', '吧', '啊', '呀', '哦', '嗯',
]);

export function ensureMemoryFile(file = DEFAULT_MEMORY) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  return file;
}

export function loadMemory(file = DEFAULT_MEMORY) {
  ensureMemoryFile(file);
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`记忆文件第 ${index + 1} 行不是合法 JSON: ${error.message}`);
    }
  });
}

/** 由虚词构成的二元组（「怎么」「什么」「今天」）不参与匹配，只制造噪音。 */
const FUNCTION_CHARS = new Set([...'的了是在有和与就都也还又我你他她它这那吗呢吧啊呀哦嗯怎么什哪谁为何如多少些个']);

export function tokenize(input) {
  const text = String(input ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const terms = new Set();

  for (const m of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) terms.add(m[0]);

  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const part of seg.segment(text)) {
      if (!part.isWordLike) continue;
      const word = part.segment.trim();
      if (/^[\u4e00-\u9fff]{2,}$/.test(word) && !STOP.has(word)) terms.add(word);
    }
  } catch {
    // 老 Node 没有 Segmenter：只靠下面的 bigram
  }

  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (STOP.has(bigram)) continue;
      // 「怎么」「什么」「今天」这类由虚词构成的二元组只制造噪音，直接丢掉
      if (FUNCTION_CHARS.has(bigram[0]) || FUNCTION_CHARS.has(bigram[1])) continue;
      terms.add(bigram);
    }
  }
  return [...terms];
}

function snippet(text, terms, maxChars) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length <= maxChars) return raw;
  let at = -1;
  for (const term of terms) {
    const i = raw.toLowerCase().indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(maxChars / 3));
  return `${start > 0 ? '…' : ''}${raw.slice(start, start + maxChars)}${start + maxChars < raw.length ? '…' : ''}`;
}

/**
 * 把查询拆成「单元」：每个单元 = 原词 + 它的同义词变体。
 * 计分时一个单元最多算命中一次，避免同义词堆叠刷分。
 */
/** 单个查询词最多扩出几个变体：外部大词库（如词林）很容易把一句话扩成几十个词。 */
const MAX_VARIANTS = 8;

export function buildQueryUnits(query, synonymMap, synonymGroups = []) {
  return tokenize(query).map((term) => {
    const variants = new Set();
    const direct = synonymMap?.get(term);
    if (direct) for (const word of direct) variants.add(word);
    // 「网速慢」这类词表条目不会被切成同一个二元组，所以再按包含关系找一遍
    if (!direct && term.length >= 2) {
      for (const group of synonymGroups) {
        if (!group.some((word) => word.includes(term) || term.includes(word))) continue;
        for (const word of group) if (word !== term) variants.add(word);
      }
    }
    return { origin: term, variants: variants.size ? [term, ...[...variants].slice(0, MAX_VARIANTS)] : [term] };
  });
}

export function search(memory, query, {
  topK = 5,
  maxChars = 800,
  perRecordChars = 180,
  minScore = 1,
  minHits = 2,
  synonymMap = null,
  synonymGroups = [],
  synonymWeight = 0.7,
} = {}) {
  const units = buildQueryUnits(query, synonymMap, synonymGroups).filter((unit) => unit.origin.length > 1 || /[a-z0-9]/.test(unit.origin));
  if (!units.length) return [];
  // 很短的问题（≤2 个单元）只有一个实词可用，强行要求 2 个会把正常问题挡掉
  const required = units.length <= 2 ? 1 : Math.min(minHits, units.length);

  const scored = memory.map((record) => {
    const haystack = `${record.title ?? ''} ${record.text ?? ''} ${(record.tags ?? []).join(' ')}`.toLowerCase();
    let score = 0;
    let rawScore = 0;
    let hits = 0;
    for (const unit of units) {
      let best = 0;
      let bestRaw = 0;
      for (const variant of unit.variants) {
        const count = haystack.split(variant).length - 1;
        if (!count) continue;
        const raw = count * (variant.length >= 3 ? 2 : 1);
        const weight = variant === unit.origin ? 1 : synonymWeight;
        best = Math.max(best, raw * weight);
        bestRaw = Math.max(bestRaw, raw);
      }
      if (bestRaw > 0) {
        score += best;
        rawScore += bestRaw;
        hits += 1;
      }
    }
    return { record, score, rawScore, hits };
  }).filter((item) => item.rawScore >= minScore && item.hits >= required)
    .sort((a, b) => b.score - a.score
      || (b.record.importance ?? 0) - (a.record.importance ?? 0)
      || String(b.record.at ?? '').localeCompare(String(a.record.at ?? '')));

  const picked = [];
  let used = 0;
  const terms = units.flatMap((unit) => unit.variants);
  for (const item of scored) {
    if (picked.length >= topK) break;
    const text = snippet(item.record.text, terms, perRecordChars);
    if (used + text.length > maxChars) continue;
    used += text.length;
    picked.push({ ...item, snippet: text });
  }
  return picked;
}

export function formatBlock(results, { maxChars = 800, label = 'Memory', askWhenUnsure = true } = {}) {
  if (!results.length) return '';
  const unsureLine = askWhenUnsure
    ? '- 拿不准：不要硬答，先问用户「我想起来之前……，是刚刚说的这个吗？」；'
    : '- 拿不准：只说你确定的部分，或说「记不清了」，不要编造；';
  const header = [
    '【旧记忆候选 · 可能和当前话题无关】',
    `下面是从「${label}」的长期记忆里按关键词检索到的旧片段，可能只是词面重合。`,
    '回答前先判断：',
    '- 明显相关：用你自己的话自然带出，不要原文照搬；',
    unsureLine,
    '- 不相关：忽略，不要提。',
    '',
  ].join('\n');
  let body = '';
  for (const item of results) {
    const line = `- ${item.snippet}`;
    if (body.length + line.length + 1 > maxChars) break;
    body += `${line}\n`;
  }
  return `${header}${body}`.trim();
}
