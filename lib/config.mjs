import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
  return process.env.DSH_MEMORY_RETRIEVAL_DIR || path.join(os.homedir(), '.dsh', 'dsh-memory-retrieval');
}

export function userConfigPath() {
  return path.join(configDir(), 'config.json');
}

export function defaultConfig() {
  return {
    enabled: true,
    label: 'Memory',
    memoryPath: '',
    topK: 5,
    maxChars: 800,
    minScore: 1,
    perRecordChars: 180,
    askWhenUnsure: true,
    includeSessionPatterns: [],
    excludeSessionPatterns: [],
    sessionOverrides: {},
    workspaceGlobalRetrieval: {},
    // 会话集合：把多个会话的全文索引起来，集合内跨会话检索
    collections: [],
    collectionRetrieval: true,
    collectionTopK: 5,
    collectionMaxChars: 1400,
    collectionPerSnippetChars: 300,
    collectionChunkChars: 600,
    collectionSessionCapChars: 0,
    cacheBudgetMB: 1024, // 索引缓存预算（MB），大会话多、小会话少 // 0 = 不截断，整个会话都进索引
    // 匹配严格度与近义词
    minHits: 2,            // 至少要命中几个查询词（单字查询自动降到 1）
    // 被动自检索：从当前会话自己的完整历史里捞较早的片段
    selfRetrieval: true,
    selfTopK: 2,
    selfMaxChars: 600,
    selfMinAgeMinutes: 15, // 最近 N 分钟内的消息还在 prompt 里，不再注入
    sessionSkipPatterns: [], // 一组正则；匹配到的 user 消息不进索引（用户按自己的 agent 配）
    // 单独的全量记忆卡（角色 memory-card.json）
    memoryCardPath: '',
    memoryCardRetrieval: true,
    memoryCardTopK: 3,
    memoryCardMaxChars: 900,
    memoryCardSessionIds: [], // 这张卡属于哪些会话；用于「注入卡就关掉该会话自检索」
    memoryCardAutoDisableSelf: true,
    synonymsEnabled: true,
    synonymPath: '',       // 空 = ~/.dsh/dsh-memory-retrieval/synonyms.json 或内置表
    synonymWeight: 0.7,
    autoLearnWords: true, // 在注入块尾部提醒模型：发现说法不一致可以自己记下来
    relatedHops: true, // 联想第二跳：主检索提到「网络」时，顺藤摸一下用户登记过的「路由器」
    relatedTopK: 1,
    relatedMaxChars: 300,
    recallMidTask: false, // true: 任务中途也继续联想（可能话题跳脱）    // 同义词命中的权重（原词是 1）
  };
}

export function normalizeCollections(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    let id = String(raw.id ?? '').trim() || `col-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const sessionIds = Array.isArray(raw.sessionIds)
      ? [...new Set(raw.sessionIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
      : [];
    out.push({
      id,
      name: String(raw.name ?? '').trim().slice(0, 60) || `集合 ${index + 1}`,
      enabled: raw.enabled !== false,
      sessionIds,
    });
  });
  return out;
}

export function normalizeConfig(input = {}) {
  const base = defaultConfig();
  const value = { ...base, ...(input ?? {}) };
  value.enabled = value.enabled !== false;
  value.label = String(value.label || 'Memory');
  value.memoryPath = String(value.memoryPath || '');
  value.topK = Math.max(1, Math.min(20, Number(value.topK) || base.topK));
  value.maxChars = Math.max(200, Math.min(4000, Number(value.maxChars) || base.maxChars));
  value.minScore = Math.max(0, Number(value.minScore) || 0);
  value.perRecordChars = Math.max(60, Math.min(1000, Number(value.perRecordChars) || base.perRecordChars));
  value.askWhenUnsure = value.askWhenUnsure !== false;
  value.includeSessionPatterns = Array.isArray(value.includeSessionPatterns) ? value.includeSessionPatterns.map(String) : [];
  value.excludeSessionPatterns = Array.isArray(value.excludeSessionPatterns) ? value.excludeSessionPatterns.map(String) : [];
  value.sessionOverrides = value.sessionOverrides && typeof value.sessionOverrides === 'object' && !Array.isArray(value.sessionOverrides)
    ? Object.fromEntries(Object.entries(value.sessionOverrides).filter(([, enabled]) => typeof enabled === 'boolean'))
    : {};
  // 迁移必须在 input 上判断：base 里已有 workspaceGlobalRetrieval: {}，
  // 在合并后的 value 上用 ?? 永远取不到 workspaceCrossSession（旧键迁移曾经因此失效）。
  const raw = input ?? {};
  const globalMap = raw.workspaceGlobalRetrieval ?? raw.workspaceCrossSession;
  value.workspaceGlobalRetrieval = globalMap
    && typeof globalMap === 'object'
    && !Array.isArray(globalMap)
    ? Object.fromEntries(Object.entries(globalMap).filter(([, enabled]) => typeof enabled === 'boolean'))
    : {};
  delete value.workspaceCrossSession;
  value.collections = normalizeCollections(value.collections);
  value.collectionRetrieval = value.collectionRetrieval !== false;
  value.collectionTopK = Math.max(1, Math.min(20, Number(value.collectionTopK) || base.collectionTopK));
  value.collectionMaxChars = Math.max(200, Math.min(8000, Number(value.collectionMaxChars) || base.collectionMaxChars));
  value.collectionPerSnippetChars = Math.max(80, Math.min(2000, Number(value.collectionPerSnippetChars) || base.collectionPerSnippetChars));
  value.collectionChunkChars = Math.max(200, Math.min(4000, Number(value.collectionChunkChars) || base.collectionChunkChars));
  value.collectionSessionCapChars = Math.max(0, Number(value.collectionSessionCapChars) || 0);
  value.cacheBudgetMB = Math.max(64, Math.min(10240, Number(value.cacheBudgetMB) || base.cacheBudgetMB));
  value.minHits = Math.max(1, Math.min(6, Number(value.minHits) || base.minHits));
  value.selfRetrieval = value.selfRetrieval !== false;
  value.selfTopK = Math.max(1, Math.min(10, Number(value.selfTopK) || base.selfTopK));
  value.selfMaxChars = Math.max(200, Math.min(4000, Number(value.selfMaxChars) || base.selfMaxChars));
  const selfAge = Number(value.selfMinAgeMinutes);
  value.selfMinAgeMinutes = Number.isFinite(selfAge)
    ? Math.max(0, Math.min(1440, selfAge))
    : base.selfMinAgeMinutes;
  value.sessionSkipPatterns = Array.isArray(value.sessionSkipPatterns)
    ? [...new Set(value.sessionSkipPatterns.map((pattern) => String(pattern ?? '').trim()).filter(Boolean))].slice(0, 100)
    : [];
  value.memoryCardPath = String(value.memoryCardPath ?? '').trim();
  value.memoryCardRetrieval = value.memoryCardRetrieval !== false;
  value.memoryCardTopK = Math.max(1, Math.min(10, Number(value.memoryCardTopK) || base.memoryCardTopK));
  value.memoryCardMaxChars = Math.max(200, Math.min(4000, Number(value.memoryCardMaxChars) || base.memoryCardMaxChars));
  value.memoryCardSessionIds = Array.isArray(value.memoryCardSessionIds)
    ? [...new Set(value.memoryCardSessionIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
    : [];
  value.memoryCardAutoDisableSelf = value.memoryCardAutoDisableSelf !== false;
  value.synonymsEnabled = value.synonymsEnabled !== false;
  value.synonymPath = String(value.synonymPath || '');
  value.synonymWeight = Math.max(0.1, Math.min(1, Number(value.synonymWeight) || base.synonymWeight));
  value.autoLearnWords = value.autoLearnWords !== false;
  value.relatedHops = value.relatedHops !== false;
  value.relatedTopK = Math.max(1, Math.min(3, Number(value.relatedTopK) || base.relatedTopK));
  value.relatedMaxChars = Math.max(120, Math.min(1200, Number(value.relatedMaxChars) || base.relatedMaxChars));
  value.recallMidTask = value.recallMidTask === true;
  return value;
}

export function readUserConfig(file = userConfigPath()) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeConfig();
  }
}

export function writeUserConfig(config, file = userConfigPath()) {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}
