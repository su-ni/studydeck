# -*- coding: utf-8 -*-
"""背单词的决策层：下一张卡给谁，由本机真数据说了算。

这一层不做模型调用，也绝不猜。它只做一件事：把本机已经记下来的事实
（什么时候到期、错过几次、真题里出现过几次、这一组里排第几）排成一个顺序，
并且**每个决定都要能说清凭什么** —— 排第一的那个词，界面上必须写得出依据。

跟 AI 讲题同一个规矩：先找证据再说话。没有证据的词就拿不到加分，
它只会因为「排在词表第 N 个」被选中，而这个理由也会如实写出来。
"""
import datetime as dt

from . import config, store

# 档位：先分档再档内排序。档位是硬顺序 —— 逾期没复习的词永远比新词优先，
# 不会因为新词「高频」就插队。这是复习的常识，不是算出来的。
TIER_OVERDUE = "overdue"     # 逾期：due < 今天
TIER_DUE = "due"             # 今天到期
TIER_WRONG = "wrong"         # 答错过（还没到期）
TIER_FREQ = "freq"           # 真题高频（有频次数据）
TIER_FRESH = "fresh"         # 没见过的新词
TIER_ORDER = [TIER_OVERDUE, TIER_DUE, TIER_WRONG, TIER_FREQ, TIER_FRESH]
TIER_NAME = {
    TIER_OVERDUE: "逾期没复习",
    TIER_DUE: "今天到期",
    TIER_WRONG: "答错过",
    TIER_FREQ: "真题高频",
    TIER_FRESH: "新词",
}


def _today():
    return dt.date.today().isoformat()


def _days(s):
    """把 YYYY-MM-DD 变成 date；读不出来就返回 None（不猜）。"""
    if not s or not isinstance(s, str):
        return None
    try:
        return dt.date.fromisoformat(s[:10])
    except ValueError:
        return None


def _overdue_days(due, today_s):
    d = _days(due)
    t = _days(today_s)
    if not d or not t:
        return 0
    return max((t - d).days, 0)


def signals(word, mem=None, freq=None, starred=False, group_index=None):
    """一个词的全部本机证据。缺哪样就是 None，不补默认值。

    mem      word_mem 行（box/due/seen/right/wrong/last_ts）
    freq     最高频 500 词表里的出现次数（没有就不给，不编）
    starred  是否在生词本里
    group_index  在词组里的序号（从 1 开始）
    """
    m = mem or {}
    return {
        "w": word,
        "box": m.get("box"),
        "due": m.get("due"),
        "seen": m.get("seen") or 0,
        "right": m.get("right") or 0,
        "wrong": m.get("wrong") or 0,
        "last_ts": m.get("last_ts"),
        "freq": freq,
        "starred": bool(starred),
        "group_index": group_index,
    }


def _tier_of(sg, today_s):
    """按证据分档。返回 (档位, 档内分数, 依据文案)。"""
    w = sg["w"]
    seen = sg["seen"]
    wrong = sg["wrong"]
    right = sg["right"]
    due = sg["due"]
    box = sg["box"]
    freq = sg["freq"]

    # 只认真的作答记录：旧 progress.json 塞进来的 seen=1 但没有对错的词
    # 不算「背过」（跟 store.REAL_MEM_SQL 同一个口径）。
    real = (right + wrong) > 0

    if real and due:
        od = _overdue_days(due, today_s)
        if od > 0:
            return (TIER_OVERDUE, od * 100 + wrong * 10,
                    "逾期 %d 天没复习（到期日 %s）" % (od, due))
        if due == today_s:
            return (TIER_DUE, wrong * 10 - (box or 0),
                    "今天到期（档位 %d%s）" % (box or 0,
                                              "，错过 %d 次" % wrong if wrong else ""))

    if wrong:
        return (TIER_WRONG, wrong * 10 + (right or 0),
                "答错过 %d 次（答对 %d 次）" % (wrong, right or 0))

    if freq:
        return (TIER_FREQ, freq, "真题里出现过 %d 次（最高频 500 词表）" % freq)

    if seen:
        return (TIER_FRESH, -seen, "背过 %d 次，但没记对错（自评档）" % seen)

    if sg["group_index"]:
        return (TIER_FRESH, 10000 - sg["group_index"],
                "这一组第 %d 个新词，还没背过" % sg["group_index"])

    return (TIER_FRESH, 0, "词表里的词，本机还没有任何记录")


def rank(words, mems=None, freq_index=None, stars=None, today_s=None,
         limit=None):
    """给一组词排出顺序。

    words       [{w, ...}] 或 [str]
    mems        {word: mem_row}
    freq_index  {word: {"freq": n}}  （没有就不给高频档，不编）
    stars       set(生词本里的词)
    limit       只取前 N 个（今天背多少）

    返回 {order:[{w,tier,tier_name,score,reason,signals}], tiers:{档位:条数}, rule}
    """
    today_s = today_s or _today()
    mems = mems or {}
    freq_index = freq_index or {}
    stars = stars or set()

    rows = []
    for i, it in enumerate(words):
        w = it["w"] if isinstance(it, dict) else it
        m = mems.get(w) or {}
        f = (freq_index.get(w) or {}).get("freq") if isinstance(
            freq_index.get(w), dict) else freq_index.get(w)
        sg = signals(w, mem=m, freq=f, starred=(w in stars),
                     group_index=(i + 1))
        tier, score, reason = _tier_of(sg, today_s)
        if sg["starred"]:
            # 生词本是人自己标的，值得提前见一面，但不改档位 —— 只是档内加分。
            score += 5
            reason += "；你自己标过生词"
        rows.append({"w": w, "tier": tier, "tier_name": TIER_NAME[tier],
                     "score": score, "reason": reason, "signals": sg})

    rows.sort(key=lambda r: (TIER_ORDER.index(r["tier"]), -r["score"]))

    tiers = {}
    for r in rows:
        tiers[r["tier"]] = tiers.get(r["tier"], 0) + 1

    if limit:
        try:
            rows = rows[:max(int(limit), 1)]
        except (TypeError, ValueError):
            pass

    parts = ["%s %d" % (TIER_NAME[k], tiers[k]) for k in TIER_ORDER if tiers.get(k)]
    rule = ("排卡顺序按本机记录算出来：逾期没复习的先来，然后今天到期、答错过、"
            "真题高频，最后才是新词。这次是 " + " · ".join(parts) if parts else
            "这一组本机还没有任何记录，先按词表顺序走")
    return {"order": rows, "tiers": tiers, "rule": rule,
            "count": len(rows), "today": today_s}
