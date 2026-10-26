# -*- coding: utf-8 -*-
"""倒计时计划：按考试日期和每天能学多久，算出「吃到哪一讲、哪些要砍」。

这一层没有模型，全是本地真数据上的算术：
  输入  考试日期（用户填）· 每天分钟（用户填）· 各科分值 · 每讲实测时长 · 已完成讲次
  输出  每天排哪几讲、每科能吃到第几讲、砍掉哪些、覆盖率多少

算不出来的地方一律留空并写明原因。不编数字，不替用户做决定
（考试日期和每天时长必须由用户填，系统不猜一个「大概是明年三月」）。
"""
import datetime as dt

from . import config, datahub, store

KV_DATE = "plan.exam_date"        # YYYY-MM-DD
KV_MIN = "plan.minutes_per_day"   # 每天能学多少分钟
KV_VOCAB = "plan.vocab_minutes"   # 每天留给单词的分钟（0 = 不排单词块）
KV_SET_AT = "plan.set_at"

# 时间轴像素口径（跟 web/app.css 里 .tl 的刻度对齐：06:00=0px，08:00=65px）
TL_START_HOUR = 6
PX_PER_HOUR = 32.5

# 短于这个分钟的条目不单独占一块（要么是占位条目，要么排出来只是一道缝）
MIN_BLOCK = 3


# ------------------------------------------------------------------ 预算
def budget():
    """读用户定的预算。没定就返回 set=False，调用方必须原样把这个状态说出去。"""
    d = store.kv_get(KV_DATE)
    m = store.kv_get(KV_MIN)
    v = store.kv_get(KV_VOCAB)
    try:
        m = int(m) if m not in (None, "") else None
    except (TypeError, ValueError):
        m = None
    try:
        v = int(v) if v not in (None, "") else 0
    except (TypeError, ValueError):
        v = 0
    out = {"exam_date": d or None, "minutes_per_day": m,
           "vocab_minutes": v, "set_at": store.kv_get(KV_SET_AT)}
    if not d or not m:
        out["set"] = False
        out["reason"] = "还没定考试日期和每天时长，排不出来——不是算不出来，是没有依据。"
        return out
    try:
        day = dt.date.fromisoformat(d)
    except ValueError:
        out["set"] = False
        out["reason"] = "考试日期 %s 不是 YYYY-MM-DD，读不出来。" % d
        return out
    today = dt.date.today()
    days_left = (day - today).days
    out["set"] = True
    out["days_left"] = days_left
    out["today"] = today.isoformat()
    if days_left < 0:
        out["ok"] = False
        out["reason"] = "考试日期 %s 已经过了 %d 天，倒计时排不了。" % (d, -days_left)
    elif days_left == 0:
        out["ok"] = False
        out["reason"] = "考试就在今天，没有可排的日子了。"
    else:
        out["ok"] = True
    out["total_minutes"] = max(days_left, 0) * m
    return out


def set_budget(exam_date=None, minutes_per_day=None, vocab_minutes=None):
    """写预算。三个值都是用户给的，系统不做推荐值——推荐值就是编数字。"""
    if exam_date is not None:
        exam_date = str(exam_date).strip()
        if exam_date:
            try:
                dt.date.fromisoformat(exam_date)
            except ValueError:
                return {"ok": False, "error": "日期要写成 YYYY-MM-DD，收到的是 %s" % exam_date}
        store.kv_set(KV_DATE, exam_date)
    if minutes_per_day is not None:
        try:
            n = int(minutes_per_day)
        except (TypeError, ValueError):
            return {"ok": False, "error": "每天分钟必须是整数，收到的是 %s" % minutes_per_day}
        if n < 10 or n > 720:
            return {"ok": False, "error": "每天分钟要在 10–720 之间，收到的是 %d" % n}
        store.kv_set(KV_MIN, str(n))
    if vocab_minutes is not None:
        try:
            n = int(vocab_minutes)
        except (TypeError, ValueError):
            return {"ok": False, "error": "单词分钟必须是整数，收到的是 %s" % vocab_minutes}
        if n < 0 or n > 300:
            return {"ok": False, "error": "单词分钟要在 0–300 之间，收到的是 %d" % n}
        store.kv_set(KV_VOCAB, str(n))
    store.kv_set(KV_SET_AT, store.now())
    return {"ok": True, "budget": budget()}


# ------------------------------------------------------------------ 讲次顺序
def _order(sub):
    """教学顺序：从构建时算好的 next.id 往后，再绕回开头。

    （datahub.derive_next 里踩过的坑：lessons[] 的数组顺序 ≠ 教学顺序）
    """
    lessons = sub.get("lessons") or []
    if not lessons:
        return []
    anchor = (sub.get("next") or {}).get("id")
    start = 0
    for i, l in enumerate(lessons):
        if l.get("id") == anchor:
            start = i
            break
    return lessons[start:] + lessons[:start]


def _min(l):
    return round((l.get("dur") or 0) / 60.0, 1)


def _cls(sid):
    return datahub.CLS.get(sid, "cs")


# ------------------------------------------------------------------ 主算
def plan_budget():
    """把「能吃到哪一讲、砍掉哪些」算成可核对的数字。"""
    b = budget()
    if not b.get("set") or not b.get("ok"):
        return b
    p = datahub.proto()
    done = datahub.done_ids()

    scored = [s for s in (p.get("subjects") or []) if (s.get("score") or 0) > 0]
    total_score = sum(s.get("score") or 0 for s in scored)
    if not total_score:
        # 一个字段都不能少：课表页要读 pending_hours / keep_hours / cut_hours / coverage。
        # 少了它们，界面就把 undefined 印给用户看 —— 那比不排还难看。
        return dict(b, subjects=[], cut_sample=[], cut_total=0,
                    lesson_budget_minutes=0,
                    vocab_total_minutes=(b.get("vocab_minutes") or 0) * (b.get("days_left") or 0),
                    pending_hours=0.0, keep_hours=0.0, cut_hours=0.0,
                    coverage=None,
                    note="没有带分值的科目 —— 排不出讲次。不是算不出来，是没有可以排的内容。",
                    rule="没有带分值的科目，权重算不出来。")

    # 单词先扣：它不在讲次预算里，是另一笔账
    vocab_min = b.get("vocab_minutes") or 0
    lesson_budget = max(b["total_minutes"] - vocab_min * b["days_left"], 0)

    subs = []
    cut_all = []
    for s in scored:
        w = (s.get("score") or 0) * 1.0 / total_score
        quota = lesson_budget * w
        order = _order(s)
        used = 0.0
        keep = []
        cut = []
        done_n = 0
        for l in order:
            if l.get("id") in done:
                done_n += 1          # 已完成的讲不吃将来的预算
                continue
            m = _min(l)
            if used + m <= quota:
                used += m
                keep.append(l)
            else:
                cut.append(l)
        subs.append({
            "id": s["id"], "name": s.get("name"), "score": s.get("score"),
            "weight": round(w, 3), "cls": _cls(s["id"]),
            "quota_minutes": round(quota), "used_minutes": round(used),
            "lessons_total": len(order), "lessons_done": done_n,
            "keep": len(keep), "cut": len(cut),
            "keep_hours": round(used / 60.0, 1),
            "cut_hours": round(sum(_min(l) for l in cut) / 60.0, 1),
            "reach": (keep[-1].get("title") if keep else None),
            "reach_chapter": (keep[-1].get("chapter") if keep else None),
        })
        for l in cut[:12]:
            cut_all.append({"subject": s.get("name"), "cls": _cls(s["id"]),
                            "id": l.get("id"), "title": l.get("title"),
                            "chapter": l.get("chapter"), "minutes": _min(l),
                            "why": "超出「%s」科的额度 %.0f 分钟" % (s.get("name"), quota)})

    pending_hours = round(sum(x["keep_hours"] + x["cut_hours"] for x in subs), 1)
    keep_hours = round(sum(x["keep_hours"] for x in subs), 1)
    cut_hours = round(sum(x["cut_hours"] for x in subs), 1)
    out = dict(b)
    out.update({
        "lesson_budget_minutes": round(lesson_budget),
        "vocab_total_minutes": vocab_min * b["days_left"],
        "pending_hours": pending_hours,
        "keep_hours": keep_hours,
        "cut_hours": cut_hours,
        "coverage": (round(keep_hours / pending_hours, 3) if pending_hours else None),
        "subjects": subs,
        "cut_sample": cut_all[:20],
        "cut_total": sum(x["cut"] for x in subs),
        "rule": "按分值权重切每天的时间 → 按教学顺序从头吃 → 吃不完的从尾部砍（后面的课依赖前面的）",
    })
    return out


# ------------------------------------------------------------------ 排一周
def plan_week(days=7):
    """排未来 days 天。一讲看不完就分到第二天（真实情况就是这样）。"""
    pb = plan_budget()
    if not pb.get("set") or not pb.get("ok"):
        return pb
    p = datahub.proto()
    done = datahub.done_ids()

    # 每科按权重拿每天额度，再按教学顺序把讲次摊到每一天
    per = []
    for s in (p.get("subjects") or []):
        if (s.get("score") or 0) <= 0:
            continue
        row = next((x for x in pb["subjects"] if x["id"] == s.get("id")), None)
        if not row:
            continue
        order = _order(s)
        # 少于 3 分钟的条目是「课程预告 / 更新中」这类占位，不是真课，不进排程
        pending = [l for l in order if l.get("id") not in done and _min(l) >= MIN_BLOCK]
        keep = pending[:row["keep"]]
        per.append({"id": s["id"], "name": s.get("name"), "cls": row["cls"],
                    "weight": row["weight"], "queue": keep[:],
                    "pos": 0.0})   # pos = 当前这一讲已经排掉的分钟

    vocab_min = pb.get("vocab_minutes") or 0
    cur = datahub.current_group(p)
    mem = store.mem_stats()
    mpd = pb["minutes_per_day"]

    out_days = []
    today = dt.date.today()
    for i in range(max(1, min(int(days or 7), 14))):
        d = today + dt.timedelta(days=i)
        left = float(mpd)
        if vocab_min:
            left -= vocab_min
        blocks = []
        # 轮转起始科目：不每天先学同一科
        n = len(per)
        order_idx = [(j + i) % n for j in range(n)] if n else []
        for j in order_idx:
            s = per[j]
            if not s["queue"]:
                continue
            quota = mpd * s["weight"]
            got = 0.0
            while s["queue"] and got < quota and left > 0:
                l = s["queue"][0]
                need = _min(l) - s["pos"]
                take = min(need, quota - got, left)
                if take < MIN_BLOCK:
                    break
                blocks.append({"cls": s["cls"], "subject": s["id"],
                               "subject_name": s["name"],
                               "title": l.get("title"),
                               "chapter": l.get("chapter"),
                               "lesson_id": l.get("id"),
                               "minutes": round(take),
                               "part": (s["pos"] > 0)})
                got += take
                left -= take
                s["pos"] += take
                if s["pos"] >= _min(l) - 0.5:
                    s["queue"].pop(0)
                    s["pos"] = 0.0
        if vocab_min > 0:
            blocks.append({"cls": "vo", "subject": "vocab", "subject_name": "背单词",
                           "title": "%s %s" % (cur.get("unit") or "", cur.get("lesson") or ""),
                           "chapter": "到期 %d 词" % (mem.get("due_today") or 0),
                           "lesson_id": None, "minutes": vocab_min, "part": False})
        blocks.sort(key=lambda b: b["minutes"], reverse=True)
        # 给每块排一个开始时间：从 08:00 起往下铺
        hh, mm = 8, 0
        for b in blocks:
            b["start"] = "%02d:%02d" % (hh, mm)
            mm += int(round(b["minutes"]))
            hh += mm // 60
            mm = mm % 60
        out_days.append({"date": d.isoformat(), "wd": d.weekday(),
                         "is_today": i == 0,
                         "minutes": sum(int(round(b["minutes"])) for b in blocks),
                         "blocks": blocks})
    # 本机一讲课都没有时也要给出话：空排程不是错误，是「没东西可排」。
    if not any(x.get("blocks") for x in out_days):
        pb["days"] = out_days
        pb["empty"] = True
        pb["empty_reason"] = ("这门课一门可排的讲次都没有 —— 本机课程目录是空的，"
                              "也没有把找到的课拉进课表。空着不是排错，是没有可排的内容。")
        return pb
    pb["days"] = out_days
    return pb
