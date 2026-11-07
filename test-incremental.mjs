/**
 * 增量索引测试：追加一帧后，只解析新增内容，结果与全量一致。
 * 不依赖 DSH，也不需要真实会话。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { makeSession, makeSessionsRoot } from './test-fixtures.mjs';

process.env.DSH_SESSIONS_DIR = makeSessionsRoot(path.join(os.tmpdir(), 'mr-inc'));
const root = process.env.DSH_SESSIONS_DIR;
const { readSessionMessages } = await import('./lib/sessions.mjs');

let checks = 0;
const expect = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) throw new Error(`FAIL ${label} ${detail}`);
  console.log(`PASS  ${label}`);
};

// 1. 建立基线：一个会话，两条消息
makeSession(root, 'session-inc', {
  title: '增量测试',
  messages: [
    { role: 'user', text: '第一条：网络卡顿怎么排查' },
    { role: 'assistant', text: '第一条回答：先看链路速率' },
  ],
});

const first = readSessionMessages('session-inc');
expect('全量读取到基线消息', first.messages.length === 2, `实际 ${first.messages.length}`);

// 2. 追加一帧（模拟会话继续写）
const sessDir = path.join(root, '--test-workspace--', 'session-inc');
const file = path.join(sessDir, 'session.v4.jsonl.zstd');
const extra = JSON.stringify({
  type: 'user/message',
  seq: 99,
  time: Date.now(),
  data: { content: [{ type: 'text', text: '第二条：追加进来的新消息' }], source: { kind: 'user' }, role: 'user' },
}) + '\n';
fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(extra, 'utf8')));

const t0 = Date.now();
const second = readSessionMessages('session-inc');
const ms = Date.now() - t0;

expect('追加后消息数 +1', second.messages.length === 3, `实际 ${second.messages.length}`);
expect('新消息内容正确', second.messages[2].text.includes('追加进来的新消息'));
expect('旧消息未被破坏', second.messages[0].text.includes('网络卡顿'));
expect('增量读取足够快（<50ms）', ms < 50, `${ms}ms`);

// 3. 文件被重写（变短）时应退回全量，而不是崩溃
const short = JSON.stringify({
  type: 'session', version: 4, id: 'session-inc', createdAt: Date.now(), cwd: 'D:\\test',
}) + '\n' + JSON.stringify({
  type: 'user/message', seq: 1, time: Date.now(),
  data: { content: [{ type: 'text', text: '重写后的唯一一条' }], source: { kind: 'user' }, role: 'user' },
}) + '\n';
fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(short, 'utf8')));

const third = readSessionMessages('session-inc');
expect('重写后退回全量并读到 1 条', third.messages.length === 1, `实际 ${third.messages.length}`);

// 4. 未变化时直接命中缓存
const fourth = readSessionMessages('session-inc');
expect('未变化时结果稳定', fourth.messages.length === 1 && fourth.messages[0].text.includes('重写后'));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n共 ${checks} 项检查通过`);
console.log('INCREMENTAL OK');
