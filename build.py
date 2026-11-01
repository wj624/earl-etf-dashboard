# -*- coding: utf-8 -*-
"""
把 template.html + echarts.min.js + data.js 打包成一个自包含的 index.html。

为什么需要这一步：预览器 / 部分静态服务器只会加载 index.html 本身，
同目录的 data.js、echarts.min.js 不会一起带上，页面会报「未加载到数据」。
打包成单文件后，file:// 双击、预览器、任意静态目录都能正常打开。
"""
import os, json, datetime as dt

BASE = os.path.dirname(os.path.abspath(__file__))
p = lambda f: os.path.join(BASE, f)

ECHARTS_TAG = "<!--ECHARTS_HERE-->"
DATA_ANCHOR = "<!--DATA_HERE-->"


def read(f):
    with open(p(f), encoding="utf-8") as fh:
        return fh.read()


def rebuild_anchor():
    """用 data.json 的 M1（五年之锚）重建独立页 anchor_v2.html 的内嵌 ANCHOR 数据。

    背景：anchor_v2.html 原是一次性静态快照（内嵌 const ANCHOR = {...}），不读 data.js、
    也不被任何 build 步骤更新，所以永远停在生成那一刻（2026-10-23 / 万得全A）。
    这里在每次构建时用 data.json 的 m1（现为中证全指 000985，云端每日刷新）重算
    price / ma1250 / dev / cur / stats 并写回，使它跟主页同步更新。
    """
    ap = p("anchor_v2.html")
    if not os.path.exists(ap) or not os.path.exists(p("data.json")):
        return
    with open(p("data.json"), encoding="utf-8") as fh:
        dj = json.load(fh)
    m1 = (dj.get("modules") or {}).get("m1")
    if not m1:
        print("anchor_v2: data.json 无 m1，跳过"); return
    d = m1.get("data") or {}
    dates, cols = d.get("dates") or [], d.get("cols") or []
    if len(cols) < 2 or not dates:
        print("anchor_v2: m1.data 结构异常，跳过"); return
    price_a, ma_a = cols[0], cols[1]

    ds, prs, mas, devs = [], [], [], []
    for i, dt_ in enumerate(dates):
        pv = price_a[i] if i < len(price_a) else None
        mv = ma_a[i] if i < len(ma_a) else None
        if pv is None or mv is None or mv == 0:
            continue
        ds.append(dt_)
        prs.append(round(float(pv), 2))
        mas.append(round(float(mv), 2))
        devs.append(round((float(pv) / float(mv) - 1) * 100, 2))
    if len(ds) < 100:
        print("anchor_v2: 有效点不足，跳过"); return

    n = len(devs)
    cur_dev = devs[-1]
    hi = max(range(n), key=lambda i: devs[i])
    lo = min(range(n), key=lambda i: devs[i])
    last_over = next((ds[i] for i in range(n - 1, -1, -1) if devs[i] >= 10), "")
    last_bot = next((ds[i] for i in range(n - 1, -1, -1) if devs[i] <= -20), "")
    d_over = sum(1 for x in devs if x >= 10)
    d_bot = sum(1 for x in devs if x <= -20)
    d_neu = n - d_over - d_bot
    hist_pct = round(sum(1 for x in devs if x <= cur_dev) / n * 100, 1)

    # 三档阈值与 index.html 的 M1 同源：中证全指 000985 口径（+10% / −20%）。
    # −20% 正好等于 M1b 的「五年均线打八折」(MA×0.8)，两页对得上；
    # 不要换成万得全A 口径的 +15%，两者偏离度水平值差约 5pt。
    if cur_dev >= 10:
        zone, label, color = "over", "高估区间 · 暂停/减仓", "red"
        advice = "偏离率 ≥ +10%：估值偏高，暂停定投、考虑分批减仓"
    elif cur_dev <= -20:
        zone, label, color = "bot", "底部区间 · 分批抄底", "green"
        advice = "偏离率 ≤ −20%：估值低位，可分批加仓"
    else:
        zone, label, color = "neutral", "中性区间 · 正常定投持有", "blue"
        advice = "−20% < 偏离率 < +10%：估值合理，按计划定投即可"

    anchor = {
        "dates": ds, "price": prs, "ma": mas, "dev": devs,
        "cur": {"date": ds[-1], "price": prs[-1], "ma": mas[-1], "dev": cur_dev,
                "zone": zone, "label": label, "color": color, "advice": advice,
                "histPct": hist_pct},
        "stats": {"histMin": devs[lo], "histMinD": ds[lo],
                  "histMax": devs[hi], "histMaxD": ds[hi],
                  "lastOver": last_over, "lastBot": last_bot,
                  "daysOver": d_over, "daysNeu": d_neu, "daysBot": d_bot, "n": n},
    }
    new_json = json.dumps(anchor, ensure_ascii=False, separators=(",", ":"))

    txt = open(ap, encoding="utf-8").read()
    marker = "const ANCHOR = "
    start = txt.find(marker)
    if start < 0:
        print("anchor_v2: 找不到 ANCHOR 数据块，跳过"); return
    jstart = start + len(marker)
    try:
        _, jend = json.JSONDecoder().raw_decode(txt[jstart:])
    except Exception as e:
        print("anchor_v2: ANCHOR JSON 解析失败，跳过：", e); return
    txt = txt[:jstart] + new_json + txt[jstart + jend:]
    # 说明：这里原来还有三行「881001.WI → 000985 / 万得全A → 中证全指000985」的全量字符串替换，
    # 那是换源时的一次性迁移代码。文件迁完之后必须删掉，否则每次构建都会把正文里正常出现的
    # 「万得全A」改写成「中证全指000985」——比如「不要与万得全A 口径混用」会被改成
    # 「不要与中证全指000985 混用」，意思正好反了。别再把它加回来。
    with open(ap, "w", encoding="utf-8") as fh:
        fh.write(txt)
    print(f"已重建 anchor_v2.html  ANCHOR（{n} 点，截至 {ds[-1]}，偏离率 {cur_dev:.2f}%）")


def main():
    tpl = read("template.html")
    ec = read("echarts.min.js")
    # data.js 自 2026-11-01 起不再进版本库：它就是 "window.DATA=" + data.json + ";"，
    # 每天多提交 2.2MB 纯冗余。缺了就在这里现生成一份（与 fetch_data.py 写出的完全一致）。
    if not os.path.exists(p("data.js")):
        with open(p("data.js"), "w", encoding="utf-8") as fh:
            fh.write("window.DATA=" + read("data.json") + ";")
        print("data.js 缺失，已从 data.json 现生成")
    data = read("data.js")

    if ECHARTS_TAG not in tpl:
        raise SystemExit("template.html 中找不到 echarts 引用标签")
    if DATA_ANCHOR not in tpl:
        raise SystemExit("template.html 中找不到数据锚点")

    out = tpl.replace(ECHARTS_TAG, "<script>\n/* ECharts 5.5.1 (inlined) */\n" + ec + "\n</script>")
    out = out.replace(DATA_ANCHOR, "<script>\n/* 指标数据 (inlined) */\n" + data + "\n</script>\n\n")

    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    out = out.replace("</head>", f"<!-- 自包含单文件，打包于 {stamp} -->\n</head>")
    out = out.replace("<!--BUILD-->", "")

    with open(p("index.html"), "w", encoding="utf-8") as fh:
        fh.write(out)
    print(f"已生成自包含 index.html  {os.path.getsize(p('index.html'))//1024} KB  ({stamp})")

    # version.txt：几十字节的版本探针。
    # 线上页面先拉它做比对，版本一致就完全不必再下 data.json
    # （跨境链路实测 data.json 需 25~107s；本地/局域网则是毫秒级）。内容 = data.json 的 updated。
    try:
        import json
        with open(p("data.json"), encoding="utf-8") as fh:
            ver = str((json.load(fh) or {}).get("updated") or stamp)
        with open(p("version.txt"), "w", encoding="utf-8") as fh:
            fh.write(ver)
        print(f"已写 version.txt  {ver}")
    except Exception as e:
        print("version.txt 写入失败：", e)

    # 重建独立页 anchor_v2.html 的内嵌数据（让它也随每日构建自动更新）
    try:
        rebuild_anchor()
    except Exception as e:
        print("anchor_v2 重建失败（忽略，不影响主页）：", e)


if __name__ == "__main__":
    main()
