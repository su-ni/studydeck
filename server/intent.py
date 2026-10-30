# -*- coding: utf-8 -*-
"""听懂一句话：从用户说的话里认出「想考什么、什么时候考、每天多久」。

这一层不接模型，也不猜。规矩三条，跟全站一致：

  1. 先查自己有没有 —— 说「考研」就先对照本机数据，对不上就说对不上，
     不拿专升本的课去冒充考研计划（那是最难被发现的一种编数字）。
  2. 认不出来的就问 —— 没给日期就问日期，没给每天多久就问时长，不替他填一个。
  3. 认出来的立刻落到排程 —— 日期和时长一旦齐了，直接写预算并重排，
     排完把「砍掉了哪些」一起交出来（那是这个产品真正的产品力）。

parse() 只做一件事：把一句话拆成 目标 / 日期 / 每天分钟 三个字段，
并且对每个字段说明「这个值是从哪几个字里读出来的」——读不出就说读不出。
"""
import datetime as dt
import re

from . import config, datahub, planner, store


# ---------------------------------------------------------------- 本机身份
def _self_evidence():
    """我到底装了什么：科目名 + 真题卷考区 + 考点卡，全是库里真有的东西。"""
    p = datahub.proto()
    subs = []
    for s in (p.get("subjects") or []):
        if (s.get("score") or 0) > 0:
            subs.append({"id": s["id"], "name": s.get("name"),
                         "score": s.get("score"),
                         "lessons": s.get("lessons_total") or 0})
    regions = []
    for x in (p.get("exam") or {}).get("papers") or []:
        r = (x.get("region") or "").strip()
        if r and r not in regions:
            regions.append(r)
    cards = [c.get("name") for c in (p.get("point_cards") or [])
             if isinstance(c, dict) and c.get("name")]
    return {"subjects": subs, "regions": regions, "cards": cards,
            "total_score": sum(x["score"] for x in subs),
            "total_lessons": sum(x["lessons"] for x in subs)}


_HAVE_HINTS = ("专升本", "专插本", "插本", "计算机基础", "程序设计", "公共英语",
               "高等数学", "高数", "政治理论", "政治", "英语", "c语言", "广东")

# 上面这张表只是兜底。真正的依据是「本机装了哪些学科」，不该由一张写死的词表说了算 ——
# 用户自己导了一门「考研数学」，他说「考研数学」时就该认得出那是他这儿有的东西，
# 而不是被一律当成「别人的目标」。所以表里认不出的，再去学科名里找一遍。

_OTHER_GOALS = (
    ("考研", ("考研", "研究生", "考硕")),
    ("四六级", ("四级", "六级", "cet4", "cet6", "cet-4", "cet-6")),
    ("雅思托福", ("雅思", "托福", "ielts", "toefl", "gre", "出国")),
    ("考公考编", ("考公", "公务员", "国考", "省考", "事业编", "行测", "申论")),
    ("教资", ("教资", "教师资格", "教招")),
    ("期中期末", ("期末", "期中", "月考", "补考")),
    ("高考", ("高考", "中考")),
)

_CN_NUM = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "半": 0.5}


def _cn_int(s):
    """中文数字转 int。只支持能一口念出来的（十几 / 二十 / 三十 / 两）。"""
    s = (s or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if "十" in s:
        a, _, b = s.partition("十")
        hi = _CN_NUM.get(a, 1) if a else 1
        lo = _CN_NUM.get(b, 0) if b else 0
        return int(hi) * 10 + int(lo)
    return _CN_NUM.get(s)


# ---------------------------------------------------------------- 日期
_MONTH_RE = re.compile(r"(?:(\d{4})\s*[年\-]\s*)?(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?")
_ISO_RE = re.compile(r"(\d{4})\s*[\-/]\s*(\d{1,2})(?:\s*[\-/]\s*(\d{1,2}))?")
_NEXTYEAR_RE = re.compile(r"(明年|后年|今年)")
_REL_RE = re.compile(r"(\d{2,4})\s*天(?:以)?后")


def _pick_date(text, today=None):
    """只认说得出口的日子。只给到月、没给到日的，一律算没说。"""
    today = today or dt.date.today()
    t = (text or "").replace("\u3000", " ")
    hit = _ISO_RE.search(t)
    if hit:
        y, m, d = int(hit.group(1)), int(hit.group(2)), hit.group(3)
        if d:
            try:
                return {"date": dt.date(y, m, int(d)), "raw": hit.group(0),
                        "from": "你说的 \u201c%s\u201d" % hit.group(0)}
            except ValueError:
                return {"date": None, "raw": hit.group(0),
                        "from": "\u201c%s\u201d 不是一个能认的日子" % hit.group(0)}
        return {"date": None, "raw": hit.group(0),
                "from": "\u201c%s\u201d 只给了月份，没说哪一天" % hit.group(0)}
    hit = _MONTH_RE.search(t)
    if hit:
        y = int(hit.group(1)) if hit.group(1) else None
        m = int(hit.group(2))
        d = int(hit.group(3)) if hit.group(3) else None
        if y is None:
            nx = _NEXTYEAR_RE.search(t)
            base = today.year
            if nx:
                base = today.year + {"今年": 0, "明年": 1, "后年": 2}[nx.group(1)]
            elif m < today.month:
                base = today.year + 1
            y = base
        if d:
            try:
                return {"date": dt.date(y, m, d), "raw": hit.group(0),
                        "from": "你说的 \u201c%s\u201d（补成 %d-%02d-%02d）" % (hit.group(0), y, m, d)}
            except ValueError:
                return {"date": None, "raw": hit.group(0),
                        "from": "\u201c%s\u201d 不是一个能认的日子" % hit.group(0)}
        return {"date": None, "raw": hit.group(0),
                "from": "\u201c%s\u201d 只给了月份，没说哪一天" % hit.group(0)}
    hit = _REL_RE.search(t)
    if hit:
        n = int(hit.group(1))
        return {"date": today + dt.timedelta(days=n), "raw": hit.group(0),
                "from": "按 %d 天后算（从今天 %s 起）" % (n, today.isoformat())}
    return {"date": None, "raw": None, "from": None}


# ---------------------------------------------------------------- 每天多久
_MIN_RE = re.compile(r"(?:每天|每日|一天|天天)[^0-9一二两三四五六七八九十半]{0,6}?(\d+|[一二两三四五六七八九十半]+)\s*个?\s*(小时|钟头|h|分钟|分)")


def _pick_minutes(text):
    t = (text or "").replace("\u3000", " ").lower()
    hit = _MIN_RE.search(t)
    if not hit:
        return {"minutes": None, "raw": None, "from": None}
    n = _cn_int(hit.group(1))
    unit, raw = hit.group(2), hit.group(0)
    if n is None:
        return {"minutes": None, "raw": raw, "from": "\u201c%s\u201d 里的数读不出来" % raw}
    m = int(round(n * 60)) if unit in ("小时", "钟头", "h") else int(n)
    if m < 10 or m > 720:
        return {"minutes": None, "raw": raw,
                "from": "\u201c%s\u201d 折出来是 %d 分钟，超出 10-720 的范围" % (raw, m)}
    return {"minutes": m, "raw": raw, "from": "你说的 \u201c%s\u201d = %d 分钟" % (raw, m)}


# 「一节课」的两种语序：一节数学 / 数学一节。
# 为什么单独认它：用户说的是「一天一节数学，一节 C 语言，一节英语」——
# 他按讲数说，不是按分钟说。老的 minutes_per_day 表达不了，于是整句话被判成
# 「没给每天总时长」，什么都没排成。这不是用户没说清楚，是模型太窄。
_Q_PRE = re.compile(r"([0-9一二三四五六七八九十两])\s*[节讲]\s*([^\s，,。；;、和及]{1,10})")
_Q_POST = re.compile(r"([^\s，,。；;、和及]{2,10}?)\s*([0-9一二三四五六七八九十两])\s*[节讲]")


def _quota_of(text):
    """认出「每科每天上几节」。认不出的科目直接丢掉，不硬凑一个。"""
    t = (text or "").replace("\u3000", " ")
    p = datahub.proto()
    got = {}

    def put(name, n):
        s = datahub.subject_flex(p, name)
        if not s:
            # 尾部常粘着「，一节英语」这类残渣，砍短再认一次
            for k in (5, 4, 3, 2):
                if len(name) > k:
                    s = datahub.subject_flex(p, name[:k])
                    if s:
                        break
        if not s:
            return
        try:
            k = int(n or 1)
        except (TypeError, ValueError):
            k = 1
        if k <= 0 or k > 6:
            return
        got[s["id"]] = {"subject": s["id"], "name": s.get("name"),
                        "lessons_per_day": k, "from": name}

    for m in _Q_PRE.finditer(t):
        put(m.group(2), _cn_int(m.group(1)))
    for m in _Q_POST.finditer(t):
        put(m.group(1), _cn_int(m.group(2)))
    return list(got.values())


# ---------------------------------------------------------------- 拆一句话
def parse(text, today=None):
    t = (text or "").strip()
    low = t.lower()
    me = _self_evidence()

    other = None
    for name, hints in _OTHER_GOALS:
        if any(h in low for h in hints):
            w = next(h for h in hints if h in low)
            other = {"goal": name, "word": w}
            break
    have_word = next((h for h in _HAVE_HINTS if h in low), None)
    if not have_word:
        # 按本机实有的学科认一遍。两个来源都要看：
        #   · proto_data 自带的五科（考纲里的名字）；
        #   · 题源表里的科目名 —— 用户自己导进来的「考研数学」只在这里，
        #     proto_data 里根本没有它，只看前者会把用户自己的东西认成「别人的目标」。
        # 按长度从长到短比，避免「数学」盖掉「考研数学」。
        mine_names = []
        for s in me["subjects"]:
            nm = (s.get("name") or "").strip()
            if nm:
                mine_names.append(nm)
                mine_names.extend([x for x in re.split(r"[与和暨、\s/]+", nm) if len(x) >= 2])
        try:
            for s in datahub.item_sources():
                nm = (s.get("subject_name") or "").strip()
                if nm:
                    mine_names.append(nm)
                    mine_names.extend([x for x in re.split(r"[与和暨、\s/]+", nm) if len(x) >= 2])
        except Exception:
            pass
        mine_names = sorted(set(mine_names), key=len, reverse=True)
        have_word = next((h for h in mine_names if h in low), None)

    if other and not have_word:
        goal_kind, goal, goal_from = "other", other["goal"], "从 \u201c%s\u201d 认出来的" % other["word"]
    elif have_word:
        # goal 取「这个词落在哪一科」的名字，不写死「广东专升本」——
        # 用户导了「考研数学」，他说考研数学，那就是他自己的目标。
        hit_sub = ""
        for _src in datahub.item_sources():
            _sub = _src.get("subject") or ""
            _nm = _src.get("subject_name") or ""
            if _nm and have_word in _nm:
                hit_sub = _nm
                break
            if _nm and _sub and _sub in have_word:
                hit_sub = _nm
                break
        if not hit_sub:
            for _s in me["subjects"]:
                _nm = _s.get("name") or ""
                if _nm and (have_word in _nm or _nm in have_word):
                    hit_sub = _nm
                    break
        goal_kind, goal = "mine", (hit_sub or "广东专升本")
        goal_from = "从 \u201c%s\u201d 认出来的，跟本机装的 %s 对得上" % (
            have_word, "、".join(x["name"] for x in me["subjects"]))
    elif other:
        goal_kind, goal, goal_from = "other", other["goal"], "从 \u201c%s\u201d 认出来的" % other["word"]
    else:
        goal_kind, goal, goal_from = "unknown", None, None

    d, m = _pick_date(t, today), _pick_minutes(t)
    return {"text": t, "goal": goal, "goal_kind": goal_kind, "goal_from": goal_from,
            "date": d["date"].isoformat() if d["date"] else None,
            "date_raw": d["raw"], "date_from": d["from"],
            "minutes_per_day": m["minutes"], "minutes_raw": m["raw"],
            "minutes_from": m["from"], "per_subject": _quota_of(t), "have": me}


# ---------------------------------------------------------------- 认完之后
def _say_not_mine(pp):
    me = pp["have"]
    names = "、".join("%s（%d 分）" % (x["name"], x["score"]) for x in me["subjects"])
    return {"ok": False, "kind": "not_mine",
            "say": "你说的是「%s」。我这一台装的是 %s 的 %s —— 共 %d 讲、%d 分；还有 %s。"
                   "你说的那个，我这儿一条都没有。" % (
                       pp["goal"], " / ".join(me["regions"] or ["广东"]), names,
                       me["total_lessons"], me["total_score"],
                       "、".join(me["cards"]) if me["cards"] else "考点卡"),
            "why": "一条都没有就是一条都没有。拿这边的课给你排一个「%s」的计划，"
                   "是最难被发现的一种假 —— 课程名看着都对，但那是另一场考试的书。" % pp["goal"],
            "have": me}


_NEED_TIP = {
    "date": "还差考试日期。写清楚哪一天，例如「2027-03-15」或「2027年3月15日」。"
            "只说月份不行 —— 哪一天得你自己定，我不替你挑。",
    "minutes": "还差每天能学多久。例如「每天 2 小时」或「每天 120 分钟」。"
               "这个数只能你自己给，我猜出来的就是你做不到的计划。",
    "goal": "没听出你要考什么。说一个名字，例如「专升本」「英语四级」「考研」。",
}


def plan_from_intent(text, today=None, apply=True):
    """听一句话：要么顶回来，要么问清楚，要么真排一张表出来。

    apply=False 时只"预演"：认齐了三样也不写盘，先把话摆出来让人点一下。
    写盘和预演走同一条判断链，所以两边说的话永远一致。
    """
    pp = parse(text, today)
    out = {"parsed": pp}

    if pp["goal_kind"] == "other":
        out.update(_say_not_mine(pp)); return out
    if pp["goal_kind"] == "unknown":
        out.update({"ok": False, "kind": "need_goal", "say": _NEED_TIP["goal"],
                    "need": "goal", "have": pp["have"]}); return out
    quota = pp.get("per_subject") or []
    if not quota:
        if not pp["date"]:
            out.update({"ok": False, "kind": "need_date", "say": _NEED_TIP["date"],
                        "need": "date", "have": pp["have"],
                        "date_from": pp["date_from"]}); return out
        if not pp["minutes_per_day"]:
            out.update({"ok": False, "kind": "need_minutes", "say": _NEED_TIP["minutes"],
                        "need": "minutes", "have": pp["have"],
                        "minutes_from": pp["minutes_from"]}); return out

    if not apply:
        if quota:
            names = "、".join("%s 每天 %d 节" % (x["name"], x["lessons_per_day"]) for x in quota)
            out.update({
                "ok": False, "kind": "ready", "effect_kind": "noop",
                "say": "听清了：%s。要我现在按这个排吗？"
                       "按讲数排，不按总分切 —— 每科每天就这么多，讲比一天长就拆到第二天。" % names,
                "ready": {"per_subject": quota, "exam_date": pp["date"]},
            })
            return out
        out.update({
            "ok": False, "kind": "ready", "effect_kind": "noop",
            "say": "认齐了：%s 考，每天 %d 分钟。要我现在按这个排吗？"
                   "排的时候会按分值权重把时间切给各科，吃不完的从尾部砍，砍掉的每一讲都列出来。" % (
                       pp["date"], pp["minutes_per_day"]),
            "ready": {"exam_date": pp["date"], "minutes_per_day": pp["minutes_per_day"]},
        })
        return out

    r = planner.set_budget(exam_date=pp["date"] or None,
                           minutes_per_day=pp["minutes_per_day"] or None,
                           per_subject=quota or None)
    if not r.get("ok"):
        out.update({"ok": False, "kind": "bad_input", "say": r.get("error") or "这个值我没法用。"})
        return out
    if quota:
        w = planner.plan_week(7)
        days = [x for x in (w.get("days") or []) if x.get("blocks")]
        head = days[0] if days else None
        names = "、".join("%s 每天 %d 节" % (x["name"], x["lessons_per_day"]) for x in quota)
        line = ""
        if head:
            line = "明天就先这样：" + "；".join(
                "%s %d 分钟" % (b.get("subject_name"), b.get("minutes")) for b in head["blocks"]) + "。"
        out.update({
            "ok": True, "kind": "planned", "mode": "quota",
            "say": "认下了：%s。%s一共排了 %d 天，每天合计 %d–%d 分钟。" % (
                names, line,
                len(days),
                min([d["minutes"] for d in days]) if days else 0,
                max([d["minutes"] for d in days]) if days else 0),
            "budget": r.get("budget"), "week": w,
            "date_from": pp["date_from"], "minutes_from": pp["minutes_from"],
            "effect": "每日配额已写进 data/plan.json：" + names,
        })
        return out

    pb = planner.plan_budget()
    out.update({
        "ok": True, "kind": "planned",
        "say": "认下了：%s 考，每天 %d 分钟 —— 还有 %d 天，一共 %d 小时。"
               "按分值权重切给各科，只能吃到 %.0f%%，砍掉 %d 讲（下面一条条列出来了）。" % (
                   pp["date"], pp["minutes_per_day"], pb.get("days_left") or 0,
                   round((pb.get("total_minutes") or 0) / 60.0),
                   (pb.get("coverage") or 0) * 100, pb.get("cut_total") or 0),
        "budget": pb, "date_from": pp["date_from"], "minutes_from": pp["minutes_from"],
        "effect": "考试日期 %s / 每天 %d 分钟 已写进本机" % (pp["date"], pp["minutes_per_day"]),
    })
    return out
