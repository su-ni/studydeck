# -*- coding: utf-8 -*-
"""接手一个空白的人：从一句话开始，一步步把它变成一张能执行的表。

这一层不是聊天框。它是一条有站点的流水线，每一站都留下能核对的东西：

  听 → 查本机 → 缺什么问什么 → 出去找 → 核一遍 → 拟方案 → 等你说行

规矩跟全站一致：
  · 每一站说的话都要有出处（本机有多少讲 / B 站这份课多少 P 多少小时）。
  · 缺的东西就问，不替人填。日期和每天多久只有本人能给。
  · 找回来的东西必须过交叉核对（分集数、总时长两项对不上就不进候选）。
  · 全程不许拿「看起来差不多」的数据顶上 —— 空白就是空白，说清楚为什么空。
"""
import datetime as dt
import json
import re

from . import bili, config, datahub, model_router, planner, store

KV = "intake.state"

# 每一站的耗时写在数据里，前端照着它画进度 —— 不是假动画，是真的按站推进。
STAGES = [
    ("listen", "听懂你说的话", "从你这句里认出考什么、哪天考、每天多久"),
    ("scan", "翻本机有什么", "看这台机器上已经装了哪些课、哪些题、哪些卷子"),
    ("seek", "出去找一遍", "本机没有的，去公开资源里搜候选，看别人的口碑和体量"),
    ("verify", "把它核一遍", "分集数、总时长两项对不上就扔掉 —— 宁可少一个，不放过一个错的"),
    ("draft", "拟一份计划", "按还剩多少天、每天多少分钟，算出能吃下多少、要砍掉哪些"),
]


def _now():
    return store.now()


def _st(key, title, sub, status="pending", log=None):
    return {"key": key, "title": title, "sub": sub, "status": status,
            "log": log or [], "at": _now()}


def _blank_state(text="", files=None):
    return {"id": _now().replace(" ", "T").replace(":", ""),
            "text": text, "files": [str(x)[:80] for x in (files or [])][:8], "stage": 0,
            "stages": [_st(k, t, s) for k, t, s in STAGES],
            "parsed": None, "inventory": None, "candidates": [],
            "need": None, "plan": None, "status": "idle", "say": "",
            "picked": [], "applied": False, "verify_i": 0, "dropped": []}


def load():
    raw = store.kv_get(KV)
    if not raw:
        return None
    try:
        s = json.loads(raw)
    except Exception:
        return None
    return s if isinstance(s, dict) and s.get("stages") else None


def save(s):
    store.kv_set(KV, json.dumps(s, ensure_ascii=False))


def reset():
    store.kv_set(KV, "")
    return {"ok": True, "state": None}


# ------------------------------------------------------------------ 交给模型听
_AI_SYS = (
    "你是一台学习规划系统的「听写员」。用户会用一句或一段口语化的中文说他的考试打算。"
    "你只做一件事：把他话里已经说清的东西抽成 JSON，不要猜、不要补、不要给建议。"
    "字段：goal（要考什么，例如 专升本 / 考研 / 四级；原话没提就 null）、"
    "date（考试日期，归一成 YYYY-MM-DD；今年是 {year} 年，本月是 {month} 月，今天是 {today}。"
    "只有能确定到「日」的时候才填，只能确定到月就填 null 交给 date_ym）、"
    "date_ym（只能确定到年月时填 YYYY-MM，例如「明年三月」→ 次年三月；连年月都没有就 null）、"
    "minutes_per_day（每天能学的分钟数，整数；「两小时」=120，「周一到周五晚上八点到十点」"
    "要按工作日算日均并说明；给不出就 null）、"
    "weekdays_only（true 表示只有工作日能学）、"
    "weak（他自己说的短板科目，没提就 null）、note（一句中文，说明你怎么理解的）。"
    "只输出这个 JSON，不要任何别的字。"
)


def _ai_listen(text, pp):
    """让模型听一遍。返回 (补丁 dict 或 None, 说明 str)。"""
    if not (text or "").strip():
        return None, "没有原话可听"
    ok, why = model_router.available()
    if not ok:
        return None, "模型没接上（%s），这一句只能按关键词认" % why
    today = dt.date.today()
    sys_p = _AI_SYS.format(year=today.year, month=today.month, today=today.isoformat())
    r = model_router.chat(sys_p, text, temperature=0, max_tokens=400, timeout=40)
    if not r.get("ok"):
        return None, "模型这次没回话（%s）" % (r.get("reason") or "未知原因")
    data, _perr = model_router.parse_json(r.get("text") or "")
    if not isinstance(data, dict):
        return None, "模型回的不是 JSON（%s），这一句按关键词认" % (_perr or "解不开")
    out = {}
    g = (data.get("goal") or "").strip() if isinstance(data.get("goal"), str) else ""
    if g:
        out["goal"] = g
    d = (data.get("date") or "").strip() if isinstance(data.get("date"), str) else ""
    if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        try:
            dt.date.fromisoformat(d)
            out["date"] = d
        except Exception:
            pass
    ym = (data.get("date_ym") or "").strip() if isinstance(data.get("date_ym"), str) else ""
    if not out.get("date") and re.match(r"^\d{4}-\d{2}$", ym):
        out["date_ym"] = ym
    mpd = data.get("minutes_per_day")
    if isinstance(mpd, (int, float)) and 5 <= mpd <= 1200:
        out["minutes_per_day"] = int(mpd)
    if data.get("weekdays_only"):
        out["weekdays_only"] = True
    wk = data.get("weak")
    if isinstance(wk, str) and wk.strip():
        out["weak"] = wk.strip()[:20]
    note = data.get("note")
    return out, ("模型听懂了：%s" % (note.strip()[:60] if isinstance(note, str) and note.strip() else "（它没写说明）"))


# ------------------------------------------------------------------ 第一站：听
def _listen(s):
    from . import intent
    text = s.get("text") or ""
    pp = intent.parse(text)                 # 先按关键词认一遍：模型挂了也有底
    patch, aiwhy = _ai_listen(text, pp)
    if patch:
        # 模型认出来的盖掉关键词的 —— 它听得懂「明年三月」，正则听不懂。
        for k, v in patch.items():
            if k in ("date", "minutes_per_day") and pp.get("fixed_%s" % k):
                continue                    # 用户在问句里明确答过的值，不许被原文覆盖
            pp[k] = v
        if pp.get("goal_kind") == "unknown" and pp.get("goal"):
            pp["goal_kind"] = "guess"
    # 只知道年月（「明年三月」）：落到那个月最后一天当锚点，并标明是推的，不是他说的。
    if not pp.get("date") and pp.get("date_ym"):
        try:
            _y, _m = int(pp["date_ym"][:4]), int(pp["date_ym"][5:7])
            _nxt = dt.date(_y + (1 if _m == 12 else 0), 1 if _m == 12 else _m + 1, 1)
            pp["date"] = (_nxt - dt.timedelta(days=1)).isoformat()
            pp["date_assumed"] = True
            pp["date_from"] = pp["date_ym"]
        except Exception:
            pass
    pp["ai"] = {"used": bool(patch), "why": aiwhy,
                "provider": (model_router.current() if patch else None),
                "model": (model_router.model_of() if patch else None)}
    s["parsed"] = pp
    st = s["stages"][0]
    got = []
    if pp.get("goal"):
        got.append("要考「%s」" % pp["goal"])
    if pp.get("date"):
        got.append("考试日期 %s%s" % (
            pp["date"],
            "（你没说具体哪天，按你说的「%s」落到月底推出来的 —— 说准了我就改）" % pp["date_from"]
            if pp.get("date_assumed") else ""))
    if pp.get("minutes_per_day"):
        got.append("每天 %d 分钟" % pp["minutes_per_day"])
    if not got:
        got = ["这句话里没认出考什么、哪天考、每天多久 —— 三样都还空着。"]
    st["log"] = got
    st["log"].append(aiwhy)
    fl = s.get("files") or []
    if fl:
        # 附件只留了名字。本机没有视觉模型，读不了图里的字 —— 这件事要说出来，
        # 不能收了东西装作看懂了。
        st["log"].append("收到 %d 个附件：%s。我只读了文件名 —— 本机没接视觉模型，图里的字读不出来；"                         "要它知道，就在上面用一句话说一遍。" % (len(fl), "、".join(fl[:4])))
    st["status"] = "done"
    return st


# ------------------------------------------------------------------ 第二站：查本机
def _scan(s):
    st = s["stages"][1]
    p = datahub.proto()
    subs = []
    for x in (p.get("subjects") or []):
        subs.append({"id": x.get("id"), "name": x.get("name"),
                     "score": x.get("score") or 0,
                     "lessons": x.get("lessons_total") or 0})
    srcs = []
    try:
        srcs = datahub.item_sources()
    except Exception:
        pass
    ex = (p.get("exam") or {}).get("papers") or []
    voc = (p.get("vocab") or {}).get("lists") or []
    s["inventory"] = {
        "subjects": subs,
        "sources": [{"id": x.get("id"), "name": x.get("name"),
                     "subject": x.get("subject"), "total": x.get("total")} for x in srcs],
        "exam_papers": len(ex), "exam_questions": sum((x.get("total") or 0) for x in ex),
        "vocab_books": [{"name": v.get("name"), "count": v.get("count")} for v in voc],
    }
    n_lesson = sum(x["lessons"] for x in subs)
    n_q = s["inventory"]["exam_questions"] + sum((x["total"] or 0) for x in s["inventory"]["sources"])
    st["log"] = [
        "课程目录：%d 门课、%d 讲" % (len(subs), n_lesson),
        "题库：%d 个题源、%d 题" % (len(s["inventory"]["sources"]), n_q),
        "真题卷：%d 套" % len(ex),
        "词书：%s" % ("、".join("%s（%d 词）" % (v["name"], v["count"] or 0) for v in s["inventory"]["vocab_books"]) or "没有"),
    ]
    if not subs and not s["inventory"]["sources"] and not ex:
        st["log"].append("结论：这台机器上什么都没装 —— 课程、题、卷子、词书，一样都没有。")
    st["status"] = "done"
    return st


# 一组「明显不是课」的词：攻略、择校、分数线这些搜出来播放很高，
# 但点进去是二十分钟的经验分享，不是能排进课表的课。先把它们挡在外面，
# 才不会出现「核了 6 条，6 条都是 UP 主在讲怎么选学校」。
_NOT_COURSE = ("攻略", "怎么选", "如何选", "难度", "排名", "榜单", "经验", "避坑",
               "分数线", "招生", "报名", "政策", "值不值", "后悔", "劝退", "上岸",
               "择校", "志愿", "院校", "专业选择", "要不要", "能不能")
_MIN_SECS = 1200          # 短于 20 分钟的一律不当课：一节课不会这么短


def _subjects_of(s):
    """按什么科目去搜。本机有考纲就用本机的；本机是空的，就用这门考试的公共课。"""
    out = []
    try:
        for x in (datahub.proto().get("subjects") or []):
            if (x.get("score") or 0) > 0 and x.get("name"):
                out.append(x["name"])
    except Exception:
        pass
    if out:
        return out, False
    # 空白实例：本机没有考纲。专升本公共课四门是公开考纲里的，
    # 不是我们编的 —— 但也要在 log 里说明这是按公共课搜的。
    return ["计算机", "英语", "高数", "政治"], True


_PROVINCES = ("广东", "山东", "甘肃", "河南", "河北", "江苏", "浙江", "安徽", "湖北",
              "湖南", "四川", "陕西", "山西", "江西", "福建", "广西", "云南",
              "贵州", "辽宁", "吉林", "黑龙江", "内蒙古", "新疆", "宁夏", "青海",
              "海南", "重庆", "天津", "北京", "上海")


def _scope_of(title, goal):
    """这门课是针对哪个省的。搜出来一堆别省的课是中常态，
    但必须自己说出来 —— 让广东的考生以为甘肃的课能用，是最坏的一种错。"""
    t = title or ""
    mine = None
    for pv in _PROVINCES:
        if pv in t:
            mine = pv
            break
    if mine and goal and mine in goal:
        return mine, True
    if mine:
        return mine, False
    return None, True          # 标题没写省份：全国通用课/说不准，不硬判


def _coursey(x):
    """值不值得核：标题别是经验贴，时长得像一节课。"""
    t = (x.get("title") or "")
    if any(w in t for w in _NOT_COURSE):
        return False
    return (x.get("secs") or 0) >= _MIN_SECS


# ------------------------------------------------------------------ 第三站：出去找
def _seek(s):
    st = s["stages"][2]
    pp = s["parsed"] or {}
    goal = pp.get("goal")
    if pp.get("goal_kind") == "other":
        st["status"] = "skip"
        st["log"] = ["你说的是「%s」，这台机器上一条它的资料都没有。" % goal,
                     "我可以去外面搜，但搜回来的东西要先给你过目 —— 不是我替你决定学哪份。"]
        return st
    if not goal:
        st["status"] = "skip"
        st["log"] = ["还没听出要考什么，没词可搜。"]
        return st
    subs, guessed = _subjects_of(s)
    if guessed:
        st["log"].append("本机没有考纲，我按专升本公共课去搜：%s。" % "、".join(subs))
    seen, raw = set(), 0
    found = []
    for sub in subs:
        kw = "%s %s" % (goal, sub)
        r = bili.search(kw, limit=20)
        if not r.get("ok"):
            st["log"].append("搜「%s」没成：%s" % (kw, r.get("reason") or "原因不明"))
            continue
        n0 = r.get("n") or 0
        raw += n0
        keep = 0
        for x in r["items"]:
            if x["bvid"] in seen:
                continue
            seen.add(x["bvid"])
            if not _coursey(x):
                continue
            pv, fit = _scope_of(x.get("title"), goal)
            found.append(dict(x, source="bili", keyword=kw, subject=sub,
                              scope=pv, scope_fit=fit))
            keep += 1
        st["log"].append("搜「%s」拿到 %d 条，去掉攻略/择校/太短的，留下 %d 条。" % (kw, n0, keep))
    if not found:
        st["status"] = "skip"
        st["log"].append("一条像课的都没找到 —— 这一步不是必须的，本机已有的东西照样能排。")
        return st
    # 按科目分派：每一科各取最长的两条。不这么做的话，六条全被一科里最长的那种
    # 三合一合辑占满，别的科目一条都轮不上 —— 那不是「找到了」，那是被一个 UP 主包场。
    per = {}
    seen_t = set()
    for x in found:
        # 同一个 UP 主把同一门课拆成好几个 BV（基础版/冲刺版/合辑版）是常态，
        # 标题前 12 个字一样就只留最长的那条，否则六个格子被一门课占满。
        key = ((x.get("title") or "")[:12], x.get("subject"))
        if key in seen_t:
            continue
        seen_t.add(key)
        per.setdefault(x.get("subject") or "?", []).append(x)
    for lst in per.values():
        # 同一科里，省份对得上的排前面，写明别省的垫底。
        lst.sort(key=lambda x: (0 if x.get("scope_fit") else 1, -(x.get("secs") or 0)))
    # 轮转取：每科先拿第一条，再每科拿第二条 —— 六条里四科都在，
    # 不会出现「六条全是高数」那种被一科包场的局面。
    picked = []
    rnd = 0
    while len(picked) < VERIFY_MAX:
        added = False
        for sub in list(per.keys()):
            lst = per[sub]
            if rnd < len(lst):
                picked.append(lst[rnd])
                added = True
                if len(picked) >= VERIFY_MAX:
                    break
        if not added:
            break
        rnd += 1
    s["candidates"] = picked[:VERIFY_MAX]
    st["log"].append("合起来 %d 条像课的，%d 个科目各取最长两条，进核对的是 %d 条。"
                     % (len(found), len(per), len(s["candidates"])))
    st["status"] = "done"
    return st


# ------------------------------------------------------------------ 第四站：核一遍
VERIFY_MAX = 6          # 只核前 6 条：一条要打两个接口，全核 20 条这一站就等太久了
VERIFY_BATCH = 2        # 一次 step 核几条。一条要打两个接口（约 0.4~1.2 秒），
                        # 原来一次一条，6 条就要模型调 6 次 intake_step ——
                        # 实测一轮串了 13 轮、302 秒，人以为死机了。


def _verify(s):
    """一次只核一条。分多次调，界面上才看得到「正在核第几条」在动 —— 这不是假动画，
    每一次调用真的打了一组 B 站接口。"""
    st = s["stages"][3]
    cands = s.get("candidates") or []
    if not cands:
        st["status"] = "skip"
        st["log"] = ["没有候选要核。"]
        return st
    done_n = int(s.get("verify_i") or 0)
    todo = cands[:VERIFY_MAX]
    if done_n >= len(todo):
        st["status"] = "done"
        return st
    # 一次核一批（不是一条）：站数少一半，人不用盯着几十秒的转圈。
    for _ in range(VERIFY_BATCH):
        vi = int(s.get("verify_i") or 0)
        if vi >= len(todo):
            break
        _verify_one(s, st, todo, todo[vi])
    if int(s.get("verify_i") or 0) >= len(todo):
        keep = [x for x in todo if x.get("verified")]
        keep.sort(key=lambda x: (-(x.get("titled") or 0), -(x.get("secs") or 0)))
        s["candidates"] = keep
        st["log"].append("核完：%d 条留下，%d 条扔掉。" % (
            len(keep), (s.get("dropped") or []).__len__()))
        st["status"] = "done"
    else:
        st["status"] = "running"
        st["more"] = True       # 告诉 _advance：这一站还没完，下一次接着核
    return st


def _verify_one(s, st, todo, c):
    """核一条候选，把结果写回候选表和这一站的日志。"""
    done_n = int(s.get("verify_i") or 0)
    s["verify_i"] = done_n + 1
    v = bili.verify(c["bvid"])
    short = (c.get("title") or c["bvid"])[:26]
    if v.get("ok"):
        c.update({"pages": v["pages"], "secs": v["secs"], "hours": v["hours"],
                  "titled": v["titled"], "verified": True,
                  "first_parts": v.get("first_parts") or [],
                  "pgs": v.get("pgs") or [],
                  "title": c.get("title") or v.get("title"),
                  "up": c.get("up") or v.get("up")})
        st["log"].append("第 %d/%d 条 · %s —— %d P / %.1f 小时，两项对得上" % (
            done_n + 1, len(todo), short, v["pages"], v["hours"]))
    else:
        st["log"].append("第 %d/%d 条 · %s —— 扔掉：%s" % (
            done_n + 1, len(todo), short, v.get("reason")))
        s["dropped"] = (s.get("dropped") or []) + ["%s %s" % (c["bvid"], short)]
    # 一条一报：界面上的「正在核第几条」是真数，不是转圈动画。
    try:
        from . import tools as _t
        _t.tick(st["log"][-1], n=done_n + 1, total=len(todo))
    except Exception:
        pass
    return c


# ------------------------------------------------------------------ 第五站：拟计划
def _draft(s):
    st = s["stages"][4]
    pp = s["parsed"] or {}
    days = pp.get("date")
    mpd = pp.get("minutes_per_day")
    if not days or not mpd:
        st["status"] = "skip"
        st["log"] = ["日期或每天时长还没给，算不出来 —— 这时候算出来的都是编的。"]
        return st
    left = (dt.date.fromisoformat(days) - dt.date.today()).days
    if left <= 0:
        st["status"] = "skip"
        st["log"] = ["考试日期 %s 已经过了（今天 %s）。" % (days, dt.date.today().isoformat())]
        return st
    budget_min = left * mpd
    hours = round(budget_min / 60.0, 1)
    # 本机现有的能吃多少
    inv = s.get("inventory") or {}
    local_hours = 0.0
    try:
        for x in (datahub.proto().get("subjects") or []):
            for l in (x.get("lessons") or []):
                local_hours += (l.get("dur") or 0) / 3600.0
    except Exception:
        pass
    pick_hours = sum((c.get("hours") or 0) for c in (s.get("candidates") or [])
                     if c.get("bvid") in (s.get("picked") or []))
    all_pick_hours = sum((c.get("hours") or 0) for c in (s.get("candidates") or []))
    week = _week(days, mpd, left, picked=s.get("picked") or [],
                 cands=s.get("candidates") or [])
    s["plan"] = {
        "exam_date": days, "minutes_per_day": mpd, "days_left": left,
        "budget_hours": hours, "local_hours": round(local_hours, 1),
        "pick_hours": round(pick_hours, 1),
        "all_pick_hours": round(all_pick_hours, 1),
        "coverage_local": (round(min(1.0, hours / local_hours), 3) if local_hours else 0),
        "coverage_pick": (round(min(1.0, hours / (pick_hours or all_pick_hours)), 3)
                          if (pick_hours or all_pick_hours) else 0),
        "week": week,
    }
    st["log"] = ["还有 %d 天 × 每天 %d 分钟 = %d 小时可支配。" % (left, mpd, round(hours)),
                 "本机现有的课一共 %.1f 小时。" % local_hours]
    if local_hours:
        st["log"].append("按这个预算，本机的课能吃到 %.0f%%。" % (s["plan"]["coverage_local"] * 100))
    misfit = [c for c in (s.get("candidates") or [])
              if c.get("bvid") in (s.get("picked") or []) and c.get("scope_fit") is False]
    if pick_hours:
        st["log"].append("你挑的课一共 %.1f 小时，占预算 %.0f%%。" % (
            pick_hours, s["plan"]["coverage_pick"] * 100))
    if misfit:
        st["log"].append("注意：%s 这几门标题上写着别的省，考纲不一定对得上 —— 我不替你删，但要说出来。"
                         % "、".join((c.get("title") or c["bvid"])[:12] for c in misfit))
    elif all_pick_hours:
        st["log"].append("找到的候选一共 %.1f 小时 —— 还没挑，先看下面。" % all_pick_hours)
    else:
        st["log"].append("本机没有课，外面也没挑中 —— 这张表会只有单词和复习。")
    # 数算完了，再让模型用一句人话说这张表合不合理 —— 数字它一个都不许改。
    why = _ai_review(s, pp, left, hours, local_hours)
    if why:
        s["plan"]["why"] = why
        st["log"].append("模型看了一遍：" + why)
    st["status"] = "done"
    return st


def _ai_review(s, pp, left, hours, local_hours):
    """让模型给一句判断（不改数字）。拿不到就返回空串，不编。"""
    ok, _why = model_router.available()
    if not ok:
        return ""
    plan = s.get("plan") or {}
    pk = s.get("picked") or []
    cands = [c for c in (s.get("candidates") or []) if c.get("bvid") in pk]
    fact = {
        "原话": (s.get("text") or "")[:300],
        "考试日期": plan.get("exam_date"),
        "还有天数": left,
        "每天分钟": pp.get("minutes_per_day"),
        "总预算小时": hours,
        "本机现有课小时": round(local_hours, 1),
        "本机覆盖率": plan.get("coverage_local"),
        "从外面挑的课": [{"标题": (c.get("title") or "")[:40],
                          "小时": c.get("hours"),
                          "分集": len(c.get("pgs") or []),
                          "省份对得上": c.get("scope_fit")} for c in cands],
    }
    sys_p = ("你是学习计划审核员。下面是一份已经算好的计划数据（数字都是系统算的，不许改）。"
             "用不超过 70 个汉字说一句人话：这个预算够不够、该先保哪门、哪里明显不现实。"
             "只输出这句话本身，不要 JSON、不要分点、不要客套。")
    r = model_router.chat(sys_p, json.dumps(fact, ensure_ascii=False),
                          temperature=0.3, max_tokens=200, timeout=40)
    if not r.get("ok"):
        return ""
    t = (r.get("text") or "").strip().replace("\n", " ")
    return t[:120]


def _week(exam_date, mpd, left, days=7, picked=None, cands=None):
    """七天预览：不算花活 —— 每天 mpd 分钟，按挑中的课的分集顺序往下推，
    每块写明是哪门课的哪一集、第几分钟到第几分钟。推不动了就说推不动。"""
    picked = picked or []
    cands = [c for c in (cands or []) if c.get("bvid") in picked]
    # 把每门课的分集摊成一条长带：[(课名, 集号, 集名, 秒数)]
    belt = []
    for c in cands:
        nm = (c.get("title") or c["bvid"])[:18]
        pgs = c.get("pgs") or []
        if not pgs:
            continue
        for g in pgs:
            belt.append({"course": nm, "page": g.get("page"),
                         "part": (g.get("part") or "")[:24],
                         "secs": g.get("secs") or 0})
    out = []
    today = dt.date.today()
    cur = 0
    for i in range(min(days, left)):
        d = today + dt.timedelta(days=i)
        blocks = []
        got = 0
        while got < mpd and cur < len(belt):
            g = belt[cur]
            need = int(round((g["secs"] or 0) / 60.0))
            if need <= 0:
                cur += 1
                continue
            take = min(need, mpd - got)
            blocks.append({"course": g["course"], "page": g["page"],
                           "part": g["part"], "minutes": take})
            if take >= need:
                cur += 1           # 这一集放完了
            else:
                belt[cur] = dict(g, secs=(need - take) * 60)   # 剩下的留给明天
            got += take
        out.append({"date": d.isoformat(), "wd": "一二三四五六日"[d.weekday()],
                    "minutes": mpd, "filled": got, "is_today": i == 0,
                    "blocks": blocks})
    return out


_RUN = {"listen": _listen, "scan": _scan, "seek": _seek, "verify": _verify, "draft": _draft}


def _advance(s, upto=None):
    """往前推站。一次只推一站，前端才画得出真进度。"""
    i = s.get("stage") or 0
    order = [x[0] for x in STAGES]
    if upto:
        i = min(i, order.index(upto))
    while i < len(order):
        key = order[i]
        st = s["stages"][i]
        if st["status"] in ("done", "skip"):
            i += 1
            continue
        st["status"] = "running"
        st.pop("more", None)
        # 报一句「现在在第几站、这一站在干什么」。seek 那一站要连着搜五科，
        # 二十几秒没有一句话，界面上就跟卡死没区别（2026-10-26 用户当场这么说的）。
        try:
            from . import tools as _t
            _t.tick("第 %d/%d 站 · %s —— %s" % (i + 1, len(order), STAGES[i][1], STAGES[i][2]),
                    n=i + 1, total=len(order))
        except Exception:
            pass
        try:
            _RUN[key](s)
        except Exception as e:
            st["status"] = "fail"
            st["log"] = ["这一站出错了：%s" % (str(e)[:160] or e.__class__.__name__)]
        if st.pop("more", False):
            # 这一站还要接着跑（例如一条一条核候选）—— 下一次调用继续，不推进站号
            s["stage"] = i
            return s
        if st["status"] == "running":
            st["status"] = "done"
        i += 1
        s["stage"] = i
        return s
    s["stage"] = i
    return s


def _settle(s):
    """推完站之后：要么等用户补一句，要么把候选摆出来。"""
    pp = s["parsed"] or {}
    s["status"] = "waiting"
    # 还有站没跑完就先别问也别摆候选 ——
    # 那时候连「本机有什么」「外面找到什么」都不知道，摆出来的候选就是凭空来的。
    if (s.get("stage") or 0) < len(STAGES):
        s["status"] = "working"
        s["need"] = None
        s["say"] = ""
        return s
    s["need"] = None
    s["say"] = ""
    if pp.get("goal_kind") == "unknown":
        s["need"] = "goal"
        s["say"] = "我还不知道你要考什么。说一个名字就行 —— 你说了，我才知道去哪儿给你找。"
        return s
    if pp.get("goal_kind") == "other":
        s["need"] = "confirm_goal"
        s["say"] = ("「%s」这台机器上没有。我可以去外面给你找课，也可以什么都先不做。"
                    "你说一声：去找，还是算了。" % pp.get("goal"))
        return s
    if not pp.get("date"):
        s["need"] = "date"
        s["say"] = "还差一句：哪天考？写成 2027-03-15 这样，或者说「明年 3 月 15 号」。"
        return s
    if not pp.get("minutes_per_day"):
        s["need"] = "minutes"
        s["say"] = "还差一句：每天能学多久？两小时、90 分钟都行 —— 这个数只有你自己知道。"
        return s
    plan = s.get("plan") or {}
    if plan and s.get("picked"):
        # 已经挑完了：这时候该把「排出来什么样、差多少」说清楚，让人点头落盘。
        cov = plan.get("coverage_local") or 0
        s["need"] = "apply"
        s["say"] = ("排完了：还有 %s 天 × 每天 %s 分钟 = %s 小时可用，"
                    "本机那些课按这个预算能吃下 %d%%。要落盘就说一句，我等你点头。"
                    % (plan.get("days_left"), plan.get("minutes_per_day"),
                       plan.get("budget_hours"), round(cov * 100)))
        s["status"] = "choosing"
        return s
    if plan:
        s["need"] = "pick"
        s["say"] = ("排出草表了：%s 小时预算，本机的课按这个预算能吃下 %d%%。"
                    "下面这些是我在外面找到的，挑要学哪些 —— 挑完我重排一遍。"
                    % (plan.get("budget_hours"), round((plan.get("coverage_local") or 0) * 100)))
        s["status"] = "choosing"
        return s
    s["need"] = "pick"
    s["say"] = "三样齐了。下面是我找到的，你挑要学哪些 —— 挑完我才排。"
    s["status"] = "choosing"
    return s


def start(text, today=None, files=None):
    s = _blank_state(text, files)
    save(s)
    _advance(s)                        # 第一站：听
    _advance(s)                        # 第二站：翻本机 —— 用户立刻能看到有东西在动
    _settle(s)
    save(s)
    return {"ok": True, "state": s}


def step():
    s = load()
    if not s:
        return {"ok": False, "reason": "还没有开始过。先说一句话。"}
    _advance(s)
    if s["stage"] >= len(STAGES):
        _settle(s)
    save(s)
    return {"ok": True, "state": s}


def reply(field=None, value=None, text=None):
    """用户补一句。field 为 date / minutes 时直接把值并进原话再重听一遍。"""
    s = load()
    if not s:
        return {"ok": False, "reason": "还没有开始过。"}
    if text:
        s["text"] = ((s.get("text") or "") + " " + text).strip()
    if field == "date" and value:
        s["text"] = ((s.get("text") or "") + " 考试日期 " + str(value)).strip()
        # 直接写进原话不一定认得出来，所以另存一份确定的
        s["fixed_date"] = str(value)
    if field == "minutes" and value:
        s["text"] = ((s.get("text") or "") + " 每天 " + str(value) + " 分钟").strip()
        s["fixed_minutes"] = int(value)
    if field == "goal" and value:
        s["text"] = ((s.get("text") or "") + " " + str(value)).strip()
    # 重听：把已经确定的日期/时长钉住，不再被正则覆盖
    _listen(s)
    pp = s["parsed"] or {}
    if s.get("fixed_date"):
        pp["date"] = s["fixed_date"]
    if s.get("fixed_minutes"):
        pp["minutes_per_day"] = int(s["fixed_minutes"])
    s["parsed"] = pp
    for i, (k, _t, _s2) in enumerate(STAGES):
        if i >= 2:
            s["stages"][i] = _st(k, _t, _s2)
    s["stage"] = 2
    s["applied"] = False
    _settle(s)
    save(s)
    return {"ok": True, "state": s}


def pick(bvids=None):
    """记下「这几门我想入库」。

    **它不写课程库。** 2026-10-26 出的那件事就是因为这一点被藏了起来：
    界面上一个按钮写着「入库高数 + C 语言」，tool 却是 intake_pick ——
    点完返回 ok=True，前端照 ok 打了「已执行」，人以为课进去了，
    结果 list_subjects 还是空的。所以这里必须自己把「还没入库」说出来（effect），
    让任何照 ok 判断成功与否的调用方都能看到它到底做了什么。
    """
    s = load()
    if not s:
        return {"ok": False, "reason": "还没有开始过。"}
    before = list(s.get("picked") or [])
    s["picked"] = [x for x in (bvids or []) if isinstance(x, str)]
    # 候选集变了，核对进度必须归零 —— 否则上一次「已经核了 6 条」的计数
    # 会套到这次只剩 1 条的候选上，_verify 直接判 done，人看到的是原地打转。
    s["verify_i"] = 0
    for i, (k, _t, _s2) in enumerate(STAGES):
        if i >= 4:
            s["stages"][i] = _st(k, _t, _s2)
    st3 = s["stages"][3]
    if all(c.get("verified") for c in (s.get("candidates") or [])) and s.get("candidates"):
        st3["status"] = "done"
    elif st3.get("status") != "running":
        st3["status"] = "done"    # 候选都已核过（pick 前就核完了）
    s["stage"] = min(s["stage"], 4)
    _advance(s)
    _settle(s)
    save(s)
    picked = list(s.get("picked") or [])
    return {"ok": True, "picked": picked, "state": s,
            # effect_kind=noop：这次调用真的执行了，但没改动任何用户能看见的东西。
            # 界面靠它把「记了一笔」画成中性提示，而不是打勾的绿色成功。
            "effect_kind": "noop",
            # 这句会原样显示在按钮旁边（纯文本，不过 Markdown），所以别写星号。
            "effect": ("只记下了要入库这 %d 门（%s），课程库还没动；"
                       "真要进去得用 course_add 或 intake_apply。"
                       % (len(picked), "、".join(picked) or "空")) if picked else
                      "把选择清空了（原来有 %d 门），课程库没动。" % len(before),
            "note": "这一步只改流水线里记下的选择，不写课程库。"}


def apply():
    """认下：写预算，并把挑中的课真正写进本机课程库。

    以前这里只 kv_set("intake.courses") —— 全仓零处读它，人看到「认下了」，
    下一句 list_subjects 照样空、pick_lesson 直接「没有这个讲次: 1」。
    现在落库走 tools.course_add（与模型手调同一条路），失败要点名，不许假装成功。
    """
    s = load()
    if not s:
        return {"ok": False, "reason": "还没有开始过。"}
    pp = s["parsed"] or {}
    if not pp.get("date") or not pp.get("minutes_per_day"):
        return {"ok": False, "reason": "日期或每天时长还空着，写不进一张能执行的表。"}
    r = planner.set_budget(exam_date=pp["date"], minutes_per_day=int(pp["minutes_per_day"]))
    if not r.get("ok"):
        return {"ok": False, "reason": r.get("error") or "预算写不进去。"}
    picked = [c for c in (s.get("candidates") or []) if c.get("bvid") in (s.get("picked") or [])]
    store.kv_set("intake.courses", json.dumps(picked, ensure_ascii=False))

    # 真落库。course_add 是 PERM_CONFIRM，但用户点「认下」本身就是那次确认；
    # 这里直接调它的实现，不走 perm 闸（否则会在闸里再问一遍）。
    from . import tools as _tools
    added, failed = [], []
    for c in picked:
        try:
            # subject 传候选自己带的科目名（「高等数学」）。原来传的是 c["bvid"]，
            # 结果每门课都被当成一个新科目，库里冒出 id 叫 BV1xxx 的「科目」，
            # 而且同一门高数存成了两份。course_add 会把中文名归到规范 id。
            got = _tools.t_course_add(bvid=c.get("bvid"), name=c.get("title"),
                                      subject=c.get("subject") or None, score=None)
        except Exception as e:
            got = {"ok": False, "reason": str(e)}
        if got.get("ok"):
            added.append("%s（%d 讲 / %.0f 分钟）" % (
                got.get("name"), got.get("lessons") or 0, got.get("minutes") or 0))
        else:
            failed.append("%s：%s" % (c.get("bvid"), got.get("reason")))

    s["applied"] = True
    s["status"] = "done"
    if added and not failed:
        s["say"] = "认下了，%d 门课已经写进本机课程库：%s。计划在课表页，随时可以回来改。" % (
            len(added), "；".join(added))
    elif added and failed:
        s["say"] = "预算写好了，%d 门课入库：%s。另外 %d 门没进去（%s），已经照实记下。" % (
            len(added), "；".join(added), len(failed), "；".join(failed))
    elif failed:
        s["say"] = "预算写好了，但课一门都没进课程库：%s。课还是外面那条链接，先别当它能上课。" % (
            "；".join(failed))
    else:
        s["say"] = "预算写好了。你没挑课，所以课程库没动 —— 挑一门我再入库。"
    save(s)
    store.add_event("intake_apply", payload="%s %s 分钟 挑%d门 入库%d门" % (
        pp.get("date"), pp.get("minutes_per_day"), len(picked), len(added)))
    out = {"ok": True, "state": s, "budget": planner.plan_budget(),
           "courses_added": added, "courses_failed": failed,
           # say 原来只写进了 state，返回值里没有 —— 界面拿不到就只能自己编一句。
           "say": s["say"], "effect": s["say"]}
    return out
