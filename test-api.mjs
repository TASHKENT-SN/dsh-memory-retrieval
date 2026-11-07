import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { makeSession, makeSessionsRoot } from './test-fixtures.mjs';
import { apply } from './lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = path.join(HERE, '.api-test');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DSH_MEMORY_RETRIEVAL_DIR = temp;
const memoryPath = path.join(HERE, 'memory.api-test.jsonl');
fs.copyFileSync(path.join(HERE, 'memory.example.jsonl'), memoryPath);

let handler;
const ctx = {
  on() {},
  agents: {
    roots: () => [{ id: 'session-api-test', session: { title: 'API Test Session' }, ctx: {} }],
  },
  sessionController: {
    list: async () => ({
      items: [
        {
          sessionId: 'session-api-test',
          cwd: 'D:\\Alice',
          agentAvailable: true,
          running: true,
          projections: { values: { title: 'DSH 自己选的大标题' } },
        },
        {
          sessionId: 'session-api-old',
          cwd: 'D:\\Alice\\old-project',
          agentAvailable: false,
          running: false,
          projections: { values: { title: '以前的旧会话' } },
        },
      ],
    }),
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(options) { handler = options.handler; return () => {}; },
        port: 1234,
      };
    }
    if (name === 'agentPresets') {
      return { composedPreset: () => ({ id: 'standard' }) };
    }
    return undefined;
  },
  effect(fn) { fn(); },
};

apply(ctx, { memoryPath, topK: 5, maxChars: 800 });

function request(method, url, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, {
    method,
    url,
    headers: { host: '127.0.0.1:1234', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      end(chunk) {
        try { resolve({ status: this.statusCode, body: chunk ? JSON.parse(chunk) : null }); }
        catch (error) { reject(error); }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const get1 = await request('GET', '/api/dsh-memory-retrieval/config');
if (!get1.body?.ok || get1.body.config.topK !== 5) throw new Error('GET config 失败');
const save = await request('POST', '/api/dsh-memory-retrieval/config', { topK: 9, label: 'API Test' });
if (!save.body?.ok || save.body.config.topK !== 9) throw new Error('POST config 失败');
const get2 = await request('GET', '/api/dsh-memory-retrieval/config');
if (get2.body.config.label !== 'API Test') throw new Error('保存后没有立即生效');
if (!get2.body.memoryCount) throw new Error('记忆条数为空');

const sessions1 = await request('GET', '/api/dsh-memory-retrieval/sessions');
if (!sessions1.body?.ok || sessions1.body.sessions[0]?.enabled !== true) throw new Error('会话列表读取失败');
if (sessions1.body.sessions[0]?.title !== 'DSH 自己选的大标题') throw new Error('没有使用 DSH 会话标题');
if (sessions1.body.sessions[0]?.workspace !== 'D:\\Alice') throw new Error('没有返回工作区');
if (sessions1.body.sessions.length !== 2 || sessions1.body.sessions[1]?.id !== 'session-api-old') throw new Error('历史会话没有加进来');
if (sessions1.body.sessions[0]?.globalRetrieval !== false) throw new Error('默认应该是同工作区检索，不是全局');
const toggled = await request('POST', '/api/dsh-memory-retrieval/session', { sessionId: 'session-api-test', enabled: false });
if (!toggled.body?.ok || toggled.body.sessions[0]?.enabled !== false) throw new Error('会话开关没有生效');
const config3 = await request('GET', '/api/dsh-memory-retrieval/config');
if (config3.body.config.sessionOverrides['session-api-test'] !== false) throw new Error('sessionOverrides 没有持久化');

const workspace = await request('POST', '/api/dsh-memory-retrieval/workspace', { workspace: 'D:\\Alice', globalRetrieval: true });
if (!workspace.body?.ok) throw new Error('工作区开关失败');
if (workspace.body.sessions.find((s) => s.workspace === 'D:\\Alice')?.globalRetrieval !== true) throw new Error('工作区开关没有生效');
const config4 = await request('GET', '/api/dsh-memory-retrieval/config');
if (config4.body.config.workspaceGlobalRetrieval['D:\\Alice'] !== true) throw new Error('workspaceGlobalRetrieval 没有持久化');

// ── 会话集合 ─────────────────────────────────────────────────────────────
const sessionsRoot = makeSessionsRoot(HERE);
process.env.DSH_SESSIONS_DIR = sessionsRoot;
makeSession(sessionsRoot, 'session-col-a', {
  title: '采购合同会话',
  messages: [
    { role: 'user', text: '采购合同里交付周期怎么定的？' },
    { role: 'assistant', text: '交付周期约定为 30 个工作日，逾期按日千分之三计违约金。' },
  ],
});
makeSession(sessionsRoot, 'session-col-b', {
  title: '法务审核会话',
  messages: [
    { role: 'user', text: '违约金上限一般写多少？' },
    { role: 'assistant', text: '违约金累计不超过合同总额的百分之二十，超过部分法院通常不予支持。' },
  ],
});

const empty = await request('GET', '/api/dsh-memory-retrieval/collections');
if (!empty.body?.ok || empty.body.collections.length !== 0) throw new Error('初始集合应为空');

const created = await request('POST', '/api/dsh-memory-retrieval/collections', {
  action: 'create',
  name: '合同集合',
  sessionIds: ['session-col-a', 'session-col-b'],
});
if (!created.body?.ok) throw new Error('创建集合失败: ' + JSON.stringify(created.body));
const colId = created.body.collections[0]?.id;
if (!colId) throw new Error('创建后没有返回集合 id');
if (created.body.collections[0].sessions.length !== 2) throw new Error('创建时没有带上成员');
if (created.body.collections[0].sessions[0].title !== '采购合同会话') throw new Error('成员标题没有从会话日志回填');

const removed = await request('POST', '/api/dsh-memory-retrieval/collections', { action: 'remove', collectionId: colId, sessionId: 'session-col-a' });
if (removed.body.collections[0].sessions.length !== 1) throw new Error('移出成员失败');
const added = await request('POST', '/api/dsh-memory-retrieval/collections', { action: 'add', collectionId: colId, sessionId: 'session-col-a' });
if (added.body.collections[0].sessions.length !== 2) throw new Error('加入成员失败');
const renamed = await request('POST', '/api/dsh-memory-retrieval/collections', { action: 'rename', collectionId: colId, name: '合同与法务' });
if (renamed.body.collections[0].name !== '合同与法务') throw new Error('重命名失败');
const off = await request('POST', '/api/dsh-memory-retrieval/collections', { action: 'toggle', collectionId: colId, enabled: false });
if (off.body.collections[0].enabled !== false) throw new Error('集合开关失败');

const preview = await request('POST', '/api/dsh-memory-retrieval/collections/preview', { collectionId: colId, query: '违约金 上限 多少' });
if (!preview.body?.ok) throw new Error('试检索失败: ' + JSON.stringify(preview.body));
if (!preview.body.hits.length) throw new Error('试检索没有命中');
if (!preview.body.block.includes('百分之二十')) throw new Error('注入块没有带上命中原文');
if (!preview.body.stats.chunks) throw new Error('统计里没有分块数');
const excludedPreview = await request('POST', '/api/dsh-memory-retrieval/collections/preview', {
  collectionId: colId,
  query: '违约金 上限 多少',
  excludeSessionId: 'session-col-b',
});
if (excludedPreview.body.hits.some((hit) => hit.sessionId === 'session-col-b')) throw new Error('excludeSessionId 没有生效');

const configCollections = await request('GET', '/api/dsh-memory-retrieval/config');
if (configCollections.body.config.collections.length !== 1) throw new Error('collections 没有持久化到配置');
if (configCollections.body.config.collections[0].name !== '合同与法务') throw new Error('collections 持久化内容不对');

// 保存按钮会带上页面加载时的旧 collections（通常是空数组），不能让它覆盖集合
const saveWithStale = await request('POST', '/api/dsh-memory-retrieval/config', { topK: 6, collections: [] });
if (!saveWithStale.body?.ok) throw new Error('带旧 collections 的保存失败');
if ((saveWithStale.body.config.collections || []).length !== 1) throw new Error('保存把集合清掉了（回归）');

const deleted = await request('POST', '/api/dsh-memory-retrieval/collections', { action: 'delete', collectionId: colId });
if (deleted.body.collections.length !== 0) throw new Error('删除集合失败');

fs.rmSync(sessionsRoot, { recursive: true, force: true });
fs.rmSync(memoryPath, { force: true });
fs.rmSync(temp, { recursive: true, force: true });
console.log('API OK');
