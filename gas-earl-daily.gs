/**
 * ============================================================================
 *  A 股指标看板 · 每日自动解读邮件
 *  数据源：https://wj624.github.io/earl-etf-dashboard/
 *  运行环境：Google Apps Script（script.google.com）
 *  作者备注：本文件仅为「读取 + 解读 + 发信」，不做任何交易动作。
 * ============================================================================
 *
 *  【第一次使用，按顺序做这 5 步】
 *
 *  1. 打开 https://script.google.com/home → 左上「新项目」
 *  2. 把本文件全部内容粘进编辑器，覆盖掉原来的空 myFunction
 *  3. 点顶部「保存」（Ctrl+S），项目名建议改成「A股每日解读」
 *  4. 依次运行下面几个函数（每个都会弹授权，全部点「允许」）：
 *       ① testConnections()      —— 测三个接口通不通，看「执行记录」
 *       ② setGeminiKey('你的密钥') 和 setFredKey('你的FRED密钥')  —— 见下方说明
 *       ③ previewNow()           —— 立刻发一封测试邮件到你邮箱
 *       ④ installDailyTrigger()  —— 装上每天 19:15（北京）自动跑的定时器
 *  5. 完成。之后每天自动收到邮件；想停就运行 removeTriggers()
 *
 *  【为什么定时 19:15】
 *  看板每天 18:30（北京）由 GitHub Actions 更新，抓数+构建通常 1~8 分钟。
 *  留 45 分钟缓冲，避开 GitHub 定时任务排队延迟。
 *
 *  【⚠️ 密钥为什么不能写进代码】
 *  这个文件会提交到公开仓库。Google / FRED 都有自动化扫描器，一旦把密钥
 *  写进代码并被公开，密钥会被直接作废（报 403 reported as leaked）。
 *  正确做法：密钥用 setGeminiKey / setFredKey 存进「脚本属性」，代码里永远是空的。
 *
 *  【出问题先看哪里】
 *  左侧「执行记录 / Executions」→ 点开最近一次 → 看「日志」，每一步都打了日志。
 *  常见：Gemini 配额用完 → 邮件仍会发，「AI 总结」栏自动降级为规则版并写明原因；
 *        FRED 挂了 → 只影响「宏观对照」小节；看板数据未更新 → 顶部会有黄条提示。
 */

// ============================================================
// 1. 配置区（只改这里就够了）
// ============================================================
var CONFIG = {
  // —— 数据源 ——
  URL_JSON: 'https://wj624.github.io/earl-etf-dashboard/latest.json', // 结构化数值，约 7.6KB
  URL_TEXT: 'https://wj624.github.io/earl-etf-dashboard/llms.txt',    // 人话读数 + 判读口径，约 8.6KB
  URL_SITE: 'https://wj624.github.io/earl-etf-dashboard/',

  // —— 密钥 ——
  // ⚠️ 不要把密钥写在这里！这个文件是公开仓库的一部分，
  //    Google / FRED 的泄露扫描器会扫到并自动把密钥作废。
  //    正确做法：跑一次 setGeminiKey('...') / setFredKey('...')，存在脚本属性里。
  //    下面的字段永远留空；只有当脚本属性里没有值时才会作为最后兜底。
  GEMINI_API_KEY: '',   // 留空即可
  FRED_API_KEY: '',     // 留空即可

  // —— 收件人（多个用英文逗号分隔）——
  RECEIVER_EMAIL: '332515070@qq.com',

  // —— Gemini 模型：按顺序尝试，第一个成功即用 ——
  // 脚本还会自动发现你账号下能用的模型并优先使用，所以这里填错也不致命。
  GEMINI_MODELS: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'],

  // —— 时区与定时 ——
  TIMEZONE: 'Asia/Shanghai',
  TRIGGER_HOUR: 19,
  TRIGGER_MINUTE: 15,

  // —— 行为开关 ——
  WEEKDAYS_ONLY: false,     // true = 周六周日不发送（默认 false：与触发器时间一致每天跑；
                            //        但下面的 SKIP_IF_UNCHANGED 会在数据日没推进时自动跳过，
                            //        所以周末/节假日数据不更新时也不会发重复邮件）
  SKIP_IF_UNCHANGED: true,  // true = 数据日与上次成功发送相同则跳过（避免重复发同一天数据）
  WITH_GEMINI: true,        // 改成 false 就不调 AI，只发明细（省配额、更快）
  WITH_FRED: true,          // 改成 false 就不取美债（少一个外部依赖）
  DRY_RUN: false            // 改成 true 只打印邮件 HTML，不发信
};

// ============================================================
// 2. 密钥层（密钥存「脚本属性」，不进代码）
// ============================================================
var PROP_GEMINI = 'GEMINI_API_KEY';
var PROP_FRED   = 'FRED_API_KEY';
var PROP_ASOF   = 'LAST_ASOF';        // 上次成功发送的数据日，用于去重
var PROP_SAME   = 'SAME_COUNT';       // 连续数据未推进次数
var PROP_MODELS = 'GEMINI_MODELS_CACHE'; // 自动发现的可用模型，下次直接命中

// 最近一次和 Google 通信的失败报文，listGeminiModels 靠它区分「密钥被作废」和「没开 API」
var LAST_GEMINI_ = { code: 0, msg: '' };

// previewNow() 会临时置为 true，跳过周末与去重检查
var FORCE_ = false;

/** 取 Gemini 密钥：优先脚本属性，其次 CONFIG（兼容旧写法） */
function geminiKey_() {
  try {
    var k = PropertiesService.getScriptProperties().getProperty(PROP_GEMINI);
    if (k) return String(k).trim();
  } catch (e) {}
  return String(CONFIG.GEMINI_API_KEY || '').trim();
}

/** 取 FRED 密钥：优先脚本属性，其次 CONFIG */
function fredKey_() {
  try {
    var k = PropertiesService.getScriptProperties().getProperty(PROP_FRED);
    if (k) return String(k).trim();
  } catch (e) {}
  return String(CONFIG.FRED_API_KEY || '').trim();
}

/** 密钥指纹：只露头尾，方便确认是不是同一把 */
function keyFp_(k) {
  if (!k) return '（未设置）';
  if (k.length <= 12) return '（太短，可能填错）';
  return k.substring(0, 6) + '…' + k.substring(k.length - 4) + '（' + k.length + ' 位）';
}

/**
 * ① 设置 Gemini 密钥（只需要跑一次，之后一直生效）
 * 用法：把下面这行的占位换成你的密钥，运行一次，然后把那行删掉。
 *   setGeminiKey('AIza...你的密钥...')
 */
function setGeminiKey(k) {
  if (k === undefined || k === null || String(k).trim() === '' || String(k) === 'thisKeyIsNotSet') {
    log_('用法：在代码里临时写一行  setGeminiKey(\'你的密钥\')  然后运行本函数。');
    log_('密钥申请地址：https://aistudio.google.com/apikey');
    log_('当前已设置的密钥：' + keyFp_(geminiKey_()));
    return;
  }
  var v = String(k).trim();
  PropertiesService.getScriptProperties().setProperty(PROP_GEMINI, v);
  log_('✅ 已保存 Gemini 密钥：' + keyFp_(v));
  log_('   它存在「项目设置 → 脚本属性」里，不会随代码一起被提交或分享。');
  log_('   建议现在把刚才那行 setGeminiKey(...) 删掉，避免留在编辑器里。');
  log_('   下一步：运行 listGeminiModels() 确认能用哪些模型。');
}

/**
 * ① 设置 FRED 密钥（只需要跑一次）
 * 申请地址：https://fredaccount.stlouisfed.org/apikeys
 * 用法：临时写一行  setFredKey('你的密钥')  运行一次，然后删掉那行。
 */
function setFredKey(k) {
  if (k === undefined || k === null || String(k).trim() === '' || String(k) === 'thisKeyIsNotSet') {
    log_('用法：在代码里临时写一行  setFredKey(\'你的密钥\')  然后运行本函数。');
    log_('密钥申请地址：https://fredaccount.stlouisfed.org/apikeys');
    log_('当前已设置的 FRED 密钥：' + keyFp_(fredKey_()));
    return;
  }
  var v = String(k).trim();
  PropertiesService.getScriptProperties().setProperty(PROP_FRED, v);
  log_('✅ 已保存 FRED 密钥：' + keyFp_(v));
  log_('   同样存在「脚本属性」里，不会随代码走。');
}

/** 清掉已存的两种密钥 */
function clearKeys() {
  try {
    var p = PropertiesService.getScriptProperties();
    p.deleteProperty(PROP_GEMINI);
    p.deleteProperty(PROP_FRED);
  } catch (e) {}
  log_('已清除脚本属性里的 Gemini 与 FRED 密钥。');
}

// 中文名 → 代码，用于邮件主题与分组顺序
var GROUP_ORDER = ['估值', '情绪', '风格', '红利', '风险'];

// 每个指标「这是什么」的一句话白话说明（补充 llms.txt 的「怎么读」规则）
var PLAIN = {
  M1:   '把 A 股当成一个有波动的商品，看现在比过去 5 年的平均成本贵了多少。',
  M1B:  '同一件事的原始版本：跌穿「五年均线再打八折」这条线，就是作者定义的抄底区。',
  M2:   '股票能赚的钱（1÷市盈率）减去国债利息，差得越多，股票越划算。',
  M12:  '把沪深300 的股价、市盈率、市赚率三张图并排看，避免被盈利周期骗。',
  M3:   '如果炒股几年的收益跟买债基差不多，说明承担风险已经没人愿意了，往往是底。',
  M3B:  '同上，但债券那一边换成一只真实基金的净值，更有实感。',
  M4:   '买偏股基金的人，过去三年平均每年赚多少。这个数有很大均值回归倾向。',
  M5:   '偏股基金的累计收益，历史上两次大顶都恰好涨到「只比债基高一点」的位置。',
  M5B:  '同上，债券那一边换成易方达增强回报这只真实基金，更贴近原文。',
  M6A:  '沪深300 里，成长股和价值股谁更强。看两条线的比值。',
  M6B:  '中证1000 里，小盘成长和小盘价值谁更强。',
  M6C:  '大盘股和小盘股谁更强（沪深300 ÷ 中证1000）。',
  M7:   '全市场口径的成长与价值对比，历史最长，最能代表 A 股的风格钟摆。',
  M13:  '全市场成交额前几名占了多大比例。越高说明钱越往少数票里挤（抱团）。',
  M14:  '借钱炒股的人，账户里的钱是负债的几倍。跌到 227% 会被强制平仓。',
  M8:   '红利指数每年分红能给出多少回报，减去国债利息还剩多少。',
  M9:   '最近 40 个交易日，红利比大盘强多少。为正说明大家在往防守跑。',
  M10:  '红利指数相对自身长期趋势线偏离了几个标准差（Z 值）。看 Z 不看点位。',
  M10B: '同上，但用含分红的全收益指数，这条更准。',
  M11:  '同一批公司，A 股和港股谁更强。反映两地资金谁更积极。'
};

// ============================================================
// 3. 主入口
// ============================================================
function dailyMain() {
  var t0 = new Date();
  log_('=== 开始 ' + fmt_(t0) + ' ===');

  // ---- 3.1 周末跳过（可关）----
  if (!FORCE_ && CONFIG.WEEKDAYS_ONLY && isWeekend_()) {
    log_('今天是周末（' + weekdayCn_(t0) + '），按设置不发送。');
    return;
  }

  // ---- 3.2 取数据 ----
  var d = fetchJson_();
  var txt = fetchText_();
  if (!d && !txt) {
    sendError_('看板数据取不到（latest.json 与 llms.txt 都失败）', '请检查看板是否可访问：' + CONFIG.URL_SITE);
    return;
  }
  if (!d) {
    sendError_('latest.json 解析失败', '取到了内容但不是合法 JSON，可能仓库正在构建中。');
    return;
  }

  var updated = d.updated || '';
  var latest = String(d.latest || '').substring(0, 10);
  var today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  log_('数据日(latest) ' + latest + '，生成时间(updated) ' + updated + '，今天 ' + today);

  // ---- 3.3 去重：数据日没推进就不重复发 ----
  var props = PropertiesService.getScriptProperties();
  var lastAsof = props.getProperty(PROP_ASOF) || '';
  if (!FORCE_ && CONFIG.SKIP_IF_UNCHANGED && lastAsof && lastAsof === latest) {
    var same = Number(props.getProperty(PROP_SAME) || '0') + 1;
    props.setProperty(PROP_SAME, String(same));
    log_('数据日没有推进（仍是 ' + latest + '，第 ' + same + ' 次），跳过本次发信。');
    if (same === 3) sendStale_(latest, today);   // 连续 3 次没推进，发一封提醒，避免"悄无声息地坏掉"
    return;
  }

  // ---- 3.4 数据新鲜度（updated 比今天旧，说明看板没重建）----
  var bundle = { json: d, text: txt || '', fred: null, ai: null, rule: null, warn: [] };
  var upDate = String(updated).substring(0, 10);
  if (upDate) {
    var staleDays = daysBetween_(upDate, today);
    if (staleDays >= 1) {
      bundle.warn.push('看板数据生成于 ' + updated + '，不是今天。可能 GitHub 定时任务还没跑完或排队延迟，页面数据会在更新后自动变新。');
    }
  }

  // ---- 3.5 解析 ----
  var rows = parseLlmsTxt_(bundle.text);
  var mods = d.modules || {};
  log_('解析到 ' + rows.length + ' 个指标，latest.json 有 ' + Object.keys(mods).length + ' 个模块');

  if (rows.length === 0 && Object.keys(mods).length === 0) {
    sendError_('数据解析失败', '两个数据源都取到了，但解析不出指标行，可能看板格式变了。');
    return;
  }

  // ---- 3.6 算信号 ----
  var sig = buildSignals_(mods);
  log_('综合温度 ' + sig.composite + ' (' + sig.label + ')；估值 ' + sig.valPct +
       '% / 情绪 ' + sig.mood + ' / 杠杆压力 ' + sig.pressure);

  // ---- 3.7 美债 ----
  if (CONFIG.WITH_FRED) {
    bundle.fred = fetchFred_();
    if (!bundle.fred) bundle.warn.push('FRED 美债数据没取到，本次跳过「宏观对照」小节。');
  }

  // ---- 3.8 AI 总结（一定会有：AI 不可用时降级为规则生成）----
  if (CONFIG.WITH_GEMINI) {
    bundle.ai = askGemini_(bundle.text, sig, bundle.fred, updated, today);
    if (!bundle.ai.ok) {
      log_('AI 不可用，降级为规则总结。原因：' + bundle.ai.error);
    }
  } else {
    bundle.ai = { ok: false, lines: null, model: '', error: '已在 CONFIG 里设置 WITH_GEMINI=false' };
  }
  // 无论 AI 是否成功，都准备一份规则总结，用于兜底与对照
  bundle.rule = buildRuleSummary_(sig, rows);

  // ---- 3.9 拼邮件 ----
  var html = buildHtml_(rows, mods, sig, bundle);
  var subject = '【A股温度 ' + sig.composite + '】' + sig.label + ' · ' +
                sig.valWord + ' · ' + sig.riskWord + ' | ' + (latest || today);

  // ---- 3.10 发信 ----
  if (CONFIG.DRY_RUN) {
    log_('DRY_RUN=true，不发信。HTML 长度 ' + html.length);
    log_(html.substring(0, 1200));
    return;
  }
  MailApp.sendEmail({
    to: CONFIG.RECEIVER_EMAIL,
    subject: subject,
    htmlBody: html,
    body: plainFallback_(rows, sig, updated, bundle),
    name: 'A股指标看板'
  });
  // 发信成功 → 记录数据日，重置去重计数
  props.setProperty(PROP_ASOF, latest);
  props.setProperty(PROP_SAME, '0');
  log_('已发送至 ' + CONFIG.RECEIVER_EMAIL + '，标题：' + subject);
  log_('=== 完成，耗时 ' + ((new Date() - t0) / 1000).toFixed(1) + ' 秒 ===');
}

// ============================================================
// 4. 取数
// ============================================================
function fetchJson_() {
  try {
    var r = UrlFetchApp.fetch(CONFIG.URL_JSON + '?t=' + Date.now(), {
      muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true
    });
    if (r.getResponseCode() !== 200) {
      log_('latest.json HTTP ' + r.getResponseCode());
      return null;
    }
    var o = JSON.parse(r.getContentText('UTF-8'));
    log_('latest.json OK，updated=' + o.updated + '，latest=' + o.latest);
    return o;
  } catch (e) {
    log_('latest.json 异常：' + e);
    return null;
  }
}

function fetchText_() {
  try {
    var r = UrlFetchApp.fetch(CONFIG.URL_TEXT + '?t=' + Date.now(), {
      muteHttpExceptions: true, followRedirects: true
    });
    if (r.getResponseCode() !== 200) {
      log_('llms.txt HTTP ' + r.getResponseCode());
      return '';
    }
    var t = r.getContentText('UTF-8');
    log_('llms.txt OK，' + t.length + ' 字符');
    return t;
  } catch (e) {
    log_('llms.txt 异常：' + e);
    return '';
  }
}

function fetchFred_() {
  var key = fredKey_();
  if (!key) {
    log_('未设置 FRED 密钥（运行 setFredKey(\'你的密钥\')），跳过「宏观对照」小节。');
    return null;
  }
  var out = {};
  var series = { DGS10: '美债10年', T10YIE: '美债10年通胀预期' };
  Object.keys(series).forEach(function (id) {
    try {
      var url = 'https://api.stlouisfed.org/fred/series/observations' +
                '?series_id=' + id + '&api_key=' + key +
                '&file_type=json&sort_order=desc&limit=15';
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) { log_('FRED ' + id + ' HTTP ' + r.getResponseCode()); return; }
      var obs = JSON.parse(r.getContentText('UTF-8')).observations || [];
      for (var i = 0; i < obs.length; i++) {
        if (obs[i].value && obs[i].value !== '.') {
          out[id] = { value: parseFloat(obs[i].value), date: obs[i].date, label: series[id] };
          break;
        }
      }
    } catch (e) { log_('FRED ' + id + ' 异常：' + e); }
  });
  return Object.keys(out).length ? out : null;
}

// ============================================================
// 5. 解析 llms.txt 的 Markdown 表格
//    表格结构：| 编号 | 指标 | 当前读数 | 数据截止 | 怎么读 |
// ============================================================
function parseLlmsTxt_(txt) {
  var rows = [], group = '';
  var lines = String(txt).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();

    var gm = ln.match(/^###\s+(.+)$/);
    if (gm) { group = gm[1].trim(); continue; }

    if (ln.charAt(0) !== '|') continue;
    var cells = ln.split('|');
    cells = cells.slice(1, cells.length - 1).map(function (s) { return s.trim(); });
    if (cells.length < 5) continue;
    if (!/^M\d/i.test(cells[0])) continue;      // 过滤表头与分隔行
    rows.push({
      code: cells[0].toUpperCase(),
      name: cells[1],
      reading: cells[2],
      asof: cells[3],
      howto: cells[4],
      group: group
    });
  }
  return rows;
}

// ============================================================
// 6. 把原始数值折成几个「温度」指标
// ============================================================
function buildSignals_(mods) {
  function v(k) { return (mods[k] && mods[k].values) || {}; }
  var m2 = v('m2'), m4 = v('m4'), m8 = v('m8'), m12 = v('m12'),
      m13 = v('m13'), m14 = v('m14'), m10b = v('m10b');

  // 估值温度：沪深300 PE 的历史分位（0-100，越低越便宜）
  var pePct = num_(m12.pe_pct, num_(m12.pr_pct, 50));
  var valTemp = clamp_(pePct, 0, 100);

  // 情绪温度：偏股基金 3 年滚动年化，-10% 记 0 度，+30% 记 100 度
  var r3 = num_(m4.r3, 0);
  var moodTemp = clamp_((r3 + 10) / 40 * 100, 0, 100);

  // 杠杆压力：距 227% 强平线越近越危险。60pt 以外记 0 压，贴线记 100 压
  var gap = num_(m14.gap227, 60);
  var pressure = clamp_((1 - gap / 60) * 100, 0, 100);

  // 红利吸引力：风险溢价（股息率减国债），0 记 0 分，5pt 记满分
  var spread = num_(m8.spread, 0);
  var redAttract = clamp_(spread / 5 * 100, 0, 100);

  // 综合温度：估值 40% + 情绪 40% + 杠杆 20%
  var composite = Math.round(valTemp * 0.4 + moodTemp * 0.4 + pressure * 0.2);

  var lb = tempLabel_(composite);

  // 「好机会程度」= 反向。用于红绿灯：越多越绿
  var goodVal = Math.round(100 - valTemp);
  var goodMood = Math.round(100 - moodTemp);
  var goodRisk = Math.round(100 - pressure);
  var goodRed = Math.round(redAttract);

  return {
    composite: composite,
    label: lb.text,
    labelColor: lb.color,
    valTemp: Math.round(valTemp),
    moodTemp: Math.round(moodTemp),
    pressure: Math.round(pressure),
    redAttract: Math.round(redAttract),
    valPct: Math.round(pePct * 10) / 10,
    mood: Math.round(moodTemp),
    valWord: goodVal >= 60 ? '估值便宜' : (goodVal >= 35 ? '估值居中' : '估值偏贵'),
    riskWord: goodRisk >= 60 ? '杠杆安全' : (goodRisk >= 35 ? '杠杆中性' : '杠杆紧绷'),
    lights: {
      估值: light_(goodVal),
      情绪: light_(goodMood),
      风险: light_(goodRisk),
      红利: light_(goodRed)
    },
    good: { 估值: goodVal, 情绪: goodMood, 风险: goodRisk, 红利: goodRed },
    raw: {
      pe: num_(m12.pe, null), pr: num_(m12.pr, null), hs300: num_(m12.hs300, null),
      ey: num_(m2.ey_cn, null), cn10y: num_(m2.cn10y, null), us10y: num_(m2.us10y, null),
      r3: r3, dy: num_(m8.dy, null), spread: spread,
      concPct: num_(m13.pct, null), concRatio: num_(m13.ratio, null), concWarn: num_(m13.warn, null),
      gap227: gap, ratio227: num_(m14.ratio, null), m14Pct: num_(m14.pct, null),
      z: num_(m10b.z, null), ann: num_(m10b.ann, null)
    }
  };
}

function tempLabel_(t) {
  if (t < 25) return { text: '冰点', color: '#0f9960' };
  if (t < 42) return { text: '偏冷', color: '#0f9960' };
  if (t < 58) return { text: '中性', color: '#ea8b1f' };
  if (t < 75) return { text: '偏热', color: '#d13a34' };
  return { text: '过热', color: '#b91c1c' };
}

/** 0-100 的「好机会程度」→ 红绿灯 */
function light_(good) {
  if (good >= 60) return { dot: '🟢', text: '偏机会', color: '#0f9960' };
  if (good >= 35) return { dot: '🟡', text: '中性', color: '#ea8b1f' };
  return { dot: '🔴', text: '偏危险', color: '#d13a34' };
}

/**
 * 规则版总结：不依赖任何外部服务，用已有数字拼出 7 段话。
 * AI 不可用时用它兜底，保证邮件里永远有一份「人话总结」。
 * 返回结构与 Gemini 解析结果一致：{ 总结, 一句话, 估值, 情绪, 风险, 红利, 建议 }
 */
function buildRuleSummary_(sig, rows) {
  var r = sig.raw;
  var f2 = function (v) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(2); };
  var f1 = function (v) { return (v === null || v === undefined) ? '—' : Number(v).toFixed(1); };

  var valTxt = sig.valPct < 30 ? '处在历史偏低区（便宜）'
             : (sig.valPct > 70 ? '处在历史偏高区（贵）' : '处在历史中间位置（不贵也不便宜）');
  var moodTxt = r.r3 < 0 ? '三年白干甚至亏损，属于典型的低迷区'
              : (r.r3 > 25 ? '三年收益很高，属于典型的热络区' : '三年收益正常，情绪不极端');
  var riskTxt = r.gap227 < 10 ? '已经贴近强平线，一点下跌就可能引发连锁平仓'
              : (r.gap227 > 50 ? '离强平线很远，杠杆端没有被动抛压' : '有一定缓冲，但不算宽裕');
  var redTxt = r.spread > 3 ? '红利相对国债明显划算，防守价值高'
             : (r.spread < 1.5 ? '红利相对国债吸引力一般' : '红利有一定性价比，但不算极端');

  var 总结 = '综合温度 ' + sig.composite + '/100，处于「' + sig.label + '」区间。' +
    '支撑这个判断的两组数是：沪深300 市盈率 ' + f2(r.pe) + ' 倍、历史分位 ' + f1(sig.valPct) + '%，估值' + valTxt + '；' +
    '两融担保比例 ' + f1(r.ratio227) + '%，距 227% 强平线还有 ' + f1(r.gap227) + ' 个点，' + riskTxt + '。' +
    '最大的风险在交易集中度：分位 ' + f1(r.concPct) + '%，若同时出现杠杆收紧，容易引发抱团瓦解。';

  var 一句话 = sig.label === '偏冷' || sig.label === '冰点'
    ? '整体偏冷、估值不贵，属于可以按原计划慢慢买的位置，但别指望马上涨。'
    : (sig.label === '过热' || sig.label === '偏热'
      ? '整体偏热，风险大于机会，这时候更重要的是管住手、别追高。'
      : '整体不冷不热，没有明显的方向性机会，按既定节奏执行即可。');

  return {
    '总结': 总结,
    '一句话': 一句话,
    '估值': '沪深300 市盈率 ' + f2(r.pe) + ' 倍，市赚率 ' + f2(r.pr) + '，PE 处于历史 ' + f1(sig.valPct) + '% 分位，' + valTxt + '。',
    '情绪': '偏股基金三年滚动年化 ' + f2(r.r3) + '%，' + moodTxt + '。',
    '风险': '两融担保比例 ' + f1(r.ratio227) + '%，距 227% 强平线 ' + f1(r.gap227) + ' 个点，' + riskTxt + '；交易集中度分位 ' + f1(r.concPct) + '%。',
    '红利': '中证红利股息率 ' + f2(r.dy) + '%，减去 10 年国债 ' + f2(r.cn10y) + '% 后风险溢价 ' + f2(r.spread) + ' 个点，' + redTxt + '。',
    '建议': '先盯住两个数：一是两融担保比例距 227% 还有多少点，跌到 10 点以内要格外小心；二是三棱镜（成长对价值的比值）40 日收益差是否由负转正，那是风格切换的信号。'
  };
}

// ============================================================
// 7. Gemini 解读
//    要求模型只输出 7 行「标签|内容」，便于稳定解析
// ============================================================

/** 把当日数据拼成给模型的 prompt。单独拆出来，重试时不用重复拼。 */
function buildPrompt_(txt, sig, fred, updated, today) {
  if (!txt) txt = '（本次未取到 llms.txt，仅凭数值判断）';

  var fredLine = '';
  if (fred && fred.DGS10) {
    fredLine = '参考：美债10年期 ' + fred.DGS10.value + '%（' + fred.DGS10.date + '）。\n';
  }

  return '你是给一个刚接触投资指标的中国普通投资者做解读的助手。\n' +
    '下面是一个 A 股指标看板今天的全部数据（Markdown 表格）。请据此写出今天的 AI 总结。\n\n' +
    '严格遵守：\n' +
    '1. 只能使用数据里出现的事实，绝对不要编造任何数字或历史事件。\n' +
    '2. 用大白话。必须用术语时，紧跟括号解释一句。\n' +
    '3. 除「总结」外，每行不超过 70 个汉字；「总结」不超过 180 个汉字。\n' +
    '4. 只输出下面 7 行，格式严格为「标签|内容」。不要标题、不要 Markdown、不要代码块、不要多余解释、不要分行。\n' +
    '5. 「建议」那行必须写成「观察动作」（例如：继续观察哪个数、什么条件下再考虑加仓），不能出现买入/卖出的直接指令。\n' +
    '6. 「总结」要像跟朋友讲话：先说结论（现在偏贵还是偏便宜、该激进还是保守），再说两个支撑这个结论的数据，最后说最大的风险是什么。不要罗列指标名。\n\n' +
    '需要输出的 7 行（标签必须一模一样）：\n' +
    '总结|（180 字内的一段话，可以带逗号句号，但不许换行）\n' +
    '一句话|（对完全不懂的人：现在是偏贵还是偏便宜，该激进还是该保守）\n' +
    '估值|（股票贵不贵，是用哪个数判断出来的）\n' +
    '情绪|（市场热不热，大家是在抢还是在跑）\n' +
    '风险|（杠杆和抱团有多危险，最该盯哪个数）\n' +
    '红利|（防守型的红利资产现在值不值得配）\n' +
    '建议|（如果只能做一件事，做什么）\n\n' +
    fredLine +
    '系统算出的综合温度：' + sig.composite + '/100（' + sig.label + '）\n' +
    '数据生成时间：' + updated + '，今天：' + today + '\n\n' +
    '数据如下：\n' + txt;
}

/**
 * 主流程：先试「上次发现的 + CONFIG 里配的」；
 * 全挂了就现场问一次 Google 有哪些模型能用，记住结果再试一轮。
 * 这样模型改名/下线时脚本能自己恢复，不用人去改代码。
 */
function askGemini_(txt, sig, fred, updated, today) {
  if (!geminiKey_()) {
    return { ok: false, lines: null, model: '',
             error: '还没设置 Gemini 密钥：运行一次 setGeminiKey(\'你的密钥\')，密钥在 https://aistudio.google.com/apikey 申请' };
  }
  var prompt = buildPrompt_(txt, sig, fred, updated, today);
  var errs = [];

  // ① 候选：上次发现成功的排前面，再补上 CONFIG 里的
  var list = [];
  var cached = cachedModels_();
  for (var i = 0; i < cached.length; i++) list.push(cached[i]);
  for (var j = 0; j < CONFIG.GEMINI_MODELS.length; j++) {
    if (list.indexOf(CONFIG.GEMINI_MODELS[j]) < 0) list.push(CONFIG.GEMINI_MODELS[j]);
  }

  var res = runModelList_(list, prompt, errs);
  if (res) return res;

  // ② 全失败 → 自动发现
  log_('配置里的模型全都不可用，开始自动发现可用模型…');
  var found = discoverModels_();
  if (found.length) {
    saveModels_(found);
    var extra = [];
    for (var k = 0; k < found.length; k++) {
      if (list.indexOf(found[k]) < 0) extra.push(found[k]);
    }
    if (extra.length) {
      log_('换用发现到的模型重试：' + extra.slice(0, 4).join(', '));
      res = runModelList_(extra, prompt, errs);
      if (res) return res;
    }
  } else {
    errs.push('自动发现模型也失败（多半是密钥没启用 Generative Language API，见执行日志）');
  }

  return { ok: false, lines: null, model: '', error: errs.join('；') };
}

/**
 * 问 Google：这把密钥到底能用哪些模型。
 * GET /v1beta/models?key=... 不需要任何模型权限，只要能列出就说明密钥是通的。
 */
function fetchModelList_() {
  var out = [];
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models' +
              '?key=' + geminiKey_() + '&pageSize=200';
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = r.getResponseCode();
    if (code !== 200) {
      var msg = r.getContentText('UTF-8');
      LAST_GEMINI_ = { code: code, msg: msg };
      log_('列模型失败 HTTP ' + code + '：' + msg.substring(0, 300));
      log_('提示：' + geminiHint_(code, msg));
      return out;
    }
    var body = JSON.parse(r.getContentText('UTF-8'));
    var arr = body.models || [];
    log_('Google 返回 ' + arr.length + ' 个模型');
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i] || {};
      var full = String(m.name || '');
      var name = full.replace(/^models\//, '');
      var methods = m.supportedGenerationMethods || [];
      out.push({
        name: name,
        display: m.displayName || '',
        methods: methods,
        canChat: methods.indexOf('generateContent') >= 0,
        input: m.inputTokenLimit || 0,
        output: m.outputTokenLimit || 0,
        desc: m.description || ''
      });
    }
  } catch (e) {
    log_('列模型异常：' + e);
  }
  return out;
}

/** 从模型清单里挑出适合聊天/写作的，按「好用程度」排序，返回短名数组 */
function discoverModels_(allIn) {
  var all = allIn || fetchModelList_();
  if (!all.length) return [];

  var cand = [];
  for (var i = 0; i < all.length; i++) {
    var m = all[i];
    if (!m.canChat) continue;
    // 排除不能做这段活的：向量化、重排、图像/视频生成、语音、纯视觉、实验性
    if (/embedding|aqa|rerank|imagen|veo|image|tts|audio|live|native-audio|learnlm|gemma/i.test(m.name)) continue;
    cand.push(m);
  }
  if (!cand.length) {
    log_('这个密钥下没有任何支持 generateContent 的对话模型。');
    return [];
  }

  // 打分：flash 优先（便宜快）、版本号大的优先、lite/小参数降权
  for (var j = 0; j < cand.length; j++) {
    var n = cand[j].name, sc = 0;
    if (/flash/i.test(n)) sc += 40;
    else if (/pro/i.test(n)) sc += 25;
    var vm = n.match(/gemini-(\d+)\.(\d+)/);
    if (vm) sc += parseInt(vm[1], 10) * 100 + parseInt(vm[2], 10) * 10;
    if (/lite|8b|-mini/i.test(n)) sc -= 18;
    if (/preview|exp/i.test(n)) sc -= 6;
    if (/latest/i.test(n)) sc += 4;
    cand[j].score = sc;
  }
  cand.sort(function (a, b) { return b.score - a.score; });

  var names = [];
  for (var k = 0; k < cand.length; k++) {
    if (names.indexOf(cand[k].name) < 0) names.push(cand[k].name);
  }
  return names;
}

/** 调一次指定模型，成功返回 {ok:true,...}，失败返回 {ok:false, err:'…'} */
function tryGeminiModel_(model, prompt) {
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              model + ':generateContent?key=' + geminiKey_();
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      // maxOutputTokens 给大一些：2.5 系列模型的「思考」也计入输出额度，
      // 给小了会出现正文被截断、只剩思考片段的情况。
      generationConfig: { temperature: 0.35, maxOutputTokens: 4000, topP: 0.9 }
    };
    var r = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = r.getResponseCode();
    if (code !== 200) {
      var msg = r.getContentText('UTF-8');
      LAST_GEMINI_ = { code: code, msg: msg };
      var hint = geminiHint_(code, msg);
      log_('Gemini ' + model + ' HTTP ' + code + '：' + msg.substring(0, 260));
      return { ok: false, err: model + ' → HTTP ' + code + (hint ? '，' + hint : '') };
    }
    var body = JSON.parse(r.getContentText('UTF-8'));
    var text = extractGeminiText_(body);
    if (!text) {
      return { ok: false, err: model + ' → 返回空内容（finishReason=' +
               (((body.candidates || [])[0] || {}).finishReason || '无') + '）' };
    }

    var parsed = parseGeminiLines_(text);
    if (!parsed) {
      log_('Gemini ' + model + ' 输出不符合格式，原文：' + text.substring(0, 300));
      return { ok: false, err: model + ' → 输出格式不符（未解析出标签行）' };
    }

    log_('Gemini ' + model + ' OK，解析到 ' + parsed.length + ' 行');
    return { ok: true, lines: parsed, model: model, error: '', err: '' };
  } catch (e) {
    log_('Gemini ' + model + ' 异常：' + e);
    return { ok: false, err: model + ' → ' + String(e).substring(0, 120) };
  }
}

/** 依次试一串模型，任一成功即返回；全失败返回 null */
function runModelList_(list, prompt, errs) {
  var cap = Math.min(list.length, 8);   // 最多试 8 个，避免卡住
  for (var i = 0; i < cap; i++) {
    var r = tryGeminiModel_(list[i], prompt);
    if (r.ok) return r;
    errs.push(r.err);
  }
  return null;
}

/** 模型名缓存：自动发现成功后写进脚本属性，下次直接命中，不用每次重新探测 */
function cachedModels_() {
  try {
    var s = PropertiesService.getScriptProperties().getProperty(PROP_MODELS) || '';
    if (!s) return [];
    var a = JSON.parse(s);
    return (Object.prototype.toString.call(a) === '[object Array]') ? a : [];
  } catch (e) { return []; }
}

function saveModels_(arr) {
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_MODELS, JSON.stringify(arr));
    log_('已记住可用模型：' + arr.slice(0, 4).join(', ') + (arr.length > 4 ? ' …' : ''));
  } catch (e) {}
}

/** 把常见的 HTTP 错误翻译成一句人话，直接写进邮件里方便排查 */
function geminiHint_(code, msg) {
  var m = String(msg || '');

  // 400：密钥本身有问题
  if (code === 400 && /API key not valid/i.test(m)) return '密钥无效，请去 AI Studio 重新复制';
  if (code === 400 && /API key expired/i.test(m)) return '密钥已过期，去 AI Studio 新建一把';
  if (code === 400) return '请求参数被拒，多半是模型名不对';

  // 403 有几种完全不同的原因，分开说，否则没法修
  if (code === 403) {
    if (/reported as leaked|has been leaked|leaked API key/i.test(m)) {
      return '⛔ 这把密钥已被 Google 判定为「泄露」并永久作废（多半是被公开仓库/网页扫到）。' +
             '改配置没用，必须新建一把：https://aistudio.google.com/apikey ' +
             '然后运行 setGeminiKey(\'新密钥\')';
    }
    if (/API_KEY_EXPIRED|expired/i.test(m)) return '密钥已过期，去 AI Studio 新建一把';
    if (/SERVICE_DISABLED|has not been used in project|it is disabled|enable it by visiting/i.test(m)) {
      return '这把密钥所属的 Google Cloud 项目还没启用 Generative Language API。' +
             '打开 https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com ' +
             '→ 选同一个项目 → 点「启用」，等 1~2 分钟再试';
    }
    if (/API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|requests to this API .* are blocked/i.test(m)) {
      return '这把密钥设了「API 限制」，把 Generative Language API 排除在外了。' +
             '去 https://console.cloud.google.com/apis/credentials 找到这把密钥 → ' +
             '「API 限制」里勾上 Generative Language API，或改成「不限制密钥」';
    }
    if (/PERMISSION_DENIED|caller does not have permission|CONSUMER_INVALID|SERVICE_DISABLED_FOR_CONSUMER/i.test(m)) {
      return '这个模型对你的账号或所在地区没有开放，换一个模型（跑 listGeminiModels() 能看到能用的）';
    }
    if (/billing|quota project/i.test(m)) {
      return '这个项目没有绑定结算账号，免费额度用不了。去 Cloud 控制台绑卡后重试';
    }
    return '无权使用这个模型：先跑 listGeminiModels() 看你的密钥到底能用哪些；' +
           '若一个都列不出来，多半是项目未启用 Generative Language API';
  }

  // 404：模型不存在 / 已下线
  if (code === 404) return '模型不存在或已下线（跑 listGeminiModels() 看当前可用的名字）';
  if (code === 429) return '超出免费配额（每分钟或每天），明天会恢复';
  if (code === 500 || code === 503) return 'Google 侧临时故障，稍后自动重试即可';
  return '';
}

function extractGeminiText_(body) {
  try {
    var c = body.candidates || [];
    for (var i = 0; i < c.length; i++) {
      var parts = (c[i].content && c[i].content.parts) || [];
      var s = '';
      for (var j = 0; j < parts.length; j++) {
        // 跳过「思考」片段：2.5 系列会把推理过程作为 part 返回，
        // 带 thought:true。拼进来会污染「标签|内容」的解析。
        if (parts[j].thought === true) continue;
        if (parts[j].text) s += parts[j].text;
      }
      if (s.trim()) return s.trim();
    }
    if (body.promptFeedback) log_('Gemini 无内容，promptFeedback=' + JSON.stringify(body.promptFeedback));
    var fr = (c[0] && c[0].finishReason) || '';
    if (fr) log_('Gemini finishReason=' + fr + (fr === 'MAX_TOKENS' ? '（输出被截断，可加大 maxOutputTokens）' : ''));
  } catch (e) {}
  return '';
}

function parseGeminiLines_(text) {
  var want = ['总结', '一句话', '估值', '情绪', '风险', '红利', '建议'];
  var map = {};
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].replace(/^[\s>*\-•\d.、]+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
    var p = ln.indexOf('|');
    if (p < 0) p = ln.indexOf('｜');
    if (p < 0) continue;
    var k = ln.substring(0, p).replace(/[【】\[\]:：]/g, '').trim();
    var v = ln.substring(p + 1).trim();
    if (want.indexOf(k) >= 0 && v) map[k] = v;
  }
  var out = [];
  for (var i2 = 0; i2 < want.length; i2++) {
    if (map[want[i2]]) out.push({ label: want[i2], text: map[want[i2]] });
  }
  return out.length >= 4 ? out : null;   // 至少解析出 4 行才算成功
}

// ============================================================
// 8. 生成 HTML 邮件
// ============================================================
function buildHtml_(rows, mods, sig, bundle) {
  var upDate = String((bundle.json && bundle.json.updated) || '').substring(0, 10);
  var latest = (bundle.json && bundle.json.latest) || '';
  var genAt = fmt_(new Date());
  var C = {
    bg: '#f5f6f8', card: '#ffffff', line: '#e5e7eb', line2: '#f3f4f6',
    tx: '#1f2328', tx2: '#5b6472', tx3: '#8b95a3',
    up: '#d13a34', down: '#0f9960', blue: '#2563eb', org: '#ea8b1f', pur: '#7c3aed'
  };
  var h = [];
  h.push('<div style="margin:0;padding:0;background:' + C.bg + ';">');
  h.push('<div style="max-width:660px;margin:0 auto;padding:0 12px 28px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;font-size:14px;line-height:1.65;color:' + C.tx + ';">');

  // ---------- 页头 ----------
  h.push('<div style="background:#1e293b;color:#fff;padding:18px 20px;border-radius:0 0 10px 10px;">');
  h.push('<div style="font-size:18px;font-weight:700;letter-spacing:.3px;">A 股指标看板 · 每日解读</div>');
  h.push('<div style="font-size:12px;color:#c7d0da;margin-top:5px;">数据日期 ' + esc_(latest || '—') +
         '　·　行情最新 ' + esc_(upDate || '—') + '　·　本邮件 ' + esc_(genAt) + ' 生成</div>');
  h.push('</div>');

  // ---------- 警告条 ----------
  if (bundle.warn && bundle.warn.length) {
    h.push('<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-top:12px;font-size:12.5px;color:#92400e;">');
    for (var w = 0; w < bundle.warn.length; w++) {
      h.push('<div>⚠️ ' + esc_(bundle.warn[w]) + '</div>');
    }
    h.push('</div>');
  }

  // ---------- AI 总结（固定第一栏，AI 不可用时自动降级为规则版）----------
  h.push(aiSummaryHtml_(bundle, sig, C));

  // ---------- 温度计 ----------
  h.push(sectionOpen_(C, '今天的温度计', '一眼看大概：数字越高 = 市场越热、越该保守。'));
  h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>');
  h.push('<td width="42%" valign="middle" style="padding:6px 10px 6px 0;text-align:center;">');
  h.push('<div style="font-size:44px;font-weight:800;line-height:1;color:' + sig.labelColor + ';">' + sig.composite + '</div>');
  h.push('<div style="font-size:13px;color:' + C.tx3 + ';margin-top:4px;">综合温度 / 100</div>');
  h.push('<div style="display:inline-block;margin-top:8px;background:' + sig.labelColor +
         ';color:#fff;font-size:13px;font-weight:700;padding:3px 14px;border-radius:12px;">' + esc_(sig.label) + '</div>');
  h.push('</td>');
  h.push('<td width="58%" valign="middle" style="padding:6px 0 6px 10px;">');
  h.push(barRow_('估值热度', sig.valTemp, '越低越便宜', C, false));
  h.push(barRow_('情绪热度', sig.moodTemp, '越低越冷清', C, false));
  h.push(barRow_('杠杆压力', sig.pressure, '越高越危险', C, false));
  h.push(barRow_('红利吸引力', sig.redAttract, '越高越值得配', C, true));
  h.push('</td></tr></table>');
  h.push('<div style="font-size:12px;color:' + C.tx3 + ';margin-top:10px;background:' + C.line2 +
         ';border-radius:6px;padding:8px 10px;">算法：综合温度 = 估值热度×40% + 情绪热度×40% + 杠杆压力×20%。' +
         '估值热度 = 沪深300 市盈率的历史分位；情绪热度 = 偏股基金 3 年滚动年化（−10% 记 0 分、+30% 记 100 分）；' +
         '杠杆压力 = 距 227% 强平线的距离（贴线 100 分、60 点以外 0 分）。这只是把几个数压成一个便于对比的刻度，不是预测。</div>');
  h.push('</div>');

  // ---------- 四张卡 ----------
  h.push(sectionOpen_(C, '四个方向看机会', '绿灯=相对有利，黄灯=中性，红灯=相对危险。这里的「机会」指赔率，不是保证涨。'));
  var cards = [
    { k: '估值', color: C.blue, main: 'PE 分位 ' + sig.valPct + '%',
      sub: '沪深300 市盈率 ' + fmtNum_(sig.raw.pe, 2) + '，市赚率 ' + fmtNum_(sig.raw.pr, 2) +
           '。历史上只有 ' + Math.round(sig.valPct) + '% 的时间比现在更贵。',
      tail: sig.valPct < 30 ? '估值处在历史偏低区，跌下去的空间相对有限。'
                            : (sig.valPct > 70 ? '估值处在历史偏高区，别在这里追高。' : '估值不便宜也不贵，属于常态区间。') },
    { k: '情绪', color: C.pur, main: '三年年化 ' + fmtNum_(sig.raw.r3, 2) + '%',
      sub: '买偏股基金的人，过去三年平均每年赚这个数。这个指标有很强的均值回归特性。',
      tail: sig.raw.r3 < 0 ? '三年白干甚至亏损，历史上多出现在底部区域。'
                           : (sig.raw.r3 > 25 ? '三年收益很高，往后往往不好做。' : '三年收益正常，没有极端情绪。') },
    { k: '风险', color: C.up, main: '距强平线 ' + fmtNum_(sig.raw.gap227, 1) + ' 点',
      sub: '两融担保比例 ' + fmtNum_(sig.raw.ratio227, 1) + '%，历史分位 ' + fmtNum_(sig.raw.m14Pct, 1) + '%。跌到 227% 会被强制平仓。',
      tail: sig.raw.gap227 < 10 ? '已经贴近强平线，一点下跌就可能引发连锁平仓。'
                                : (sig.raw.gap227 > 50 ? '离强平线很远，杠杆端没有被动抛压。' : '有一定缓冲，但不算宽裕。') },
    { k: '红利', color: C.org, main: '风险溢价 ' + fmtNum_(sig.raw.spread, 2) + '点',
      sub: '中证红利股息率 ' + fmtNum_(sig.raw.dy, 2) + '% 减去 10 年国债 ' + fmtNum_(sig.raw.cn10y, 2) + '%。这是红利相对债券多给的现金回报。',
      tail: sig.raw.spread > 3 ? '红利相对债券明显划算，防守价值高。'
                               : (sig.raw.spread < 1.5 ? '红利相对债券吸引力一般。' : '红利有一定性价比，但不算极端。') }
  ];
  for (var ci = 0; ci < cards.length; ci++) {
    var cd = cards[ci];
    var lg = sig.lights[cd.k];
    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
           'style="margin-bottom:10px;background:' + C.card + ';border:1px solid ' + C.line + ';border-radius:8px;">');
    h.push('<tr>');
    h.push('<td style="padding:12px 14px;border-left:4px solid ' + cd.color + ';">');
    h.push('<div style="font-size:13px;font-weight:700;color:' + cd.color + ';">' + lg.dot + ' ' + cd.k +
           ' · ' + lg.text + '</div>');
    h.push('<div style="font-size:17px;font-weight:700;color:' + C.tx + ';margin:3px 0 4px;">' + esc_(cd.main) + '</div>');
    h.push('<div style="font-size:12.5px;color:' + C.tx2 + ';">' + esc_(cd.sub) + '</div>');
    h.push('<div style="font-size:12.5px;color:' + C.tx + ';margin-top:6px;padding-top:6px;border-top:1px dashed ' + C.line + ';">→ ' +
           esc_(cd.tail) + '</div>');
    h.push('</td></tr></table>');
  }
  h.push('</div>');

  // ---------- 宏观对照 ----------
  if (bundle.fred && (bundle.fred.DGS10 || bundle.fred.T10YIE)) {
    var us = bundle.fred.DGS10 ? bundle.fred.DGS10.value : null;
    h.push(sectionOpen_(C, '宏观对照：中美利率', '股票和债券比价的天平，一端的锚是国债利率。'));
    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">');
    h.push('<tr style="background:' + C.line2 + ';"><td style="padding:7px 10px;font-weight:700;">项目</td>' +
           '<td style="padding:7px 10px;font-weight:700;" align="right">数值</td>' +
           '<td style="padding:7px 10px;font-weight:700;" align="right">日期</td></tr>');
    if (us !== null) {
      h.push(tr3_('美债 10 年期（FRED 官方）', fmtNum_(us, 2) + '%', bundle.fred.DGS10.date));
    }
    if (bundle.fred.T10YIE) {
      h.push(tr3_('美债 10 年通胀预期（FRED）', fmtNum_(bundle.fred.T10YIE.value, 2) + '%', bundle.fred.T10YIE.date));
    }
    if (sig.raw.cn10y !== null) {
      h.push(tr3_('中债 10 年期（看板）', fmtNum_(sig.raw.cn10y, 2) + '%', '见 M2'));
    }
    if (us !== null && sig.raw.cn10y !== null) {
      var d = sig.raw.cn10y - us;
      h.push(tr3_('中美利差（中 − 美）', (d > 0 ? '+' : '') + fmtNum_(d, 2) + 'pt', '—'));
    }
    h.push('</table>');
    if (us !== null && sig.raw.cn10y !== null && sig.raw.cn10y - us < 0) {
      h.push('<div style="font-size:12.5px;color:' + C.tx2 + ';margin-top:8px;">→ 中国利率明显低于美国，' +
             '意味着「股票的盈利回报减去本国国债」这个差值更容易为正。这也是 M2 股债性价比现在读数不错的原因之一。' +
             '但利差为负同时会压制人民币汇率与外资流入意愿，两面看。</div>');
    }
    h.push('</div>');
  }

  // ---------- 明细 ----------
  h.push(sectionOpen_(C, '全部 20 个指标明细', '「数据截止」这一列一定要看：每个数据源发布节奏不同，不是同一天的数。'));
  for (var oi = 0; oi < GROUP_ORDER.length; oi++) {
    var grp = GROUP_ORDER[oi];
    var list = rows.filter(function (r) { return r.group === grp; });
    if (!list.length) continue;

    h.push('<div style="font-size:13.5px;font-weight:700;color:' + C.tx + ';margin:14px 0 6px;padding-left:8px;border-left:4px solid ' + C.blue + ';">' +
           esc_(grp) + '（' + list.length + '）</div>');
    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:12.5px;border-collapse:collapse;">');
    for (var ri = 0; ri < list.length; ri++) {
      var r = list[ri];
      var plain = PLAIN[r.code] || '';
      h.push('<tr>');
      h.push('<td style="padding:8px 6px 8px 0;border-bottom:1px solid ' + C.line + ';vertical-align:top;width:58%;">');
      h.push('<div style="font-weight:700;color:' + C.tx + ';">' + esc_(r.code) + '　' + esc_(r.name) + '</div>');
      if (plain) h.push('<div style="color:' + C.tx3 + ';font-size:11.5px;margin-top:2px;">' + esc_(plain) + '</div>');
      h.push('<div style="color:' + C.tx2 + ';font-size:11.5px;margin-top:2px;">怎么读：' + esc_(r.howto) + '</div>');
      h.push('</td>');
      h.push('<td style="padding:8px 0;border-bottom:1px solid ' + C.line + ';vertical-align:top;width:42%;" align="right">');
      h.push('<div style="color:' + C.tx + ';font-weight:600;font-size:12px;">' + esc_(r.reading) + '</div>');
      h.push('<div style="color:' + C.tx3 + ';font-size:11px;margin-top:3px;">数据截止 ' + esc_(r.asof) + '</div>');
      h.push('</td></tr>');
    }
    h.push('</table>');
  }
  h.push('</div>');

  // ---------- 交叉判读（动态判定）----------
  var combos = evalCombos_(sig);
  h.push(sectionOpen_(C, '两条经验规则（比单指标可靠）', '单个指标几乎一定会骗人，要几个方向同向才有意义。下面按今天真实数据逐条判定。'));
  h.push('<div style="font-size:12.5px;color:' + C.tx2 + ';line-height:1.7;margin-bottom:8px;">' +
         '说明：下面两条是「历史结构识别」规则。每条由几腿组成，<b>全部命中</b>才说明该结构当前成立；' +
         '只要有一腿没中，就只是「接近」而非「触发」。每腿右侧是今天真实数值。</div>');
  h.push(comboHtml_('危险组合', '「钱挤在少数票里」叠加「杠杆已经绷紧」。2015 年 6 月、2021 年 2 月都是这个结构。',
                    combos.danger, '#fef2f2', C.up, C));
  h.push(comboHtml_('底部组合', '估值、情绪、杠杆三个方向同时指向冰点——机会大，但可能还要熬很久。',
                    combos.bottom, '#ecfdf5', C.down, C));
  h.push('</div>');

  // ---------- 页脚 ----------
  h.push('<div style="margin-top:16px;padding:14px 16px;background:#eef1f5;border-radius:8px;font-size:11.5px;color:' + C.tx3 + ';line-height:1.7;">');
  h.push('<div style="margin-bottom:5px;">📊 <a href="' + CONFIG.URL_SITE + '" style="color:' + C.blue + ';text-decoration:none;">看板主页（图表版）</a>　|　' +
         '<a href="' + CONFIG.URL_TEXT + '" style="color:' + C.blue + ';text-decoration:none;">llms.txt（本邮件数据来源）</a>　|　' +
         '<a href="' + CONFIG.URL_JSON + '" style="color:' + C.blue + ';text-decoration:none;">latest.json</a></div>');
  h.push('<div>⚠️ 本邮件由程序自动生成，仅为公开图表模型的复现与数据观察，<b>不构成任何投资建议</b>。' +
         '历史分位基于有限样本，部分指标存在口径替代（如用价格指数替代全收益指数，年化约低估 2%）。' +
         'AI 解读部分可能存在错误，请以原始数值为准。</div>');
  h.push('<div style="margin-top:6px;">原始模型版权归《EarlETF 图表周刊》作者张翼轸所有。</div>');
  h.push('</div>');

  h.push('</div></div>');
  return h.join('');
}

/**
 * 把一条经验组合按当前数据逐腿判定，返回是否触发 + 每腿状态。
 * 这一步是修复「底部组合写 M4 为负、但实际 M4=+5%」呈现冲突的关键：
 * 不再写死"M4 为负"，而是实时算出 M4 是否真为负，并在邮件里逐腿打勾叉。
 */
function evalCombos_(sig) {
  var r = sig.raw;
  // 危险组合：M13 集中度高（分位>80%）+ M14 担保比例贴近 227%
  var danger = [
    { name: 'M13 交易集中度分位 > 80%', ok: (r.concPct !== null && r.concPct > 80),
      val: (r.concPct === null ? '—' : fmtNum_(r.concPct, 1) + '%') },
    { name: 'M14 距 227% 强平线 < 10pt', ok: (r.gap227 !== null && r.gap227 < 10),
      val: (r.gap227 === null ? '—' : '+' + fmtNum_(r.gap227, 1) + 'pt') }
  ];
  // 底部组合：M2 估值便宜（PE分位<35%）+ M4 三年滚动年化<0 + M14 贴 227%
  // 注：M4 的"怎么读"是"落到 0 附近或为负 = 底部区"，这里取更严格的"<0"，
  //     与规则原文"M4 三年滚动年化为负"保持一致；接近 0 但为正时不判为触发。
  var bottom = [
    { name: 'M2 估值便宜（PE分位<35%）', ok: (sig.valPct !== null && sig.valPct < 35),
      val: (sig.valPct === null ? '—' : fmtNum_(sig.valPct, 1) + '%') },
    { name: 'M4 三年滚动年化 < 0', ok: (r.r3 !== null && r.r3 < 0),
      val: (r.r3 === null ? '—' : (r.r3 >= 0 ? '+' : '') + fmtNum_(r.r3, 2) + '%') },
    { name: 'M14 距 227% 强平线 < 10pt', ok: (r.gap227 !== null && r.gap227 < 10),
      val: (r.gap227 === null ? '—' : '+' + fmtNum_(r.gap227, 1) + 'pt') }
  ];
  function pack(legs) {
    var hits = 0;
    for (var i = 0; i < legs.length; i++) if (legs[i].ok) hits++;
    return { hits: hits, total: legs.length, legs: legs, active: hits === legs.length };
  }
  return { danger: pack(danger), bottom: pack(bottom) };
}

/** 渲染一条组合的判定卡（含每腿 ✓/✗ 与当前是否触发） */
function comboHtml_(title, desc, combo, bg, accent, C) {
  var verdict = combo.active
    ? '<span style="color:#0f9960;font-weight:700;">✅ 当前触发</span>'
    : '<span style="color:#b45309;font-weight:700;">○ 当前未触发（' + combo.hits + '/' + combo.total + ' 条件满足）</span>';
  var html = '<div style="padding:10px 13px;background:' + bg + ';border-radius:8px;margin-bottom:10px;">';
  html += '<div style="font-size:13.5px;font-weight:700;color:' + accent + ';">' + esc_(title) +
          '　' + verdict + '</div>';
  html += '<div style="font-size:12px;color:' + C.tx2 + ';margin:3px 0 7px;">' + esc_(desc) + '</div>';
  for (var i = 0; i < combo.legs.length; i++) {
    var leg = combo.legs[i];
    var mark = leg.ok ? '<span style="color:#0f9960;font-weight:700;">✓</span>'
                      : '<span style="color:#b45309;font-weight:700;">✗</span>';
    html += '<div style="font-size:12.5px;color:' + C.tx + ';padding:4px 0;border-top:1px dashed ' + C.line + ';">' +
            mark + ' ' + esc_(leg.name) +
            '　<span style="color:' + C.tx3 + ';">当前 ' + esc_(leg.val) + '</span></div>';
  }
  html += '</div>';
  return html;
}

/**
 * 「AI 总结」栏 —— 放在邮件正文第一屏。
 * 有 AI 就用 AI；AI 不可用则用规则版，并在下方小字说明原因与修法。
 * 无论哪种情况，这一栏一定存在，不会再出现「什么都没有」。
 */
function aiSummaryHtml_(bundle, sig, C) {
  var ai = bundle.ai || { ok: false, lines: null, model: '', error: '未调用' };
  var rule = bundle.rule || {};
  var isAI = !!(ai.ok && ai.lines && ai.lines.length);

  var map = {};
  if (isAI) {
    for (var i = 0; i < ai.lines.length; i++) map[ai.lines[i].label] = ai.lines[i].text;
  }
  function get(k) {
    var v = isAI ? map[k] : rule[k];
    return v || '';
  }

  var oneline = get('一句话') || (sig.label + '，综合温度 ' + sig.composite + '/100。');
  var body = get('总结');
  var advice = get('建议');
  var dims = ['估值', '情绪', '风险', '红利'];

  var title = isAI ? '🧠 AI 总结' : '🧠 今日总结';
  var badge = isAI
    ? '<span style="display:inline-block;background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px;vertical-align:middle;">AI 生成 · ' + esc_(ai.model) + '</span>'
    : '<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px;vertical-align:middle;">规则生成 · AI 未启用</span>';

  var h = [];
  h.push('<div style="background:' + C.card + ';border:1px solid ' + C.line +
         ';border-left:4px solid #7c3aed;border-radius:10px;padding:16px;margin-top:12px;">');

  // 标题行
  h.push('<div style="font-size:16px;font-weight:700;color:' + C.tx + ';">' + title +
         '　' + badge + '</div>');

  // 一句话（最醒目）
  h.push('<div style="margin-top:10px;padding:11px 14px;background:#f5f3ff;border-radius:8px;font-size:14.5px;font-weight:600;color:#4c1d95;line-height:1.6;">' +
         esc_(oneline) + '</div>');

  // 总结正文
  if (body) {
    h.push('<div style="margin-top:10px;font-size:13.5px;line-height:1.85;color:' + C.tx + ';">' + esc_(body) + '</div>');
  }

  // 四个维度
  var anyDim = false;
  for (var d = 0; d < dims.length; d++) if (get(dims[d])) anyDim = true;
  if (anyDim) {
    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:11px;font-size:12.5px;border-top:1px solid ' + C.line + ';">');
    for (var d2 = 0; d2 < dims.length; d2++) {
      var txt = get(dims[d2]);
      if (!txt) continue;
      var lg = sig.lights[dims[d2]];
      var dot = lg ? lg.dot : '·';
      h.push('<tr>');
      h.push('<td width="58" valign="top" style="padding:7px 0;border-bottom:1px solid ' + C.line2 +
             ';font-weight:700;color:' + C.tx2 + ';white-space:nowrap;">' + dot + ' ' + esc_(dims[d2]) + '</td>');
      h.push('<td valign="top" style="padding:7px 0;border-bottom:1px solid ' + C.line2 + ';color:' + C.tx + ';">' + esc_(txt) + '</td>');
      h.push('</tr>');
    }
    h.push('</table>');
  }

  // 建议
  if (advice) {
    h.push('<div style="margin-top:11px;padding:10px 13px;background:#eff6ff;border-radius:8px;border-left:3px solid ' + C.blue + ';">');
    h.push('<div style="font-size:11.5px;font-weight:700;color:' + C.blue + ';letter-spacing:.5px;">如果只能做一件事</div>');
    h.push('<div style="font-size:13px;color:' + C.tx + ';margin-top:2px;">' + esc_(advice) + '</div>');
    h.push('</div>');
  }

  // 降级说明
  if (!isAI) {
    h.push('<div style="margin-top:11px;padding:9px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:7px;font-size:11.5px;color:#991b1b;line-height:1.7;">');
    h.push('<div style="font-weight:700;">本次 AI 没有生成内容，以上为程序按固定规则拼出的总结（结论来自同一批数字，只是措辞不如 AI 自然）。</div>');
    h.push('<div style="margin-top:4px;word-break:break-all;">原因：' + esc_(ai.error || '未知') + '</div>');
    h.push('<div style="margin-top:4px;color:#b45309;">排查：① 打开 script.google.com 里本项目的「执行记录」看日志；' +
           '② 运行 testConnections() 单独测 Gemini；③ 确认密钥有效、模型已在 AI Studio 启用、未超免费配额。</div>');
    h.push('</div>');
  } else {
    h.push('<div style="margin-top:10px;font-size:11px;color:' + C.tx3 + ';">以上由大模型基于本邮件全部数据生成，仅供理解，不构成投资建议；如与上方原始数值冲突，以原始数值为准。</div>');
  }

  h.push('</div>');
  return h.join('');
}

function sectionOpen_(C, title, sub) {
  return '<div style="background:' + C.card + ';border:1px solid ' + C.line +
         ';border-radius:10px;padding:16px;margin-top:12px;">' +
         '<div style="font-size:15px;font-weight:700;color:' + C.tx + ';">' + esc_(title) + '</div>' +
         (sub ? '<div style="font-size:12px;color:' + C.tx3 + ';margin:3px 0 12px;">' + esc_(sub) + '</div>' : '<div style="height:10px;"></div>');
}

/**
 * 一根进度条。
 * goodWhenHigh=false 时「数值高=坏」（热度/压力），高→红；
 * goodWhenHigh=true  时「数值高=好」（吸引力），高→绿。
 */
function barRow_(label, val, hint, C, goodWhenHigh) {
  var w = Math.max(2, Math.min(100, Math.round(val)));
  var hot = val >= 70 ? '#d13a34' : (val >= 45 ? '#ea8b1f' : '#0f9960');
  var cool = val >= 70 ? '#0f9960' : (val >= 45 ? '#8fbf3f' : '#a8cc6a');
  var color = goodWhenHigh ? cool : hot;
  return '<div style="margin-bottom:8px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
    '<td style="font-size:12px;color:#5b6472;">' + esc_(label) + '　<span style="color:#aab3c0;font-size:11px;">' + esc_(hint) + '</span></td>' +
    '<td align="right" style="font-size:12px;font-weight:700;color:' + color + ';">' + Math.round(val) + '</td>' +
    '</tr></table>' +
    '<div style="background:#e9edf2;border-radius:4px;height:7px;margin-top:3px;overflow:hidden;">' +
    '<div style="background:' + color + ';height:7px;width:' + w + '%;"></div></div>' +
    '</div>';
}

function tr3_(a, b, c) {
  return '<tr><td style="padding:7px 10px;border-bottom:1px solid #eee;">' + esc_(a) + '</td>' +
         '<td style="padding:7px 10px;border-bottom:1px solid #eee;font-weight:700;" align="right">' + esc_(b) + '</td>' +
         '<td style="padding:7px 10px;border-bottom:1px solid #eee;color:#8b95a3;" align="right">' + esc_(c) + '</td></tr>';
}

// ============================================================
// 9. 纯文本兜底正文
// ============================================================
function plainFallback_(rows, sig, updated, bundle) {
  var L = [];
  L.push('A 股指标看板 · 每日解读');
  L.push('数据生成：' + (updated || '—'));
  L.push('综合温度：' + sig.composite + '/100（' + sig.label + '）');
  L.push('');
  // AI 总结（纯文本版，与 HTML 里第一栏一致）
  var ai = (bundle && bundle.ai) || { ok: false, lines: null, error: '' };
  var rule = (bundle && bundle.rule) || {};
  var isAI = !!(ai.ok && ai.lines && ai.lines.length);
  var map = {};
  if (isAI) for (var a = 0; a < ai.lines.length; a++) map[ai.lines[a].label] = ai.lines[a].text;
  function g(k) { return (isAI ? map[k] : rule[k]) || ''; }
  L.push('【' + (isAI ? 'AI 总结（' + ai.model + '）' : '今日总结（规则生成，AI 未启用）') + '】');
  if (g('一句话')) L.push('· ' + g('一句话'));
  if (g('总结')) L.push(g('总结'));
  ['估值', '情绪', '风险', '红利'].forEach(function (k) {
    if (g(k)) L.push('· ' + k + '：' + g(k));
  });
  if (g('建议')) L.push('· 建议：' + g('建议'));
  if (!isAI && ai.error) L.push('（AI 失败原因：' + ai.error + '）');
  L.push('');
  for (var i = 0; i < rows.length; i++) {
    L.push(rows[i].code + ' ' + rows[i].name + '：' + rows[i].reading + '（' + rows[i].asof + '）');
  }
  L.push('');
  L.push('详见 ' + CONFIG.URL_SITE);
  L.push('本邮件自动生成，不构成投资建议。');
  return L.join('\n');
}

// ============================================================
// 10. 工具函数
// ============================================================
function log_(m) { console.log(m); }

function fmt_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'); }

function num_(v, dflt) {
  var n = parseFloat(v);
  return isFinite(n) ? n : dflt;
}

function clamp_(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function fmtNum_(v, nd) {
  if (v === null || v === undefined || !isFinite(parseFloat(v))) return '—';
  return parseFloat(v).toFixed(nd);
}

function esc_(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function daysBetween_(a, b) {
  try { return Math.floor((new Date(b) - new Date(a)) / 86400000); } catch (e) { return 0; }
}

function isWeekend_() {
  var wd = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'u'); // 1=Mon..7=Sun
  return wd === '6' || wd === '7';
}

function weekdayCn_(d) {
  var map = { '1': '周一', '2': '周二', '3': '周三', '4': '周四', '5': '周五', '6': '周六', '7': '周日' };
  return map[Utilities.formatDate(d, CONFIG.TIMEZONE, 'u')] || '';
}

function sendError_(title, detail) {
  log_('ERROR: ' + title + ' | ' + detail);
  try {
    MailApp.sendEmail({
      to: CONFIG.RECEIVER_EMAIL,
      subject: '【A股每日解读·失败】' + title,
      body: title + '\n\n' + detail + '\n\n时间：' + fmt_(new Date()) +
            '\n\n排查看这里：脚本编辑器左侧「执行记录」，点开最近一次看日志。',
      name: 'A股指标看板'
    });
  } catch (e) { log_('连告警邮件都发不出去：' + e); }
}

/** 数据连续 3 次没推进，发一封提醒，避免"悄无声息地坏掉" */
function sendStale_(asof, today) {
  try {
    MailApp.sendEmail({
      to: CONFIG.RECEIVER_EMAIL,
      subject: '【A股每日解读·数据卡住提醒】数据日停在 ' + asof,
      body: '已经连续 3 次定时运行，看板的数据日仍是 ' + asof + '（今天 ' + today + '）。\n' +
            '可能是 GitHub 定时任务没跑、或数据源（中证/Wind）延迟发布。\n' +
            '本邮件仅为提醒，期间没有重复发送解读邮件。\n\n' +
            '排查：打开 ' + CONFIG.URL_SITE + ' 看页面是否更新；或运行 testConnections()。',
      name: 'A股指标看板'
    });
    log_('已发送「数据卡住」提醒（数据日停在 ' + asof + '）');
  } catch (e) { log_('提醒邮件也发不出：' + e); }
}

// ============================================================
// 11. 手动测试 / 安装定时器（各运行一次即可）
// ============================================================

/** ① 体检：测三个接口是否可用 */
function testConnections() {
  log_('—— 1/3 看板数据源 ——');
  var j = fetchJson_();
  var t = fetchText_();
  log_('   latest.json ' + (j ? '✅ ' + Object.keys(j.modules).length + ' 个模块' : '❌ 失败'));
  log_('   llms.txt    ' + (t ? '✅ ' + t.length + ' 字符 / ' + parseLlmsTxt_(t).length + ' 个指标' : '❌ 失败'));

  log_('—— 2/3 FRED 美债 ——');
  if (!fredKey_()) {
    log_('   ⚠️ 还没设置 FRED 密钥（运行 setFredKey(\'你的密钥\')）。「宏观对照」小节会跳过。');
  } else {
    var f = fetchFred_();
    log_('   ' + (f ? '✅ ' + JSON.stringify(f) : '❌ 失败'));
  }

  log_('—— 3/3 Gemini ——');
  if (!geminiKey_()) {
    log_('   ⚠️ 还没设置 Gemini 密钥（运行 setGeminiKey(\'你的密钥\')）。邮件会用规则版总结。');
  } else if (!CONFIG.WITH_GEMINI) {
    log_('   已关闭（WITH_GEMINI=false），邮件里会用规则生成的总结');
  } else {
    var sig = buildSignals_((j && j.modules) || {});
    var g = askGemini_(t, sig, null, (j && j.updated) || '', Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'));
    if (g.ok) {
      log_('   ✅ 成功（' + g.model + '），返回 ' + g.lines.length + ' 行：');
      for (var i = 0; i < g.lines.length; i++) log_('      ' + g.lines[i].label + '：' + g.lines[i].text);
    } else {
      log_('   ❌ 全部模型都失败。逐条原因：');
      log_('      ' + g.error);
      log_('   对照：400 密钥无效 / 403 无权或未启用 API / 404 模型名不存在 / 429 超配额');
    }
  }

  log_('—— 邮件配额 ——');
  log_('   今天还能发 ' + MailApp.getRemainingDailyQuota() + ' 封');
  log_('   脚本时区 ' + Session.getScriptTimeZone() + '（定时器另行指定 ' + CONFIG.TIMEZONE + '，不受此影响）');
}

/** ② 立刻发一封看效果（不装定时器） */
function previewNow() {
  log_('预览模式：立刻生成并发送一封（忽略周末与「数据未变」检查）');
  FORCE_ = true;
  try {
    dailyMain();
  } finally {
    FORCE_ = false;
  }
}

/** ③ 装定时器：每天 19:15（北京）自动跑 */
function installDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('dailyMain')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.TRIGGER_HOUR)
    .nearMinute(CONFIG.TRIGGER_MINUTE)
    .inTimezone(CONFIG.TIMEZONE)
    .create();
  log_('✅ 已安装：每天 ' + CONFIG.TRIGGER_HOUR + ':' + ('0' + CONFIG.TRIGGER_MINUTE).slice(-2) +
       '（' + CONFIG.TIMEZONE + '）自动运行 dailyMain');
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) log_('   现有定时器：' + ts[i].getHandlerFunction());
}

/** 停掉全部定时器 */
function removeTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) ScriptApp.deleteTrigger(ts[i]);
  log_('已删除 ' + ts.length + ' 个定时器');
}

/** ④ 只看邮件长什么样，不发信（想调样式时用） */
function showHtml() {
  var j = fetchJson_();
  var t = fetchText_();
  var rows = parseLlmsTxt_(t || '');
  var sig = buildSignals_((j && j.modules) || {});
  var bundle = {
    json: j, text: t, fred: null, warn: [],
    ai: { ok: false, lines: null, model: '', error: 'showHtml() 里不调用 AI，用规则总结演示' },
    rule: buildRuleSummary_(sig, rows)
  };
  var html = buildHtml_(rows, (j && j.modules) || {}, sig, bundle);
  log_('HTML 长度 ' + html.length);
  log_(html);
}

/**
 * ⑤ 问 Google：这把 Gemini 密钥到底能用哪些模型
 * 列不出来时，会区分「密钥被作废（reported as leaked）」和「没开 API」两种完全不同的原因。
 */
function listGeminiModels() {
  log_('=== 问 Google：这把密钥能用哪些模型 ===');
  var k = geminiKey_();
  log_('密钥指纹：' + keyFp_(k));

  if (!k) {
    log_('');
    log_('❌ 还没设置密钥。先运行一次（把里面的字替换成你的密钥）：');
    log_("     setGeminiKey('AIza...你的密钥...')");
    log_('   密钥申请：https://aistudio.google.com/apikey');
    log_('   设置一次就永久生效，存在「项目设置 → 脚本属性」里，不会随代码走。');
    return;
  }

  var all = fetchModelList_();
  if (!all.length) {
    log_('');
    // 先判断是不是「密钥被判泄露」，这种情况改配置是没用的
    if (/reported as leaked|leaked/i.test(LAST_GEMINI_.msg || '')) {
      log_('⛔ 这把密钥已被 Google 判定为「泄露」并永久作废 —— 不是配置问题，改什么都没用。');
      log_('');
      log_('   原因：密钥出现在公开可访问的地方（例如被提交进公开的 GitHub 仓库、');
      log_('        粘贴到公开网页），Google 的自动化扫描器扫到后直接封禁。');
      log_('   处理（3 步，2 分钟）：');
      log_('     1. 打开 https://aistudio.google.com/apikey');
      log_('     2. 「Create API key」→ 选择一个项目（或新建）→ 复制新密钥');
      log_('     3. 回到编辑器，临时写一行并运行：');
      log_("          setGeminiKey('刚复制的新密钥')");
      log_('        然后把这行删掉，再跑一次 listGeminiModels() 验证。');
      log_('');
      log_('   以后不会再犯：本脚本已改成从「脚本属性」读密钥，代码里是空的，');
      log_('   提交到仓库也不会带出任何密钥。');
      return;
    }
    log_('❌ 一个模型都列不出来。这通常意味着下面三种情况之一：');
    log_('   1. 密钥所属的 Cloud 项目没启用 Generative Language API');
    log_('      → https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com');
    log_('   2. 密钥设了 API 限制，把 Generative Language API 挡在外面');
    log_('      → https://console.cloud.google.com/apis/credentials');
    log_('   3. 密钥本身无效或已过期 → https://aistudio.google.com/apikey 重新生成');
    log_('');
    log_('   修好之后重跑一次本函数，能列出模型就说明通了。');
    return;
  }

  log_('');
  log_('✅ 共 ' + all.length + ' 个模型。下面只列「能做对话/写作」的（支持 generateContent）：');
  var chat = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].canChat) chat.push(all[i]);
  }
  if (!chat.length) {
    log_('   （没有）这把密钥下没有对话模型，只有向量化/图像之类的。');
    return;
  }
  for (var j = 0; j < chat.length; j++) {
    var m = chat[j];
    var tag = /image/i.test(m.name) ? '　（图像生成，不参与推荐）' : '';
    log_('   · ' + m.name +
         (m.display ? '　[' + m.display + ']' : '') +
         (m.output ? '　输出上限 ' + Math.round(m.output / 1000) + 'k' : '') + tag);
  }

  var rec = discoverModels_(all);
  log_('');
  log_('按「便宜快 + 版本新」排序，推荐顺序：');
  for (var k = 0; k < Math.min(rec.length, 6); k++) log_('   ' + (k + 1) + '. ' + rec[k]);
  log_('');
  log_('说明：脚本已经会自动发现，正常情况下不用手改 —— 这一步只是让你看清楚现状。');
  log_('写进 CONFIG 的好处是省掉每次失败的探测请求。');
}
