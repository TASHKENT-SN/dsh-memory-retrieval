/**
 * 词表工具链的测试：同义词候选抽取 + 覆盖率统计。
 *
 * 这两个工具的价值不在"命中多少"，而在**给你一个可验证的答案**：
 * 你的语料里到底有没有可以自动学出来的等价表述。
 * 所以测试重点是"边界不误伤"，而不是"多抓几组"。
 */
import { extractPairs } from './tools/synonym-candidates.mjs';
import { summarize, isCandidate, stripTemplates } from './tools/synonym-coverage.mjs';

const failures = [];
const passed = { n: 0 };
const ok = (label, cond) => {
  if (cond) passed.n += 1;
  else failures.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

// ── 1. 带引号的等价表述能抽出来 ──────────────────────────────────────────
{
  const text = '我们说的「对象存储」，也叫「OSS」，是按对象存的。';
  const { groups } = extractPairs(text);
  ok('抽出「X」，也叫「Y」', groups.some((g) => g.includes('对象存储') && g.includes('OSS')));
}

{
  const text = '用这个「快照」（又叫「镜像」）就能回滚。';
  const { groups } = extractPairs(text);
  ok('抽出「X」（又叫「Y」）', groups.some((g) => g.includes('快照') && g.includes('镜像')));
}

{
  const text = 'DSH（也叫 DeepSeek Harness）是宿主。';
  const { groups } = extractPairs(text);
  ok('英文术语不加引号也能抽', groups.some((g) => g.includes('DSH') && g.some((w) => w.startsWith('DeepSeek'))));
}

// ── 2. 没有引号的句子片段不能被当成同义词 ────────────────────────────────
{
  const text = '保存后立即生效，也就是不用重启；取消勾选也就是恢复默认。';
  const { groups } = extractPairs(text);
  ok('不误抓无引号的动宾片段', groups.length === 0);
}

// ── 3. 覆盖率工具的候选词过滤 ────────────────────────────────────────────
ok('纯数字不算候选词', isCandidate('2026') === false);
ok('日期不算候选词', isCandidate('2026-10-30') === false);
ok('虚词二元组不算候选词', isCandidate('可以') === false || isCandidate('不是') === false);
ok('技术词算候选词', isCandidate('缓存') === true || isCandidate('安装') === true);

// ── 4. 模板行要剥掉，否则统计全被时间戳占满 ──────────────────────────────
{
  const raw = '【当前时间】2026/11/7 10:00\n我们打算换缓存\nTime sampled while preparing turn 3';
  const clean = stripTemplates(raw);
  ok('剥掉唤醒模板与时间戳', !clean.includes('【当前时间】') && !clean.includes('Time sampled') && clean.includes('我们打算换缓存'));
}

// ── 5. 覆盖率统计口径 ────────────────────────────────────────────────────
{
  const groups = [['缓存', 'cache']];
  const report = summarize(['缓存缓存 cache 别的内容'], groups);
  ok('覆盖率按出现次数加权', report.total > report.covered && report.ratio > 0 && report.ratio < 1);
  ok('排序按会话数（一个词出现在越多文档越靠前）', Array.isArray(report.uncovered) && report.uncovered.every((row) => typeof row.df === 'number'));
}

console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join(' / ')}` : `\n共 ${passed.n} 项检查通过`);
if (failures.length) process.exit(1);
console.log('SYNONYMS OK');
