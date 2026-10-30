# -*- coding: utf-8 -*-
"""倒计时计划：按考试日期和每天能学多久，算出「吃到哪一讲、哪些要砍」。

这一层没有模型，全是本地真数据上的算术：
  输入  考试日期（用户填）· 每天分钟（用户填）· 各科分值 · 每讲实测时长 · 已完成讲次
  输出  每天排哪几讲、每科能吃到第几讲、砍掉哪些、覆盖率多少

算不出来的地方一律留空并写明原因。不编数字，不替用户做决定
（考试日期和每天时长必须由用户填，系统不猜一个「大概是明年三月」）。
"""
import datetime as dt
import json
import os

from . import config, datahub, store

KV_DATE = "plan.exam_date"        # YYYY-MM-DD
KV_MIN = "plan.minutes_per_day"   # 每天能学多少分钟
KV_VOCAB = "plan.vocab_minutes"   # 每天留给单词的分钟（0 = 不排单词块）
KV_SET_AT = "plan.set_at"

# 用户（或助手）可以直接改这个文件来定计划，不必走 plan_set_budget。
# 加它是为了「一天一节数学、一节 C、一节英语」这种按科目说的排法 ——
# 光靠 minutes_per_day 一个总数表达不了，硬塞进 tool 参数只会再造一个工具。
PLAN_FILE = os.path.join(config.APP_DATA_DIR, "plan.json")


def plan_file():
    """读计划文件。读不出来就当没配（不猜一个默认计划）。"""
    try:
        with open(PLAN_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _patch_file(**kw):
    """把改过的值写回 plan.json。保留文件里其它用户手写的字段。"""
    cur = plan_file()
    cur.update({k: v for k, v in kw.items() if v is not None})
    try:
        os.makedirs(os.path.dirname(PLAN_FILE), exist_ok=True)
        tmp = PLAN_FILE + ".sdtmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(cur, f, ensure_ascii=False, indent=2)
        os.replace(tmp, PLAN_FILE)
    except OSError:
        pass

# 时间轴像素口径（跟 web/app.css 里 .tl 的刻度对齐：06:00=0px，08:00=65px）
TL_START_HOUR = 6
PX_PER_HOUR = 32.5

# 短于这个分钟的条目不单独占一块（要么是占位条目，要么排出来只是一道缝）
MIN_BLOCK = 3


# ------------------------------------------------------------------ 预算
def _quota_rows(rows):
    """把 per_subject 收拾成 [{"subject": "...", "lessons_per_day": n}]。

    宽松收：允许写成 "math"、{"subject":"数学"}、{"id":"clang","per_day":2}。
    科目名到 slug 的归一留到真排的时候做（这里不依赖 proto 加载）。
    """
    out = []
    for x in rows or []:
        if isinstance(x, str):
            x = {"subject": x}
        if not isinstance(x, dict):
            continue
        raw = x.get("subject") or x.get("id") or x.get("name")
        if not raw:
            continue
        try:
            n = int(x.get("lessons_per_day", x.get("per_day", 1)))
        except (TypeError, ValueError):
            n = 1
        if n <= 0:
            continue
        row = {"subject": str(raw).strip(), "lessons_per_day": min(n, 6)}
        if x.get("name"):
            row["name"] = str(x["name"])
        out.append(row)
    return out


def budget():
    """读用户定的预算。没定就返回 set=False，调用方必须原样把这个状态说出去。

    两个来源：data/plan.json（用户或助手直接改）优先，其次是库里的 kv（老路径）。
    两者都没有就老实说没定，不猜一个默认计划。
    """
    fc = plan_file()
    d = fc.get("exam_date") or store.kv_get(KV_DATE)
    m = fc.get("minutes_per_day")
    if m is None:
        m = store.kv_get(KV_MIN)
    v = fc.get("vocab_minutes")
    if v is None:
        v = store.kv_get(KV_VOCAB)
    try:
        m = int(m) if m not in (None, "") else None
    except (TypeError, ValueError):
        m = None
    try:
        v = int(v) if v not in (None, "") else 0
    except (TypeError, ValueError):
        v = 0
    q = _quota_rows(fc.get("per_subject"))
    out = {"exam_date": d or None, "minutes_per_day": m,
           "vocab_minutes": v, "per_subject": q,
           "set_at": fc.get("set_at") or store.kv_get(KV_SET_AT),
           "source": "plan.json" if fc else "kv"}
    if not q and (not d or not m):
        out["set"] = False
        out["reason"] = ("还没定考试日期和每天时长，也没说每科每天上几节，排不出来 —— "
                         "不是算不出来，是没有依据。")
        return out
    out["set"] = True
    if d:
        try:
            day = dt.date.fromisoformat(str(d))
        except ValueError:
            out["set"] = False
            out["reason"] = "考试日期 %s 不是 YYYY-MM-DD，读不出来。" % d
            return out
        today = dt.date.today()
        days_left = (day - today).days
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
    else:
        # 只给了每日配额、没给日期：能排每天上什么，但算不出覆盖率。
        out["ok"] = True
        out["days_left"] = None
        out["reason"] = "没设考试日期，只按每日配额排；覆盖率算不出来（不编）。"
    out["total_minutes"] = (max(out.get("days_left") or 0, 0) * m) if (d and m) else None
    return out


def set_budget(exam_date=None, minutes_per_day=None, vocab_minutes=None, per_subject=None):
    """写预算。值都是用户给的，系统不做推荐值——推荐值就是编数字。"""
    if exam_date is not None:
        exam_date = str(exam_date).strip()
        if exam_date:
            try:
                dt.date.fromisoformat(exam_date)
            except ValueError:
                return {"ok": False, "error": "日期要写成 YYYY-MM-DD，收到的是 %s" % exam_date}
        store.kv_set(KV_DATE, exam_date)
        _patch_file(exam_date=exam_date)
    if minutes_per_day is not None:
        try:
            n = int(minutes_per_day)
        except (TypeError, ValueError):
            return {"ok": False, "error": "每天分钟必须是整数，收到的是 %s" % minutes_per_day}
        if n < 10 or n > 720:
            return {"ok": False, "error": "每天分钟要在 10–720 之间，收到的是 %d" % n}
        store.kv_set(KV_MIN, str(n))
        _patch_file(minutes_per_day=n)
    if vocab_minutes is not None:
        try:
            n = int(vocab_minutes)
        except (TypeError, ValueError):
            return {"ok": False, "error": "单词分钟必须是整数，收到的是 %s" % vocab_minutes}
        if n < 0 or n > 300:
            return {"ok": False, "error": "单词分钟要在 0–300 之间，收到的是 %d" % n}
        store.kv_set(KV_VOCAB, str(n))
        _patch_file(vocab_minutes=n)
    if per_subject is not None:
        q = _quota_rows(per_subject)
        _patch_file(per_subject=q or [])
    store.kv_set(KV_SET_AT, store.now())
    _patch_file(set_at=store.now())
    # 文件要能自己解释自己：只写了一半的 plan.json，人打开看是「怎么没有日期」。
    # 库里已有的值补进去，以后改这个文件就够了，不用两边对。
    cur, fill = plan_file(), {}
    if not cur.get("exam_date") and store.kv_get(KV_DATE):
        fill["exam_date"] = store.kv_get(KV_DATE)
    if cur.get("minutes_per_day") is None and store.kv_get(KV_MIN):
        fill["minutes_per_day"] = int(store.kv_get(KV_MIN))
    if cur.get("vocab_minutes") is None and store.kv_get(KV_VOCAB):
        fill["vocab_minutes"] = int(store.kv_get(KV_VOCAB))
    if fill:
        _patch_file(**fill)
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
def _plan_quota(b, days):
    """按科目配额排：每科每天最多上几讲，不看总分。

    用户原话「一天上一节数学，一节 C 语言，一节英语」就是这个模型 —— 他按讲数说，
    不是按分钟说。老的 quota = 每天分钟 × 分值权重 会排成「数学一天三讲」，
    那不是他要的东西。一讲讲不完就顺延到第二天（pos 记账，跟总量模型共用）。
    """
    p = datahub.proto()
    done = datahub.done_ids()
    cap = int(b.get("minutes_per_day") or 180)   # 单科一天最多吃这么多分钟
    cfg, seen = [], set()
    for q in b["per_subject"]:
        s = datahub.subject_flex(p, q["subject"])
        if not s or s.get("id") in seen:
            continue
        seen.add(s.get("id"))
        cfg.append({"id": s.get("id"), "name": s.get("name"), "cls": _cls(s.get("id")),
                    "per_day": q["lessons_per_day"],
                    "queue": [l for l in _order(s)
                              if l.get("id") not in done and _min(l) >= MIN_BLOCK],
                    "pos": 0.0, "rest": 0.0})
    if not cfg:
        return dict(b, ok=False, days=[],
                    reason="这几科在本机课程目录里一门都没认出来，排不了。要先把课入库。")

    # 排之前先把账记下来 —— 排完 queue 就被吃空了，那时候再数就是 0。
    quota_rows = [{"id": c["id"], "name": c["name"], "cls": c["cls"],
                   "per_day": c["per_day"], "weight": 0,
                   "lessons_total": len(c["queue"]), "pending": len(c["queue"])}
                  for c in cfg]

    vocab_min = b.get("vocab_minutes") or 0
    cur = datahub.current_group(p)
    mem = store.mem_stats()
    today = dt.date.today()
    out_days = []
    for i in range(max(1, min(int(days or 7), 14))):
        d = today + dt.timedelta(days=i)
        blocks = []
        n = len(cfg)
        # 轮转：不每天固定先上同一科
        for j in [(k + i) % n for k in range(n)]:
            s = cfg[j]
            used = 0
            while s["queue"] and used < s["per_day"]:
                l = s["queue"][0]
                need = _min(l) - s["pos"]
                take = min(need, cap)
                if take < MIN_BLOCK:
                    # 只剩个尾巴，算这一讲完了
                    s["queue"].pop(0)
                    s["pos"] = 0.0
                    used += 1
                    continue
                blocks.append({"cls": s["cls"], "subject": s["id"],
                               "subject_name": s["name"],
                               "title": l.get("title"),
                               "chapter": l.get("chapter"),
                               "lesson_id": l.get("id"),
                               "minutes": round(take),
                               "part": s["pos"] > 0})
                s["pos"] += take
                used += 1
                if s["pos"] >= need - 0.5:
                    s["queue"].pop(0)
                    s["pos"] = 0.0
        if vocab_min > 0:
            blocks.append({"cls": "vo", "subject": "vocab", "subject_name": "背单词",
                           "title": "%s %s" % (cur.get("unit") or "", cur.get("lesson") or ""),
                           "chapter": "到期 %d 词" % (mem.get("due_today") or 0),
                           "lesson_id": None, "minutes": vocab_min, "part": False})
        hh, mm = 8, 0
        for blk in blocks:
            blk["start"] = "%02d:%02d" % (hh, mm)
            mm += int(round(blk["minutes"]))
            hh += mm // 60
            mm = mm % 60
        out_days.append({"date": d.isoformat(), "wd": d.weekday(), "is_today": i == 0,
                         "minutes": sum(int(round(x["minutes"])) for x in blocks),
                         "blocks": blocks})
    out = dict(b)
    out["mode"] = "quota"
    out["days"] = out_days
    out["subjects"] = quota_rows
    # 覆盖率是「总量模型」的概念：每天总量 × 天数 ÷ 待学时长。按讲数排的时候
    # 这几个数本来就不成立，留空并说明，比给个 0% 让人以为「全砍了」要诚实。
    out["coverage"] = None
    out["keep_hours"] = None
    out["cut_hours"] = None
    out["cut_total"] = 0
    out["rule"] = ("按科目配额排：每科每天最多 N 讲，不看总分；"
                   "一讲比单日上限长就拆到第二天")
    if not any(x.get("blocks") for x in out_days):
        out["empty"] = True
        out["empty_reason"] = ("这几科一门可排的讲次都没有 —— 课程目录是空的，"
                               "或者都已经标成看完了。")
    return out


def plan_week(days=7):
    """排未来 days 天。一讲看不完就分到第二天（真实情况就是这样）。"""
    b = budget()
    if not b.get("set") or not b.get("ok"):
        return b
    if b.get("per_subject"):
        return _plan_quota(b, days)
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
