// 桩测：在 node 里用 vm 跑 gas-earl-daily.gs，喂入真实 latest.json，验证关键逻辑。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = __dirname;
const src = fs.readFileSync(path.join(ROOT, 'gas-earl-daily.gs'), 'utf8');
const latest = JSON.parse(fs.readFileSync(path.join(ROOT, 'latest.json'), 'utf8'));

// ---- 桩：模拟 GAS 全局 ----
const props = {};
const sandbox = {
  console,
  Utilities: {
    formatDate: (d, tz, fmt) => {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
    }),
  },
  MailApp: { sendEmail: () => {}, getRemainingDailyQuota: () => 100 },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
  ScriptApp: { newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ nearMinute: () => ({ inTimezone: () => ({ create: () => {} }) }) }) }) }) }), getProjectTriggers: () => [] },
  Session: { getScriptTimeZone: () => 'Asia/Shanghai' },
  Math, JSON, Date, parseInt, parseFloat, isFinite, String, Number, Object,
  RegExp,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let fail = 0;
function assert(name, cond, extra) {
  console.log((cond ? '✅ ' : '❌ ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
}

// ---- 1. buildSignals_ 用真实数据 ----
const sig = sandbox.buildSignals_(latest.modules);
console.log('\n综合温度', sig.composite, sig.label, '| 估值分位', sig.valPct, '| M4.r3', sig.raw.r3, '| M14.gap227', sig.raw.gap227, '| M13.pct', sig.raw.concPct);
// 断言取 latest.json 里的真值，而不是写死数字——否则每天数据一动测试就红。
// 这里验的是「.gs 的取值路径对不对」（如 pe_pct 缺失时回退 pr_pct），不是行情本身。
const V12 = latest.modules.m12.values, V14 = latest.modules.m14.values, V4 = latest.modules.m4.values;
assert('buildSignals_ 估值分位跟随 m12',
  Math.abs(sig.valPct - (V12.pe_pct ?? V12.pr_pct ?? 50)) < 0.05,
  'valPct=' + sig.valPct);
assert('buildSignals_ M4.r3 跟随 m4.values.r3',
  Math.abs(sig.raw.r3 - V4.r3) < 1e-6, 'r3=' + sig.raw.r3);
assert('buildSignals_ M14.gap227 = 担保比例 − 227',
  Math.abs(sig.raw.gap227 - (V14.gap227 ?? (V14.ratio - 227))) < 0.05,
  'gap=' + sig.raw.gap227 + ' vs ' + V14.gap227);

// ---- 2. 经验规则动态判定（核心：M4 冲突修复）----
const combos = sandbox.evalCombos_(sig);
console.log('\n危险组合:', JSON.stringify(combos.danger.legs.map(l => ({ n: l.name, ok: l.ok, v: l.val }))));
console.log('底部组合:', JSON.stringify(combos.bottom.legs.map(l => ({ n: l.name, ok: l.ok, v: l.val }))));
assert('危险组合未触发(因M14离强平线远)', combos.danger.active === false, 'hits=' + combos.danger.hits + '/' + combos.danger.total);
assert('底部组合未触发(因M4为正+M14远)', combos.bottom.active === false, 'hits=' + combos.bottom.hits + '/' + combos.bottom.total);
const m4leg = combos.bottom.legs.find(l => l.name.indexOf('M4') >= 0);
assert('M4 腿显示 ✗ 且数值为 +5.00%', m4leg.ok === false && m4leg.val === '+5.00%', 'val=' + m4leg.val);

// ---- 3. comboHtml_ 真的渲染了 ✗ 与当前 +5.00% ----
const html = sandbox.comboHtml_('底部组合', 'desc', combos.bottom, '#ecfdf5', '#0f9960', {});
assert('comboHtml 含 当前 +5.00%', html.indexOf('当前 +5.00%') >= 0);
assert('comboHtml 含 当前未触发', html.indexOf('当前未触发') >= 0);
assert('comboHtml 含 ✗ 标记', html.indexOf('✗') >= 0);

// ---- 4. buildHtml_ 全量渲染不崩溃（fred=null 跳过宏观；AI 走规则兜底）----
const rows = sandbox.parseLlmsTxt_(fs.existsSync(path.join(ROOT,'llms.txt')) ? fs.readFileSync(path.join(ROOT,'llms.txt'),'utf8') : '');
const bundle = { json: latest, text: '', fred: null, warn: [], ai: { ok:false, lines:null, model:'', error:'测试' }, rule: sandbox.buildRuleSummary_(sig, rows) };
const full = sandbox.buildHtml_(rows, latest.modules, sig, bundle);
assert('buildHtml_ 产出非空', full.length > 1000, 'len=' + full.length);
assert('buildHtml_ 不含硬编码"M4 三年滚动年化为负"', full.indexOf('M4 三年滚动年化为负') < 0);
assert('buildHtml_ 含 当前 +5.00%（底部组合动态）', full.indexOf('当前 +5.00%') >= 0);

// ---- 5. 边界：若 M4 真为负，底部组合应触发 ----
const fakeMods = JSON.parse(JSON.stringify(latest.modules));
fakeMods.m4.values.r3 = -3.5;
fakeMods.m14.values.gap227 = 5.0;
fakeMods.m12.values.pe_pct = 20.0;
const sig2 = sandbox.buildSignals_(fakeMods);
const c2 = sandbox.evalCombos_(sig2);
assert('M4为负+M14贴近+估值便宜 → 底部组合触发', c2.bottom.active === true, 'hits=' + c2.bottom.hits + '/' + c2.bottom.total);

console.log('\n' + (fail === 0 ? 'ALL PASS' : (fail + ' 个断言失败')));
process.exit(fail === 0 ? 0 : 1);
