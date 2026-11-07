/**
 * `memory_links`：让**模型自己**往词表里加同义词。
 *
 * 为什么是模型来做：判断「网速慢」和「卡顿」是不是一回事，是语义判断。
 * 统计方法在个人语料上行不通（见 README「扩充词表」一节的三个失败结论）。
 *
 * 存储：写到 learned.json，与用户的 synonyms.json 分开——
 * 导入工具会整份覆盖 synonyms.json，混在一起会互相踩。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSynonymGroups, loadLearned, saveLearned, mergeGroups, buildSynonymMap } from './synonyms.mjs';

/** 和 index.js 一样：优先宿主那份 defineTool，拿不到就退回 asar 路径，再不行直接交普通对象 */
async function resolveDefineTool() {
  const candidates = ['@deepseek-ai/dsh-tools'];
  if (process.resourcesPath) {
    candidates.push(`${process.resourcesPath}/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`);
    candidates.push(`${process.resourcesPath}/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`);
  }
  for (const candidate of candidates) {
    try {
      const spec = candidate.startsWith('@') ? candidate : pathToFileURL(candidate).href;
      const mod = await import(spec);
      if (typeof mod?.defineTool === 'function') return mod.defineTool;
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {{register:Function}} options.tools   工具注册表
 * @param {string} options.learnedPath          learned.json 路径
 * @param {{cfg:object, synonymGroups:Array, synonymMap:Map}} options.runtime 运行时状态（会就地更新）
 * @param {(msg:string)=>void} [options.diag]
 */
export async function registerWordsTool({ tools, learnedPath, runtime, diag = () => {} }) {
  if (!tools?.register) return;

  const defineTool = await resolveDefineTool();
  diag('memory_links defineTool：' + (defineTool ? '已解析' : '未找到（用普通对象注册）'));

  const reloadSynonyms = () => {
    const base = runtime.cfg.synonymsEnabled ? loadSynonymGroups(runtime.cfg.synonymPath) : [];
    const learned = loadLearned(learnedPath).groups;
    runtime.synonymGroups = learned.length ? [...base, ...learned] : base;
    runtime.synonymMap = buildSynonymMap(runtime.synonymGroups);
    return { base: base.length, learned: learned.length };
  };

  const spec = {
    name: 'memory_links',
    description: [
      'Two kinds of records:',
      'kind="synonym" (default) — several words for the SAME thing (网速慢 / 卡顿 / 延迟); expanded at query time.',
      'kind="related" — two DIFFERENT concepts that genuinely belong together in this domain',
      '(网络 ↔ 路由器, 磁盘 ↔ 固态硬盘, 登录态 ↔ Cookie); used only as a second hop',
      'when the conversation already mentions one side. The relation is a fact about the world,',
      'not a wording difference — record it when the two ideas actually came up together.',
      'Use it on your own initiative; the user should never have to ask.',
      'Pass list=true to see what has been learned. Changes take effect immediately.',
    ].join(' '),
    parameters: {
      words: { type: 'string', description: 'kind=synonym: two or more interchangeable words ("网速慢,卡顿,延迟"). kind=related: exactly one pair of related concepts ("网络,路由器"). Ignored when list=true.' },
      note: { type: 'string', description: 'Why they belong together — shown to the user for review (optional).' },
      kind: { type: 'string', description: 'synonym (default) = different names for the same thing, expanded at query time. related = two distinct but related concepts (网络 ↔ 路由器); used only as a second hop when the conversation already mentions one side.' },
      list: { type: 'boolean', description: 'When true, return what has been learned instead of adding.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    execute: async (args) => {
      if (args?.list === true) {
        const { groups, links } = loadLearned(learnedPath);
        if (!groups.length && !links.length) return '还没有记下任何东西。遇到「同一个东西的两种说法」或「两个本来就相关的概念」时再调用我。';
        const lines = [];
        if (groups.length) lines.push('同义词（查询时直接扩展）：', ...groups.map((group) => '  ' + group.join(' ≈ ')));
        if (links.length) lines.push('联想（只在语境提到时顺藤摸一下）：', ...links.map((pair) => '  ' + pair.join(' → ')));
        return lines.join('\n');
      }

      const raw = String(args?.words ?? '');
      const words = [...new Set(raw.split(/[,，、\s]+/).map((word) => word.trim()).filter((word) => word.length >= 2))];
      if (words.length < 2) {
        return `至少要有两个词（收到 ${words.length} 个）。例如：words="网速慢,卡顿,延迟"`;
      }

      const learned = loadLearned(learnedPath);
      const kind = String(args?.kind ?? 'synonym') === 'related' ? 'related' : 'synonym';
      if (kind === 'related' && words.length !== 2) {
        return '联想只接受一对词（A,B）—— 联想是「两个相关概念之间的桥」，不是一组同义词。';
      }
      const mergedGroups = kind === 'synonym' ? mergeGroups(learned.groups, words) : learned.groups;
      const links = kind === 'related'
        ? [...learned.links, words].filter((pair, index, all) => all.findIndex((p) => [...p].sort().join('|') === [...pair].sort().join('|')) === index)
        : learned.links;
      let written;
      try {
        written = saveLearned(learnedPath, { groups: mergedGroups, links });
      } catch (error) {
        return '写入失败：' + String(error?.message ?? error);
      }
      const counts = reloadSynonyms();
      return [
        kind === 'related'
          ? `已记住联想：${words.join(' → ')}（累计 ${links.length} 对，主检索提到其中一个时才会用）`
          : `已记住：${words.join(' ≈ ')}（累计 ${mergedGroups.length} 组，立即生效）`,
        args?.note ? `理由：${args.note}` : '',
        `文件：${written}`,
        `当前生效词表：基础 ${counts.base} 组 + 学到 ${counts.learned} 组`,
      ].filter(Boolean).join('\n');
    },
  };

  try {
    tools.register(typeof defineTool === 'function' ? defineTool(spec) : spec);
    diag('memory_links 注册完成');
  } catch (error) {
    diag('memory_links 注册失败：' + String(error?.message ?? error));
  }
}
