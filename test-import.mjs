/**
 * 同义词导入工具的测试：三种输入格式、分组切块、脏数据过滤。
 * 不需要 DSH，也不联网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInput, convert, normalizeWord, splitLine } from './tools/import-synonyms.mjs';

let checks = 0;
function expect(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label} ${detail}`);
  console.log(`PASS  ${label}`);
}

// ── 1. 单行拆分 ──────────────────────────────────────────────────────────
expect('空格分隔', splitLine('安装 部署 装好').join(',') === '安装,部署,装好');
expect('逗号/顿号分隔', splitLine('安装，部署、装好').join(',') === '安装,部署,装好');
expect('词林编码前缀被去掉', splitLine('Aa01A01= 人 士 人物 人士').includes('人物'), JSON.stringify(splitLine('Aa01A01= 人 士 人物 人士')));
expect('单字被丢弃', splitLine('人 士 人物').includes('人物') && !splitLine('人 士 人物').includes('人'));
expect('纯编码行返回空', splitLine('Aa01A01=').length === 0);
expect('注释行忽略', splitLine('# 这是注释').length === 0);
expect('超长词被丢弃', normalizeWord('这是一个非常非常长的词组超过限制') === '');
expect('标点被清理', normalizeWord('安装，') === '安装');

// ── 2. 三种输入格式 ──────────────────────────────────────────────────────
const cilin = ['Aa01A01= 安装 部署 装好', 'Aa01A02= 卸载 移除', '# 注释', ''].join('\n');
expect('解析词林格式', parseInput(cilin).length === 2, JSON.stringify(parseInput(cilin)));

const plain = '报错 错误 异常\n崩溃 闪退';
expect('解析纯文本', parseInput(plain).length === 2);

const json = JSON.stringify({ groups: [['重启', '重开'], ['日志', '记录', 'log']] });
expect('解析 JSON', parseInput(json).length === 2);
expect('JSON 数组形式也接受', parseInput(JSON.stringify([['重启', '重开']])).length === 1);

// ── 3. 大组切块 + 去重 + 过滤 ────────────────────────────────────────────
const big = [['一', '二', '三', '四', '五', '六', '七', '八', '安装', '部署']];
const chunked = convert([['安装', '部署', '配置', '参数', '选项', '开关', '设定', '组合']], { maxGroup: 3 });
expect('大组被切成小块', chunked.every((group) => group.length <= 3), JSON.stringify(chunked));
expect('切块不丢词', new Set(chunked.flat()).size === 8, JSON.stringify(chunked));
expect('处理后仍含 2 个词的小组', chunked.every((group) => group.length >= 2));
expect('重复组被去掉', convert([['重启', '重开'], ['重开', '重启']]).length === 1);
expect('含单字的组被丢弃', convert([['人', '士']]).length === 0);

// ── 4. 端到端：写文件 → 读回 → 结构合法 ─────────────────────────────────
const dir = path.join(os.tmpdir(), `syn-import-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
const src = path.join(dir, 'src.txt');
const out = path.join(dir, 'synonyms.json');
fs.writeFileSync(src, cilin, 'utf8');
const groups = convert(parseInput(fs.readFileSync(src, 'utf8')), { maxGroup: 6 });
fs.writeFileSync(out, JSON.stringify({ groups }, null, 2), 'utf8');
const round = JSON.parse(fs.readFileSync(out, 'utf8'));
expect('输出结构为 {groups: [...]}', Array.isArray(round.groups) && round.groups[0].length >= 2);
expect('输出词条都是小写规范形式', round.groups.flat().every((word) => word === word.toLowerCase() && word.length >= 2));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n共 ${checks} 项检查通过`);
console.log('IMPORT OK');
