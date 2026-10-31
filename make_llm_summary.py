# -*- coding: utf-8 -*-
"""
从 data.json 生成「给 AI 读」的纯文本摘要。

产出三个文件（都放在仓库根目录，随每日构建一起提交）：
  llms.txt      —— 站点说明 + 当日数据快照，AI 抓取入口（llms.txt 约定名）
  snapshot.md   —— 同上内容的 Markdown 版，方便直接粘贴到大模型对话框
  latest.json   —— 只含各指标当前读数与截止日，约 3KB（data.json 是 2.2MB，多数 AI 抓不动）

用法：
  python make_llm_summary.py                    # 读 data.json，写三个文件
  python make_llm_summary.py --check            # 只打印，不写文件
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = 'https://wj624.github.io/earl-etf-dashboard'

# 编号 -> (名称, 分组, 判读口径一句话)
META = {
    'm1':   ('五年之锚（万得全A）', '估值', '偏离五年均线 >+15% 暂停定投；≈0 或为负属低位'),
    'm1b':  ('五年之锚·原文口径', '估值', '收盘价跌破 MA×0.8 才是原文定义的抄底区'),
    'm2':   ('股债性价比', '估值', '盈利收益率减 10Y 国债，差值越高股票越划算（月频）'),
    'm12':  ('沪深300 估值一图看全', '估值', '股价跌 + PE 不高 + PR<1 三者同现才算便宜（月频）'),
    'm3':   ('韭圈儿神奇指标', '情绪', '股票全收益线逼近偏债线 = 历史级底部信号'),
    'm3b':  ('韭圈儿·基金净值口径', '情绪', '同上，债券腿换成真实基金净值'),
    'm4':   ('偏股基金 3 年滚动年化', '情绪', '落到 0 附近或为负 = 历史级底部区域'),
    'm5':   ('顶部共振·一级债基', '情绪', '偏股/债基比值逼近 1.0 = 顶部共振，看形态不看分位'),
    'm5b':  ('顶部共振·易方达增强回报', '情绪', '同上，债券腿为真实基金，起点更晚'),
    'm6a':  ('三棱镜·300成长/价值', '风格', '40 日收益差穿越零轴 = 风格切换信号'),
    'm6b':  ('三棱镜·1000成长/价值', '风格', '同上，小盘成长 vs 小盘价值'),
    'm6c':  ('三棱镜·沪深300/中证1000', '风格', '同上，本质是大小盘而非成长价值'),
    'm7':   ('三棱镜·国证成长/价值', '风格', '全市场口径的风格钟摆，历史最长'),
    'm8':   ('红利股息率', '红利', '股息率越高越便宜；风险溢价越大，红利相对国债越有吸引力'),
    'm9':   ('红利 40 日收益差', '红利', '大幅为正 = 防守占优；>+14 属短期已充分反映'),
    'm10':  ('红利回归·价格指数', '红利', '看 Z 值不看点位；Z<-2 跌破通道下沿'),
    'm10b': ('红利回归·全收益指数', '红利', '以这条为准，含分红再投，不低估约 2%/年'),
    'm11':  ('红利 AH 40 日收益差', '红利', '为正 = A 股跑赢，境内资金更积极'),
    'm13':  ('交易集中度', '风险', '分位>80% 且接近 45% 警戒线 = 抱团紧，瓦解时更惨'),
    'm14':  ('融资盘担保比例', '风险', '距 227% 强平线越近越危险；分位低反而是好事'),
}

ORDER = ['m1', 'm1b', 'm2', 'm12', 'm3', 'm3b', 'm4', 'm5', 'm5b',
         'm6a', 'm6b', 'm6c', 'm7', 'm13', 'm14', 'm8', 'm9', 'm10', 'm10b', 'm11']


def pct(x, nd=2, sign=True):
    if x is None:
        return '—'
    s = f'{x:+.{nd}f}%' if sign else f'{x:.{nd}f}%'
    return s


def num(x, nd=2):
    if x is None:
        return '—'
    return f'{x:,.{nd}f}'


def reading(code, c):
    """把一个模块的 cur 字典压成一行人类可读读数。"""
    if code == 'm1':
        return (f"偏离五年均线 {pct(c['dev'])}，10 年分位 {c['pct10']:.1f}%；"
                f"收盘 {num(c['close'])}，五年均线 {num(c['ma1250'])}")
    if code == 'm1b':
        return (f"收盘 {num(c['close'])}，五年均线 {num(c['ma1250'])}，"
                f"抄底线 MA×0.8 = {num(c['ma20'])}；当前偏离均线 {pct(c['dev'])}，"
                f"距抄底线 {pct(c['dev_ma20'], 1)}")
    if code == 'm2':
        spread_cn = c['ey_cn'] - c['cn10y']
        spread_us = c['ey_us'] - c['us10y']
        return (f"沪深300 PE(TTM) {c['pe']}，盈利收益率 {c['ey_cn']:.2f}% − 10Y国债 "
                f"{c['cn10y']}% = 中国股债性价比 {spread_cn:+.2f}pt；"
                f"美股口径 {c['ey_us']:.2f}% − {c['us10y']}% = {spread_us:+.2f}pt；"
                f"ROE≈{c['roe']*100:.1f}%，市赚率 PR {c['pr']}")
    if code == 'm12':
        return (f"沪深300 {num(c['hs300'])}；PE {c['pe']}（分位 {c['pe_pct']:.1f}%）；"
                f"市赚率 PR {c['pr']}（分位 {c['pr_pct']:.1f}%）；ROE≈{c['roe']*100:.1f}%")
    if code == 'm3':
        return (f"归一值：沪深300全收益 {num(c['hs300'])} / 偏债混合 {num(c['syn'])}；"
                f"比值 {c['ratio']}，股票线领先 {pct(c['dev'])}")
    if code == 'm3b':
        gap = c['eq'] / c['dm'] - 1
        return (f"净值：股票基金 {num(c['eq'])} / 偏债基金 {num(c['dm'])}；股票腿落后 {gap*100:+.1f}%")
    if code == 'm4':
        return f"偏股基金指数 3 年滚动年化 {pct(c['r3'])}"
    if code in ('m5', 'm5b'):
        who = '一级债基' if code == 'm5' else '易方达增强回报'
        return (f"偏股基金 / {who} 比值 {c['ratio']}（历史顶 {c['rmax']} @{c['rmaxd']}，"
                f"历史底 {c['rmin']} @{c['rmind']}）；距历史顶还有 {c['gap']:.1f}%")
    if code in ('m6a', 'm6b', 'm6c', 'm7'):
        lab = {'m6a': '300成长/300价值', 'm6b': '1000成长/1000价值',
               'm6c': '沪深300/中证1000', 'm7': '国证成长/国证价值'}[code]
        pos = ''
        if c['ratio'] < c['boll_dn']:
            pos = '，已跌破布林下轨'
        elif c['ratio'] > c['boll_up']:
            pos = '，已突破布林上轨'
        else:
            pos = '，布林通道内'
        return (f"{lab} 比值 {c['ratio']}（下轨 {c['boll_dn']} / 中轨 {c['boll_mid']} / "
                f"上轨 {c['boll_up']}）{pos}；40 日收益差 {c['d40']:+.2f}pt，"
                f"其均线 {c['d40ma']:+.4f}")
    if code == 'm8':
        return (f"中证红利股息率 {c['dy']}%，10Y国债 {c['cn10y']}%，"
                f"风险溢价 {c['spread']}pt；上证红利长周期估算股息率 {c['dy_long']:.2f}%")
    if code in ('m9', 'm11'):
        who = '红利 vs 宽基' if code == 'm9' else '红利 A 股 vs H 股'
        return f"{who} 40 日收益差 {c['d40']:+.2f}pt，其均线 {c['d40ma']:+.2f}pt"
    if code in ('m10', 'm10b'):
        kind = '价格指数 000922' if code == 'm10' else '全收益指数 H00922'
        return (f"{kind}：点位 {num(c['close'])}，趋势线 {num(c['fit'])}，"
                f"上轨 {num(c['up'])} / 下轨 {num(c['dn'])}，长期年化 {c['ann']}%，Z 值 {c['z']:+.2f}")
    if code == 'm13':
        return (f"成交额前 N 名占比 {c['ratio']}%，历史分位 {c['pct']}%，"
                f"警戒线 {c['warn']}%；口径：{c['method']}")
    if code == 'm14':
        return (f"担保比例 {c['ratio']}%，距 227% 强平线 {c['gap227']:+.1f}pt，"
                f"历史分位 {c['pct']}%；历史低点 {c['low']}% @{c['lowd']}，"
                f"高点 {c['high']}% @{c['highd']}；"
                f"历史上破 227% 共 {c['below_days']} 天 / {c['below_rounds']} 轮")
    return '—'


def build(d):
    mods = d['modules']
    asof = d.get('asof') or {}
    updated = d.get('updated', '')
    latest = d.get('latest', '')

    lines = []
    A = lines.append

    A('# EarlETF 图表周刊 · 指标看板 —— 数据快照')
    A('')
    A(f'> 生成时间：{updated}（北京时间）　最新行情日：{latest}')
    A(f'> 在线看板：{BASE}/')
    A(f'> 机器可读全量数据：{BASE}/data.json')
    A('')
    A('## 这是什么')
    A('')
    A('一个复现《EarlETF 图表周刊》（作者：张翼轸）图表模型的 A 股指标看板。')
    A('共 20 个指标，覆盖四条线：**估值**（贵不贵）、**情绪**（热不热）、')
    A('**风格**（成长还是价值/大盘还是小盘）、**红利**（防守资产位置）、**风险**（杠杆与抱团）。')
    A('每日 18:30 北京时间自动更新。')
    A('')
    A('## 怎么用这份数据')
    A('')
    A('1. **先看分位，不看绝对值**。分位 = 当前值在历史样本中的排名位置。')
    A('   「85% 分位」= 历史上只有 15% 的时间比现在更高。')
    A('2. **三个方向同向才下结论**：估值 + 情绪 + 风险。单看一个指标一定会骗人。')
    A('3. **每个指标的截止日不同**（见下表「数据截止」列）。中证官网、Wind、AkShare')
    A('   发布节奏不同，不要假设所有数字都是同一天。')
    A('4. **口径替代**：无公开日频源的指标做了替代（如万得全A 用价格指数而非全收益，')
    A('   偏离度会系统性偏低约 2%/年；红利长周期股息率为反推估算）。')
    A('')
    A('## 当日读数')
    A('')

    for grp in ['估值', '情绪', '风格', '红利', '风险']:
        codes = [c for c in ORDER if META[c][1] == grp]
        if not codes:
            continue
        A(f'### {grp}')
        A('')
        A('| 编号 | 指标 | 当前读数 | 数据截止 | 怎么读 |')
        A('|---|---|---|---|---|')
        for code in codes:
            m = mods.get(code) or {}
            c = m.get('cur') or {}
            if not c:
                continue
            name = META[code][0]
            try:
                rd = reading(code, c)
            except Exception as e:  # 字段缺失时降级，不要让整份摘要挂掉
                rd = f'（读取失败：{e}）' + json.dumps(c, ensure_ascii=False)[:120]
            dt = asof.get(code) or c.get('date') or '—'
            rule = META[code][2]
            A(f'| {code.upper()} | {name} | {rd} | {dt} | {rule} |')
        A('')

    # 滞后的指标单独提示，避免 AI 把旧值当最新
    stale = d.get('stale') or {}
    if stale:
        A('## 数据滞后提示')
        A('')
        A('以下指标当日未能拿到最新值，沿用最近可得数据：')
        A('')
        for k, v in stale.items():
            nm = META.get(k, (k,))[0]
            A(f'- {k.upper()} {nm}：{v}')
        A('')

    A('## 交叉判读（比单指标可靠）')
    A('')
    A('- **危险组合**：M13 集中度高（分位>80%）+ M14 担保比例贴近 227%')
    A('  = 抱团瓦解叠加去杠杆，对应 2015-06 / 2021-02 的结构。')
    A('- **底部组合**：M2 股债性价比分位高 + M4 三年滚动年化为负 + M14 贴 227%')
    A('  = 估值、情绪、杠杆三个方向同时指向冰点。')
    A('- **风格切换**：M6a/M6b/M6c/M7 的 40 日收益差穿越零轴，且布林带同向确认。')
    A('- **防守切换**：M9 红利 40 日收益差由负转正且上穿其均线。')
    A('')
    A('## 名词速查')
    A('')
    A('| 名词 | 含义 |')
    A('|---|---|')
    for k, v in [
        ('PE(TTM)', '市盈率 = 股价 ÷ 最近 12 个月每股盈利，越低越便宜'),
        ('PB', '市净率 = 股价 ÷ 每股净资产'),
        ('ROE', '净资产收益率 = 净利润 ÷ 净资产'),
        ('盈利收益率', '= 1 ÷ PE，可直接与债券利率比较'),
        ('股息率', '每股分红 ÷ 股价，红利策略核心指标'),
        ('风险溢价', '股息率 − 10 年期国债收益率'),
        ('市赚率 PR', '= PE ÷ (ROE×100)，PR<1 通常视为低估'),
        ('滚动年化', '把过去 N 年累计收益换算成每年复合收益率'),
        ('布林带', '均线上下各加 2 个标准差形成的通道'),
        ('Z 值', '当前值偏离均值多少个标准差，±2 为显著'),
        ('两融担保比例', '（现金+证券市值）÷ 融资负债，低于 227% 触发强平'),
        ('归一化 / rebase', '把曲线从某天重新定为 1000，便于不同点位对比'),
    ]:
        A(f'| {k} | {v} |')
    A('')
    A('## 免责声明')
    A('')
    A('仅为公开图表模型的复现，用于数据观察与学习，**不构成任何投资建议**。')
    A('分位基于有限样本，口径替代部分存在系统性偏差。')
    A('')
    return '\n'.join(lines)


def latest_payload(d):
    """精简版机器数据：只保留各指标当前读数。"""
    out = {'updated': d.get('updated'), 'latest': d.get('latest'), 'modules': {}}
    for code in ORDER:
        m = d['modules'].get(code) or {}
        c = m.get('cur') or {}
        if not c:
            continue
        out['modules'][code] = {
            'name': META[code][0],
            'group': META[code][1],
            'asof': (d.get('asof') or {}).get(code) or c.get('date'),
            'values': c,
            'howto': META[code][2],
        }
    return out


def main():
    check = '--check' in sys.argv
    with open(os.path.join(HERE, 'data.json'), encoding='utf-8') as f:
        d = json.load(f)

    md = build(d)
    payload = json.dumps(latest_payload(d), ensure_ascii=False, indent=1)

    if check:
        print(md)
        return

    with open(os.path.join(HERE, 'llms.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(md)
    with open(os.path.join(HERE, 'snapshot.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(md)
    with open(os.path.join(HERE, 'latest.json'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(payload)

    print(f'llms.txt      {len(md.encode("utf-8")):>7,} bytes')
    print(f'snapshot.md   {len(md.encode("utf-8")):>7,} bytes')
    print(f'latest.json   {len(payload.encode("utf-8")):>7,} bytes')


if __name__ == '__main__':
    main()
