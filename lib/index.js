/**
 * dsh-memory-retrieval — 通用 DSH 记忆检索注入插件。
 *
 * 对每个 agent：
 *   1. 在 agent 的 scoped ctx 注册 system prompt section；
 *   2. 记录当前用户消息（agent/inbox/claimed）；
 *   3. 每次 assembly 本地检索 memoryPath，注入【旧记忆候选】。
 *
 * 设置页通过 /api/dsh-memory-retrieval/* 读写配置，保存后立即生效。
 * 不依赖 SurfCore；不调用 API；记忆只读，不自动写入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { defaultMemoryPath, ensureMemoryFile, loadMemory, search, formatBlock } from './retrieval.mjs';
import { normalizeConfig, readUserConfig, userConfigPath, writeUserConfig, configDir } from './config.mjs';
import { getCollectionIndex, searchCollection, formatCollectionBlock, formatDate, clearCollectionCache } from './collections.mjs';
import { loadMemoryCard } from './memory-card.mjs';
import { sessionStat, readSessionMessages, zstdAvailable } from './sessions.mjs';
import { loadSynonymGroups, loadLearned, buildSynonymMap, defaultSynonymPath } from './synonyms.mjs';
import { registerWordsTool } from './words-tool.mjs';
import { activeNotes, searchNotes, formatNotesBlock } from './notes.mjs';
import { createNoteTool } from './note-tool.mjs';

// defineTool 只解析一次。为什么要提前：agent/created 里再 await import 会花几毫秒，
// 而宿主正好在那个窗口给会话拍工具快照——结果就是"注册成功但会话里看不见"。
let defineToolCache;
let defineToolFrom = '';
async function resolveDefineToolOnce() {
  if (defineToolCache !== undefined) return defineToolCache;
  const candidates = ['@deepseek-ai/dsh-tools'];
  if (process.env.DSH_TOOLS_PATH) candidates.push(process.env.DSH_TOOLS_PATH);
  if (process.resourcesPath) {
    candidates.push(`${process.resourcesPath}/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`);
    candidates.push(`${process.resourcesPath}/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`);
  }
  defineToolCache = null;
  for (const candidate of candidates) {
    try {
      const spec = candidate.startsWith('@') ? candidate : pathToFileURL(candidate).href;
      const mod = await import(spec);
      if (typeof mod?.defineTool === 'function') {
        defineToolCache = mod.defineTool;
        defineToolFrom = candidate;
        break;
      }
    } catch {
      // 换下一个候选
    }
  }
  return defineToolCache;
}

export const name = 'dsh-memory-retrieval';
export const inject = ['systemPrompt', 'webServer', 'agents', 'sessionController', 'tools'];

/**
 * 笔记的可见范围：本会话 + 与它同属一个集合的会话。
 * 注入和主动检索必须用同一套规则，否则 memory_recall 会翻出注入层不让看的笔记。
 */
export function visibleNotes(cfg, notes, sessionId) {
  const visible = new Set([String(sessionId)]);
  for (const collection of cfg?.collections || []) {
    if (collection.enabled === false) continue;
    if (!collection.sessionIds.includes(sessionId)) continue;
    for (const id of collection.sessionIds) visible.add(id);
  }
  return notes.filter((note) => !note.source?.sessionId || visible.has(note.source.sessionId));
}

function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
      .trim();
  }
  return String(message.text ?? '').trim();
}

function compilePatterns(patterns) {
  const out = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    try {
      out.push(new RegExp(String(pattern)));
    } catch (error) {
      console.error(`[dsh-memory-retrieval] 忽略无效 session 正则 ${JSON.stringify(pattern)}: ${error?.message ?? error}`);
    }
  }
  return out;
}

function allowedSession(sessionId, cfg, include, exclude) {
  const override = cfg?.sessionOverrides?.[sessionId];
  if (typeof override === 'boolean') return override;
  if (exclude.some((re) => re.test(sessionId))) return false;
  if (include.length > 0 && !include.some((re) => re.test(sessionId))) return false;
  return true;
}

function resolveMemoryPath(cfg) {
  const raw = String(cfg.memoryPath ?? '').trim();
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded || defaultMemoryPath());
}

function workspaceOf(agent) {
  return String(agent?.session?.cwd ?? agent?.session?.header?.cwd ?? agent?.cwd ?? '');
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHost(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase();
  if (!host) return true;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function apply(ctx, config = {}) {
  diag('插件 apply 开始 v0.9.7');
  const userFile = userConfigPath();
  const userConfig = fs.existsSync(userFile) ? readUserConfig(userFile) : {};
  const runtime = {
    // 插件行（cordis.patch.yml）里的配置：reload 时用户文件要和它重新合并，
    // 否则 reload 会把插件行里的默认值丢掉。
    pluginConfig: { ...config },
    cfg: normalizeConfig({ ...config, ...userConfig }),
    include: [],
    exclude: [],
    memoryPath: '',
    memory: [],
    synonymMap: null,
    synonymGroups: [],
    relatedPairs: [],
    notesFile: path.join(configDir(), 'notes.jsonl'),
  };

  function reloadRuntime(nextConfig) {
    runtime.cfg = normalizeConfig(nextConfig);
    runtime.include = compilePatterns(runtime.cfg.includeSessionPatterns);
    runtime.exclude = compilePatterns(runtime.cfg.excludeSessionPatterns);
    runtime.memoryPath = resolveMemoryPath(runtime.cfg);
    try { setCacheBudgetMB(runtime.cfg.cacheBudgetMB); } catch {}
    try {
      ensureMemoryFile(runtime.memoryPath);
      runtime.memory = loadMemory(runtime.memoryPath);
    } catch (error) {
      runtime.memory = [];
      console.error(`[dsh-memory-retrieval] 读取记忆失败 ${runtime.memoryPath}: ${error?.message ?? error}`);
    }
    try {
      // 三层：用户的 synonyms.json（或内置） + agent 自己学到的 learned.json
      const base = runtime.cfg.synonymsEnabled ? loadSynonymGroups(runtime.cfg.synonymPath) : [];
      const learned = loadLearned(path.join(configDir(), 'learned.json'));
      runtime.synonymGroups = learned.groups.length ? [...base, ...learned.groups] : base;
      runtime.relatedPairs = learned.links ?? [];
      runtime.synonymMap = buildSynonymMap(runtime.synonymGroups);
    } catch (error) {
      runtime.synonymGroups = [];
      runtime.synonymMap = null;
      console.error(`[dsh-memory-retrieval] 读取同义词表失败: ${error?.message ?? error}`);
    }
  }

  reloadRuntime(runtime.cfg);
  // 预热 defineTool：先发起、不阻塞——下面还要同步注册 agent/created 等事件处理器，
  // 它们的注册不能因为等 import 被推到微任务之后（测试和真实装配都依赖"apply 早期就绪"）。
  const defineToolReady = resolveDefineToolOnce();

  /**
   * 注册 memory_recall 工具：让模型用自己的话去集合里查，而不是由注入层猜关键词。
   * 语义匹配交给模型，插件只负责「按字面捞出候选 + 返回原文」。
   * 注册失败只记日志，不影响插件其余部分。
   */
  /** 诊断日志：宿主是 GUI 进程时看不到 stdout，所以自己落一份到数据目录 */
  function diag(line) {
    try {
      const file = path.join(configDir(), 'tool.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {}
  }
  // 会话级注册时用自己的 state；全局注册时从 exec.agent.session 反查（不能共用闭包，
  // 否则最后创建的那个会话会覆盖掉所有人的出处）。
  let sessionNoteSource = null;
  const setNoteSource = (fn) => { sessionNoteSource = fn; };

  function sourceFromExec(exec) {
    const sid = String(exec?.agent?.session?.id ?? '');
    if (!sid) return null;
    if (sessionNoteSource && true) {
      // 当前 agent 就是本会话时，直接用它的 state（含最近一句原文）
      try {
        const current = sessionNoteSource();
        if (current && current.sessionId === sid) return current;
      } catch {
        // 忽略，走下面的兜底
      }
    }
    let title = '';
    try {
      title = readSessionMessages(sid, { skipPatterns: runtime.cfg.sessionSkipPatterns })?.title || '';
    } catch {
      title = '';
    }
    return { sessionId: sid, title, time: Date.now(), excerpt: '' };
  }

  /** 只重读词表：memory_note 顺手记了同义词之后刷新运行时，下一次检索立刻生效 */
  function refreshSynonyms() {
    try {
      const base = runtime.cfg.synonymsEnabled ? loadSynonymGroups(runtime.cfg.synonymPath) : [];
      const learned = loadLearned(path.join(configDir(), 'learned.json'));
      runtime.synonymGroups = learned.groups.length ? [...base, ...learned.groups] : base;
      runtime.relatedPairs = learned.links ?? [];
      runtime.synonymMap = buildSynonymMap(runtime.synonymGroups);
      diag(`词表已刷新：${runtime.synonymGroups.length} 组 / ${runtime.relatedPairs.length} 对关联`);
    } catch (error) {
      diag('词表刷新失败：' + String(error?.message ?? error));
    }
  }

  async function registerNoteTool(targetCtx, label = '全局') {
    const tools = targetCtx?.tools;
    if (!tools?.register) {
      diag(`[${label}] memory_note 跳过：没有 tools.register`);
      return;
    }
    const tool = createNoteTool({
      sourceOf: (exec) => sourceFromExec(exec),
      skipPatterns: () => runtime.cfg.sessionSkipPatterns,
      learnedPath: path.join(configDir(), 'learned.json'),
      onSynonymsChanged: () => refreshSynonyms(),
    });
    const dispose = await tools.register(tool);
    diag(`[${label}] memory_note 注册完成`);
    return typeof dispose === 'function' ? dispose : undefined;
  }

  /**
   * 诊断工具（全新名字 memory_status）：
   * 它的用处不是给用户，而是判断「旧会话能不能捡到新注册的工具」。
   * 能出现 → 新名字可以进旧会话；不出现 → 装配层把整批都挡了。
   * 执行时还能看到该 agent 当前可见的工具名，用来区分"注册了"和"看得见"。
   */
  async function registerStatusTool(targetCtx = ctx, label = '全局') {
    const tools = targetCtx?.tools ?? ctx.tools;
    if (!tools?.register) return;
    const defineTool = await resolveDefineToolOnce();
    let version = '';
    try {
      version = JSON.parse(fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'), 'utf8')).version;
    } catch {
      version = '';
    }
    const spec = {
      name: 'memory_status',
      description: 'Diagnostic: which memory tools this agent can actually see, plus plugin version and config summary. Call it when memory_recall / memory_note / memory_links appear to be missing.',
      parameters: {
        verbose: { type: 'boolean', description: 'Include the full visible tool name list.' },
      },
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: String(value ?? '') }] },
      execute: async (args, exec) => {
        const agent = exec?.agent;
        const toolsApi = agent?.ctx?.tools ?? tools;
        let names = [];
        const errors = [];
        for (const fn of ['schemas', 'definitions']) {
          try {
            if (typeof toolsApi?.[fn] !== 'function') continue;
            const value = toolsApi[fn](agent);
            if (!value) continue;
            if (Array.isArray(value)) names = value.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean);
            else if (typeof value === 'object') names = Object.keys(value);
            if (names.length) break;
          } catch (error) {
            errors.push(`${fn}: ${error?.message ?? error}`);
          }
        }
        const has = (name) => names.includes(name);
        const lines = [
          `插件版本：${version || '(未知)'}`,
          `本 agent 可见工具：${names.length} 个`,
          `memory_recall=${has('memory_recall') ? '✅' : '❌'}  memory_note=${has('memory_note') ? '✅' : '❌'}  memory_links=${has('memory_links') ? '✅' : '❌'}`,
          `记忆卡路径：${runtime.cfg.memoryCardPath || '(未配置)'}`,
          `集合数：${(runtime.cfg.collections ?? []).length}  卡片白名单会话：${(runtime.cfg.memoryCardSessionIds ?? []).length}`,
        ];
        if (errors.length) lines.push(`读取可见工具时出错：${errors.join('；')}`);
        if (args?.verbose || names.length === 0) lines.push(`全部可见工具：${names.join(', ') || '(空)'}`);
        diag(`memory_status: 可见 ${names.length} 个工具；memory_* 命中 ${['memory_recall','memory_note','memory_links'].filter(has).length}/3`);
        return lines.join('\n');
      },
    };
    const finalSpec = typeof defineTool === 'function' ? defineTool(spec) : spec;
    try {
      const dispose = await tools.register(finalSpec);
      diag(`[${label}] memory_status 注册完成`);
      return typeof dispose === 'function' ? dispose : undefined;
    } catch (error) {
      diag(`[${label}] memory_status 注册失败：${error?.message ?? error}`);
    }
  }

  async function registerRecallTool(targetCtx = ctx, label = '全局') {
    diag('进入注册：' + label);
    const tools = targetCtx?.tools ?? ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : undefined);
    diag(`tools 解析=${tools?.register ? '有 register' : '无 register'}`);
    if (!tools?.register) {
      console.error('[dsh-memory-retrieval] 没有 tools.register，跳过 memory_recall');
      return;
    }
    // 用 apply 阶段预热好的那份：这里不再 import，注册路径上没有 await I/O
    const defineTool = await resolveDefineToolOnce();
    const from = defineToolFrom;
    diag(`defineTool 来源=${from || '未找到'}`);
    console.error(`[dsh-memory-retrieval] memory_recall defineTool 来源：${from || '无（将直接注册普通对象）'}`);

    // A 方案：优先直接注册普通对象。从 asar 绝对路径 import 的 defineTool 可能是
    // 另一份模块实例，宿主认不出它产出的工具对象；defineTool 只作为可选加工步骤。
    const specShape = ({
      name: 'memory_recall',
      description: [
        'Search your own past conversations grouped into "collections".',
        'Use it when the user refers to something discussed in ANOTHER session (a past decision,',
        'a contract clause, a diagnosis you did before) and you are not sure which words were used.',
        'Query in natural language — synonyms are handled by you, not by the index.',
        'Returns matching excerpts with their source session title and date.',
      ].join(' '),
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for, in your own words. Chinese or English.' },
        scope: { type: 'string', description: 'collections (default) = other sessions in your collections; self = this session\'s own full history; card = the configured full memory card; notes = conclusions you wrote down yourself (with source, use memory_note(origin=id) for the original); all = notes + self + collections + card. Self-history results older than 15 minutes only, to avoid re-injecting the live prompt.' },
        collection: { type: 'string', description: 'Collection name to search. Omit to search every collection the current session belongs to. Ignored for scope=self.' },
        topK: { type: 'integer', description: 'How many excerpts to return, 1-10 (default 5).' },
      },
      output: {
        schema: { type: 'string' },
        render(args, value) {
          return [{ type: 'text', text: String(value ?? '') }];
        },
      },
      execute: async (args, exec) => {
        const cfg = runtime.cfg;
        const sessionId = String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '');
        if (!sessionId) return '无法识别当前会话，memory_recall 只能在 agent 会话内调用。';
        const query = String(args?.query ?? '').trim();
        if (!query) return 'query 不能为空。';
        const scope = ['collections', 'self', 'card', 'notes', 'all'].includes(String(args?.scope ?? '')) ? String(args.scope) : 'collections';
        const topK = Math.max(1, Math.min(10, Number(args?.topK) || 5));
        const searchOptions = {
          topK,
          maxChars: Math.max(cfg.collectionMaxChars, topK * cfg.collectionPerSnippetChars),
          perSnippetChars: cfg.collectionPerSnippetChars,
          minScore: cfg.minScore,
          minHits: 1, // 工具由模型主动调用，宽松召回即可，判断交给模型
          synonymMap: runtime.synonymMap,
          synonymGroups: runtime.synonymGroups,
          synonymWeight: cfg.synonymWeight,
        };
        const chunks = [];

        // scope=self/all：把当前会话自己的完整日志也当集合建索引。
        // 只取 15 分钟以前的片段，避免把刚刚进 prompt 的话又捞回来。
        if (scope === 'self' || scope === 'all') {
          const selfCollection = {
            id: `self:${sessionId}`,
            name: '自己的历史',
            sessionIds: [sessionId],
          };
          const index = getCollectionIndex(selfCollection, {
            chunkChars: cfg.collectionChunkChars,
            capChars: cfg.collectionSessionCapChars,
            skipPatterns: cfg.sessionSkipPatterns,
          });
          const hits = searchCollection(index, query, {
            ...searchOptions,
            excludeSessionId: '', // 不排除自己
          });
          const cutoff = Date.now() - 15 * 60 * 1000;
          for (const hit of hits) {
            if (hit.time && hit.time >= cutoff) continue;
            chunks.push({ ...hit, collection: '自己的历史' });
          }
        }

        // 笔记：模型自己写下的结论。范围与注入层一致（本会话 + 同集合会话）。
        if (scope === 'notes' || scope === 'all') {
          const notes = visibleNotes(cfg, activeNotes(runtime.notesFile), sessionId);
          const picked = searchNotes(notes, query, {
            topK,
            maxChars: Math.max(cfg.notesMaxChars, topK * 200),
            synonymMap: runtime.synonymMap,
          });
          for (const item of picked) {
            const note = item.note;
            chunks.push({
              sessionId: note.source?.sessionId || 'note',
              title: note.source?.title || '笔记',
              text: `${note.text}\n（来源：《${note.source?.title || '未知'}》 ${note.source?.time ? formatDate(note.source.time) : '未记录'} · ${note.kind} · id=${note.id}）`,
              score: item.score * 3 + 10, // 结论优先于原文片段
              collection: '笔记',
            });
          }
          if (scope === 'notes' && !picked.length) {
            return `没有和「${query}」相关的笔记。可以先用 memory_note(list=true) 看看都记了什么。`;
          }
        }

        // 工具侧同样按归属判断：非卡主会话不能主动翻别人的全量记忆卡
        const cardAllowed = (cfg.memoryCardSessionIds ?? []).includes(sessionId);
        if (scope === 'card' && !cardAllowed) {
          return '这张全量记忆卡只对 memoryCardSessionIds 里登记的会话开放。要让别的会话也能用，请把该会话加入同一个集合（集合走的是会话日志，不是这张卡）。';
        }
        if ((scope === 'card' || scope === 'all') && cardAllowed) {
          const records = loadMemoryCard(cfg.memoryCardPath);
          if (!records.length) {
            if (scope === 'card') {
              return cfg.memoryCardPath
                ? `全量记忆卡没有可读记录：${cfg.memoryCardPath}`
                : '还没有配置全量记忆卡路径。';
            }
          } else {
            const results = search(records, query, {
              topK,
              maxChars: cfg.memoryCardMaxChars,
              perRecordChars: cfg.collectionPerSnippetChars,
              minScore: cfg.minScore,
              minHits: cfg.minHits,
              synonymMap: runtime.synonymMap,
              synonymWeight: cfg.synonymWeight,
              synonymGroups: runtime.synonymGroups,
            });
            for (const item of results) {
              chunks.push({
                sessionId: 'card',
                title: item.record.title || '记忆卡',
                text: item.snippet || item.record.text,
                score: item.score,
                collection: '全量记忆卡',
              });
            }
          }
        }

        if (scope === 'collections' || scope === 'all') {
          const mine = (cfg.collections ?? []).filter(
            (collection) => collection.enabled !== false && collection.sessionIds.includes(sessionId),
          );
          const wanted = String(args?.collection ?? '').trim();
          const targets = wanted ? mine.filter((collection) => collection.name === wanted) : mine;
          for (const collection of targets) {
            const others = collection.sessionIds.filter((id) => id !== sessionId);
            if (!others.length) continue;
            const index = getCollectionIndex(
              { ...collection, sessionIds: others },
              {
                chunkChars: cfg.collectionChunkChars,
                capChars: cfg.collectionSessionCapChars,
                skipPatterns: cfg.sessionSkipPatterns,
              },
            );
            const hits = searchCollection(index, query, {
              ...searchOptions,
              excludeSessionId: sessionId,
            });
            for (const hit of hits) chunks.push({ ...hit, collection: collection.name });

            // 集合里除了会话原文，还有成员会话写下的**笔记**（结论）。
            // 只在 scope=collections 时补：scope=all 的笔记分支已经全量查过。
            if (scope === 'collections') {
              const memberIds = new Set(collection.sessionIds);
              const notesById = visibleNotes(cfg, activeNotes(runtime.notesFile), sessionId)
                .filter((note) => !note.source?.sessionId || memberIds.has(note.source.sessionId));
              const noteHits = searchNotes(notesById, query, {
                topK,
                maxChars: Math.max(cfg.notesMaxChars, topK * 200),
                synonymMap: runtime.synonymMap,
              });
              for (const item of noteHits) {
                chunks.push({
                  sessionId: item.note.source?.sessionId || 'note',
                  title: item.note.source?.title || '笔记',
                  text: `${item.note.text}\n（笔记 · 来源：《${item.note.source?.title || '未知'}》 · id=${item.note.id}）`,
                  score: item.score * 3 + 10,
                  collection: `${collection.name} · 笔记`,
                });
              }
            }
          }
          if (!targets.length && scope === 'collections') {
            return wanted
              ? `当前会话不在名为「${wanted}」的集合里，或该集合不存在。可用集合：${mine.map((c) => c.name).join('、') || '无'}`
              : '当前会话还没有加入任何集合，无法检索历史对话。';
          }
        }

        if (!chunks.length) {
          return scope === 'self'
            ? `没有在「自己的历史」里找到和「${query}」相关的旧片段（最近 15 分钟内的消息不算）。`
            : `没有找到和「${query}」相关的历史对话。`;
        }
        chunks.sort((a, b) => b.score - a.score);
        const seen = new Set();
        const unique = chunks.filter((hit) => {
          const key = String(hit.text ?? '').replace(/\s+/g, '').slice(0, 60);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return unique.slice(0, topK)
          .map((hit) => `【${hit.collection} · 《${hit.title}》】\n${hit.text}`)
          .join('\n\n');
      },
    });

    // defineTool 优先（宿主需要它编译出的 schema）；失败再退回普通对象。
    let spec = specShape;
    let dispose;
    if (typeof defineTool === 'function') {
      try {
        spec = defineTool(specShape);
        diag('spec 经 defineTool 编译');
      } catch (error) {
        diag('defineTool 编译失败，改用普通对象: ' + String(error?.message ?? error));
        spec = specShape;
      }
    }
    try {
      dispose = tools.register(spec);
      diag('register 返回：' + typeof dispose + '（defineTool=' + (typeof defineTool === 'function') + '）');
    } catch (error) {
      diag('register 抛错：' + String(error?.message ?? error));
      try {
        dispose = tools.register(specShape);
        diag('普通对象 register 返回：' + typeof dispose);
      } catch (inner) {
        diag('普通对象也失败：' + String(inner?.message ?? inner));
      }
    }
    return typeof dispose === 'function' ? dispose : undefined;
  }

  ctx.on('agent/created', (payload) => {
    // DSH 的事件载荷是 { agent }，不是 agent 本身
    const agent = payload?.agent ?? payload;
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '');
    const agentCtx = agent?.ctx;
    diag(`agent/created：session=${sessionId || '(空)'}，ctx=${agentCtx ? '有' : '无'}，section=${agentCtx?.systemPrompt?.section ? '有' : '无'}`);
    if (!agentCtx?.systemPrompt?.section) {
      // 会话恢复时 ctx 可能还没装配好：稍后重试，而不是直接放弃
      let tries = 0;
      const retry = () => {
        tries += 1;
        const ctxNow = agent?.ctx;
        const sidNow = String(agent?.session?.id ?? agent?.id ?? '');
        if (ctxNow?.systemPrompt?.section && sidNow) {
          diag(`重试成功（第 ${tries} 次）：session=${sidNow}`);
          return;
        }
        if (tries < 20) setTimeout(retry, 500);
        else diag(`重试放弃：session=${sidNow || '(空)'}，section=${ctxNow?.systemPrompt?.section ? '有' : '无'}`);
      };
      setTimeout(retry, 300);
      console.error('[dsh-memory-retrieval] agent.ctx 尚未就绪，已安排重试');
      return;
    }

    // 会话级注册：DSH 的工具快照按会话装配，老会话只有走 agent ctx 才拿得到新工具。
    // defineTool 已预热，这三个注册都不再等 import，紧跟 agent/created 同步完成。
    diag('agent 作用域 tools=' + (agentCtx?.tools ? '有' : '无'));
    if (agentCtx?.tools?.register) {
      const t0 = Date.now();
      let catalog = null;
      try {
        const listed = agentCtx.tools.list?.();
        catalog = Array.isArray(listed) ? listed.length : null;
      } catch {
        catalog = null;
      }
      const jobs = Promise.allSettled([
        registerStatusTool(agentCtx, 'agent:' + sessionId),
        registerWordsTool({
          tools: agentCtx.tools,
          learnedPath: path.join(configDir(), 'learned.json'),
          runtime,
          diag,
          defineTool: defineToolCache,
        }),
        registerRecallTool(agentCtx, 'agent:' + sessionId),
        registerNoteTool(agentCtx, 'agent:' + sessionId),
      ]);
      jobs.then((results) => {
        const okCount = results.filter((item) => item.status === 'fulfilled').length;
        diag(`[${sessionId}] 工具注册完成 ${Date.now() - t0}ms（快照 catalog=${catalog ?? '未知'}；${okCount}/${results.length}）`);
        for (const item of results) {
          if (item.status === 'rejected') diag('agent 作用域注册失败：' + String(item.reason?.message ?? item.reason));
        }
      });
    }
    // 线索不只取最后一句：人是在一段对话的语境里被勾起回忆的，话题会延续好几轮
    const state = { last: '', history: [], turn: 0, seen: new Map(), textSeen: new Map(), cardInjectedTurn: -1, collectionsInjectedTurn: -1, notesInjectedTurn: -1, stepCue: '', sessionTitle: '', toolDiagDone: false };
    const CUE_TURNS = 3; // 拼接最近 3 条用户消息作为检索线索
    const REPEAT_TURNS = 3; // 同一片段 3 轮内不重复注入，提过一次就让它沉下去
    const workspace = workspaceOf(agent);
    const sessionTitle = () => {
      if (state.sessionTitle) return state.sessionTitle;
      try {
        state.sessionTitle = readSessionMessages(sessionId, { skipPatterns: runtime.cfg.sessionSkipPatterns })?.title || '';
      } catch {
        state.sessionTitle = '';
      }
      return state.sessionTitle;
    };
    // 出处片段要够长才当得了锚点：一个字的回复（"1"、"好"）在任何原文里都能匹配，
    // 会让 origin 锚到日志第一条含该字符的消息上。优先取最近一条 ≥8 字的用户消息。
    const excerptOf = () => {
      const recent = [...state.history].reverse();
      const good = recent.find((text) => String(text || '').trim().length >= 8);
      return String(good || '').slice(0, 160);
    };
    /**
     * 当前上下文里已经有的文本（最近 24 条消息 + 本轮线索）。
     * 记忆卡和自检索都必须先过这一关：它们搜的是「过去」，但命中的可能是
     * 刚刚才说过的话——注进去只是把同一段话贴第二遍，还占字数。
     * 按轮缓存，避免一次装配里反复读会话文件。
     */
    const normText = (text) => String(text ?? '').replace(/\s+/g, '').toLowerCase();
    let contextCache = { turn: -1, texts: [], cue: '' };
    const recentContext = () => {
      if (contextCache.turn === state.turn) return contextCache;
      let texts = [];
      try {
        texts = readSessionMessages(sessionId, { skipPatterns: runtime.cfg.sessionSkipPatterns }).messages
          .slice(-24)
          .map((message) => normText(message.text))
          .filter(Boolean);
      } catch {
        texts = [];
      }
      contextCache = { turn: state.turn, texts, cue: normText(state.history.join('\n')) };
      return contextCache;
    };
    /** 前缀（60 字）已在上下文里出现过 → 这段话不需要再注入 */
    const inRecentContext = (text) => {
      const prefix = normText(text).slice(0, 60);
      if (prefix.length < 20) return false;
      const { texts, cue } = recentContext();
      if (cue.includes(prefix)) return true;
      return texts.some((recent) => recent.includes(prefix));
    };
    setNoteSource(() => ({ sessionId, title: sessionTitle(), time: Date.now(), excerpt: excerptOf() }));
    const onClaim = (payload) => {
      if (payload?.sessionId && sessionId && String(payload.sessionId) !== sessionId) return;
      const text = messageText(payload?.message);
      if (!text) return;
      state.last = text;
      state.history.push(text);
      while (state.history.length > CUE_TURNS) state.history.shift();
      state.turn += 1;
    };

    /** 最近几轮拼成的检索线索（截断，避免历史越长越跑偏） */
    /**
     * 检索线索。
     * 默认只用最近几条用户消息——人是在一段对话的语境里被勾起回忆的。
     * recallMidTask 打开时，把当前步骤的最新内容（tool 结果 / 助手输出）并进来：
     * 任务进行中的方向变了，线索就该跟着变，否则「中途联想」只是把同一批候选分批发完。
     */
    const cueText = () => {
      const userCue = state.history.join('\n').slice(-800) || state.last;
      if (!runtime.cfg.recallMidTask || !state.stepCue) return userCue;
      return (state.stepCue + '\n' + userCue).slice(-900);
    };

    /** 同一段内容短时间内重复注入会显得啰嗦；按「来源 + 前缀」和「纯文本前缀」双重去重，
     *  后者让记忆卡 / 自检索 / 集合之间也不会把同一段话各注入一遍。 */
    const freshHits = (hits) => hits.filter((hit) => {
      const text = String(hit.text ?? '').replace(/\s+/g, '').slice(0, 60);
      const key = `${hit.sessionId ?? ''}|${text.slice(0, 40)}`;
      const textKey = `text|${text}`;
      const seenAt = state.seen.get(key);
      const seenTextAt = state.textSeen.get(textKey);
      hit.__key = key;
      hit.__textKey = textKey;
      return (seenAt === undefined || state.turn - seenAt >= REPEAT_TURNS)
        && (seenTextAt === undefined || state.turn - seenTextAt >= REPEAT_TURNS);
    });
    const rememberHits = (hits) => {
      for (const hit of hits) {
        if (hit.__key) state.seen.set(hit.__key, state.turn);
        if (hit.__textKey) state.textSeen.set(hit.__textKey, state.turn);
      }
    };

    // memory_recall 是全局工具，在 apply() 里只注册一次；这里不再按 agent 注册。

    // 中途联想需要「变化的线索」：agent/pre-step 会带上本步的 messages（含 tool 结果）。
    // 注意这是 waterfall 事件，必须把 next() 的返回值透传回去，否则会打断 agent 循环。
    const offStep = typeof agentCtx.on === 'function'
      ? agentCtx.on('agent/pre-step', (event, next) => {
          // 一次性诊断：把该 agent 这一步真正能看到的工具名写进日志。
          // 「注册成功」和「模型看得见」是两件事，只有这里能区分。
          if (!state.toolDiagDone) {
            state.toolDiagDone = true;
            try {
              const api = agentCtx.tools;
              const value = api?.schemas?.(agent) ?? api?.definitions?.(agent);
              const names = Array.isArray(value)
                ? value.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
                : Object.keys(value ?? {});
              diag(`[${sessionId}] 本步可见 ${names.length} 个工具；memory_recall=${names.includes('memory_recall')} memory_note=${names.includes('memory_note')} memory_links=${names.includes('memory_links')} memory_status=${names.includes('memory_status')}`);
            } catch (error) {
              diag(`[${sessionId}] 读取可见工具失败：${error?.message ?? error}`);
            }
          }
          try {
            // 实测：任务中途 pre-step 的 messages 是空的（只带本步新认领的用户消息），
            // 所以「当前在干什么」要从会话日志里取——那里已经写下了本步的助手输出和工具结果。
            // 增量索引让这次读取只有毫秒级开销。
            if (event?.step > 1) {
              const texts = [];
              if (Array.isArray(event.messages)) {
                for (const message of event.messages) {
                  const text = messageText(message);
                  if (text) texts.push(text);
                }
              }
              if (!texts.length) {
                try {
                  const recent = readSessionMessages(sessionId, { skipPatterns: runtime.cfg.sessionSkipPatterns }).messages;
                  for (const message of recent.slice(-3)) {
                    if (!message.text) continue;
                    if (message.role !== 'assistant' && message.role !== 'tool') continue;
                    texts.push(String(message.text));
                  }
                } catch (error) {
                  diag('读取本步内容失败：' + String(error?.message ?? error));
                }
              }
              if (texts.length) state.stepCue = texts.join('\n').replace(/\s+/g, ' ').slice(-500);
            }
          } catch (error) {
            diag('pre-step 线索更新失败：' + String(error?.message ?? error));
          }
          diag(`pre-step step=${event?.step} msgs=${event?.messages?.length ?? 0} cueLen=${state.stepCue.length}`);
          return typeof next === 'function' ? next() : undefined;
        })
      : null;

    const offClaim = typeof agentCtx.on === 'function'
      ? agentCtx.on('agent/inbox/claimed', onClaim)
      : ctx.on('agent/inbox/claimed', onClaim);

    const offSection = agentCtx.systemPrompt.section({
      name: 'memory-retrieval:context',
      order: 1,
      text: () => {
        const cfg = runtime.cfg;
        if (!cfg.enabled || !state.last || runtime.memory.length === 0) return '';
        if (!allowedSession(sessionId, cfg, runtime.include, runtime.exclude)) return '';
        const workspaceKey = workspace || '未分组';
        const globalRetrieval = cfg.workspaceGlobalRetrieval?.[workspaceKey] === true;
        const pool = globalRetrieval
          ? runtime.memory
          : runtime.memory.filter((record) => (String(record.workspace ?? '') || '未分组') === workspaceKey);
        if (pool.length === 0) return '';
        const results = search(pool, cueText(), {
          topK: cfg.topK,
          maxChars: cfg.maxChars,
          minScore: cfg.minScore,
          minHits: cfg.minHits,
          synonymMap: runtime.synonymMap,
          synonymWeight: cfg.synonymWeight,
          synonymGroups: runtime.synonymGroups,
          perRecordChars: cfg.perRecordChars,
        });
        return formatBlock(results, {
          maxChars: cfg.maxChars,
          label: cfg.label,
          askWhenUnsure: cfg.askWhenUnsure,
        });
      },
    });

    // 笔记：模型自己判断值得记的结论，优先级最高——它已经理解过上下文，
    // 不像原文片段那样还要模型再判断一次。每轮一次，不重复注入。
    const offNotes = agentCtx.systemPrompt.section({
      name: 'memory-retrieval:notes',
      order: 0,
      text: () => {
        const cfg = runtime.cfg;
        if (!cfg.enabled || cfg.notesEnabled === false || !state.last) return '';
        if (!allowedSession(sessionId, cfg, runtime.include, runtime.exclude)) return '';
        if (state.notesInjectedTurn === state.turn) return '';
        let notes = [];
        try {
          notes = activeNotes(runtime.notesFile);
        } catch {
          return '';
        }
        if (!notes.length) return '';
        // 笔记跟着**来源会话**走：本会话 + 同集合会话
        notes = visibleNotes(cfg, notes, sessionId);
        if (!notes.length) return '';
        let picked = searchNotes(notes, cueText(), {
          topK: cfg.notesTopK,
          maxChars: cfg.notesMaxChars,
          synonymMap: runtime.synonymMap,
        });
        // 没有相关笔记时，仍然把「偏好/决定」这类长期有效的少量笔记放上去：
        // 它们对当前任务本身有用，不需要被关键词勾起。
        if (!picked.length && cfg.notesAlwaysInject !== false) {
          picked = notes
            .filter((note) => note.kind === 'preference' || note.kind === 'decision')
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, Math.min(2, cfg.notesTopK))
            .map((note) => ({ note, score: 1 }));
        }
        if (!picked.length) return '';
        state.notesInjectedTurn = state.turn;
        return formatNotesBlock(picked, { askWhenUnsure: cfg.askWhenUnsure });
      },
    });
    ctx.effect(() => () => { try { offNotes?.(); } catch {} });

    // 集合内跨会话检索：当前会话属于某个集合时，从集合内其它会话的全文里取片段
    const offCollections = agentCtx.systemPrompt.section({
      name: 'memory-retrieval:collections',
      order: 2,
      text: () => {
        const cfg = runtime.cfg;
        if (!cfg.enabled || !cfg.collectionRetrieval || !state.last) return '';
        if (!allowedSession(sessionId, cfg, runtime.include, runtime.exclude)) return '';
        const mine = (cfg.collections || []).filter(
          (collection) => collection.enabled !== false && collection.sessionIds.includes(sessionId),
        );
        if (!mine.length) return '';
        // recallMidTask=false：本轮已经注入过集合块 → 不再跑，做到「只在开口时联想一次」。
        // recallMidTask=true：允许每个步骤都重新检索（只给还没给过的片段）。
        if (!cfg.recallMidTask && state.collectionsInjectedTurn === state.turn) return '';

        const blocks = [];
        for (const collection of mine) {
          const others = collection.sessionIds.filter((id) => id !== sessionId);
          if (!others.length) continue;
          try {
            const index = getCollectionIndex(
              { ...collection, sessionIds: others },
              {
                chunkChars: cfg.collectionChunkChars,
                capChars: cfg.collectionSessionCapChars,
                skipPatterns: cfg.sessionSkipPatterns,
              },
            );
            if (!index.chunks.length) continue;
            let results = searchCollection(index, cueText(), {
              // recallMidTask=true 时多取候选：已注入的会被过滤掉，
              // 只取 topK 的话剩下的片段永远轮不到（它们排在后面）。
              topK: cfg.recallMidTask ? Math.max(cfg.collectionTopK * 4, 12) : cfg.collectionTopK,
              // recallMidTask 时先用更宽的预算收集候选：否则 search 自己就把
              // 后面的片段截掉了，去重后剩不下东西可给。
              maxChars: cfg.recallMidTask ? cfg.collectionMaxChars * 4 : cfg.collectionMaxChars,
              perSnippetChars: cfg.collectionPerSnippetChars,
              minScore: cfg.minScore,
              minHits: cfg.minHits,
              synonymMap: runtime.synonymMap,
              synonymWeight: cfg.synonymWeight,
              synonymGroups: runtime.synonymGroups,
              excludeSessionId: sessionId,
            });
            // recallMidTask: 同一任务内继续联想（只给没见过的片段），代价是话题更容易跳
            results = cfg.recallMidTask
              ? results.filter((hit) => {
                  const text = String(hit.text).replace(/\s+/g, '').slice(0, 60);
                  const key = `${hit.sessionId}|${text.slice(0, 40)}`;
                  const textKey = `text|${text}`;
                  hit.__key = key;
                  hit.__textKey = textKey;
                  return !state.seen.has(key) && !state.textSeen.has(textKey);
                })
              : freshHits(results);
            if (!results.length) continue;
            if (cfg.recallMidTask) {
              const budget = cfg.collectionMaxChars;
              const kept = [];
              let used = 0;
              for (const hit of results) {
                const cost = String(hit.text ?? '').length;
                if (used + cost > budget && kept.length) break;
                kept.push(hit);
                used += cost;
              }
              results = kept;
            }
            // ── 联想第二跳 ──────────────────────────────────────────────
            // 同义词是"替换"，联想是"下一跳"。所以联想只在这一轮的语境里
            // 已经提到 A 时才启用：语境里出现「网络」→ 顺藤摸一手「路由器」。
            // 这样不会因为记住了一条联想，就把每次网络检索都搞脏。
            let hopResults = [];
            const hopFrom = [];
            if (cfg.relatedHops !== false && runtime.relatedPairs?.length) {
              const seed = (cueText() + '\n' + results.map((hit) => String(hit.text ?? '')).join('\n')).toLowerCase();
              const wanted = new Set();
              for (const pair of runtime.relatedPairs) {
                const [a, b] = pair;
                if (!a || !b) continue;
                if (seed.includes(a) && !seed.includes(b)) { wanted.add(b); hopFrom.push(a); }
                else if (seed.includes(b) && !seed.includes(a)) { wanted.add(a); hopFrom.push(b); }
              }
              if (wanted.size) {
                try {
                  hopResults = searchCollection(index, [...wanted].join(' '), {
                    topK: cfg.relatedTopK,
                    maxChars: cfg.relatedMaxChars,
                    perSnippetChars: Math.min(cfg.collectionPerSnippetChars, 200),
                    minScore: cfg.minScore,
                    minHits: 1,
                    synonymMap: null,
                    synonymGroups: [],
                    excludeSessionId: sessionId,
                  }).filter((hit) => {
                    const text = String(hit.text).replace(/\s+/g, '').slice(0, 60);
                    return !state.seen.has(`${hit.sessionId}|${text.slice(0, 40)}`) && !state.textSeen.has(`text|${text}`);
                  });
                } catch (error) {
                  diag('联想第二跳失败：' + String(error?.message ?? error));
                }
              }
            }

            const block = formatCollectionBlock(collection.name, results, { askWhenUnsure: cfg.askWhenUnsure });
            if (block) {
              // 只记「真的写进块里」的那些：候选池可能远大于本轮预算，
              // 全都标记已读的话，剩下的片段永远轮不到（recallMidTask 就失效了）。
              const emitted = results.filter((hit) => block.includes(String(hit.text ?? '').slice(0, 16)));
              rememberHits(emitted.length ? emitted : results);
              blocks.push(block);
              // 允许模型主动记词：不是命令它记，而是告诉它"这件事你可以做"。
              // 只在真的注入了内容时提一句，避免每轮都挂着一句废话。
              if (cfg.autoLearnWords !== false) {
                blocks.push('如果你注意到「同一个东西的不同说法」（网速慢/卡顿），或「两个本来就有关系的概念」（网络/路由器、磁盘/固态硬盘），可以用 memory_links 记下来——同类用默认，关联用 kind="related"。下次检索就能接上。');
              }
            }
            if (hopResults.length) {
              const lines = [
                `【顺带想起 · 由「${[...new Set(hopFrom)].join('、')}」联想到】`,
                '下面这些不是同一件事，只是顺着刚才的话题多摸了一手。',
                '先判断它跟当前任务有没有关系：没关系就自己咽回去——不要说"我想起…"，也不要为了用上它而改话题；有关系再自然带出来。',
                '',
              ];
              for (const hit of hopResults) {
                lines.push(`- 《${hit.title}》 ${formatDate(hit.time)}：${hit.text}`);
              }
              rememberHits(hopResults);
              blocks.push(lines.join('\n'));
            }
          } catch (error) {
            console.error(`[dsh-memory-retrieval] 集合检索失败 ${collection.name}: ${error?.message ?? error}`);
          }
        }
        if (blocks.length) state.collectionsInjectedTurn = state.turn;
        return blocks.join('\n\n');
      },
    });

    // 全量记忆卡：独立于会话日志，直接读角色自己的 memory-card.json。
    // 唤醒模板不会出现在这里，所以不需要靠 sessionSkipPatterns 兜底。
    const offCard = agentCtx.systemPrompt.section({
      name: 'memory-retrieval:card',
      order: 3,
      text: () => {
        const cfg = runtime.cfg;
        if (!cfg.enabled || cfg.memoryCardRetrieval === false || !cfg.memoryCardPath || !state.last) return '';
        if (!allowedSession(sessionId, cfg, runtime.include, runtime.exclude)) return '';
        // 归属闸门：默认只有 memoryCardSessionIds 里的会话能读到这张卡，
        // 否则任何会话都会把角色私人记忆注进自己的上下文（也是污染）。
        // 卡只属于 memoryCardSessionIds 里登记的会话；没有开关能把它放给所有人。
        if (!(cfg.memoryCardSessionIds ?? []).includes(sessionId)) return '';
        const records = loadMemoryCard(cfg.memoryCardPath);
        if (!records.length) return '';
        let results = search(records, cueText(), {
          topK: cfg.memoryCardTopK,
          maxChars: cfg.memoryCardMaxChars,
          perRecordChars: cfg.collectionPerSnippetChars,
          minScore: cfg.minScore,
          minHits: cfg.minHits,
          synonymMap: runtime.synonymMap,
          synonymWeight: cfg.synonymWeight,
          synonymGroups: runtime.synonymGroups,
        });
        results = results.map((item) => ({
          ...item,
          sessionId: 'card',
          title: item.record.title,
          text: item.snippet || item.record.text,
        }));
        // 卡里可能有刚发生的事（甚至就是这一轮说的话）：已经在上文里的不再贴一遍
        results = results.filter((item) => !inRecentContext(item.text));
        results = freshHits(results);
        if (!results.length) return '';
        rememberHits(results);
        state.cardInjectedTurn = state.turn;
        const block = formatBlock(results.map((item) => ({ ...item, snippet: item.text })), {
          maxChars: cfg.memoryCardMaxChars,
          label: '角色全量记忆卡',
          askWhenUnsure: cfg.askWhenUnsure,
        });
        // 在注入块第二行标出「全量卡多少条 / 本次命中几段」：
        // 换卡（例如从裁剪版换成 .jsonl 全量）之后，肉眼就能确认插件到底读进来多少，
        // 不用去猜"注入有没有变厚"。
        const meta = `（全量卡 ${records.length} 条 · 本次命中 ${results.length} 段）`;
        return block.replace('\n', `\n${meta}\n`);
      },
    });

    // 被动自检索：从当前会话自己的完整日志里捞较早的片段。
    // 本地建索引 + 本地去重，不额外调 API；只有真正捞到「当前上下文里没有的旧片段」才注入。
    const offSelf = agentCtx.systemPrompt.section({
      name: 'memory-retrieval:self',
      order: 4,
      text: () => {
        const cfg = runtime.cfg;
        if (!cfg.enabled || cfg.selfRetrieval === false || !state.last) return '';
        if (!allowedSession(sessionId, cfg, runtime.include, runtime.exclude)) return '';
        // 记忆卡这一轮已经注入，且当前会话被标记为这张卡的主人 →
        // 本轮不再跑自检索；用户关掉 memoryCardAutoDisableSelf 即可恢复。
        const cardOwned = (cfg.memoryCardSessionIds ?? []).includes(sessionId);
        if (cfg.memoryCardAutoDisableSelf !== false && cardOwned && state.cardInjectedTurn === state.turn) return '';
        const cue = cueText();
        if (!cue.trim()) return '';
        try {
          const selfCollection = {
            id: `self:${sessionId}`,
            name: '自己的历史',
            sessionIds: [sessionId],
          };
          const index = getCollectionIndex(selfCollection, {
            chunkChars: cfg.collectionChunkChars,
            capChars: cfg.collectionSessionCapChars,
            skipPatterns: cfg.sessionSkipPatterns,
          });
          if (!index.chunks.length) return '';
          // 自检索的片段全都属于「同一个会话」，而 searchCollection 默认 perSessionLimit=2：
          // 于是最多只取 2 段，且这 2 段往往是最新的——再被「15 分钟」规则滤掉就一条不剩。
          // 所以这里先多取候选，过滤完时间再截断到 selfTopK。
          // 候选池要「按相关性排好 + 时间过滤后再取」，不是「先取 N 条再过滤」：
          // 先取 N 条的话，最近 15 分钟那些高分片段会把名额占满，
          // 被滤掉后不会补位 —— 实际注入常常远少于 selfTopK。
          // 所以这里取一个很深的候选池（字符预算放宽），过滤完再截断。
          const deepPool = Math.max(cfg.selfTopK * 20, 60);
          let results = searchCollection(index, cue, {
            topK: deepPool,
            maxChars: 200000,
            perSessionLimit: deepPool,
            perSnippetChars: Math.min(cfg.collectionPerSnippetChars, 300),
            minScore: cfg.minScore,
            minHits: cfg.minHits,
            synonymMap: runtime.synonymMap,
            synonymWeight: cfg.synonymWeight,
            synonymGroups: runtime.synonymGroups,
            excludeSessionId: '', // 就是要查自己
          });
          const cutoff = Date.now() - cfg.selfMinAgeMinutes * 60 * 1000;
          results = results.filter((hit) => !hit.time || hit.time < cutoff).slice(0, cfg.selfTopK);

          // 本地去重：最近 24 条消息（含当前 prompt）里出现过的内容不再注入
          results = results.filter((hit) => !inRecentContext(hit.text));
          results = freshHits(results);
          if (!results.length) return '';
          rememberHits(results);

          const lines = [
            '【自己的历史 · 旧片段】',
            '下面是本会话较早的原文，可能只是词面重合；不相关就忽略。',
          ];
          // selfMaxChars 是「注入总字数上限」，必须真的执行：
          // 之前它只用于收集候选，段数一多实际输出会远超配置值。
          let used = 0;
          for (const hit of results) {
            const line = `- ${formatDate(hit.time)}：${hit.text}`;
            if (used + line.length > cfg.selfMaxChars && lines.length > 2) break;
            lines.push(line);
            used += line.length;
          }
          if (lines.length <= 2) return '';
          return lines.join('\n');
        } catch (error) {
          console.error(`[dsh-memory-retrieval] 自检索失败: ${error?.message ?? error}`);
          return '';
        }
      },
    });

    ctx.effect(() => () => {
      try { offStep?.(); } catch {}
      try { offClaim?.(); } catch {}
      try { offSection?.(); } catch {}
      try { offCollections?.(); } catch {}
      try { offCard?.(); } catch {}
      try { offSelf?.(); } catch {}
    });
  });

  // ── 设置页 API ────────────────────────────────────────────────────────────
  async function sessionRows() {
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined;
    const agents = ctx.agents?.roots?.() ?? [];
    const byId = new Map(agents.map((agent) => [String(agent?.id ?? agent?.session?.id ?? ''), agent]));

    let items = [];
    try {
      if (ctx.sessionController?.list) {
        const value = await ctx.sessionController.list({}, new AbortController().signal);
        items = value?.items ?? [];
      }
    } catch (error) {
      console.error(`[dsh-memory-retrieval] 读取会话标题失败: ${error?.message ?? error}`);
    }
    if (items.length === 0) {
      items = agents.map((agent) => ({ sessionId: agent?.id, agentAvailable: true }));
    }

    return items
      .filter((item) => item && item.sessionId)
      .map((item) => {
        const id = String(item.sessionId);
        const agent = byId.get(id);
        let preset = item.preset ?? null;
        if (agent) {
          try { preset = presets?.composedPreset?.(agent.ctx) ?? preset; } catch {}
        }
        const cwd = String(item.cwd ?? item.workspacePath ?? agent?.session?.cwd ?? '');
        return {
          id,
          title: String(item.projections?.values?.title ?? item.title ?? agent?.session?.title ?? agent?.title ?? ''),
          preset: preset?.id ?? preset ?? null,
          cwd,
          workspace: cwd || '未分组',
          available: item.agentAvailable !== false,
          running: item.running === true,
          globalRetrieval: runtime.cfg.workspaceGlobalRetrieval?.[cwd || '未分组'] === true,
          enabled: allowedSession(id, runtime.cfg, runtime.include, runtime.exclude),
        };
      });
  }

  function collectionOptions(cfg = runtime.cfg) {
    return {
      chunkChars: cfg.collectionChunkChars,
      capChars: cfg.collectionSessionCapChars,
      skipPatterns: cfg.sessionSkipPatterns,
    };
  }

  function collectionRows(rows) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return (runtime.cfg.collections ?? []).map((collection) => ({
      id: collection.id,
      name: collection.name,
      enabled: collection.enabled !== false,
      sessions: collection.sessionIds.map((id) => {
        const row = byId.get(id);
        const stat = sessionStat(id);
        let title = row?.title ?? '';
        if (!title) {
          try {
            title = readSessionMessages(id).title || '';
          } catch {}
        }
        return {
          id,
          title: title || id,
          workspace: row?.workspace ?? '',
          running: row?.running === true,
          available: row?.available !== false,
          exists: Boolean(stat),
          bytes: stat?.bytes ?? 0,
        };
      }),
    }));
  }

  function saveCollections(next) {
    const saved = writeUserConfig({ ...runtime.cfg, collections: next });
    reloadRuntime(saved);
    return saved.collections ?? [];
  }

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
  if (webServer?.register) {
    const dispose = webServer.register({
      kind: 'prefix',
      path: '/api/dsh-memory-retrieval',
      handler: async (req, res) => {
        try {
          if (!isLoopback(req) || !isLoopbackHost(req)) {
            sendJson(res, 403, { ok: false, error: '只允许本机回环请求' });
            return;
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const route = url.pathname.slice('/api/dsh-memory-retrieval'.length);
          if (req.method === 'GET' && route === '/sessions') {
            sendJson(res, 200, { ok: true, sessions: await sessionRows() });
            return;
          }
          if (req.method === 'POST' && route === '/session') {
            const body = await readBody(req);
            const sessionId = String(body.sessionId ?? '').trim();
            if (!sessionId) {
              sendJson(res, 400, { ok: false, error: 'sessionId 不能为空' });
              return;
            }
            const overrides = { ...(runtime.cfg.sessionOverrides ?? {}) };
            if (body.enabled === null) delete overrides[sessionId];
            else overrides[sessionId] = body.enabled === true;
            const saved = writeUserConfig({ ...runtime.cfg, sessionOverrides: overrides });
            reloadRuntime(saved);
            sendJson(res, 200, { ok: true, sessions: await sessionRows() });
            return;
          }
          if (req.method === 'POST' && route === '/workspace') {
            const body = await readBody(req);
            const workspace = String(body.workspace ?? '').trim();
            if (!workspace) {
              sendJson(res, 400, { ok: false, error: 'workspace 不能为空' });
              return;
            }
            const map = { ...(runtime.cfg.workspaceGlobalRetrieval ?? {}) };
            const value = body.globalRetrieval ?? body.crossSession;
            if (value === null) delete map[workspace];
            else map[workspace] = value === true;
            const saved = writeUserConfig({ ...runtime.cfg, workspaceGlobalRetrieval: map });
            reloadRuntime(saved);
            sendJson(res, 200, { ok: true, sessions: await sessionRows() });
            return;
          }
          if (req.method === 'GET' && (route === '/config' || route === '/status')) {
            sendJson(res, 200, {
              ok: true,
              config: runtime.cfg,
              memoryPath: runtime.memoryPath,
              memoryCount: runtime.memory.length,
              configFile: userConfigPath(),
              synonyms: {
                enabled: runtime.cfg.synonymsEnabled,
                groups: runtime.synonymGroups.length,
                path: runtime.cfg.synonymPath || defaultSynonymPath(),
              },
            });
            return;
          }
          if (req.method === 'POST' && (route === '/config' || route === '/save')) {
            const body = await readBody(req);
            // 集合只能通过 /collections 改：前端保存时带的是页面加载时的旧值，
            // 直接合并会把用户刚拖进去的会话覆盖掉。
            const { collections: ignoredCollections, ...rest } = body ?? {};
            const saved = writeUserConfig({ ...runtime.cfg, ...rest });
            reloadRuntime(saved);
            sendJson(res, 200, {
              ok: true,
              config: runtime.cfg,
              memoryPath: runtime.memoryPath,
              memoryCount: runtime.memory.length,
              configFile: userConfigPath(),
              synonyms: {
                enabled: runtime.cfg.synonymsEnabled,
                groups: runtime.synonymGroups.length,
                path: runtime.cfg.synonymPath || defaultSynonymPath(),
              },
            });
            return;
          }
          if (req.method === 'POST' && route === '/reload') {
            // 必须重读文件：runtime.cfg 是内存副本，直接 reload(runtime.cfg)
            // 等于把旧值又算一遍——手工改 config.json 后永远不生效。
            reloadRuntime({ ...runtime.pluginConfig, ...readUserConfig() });
            sendJson(res, 200, { ok: true, memoryPath: runtime.memoryPath, memoryCount: runtime.memory.length });
            return;
          }

          // ── 会话集合 ────────────────────────────────────────────────────
          if (req.method === 'GET' && route === '/collections') {
            sendJson(res, 200, {
              ok: true,
              collections: collectionRows(await sessionRows()),
              capabilities: { zstd: zstdAvailable, node: process.versions?.node ?? '' },
            });
            return;
          }

          if (req.method === 'POST' && route === '/collections') {
            const body = await readBody(req);
            const action = String(body.action ?? '');
            const list = (runtime.cfg.collections ?? []).map((collection) => ({
              ...collection,
              sessionIds: [...collection.sessionIds],
            }));
            const find = (id) => list.find((collection) => collection.id === String(id ?? ''));

            if (action === 'create') {
              const id = `col-${Date.now().toString(36)}`;
              const sessionIds = Array.isArray(body.sessionIds)
                ? body.sessionIds.map(String).filter(Boolean)
                : body.sessionId
                  ? [String(body.sessionId)]
                  : [];
              list.push({
                id,
                name: String(body.name ?? '').trim() || `集合 ${list.length + 1}`,
                enabled: true,
                sessionIds: [...new Set(sessionIds)],
              });
            } else if (action === 'add') {
              const collection = find(body.collectionId);
              if (!collection) throw new Error('集合不存在');
              const sessionId = String(body.sessionId ?? '');
              if (!sessionId) throw new Error('sessionId 不能为空');
              if (!collection.sessionIds.includes(sessionId)) collection.sessionIds.push(sessionId);
            } else if (action === 'remove') {
              const collection = find(body.collectionId);
              if (!collection) throw new Error('集合不存在');
              const sessionId = String(body.sessionId ?? '');
              collection.sessionIds = collection.sessionIds.filter((id) => id !== sessionId);
            } else if (action === 'rename') {
              const collection = find(body.collectionId);
              if (!collection) throw new Error('集合不存在');
              collection.name = String(body.name ?? '').trim().slice(0, 60) || collection.name;
            } else if (action === 'toggle') {
              const collection = find(body.collectionId);
              if (!collection) throw new Error('集合不存在');
              collection.enabled = body.enabled !== false;
            } else if (action === 'delete') {
              const collection = find(body.collectionId);
              if (!collection) throw new Error('集合不存在');
              list.splice(list.indexOf(collection), 1);
              clearCollectionCache(collection.id);
            } else {
              throw new Error(`未知操作 ${action}`);
            }

            saveCollections(list);
            sendJson(res, 200, { ok: true, collections: collectionRows(await sessionRows()) });
            return;
          }

          if (req.method === 'POST' && route === '/collections/preview') {
            const body = await readBody(req);
            const cfg = runtime.cfg;
            const collection = (cfg.collections ?? []).find((item) => item.id === String(body.collectionId ?? ''));
            if (!collection) {
              sendJson(res, 400, { ok: false, error: '集合不存在' });
              return;
            }
            const query = String(body.query ?? '').trim();
            const started = Date.now();
            const index = getCollectionIndex(collection, collectionOptions(cfg));
            const hits = searchCollection(index, query, {
              topK: cfg.collectionTopK,
              maxChars: cfg.collectionMaxChars,
              perSnippetChars: cfg.collectionPerSnippetChars,
              minScore: cfg.minScore,
              minHits: cfg.minHits,
              synonymMap: runtime.synonymMap,
              synonymWeight: cfg.synonymWeight,
              synonymGroups: runtime.synonymGroups,
              excludeSessionId: String(body.excludeSessionId ?? ''),
            });
            sendJson(res, 200, {
              ok: true,
              query,
              hits,
              block: formatCollectionBlock(collection.name, hits, { askWhenUnsure: cfg.askWhenUnsure }),
              stats: index.stats,
              elapsedMs: Date.now() - started,
            });
            return;
          }

          if (req.method === 'POST' && route === '/collections/rebuild') {
            const body = await readBody(req);
            const cfg = runtime.cfg;
            const collection = (cfg.collections ?? []).find((item) => item.id === String(body.collectionId ?? ''));
            if (!collection) {
              sendJson(res, 400, { ok: false, error: '集合不存在' });
              return;
            }
            clearCollectionCache(collection.id);
            const started = Date.now();
            const index = getCollectionIndex(collection, collectionOptions(cfg));
            sendJson(res, 200, { ok: true, stats: index.stats, elapsedMs: Date.now() - started });
            return;
          }
          sendJson(res, 404, { ok: false, error: 'not found' });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    });
    ctx.effect(() => dispose);
  } else {
    console.error('[dsh-memory-retrieval] webServer 不可用，设置页 API 不会启动');
  }

  // 全局注册一次；execute(args, exec) 里用 exec.agent.session.id 反查当前会话。
  // 关键：必须 await。宿主在插件挂载完成后立刻装配各会话的 agent，
  // 异步注册（先 return 再 .then）会错过这个窗口，只有之后新建的会话能捡到。
  let globalToolDispose;
  try {
    await defineToolReady;
    globalToolDispose = await registerRecallTool();
    await registerStatusTool(ctx, '全局');
    await registerWordsTool({
      tools: ctx.tools,
      learnedPath: path.join(configDir(), 'learned.json'),
      runtime,
      diag,
    });
    await registerNoteTool(ctx, '全局');
    diag('全局注册完成（已 await）');
  } catch (error) {
    diag('全局注册失败：' + String(error?.message ?? error));
  }
  ctx.effect(() => () => { try { globalToolDispose?.(); } catch {} });

  console.log(`[dsh-memory-retrieval] 已启用 · ${runtime.memoryPath} · ${runtime.memory.length} 条 · topK=${runtime.cfg.topK} · maxChars=${runtime.cfg.maxChars}`);
}
