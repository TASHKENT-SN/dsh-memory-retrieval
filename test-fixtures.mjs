/**
 * 测试夹具：在临时目录里造一个符合 DSH v4 格式的会话日志。
 * 生产环境用 zstd 压缩；这里同样压缩，确保走的是真实解码路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

let clock = 1793000000000;

/**
 * @param {string} root     相当于 ~/.dsh/sessions
 * @param {string} sessionId
 * @param {{title?: string, messages?: {role:'user'|'assistant', text:string}[], slug?: string}} options
 */
export function makeSession(root, sessionId, options = {}) {
  const slug = options.slug || '--test-workspace--';
  const dir = path.join(root, slug, sessionId);
  fs.mkdirSync(dir, { recursive: true });

  clock += 1000;
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: clock, cwd: 'D:\\test', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
  ];

  if (options.title) {
    lines.push(JSON.stringify({ type: 'session/title', seq: 0, time: clock, data: { title: options.title } }));
  }

  let seq = 1;
  for (const message of options.messages || []) {
    clock += 500;
    if (message.role === 'user') {
      lines.push(JSON.stringify({
        type: 'user/message',
        seq: seq++,
        time: clock,
        data: { content: [{ type: 'text', text: message.text }], source: { kind: 'user' }, role: 'user' },
      }));
    } else {
      lines.push(JSON.stringify({
        type: 'assistant/message',
        seq: seq++,
        time: clock,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: message.text }] } },
      }));
    }
  }

  // 夹一条应被忽略的运行时快照，验证过滤逻辑
  lines.push(JSON.stringify({
    type: 'user/message',
    seq: seq++,
    time: clock,
    data: { content: [{ type: 'text', text: 'SHOULD-NOT-BE-INDEXED runtime context' }], source: { kind: 'runtime-context' }, role: 'user' },
  }));

  const payload = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(payload));
  return dir;
}

export function makeSessionsRoot(baseDir) {
  const root = path.join(baseDir, `sessions-fixture-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  // 测试产物不要留在仓库里：进程退出时清掉（Windows 上偶发 EBUSY，忽略即可）
  process.once('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
  return root;
}
