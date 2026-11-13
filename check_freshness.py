# -*- coding: utf-8 -*-
"""数据新鲜度告警（P0 · 2026-11-13）。

背景：中证官网 WAF 曾让 12 张卡片连续多日「沿用旧缓存」，而 workflow 仍 success、
日志只有一行不起眼的跳过提示 —— 用户看到的是「数据日期差原版好几天」。
主取数现已能经 a-stock-api /api/csindex 自愈，这里只做最后一道「可见性兜底」：
若仍有卡片落后全站最新日 >=2 天，或同时滞后卡片 >=8 张，打 ::warning::。

设计约束（与 README 第十一部分 / 附录 K 一致）：
  · 绝不 exit 1、绝不中断构建：节假日、披露节奏差异属正常，局部容错是设计；
  · 不写任何文件、不改产物：llms.txt / snapshot.md 自带「数据滞后提示」段，
    无需在这里重复生成（改摘要请改 make_llm_summary.py，见维护须知第 8 条）；
  · 只读 data.json 的 latest / stale，两者都由 fetch_data.py 自己算出。
"""
import datetime
import json
import os

GAP_DAYS = 2      # 落后 >=2 个自然日 → 告警
MASS_CARDS = 8    # 或同时滞后 >=8 张卡片 → 告警（本次事故正是 12 张一起冻结）


def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception as e:
        print("::warning::新鲜度检查读不到 data.json: %s" % e)
        return
    latest = (d.get("latest") or "").strip()
    stale = d.get("stale") or {}
    if not latest or not isinstance(stale, dict) or not stale:
        print("新鲜度检查：全站最新 %s，滞后卡片 0 张，正常" % (latest or "—"))
        return
    try:
        L = datetime.date.fromisoformat(latest)
    except Exception:
        print("新鲜度检查：latest 格式异常(%s)，跳过" % latest)
        return
    bad = []
    for k, v in sorted(stale.items()):
        try:
            gap = (L - datetime.date.fromisoformat(str(v))).days
        except Exception:
            continue
        if gap >= GAP_DAYS:
            bad.append("%s=%s(%d天)" % (k, v, gap))
    mass = len(stale) >= MASS_CARDS
    if bad or mass:
        print("::warning::数据停更告警：全站最新 %s，滞后卡片 %d 张；落后>=%d天的有 %d 张%s"
              % (latest, len(stale), GAP_DAYS, len(bad),
                 (" —— " + ", ".join(bad)) if bad else ""))
        print("::warning::若两条取数通道日志均正常，这通常是上游 index-perf 发布节奏"
              "（官方数据末日落后 1~2 个交易日，见 README 附录 L.10）：上游补发后每日增量会自动追回，"
              "无需人工处理；仅当 gap 逐日扩大且通道日志异常时才按附录 L.4 排查。"
              "完整清单见 data.json 的 stale 字段与 llms.txt「数据滞后提示」。")
    else:
        print("新鲜度检查：%d 张卡片滞后均 <%d 天（最新日 %s），属正常披露节奏"
              % (len(stale), GAP_DAYS, latest))


if __name__ == "__main__":
    main()
