/**
 * 会话集合：把若干会话的全文拼成一个可检索索引。
 *
 * 「集合内的全量上下文」= 集合内每个会话的完整正文都进索引（默认不截断），
 * 检索后只把最相关的少量片段注入 prompt —— 199 万字不可能整块塞进上下文，
 * 但可以全量索引、按需取片段。
 *
 * 纯本地：零 API、零 embedding；索引按 (会话文件 mtime/size + 参数) 缓存。
 */
import { readSessionMessages, chunkMessages, sessionStat } from './sessions.mjs';
import { buildQueryUnits } from './retrieval.mjs';

const indexCache = new Map();
const chunkCache = new Map(); // sessionId -> { count, chunkChars, chunks, bytes }
// 预算按字节算：大会话自然受限，小会话能多存。默认 1GB。
let chunkCacheBudget = Number(process.env.DSH_MR_CACHE_MB || 1024) * 1024 * 1024;

/** 运行时可调：设置索引缓存预算（MB）。 */
export function setCacheBudgetMB(mb) {
  const value = Number(mb);
  if (Number.isFinite(value) && value > 0) chunkCacheBudget = value * 1024 * 1024;
}
let chunkCacheBytes = 0;

function estimateBytes(chunks) {
  let bytes = 0;
  for (const chunk of chunks) {
    bytes += chunk.text.length * 2 + chunk.terms.byteLength + 240; // 字符串 + 哈希数组 + 对象头
  }
  return bytes;
}

/** FNV-1a 32 位哈希：词项只存哈希值，省掉上百万个字符串对象。 */
export function hashTerm(word) {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 二分查找：terms 必须是升序 Uint32Array。 */
function hasHash(terms, hash) {
  let lo = 0;
  let hi = terms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = terms[mid];
    if (value === hash) return true;
    if (value < hash) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * 建索引用的轻量分词：只做拉丁词 + 中文 bigram，输出排序后的哈希数组。
 * 不用 Intl.Segmenter —— 199 万字逐个分块跑 Segmenter 要好几秒。
 */
export function termsOf(text) {
  const set = new Set();
  const lowered = text.toLowerCase();
  for (const match of lowered.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) set.add(hashTerm(match[0]));
  for (const run of lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) set.add(hashTerm(run.slice(i, i + 2)));
  }
  return Uint32Array.from(set).sort();
}

function signatureOf(collection, options) {
  const parts = (collection.sessionIds || []).map((id) => {
    const stat = sessionStat(id);
    return stat ? `${id}@${stat.mtimeMs}/${stat.bytes}` : `${id}@missing`;
  });
  return `${options.chunkChars}/${options.capChars}|${(options.skipPatterns || []).join('\u0001')}|${parts.join(',')}`;
}

/**
 * 构建（或复用缓存）集合索引。
 * @returns {{chunks: object[], sessions: object[], stats: object, signature: string}}
 */

/** 会话 -> 分块缓存。日志只追加，所以只重分块尾部，覆盖率不变。 */
const RECHUNK_TAIL = 40;

function setChunks(key, entry) {
  const prev = chunkCache.get(key);
  if (prev) chunkCacheBytes -= prev.bytes ?? 0;
  chunkCache.delete(key);
  const sized = { ...entry, bytes: estimateBytes(entry.chunks) };
  chunkCache.set(key, sized);
  chunkCacheBytes += sized.bytes;
  while (chunkCacheBytes > chunkCacheBudget && chunkCache.size > 1) {
    const oldestKey = chunkCache.keys().next().value;
    const dropped = chunkCache.get(oldestKey);
    chunkCacheBytes -= dropped?.bytes ?? 0;
    chunkCache.delete(oldestKey);
  }
}

function chunksForSession(sessionId, messages, options) {
  const chunkChars = options.chunkChars;
  const key = String(sessionId);
  const prev = chunkCache.get(key);

  // capChars > 0 时依赖总数，直接全量重算，避免边界错位
  const canAppend = prev
    && prev.chunkChars === chunkChars
    && !options.capChars
    && messages.length >= prev.count
    && prev.count > RECHUNK_TAIL;

  if (!canAppend) {
    const chunks = chunkMessages(messages, { chunkChars, capChars: options.capChars })
      .map((chunk) => ({ ...chunk, terms: termsOf(chunk.text) }));
    setChunks(key, { count: messages.length, chunkChars, chunks });
    return chunks;
  }

  if (messages.length === prev.count) return prev.chunks;

  const startIndex = Math.max(0, prev.count - RECHUNK_TAIL);
  const kept = prev.chunks.filter((chunk) => chunk.msgTo < startIndex);
  const tail = chunkMessages(messages.slice(startIndex), { chunkChars, capChars: 0 })
    .map((chunk) => ({
      ...chunk,
      msgFrom: chunk.msgFrom + startIndex,
      msgTo: chunk.msgTo + startIndex,
      terms: termsOf(chunk.text),
    }));
  const chunks = [...kept, ...tail];
  setChunks(key, { count: messages.length, chunkChars, chunks });
  return chunks;
}

export function getCollectionIndex(collection, options = {}, titles = new Map()) {
  const opts = { chunkChars: 600, capChars: 0, skipPatterns: [], ...options };
  const signature = signatureOf(collection, opts);
  const key = `${collection.id}|${signature}`;
  const hit = indexCache.get(key);
  if (hit) {
    hit.at = Date.now();
    return hit.index;
  }

  const chunks = [];
  const sessions = [];
  let chars = 0;
  let bytes = 0;
  let messages = 0;

  for (const sessionId of collection.sessionIds || []) {
    const stat = sessionStat(sessionId);
    if (!stat) {
      sessions.push({ id: sessionId, title: titles.get(sessionId) || sessionId, missing: true, chunks: 0, chars: 0, messages: 0 });
      continue;
    }
    const { messages: list, title: logTitle } = readSessionMessages(sessionId, { skipPatterns: opts.skipPatterns });
    const title = titles.get(sessionId) || logTitle || sessionId;
    const wholeChars = list.reduce((sum, message) => sum + message.text.length, 0);
    const pieces = chunksForSession(sessionId, list, opts);
    for (const piece of pieces) {
      chunks.push({ sessionId, title, ...piece });
    }
    chars += wholeChars;
    bytes += stat.bytes;
    messages += list.length;
    sessions.push({
      id: sessionId,
      title,
      bytes: stat.bytes,
      mtimeMs: stat.mtimeMs,
      messages: list.length,
      chars: wholeChars,
      chunks: pieces.length,
      missing: false,
    });
  }

  const index = {
    chunks,
    sessions,
    stats: { sessions: sessions.length, chunks: chunks.length, chars, bytes, messages, signature },
  };
  indexCache.set(key, { index, at: Date.now() });
  // 同一个集合改了配置会换 key，清掉旧的，避免无限增长
  for (const [k, value] of indexCache) {
    if (k.startsWith(`${collection.id}|`) && k !== key) indexCache.delete(k);
  }
  while (indexCache.size > 12) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, value] of indexCache) {
      if (value.at < oldest) {
        oldest = value.at;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    indexCache.delete(oldestKey);
  }
  return index;
}

export function clearCollectionCache(collectionId) {
  if (!collectionId) {
    indexCache.clear();
    chunkCache.clear();
    chunkCacheBytes = 0;
    return;
  }
  for (const key of [...indexCache.keys()]) {
    if (key.startsWith(`${collectionId}|`)) indexCache.delete(key);
  }
}

/**
 * 在集合里检索与 query 相关的片段。
 * 结果按「每会话最多 perSessionLimit 段」分散，避免某个超大会话垄断。
 */
// 中文虚词：和它们组成的 bigram（「提的」「我很」「是不」）几乎不含信息，
// 却因为偶然出现而 df 很小，会被当成"少见词"把无关片段拉进来。
export const FUNCTION_CHARS = new Set('的了是我你他她它在有和就都也很不吗呢吧啊这那个们把被给对与及或里上下中到后前会要能说做么什');
export function isFunctionPair(term) {
  if (term.length !== 2) return false;
  for (const ch of term) if (FUNCTION_CHARS.has(ch)) return true;
  return false;
}

export function searchCollection(index, query, options = {}) {
  const {
    topK = 5,
    maxChars = 1400,
    perSnippetChars = 300,
    minScore = 1,
    minHits = 2,
    synonymMap = null,
    synonymGroups = [],
    synonymWeight = 0.7,
    excludeSessionId = '',
    perSessionLimit = 2,
  } = options;

  const units = buildQueryUnits(query, synonymMap, synonymGroups).filter((unit) => unit.origin.length > 1 || /[a-z0-9]/.test(unit.origin));
  if (!units.length) return [];
  // 整句都是虚词（「这也很好」）时没有可检索的信息量，直接返回空
  if (!units.some((unit) => !isFunctionPair(unit.origin) && unit.origin.length > 1)) return [];
  const terms = units.flatMap((unit) => unit.variants);
  // 很短的问题（≤2 个单元）只有一个实词可用，强行要求 2 个会把正常问题挡掉
  const required = units.length <= 2 ? 1 : Math.min(minHits, units.length);

  const pool = index.chunks.filter((chunk) => chunk.sessionId !== excludeSessionId);
  if (!pool.length) return [];

  // 文档频率 → idf，压掉「用户」「助手」这类高频词的权重
  const df = new Map();
  for (const term of terms) {
    let count = 0;
    const hash = hashTerm(term);
    for (const chunk of pool) if (hasHash(chunk.terms, hash)) count += 1;
    df.set(term, count);
  }
  const N = pool.length;
  // 准入用「未降权」的 idf：降权只影响排序，不该把整段挡在门外（原则一）。
  const rawWeight = (term) => {
    const d = df.get(term) ?? 0;
    if (!d) return 0;
    return Math.log(1 + N / d) * (term.length >= 3 ? 1.2 : 1);
  };
  const weight = (term) => {
    const d = df.get(term) ?? 0;
    if (!d) return 0;
    const idf = Math.log(1 + N / d);
    // 通用词降权：像「插件」「测试」「DSH」这种在集合里到处都有的词，
    // idf 也还有 1.1 左右，单靠它就能过 minScore，于是把无关片段带进来。
    // 出现率超过 35% 的词几乎不参与打分，超过 60% 基本视为停用词。
    // 语料很小时（测试夹具、刚建的集合）df/N 没有统计意义，别降权
    const ratio = d / N;
    const damp = N < 20 ? 1 : ratio > 0.6 ? 0.05 : ratio > 0.35 ? 0.2 : 1;
    const noise = isFunctionPair(term) ? 0.25 : 1;
    return idf * damp * noise * (term.length >= 3 ? 1.2 : 1);
  };

  const scored = [];
  for (const chunk of pool) {
    let score = 0;
    let rawScore = 0;
    let hits = 0;
    let specificDf = Infinity; // 命中的最具体词（df 最小），用来判断是不是只蹭到了通用词
    let gateScore = 0; // 未降权的原始分，只用于过 minScore
    for (const unit of units) {
      let best = 0;
      let bestRaw = 0;
      for (const variant of unit.variants) {
        if (!hasHash(chunk.terms, hashTerm(variant))) continue;
        const raw = weight(variant);
        const factor = variant === unit.origin ? 1 : synonymWeight;
        best = Math.max(best, raw * factor);
        bestRaw = Math.max(bestRaw, raw);
      }
      if (bestRaw > 0) {
        score += best;
        rawScore += bestRaw;
        gateScore += Math.max(0, ...unit.variants.filter((v) => hasHash(chunk.terms, hashTerm(v))).map(rawWeight));
        hits += 1;
        for (const variant of unit.variants) {
          if (isFunctionPair(variant)) continue; // 虚词不算"实质命中"
          if (!hasHash(chunk.terms, hashTerm(variant))) continue;
          const d = df.get(variant) ?? 0;
          if (d > 0 && d < specificDf) specificDf = d;
        }
      }
    }
    if (hits < required || gateScore < minScore) continue;
    // hits 里若全是通用词，rawScore 已经被打压；这里再明确要求一次实质命中
    if (score <= 0) continue;
    // 分层而不是淘汰（设计原则第一条：检索层只负责召回）。
    // 只命中通用词的片段照样保留，但标成 weak，排到后面、有空位才补进来。
    const specificLimit = Math.max(3, Math.floor(N * 0.1));
    const weak = N >= 20 && !(specificDf <= specificLimit);
    scored.push({ chunk, score, rawScore, hits, weak });
  }

  scored.sort((a, b) => {
    if (a.weak !== b.weak) return a.weak ? 1 : -1;
    return b.score - a.score || b.chunk.to - a.chunk.to;
  });

  const picked = [];
  const perSession = new Map();
  const seenPrefix = new Set();
  let used = 0;
  for (const item of scored) {
    if (picked.length >= topK) break;
    const count = perSession.get(item.chunk.sessionId) ?? 0;
    if (count >= perSessionLimit) continue;
    // 同一段人设卡这类内容会在多个分块里重复出现，按前缀去重
    const prefix = item.chunk.text.replace(/\s+/g, '').slice(0, 60);
    if (prefix.length > 20 && seenPrefix.has(prefix)) continue;
    const text = snippet(item.chunk, terms, perSnippetChars);
    if (used + text.length > maxChars) continue;
    used += text.length;
    if (prefix.length > 20) seenPrefix.add(prefix);
    perSession.set(item.chunk.sessionId, count + 1);
    picked.push({
      sessionId: item.chunk.sessionId,
      title: item.chunk.title,
      time: item.chunk.to || item.chunk.from,
      text,
      score: Math.round(item.score * 100) / 100,
      hits: item.hits,
      weak: Boolean(item.weak),
    });
  }
  return picked;
}

function snippet(chunk, terms, maxChars) {
  const raw = chunk.text.replace(/\s+/g, ' ').trim();
  if (raw.length <= maxChars) return raw;
  let at = -1;
  for (const term of terms) {
    const i = raw.toLowerCase().indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(maxChars / 3));
  return `${start > 0 ? '…' : ''}${raw.slice(start, start + maxChars)}${start + maxChars < raw.length ? '…' : ''}`;
}

export function formatDate(ms) {
  if (!ms) return '';
  try {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

/** 生成注入块。 */
export function formatCollectionBlock(name, results, { askWhenUnsure = true } = {}) {
  if (!results.length) return '';
  const lines = [
    `【集合记忆 · 「${name}」跨会话】`,
    '下面是同一集合里其它会话的原文片段，按和当前消息的关键词相关度选出，可能只是词面重合：',
    '',
  ];
  const strong = results.filter((item) => !item.weak);
  const weak = results.filter((item) => item.weak);
  for (const item of strong) {
    const when = formatDate(item.time);
    lines.push(`- 《${item.title}》${when ? ` ${when}` : ''}：${item.text}`);
  }
  if (weak.length) {
    lines.push('');
    lines.push('（下面这些只是词面重合、可信度较低，可以当没看见）');
    for (const item of weak) {
      const when = formatDate(item.time);
      lines.push(`- 《${item.title}》${when ? ` ${when}` : ''}：${item.text}`);
    }
  }
  lines.push('');
  lines.push(
    askWhenUnsure
      ? '这些是历史对话原文：相关就像自己记得一样自然带出，不确定就先问用户「我之前在另一个会话里提过……，是同一个吗？」，不相关就忽略。'
      : '这些是历史对话原文：只用确定相关的部分，不相关就忽略。',
  );
  return lines.join('\n');
}
