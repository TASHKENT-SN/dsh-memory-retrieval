/**
 * 全量记忆卡：把角色自己的 memory-card.json 读成可检索的记录。
 *
 * 兼容：
 *   - 顶层数组
 *   - { records: [...] } / { memories: [...] } / { items: [...] }
 *   - 每条记录至少要有 text / content / detail 之一
 *
 * 纯本地、只读；按文件 mtime/size 缓存。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cache = new Map();

export function resolveMemoryCardPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => textOf(item)).filter(Boolean).join('\n');
  return '';
}

function normalizeRecord(raw, index) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? { id: `card-${index + 1}`, title: '', text, tags: [], importance: 0, at: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? raw.name ?? '').trim();
  const body = textOf(raw.text) || textOf(raw.content) || textOf(raw.detail) || textOf(raw.summary);
  if (!title && !body) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
  for (const extra of [raw.kind, raw.source, raw.platform, raw.scope]) {
    if (extra && !tags.includes(String(extra))) tags.push(String(extra));
  }
  return {
    id: String(raw.id ?? `card-${index + 1}`),
    title: title || body.slice(0, 80),
    text: body || title,
    tags,
    importance: Number(raw.importance ?? raw.weight ?? 0) || 0,
    at: String(raw.at ?? raw.createdAt ?? raw.updatedAt ?? raw.time ?? ''),
  };
}

/** 读取并归一化全量记忆卡；文件不存在/坏了返回空数组。 */
export function loadMemoryCard(rawPath) {
  const file = resolveMemoryCardPath(rawPath);
  if (!file) return [];
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const key = `${file}|${stat.mtimeMs}|${stat.size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let root;
  try {
    root = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[dsh-memory-retrieval] 读取全量记忆卡失败 ${file}: ${error?.message ?? error}`);
    return [];
  }
  const list = Array.isArray(root)
    ? root
    : Array.isArray(root?.records)
      ? root.records
      : Array.isArray(root?.memories)
        ? root.memories
        : Array.isArray(root?.items)
          ? root.items
          : [];
  const records = list.map(normalizeRecord).filter(Boolean);
  cache.set(key, records);
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return records;
}
