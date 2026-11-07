/**
 * UI 冒烟测试：不启动 DSH，把 lib/client.js 里的设置页组件真渲染几轮。
 *
 * 做法：用最小的 React 桩（useState / useEffect / useCallback / createElement）
 * 驱动组件，fetch 用假数据，然后检查渲染结果里该出现的东西是否出现。
 * 目的是在重启 DSH 之前抓白屏、undefined 属性、map 崩溃这类问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 最小 React 桩 ────────────────────────────────────────────────────────
let hooks = [];
let hookIndex = 0;
let effectRan = false;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value;
    }];
  },
  useEffect(fn) {
    if (!effectRan) {
      effectRan = true;
      fn();
    }
  },
  useCallback(fn) {
    return fn;
  },
};

// ── 假数据 ──────────────────────────────────────────────────────────────
const config = {
  enabled: true,
  label: 'Memory',
  topK: 5,
  maxChars: 800,
  minScore: 1,
  perRecordChars: 180,
  askWhenUnsure: true,
  collectionRetrieval: true,
  collectionTopK: 5,
  collectionMaxChars: 1400,
  collectionPerSnippetChars: 300,
  collectionChunkChars: 600,
  collectionSessionCapChars: 0,
  memoryPath: '',
  collections: [],
};

const sessions = [
  { id: 's1', title: '采购合同会话', workspace: 'D:\\A', running: true, available: true, enabled: true, globalRetrieval: false },
  { id: 's2', title: '法务审核会话', workspace: 'D:\\A', running: false, available: true, enabled: true, globalRetrieval: false },
  { id: 's3', title: '另一个工作区的会话', workspace: 'D:\\B', running: false, available: false, enabled: true, globalRetrieval: false },
];

let collections = [
  {
    id: 'c1',
    name: '合同集合',
    enabled: true,
    sessions: [
      { id: 's2', title: '法务审核会话', workspace: 'D:\\A', running: false, available: true, exists: true, bytes: 204800 },
    ],
  },
];

const calls = [];
function fakeFetch(url, options = {}) {
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, body });
  const json = (value) => Promise.resolve({ json: () => Promise.resolve(value) });

  if (url.endsWith('/config')) {
    if (options.method === 'POST') return json({ ok: true, config: { ...config, ...body }, memoryPath: 'x', memoryCount: 3 });
    return json({ ok: true, config, memoryPath: 'memory.jsonl', memoryCount: 3 });
  }
  if (url.endsWith('/sessions')) return json({ ok: true, sessions });
  if (url.endsWith('/session')) {
    const next = sessions.map((s) => (s.id === body.sessionId ? { ...s, enabled: body.enabled } : s));
    sessions.splice(0, sessions.length, ...next);
    return json({ ok: true, sessions });
  }
  if (url.endsWith('/workspace')) {
    const next = sessions.map((s) => (s.workspace === body.workspace ? { ...s, globalRetrieval: body.globalRetrieval } : s));
    sessions.splice(0, sessions.length, ...next);
    return json({ ok: true, sessions });
  }
  if (url.endsWith('/collections/preview')) {
    return json({
      ok: true,
      query: body.query,
      hits: [{ sessionId: 's2', title: '法务审核会话', score: 4.2, text: '违约金不超过合同总额的百分之二十。', time: 1793000000000 }],
      block: '【集合记忆】…',
      stats: { chunks: 12, chars: 8000 },
      elapsedMs: 7,
    });
  }
  if (url.endsWith('/collections')) {
    if (options.method === 'POST') {
      if (body.action === 'create') {
        collections = [...collections, { id: 'c2', name: body.name || '新集合', enabled: true, sessions: [] }];
      }
      return json({ ok: true, collections });
    }
    return json({ ok: true, collections });
  }
  return json({ ok: false, error: 'unexpected url ' + url });
}

// ── 装载 client.js ──────────────────────────────────────────────────────
let exported = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory((name) => {
          if (name !== 'react') throw new Error('unexpected require ' + name);
          return React;
        });
      },
    },
  },
  fetch: fakeFetch,
  console,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(HERE, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });

if (!exported || typeof exported.apply !== 'function') throw new Error('client.js 没有导出 apply');

let captured = null;
exported.apply({
  get(name) {
    if (name !== 'slots') return undefined;
    return {
      inject(_slot, fn) { fn(); },
      register(_meta, component) { captured = component; return () => {}; },
    };
  },
});

if (!captured) throw new Error('没有注册 settings.section 组件');

// ── 渲染若干轮，直到数据加载完成 ────────────────────────────────────────
function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => textOf(child, out));
    return out;
  }
  if (node.children) node.children.forEach((child) => textOf(child, out));
  return out;
}

function find(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => find(child, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.children) node.children.forEach((child) => find(child, predicate, out));
  return out;
}

let tree = null;

/** 把函数组件展开成普通元素树（迷你渲染器，只处理本项目用到的形态） */
function expand(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props || {}));
  return { ...node, children: (node.children || []).map(expand) };
}

for (let round = 0; round < 6; round += 1) {
  hookIndex = 0;
  effectRan = round === 0 ? effectRan : true; // 只在第一轮跑 effect
  tree = expand(captured());
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const allText = textOf(tree).join(' | ');

const checks = [
  ['标题', allText.includes('记忆检索')],
  ['会话数', allText.includes('会话（3）')],
  ['工作区分组', allText.includes('D:\\A') && allText.includes('D:\\B')],
  ['会话标题', allText.includes('采购合同会话')],
  ['集合名', allText.includes('合同集合')],
  ['集合成员', allText.includes('法务审核会话')],
  ['字节统计', allText.includes('200 KB')],
  ['新建集合拖放区', allText.includes('新建集合')],
  ['试检索入口', allText.includes('试检索')],
  ['高级设置入口', allText.includes('高级设置')],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

// 交互：点击会话下拉加入集合、点开试检索、提交检索
const buttons = find(tree, (node) => node.type === 'button');
const testButton = buttons.find((b) => textOf(b).join('') === '试检索');
if (!testButton) throw new Error('找不到「试检索」按钮');
testButton.props.onClick();
for (let round = 0; round < 3; round += 1) {
  hookIndex = 0;
  tree = expand(captured());
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const afterOpen = expand(tree);
const testInput = find(afterOpen, (node) => node.type === 'input' && typeof node.props.placeholder === 'string' && node.props.placeholder.includes('输入一句话'));
if (!testInput.length) throw new Error('点开试检索后没有出现输入框');
console.log('PASS  试检索面板可展开');

// 交互：展开高级设置，确认逐会话开关和工作区「全局检索」还在
const advancedButton = find(afterOpen, (node) => node.type === 'button' && textOf(node).join('').includes('高级设置'));
if (!advancedButton.length) throw new Error('找不到「高级设置」按钮');
advancedButton[0].props.onClick();
for (let round = 0; round < 3; round += 1) {
  hookIndex = 0;
  tree = expand(captured());
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const advanced = expand(tree);
const advancedText = textOf(advanced).join(' | ');
if (!advancedText.includes('全局检索')) throw new Error('高级设置里缺少工作区「全局检索」开关');
if (!advancedText.includes('会话开关（按工作区分组）')) throw new Error('高级设置里缺少逐会话开关');
// 数字字段要把范围写进标签，否则用户看不到上限（输入超了会被悄悄夹回）
if (!advancedText.includes('最多注入几段（1–10）')) throw new Error('自检索「最多注入几段」没显示范围 1–10');
if (!advancedText.includes('注入总字数上限（200–4000）')) throw new Error('自检索「注入总字数上限」没显示范围 200–4000');
if (!advancedText.includes('至少命中几个查询词（1–6）')) throw new Error('minHits 没显示范围');
const checkboxes = find(advanced, (node) => node.type === 'input' && node.props.type === 'checkbox');
// 总开关 3 个 + 工作区 2 个 + 会话 3 个
if (checkboxes.length < 8) throw new Error(`复选框数量不对：${checkboxes.length}`);
console.log(`PASS  高级设置里恢复会话开关（${checkboxes.length} 个复选框）`);

// 布局：两栏不能折行（窄面板下折行会变成「上会话、下集合」，和文案的左右不符）
const twoColumn = find(tree, (node) => node.props && node.props.style && node.props.style.flexWrap === 'nowrap' && node.props.style.display === 'flex');
if (!twoColumn.length) throw new Error('找不到两栏容器（flexWrap: nowrap）');
const wide = twoColumn[0].children.filter((child) => child && child.type === 'div');
if (wide.length < 2) throw new Error('两栏容器里不足两列');
console.log('PASS  会话/集合是左右两栏（nowrap，不会折成上下）');

// 点一下工作区的「全局检索」勾，确认真的打到了 /workspace 接口
const workspaceLabel = find(advanced, (node) => node.type === 'label' && textOf(node).join('').includes('全局检索') && find(node, (c) => c.type === 'input').length);
if (!workspaceLabel.length) throw new Error('找不到工作区「全局检索」勾选框');
const before = calls.filter((c) => c.url.endsWith('/workspace')).length;
find(workspaceLabel[0], (c) => c.type === 'input')[0].props.onChange({ target: { checked: true } });
await new Promise((resolve) => setTimeout(resolve, 30));
const after = calls.filter((c) => c.url.endsWith('/workspace')).length;
if (after <= before) throw new Error('点「全局检索」没有调用 /workspace 接口');
console.log('PASS  「全局检索」勾选会调用 /workspace');

if (failed) throw new Error(`${failed} 项 UI 检查失败`);
console.log('UI OK');
