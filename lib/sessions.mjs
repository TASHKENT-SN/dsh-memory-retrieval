/**
 * 读取 DSH 本地会话正文，供集合检索使用。
 *
 * 存储：~/.dsh/sessions/<工作区 slug>/<sessionId>/session.v4.jsonl.zstd
 * 只取 user/message、assistant/message 的文本块与 compaction/summary；
 * 跳过 runtime-context 快照、reasoning、tool-call 参数，避免把噪音灌进索引。
 *
 * 全部本地、零 API、零 embedding。解压与解析按 (路径, mtime, size) 缓存。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CACHE_LIMIT = 24;

/** 运行插件的宿主是 Electron 的 node，版本可能低于命令行；zstd 需要 Node 22.15+。 */
export const zstdAvailable = typeof zlib.zstdDecompressSync === 'function';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压全部 zstd 帧。
 *
 * DSH 每追加一批事件就写一帧，一个会话文件常有几百帧（实测 565KB / 242 帧）。
 * Node 24 的 zstdDecompressSync 只解第一帧（= 244 字节的 session 头），
 * Node 26 才解全部 —— 直接用会得到「0 条消息」，所以这里逐帧解。
 * 压缩数据内部可能恰好出现帧魔数，解码失败就把边界往后并一帧重试。
 */
/**
 * 逐帧解压，并返回「已经解到第几个字节」。
 *
 * 返回 end 是最后一个完整帧的结束位置：末尾如果有还没写完的半帧，
 * 就停在它前面，下一轮从 end 继续，不会重复解压前面已经处理过的内容。
 */
export function decodeZstdFrames(buf, baseOffset = 0) {
  const starts = [];
  for (let at = buf.indexOf(ZSTD_MAGIC); at !== -1; at = buf.indexOf(ZSTD_MAGIC, at + 1)) starts.push(at);
  if (!starts.length) return { text: '', end: baseOffset };

  const parts = [];
  let index = 0;
  let lastEnd = 0;
  while (index < starts.length) {
    const start = starts[index];
    let consumed = -1;
    for (let next = index + 1; next <= starts.length; next += 1) {
      const end = next < starts.length ? starts[next] : buf.length;
      if (end <= start) continue;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
        lastEnd = end;
        consumed = next;
        break;
      } catch {
        // 假魔数或半帧：继续往后合并
      }
    }
    if (consumed < 0) break; // 末尾不完整，留到下次
    index = consumed;
  }
  return { text: Buffer.concat(parts).toString('utf8'), end: baseOffset + lastEnd };
}

export function sessionsRoot() {
  return process.env.DSH_SESSIONS_DIR || path.join(os.homedir(), '.dsh', 'sessions');
}

let dirCache = { at: 0, dirs: [] };
function workspaceDirs() {
  const now = Date.now();
  if (now - dirCache.at < 5000 && dirCache.dirs.length) return dirCache.dirs;
  const root = sessionsRoot();
  const dirs = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      try {
        if (fs.statSync(full).isDirectory()) dirs.push(full);
      } catch {}
    }
  } catch {}
  dirCache = { at: now, dirs };
  return dirs;
}

/** sessionId → 会话文件绝对路径；找不到返回 ''。 */
export function sessionFile(sessionId) {
  const id = String(sessionId ?? '');
  if (!id) return '';
  for (const dir of workspaceDirs()) {
    const file = path.join(dir, id, 'session.v4.jsonl.zstd');
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return '';
}

export function sessionStat(sessionId) {
  const file = sessionFile(sessionId);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    return { file, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
    .trim();
}

/**
 * 读取一个会话的正文消息。
 * @returns {{messages: {role:string,text:string,time:number}[], bytes:number, mtimeMs:number}}
 */
/**
 * 逻辑由插件配置提供：`sessionSkipPatterns` 是一组正则字符串。
 * 默认空，不内置任何「唤醒模板」前缀 —— 每个用户的 agent 情况不同，
 * 由使用者在 config.json / 设置页里自行决定要跳过什么。
 */
function compileSkipPatterns(patterns) {
  const out = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    try {
      out.push(new RegExp(String(pattern)));
    } catch {
      // 单个坏正则不影响其它规则
    }
  }
  return out;
}

const fileCache = new Map(); // file -> { size, offset, skipKey, carry, value }

const EMPTY = () => ({ messages: [], toolCalls: [], title: '', bytes: 0, mtimeMs: 0 });

function readRange(file, offset, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function parseInto(text, skips, sink) {
  const lines = text.split('\n');
  const carry = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const data = record?.data ?? {};
    const time = Number(record?.time ?? 0);
    if (record.type === 'session/title') {
      const next = String(data.title ?? data.value ?? '').trim();
      if (next) sink.title = next;
      continue;
    }
    if (record.type === 'user/message') {
      if (data?.source?.kind === 'runtime-context') continue;
      const body = textOf(data.content);
      if (body && !skips.some((pattern) => pattern.test(body))) sink.messages.push({ role: 'user', text: body, time });
    } else if (record.type === 'assistant/message') {
      const body = textOf(data?.message?.content);
      if (body) sink.messages.push({ role: 'assistant', text: body, time });
    } else if (record.type === 'tool/call') {
      const name = String(data.name ?? data.toolName ?? '');
      if (name) sink.toolCalls.push({ name, args: String(data.arguments ?? '').slice(0, 500), time });
    } else if (record.type === 'compaction/summary') {
      const body = textOf(data.summary);
      if (body) sink.messages.push({ role: 'summary', text: body, time });
    }
  }
  return carry;
}

/**
 * 读取一个会话的正文消息（增量）。
 *
 * 会话日志只追加：文件变大时只解压尾部新帧、只解析新行，
 * 覆盖率与全量一致，成本只跟「新增内容」成正比。
 * 文件被重写（变短）或换了跳过规则时退回全量。
 */
export function readSessionMessages(sessionId, { skipPatterns = [] } = {}) {
  const file = sessionFile(sessionId);
  if (!file) return EMPTY();

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return EMPTY();
  }

  const skipKey = skipPatterns.join('\u0001');
  const prev = fileCache.get(file);

  // 完全没变
  if (prev && prev.skipKey === skipKey && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    return prev.value;
  }

  // 只追加：增量解压
  if (prev && prev.skipKey === skipKey && st.size > prev.size && prev.offset <= st.size) {
    try {
      const tail = readRange(file, prev.offset, st.size - prev.offset);
      const { text, end } = decodeZstdFrames(tail, prev.offset);
      if (end > prev.offset) {
        const value = {
          messages: [...prev.value.messages],
          toolCalls: [...prev.value.toolCalls],
          title: prev.value.title,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        };
        const skips = compileSkipPatterns(skipPatterns);
        const carry = parseInto(prev.carry + text, skips, value);
        const entry = { size: st.size, mtimeMs: st.mtimeMs, offset: end, skipKey, carry, value };
        fileCache.set(file, entry);
        return value;
      }
    } catch (error) {
      // 增量失败就退回全量，不影响正确性
      console.error('[dsh-memory-retrieval] 增量解压失败，退回全量: ' + String(error?.message ?? error));
    }
  }

  // 全量
  const skips = compileSkipPatterns(skipPatterns);
  const { text, end } = decodeZstdFrames(fs.readFileSync(file), 0);
  const value = { messages: [], toolCalls: [], title: '', bytes: st.size, mtimeMs: st.mtimeMs };
  const carry = parseInto(text, skips, value);
  fileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, offset: end, skipKey, carry, value });
  while (fileCache.size > CACHE_LIMIT) fileCache.delete(fileCache.keys().next().value);
  return value;
}

/** 把消息切成 ~chunkChars 字的片段，保留时间范围与说话人。 */
export function chunkMessages(messages, { chunkChars = 600, capChars = 0 } = {}) {
  let list = messages;
  if (capChars > 0) {
    const total = list.reduce((sum, message) => sum + message.text.length, 0);
    if (total > capChars) {
      const kept = [];
      let acc = 0;
      for (let i = list.length - 1; i >= 0 && acc < capChars; i -= 1) {
        kept.unshift(list[i]);
        acc += list[i].text.length;
      }
      list = kept;
    }
  }

  const chunks = [];
  let buffer = '';
  let from = 0;
  let to = 0;
  let lastRole = '';
  let flushStart = 0;

  // 注意：to 必须显式传入。此前先更新了 to 再 flush，会把「下一条消息」的时间
  // 盖到上一段上——旧内容因此显得比实际新，自检索按时间过滤时会被误杀。
  const flush = (msgTo, toTime) => {
    const text = buffer.trim();
    if (text) chunks.push({ text, from, to: toTime, msgFrom: flushStart, msgTo });
    buffer = '';
  };

  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    const role = message.role === 'user' ? '用户' : message.role === 'summary' ? '摘要' : '助手';
    if (!from) from = message.time;
    const previousTo = to;
    to = message.time;
    const piece = role === lastRole ? message.text : `${role}：${message.text}`;
    lastRole = role;

    if (buffer.length + piece.length + 1 > chunkChars && buffer.length > 0) {
      flush(index - 1, previousTo);
      flushStart = index;
      buffer = `${role}：${message.text}`;
      lastRole = role;
    } else {
      buffer = buffer ? `${buffer}\n${piece}` : piece;
    }
  }
  flush(list.length - 1, to);
  return chunks;
}
