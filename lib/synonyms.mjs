/**
 * 轻量近义词层：纯本地词表，零 API。
 *
 * 只做「查询侧扩展」——用户问「网速慢」时，把同组的「卡顿 / 延迟」一并拿去匹配，
 * 权重比原词低（默认 0.7），所以原词仍然优先。
 *
 * 词表来源优先级：
 *   1. 配置 synonymPath 指定的 JSON；
 *   2. ~/.dsh/dsh-memory-retrieval/synonyms.json；
 *   3. 内置默认表（覆盖本机常见的技术/运维/日常说法）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_GROUPS = [
  // 故障与症状
  ['卡顿', '延迟', '掉帧', '很卡', '网速慢', '网络慢', '网速差', '带宽不足'],
  ['丢包', '掉线', '断网', '连不上'],
  ['报错', '错误', '异常', '出错'],
  ['崩溃', '闪退', '崩了', '挂掉'],
  ['问题', '故障', '毛病'],
  // 安装与运维
  ['安装', '装好', '装上'],
  ['部署', '上线', '发布'],
  ['卸载', '移除', '删掉'],
  ['删除', '清理', '清空'],
  ['配置', '设置', '参数'],
  ['选项', '开关'],
  ['重启', '重开', '重新启动'],
  ['升级', '更新', '迭代'],
  ['回滚', '降级', '还原'],
  ['备份', '快照', '存档'],
  ['恢复', '找回'],
  // 日志与排查
  ['日志', '记录', 'log'],
  ['堆栈', 'stacktrace', '调用栈'],
  ['缓存', 'cache'],
  ['内存', '运存', 'ram'],
  ['磁盘', '硬盘', '存储空间'],
  ['进程', '服务', 'service'],
  ['端口', 'port'],
  ['接口', 'api', '请求'],
  // 账号与权限
  ['网络', '联网', '上网'],
  ['密码', '口令', 'password'],
  ['登录', '登陆', '登入'],
  ['权限', '授权', '许可'],
  ['账号', '帐号', '账户'],
  // 开发
  ['插件', '扩展', 'extension', 'plugin'],
  ['版本', '版本号', 'version'],
  ['依赖', 'dependency'],
  ['仓库', '代码库', 'repo', 'repository'],
  ['提交', 'commit'],
  ['分支', 'branch'],
  ['合并', 'merge'],
  ['冲突', 'conflict'],
  ['测试', '自测', '验证'],
  ['文档', '说明', 'readme'],
  ['示例', '例子', '样例'],
  // 商务
  ['费用', '价格', '收费', '多少钱'],
  ['退款', '退货', '退钱', '退费'],
  ['订单', '下单', '单据'],
  ['发票', '开票', '票据'],
  ['合同', '协议', '契约'],
  ['违约', '违约金', '违约责任'],
  ['审核', '审批', '审阅'],
  // 日常
  ['会议', '开会', 'meeting'],
  ['日程', '日历', '安排'],
  ['截止', '期限', '到期'],
  ['提醒', '通知', '告知'],
  ['记忆', '回忆', '记得'],
  ['浏览器', 'browser', 'chrome'],
  ['导出', '下载', '保存'],
  ['导入', '上传'],
];

/** agent 自己学到的词表；与用户的 synonyms.json 分开，避免互相覆盖 */
export function defaultLearnedPath() {
  return path.join(os.homedir(), '.dsh', 'dsh-memory-retrieval', 'learned.json');
}

export function defaultSynonymPath() {
  return path.join(os.homedir(), '.dsh', 'dsh-memory-retrieval', 'synonyms.json');
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const group of input) {
    if (!Array.isArray(group)) continue;
    const words = [...new Set(group.map((word) => String(word ?? '').trim().toLowerCase()).filter((word) => word.length >= 2))];
    if (words.length >= 2) out.push(words);
  }
  return out;
}

/** 读取词表；找不到/坏掉都退回内置表，不让它影响检索。 */
export function loadSynonymGroups(file = '') {
  const target = file ? (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file) : defaultSynonymPath();
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const groups = normalizeGroups(raw?.groups ?? raw);
    if (groups.length) return groups;
  } catch {
    // 没有自定义词表就用内置的
  }
  return normalizeGroups(DEFAULT_GROUPS);
}

/** term → 同组其它词 */
/** 读学习词表；没有或坏掉都当空表。 */
export function loadLearnedGroups(file = '') {
  const target = file || defaultLearnedPath();
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    return normalizeGroups(raw?.groups ?? raw);
  } catch {
    return [];
  }
}

export function buildSynonymMap(groups) {
  const map = new Map();
  for (const group of groups) {
    for (const word of group) {
      let set = map.get(word);
      if (!set) {
        set = new Set();
        map.set(word, set);
      }
      for (const other of group) if (other !== word) set.add(other);
    }
  }
  return map;
}

/**
 * 把查询拆成「单元」：每个单元是一个原词 + 它的同义词变体。
 * 计分时一个单元最多贡献一次，避免同义词堆叠刷分。
 * （实现在 retrieval.mjs，避免两个模块互相 import。）
 */

/**
 * 合并新词进现有词表。
 *
 * 语义：给出的词先合成一组；若与已有组有交集，就并进那一组（避免"卡顿/延迟"和"延迟/掉帧"分裂成两张表）。
 * 组内去重、限制单组大小，防止模型一次写进来十几个词把扩展面撑爆。
 */
export function mergeGroups(existing, incoming, { maxGroup = 8 } = {}) {
  const merged = normalizeGroups(existing).map((group) => [...group]);
  // incoming 可以是单组 ["延迟","掉帧"]，也可以是多组 [[...],[...]]
  const fresh = normalizeGroups(Array.isArray(incoming?.[0]) ? incoming : [incoming]);
  for (const group of fresh) {
    const matching = merged.filter((existingGroup) => existingGroup.some((word) => group.includes(word)));
    if (!matching.length) {
      merged.push(group.slice(0, maxGroup));
      continue;
    }
    const union = new Set(matching.flatMap((g) => g));
    for (const word of group) union.add(word);
    const combined = [...union].slice(0, maxGroup);
    for (const g of matching) merged.splice(merged.indexOf(g), 1);
    merged.push(combined);
  }
  return merged;
}

/** 写回词表文件；返回写入路径。 */
export function saveSynonymGroups(file, groups) {
  const target = file || defaultSynonymPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ groups: normalizeGroups(groups) }, null, 2)}\n`, 'utf8');
  return target;
}

export function writeExampleSynonyms(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ groups: DEFAULT_GROUPS }, null, 2)}\n`, 'utf8');
  return file;
}

/** 联想对：两个词相关但不可互换（网络 → 路由器）；只在语境已经提到其中一个时才启用 */
export function normalizeLinks(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const pair of input) {
    if (!Array.isArray(pair)) continue;
    const words = [...new Set(pair.map((w) => String(w ?? '').trim().toLowerCase()).filter((w) => w.length >= 2))];
    if (words.length !== 2) continue;
    const key = [...words].sort().join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(words);
  }
  return out;
}

/** 读学习文件：同义词组 + 联想对 */
export function loadLearned(file = '') {
  const target = file || defaultLearnedPath();
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    return { groups: normalizeGroups(raw?.groups ?? []), links: normalizeLinks(raw?.links ?? []) };
  } catch {
    return { groups: [], links: [] };
  }
}

/** 写学习文件（groups 与 links 一起写，避免互相覆盖） */
export function saveLearned(file, { groups, links }) {
  const target = file || defaultLearnedPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = { groups: normalizeGroups(groups ?? []), links: normalizeLinks(links ?? []) };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}
