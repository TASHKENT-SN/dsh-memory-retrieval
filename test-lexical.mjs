/**
 * 匹配层测试：分词、严格度、近义词扩展。
 * 不需要 DSH，也不需要真实会话。
 */
import { tokenize, buildQueryUnits, search } from './lib/retrieval.mjs';
import { searchCollection, termsOf } from './lib/collections.mjs';
import { loadSynonymGroups, buildSynonymMap } from './lib/synonyms.mjs';

const groups = loadSynonymGroups('');
const map = buildSynonymMap(groups);

let checks = 0;
function expect(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label} ${detail}`);
  console.log(`PASS  ${label}`);
}

// ── 1. 分词不再产出虚词二元组 ─────────────────────────────────────────────
expect('「怎么办」不产生查询词', tokenize('怎么办').length === 0, JSON.stringify(tokenize('怎么办')));
expect('「怎么」不产生查询词', tokenize('怎么').length === 0);
expect('「网络卡顿」产出网络/卡顿', tokenize('网络卡顿').includes('网络') && tokenize('网络卡顿').includes('卡顿'));
expect('「很卡」保留（有意义）', tokenize('很卡').includes('很卡'));

// ── 2. 近义词扩展 ────────────────────────────────────────────────────────
const units = buildQueryUnits('网速慢', map, groups);
const netUnit = units.find((unit) => unit.origin === '网速');
expect('「网速」扩出「卡顿」', Boolean(netUnit && netUnit.variants.includes('卡顿')), JSON.stringify(netUnit));
const direct = buildQueryUnits('卡顿', map, groups)[0];
expect('「卡顿」直接查到同组词', direct.variants.includes('延迟'));
expect('关闭词表时不扩展', buildQueryUnits('卡顿', null, []).length === 1 && buildQueryUnits('卡顿', null, [])[0].variants.length === 1);

// ── 3. 集合检索：近义词命中 + 不相关不命中 ───────────────────────────────

const index = {
  chunks: [
    { sessionId: 's1', title: '网络诊断会话', text: '链路速率只有 10Mbps，这是网络卡顿的直接原因。', from: 1, to: 2, terms: termsOf('链路速率只有 10Mbps，这是网络卡顿的直接原因。') },
    { sessionId: 's2', title: '合同会话', text: '违约金不超过合同总额的百分之二十。', from: 3, to: 4, terms: termsOf('违约金不超过合同总额的百分之二十。') },
  ],
  sessions: [],
  stats: { chunks: 2, chars: 60 },
};

const base = { topK: 3, maxChars: 800, perSnippetChars: 200, minScore: 1, minHits: 2 };
const withoutSynonym = searchCollection(index, '网速慢是什么原因', base);
const withSynonym = searchCollection(index, '网速慢是什么原因', { ...base, synonymMap: map, synonymGroups: groups });
expect('无词表时「网速慢」不命中', withoutSynonym.length === 0, `命中 ${withoutSynonym.length}`);
expect('有词表时「网速慢」命中卡顿会话', withSynonym.some((hit) => hit.title === '网络诊断会话'));
expect('不相关查询不命中', searchCollection(index, '量子力学的基本假设', { ...base, synonymMap: map, synonymGroups: groups }).length === 0);

// 严格度：两个查询词里只有一个泛词重合时应当被过滤
const noisy = searchCollection(index, '原因 量子力学', { ...base, minHits: 2, synonymMap: map, synonymGroups: groups });
expect('「原因 量子力学」被严格度过滤', noisy.length === 0, `命中 ${noisy.length}`);
const relaxed = searchCollection(index, '原因 量子力学', { ...base, minHits: 1, synonymMap: map, synonymGroups: groups });
expect('把严格度调到 1 就能命中', relaxed.length > 0);
expect('单字/单词查询自动放宽（不被 minHits 卡死）', searchCollection(index, '卡顿', { ...base, minHits: 2, synonymMap: map, synonymGroups: groups }).length > 0);

// ── 4. memory.jsonl 检索也走同一套 ───────────────────────────────────────
const memory = [
  { id: 'm1', title: '网络', text: '链路速率协商成 10Mbps 导致网络卡顿。', tags: [] },
  { id: 'm2', title: '喝茶', text: '用户最常喝乌龙茶。', tags: [] },
];
const memBase = { topK: 3, maxChars: 500, perRecordChars: 100, minScore: 1, minHits: 2 };
expect('记忆：无词表不命中', search(memory, '网速慢', memBase).length === 0);
expect('记忆：有词表命中', search(memory, '网速慢', { ...memBase, synonymMap: map, synonymGroups: groups }).length > 0);
expect('记忆：原文词照常命中', search(memory, '乌龙茶', memBase).length === 1);

console.log(`\n共 ${checks} 项检查通过`);
// ── 4. 排序：通用词不该单独撑起命中，少见词要能命中 ─────────────────────
{
  const fillers = [];
  for (let i = 0; i < 28; i += 1) {
    fillers.push({ sessionId: 's-' + i, title: '闲聊 ' + i, text: `第 ${i} 段：插件、测试、DSH 这些词每段都有，属于通用词。`, from: i, to: i });
  }
  fillers.push({ sessionId: 's-rare', title: '配额会话', text: '账单系统里，配额上限是按天重置的。', from: 28, to: 28 });
  const bigIndex = {
    chunks: fillers.map((f) => ({ ...f, terms: termsOf(f.text) })),
    sessions: [],
    stats: { chunks: fillers.length, chars: 0 },
  };
  const common = searchCollection(bigIndex, '插件测试', { topK: 3, maxChars: 900, minHits: 1, minScore: 1 });
  expect('通用词命中会被降级（weak），而不是直接丢掉', common.length > 0 && common.every((hit) => hit.weak === true));
  const rareFirst = searchCollection(bigIndex, '配额上限 插件', { topK: 3, maxChars: 900, minHits: 1, minScore: 1 });
  expect('强命中排在 weak 之前', rareFirst.length > 0 && rareFirst[0].weak !== true);
  const rare = searchCollection(bigIndex, '配额上限', { topK: 3, maxChars: 900, minHits: 1, minScore: 1 });
  expect('少见词仍能被检索到', rare.length === 1 && rare[0].text.includes('配额'));
  const func = searchCollection(bigIndex, '这也很好', { topK: 3, maxChars: 900, minHits: 1, minScore: 1 });
  expect('纯虚词查询不产生命中', func.length === 0);
}

console.log('LEXICAL OK');
