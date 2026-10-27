# -*- coding: utf-8 -*-
"""研学台 · 工具层。

设计稿里的 TOOLS 只是一张清单（logTool 只往数组里塞个名字）。
这里把它们做成真函数：真读数据、真算、真落库、真返回。

每个工具返回 dict，main.py 会补上 ok / ts / perm / ms / note。
工具自身永远不抛给前端——出错就返回 ok=False + error，别把 500 甩到界面上。
"""
import datetime as dt
import io
import json
import os
import re
import sqlite3
import threading
import time
import uuid

from . import (agent, bcz, bili, config, context, datahub, decider, evidence, explain,
               intake, intent, model_router, notesrc, perm, planner, platform_ai,
               store, websearch, writing, xmind)

REGISTRY = {}

# 「我正在干什么」的出口。工具在慢循环里调 tick()，外面挂着的监听方（卡片按钮的
# 流式通道、agent 的 sink）就能把这一句实时推到界面上。
# 用 threading.local：同一个进程里可能同时有对话在跑、有按钮在点，两边的进度不能串。
_PROG = threading.local()


def tick(msg, **kw):
    """报一句进度。没有监听方就什么都不做（不是假装有进度）。"""
    cb = getattr(_PROG, "cb", None)
    if not cb:
        return
    try:
        d = {"msg": str(msg)[:180]}
        d.update({k: v for k, v in kw.items() if isinstance(v, (int, float, str, bool))})
        cb(d)
    except Exception:
        pass


def tool(name, perm, desc):
    def deco(fn):
        REGISTRY[name] = {"name": name, "perm": perm, "desc": desc, "fn": fn}
        return fn
    return deco


# ---------------------------------------------------------------- 自报成效的兜底
# 这些工具**会改本机状态**，所以必须自己说清「改了什么」。
# 少说一句就等于前端只能拿 ok:true 编一个绿勾 —— 用户当场骂过这件事
# （"做完了为什么这个做完了是假的"），所以宁可在界面上点名，也不许默认成功。
_WRITE_TOOLS = frozenset([
    # 要二次确认的
    "add_words_to_review", "agent_reset", "ai_forget", "course_add", "course_add_many",
    "intake_apply",
    "mark_lesson_done", "note_del", "plan_from_sentence", "plan_set_budget",
    "restore_backup", "source_drop", "source_import", "sync_pull", "sync_xuecheng",
    # 直接写库 / 写盘的
    "bili_logout", "cache_asset", "fetch_word_detail", "finish_lesson", "grade_answer",
    "grade_word", "log_playback", "make_backup", "note_pull_xmind", "note_push_src",
    "note_save", "note_src_cfg", "note_src_pull", "pick_lesson", "pick_question_part",
    "pick_word_mode", "plan_today", "rate_explain", "save_note", "session_archive",
    "session_new", "shot_del", "shot_rename", "shot_save", "shot_tag", "star_word",
    "fav_sentence", "submit_exam", "tag_error", "writing_grade", "ai_login",
    "bili_login_poll",
    # 拉词书会往 data/vocab_extra.json 加一本真词书（不登记就等于可以空口说"拉进来了"）
    "vocab_pull",
    # 设置页：填自己的 Key、清空整个平台、断开 XMind，都是真动本机文件/库
    "ai_apikey_set", "ai_apikey_clear", "platform_reset", "xmind_disconnect",
    # 拉卷会写 data/papers_extra.json；生题会写 data/gen_questions.json
    "paper_pull", "quiz_gen", "paper_drop", "paper_make",
])


def _ensure_report(name, data, ok):
    """写盘工具没自报成效时，明确标记「没说改了什么」，不留给前端去猜。

    只补一个标记和一句话，绝不替它编数字 —— 编出来的成效正是上一轮翻车的原因。
    """
    if not ok or not isinstance(data, dict):
        return data
    if name not in _WRITE_TOOLS:
        return data
    if data.get("say") or data.get("effect"):
        return data
    data["effect_kind"] = "unknown"
    data["say"] = "跑完了，但它没说自己改了哪儿 —— 别当成改成功了，按情况再核一遍。"
    return data


def registry_public():
    return [{"name": v["name"], "perm": v["perm"], "desc": v["desc"]}
            for v in REGISTRY.values()]


def safe_media_path(rel):
    """把前端给的相对路径锁死在项目根目录内（防目录穿越）。"""
    base = os.path.abspath(config.PROJECT_ROOT)
    p = os.path.abspath(os.path.join(base, rel.replace("/", os.sep)))
    if not (p == base or p.startswith(base + os.sep)):
        raise ValueError("非法路径: %s" % rel)
    return p


def _cls(sid):
    # 学科配色跟着数据走：新学科不用在代码里登记颜色（以前这张表是写死的）
    return datahub.CLS.get(sid, "cs")


def _pick_subject(subject):
    """不传 subject 时**不再默默落到英语**。

    以前默认参数是 subject="english"，切到政治点课程库，返回的还是英语的讲次——
    界面上五科，骨子里一台英语机，就是这么来的。
    现在：传了就用传的；没传就按「已上过课的科目 → 双学分最高的科目」推一个，
    并在返回值里写明 why，让用户看得见它是**怎么挑的**。
    """
    p = datahub.proto()
    if subject:
        sub = datahub.subject(p, subject)
        if not sub:
            return None, "没有这个科目: %s" % subject
        return sub, None
    done = datahub.done_ids()
    for s in p.get("subjects") or []:
        if datahub.subject_progress(p, s, done)["lessons_done"] > 0:
            return s, "没传科目，按「已经上过课的科目」推：%s" % s["name"]
    cands = [s for s in (p.get("subjects") or []) if s.get("score")]
    if cands:
        s = sorted(cands, key=lambda x: -(x.get("score") or 0))[0]
        return s, "没传科目，按「学分最高的科目」推：%s" % s["name"]
    return None, "没有任何科目数据"


# ========================================================== 讲次 / 课堂
@tool("get_current_lesson", config.PERM_LOCAL, "取当前讲次与断点位置")
def t_current_lesson(subject=None, **_):
    """当前这一讲 = 用户最近动过的那一讲；没动过才回落到「下一讲」。

    以前这里只认 derive_next 推出来的 next，pick_lesson 写进 lesson_progress
    的那一条根本不读 —— 结果就是用户点目录里别的 P，界面纹丝不动。
    pick_lesson 不是「记个笔记」，它语义上就是「我现在要学这一讲」。
    """
    sub, why = _pick_subject(subject)
    if not sub:
        return {"error": why}
    p = datahub.proto()
    done = datahub.done_ids()
    sp = datahub.subject_progress(p, sub, done)
    nxt = sp["next"]
    # 先看人真正动过哪儿（pick / 播放 / 截帧都会更新 updated_ts）
    rec = store.recent_lesson(sub["id"])
    lesson = nxt
    how = "derive_next"
    # ① 用户明确点过的那一讲（pick_lesson 落 kv）优先 —— 这是「我现在要学这个」，
    #    不能再被 derive_next 按教学顺序推回去。
    picked = store.kv_get("cur_lesson:" + sub["id"])
    if picked:
        owner, hit = datahub.find_lesson(p, picked)
        if hit and owner and owner.get("id") == sub["id"]:
            lesson = hit
            how = "picked"
    # ② 没点过就看最近动过的（播放 / 截帧 / 标记都会刷新 updated_ts）
    if how == "derive_next" and rec:
        owner, hit = datahub.find_lesson(p, rec["lesson_id"])
        # 只认属于这个科目的讲次：库里可能有别的科目留下的行
        if hit and owner and owner.get("id") == sub["id"]:
            lesson = hit
            how = "recent"
    pos = store.get_lesson(lesson["id"]) if lesson else None
    return {
        "subject": {"id": sub["id"], "name": sub["name"], "score": sub.get("score"),
                    "video_up": sub.get("video_up"), "mode": sub.get("mode"),
                    "cover": sub.get("cover"), "cls": _cls(sub["id"])},
        "subject_why": why,
        "lesson": lesson,
        "picked_by": how,
        "pos_sec": (pos or {}).get("pos_sec") or 0,
        "status": (pos or {}).get("status"),
        "lessons_done": sp["lessons_done"],
        "lessons_total": sp["lessons_total"],
        "done": [d["id"] for d in sp["done"]],
        "source": "SQLite 事件库 + progress.json",
    }


@tool("list_subjects", config.PERM_LOCAL, "列出全部科目与进度")
def t_list_subjects(**_):
    p = datahub.proto()
    done = datahub.done_ids()
    out = []
    for s in p.get("subjects") or []:
        sp = datahub.subject_progress(p, s, done)
        out.append({"id": s["id"], "name": s["name"], "score": s.get("score"),
                    "kind": s.get("kind"), "cls": _cls(s["id"]),
                    # 每门课自己的封面/B站号/UP主：以前这里没带出来，界面只能全用一张占位图
                    "cover": s.get("cover"), "bvid": s.get("bvid"),
                    "video_up": s.get("video_up"), "video_pages": s.get("video_pages"),
                    "video_title": s.get("video_title"),
                    "lessons_done": sp["lessons_done"],
                    "lessons_total": sp["lessons_total"],
                    "next": sp["next"]})
    out.sort(key=lambda x: -(x["score"] or 0))
    return {"subjects": out}


@tool("list_lessons", config.PERM_LOCAL, "列某科目的讲次目录（按章分组）")
def t_list_lessons(subject=None, **_):
    sub, why = _pick_subject(subject)
    if not sub:
        return {"error": why}
    p = datahub.proto()
    sid = sub["id"]
    done = datahub.done_ids(sid)
    idx = (p.get("wordmap") or {}).get("lesson_index") or {}
    chapters, order = {}, []
    for l in sub.get("lessons") or []:
        c = l.get("chapter") or "未分组"
        if c not in chapters:
            chapters[c] = []
            order.append(c)
        chapters[c].append({
            "id": l.get("id"), "title": l.get("title"), "dur": l.get("dur") or 0,
            "page": l.get("page"), "done": l.get("id") in done,
            "is_word_lesson": l.get("id") in idx,
            "group": idx.get(l.get("id")),
            "local": bool(l.get("local")),
        })
    return {"subject": sub["id"], "name": sub["name"], "subject_why": why,
            "chapters": order,
            "groups": [{"chapter": c, "lessons": chapters[c]} for c in order],
            "lessons_total": len(sub.get("lessons") or []),
            "lessons_done": len(done)}


@tool("list_lesson_words", config.PERM_LOCAL, "本讲词群与时间锚点（只给单词课）")
def t_lesson_words(lesson_id=None, **_):
    if not lesson_id:
        return {"is_word_lesson": False, "count": 0, "words": [],
                "reason": "没指定讲次"}
    r = datahub.lesson_words(lesson_id)
    if not r["is_word_lesson"]:
        r["content"] = datahub.lesson_content(lesson_id)
    return r


@tool("list_lesson_content", config.PERM_LOCAL, "非词汇讲次的内容面（考点/题库/卡片）")
def t_lesson_content(lesson_id=None, **_):
    if not lesson_id:
        return {"error": "没指定讲次"}
    return datahub.lesson_content(lesson_id)


@tool("pick_lesson", config.PERM_LOCAL, "选定要上的科目与讲次（写进度）")
def t_pick_lesson(lesson_id=None, subject=None, **_):
    if not lesson_id:
        return {"error": "没指定讲次"}
    p = datahub.proto()
    sub, les = datahub.find_lesson(p, lesson_id)
    if not les:
        return {"error": "没有这个讲次: %s" % lesson_id}
    rec = store.set_lesson(lesson_id, subject or sub["id"], status=None)
    # 显式记一笔「用户在学这一讲」。lesson_progress 是按 updated_ts 排序的，
    # 播放/截帧也会刷新它 —— 只靠那张表分不清「我点了」和「我在这讲过话」。
    # 这一条才是「现在要学哪一讲」的权威，get_current_lesson 优先读它。
    store.kv_set("cur_lesson:" + sub["id"], lesson_id)
    store.add_event("pick_lesson", subject=sub["id"], lesson_id=lesson_id)
    _say = "现在在学「%s」（%s）。这一讲记成了当前讲次，切走再回来还是它。" % (
        les.get("title") or lesson_id, (sub or {}).get("name") or sub["id"])
    return {"lesson": les, "subject": sub["id"], "progress": rec,
            "say": _say, "effect": "cur_lesson %s -> %s" % (sub["id"], lesson_id),
            "content": datahub.lesson_content(lesson_id)}


@tool("log_playback", config.PERM_LOCAL, "上报播放位置与本段实看秒数（真实计时，不是视频长度）")
def t_log_playback(lesson_id=None, pos_sec=0, seconds=0, **_):
    if not lesson_id:
        return {"error": "没指定讲次"}
    rec = store.set_lesson(lesson_id, status="doing", pos_sec=pos_sec)
    sec = max(0.0, round(float(seconds or 0), 1))
    store.add_event("play", lesson_id=lesson_id, seconds=sec,
                    payload="pos=%.0f" % float(pos_sec or 0))
    return {"progress": rec, "seconds": sec,
            "say": "记了 %.1f 秒播放（停在 %d:%02d）。这条会计进真实投入时长。" % (
                sec, int(float(pos_sec or 0)) // 60, int(float(pos_sec or 0)) % 60),
            "effect": "+%.1fs playback" % sec}


@tool("lesson_play_time", config.PERM_LOCAL, "本机真实投入时长：总计/今日/分来源/看过的讲次")
def t_lesson_play_time(**_):
    ls = store.learning_seconds()
    rows = store.lesson_play_rows()
    titled = []
    for r in rows:
        les = datahub.find_lesson(datahub.proto(), r["lesson_id"])[1] or {}
        titled.append({"lesson_id": r["lesson_id"],
                       "title": les.get("title") or r["lesson_id"],
                       "seconds": r["seconds"], "last_ts": r["last_ts"]})
    return {"total": ls["total"], "today": ls["today"], "by_kind": ls["by_kind"],
            "lessons": titled,
            "note": "只统计事件里真的带了秒数的部分（看视频 + 考场计时），没记到的就是没有，不估算"}


@tool("mark_lesson_done", config.PERM_CONFIRM, "把讲次标记为已完成（回写进度文件）")
def t_mark_done(lesson_id=None, subject=None, **_):
    if not lesson_id:
        return {"error": "没指定讲次"}
    tick("查这一讲是哪门课的", n=1, total=3)
    p = datahub.proto()
    sub, les = datahub.find_lesson(p, lesson_id)
    title = (les or {}).get("title") or lesson_id
    tick("写进本机进度库", n=2, total=3)
    store.set_lesson(lesson_id, subject or (sub or {}).get("id"), status="done")
    store.add_event("lesson_done", subject=(sub or {}).get("id"), lesson_id=lesson_id)
    tick("同步回 progress.json", n=3, total=3)
    r = sync_progress_file()
    ch = r.get("changed") or []
    if ch:
        say = "标成完成了：%s。本机进度库 + progress.json 都写了（备份在 data/backup）。" % title
    else:
        say = "标成完成了：%s。本机进度库写了，progress.json 里本来就是完成状态，没重写。" % title
    return {"lesson_id": lesson_id, "written": r, "title": title,
            "say": say, "effect": "done %s%s" % (lesson_id, " +progress.json" if ch else "")}


def sync_progress_file():
    """把本机已完成的讲次并回 workbench/data/progress.json（先备份）。"""
    path = config.PROGRESS_JSON
    os.makedirs(config.PROGRESS_BACKUP_DIR, exist_ok=True)
    p = datahub.progress() or {}
    sections = p.get("sections") or {}
    changed = []
    for r in store.lessons_done():
        lid = r["lesson_id"]
        if (sections.get(lid) or {}).get("status") != "done":
            sections[lid] = {"status": "done",
                             "at": (r.get("updated_ts") or store.today())[:10]}
            changed.append(lid)
    if not changed:
        return {"changed": [], "note": "没有新完成的讲次，未写盘"}
    bak = os.path.join(config.PROGRESS_BACKUP_DIR,
                       "progress.json.bak_%s" % dt.datetime.now().strftime("%Y%m%d_%H%M%S"))
    with io.open(path, encoding="utf-8") as f:
        raw = f.read()
    with io.open(bak, "w", encoding="utf-8") as f:
        f.write(raw)
    p["sections"] = sections
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(p, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return {"changed": changed, "backup": bak, "path": path}


# ========================================================== 今日编排
@tool("plan_today", config.PERM_LOCAL, "按断点/到期/未开科目生成今日编排")
def t_plan_today(**_):
    p = datahub.proto()
    done = datahub.done_ids()
    rows = []

    # 1) 断点续学：**任何**一科里最近动过、还没上完的那一讲（不再只看英语）
    cur = None
    for s in p.get("subjects") or []:
        sp = datahub.subject_progress(p, s, done)
        nxt = sp["next"]
        if not nxt:
            continue
        pos = store.get_lesson(nxt["id"]) or {}
        touched = pos.get("updated_ts") or ""
        if cur is None or touched > (cur[2] or ""):
            cur = (s, nxt, touched, pos)
    if cur:
        s, nxt, _touched, pos = cur
        p_sec = pos.get("pos_sec") or 0
        rows.append({
            "cls": _cls(s["id"]), "title": "继续上一讲 · " + (nxt.get("title") or ""),
            "meta": "%s · %s · %s%s" % (s["name"], nxt.get("chapter") or "—",
                                         "%d 分钟" % round((nxt.get("dur") or 0) / 60),
                                         ("，上次看到 %d:%02d" % (p_sec // 60, p_sec % 60)) if p_sec else "，还没开始"),
            "action": "开始", "page": "classroom", "subject": s["id"],
            "lesson_id": nxt.get("id"),
        })

    # 2) 到期复习：SQLite 里的到期词
    # 只在真有词可背的时候才给这一行。空库（没有词表 / 没有到期）时这一行会变成
    # 「背一组词 ·  0 词 · 到期 0 词」，点进去还是空的 —— 宁可少一行，不摆空待办。
    mem = store.mem_stats()
    cur = datahub.current_group(p)
    if (cur.get("count") or 0) > 0 or mem["due_today"] > 0:
        rows.append({
            "cls": "vo",
            "title": "背一组词 · %s %s" % (cur.get("unit") or "", cur.get("lesson") or ""),
            "meta": "%d 词 · 到期 %d 词" % (cur.get("count") or 0, mem["due_today"]),
            "action": "去背", "page": "vocab", "group": cur.get("key"),
        })

    # 3) 练习：优先补最大错因考点，没错就从头刷
    errs = [e for e in store.error_by_part() if e["wrong"] > 0]
    bank = p.get("exercise_bank") or {}
    if errs:
        top = errs[0]
        meta = "错因最重 · 已做 %d 错 %d" % (top["done"], top["wrong"])
        part = top["part"]
    else:
        parts = bank.get("parts") or []
        part = (parts[0] or {}).get("name") if parts else None
        meta = "还没有错题记录 · 从第一个考点开始"
    if part:
        rows.append({"cls": "en", "title": "练习 · " + re.sub(r"^第[一二三四五六七八九十]+部分：", "", part),
                     "meta": meta, "action": "去练", "page": "practice", "part": part})

    # 4) 未动过的最高分科目：开新坑
    cand = None
    for s in sorted(p.get("subjects") or [], key=lambda x: -(x.get("score") or 0)):
        if s.get("score") and datahub.subject_progress(p, s, done)["lessons_done"] == 0:
            cand = s
            break
    if cand:
        n2 = datahub.subject_progress(p, cand, done)["next"] or {}
        rows.append({
            "cls": _cls(cand["id"]),
            "title": "开新坑 · %s" % cand["name"],
            "meta": "%s 分科目还没动过 · 第一讲「%s」%d 分钟" % (
                cand.get("score"), n2.get("title") or "", round((n2.get("dur") or 0) / 60)),
            "action": "试水", "page": "classroom", "subject": cand["id"],
            "lesson_id": n2.get("id"),
        })

    store.add_event("plan_today", payload="%d rows" % len(rows))
    return {"rows": rows,
            "say": "排出了今天的 %d 项：%s。按「断点续学 > 到期复习 > 最大错因 > 未开科目」排的。" % (
                len(rows), "、".join(str(r.get("title") or "")[:26] for r in rows[:4])
                or "（什么都没有，本机数据还不够排）"),
            "effect": "%d rows planned" % len(rows),
            "rule": "断点续学（五科一起比，按最近动过的）> 到期复习 > 最大错因 > 未开科目",
            "due_today": mem["due_today"]}


@tool("plan_set_budget", config.PERM_CONFIRM,
      "改考试日期 / 每天时长 / 背单词时长（只传要改的那项即可；写进本机，写盘要二次确认）")
def t_plan_set_budget(exam_date=None, minutes_per_day=None, vocab_minutes=None,
                      hours_per_day=None, **_):
    """倒计时排程的唯一入口。考试日期和每天时长必须由用户填——系统不猜。

    猜出来的日期就是编数字，编出来的排程会让人按假计划复习，这比没有计划更糟。

    **部分改**：只传「每天几小时」也行，其余沿用已经存下来的值。
    以前只改时长得走 intake 流水线，模型就会回「要不要我找工具改」——
    一句话的事变成一串问句，这正是人不爱用手管助手的原因。
    """
    before = planner.budget()
    # 人说「3 小时」，不用他自己换算成 180 分钟
    if hours_per_day not in (None, ""):
        try:
            minutes_per_day = int(round(float(hours_per_day) * 60))
        except (TypeError, ValueError):
            return {"ok": False, "error": "每天几小时得是数字，收到的是 %s" % hours_per_day}
    r = planner.set_budget(exam_date, minutes_per_day, vocab_minutes)
    if not r.get("ok"):
        return r
    b = r["budget"]
    if b.get("set") and b.get("ok"):
        store.add_event("plan_budget", payload="%s %dmin" % (b["exam_date"], b["minutes_per_day"]))
    # 改完立刻重算一遍，把新数报出来 —— 只回「改好了」等于让人自己去点一遍看
    after = planner.plan_budget()
    changed = []
    if before.get("exam_date") != b.get("exam_date"):
        changed.append("考试日期 %s → %s" % (before.get("exam_date") or "（没设）", b.get("exam_date")))
    if before.get("minutes_per_day") != b.get("minutes_per_day"):
        changed.append("每天时长 %s → %s 分钟" % (before.get("minutes_per_day"),
                                              b.get("minutes_per_day")))
    if before.get("vocab_minutes") != b.get("vocab_minutes"):
        changed.append("背单词 %s → %s 分钟" % (before.get("vocab_minutes"),
                                           b.get("vocab_minutes")))
    out = {"ok": True, "set": b.get("set"), "budget": b,
           "changed": changed,
           "recomputed": {"days_left": after.get("days_left"),
                          "lesson_budget_minutes": after.get("lesson_budget_minutes"),
                          "pending_hours": after.get("pending_hours"),
                          "keep_hours": after.get("keep_hours"),
                          "cut_hours": after.get("cut_hours"),
                          "coverage": after.get("coverage"),
                          "cut_total": after.get("cut_total")}}
    if changed:
        cov = after.get("coverage")
        out["note"] = ("改完了：" + "；".join(changed) +
                       "。按新设置重算：剩 %s 天，讲课额度 %s 分钟，"
                       "要砍 %s 讲，覆盖 %s。"
                       % (after.get("days_left"), after.get("lesson_budget_minutes"),
                          after.get("cut_total"),
                          ("%.0f%%" % (cov * 100)) if isinstance(cov, (int, float))
                          else "算不出来"))
        out["say"] = out["note"]
        out["effect"] = "；".join(changed)
    else:
        out["effect_kind"] = "noop"
        out["say"] = ("这几项本来就是这些值（考试日期 %s、每天 %s 分钟），"
                      "没改动。" % (b.get("exam_date") or "没设", b.get("minutes_per_day")))
    return out


@tool("plan_budget", config.PERM_LOCAL,
      "按考试日期和每天时长，算出每科能吃到第几讲、要砍掉哪些")
def t_plan_budget(**_):
    """「这些不看」要有依据：额度是分值权重算的，砍的是教学顺序的尾部。"""
    return planner.plan_budget()


@tool("plan_week", config.PERM_LOCAL, "排未来几天每天学哪几讲（一讲看不完就分到第二天）")
def t_plan_week(days=7, **_):
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 7
    return planner.plan_week(days)


@tool("pick_next_task", config.PERM_LOCAL, "决定下一个训练动作")
def t_next_task(**_):
    plan = t_plan_today()
    rows = plan.get("rows") or []
    return {"task": rows[0] if rows else None, "count": len(rows)}


# ========================================================== 练习 / 判分
@tool("list_item_sources", config.PERM_LOCAL, "列出可刷的题源（五科共用一张表）")
def t_list_item_sources(subject=None, **_):
    return {"sources": datahub.item_sources(subject),
            "note": "题源自报题量与判分档；判分档不是 exact 的，要模型才能判"}


@tool("pick_question_part", config.PERM_LOCAL, "选定题源与分组并取题（不含答案）")
def t_pick_part(part=None, n=config.QUIZ_DEFAULT_SIZE, offset=0,
                source=None, **kw):
    r = datahub.source_questions(source, part, n, offset)
    if r.get("error"):
        return r
    # 兼容老参数：政治/计算机的「分组名」直接当 part 传进来也能用
    store.add_event("pick_part", part=r.get("part"),
                    payload="src=%s" % r.get("source"))
    if isinstance(r, dict):
        _n = len(r.get("questions") or r.get("items") or [])
        r["say"] = "从「%s」的「%s」取了 %d 道题（只给题干，答案在判分那一步才出）。" % (
            r.get("source_name") or r.get("source") or "题库",
            r.get("part") or "全部", _n)
        r["effect"] = "pick %d questions" % _n
    return r


@tool("make_quiz", config.PERM_LOCAL, "按题源生成一组练习（不含答案）")
def t_make_quiz(part=None, n=config.QUIZ_DEFAULT_SIZE, source=None, offset=0, **_):
    # offset 必须透传：题库几百题，界面要能「从第几题开始刷」，
    # 少这一个参数就永远只能刷到最前面那一组 —— 后面那些题等于没有。
    return t_pick_part(part=part, n=n, offset=offset, source=source)


@tool("grade_answer", config.PERM_LOCAL, "判一道题并把作答写库（题源决定判分档）")
def t_grade_answer(qno=None, chosen=None, kind="practice", part=None,
                   source=None, ref=None, **_):
    if qno is None and ref is not None:
        qno = ref
    if qno is None:
        return {"error": "没给题号"}
    if kind == "exam":
        # 考场：真卷判分。part = paper_id，qno = 卷内题号
        p, g, q = datahub.exam_question(part, qno)
        if not q:
            return {"error": "这套卷里没有第 %s 题" % qno}
        ok = (chosen == q.get("ans"))
        # 考场作答也记一条 answers：以前只写 events，导致「错因归因/只看错题」
        # 永远看不到真卷里错的题（这也是题库半边空的原因之一）
        store.add_answer(q.get("no"), part, chosen, q.get("ans"), bool(ok),
                         source=datahub.SRC_EXAM, subject="english")
        store.add_event("exam_answer", part=part, qno=int(qno), ok=ok,
                        subject="english", payload="chosen=%s" % chosen)
        st = (store.exam_state_all().get(part) or {})
        return {"qno": q.get("no"), "kind": "exam", "paper": part, "chosen": chosen,
                "ans": q.get("ans"), "ok": bool(ok), "type": (g or {}).get("type"),
                "answered": len(st),
                "right": len([1 for v in st.values() if v == 1]),
                "wrong": len([1 for v in st.values() if v == 0])}
    # 练习：题源决定这道题长什么样、怎么判（以前只认英语语法题库）
    item = datahub.item_by_ref(source, qno)
    if not item:
        return {"error": "题源 %s 里没有 %s 这一题" % (source or datahub.SRC_GRAMMAR, qno)}
    v = datahub.judge_answer(item, chosen)
    ok = v.get("ok")
    # 判不出（要模型 / 无标准答案）就**不写作答记录**，免得污染正确率与错因归因
    if ok is not None:
        store.add_answer(item.get("no"), item.get("part"), chosen,
                         v.get("ans"), ok, source=item.get("source"),
                         subject=item.get("subject"))
        store.add_event("answer", subject=item.get("subject"),
                        part=item.get("part"), qno=item.get("no"), ok=ok,
                        payload="src=%s chosen=%s" % (item.get("source"), chosen))
    _say = ("这题%s。" % ("答对了" if ok else "答错了")) if ok is not None else (
        "这题判不了（%s），所以没写作答记录 —— 不然会污染正确率。" % (v.get("note") or "没有可判的依据"))
    return {"qno": item.get("no"), "id": item.get("id"),
            "say": _say, "effect": ("answer %s" % ("right" if ok else "wrong")) if ok is not None else "unjudged",
            "source": item.get("source"), "subject": item.get("subject"),
            "part": item.get("part"), "kind": item.get("kind"),
            "chosen": chosen, "ans": v.get("ans"), "ok": ok,
            "band": v.get("band"), "want_band": v.get("want_band"),
            "judged": ok is not None, "note": v.get("note"),
            "full": v.get("full"),
            "explain": v.get("explain"), "topic": item.get("topic"),
            "stats": store.answer_stats()}


@tool("analyze_errors", config.PERM_LOCAL, "错因归因（按考点统计真实作答）")
def t_analyze_errors(**_):
    rows = store.error_by_part()
    st = store.answer_stats()
    return {"by_part": rows, "stats": st,
            "empty": not rows,
            "note": ("错题少的考点排后面；没有任何作答记录时这里为空——不编数字。"
                     if not rows else "数据来自本机 SQLite answers 表")}


@tool("list_errors", config.PERM_LOCAL, "列出做错过的题（真源 answers）")
def t_list_errors(limit=20, **_):
    p = datahub.proto()
    bank = p.get("exercise_bank") or {}
    wrong = {}
    for q in bank.get("questions") or []:
        pass
    con = store.connect()
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT qno, part, chosen, ans, source, subject FROM answers WHERE ok=0"
            " ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]
    finally:
        con.close()
    out = []
    for r in rows:
        # 错题按**它自己所属的题源**取原文：以前一律去英语语法库找，
        # 计算机/政治的错题在这里会变成「题干空白」的空壳行。
        q = datahub.item_by_ref(r.get("source"), r["qno"])
        if not q:
            continue
        r.update({"stem": q.get("stem"), "opts": q.get("opts"),
                  "explain": q.get("explain"), "title": q.get("topic"),
                  "id": q.get("id")})
        out.append(r)
    return {"errors": out, "count": len(out),
            "note": "每道错题按它自己的题源取原文；取不到原文的不列，不摆空壳"}


# ========================================================== 背单词
@tool("resolve_vocab_group", config.PERM_LOCAL, "讲次 → (Unit, Lesson) 词组映射")
def t_resolve_group(lesson_id=None, key=None, **_):
    pod = datahub.proto().get("wordmap") or {}
    idx = pod.get("lesson_index") or {}
    if key:
        g = next((g for g in (pod.get("groups") or []) if g["key"] == key), None)
        return {"key": key, "group": g, "count": (g or {}).get("count", 0)}
    if not lesson_id:
        cur = datahub.current_group(datahub.proto())
        return {"key": cur.get("key"), "follow": True, "lesson_id": cur.get("lesson_id"),
                "count": cur.get("count"), "why": cur.get("why")}
    k = idx.get(lesson_id)
    if not k:
        return {"key": None, "lesson_id": lesson_id, "is_word_lesson": False,
                "reason": "这讲不是单词课，没有词组"}
    return {"key": k, "lesson_id": lesson_id, "is_word_lesson": True}


@tool("list_word_group", config.PERM_LOCAL, "取某个词组的全部词 + 记忆状态")
def t_list_word_group(key=None, lesson_id=None, **_):
    p = datahub.proto()
    if not key:
        r = t_resolve_group(lesson_id=lesson_id)
        key = r.get("key")
    if not key:
        return {"key": None, "count": 0, "words": []}
    ws = datahub.group_words(key)
    freq = (p.get("vocab") or {}).get("freq_index") or {}
    return {"key": key, "count": len(ws),
            "words": [{"no": w.get("no"), "w": w["w"], "ph": w.get("ph"),
                       "pos": w.get("pos"), "cn": w.get("cn"),
                       "mem": datahub.mem_of(w["w"]),
                       "freq": (freq.get(w["w"]) or {}).get("freq")} for w in ws]}


@tool("grade_word", config.PERM_LOCAL, "判一个词的作答并更新 SM-2 记忆状态")
def t_grade_word(word=None, mode="card", answer=None, right=None, fuzzy=0, **_):
    """判一个词。

    判定优先级：前端已经判过的 right（对/错布尔）> 按模式自己比答案。
    界面上的四选一和「认识/不认识」都是前端当场判的，答案形状是中文义项或者单词本身，
    服务端拿去做字符串比对只会全判错 —— 所以先认 right。

    fuzzy=1 是「自评：模糊」：人没答错，只是说不准。所以不记 right 也不记 wrong
    （不该进错词本），但间隔压到最短档，明天就回来。"""
    if not word:
        return {"error": "没给单词"}
    is_fuzzy = str(fuzzy).strip().lower() in ("1", "true", "yes")
    ok = None
    if isinstance(right, bool):
        ok = right
    elif right in (0, 1):
        ok = bool(right)
    elif str(right).strip().lower() in ("true", "false", "1", "0"):
        ok = str(right).strip().lower() in ("true", "1")
    if ok is None and mode in ("dictation", "cloze", "cn2write") and answer is not None:
        ok = str(answer).strip().lower() == str(word).strip().lower()
    if ok is None and mode == "pick" and answer in (1, True, "1", "true"):
        ok = True
    if ok is None and mode == "pick":
        ok = False
    # 模糊档本来就不判对错（人没说错，只是说不准），所以缺 right 不算错，补成 False 让它走过去；
    # 以前这里直接 return error，结果「模糊」按下去永远落不了库。
    if ok is None and is_fuzzy:
        ok = False
    if ok is None:
        return {"error": "这个模式没有可判定的答案：%s" % mode}
    rec = store.grade_word(word, ok, fuzzy=is_fuzzy)
    store.add_event("grade_word", word=word, ok=(False if is_fuzzy else ok),
                    payload="mode=%s%s" % (mode, ";fuzzy" if is_fuzzy else ""))
    _ms = store.mem_stats()
    return {"word": word, "mode": mode, "ok": ok, "fuzzy": is_fuzzy, "mem": rec,
            "say": "「%s」%s%s，进到第 %s 个盒子。今天还要背 %d 个。" % (
                word, "过了" if ok else "没过", "（模糊算没过）" if is_fuzzy else "",
                (rec or {}).get("box") or "?", _ms.get("due_today") or 0),
            "effect": "word %s %s" % (word, "right" if ok else "wrong"),
            "stats": _ms}


@tool("pick_word_mode", config.PERM_LOCAL, "切换背词模式（记录偏好）")
def t_pick_word_mode(mode=None, **_):
    _m = str(mode or "").strip()
    # 不传 mode 就写空串，等于把偏好清成 "None" —— 界面上会显示「切成了 None」。
    # 这是真跑一遍才发现的，宁可拒收也不写脏值。
    if not _m:
        return {"ok": False, "mode": None, "saved": store.kv_get("word_mode"),
                "error": "没说切哪个模式（card / spell / fill / dictation）"}
    store.kv_set("word_mode", _m)
    store.add_event("pick_word_mode", payload=_m)
    return {"ok": True, "mode": _m, "saved": store.kv_get("word_mode"),
            "say": "背词模式切成了「%s」，下次进来还是这个。" % _m,
            "effect": "word_mode -> %s" % _m}


# ------------------------------------------------- 词书获取（AI 自己去百词斩找书、拉词）
# 为什么做成工具而不是预置一份词表：这是参赛项目，卖点是 AI 自己把资源闭环起来。
# 预置词表只能覆盖提前想到的那几本；用户说「考研词汇」「四级核心」就没了。
# 学丞那条线要用户先买过课，词表锁在课程包里，当不了通用源 —— 百词斩书目是公开的。
# 三段（书目 → 词序 → 词条）都走工具，AI 自己搜、自己拉、自己落库；
# 落库落成 lists + groups_words + by_unit 三件套，词书在背单词页当场能翻，不是一张清单。
_VOCAB_PER_GROUP = 50          # 一组 50 词：Vocab 页一组先学 20 个，50 是能翻完的体量
_RE_POS = re.compile(
    r"(?:^|[\s；;，,、])((?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|phr|abbr)\.)", re.I)


def _bcz_token():
    """百词斩登录态。没有就如实说没配，不拿空 token 去撞 401。"""
    if not config.ENABLE_BCZ:
        return None, "百词斩这一路在配置里关着（config.ENABLE_BCZ=false）"
    tk = (config.BCZ_ACCESS_TOKEN or "").strip()
    if not tk:
        return None, ("没配百词斩 access_token（config.BCZ_ACCESS_TOKEN 为空），"
                      "词书接口不带登录态只回「token is empty」")
    return tk, None


def _pos_of(mean):
    """从百词斩释义串里抽词性标签（n. / v. / adj. …），最多留 4 个。

    原文是「n. 笔记；便条… v. 注意」，词性混在正文里。抽出来只当标签用，
    释义一个字都不改（cn 保留原文）—— 不替它润色，也不拆成猜出来的分条。
    """
    seen = []
    for m in _RE_POS.finditer(str(mean or "")):
        t = m.group(1).lower()
        if t not in seen:
            seen.append(t)
        if len(seen) >= 4:
            break
    return " / ".join(seen)


@tool("vocab_books", config.PERM_NET,
      "搜百词斩词书：给关键词（专升本/考研/四级…）列出真词书、词数、是否已经拉进来")
def t_vocab_books(keyword=None, limit=15, **_):
    """词书目录。keyword 为空就列全部（2348 本，按词数倒序取前 N）。

    `pulled` 是真读 overlay 判的：同一本书拉过就不用再拉一遍。
    """
    tk, why = _bcz_token()
    if not tk:
        return {"ok": False, "error": why, "books": [],
                "say": "没搜成：%s" % why, "effect": "0 book（没登录态）"}
    rows, err = bcz.books(keyword, access_token=tk)
    if err or rows is None:
        return {"ok": False, "error": str(err or "书目返回空"), "books": [],
                "say": "百词斩书目没取到：%s" % (err or "返回空"), "effect": "0 book"}
    pulled = {str((l.get("origin") or {}).get("book_id"))
              for l in (datahub.vocab_extra().get("lists") or [])}
    try:
        cap = int(limit or 15)
    except (TypeError, ValueError):
        cap = 15
    cap = max(1, min(cap, 60))
    rows = sorted(rows, key=lambda b: -(b.get("words") or 0))
    out = [{"id": b.get("id"), "name": b.get("name"), "words": b.get("words") or 0,
            "pulled": str(b.get("id")) in pulled} for b in rows[:cap]]
    tot = sum((b.get("words") or 0) for b in rows)
    kw = (keyword or "").strip()
    top = out[0] if out else None
    say = "百词斩书目里%s %d 本（合计 %d 词）。" % (
        ("名字带「%s」的" % kw) if kw else "全部", len(rows), tot)
    if top:
        say += "词数最多的是「%s」%d 词%s。要哪本就 vocab_pull(book_id=%s)。" % (
            top["name"], top["words"], "（已经拉进来过）" if top["pulled"] else "",
            top["id"])
    return {"ok": True, "keyword": kw, "matched": len(rows), "total_words": tot,
            "shown": len(out), "books": out,
            "say": say, "effect": "%d books matched" % len(rows)}


@tool("vocab_pull", config.PERM_NET,
      "把一本百词斩词书真拉进来（词序→逐条词条→落成本机词书，背单词页当场能翻）")
def t_vocab_pull(book_id=None, limit=None, force=False, name=None, **_):
    """拉一本词书：真发 N 批请求取词条，再写 data/vocab_extra.json。

    - limit 只拉前 N 词（试一本大书先看效果用），返回里明说「只拉了前 N 词」；
    - 已经拉过且没 force 就**不重复拉**（一次全书 50+ 批请求，白跑没意义），回 noop；
    - 一批都没拿到才算失败；拿到一部分就照实交一部分，并写清是第几批断的。
    """
    tk, why = _bcz_token()
    if not tk:
        return {"ok": False, "error": why, "say": "没拉成：%s" % why,
                "effect": "0 word（没登录态）"}
    bid = str(book_id or "").strip()
    if not bid:
        return {"ok": False, "error": "没给词书 id（先用 vocab_books 搜一本）",
                "say": "没拉成：没给词书 id。", "effect": "0 word"}

    tick("查这本词书的书目信息")
    rows, err = bcz.books(None, access_token=tk)
    if err or not rows:
        return {"ok": False, "error": str(err or "书目返回空"),
                "say": "书目没取到，拉不了：%s" % (err or "返回空"), "effect": "0 word"}
    book = next((b for b in rows if str(b.get("id")) == bid), None)
    if not book:
        return {"ok": False, "error": "书目里没有 id=%s 这本词书" % bid,
                "say": "书目里没有 id=%s 这本词书。" % bid, "effect": "0 word"}

    nm = str(name or "").strip() or book.get("name") or ("词书 %s" % bid)
    lid = "bcz-%s" % bid
    ex = datahub.vocab_extra()
    old = next((l for l in (ex.get("lists") or []) if l.get("id") == lid), None)
    try:
        lim = int(limit or 0)
    except (TypeError, ValueError):
        lim = 0
    if old and not force and not lim:
        return {"ok": True, "list": lid, "book_id": bid, "name": nm,
                "words": old.get("count") or 0, "pulled": False,
                "first_key": "%s|第 1 组" % (old.get("unit") or nm),
                "say": "「%s」之前已经拉进来过（%d 词），这次没重复拉 —— 要重拉就 force=1。"
                       % (nm, old.get("count") or 0),
                "effect": "noop: 已经在库里，没重复拉"}

    tick("取词序（书目说 %d 词）" % (book.get("words") or 0))
    topics, terr = bcz.book_topics(bid, access_token=tk)
    if terr or not topics:
        return {"ok": False, "error": str(terr or "词序返回空"),
                "say": "词序没取到，拉不了：%s" % (terr or "返回空"), "effect": "0 word"}
    total_book = len(topics)
    use = topics[:lim] if lim > 0 else topics

    got, broke = [], ""
    t0 = time.time()
    for i in range(0, len(use), 80):
        chunk = use[i:i + 80]
        ws, werr = bcz.topic_words(chunk, access_token=tk)
        if not ws:
            broke = str(werr or "这一批没返回词条")
            break
        got.extend([w for w in ws if w.get("word")])
        tick("拉了 %d/%d 词" % (len(got), len(use)), n=len(got), total=len(use))
        if werr:
            broke = str(werr)
            break
    if not got:
        return {"ok": False, "error": broke or "一条词条都没取到",
                "say": "一条词条都没取到，没入库：%s" % (broke or "返回空"),
                "effect": "0 word"}

    words, n = [], 0
    for w in got:
        mean = str(w.get("mean_cn") or "").strip()
        if not mean:          # 没释义的条目是废条目，背不了，直接不收
            continue
        n += 1
        words.append({"no": n, "w": w["word"], "ph": "", "pos": _pos_of(mean), "cn": mean,
                      "audio": bcz.cdn_url(w["audio_us"]) if w.get("audio_us") else "",
                      "src": "baicizhan"})
    if not words:
        return {"ok": False, "error": "取到的词条没有一条带释义",
                "say": "取到 %d 条词条，但没有一条带释义，没入库。" % len(got),
                "effect": "0 word"}

    # 单位名撞了（两本书同名）就带上书号，不然两本的词组会互相覆盖
    unit = nm
    clash = {v.get("list") for k, v in (ex.get("groups") or {}).items()
             if isinstance(v, dict) and (k.split("|")[0] == unit) and v.get("list") != lid}
    if clash:
        unit = "%s #%s" % (nm, bid)

    groups, lessons = {}, []
    for gi in range(0, len(words), _VOCAB_PER_GROUP):
        part = words[gi:gi + _VOCAB_PER_GROUP]
        lname = "第 %d 组" % (gi // _VOCAB_PER_GROUP + 1)
        groups["%s|%s" % (unit, lname)] = {"list": lid, "unit": unit,
                                           "lesson": lname, "words": part}
        lessons.append({"name": lname, "count": len(part)})

    tick("写进本机词书", n=len(lessons), total=len(lessons))
    lists = [l for l in (ex.get("lists") or []) if l.get("id") != lid]
    lists.append({"id": lid, "name": nm,
                  "source": "百词斩词书 #%s" % bid,
                  "desc": "百词斩原书词序，每 %d 词一组，带释义与美音" % _VOCAB_PER_GROUP,
                  "count": len(words), "hasFreq": False, "unit": unit,
                  "origin": {"kind": "baicizhan", "book_id": bid},
                  "pulled_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    # 重拉时先把这本书上一版的词组/分组清掉，不然词少了会留下尾巴
    keep_groups = {k: v for k, v in (ex.get("groups") or {}).items()
                   if not (isinstance(v, dict) and v.get("list") == lid)}
    keep_groups.update(groups)
    keep_units = [u for u in (ex.get("units") or []) if u.get("list") != lid]
    keep_units.append({"unit": unit, "list": lid, "count": len(words), "lessons": lessons})
    datahub.save_vocab_extra({"lists": lists, "groups": keep_groups, "units": keep_units})

    first_key = "%s|第 1 组" % unit
    part = ("只拉了前 %d 词（书里一共 %d 词）" % (len(words), total_book)
            if len(words) < total_book else "全书 %d 词" % len(words))
    if broke:
        part += "；第 %d 批起断了：%s" % (len(got) // 80 + 1, broke)
    return {"ok": True, "pulled": True, "list": lid, "book_id": bid, "name": nm,
            "unit": unit, "words": len(words), "groups": len(lessons),
            "first_key": first_key,
            "keys": ["%s|第 %d 组" % (unit, i + 1) for i in range(min(3, len(lessons)))],
            "took": round(time.time() - t0, 1),
            "say": "拉进来了：%s，%s、分成 %d 组，归到词书「%s」。背单词页选这本就能从「第 1 组」开始翻。"
                   % (nm, part, len(lessons), unit),
            "effect": "vocab +%d words / %d groups -> %s" % (len(words), len(lessons), lid)}


@tool("vocab_library", config.PERM_LOCAL, "本机现在有哪几本词书：课程自带的 + 拉进来的，各自有哪些组")
def t_vocab_library(**_):
    """给界面和模型一张「词表都在哪」的表 —— 不然拉进来的词书没入口，等于没拉。

    按**书**聚合，不按 Unit 摊（课程那本 12 个 Unit 摊出来就是 13 个入口，
    界面上根本选不动）。每本带 keys，界面按组翻。
    """
    p = datahub.proto()
    books = []
    # ① 课程自带的（学丞讲义词表）—— 跟着讲次走，整本算一本
    gs = [g for g in ((p.get("wordmap") or {}).get("groups") or []) if g.get("key")]
    if gs:
        cur = datahub.current_group(p)
        keys = [g["key"] for g in gs]
        books.append({"id": "course", "origin": "course", "name": "课程词表（讲义配套）",
                      "count": sum((g.get("count") or 0) for g in gs),
                      "groups": len(keys), "keys": keys,
                      "first_key": cur.get("key") if cur.get("key") in keys else keys[0]})
    # ② 拉进来的（百词斩词书）
    for u in (datahub.vocab_extra().get("units") or []):
        ls = [x for x in (u.get("lessons") or []) if (x or {}).get("name")]
        if not ls:
            continue
        keys = ["%s|%s" % (u.get("unit"), x.get("name")) for x in ls]
        books.append({"id": u.get("list"), "origin": "pulled", "name": u.get("unit") or "",
                      "count": u.get("count") or 0, "groups": len(keys), "keys": keys,
                      "first_key": keys[0]})
    pulled = len([x for x in books if x["origin"] == "pulled"])
    return {"books": books, "count": len(books), "pulled": pulled,
            "note": ("一本拉进来的词书都没有：背单词页只能跟课程词表走" if not pulled
                     else "拉进来的 %d 本可以和课程词表互相切换" % pulled)}


@tool("fetch_word_detail", config.PERM_NET, "拉词条详情（配图/词根词缀/例句/发音，来源百词斩）")
def t_word_detail(word=None, force=False, **_):
    """百词斩词条：配图、词根词缀、分条释义、真题以外的例句。

    - 有缓存且没过期就直接用（`cached: true`），省一次网络；
    - 拿不到就**如实说为什么拿不到**，并回落到本地构词推测（标注 fallback_is_guess）
      —— 绝不拿推测冒充实词条。
    """
    if not word:
        return {"error": "没给单词"}
    safe = re.sub(r"[^a-zA-Z_-]", "", word)[:64]
    cache_dir = os.path.join(config.APP_DATA_DIR, "cache", "word")
    os.makedirs(cache_dir, exist_ok=True)
    f = os.path.join(cache_dir, safe + ".json")
    ttl = max(0, int(config.BCZ_CACHE_TTL_DAYS or 0)) * 86400

    if os.path.exists(f) and not force:
        try:
            age = time.time() - os.path.getmtime(f)
            if age <= ttl:
                with io.open(f, encoding="utf-8") as fh:
                    d = json.load(fh)
                if d.get("available"):
                    d["cached"] = True
                    d["say"] = "「%s」词条本机缓存还在有效期（%s），直接用，没再联网。" % (
                        d.get("word") or word, d.get("source") or "百词斩")
                    d["effect"] = "word detail %s cache-hit" % word
                    return d
        except Exception:
            pass

    def _fallback(reason, source=None):
        return {
            "word": word, "available": False, "source": source,
            "reason": reason, "fallback": guess_morphology(word),
            "fallback_is_guess": True, "mem": datahub.mem_of(word),
            # 拿不到就说拿不到，别让界面以为词条已经补齐了
            "say": "「%s」的百词斩词条没取到：%s。下面给的是本地构词推测，不是词典释义。" % (
                word, reason),
            "effect": "word detail %s unavailable" % word,
        }

    if not config.ENABLE_BCZ:
        return _fallback("百词斩词条已关闭（config.ENABLE_BCZ=false），没联网拉取")
    token = config.BCZ_ACCESS_TOKEN
    if not token:
        return _fallback("没配百词斩 access_token（config.BCZ_ACCESS_TOKEN 为空），"
                         "接口要求登录态，所以拿不到配图")

    rows, err = bcz.search(word, token)
    if not rows:
        store.add_event("fetch_word_detail", word=word, payload="search-miss")
        return _fallback("百词斩搜不到这个词：%s" % (err or "返回空列表"), source="bcz")

    # 优先取拼写完全一致的那条，否则用第一条（服务端按匹配度排过）
    hit = next((r for r in rows if (r.get("word") or "").lower() == word.lower()),
               rows[0])
    tid = hit.get("topic_id")
    card, cerr = bcz.word_card(tid, token)
    dic, derr = bcz.dict_entry(hit.get("word") or word, token)

    if not card and not dic:
        store.add_event("fetch_word_detail", word=word, payload="card-miss")
        return _fallback("搜到了词条但取不到详情：%s / %s" % (cerr, derr), source="bcz")

    card = card or {}
    dic = dic or {}
    img = bcz.cdn_url(card.get("image_file"))
    # 素材落本地：CDN 认 UA/Referer，浏览器直取会被挡，所以由服务下下来再代理出去
    local_img = _cache_word_asset(word, img, "pic")
    local_def = _cache_word_asset(word, bcz.cdn_url(card.get("deformation_img")), "def")
    local_aud = _cache_word_asset(word, bcz.cdn_url(card.get("audio_path")), "aud")
    exs = []
    for i, e in enumerate(dic.get("examples") or []):
        e2 = dict(e, img=bcz.cdn_url(e.get("img")), audio=bcz.cdn_url(e.get("audio")))
        e2["img_local"] = _cache_word_asset(word, e2["img"], "ex%d" % i)
        exs.append(e2)

    # 主图兜底：旧格式 /cropped_images/3_0_..._c.jpg 在 CDN 上大面积 404（实测
    # dormitory、sophisticated 都是），此时不摆空槽，改用第一张例句配图顶上，
    # 并如实标出 image_kind=example，界面上明说这是哪张图。
    img_kind = "word"
    if not local_img:
        for i, e in enumerate(exs):
            if e.get("img_local"):
                local_img = e["img_local"]
                img_kind = "example"
                img = e.get("img") or ""
                img_example_index = i
                break
    else:
        img_example_index = None

    out = {
        "word": card.get("word") or hit.get("word") or word,
        "available": True,
        "source": "百词斩",
        "source_url": img,
        "topic_id": tid,
        "phonetic": card.get("phonetic") or hit.get("phonetic"),
        "phonetic_us": dic.get("us"), "phonetic_uk": dic.get("uk"),
        "mean_cn": card.get("mean_cn") or hit.get("mean_cn"),
        "mean_en": card.get("mean_en"),
        "short_phrase": card.get("short_phrase"),
        "word_variants": card.get("word_variants"),
        # image 优先给本地代理地址（浏览器能取到）；image_remote 留着备查
        "image": local_img, "image_remote": img,
        "image_url": local_img,
        "image_kind": img_kind,
        "image_example_index": img_example_index,
        "image_note": ("词卡主图用的是 Word 配图。" if img_kind == "word" else
                       "词卡主图在 CDN 上已失效（404），这里用的是第 %d 条例句的配图。"
                       % ((img_example_index or 0) + 1)),
        "deformation_img": local_def,
        "audio": local_aud,
        "audio_us": bcz.cdn_url(dic.get("audio_us")),
        "audio_uk": bcz.cdn_url(dic.get("audio_uk")),
        "etyma": dic.get("etyma"),
        "senses": dic.get("senses") or [],
        "sentence": card.get("sentence"),
        "sentence_trans": card.get("sentence_trans"),
        "examples": exs,
        "fallback": guess_morphology(word),
        "fallback_is_guess": False,
        "mem": datahub.mem_of(word),
        "cached": False,
        "caveat": ("配图和词根来自百词斩公开词卡接口；例句里没有译文的照原样留空，不补。"),
    }
    try:
        with io.open(f, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False)
    except Exception:
        pass  # 落盘失败不影响这次返回，下次重拉
    store.add_event("fetch_word_detail", word=word, payload="bcz-hit")
    _nb = len([1 for k in ("image", "audio", "deformation_img") if out.get(k)])
    out["say"] = "「%s」词条取到了（%s）：释义 %d 条、例句 %d 条、%d 个素材落到本机。%s" % (
        out["word"], out.get("phonetic") or "无音标",
        len(out.get("senses") or []), len(exs), _nb,
        "" if img_kind == "word" else out.get("image_note") or "")
    out["effect"] = "word detail %s cached" % word
    return out


@tool("cache_asset", config.PERM_NET, "按内容哈希缓存素材，失败沿用旧版")
def t_cache_asset(word=None, kind="mnemo", **_):
    cache_dir = os.path.join(config.APP_DATA_DIR, "cache", kind)
    os.makedirs(cache_dir, exist_ok=True)
    hit = None
    if word:
        f = os.path.join(cache_dir, re.sub(r"[^a-zA-Z_-]", "", word)[:64] + ".jpg")
        hit = f if os.path.exists(f) else None
    store.add_event("cache_asset", word=word, payload="kind=%s hit=%s" % (kind, bool(hit)))
    return {"kind": kind, "word": word, "hit": bool(hit), "path": hit,
            "say": ("素材缓存命中：%s（%s 类）。" % (os.path.basename(hit), kind)) if hit
                   else ("「%s」的 %s 类素材还没缓存过，这里不联网下载，界面用插画兜底。"
                         % (word or "（没给词）", kind)),
            "effect": "cache %s hit=%s" % (kind, bool(hit)),
            "cache_dir": cache_dir,
            "note": "命中就返回本地文件；未命中且未联外网时界面用插画兜底"}


def _cache_word_asset(word, url, tag):
    """下载词条素材到 data/cache/word，返回可给 <img>/<audio> 用的本地地址。

    失败返回 None —— 界面据此显示"没取到图"，不做假占位。
    """
    if not url:
        return None
    ext = os.path.splitext(url.split("?")[0])[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp3", ".m4a", ".dat"):
        ext = ".jpg"
    base = re.sub(r"[^a-zA-Z_-]", "", word or "")[:48] or "word"
    name = "%s_%s%s" % (base, tag, ext)
    dest = os.path.join(config.APP_DATA_DIR, "cache", "word", name)
    if os.path.exists(dest) and os.path.getsize(dest) > 256:
        return "/media/word/" + name
    ok, info = bcz.download(url, dest, timeout=int(config.BCZ_TIMEOUT or 12))
    if not ok:
        return None
    return "/media/word/" + name


def guess_morphology(word):
    """本地构词法兜底。明确标注这是推测，不是词典条目。"""
    PREFIX = {"un": "否定", "in": "否定/进入", "im": "否定/进入", "dis": "分离/否定",
              "re": "再/回", "pre": "在前", "pro": "向前", "sub": "在下", "super": "超过",
              "inter": "之间", "trans": "穿越", "ex": "向外", "con": "共同", "com": "共同",
              "de": "向下/去除", "over": "过度", "under": "不足", "mis": "错误"}
    SUFFIX = {"tion": "名词·行为/状态", "sion": "名词·行为/状态", "ment": "名词·结果",
              "ness": "名词·性质", "ity": "名词·性质", "ance": "名词·性质",
              "able": "形容词·可…的", "ible": "形容词·可…的", "ive": "形容词·有…性质",
              "ous": "形容词·充满…", "ful": "形容词·充满…", "less": "形容词·无…",
              "ly": "副词", "ize": "动词·使…", "ise": "动词·使…", "ify": "动词·使…",
              "er": "名词·人/物", "or": "名词·人/物", "ist": "名词·人", "ism": "名词·主义"}
    w = (word or "").lower()
    parts = []
    for pre in sorted(PREFIX, key=len, reverse=True):
        if w.startswith(pre) and len(w) > len(pre) + 2:
            parts.append({"part": pre, "kind": "前缀", "meaning": PREFIX[pre]})
            w = w[len(pre):]
            break
    for suf in sorted(SUFFIX, key=len, reverse=True):
        if w.endswith(suf) and len(w) > len(suf) + 1:
            parts.append({"part": suf, "kind": "后缀", "meaning": SUFFIX[suf]})
            w = w[: -len(suf)]
            break
    if w:
        parts.append({"part": w, "kind": "词根(待核)", "meaning": "本地无法确认词根，需外部词源"})
    return {"segments": parts,
            "caveat": "这是本地构词法推测，不是词典释义，只用来帮你记形状"}


@tool("sync_xuecheng", config.PERM_CONFIRM, "回写完成的讲次到进度文件")
def t_sync_xuecheng(**_):
    tick("扫本机已完成的讲次", n=1, total=3)
    r = sync_progress_file()
    ch = r.get("changed") or []
    store.add_event("sync_progress", payload=json.dumps(ch, ensure_ascii=False))
    if ch:
        say = "回写了 %d 讲到 progress.json（旧文件备份在 data/backup）：%s" % (
            len(ch), "、".join(ch[:5]) + ("…" if len(ch) > 5 else ""))
        eff = "%d lessons -> progress.json" % len(ch)
    else:
        r["effect_kind"] = "noop"
        say = "本机完成的讲次 progress.json 里都有了，没有新内容要写，文件没动。"
        eff = "0 lessons"
    r["say"] = say
    r["effect"] = eff
    return r


# ========================================================== 统计 / 考场
@tool("perm_state", config.PERM_LOCAL, "看现在是哪一档权限（只看不改 / 先问我 / 完全信任）")
def t_perm_state(**_):
    """模型能看见档位，但改不了 —— 改档只走 /api/perm，是人按的开关。"""
    st = perm.state()
    return {"mode": st["mode"],
            "why": next(x["why"] for x in st["modes"] if x["id"] == st["mode"]),
            "modes": st["modes"],
            "note": "档位只能由人去设置里改；模型没有改它的工具。"}


@tool("stats_overview", config.PERM_LOCAL, "只展示能核对的条目数")
def t_stats(**_):
    p = datahub.proto()
    done = datahub.done_ids()
    mem = store.mem_stats()
    st = store.answer_stats()
    bank = p.get("exercise_bank") or {}
    pods = [c for c in (p.get("point_cards") or [])]
    return {
        "lessons": {"done": len(done), "total": sum(len(s.get("lessons") or [])
                                                     for s in p.get("subjects") or [])},
        "words": {"in_memory": mem["words"], "due_today": mem["due_today"],
                  "total": ((p.get("vocab") or {}).get("lists") or [{}])[0].get("count"),
                  "boxes": mem["boxes"]},
        "bank": {"name": bank.get("name"), "total": bank.get("total")},
        "answers": st,
        # 卷数以前数 proto（15），而考场页读 list_exam_papers（16，含 papers_extra.json）——
        # 同一台机器两页两个数。这里统一走 datahub.exam_papers()（它已经合并了 extra）。
        "exam_papers": len(datahub.exam_papers().get("papers") or []),
        # 真题可判分题数：拿题源自报的 total，别在页面上写死一个 995。
        "exam_bank_total": next((x.get("total") for x in datahub.item_sources()
                                 if x.get("id") == datahub.SRC_EXAM), 0),
        # 词量：以前只取第一本书（3790），后拉进来的 419/3287/4056 全不进计数。
        # 这里把每本都报出来，前端自己决定显示哪一本、合计多少。
        "vocab_books": [{"name": x.get("name"), "count": x.get("count")}
                        for x in ((p.get("vocab") or {}).get("lists") or [])],
        "vocab_books_total": sum(int(x.get("count") or 0)
                                 for x in ((p.get("vocab") or {}).get("lists") or [])),
        "point_cards": [{"name": c["name"], "count": c["count"]} for c in pods],
        "days7": store.last_7d_minutes(),
        "time": store.learning_seconds(),
        "note": "全部数字来自本机数据文件与 SQLite，没有估算值",
    }


# ======================================================== 真题卷：AI 自己去找、去拉
# 原来 15 套卷全绑在 workbench/data/exam_papers.json 上（只读、只有广东公共英语）。
# 政治/计算机/高数一套都没有，空实例更是一套都没有 —— 「换个考试就没了」。
# 这里补上「找卷 → 解析 → 入库」：卷源不预置，AI 现搜现取。
# 解析只认**正文**（题干 + A/B/C/D + 答案区），图片版 PDF 读不出来就如实说读不出来，
# 不拿「看起来像题的句子」凑数 —— 卷子里的题必须是原文里真有的。
_RE_Q = re.compile(r"^\s*(?:第\s*)?(\d{1,3})\s*[.、．)）]\s*(.*)$")
_RE_OPT = re.compile(r"([A-E])\s*[.、．)）]\s*")
_RE_ANS_PAIR = re.compile(r"(\d{1,3})\s*[.、．)）:：\-]\s*([A-E])(?![A-Za-z])")
_RE_ANS_RANGE = re.compile(r"(\d{1,3})\s*[-~—–至]\s*(\d{1,3})\s*[:：]?\s*([A-E]{2,})")
_RE_ANS_HEAD = re.compile(r"^\s*(?:参考)?答\s*案|^\s*answer\s*key|^\s*key\s*[:：]", re.I)


def _split_opts(line):
    """一行里拆出 (字母, 内容)。「A. xx B. yy」和「A.xx」两种都认。"""
    hits = list(_RE_OPT.finditer(line))
    if not hits:
        return []
    if len(hits) == 1 and hits[0].start() > 0:
        return []                      # 选项后面还有正文，不算选项行
    out = []
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(line)
        txt = line[m.end():end].strip(" ;；,，")
        if txt:
            out.append((m.group(1), txt))
    return out


def _scan_answers(line, box):
    """从答案区一行里捞 {题号: 字母}。认「1-5 ABCDA」「1.A 2.B」两种。"""
    for m in _RE_ANS_RANGE.finditer(line):
        a, b, seq = int(m.group(1)), int(m.group(2)), m.group(3)
        if b - a + 1 == len(seq):
            for i, ch in enumerate(seq):
                box[a + i] = ch
    for m in _RE_ANS_PAIR.finditer(line):
        box[int(m.group(1))] = m.group(2)


def _parse_paper_text(text, max_q=200):
    """正文 → [{no, orig, stem, opts, ans}]。解析不出来就是空列表，不猜。"""
    raw = str(text or "").replace("\u3000", " ")
    raw = re.sub(r"(?m)^\s*(?:第\s*\d+\s*页.*|-\s*\d+\s*-|\d+\s*/\s*\d+)\s*$", "", raw)
    lines = [ln.strip() for ln in raw.splitlines()]
    body, ans_part, in_ans = [], [], False
    for ln in lines:
        if not ln:
            continue
        if _RE_ANS_HEAD.match(ln):
            in_ans = True
            ans_part.append(ln)
            continue
        (ans_part if in_ans else body).append(ln)

    items, cur = [], None
    for ln in body:
        m = _RE_Q.match(ln)
        # 「1. A. xx」这种是选项行，不是新题：题号后面紧跟着选项字母
        if m and not (len(m.group(2)) > 1 and _RE_OPT.match(m.group(2))):
            if cur and len(cur["opts"]) >= 2:
                items.append(cur)
            elif cur and cur["stem"] and len(cur["opts"]) < 2:
                items.append(cur)          # 填空/简答：没选项也算一道
            cur = {"orig": int(m.group(1)), "stem": m.group(2).strip(), "opts": {}, "ans": None}
            for k, v in _split_opts(cur["stem"]):
                cur["opts"][k] = v
            if cur["opts"]:
                cur["stem"] = _RE_OPT.split(cur["stem"])[0].strip()
            continue
        if cur is None:
            continue
        opts = _split_opts(ln)
        if opts:
            for k, v in opts:
                cur["opts"][k] = v
        elif cur["stem"] and not cur["opts"]:
            cur["stem"] = (cur["stem"] + " " + ln).strip()   # 题干折行
    if cur:
        items.append(cur)

    box = {}
    for ln in ans_part:
        _scan_answers(ln, box)
    keep = []
    for it in items:
        if not it["stem"] or len(it["stem"]) < 4:
            continue
        it["ans"] = box.get(it["orig"]) or it.get("ans")
        keep.append(it)
    keep = keep[:max_q]
    for i, it in enumerate(keep):
        it["no"] = i + 1
    return keep


def _paper_id(url, name):
    import hashlib
    h = hashlib.md5((str(url or "") + "|" + str(name or "")).encode("utf-8")).hexdigest()
    return "web-%s" % h[:10]


@tool("paper_search", config.PERM_NET,
      "找真题卷：按关键词联网搜，返回候选链接并现场试读（看这页能不能解析出题）")
def t_paper_search(keyword=None, limit=8, probe=True, **_):
    """搜卷 + 现场验。

    「有没有这套卷」不能凭标题猜 —— 这里对前几个候选真去 fetch 一遍，
    数一数能认出多少道题，把「读得出来 / 读不出来」直接写进结果。
    """
    kw = str(keyword or "").strip()
    if not kw:
        return {"ok": False, "error": "给个关键词，比如「2023 广东专升本 政治 真题」"}
    r = websearch.search(kw, limit=max(1, min(int(limit or 8), 12)))
    if not r.get("ok"):
        return {"ok": False, "error": r.get("reason") or "搜索没返回", "items": [],
                "say": "没搜到：%s" % (r.get("reason") or "搜索引擎没返回")}
    rows = []
    for i, it in enumerate((r.get("items") or [])[:8]):
        row = {"title": it.get("title"), "url": it.get("url"),
               "snippet": (it.get("snippet") or "")[:120], "probed": False}
        if probe and i < 3:
            f = websearch.fetch(it.get("url"), max_chars=20000)
            row["probed"] = True
            if f.get("ok"):
                qs = _parse_paper_text(f.get("text") or "")
                row["questions"] = len(qs)
                row["with_opts"] = len([1 for q in qs if len(q["opts"]) >= 2])
                row["with_ans"] = len([1 for q in qs if q.get("ans")])
            else:
                row["read_error"] = f.get("reason")
        rows.append(row)
    good = [x for x in rows if (x.get("questions") or 0) >= 5]
    return {"ok": True, "keyword": kw, "engine": r.get("engine"), "items": rows,
            "count": len(rows), "readable": len(good),
            "say": ("搜到 %d 条候选，试读了 %d 条，其中 %d 条能认出 5 题以上。"
                    % (len(rows), len([x for x in rows if x["probed"]]), len(good)))
                   + ("先拉这条：%s" % good[0]["url"] if good else
                      "这几条都没解析出题（可能是图片/PDF）；把正文复制给 paper_pull(text=...) 再试。"),
            "effect": "%d candidates / %d readable" % (len(rows), len(good)),
            "next": "paper_pull(url=…, subject=…, year=…)"}


@tool("paper_pull", config.PERM_NET,
      "把一套真题卷拉进本机（给 url 或正文都行；解析出题干/选项/答案，进真题卷列表）")
def t_paper_pull(url=None, text=None, subject=None, subject_name=None,
                 name=None, year=None, **_):
    """解析正文 → 一套卷 → data/papers_extra.json（只读源不动）。

    有答案就能交卷判分；没答案的照收，但标 `answers=false`，
    评分那一步不进分母 —— 「没答案的卷子算 0 分」是最坑人的假分数。
    """
    body = str(text or "")
    if not body and url:
        f = websearch.fetch(url, max_chars=40000)
        if not f.get("ok"):
            return {"ok": False, "error": f.get("reason") or "取不回来",
                    "say": "这页没取回来：%s" % (f.get("reason") or "")}
        body = f.get("text") or ""
    if not body.strip():
        return {"ok": False, "error": "没给 url 也没给正文",
                "say": "没卷子内容：给个链接，或者把卷子正文整段贴进来。"}
    tick("解析题面", n=1, total=3)
    qs = _parse_paper_text(body)
    withopts = [q for q in qs if len(q["opts"]) >= 2]
    if len(withopts) < 3:
        return {"ok": False, "found": len(qs), "with_opts": len(withopts),
                "error": "解析不出题（认出 %d 道，带选项的 %d 道）" % (len(qs), len(withopts)),
                "say": ("这段正文只认出 %d 道带选项的题，不够一套卷 —— 多半是图片版或排版太散。"
                        "把题目正文（带 A/B/C/D 和答案）整段贴进来再试。" % len(withopts))}
    with_ans = [q for q in withopts if q.get("ans")]
    nm = str(name or "").strip() or ("网上拉取的卷 · %s" % (year or dt.date.today().year))
    sid, sname = None, None
    try:
        sub = datahub.subject_flex(datahub.proto(), subject or "")
        sid = (sub or {}).get("id") or datahub.canonical_subject_id(subject or nm)
        sname = (sub or {}).get("name") or datahub.canonical_subject_name(sid)
    except Exception:
        sid = datahub.canonical_subject_id(subject or nm) or "web"
    sid = sid or "web"
    sname = subject_name or sname or sid
    pid = _paper_id(url, nm)
    paper = {
        "id": pid, "name": nm, "region": sname, "year": str(year or ""),
        "subject": sid, "pdf": None, "total": len(withopts), "answered": 0,
        "origin": "web" if url else "pasted", "source_url": url or "",
        "answers": bool(with_ans),
        "pulled_at": store.now(),
        "groups": [{"type": "single", "label": "单项选择题（网上拉取）",
                    "material": None,
                    "questions": [{"orig": q["orig"], "stem": q["stem"],
                                   "opts": q["opts"], "no": q["no"], "ans": q.get("ans")}
                                  for q in withopts]}],
    }
    tick("写进真题卷", n=2, total=3)
    ex = datahub.papers_extra()
    papers = [p for p in (ex.get("papers") or []) if p.get("id") != pid]
    papers.append(paper)
    datahub.save_papers_extra({"papers": papers})
    tick("核对题量", n=3, total=3)
    miss = len(withopts) - len(with_ans)
    return {"ok": True, "paper_id": pid, "name": nm, "subject": sid, "subject_name": sname,
            "questions": len(withopts), "with_answers": len(with_ans),
            "answers": bool(with_ans), "year": paper["year"],
            "say": ("拉进来了：《%s》，%d 道选择题，其中 %d 道有答案。%s"
                    % (nm, len(withopts), len(with_ans),
                       "可以交卷判分。" if not miss else
                       "还有 %d 道没答案，那几道不计分（不拿没答案的题算 0 分）。" % miss)),
            "effect": "+1 paper / %d questions -> %s" % (len(withopts), pid),
            "note": "来源：%s。卷子在「真题卷」里，标 origin=web。" % (url or "直接粘的正文")}


@tool("paper_drop", config.PERM_CONFIRM, "删掉一套拉进来的真题卷（只删网上拉的，自带那 15 套不许删）")
def t_paper_drop(paper_id=None, **_):
    """拉错了要能收回。自带卷（origin=builtin）一律拒收 —— 那是只读源，不归这个工具管。"""
    pid = str(paper_id or "").strip()
    if not pid:
        return {"ok": False, "error": "没给 paper_id"}
    ex = datahub.papers_extra()
    papers = ex.get("papers") or []
    hit = next((p for p in papers if p.get("id") == pid), None)
    if not hit:
        return {"ok": False, "error": "这套卷不是拉进来的（只删 papers_extra 里的）",
                "say": "没删：自带的那几套卷不归拉取工具管。"}
    datahub.save_papers_extra({"papers": [p for p in papers if p.get("id") != pid]})
    return {"ok": True, "removed": pid, "name": hit.get("name"), "left": len(papers) - 1,
            "say": "删掉了《%s》，还剩 %d 套拉进来的卷。" % (hit.get("name"), len(papers) - 1),
            "effect": "paper %s removed" % pid}


@tool("list_exam_papers", config.PERM_LOCAL, "列出可判分真题卷与真实已答数")
def t_exam_papers(**_):
    ps = datahub.exam_paper_meta()
    return {"papers": ps,
            "total_questions": sum(x["total"] or 0 for x in ps),
            "answered_all": sum(x["answered"] for x in ps),
            "note": "题量来自 exam_papers.json 实际条目；已答/对错来自本机作答记录"}


@tool("get_exam_paper", config.PERM_LOCAL, "取一套真题卷的题组与题目（不含答案）")
def t_get_exam_paper(paper_id=None, group_index=0, with_answer=False, **_):
    if not paper_id:
        ps = datahub.exam_paper_meta()
        if not ps:
            return {"error": "没有真题卷"}
        paper_id = ps[0]["id"]
    return datahub.exam_paper(paper_id, group_index, with_answer=bool(with_answer))


@tool("submit_exam", config.PERM_LOCAL, "交卷：按题型权重算分并落一次交卷记录")
def t_submit_exam(paper_id=None, seconds=None, **_):
    """D4 整卷模考评分。

    只算**本机真的答过**的题（事件库 kind=exam_answer）。没答的题就是没答，
    不补 0 分以外的任何推测——但会如实告诉用户"还有 N 题没做"。
    """
    if not paper_id:
        ps = datahub.exam_paper_meta()
        if not ps:
            return {"error": "没有真题卷"}
        paper_id = ps[0]["id"]
    shape = datahub.exam_paper_shape(paper_id)
    if not shape:
        return {"error": "没有这套卷: %s" % paper_id}
    st = store.exam_state_all().get(paper_id) or {}

    rows, detail, raw, max_raw = [], [], 0.0, 0.0
    for grp in shape:
        rule = config.EXAM_TYPE_RULES.get(grp["type"]) or {}
        each = float(rule.get("each") or 1.0)
        judgeable = bool(grp["judgeable"])
        nos = grp["nos"]
        done = [n for n in nos if n in st]
        hit = [n for n in done if st[n] == 1]
        if judgeable:
            raw += len(hit) * each
            max_raw += len(nos) * each
        rows.append({
            "type": grp["type"], "label": grp["label"], "each": each,
            "judgeable": judgeable,
            "total": len(nos), "answered": len(done), "right": len(hit),
            "wrong": len(done) - len(hit),
            "got": (round(len(hit) * each, 2) if judgeable else None),
            "full": (round(len(nos) * each, 2) if judgeable else None),
            "src": rule.get("src") or "",
        })
        for n in nos:
            if n in st:
                detail.append({"qno": n, "type": grp["type"], "ok": int(st[n]),
                               "each": each if judgeable else None})

    judgeable_total = sum(r["total"] for r in rows if r["judgeable"])
    answered = sum(r["answered"] for r in rows)
    right = sum(r["right"] for r in rows)
    scored = (round(raw / max_raw * config.EXAM_TOTAL_SCORE, 1) if max_raw else None)
    best = store.exam_best(paper_id)
    sid = store.save_exam_session(paper_id, judgeable_total, answered, right,
                                  raw, max_raw, scored, seconds or 0, detail)
    store.add_event("exam_submit", part=paper_id, ok=None,
                    payload="scored=%s answered=%d/%d" % (
                        scored, answered, judgeable_total))
    _ptt = {"judgeable": judgeable_total, "answered": answered, "right": right,
            "wrong": answered - right, "unanswered": judgeable_total - answered,
            "raw": round(raw, 2), "max_raw": round(max_raw, 2),
            "scored": scored, "full": config.EXAM_TOTAL_SCORE,
            "pass": (None if scored is None else scored >= config.EXAM_PASS_SCORE),
            "pass_line": config.EXAM_PASS_SCORE,
            "accuracy": (round(right * 100.0 / answered, 1) if answered else None)}
    _nm = next((p["name"] for p in datahub.exam_paper_meta()
                if p["id"] == paper_id), paper_id)
    if scored is None:
        _ans_ok = next((p.get("answers") for p in datahub.exam_paper_meta()
                        if p["id"] == paper_id), True)
        _say = (("%s 是网上拉来的卷，原页没找到答案，只能当练习、不判分（答了 %d 题、对不了对错）。"
                 % (_nm, answered))
                if _ans_ok is False else
                ("%s 交卷了，但这份卷子里没有可判分的题，算不出分数。"
                 "答了 %d 题、对 %d 题。" % (_nm, answered, right)))
    else:
        _say = ("%s 交卷：%.1f / %d 分（%s），答了 %d/%d 题，对 %d、错 %d、没答 %d。"
                "这次记录已落库。" % (
                    _nm, scored, config.EXAM_TOTAL_SCORE,
                    "过线" if scored >= config.EXAM_PASS_SCORE else "没过线",
                    answered, judgeable_total, right, answered - right,
                    judgeable_total - answered))
    return {
        "paper_id": paper_id,
        "session_id": sid,
        "say": _say,
        "effect": "exam %s scored=%s answered=%d/%d" % (
            paper_id, scored, answered, judgeable_total),
        "name": next((p["name"] for p in datahub.exam_paper_meta()
                      if p["id"] == paper_id), paper_id),
        "rows": rows,
        "totals": {
            "judgeable": judgeable_total, "answered": answered, "right": right,
            "wrong": answered - right, "unanswered": judgeable_total - answered,
            "raw": round(raw, 2), "max_raw": round(max_raw, 2),
            "scored": scored, "full": config.EXAM_TOTAL_SCORE,
            "pass": (None if scored is None else scored >= config.EXAM_PASS_SCORE),
            "pass_line": config.EXAM_PASS_SCORE,
            "accuracy": (round(right * 100.0 / answered, 1) if answered else None),
        },
        "best": best,
        "seconds": int(seconds or 0),
        "note": ("分数按题型权重算（权重在 server/config.py）：没答的题记 0 分，"
                 "语法填空要自己写词、本机不判分，所以不计入总分。"
                 if answered else "这套卷一道题都还没答，先去答几题再交卷。"),
    }


@tool("exam_scores", config.PERM_LOCAL, "这套卷的历史交卷记录（真交过才有）")
def t_exam_scores(paper_id=None, limit=10, **_):
    rows = store.exam_sessions(paper_id, limit)
    best = store.exam_best(paper_id) if paper_id else {"best": None, "sessions": len(rows)}
    return {"paper_id": paper_id, "sessions": rows, "count": len(rows),
            "best": best,
            "note": ("还没有交过卷——分数只在你点了「交卷看分」之后产生"
                     if not rows else "每次交卷一行，来自本机 exam_sessions 表")}


@tool("word_sentences", config.PERM_LOCAL, "取这个单词在真卷里的真例句")
def t_word_sentences(word=None, limit=3, **_):
    if not word:
        return {"error": "没给单词"}
    return datahub.sentences_of(word, limit)


@tool("today_summary", config.PERM_LOCAL, "今日已完成动作的真实汇总")
def t_today_summary(**_):
    ev = store.events_today()
    kinds = {}
    for e in ev:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    return {"events": len(ev), "by_kind": kinds, "seconds": sum(e.get("seconds") or 0 for e in ev),
            "recent": store.recent_events(8), "days7": store.last_7d_minutes()}


@tool("ask_ai", config.PERM_NET, "让 AI 讲题（要带讲次与时间点一起问，需要接模型）")
def t_ask_ai(qno=None, question=None, lesson_id=None, pos_sec=None, subject=None, **_):
    """E2：提问必须带上下文——讲次 + 视频里的第几秒。

    接了模型就真去问：把上下文（讲次 / 章节 / 科目 / 视频第几秒）一起递过去，
    回答旁边标清是哪家的哪个模型说的 —— **那是模型的话，不是本机数据**，
    所以题库解析照旧一并返回，那个才是能核对的真东西。

    没接时不编答案：题库有解析就回落解析，并把这次提问（含时间点）记进事件库，
    等真接了模型，这条上下文还在。
    """
    sub, les = (None, None)
    if lesson_id:
        sub, les = datahub.find_lesson(datahub.proto(), lesson_id)
    pos = None
    try:
        pos = None if pos_sec is None else round(float(pos_sec), 1)
    except (TypeError, ValueError):
        pos = None
    ctx = []
    if les:
        ctx.append("讲次：%s" % (les.get("title") or lesson_id))
        if les.get("chapter"):
            ctx.append("章节：%s" % les.get("chapter"))
    if sub:
        ctx.append("科目：%s" % (sub.get("name") or sub["id"]))
    if pos is not None:
        ctx.append("视频位置：%s" % mss(pos))
    ok, why = (False, "本机未接模型：ENABLE_LLM=false")
    if config.ENABLE_LLM:
        ok, why = model_router.available()
    out = {"available": False,
           "reason": why,
           "answer": None,
           "context": ctx,
           "lesson_id": lesson_id, "pos_sec": pos,
           "note": ("题库每道题都自带解析，先用那个——那是真数据，不是模型编的。"
                    "要接模型改 server/config.py 的 ENABLE_LLM。")}
    if qno is not None:
        q = datahub.question_by_no(qno)
        if q:
            out["fallback_explain"] = q.get("explain")
            out["fallback_ans"] = q.get("ans")
    if les:  # 该讲次的词锚点：问"这个词"时能指到具体位置
        lw = datahub.lesson_words(lesson_id)
        if lw.get("is_word_lesson"):
            out["lesson_words"] = [w["w"] for w in lw.get("words") or []][:20]
    if ok:
        sys_p = ("你是备考辅导助手。分两类问题：\n"
                 "1. 学科知识、解题方法、语法规则这类通识问题——正常回答，讲清楚，"
                 "这类你本来就该会；\n"
                 "2. 关于这台机器上的数据（学到哪一讲、做对几题、课程怎么排）——"
                 "上下文里没给的就直说不知道，一个字都不许编。\n"
                 "讲题先给结论，再说为什么，最后给一句怎么记。"
                 "不复述题目，不客套，不写开场白。")
        ask = (question or "").strip()
        if not ask and out.get("fallback_ans") is not None:
            ask = "这道题怎么做？答案是什么？"
        if ask:
            t0 = time.time()
            r = model_router.chat(sys_p, ("\n".join(ctx) + "\n\n问题：" + ask).strip(),
                                  temperature=config.LLM_TEMPERATURE,
                                  timeout=config.LLM_TIMEOUT)
            out["ms"] = int((time.time() - t0) * 1000)
            txt = (r.get("text") or "").strip()
            if r.get("ok") and txt:
                out.update(available=True, answer=txt, reason="ok",
                           provider=r.get("provider"), model=r.get("model"),
                           note=("这是 %s（%s）说的，是模型的话不是本机数据；"
                                 "题库解析也在下面，那个才是对得上的真东西。"
                                 % (r.get("provider"), r.get("model"))))
            else:
                out["reason"] = r.get("reason") or "模型没回话"
                out["note"] = ("模型没答上来，先用题库解析——那是真数据。"
                               "失败原因原样贴在上面，不替它遮。")
    store.add_event("ask_ai", qno=qno, subject=subject or (sub or {}).get("id"),
                    lesson_id=lesson_id,
                    payload=(" | ".join(ctx) + " || " + str(question or ""))[:300])
    return out


@tool("explain_question", config.PERM_LOCAL,
      "讲一道题：先捞依据，再按定位/依据/判断/纠错四段讲（本机可跑，不必接模型）")
def t_explain_question(source=None, ref=None, qno=None, chosen=None,
                       style=None, save=True, use_model=None, **_):
    """讲题的唯一入口。

    关键取舍：它和 ask_ai 是两件事。
      ask_ai          拿着题干去问模型"这题怎么解" —— 模型没接就只剩题库解析
      explain_question 先把本机能核对的依据捞齐，再在依据上讲 ——
                       模型没接也讲得出，只是讲得朴素；接了模型讲得好听，
                       但每一句仍然要挂在依据上，引文对不上原文就作废

    所以界面上"讲题"按钮走这里，本机就能用；模型只是让措辞更顺，
    不是它能不能工作的前提。
    """
    src = source or datahub.default_source()
    rf = ref if ref is not None else qno
    if rf is None:
        return {"ok": False, "error": "没指定讲哪一道题（source + ref）"}
    if not src:
        return {"ok": False, "reason": "这台机器上还没有任何题源，没题可讲。"}
    doc = explain.explain(str(src), str(rf), chosen=chosen,
                          style=style or explain.STYLE_STANDARD,
                          save=bool(save), use_model=use_model)
    if not doc.get("found"):
        store.add_event("explain", subject=None,
                        payload=("讲不了 %s|%s" % (src, rf))[:300])
        return {"ok": False, "reason": doc.get("verdict_note"), **doc}
    store.add_event("explain", subject=None,
                    payload=("讲题 %s|%s conf=%s" % (src, rf, doc.get("confidence")))[:300])
    doc["ok"] = True
    return doc


@tool("rate_explain", config.PERM_LOCAL, "给这一讲打分：讲得对 / 讲错了（留痕，用来数准确率）")
def t_rate_explain(source=None, ref=None, style=None, up=False, down=False, **_):
    """学生自己判这一讲对不对。

    打回不是删掉，是记下来。以后统计页上的"讲错率"就是从这来的 ——
    一个会承认自己讲错、并且能被数出来的系统，才敢让评委现场随便点一道题。
    """
    src = source or datahub.default_source()
    if ref is None:
        return {"ok": False, "error": "没指定哪一道题"}
    if not src:
        return {"ok": False, "error": "这台机器上还没有任何题源"}
    cur = store.get_explain(str(src), str(ref), style or "standard")
    if not cur:
        return {"ok": False, "error": "这道题还没讲过，没有可评的讲解"}
    r = store.vote_explain(str(src), str(ref), style or "standard",
                           up=bool(up), down=bool(down))
    store.add_event("explain_vote", subject=None,
                    payload=("%s|%s %s" % (src, ref, "up" if up else "down"))[:300])
    return {"ok": True, "votes_up": (r or {}).get("votes_up", 0),
            "say": "投了「%s」。这份讲解现在 %d 赞 / %d 踩。" % (
                "有用" if up else "没用", (r or {}).get("votes_up", 0),
                (r or {}).get("votes_down", 0)),
            "effect": "vote %s" % ("up" if up else "down"),
            "votes_down": (r or {}).get("votes_down", 0)}


@tool("explain_coverage", config.PERM_LOCAL,
      "讲题的家底：每个题源能讲多少道、置信度多少、多少条依据通过复核")
def t_explain_coverage(sample=None, **_):
    """把「这个 AI 到底靠不靠谱」变成可查的数字，而不是一句自评。

    三个口径分开算，因为它们说的不是一件事：
      可讲率   有依据、能讲得出来的比例 —— 讲不了的不许硬讲，所以这个数不会到 100%
      置信度   依据核验过的比例折算，依据有一条没过复核就整体打折
      复核率   依据在原文/题库里能否逐字命中 —— 这是唯一能机器判真假的部分
    真题卷那 699 道「只能靠背」不是缺陷，是原卷只给了答案没给依据；
    把它们算进分母，才说明这套东西是真在核，不是在秀。
    """
    import collections
    verd = collections.Counter()
    by = collections.defaultdict(collections.Counter)
    confs = []
    n = 0
    cap = int(sample or 0)

    def rec(sid, ref):
        nonlocal n
        n += 1
        d = explain.build(sid, ref)
        verd[d.get("verdict")] += 1
        by[sid][d.get("verdict")] += 1
        confs.append(d.get("confidence") or 0)

    parts = [x["name"] for x in
             (datahub.proto().get("exercise_bank") or {}).get("parts") or []]
    seen = 0
    for pname in parts:
        for q in datahub.questions_of_part(pname, 5000, 0, True)["questions"]:
            seen += 1
            if cap and seen > cap:
                break
            rec(datahub.SRC_GRAMMAR, str(q["no"]))
    for p in datahub.exam_papers()["papers"]:
        for g in p["groups"]:
            if g.get("type") not in datahub._EXAM_JUDGEABLE:
                continue
            for q in g["questions"]:
                if cap and seen >= cap:
                    break
                seen += 1
                rec(datahub.SRC_EXAM, "%s|%s" % (p["id"], q["no"]))
    for sid in ("pc-cs99", "pc-cs500", "pc-pol390"):
        for q in datahub.source_questions(sid, limit=5000)["questions"]:
            if cap and seen >= cap:
                break
            seen += 1
            rec(sid, str(q["no"]))

    good = verd["有据可依"] + verd["依据部分成立"]
    return {
        "total": n,
        "by_verdict": dict(verd),
        "speakable": good,
        "speakable_rate": round(good / float(n), 3) if n else 0,
        "avg_confidence": round(sum(confs) / float(len(confs)), 3) if confs else 0,
        "by_source": {k: dict(v) for k, v in by.items()},
        "stored": store.explain_stats(),
        "note": "「只能靠背」= 原卷只给了答案没给依据，本机不编，让人自己背。",
    }


def mss(sec):
    sec = int(sec or 0)
    return "%02d:%02d" % (sec // 60, sec % 60)


@tool("ai_providers", config.PERM_LOCAL, "现在有哪几家模型能用、选的是哪家、各自的登录态")
def t_ai_providers(**_):
    """给界面用的快照：选了谁、每家现在什么状态、当前模型名。

    状态全是不联网读出来的（读本机凭据文件和 config），界面可以放心反复刷。
    要看真能用的模型清单请用 ai_models —— 那个要联网。
    """
    return model_router.state()


@tool("ai_use", config.PERM_LOCAL, "指定用哪一家来说话（apikey / workbuddy / trae）")
def t_ai_use(provider=None, model=None, function=None, ctx=None, **_):
    """选一家。选完就写在 kv 里，讲题、作文批改、提问都跟着换。

    不校验「这家能不能用」—— 选了一家没登录的，界面上会显示它没登录，
    而不是在这里拦下来。拦下来会让人以为选成功了。

    function：Trae 这类平台把「哪个模型名能说话」拆到了 function 上，
    模型目录里每个模型都带着自己那个，所以选模型时一起存（见 model_router.function_of）。
    ctx：目录里给的上下文窗口，底部状态条算占用率要用它 —— 不存就没法算，宁可空着。
    """
    r = model_router.set_current(provider)
    if not r.get("ok"):
        return r
    if model:
        m = model_router.set_model(provider, model)
        if not m.get("ok"):
            r["model_error"] = m.get("error")
        else:
            r["model"] = m.get("model")
    if function:
        f = model_router.set_function(provider, function)
        if not f.get("ok"):
            r["function_error"] = f.get("error")
        else:
            r["function"] = f.get("function")
    if ctx:
        c = model_router.set_ctx(provider, ctx)
        if c.get("ok"):
            r["ctx"] = c.get("ctx")
    r["state"] = model_router.state()
    return r


@tool("course_add", config.PERM_CONFIRM, "把一门核过的 B 站课正式加进本机课程库（分集变讲次）")
def t_course_add(bvid=None, name=None, subject=None, score=None, kind="video", **_):
    """「认下了」原来是一句空话。

    实测：intake_apply 只把候选写进 kv `intake.courses`，全仓零处读它 ——
    所以人看到「这门课我记下了」，下一句 list_subjects 照样空、pick_lesson 直接
    「没有这个讲次: 1」。课在 intake 里，不在课程库里。

    这里补上落库那一步：拿 BV 号当真源，现场拉一遍分集（不信内存里的旧数据），
    写进 data/courses_extra.json，datahub.proto() 读的时候合并进来。
    """
    if not bvid or not str(bvid).strip().upper().startswith("BV"):
        return {"ok": False, "reason": "给一个 BV 号。"}
    bvid = str(bvid).strip()
    tick("取这条课的基本信息（标题/UP/封面）", n=1, total=3)
    vw = bili.view(bvid)
    vw, verr = vw if isinstance(vw, tuple) else (vw, None)
    if verr or not vw:
        return {"ok": False, "reason": "这条课现在取不到：%s" % (verr or "view 空返回")}
    tick("拉分集表（每一 P 的标题和时长）", n=2, total=3)
    pg = bili.pages(bvid)
    rows, perr = pg if isinstance(pg, tuple) else (pg, None)
    if perr or not rows:
        return {"ok": False, "reason": "分集取不到，先别入库：%s" % (perr or "空")}

    # 模型会把界面上的中文名当 id 传进来（「英语」）。不认就直接落库的话，
    # 用户会凭空多出一门叫「英语」的科目，讲次 id 是「英语-001」，进度接不回去。
    #
    # 2026-10-26 加：卡片按钮只带 bvid（模型出卡时没写 subject），点下去全报
    # 「没说这门课归到哪一科」，人看到的就是四个按钮全死。所以缺科目时自己找两次：
    #   ① 这门 BV 已经在库里 → 照那条记录的 subject_id 接回去（最常见：重复点入库）
    #   ② 库里没有 → 拿 B 站标题认一次（「英语盖老师英汉互译技巧」→ english）
    # 两次都不成才问人，绝不瞎猜一门塞进去。
    _proto = datahub.proto()
    ex = datahub.courses_extra()
    subs = list(ex.get("subjects") or [])
    _dup = next((s for s in subs if str(s.get("bvid") or "") == bvid and s.get("id")), None)
    _key, _from = subject, ""
    if not _key and _dup:
        _key = _dup.get("subject_id") or _dup.get("subject_name")
        _from = "照库里那条记录接的"
    _sub = datahub.subject_flex(_proto, _key)
    base = (_sub or {}).get("id") or datahub.canonical_subject_id(_key)
    if not base and not _key:
        base = datahub.canonical_subject_id(vw.get("title"))
        if base:
            _from = "从课程标题里认出来的"
    if not base:
        if not _key:
            return {"ok": False, "reason":
                    "没说这门课归到哪一科，标题里也认不出来（%s）。现有科目：%s。"
                    % (str(vw.get("title") or bvid)[:30],
                       "、".join("%s(%s)" % (s.get("id"), s.get("name"))
                                for s in (_proto.get("subjects") or [])[:8]) or "一台空库")}
        # 真·新科目：只留字母数字，别把中文名当 id 写进库
        base = re.sub(r"[^a-z0-9_-]+", "", str(_key).lower())[:24] or "course"
    # 科目中文名：科目 id 的规范中文名优先。别拿 s["name"] 当科目名 ——
    # 课程库里一条记录 = 一门课，name 是课程标题（「伍老师 各省真题阅读66篇」），
    # 拿它当科目名会让「这门课归到哪一科」写成另一门课的名字。
    sub_name = (datahub.canonical_subject_name(base)
                or (_sub or {}).get("subject_name")
                or (_sub or {}).get("name")
                or str(_key or base))
    # 课程库是「一条记录 = 一门课」，id 拿来当主键。所以：
    #   ① 这门 BV 已经入过 → 更新原来那条，别再建一条（以前高数因此存成了两份）
    #   ② 这一科已经有别的课了 → 另给一个不撞的 id，不然第二门会把第一门覆盖掉
    if _dup:
        sid = str(_dup["id"])
        _how = "更新了已有的那条"
    elif any(str(s.get("id") or "") == base for s in subs):
        sid = "%s-%s" % (base, bvid.lower())
        _how = "这一科之前已经有一门课，给新的这条单独一个 id"
    else:
        sid = base
        _how = "新建了这一科"
    if _from:
        _how = "%s，%s" % (_how, _from)
    title = str(name or vw.get("title") or bvid).strip()[:60]
    lessons = []
    for i, x in enumerate(rows):
        lessons.append({
            "id": "%s-%03d" % (sid, i + 1),
            "title": (x.get("part") or "第%d集" % (i + 1))[:60],
            "chapter": "分集",
            "dur": int(x.get("secs") or 0),
            "page": x.get("page") or (i + 1),
            "local": False,
        })
    total = sum((x.get("secs") or 0) for x in rows)
    sub = {
        "id": sid, "name": title, "score": score, "kind": kind,
        # 科目归到哪一门单独存字段：id 里可能带着 BV 号，靠它猜科目会猜错。
        # 界面配色、按科筛选、讲次归属都读这两个。
        "subject_id": base, "subject_name": sub_name,
        "bvid": bvid, "video_up": (vw.get("owner") or {}).get("name") if isinstance(vw.get("owner"), dict) else vw.get("owner"), "video_pages": len(rows),
        "video_title": title, "cover": vw.get("pic"),
        "total_secs": total, "lessons": lessons, "origin": "bili",
        "added_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    subs = [s for s in subs if str(s.get("id") or "") != sid]
    subs.append(sub)
    tick("写进本机课程库（%d 讲）" % len(lessons), n=3, total=3)
    datahub.save_courses_extra({"subjects": subs})
    mins = round(total / 60.0, 1)
    return {"ok": True, "subject": sid, "subject_id": base, "subject_name": sub_name,
            "name": title, "bvid": bvid, "lessons": len(lessons), "minutes": mins,
            "effect": "%s: %d lessons / %.0f min -> 课程库" % (sid, len(lessons), mins),
            "say": "入库了：%s，%d 讲 / %.0f 分钟，归到「%s」（%s）。现在能选讲次、记进度、排每天学什么了。"
                   % (title, len(lessons), mins, sub_name, _how)}


@tool("course_add_many", config.PERM_CONFIRM,
      "一次入库几门核过的课（逐门真拉分集，一门失败不影响别的，最后逐门报结果）")
def t_course_add_many(items=None, subject=None, **_):
    """卡片上给了三个「入库这门」，人想的是「全部入库」—— 三次点击不是体验问题，是设计漏了。

    items 收两种写法：[{"bvid","name","subject"}] 或 ["BV1xx", ...]。
    每门走的是同一个 t_course_add（同一条路，不另写一套），所以核时长、查重、
    id 归属、逐门自报成效全都一致 —— 这里只负责串联和把结果汇总成一句话。
    """
    seq = []
    for it in (items or []):
        if isinstance(it, str):
            seq.append({"bvid": it})
        elif isinstance(it, dict) and it.get("bvid"):
            seq.append(it)
    if not seq:
        return {"ok": False, "reason": "没给要入库的课（items 里每项要有 bvid）"}
    # 同一门课在 items 里出现两次是模型常犯的错（出卡时把同一颗按钮写了两遍，
    # 人点「全部入库（3 门）」实际只有 2 门）。按 bvid 去重，别为同一门拉两遍分集。
    _seen, _uniq = set(), []
    for it in seq:
        bv = str(it["bvid"]).strip()
        if bv.lower() in _seen:
            continue
        _seen.add(bv.lower())
        it["bvid"] = bv
        _uniq.append(it)
    seq = _uniq
    if len(seq) > 8:
        seq = seq[:8]
    done, failed = [], []
    for i, it in enumerate(seq):
        tick("入库第 %d/%d 门：%s" % (i + 1, len(seq), str(it.get("name") or it["bvid"])[:24]),
             n=i + 1, total=len(seq))
        try:
            got = t_course_add(bvid=it["bvid"], name=it.get("name"),
                               subject=it.get("subject") or subject, score=None)
        except Exception as e:
            got = {"ok": False, "reason": "%s: %s" % (type(e).__name__, e)}
        if got.get("ok"):
            done.append(got)
        else:
            failed.append({"bvid": it["bvid"],
                           "name": it.get("name") or it["bvid"],
                           "why": got.get("reason") or "原因没拿到"})
    if done:
        _tot_min = sum((x.get("minutes") or 0) for x in done)
        say = "入库了 %d 门：%s。合计 %.1f 小时，现在能选讲次、记进度、排每天学什么了。" % (
            len(done),
            "；".join("%s（%d 讲 / %.0f 分钟）" % (x.get("name"), x.get("lessons") or 0,
                                                x.get("minutes") or 0) for x in done),
            _tot_min / 60.0)
        if failed:
            say += "另外 %d 门没进去：%s。" % (
                len(failed), "；".join("%s（%s）" % (f["name"], f["why"]) for f in failed))
    else:
        say = "一门都没进去：%s。" % "；".join(
            "%s（%s）" % (f["name"], f["why"]) for f in failed)
    # 一门都没成时，reason 直接把第一门的原因说出来 —— 只回「全都没成」等于什么都没说，
    # 人只能盯着一个红字猜。
    _why = None
    if not done:
        _why = (failed[0]["why"] if failed else "没有可入库的课")[:160]
    return {"ok": bool(done), "added": len(done), "failed": len(failed),
            "courses": [{"bvid": x.get("bvid"), "name": x.get("name"),
                         "subject": x.get("subject"), "subject_name": x.get("subject_name"),
                         "lessons": x.get("lessons"), "minutes": x.get("minutes")}
                        for x in done],
            "failed_detail": failed,
            "say": say,
            "effect": "%d/%d courses imported" % (len(done), len(seq)),
            "reason": _why}


@tool("source_import", config.PERM_CONFIRM, "把一套自己的题导进来（考研 / 考编 / 任何考试）")
def t_source_import(source=None, items=None, subject=None, subject_name=None,
                    name=None, kind=None, judge=None, why=None, replace=True, **_):
    """题源导入 —— 这是「换一门考试也能用」的那道门。

    为什么要有它：四个自带题源全绑在专升本那几份文件上，代码里没有
    「再进来一套题」的位置，于是整个产品只能是一门考试的机器。
    给它一份 {题干, 选项, 答案, 解析, 考点} 的清单，它就变成第 N 个题源，
    判分走同一套四档（exact / ai_exact / ai_semantic / manual），
    错因也回流到同一张 error_tags。科目名随便写，不用在代码里登记。

    不校验题目好坏 —— 判分那一步会自己暴露好坏（exact 判不出会退回 ai_exact，
    模型判不了会如实说判不了）。这里只做三件事：认字段、查重、落盘。
    """
    import io as _io
    import os as _os
    if not source:
        return {"error": "没给题源 id（英文短名，比如 ky-math-2023）"}
    if not items:
        return {"error": "没给题目：items 是一串 {no, stem, opts, ans, explain, topic}"}
    if not subject:
        return {"error": "没说是哪个科目（比如 kaoyan-math / kaobian-zonghe）"}
    clean, dropped = [], []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            dropped.append({"index": i, "why": "不是对象"})
            continue
        stem = (it.get("stem") or "").strip()
        if not stem:
            dropped.append({"index": i, "why": "没题干"})
            continue
        row = {"no": it.get("no") if it.get("no") is not None else (i + 1),
               "stem": stem,
               "opts": it.get("opts") or {},
               "ans": it.get("ans"),
               "explain": it.get("explain"),
               "topic": it.get("topic"),
               "part": it.get("part")}
        if it.get("full"):
            row["full"] = it.get("full")
        clean.append(row)
    if not clean:
        return {"error": "一条能收的都没有", "dropped": dropped[:10]}
    # 没有答案的题：照样收，但判分档会被压成 manual —— 不许拿「空答案」当标准答案判对错
    noans = len([x for x in clean if x.get("ans") in (None, "")])
    band = judge or ("choice" if kind == "choice" or
                     any(x.get("opts") for x in clean[:5]) else "blank")
    if noans == len(clean):
        band = config.JUDGE_MANUAL
    path = config.IMPORTED_SOURCES
    try:
        _os.makedirs(_os.path.dirname(path), exist_ok=True)
    except Exception:
        pass
    data = {"sources": []}
    try:
        with _io.open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        pass
    srcs = [s for s in (data.get("sources") or []) if s.get("id") != source]
    srcs.append({"id": source, "subject": subject,
                 # 中文科目名单独存一个字段：前端不再拿 id 去猜「这是英语还是高数」
                 "subject_name": subject_name or subject,
                 "name": name or source, "kind": kind or "choice",
                 "judge": judge or (config.JUDGE_EXACT if band == "choice" else
                                    (config.JUDGE_AI_EXACT if band == "blank" else
                                     config.JUDGE_AI_SEMANTIC)),
                 "why": why or "用户导入",
                 "imported_at": store.now(), "items": clean})
    if not replace:
        old = data.get("sources") or []
        keep = [s for s in old if s.get("id") == source]
        if keep:
            merged = {str(x.get("no")): x for x in (keep[0].get("items") or [])}
            for x in clean:
                merged[str(x.get("no"))] = x
            srcs[-1]["items"] = list(merged.values())
    with _io.open(path, "w", encoding="utf-8") as f:
        json.dump({"sources": srcs}, f, ensure_ascii=False, indent=1)
    store.add_event("source_import", payload="%s %d" % (source, len(clean)))
    total = len(srcs[-1]["items"])
    say = ("题导进来了：%s · %d 条收下、%d 条看不出题干被丢。科目 %s，判分档 %s。"
           % (name or source, len(clean), len(dropped),
              subject_name or subject, srcs[-1]["judge"]))
    if total != len(clean):
        say += " 这套题现在一共 %d 条。" % total
    if noans:
        say += " 其中 %d 条没有标准答案，只能人工判。" % noans
    return {"ok": True, "source": source, "subject": subject,
            "kept": total, "dropped": len(dropped),
            "dropped_sample": dropped[:5], "no_answer": noans,
            "judge": srcs[-1]["judge"],
            "say": say, "effect": "%s: +%d items" % (source, len(clean)),
            "note": ("其中 %d 条没有标准答案，这一档只能人工看" % noans) if noans else "",
            "sources": datahub.item_sources()}


@tool("source_drop", config.PERM_CONFIRM, "删掉一套自己导进来的题")
def t_source_drop(source=None, **_):
    import io as _io
    if not source:
        return {"error": "没给题源 id"}
    path = config.IMPORTED_SOURCES
    try:
        with _io.open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"error": "还没有导入过任何题源"}
    before = len(data.get("sources") or [])
    data["sources"] = [s for s in (data.get("sources") or []) if s.get("id") != source]
    after = len(data["sources"])
    if before == after:
        return {"error": "没有这个题源：%s" % source}
    with _io.open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    say = "删掉了题源 %s，还剩 %d 套。这套题的作答记录没删（在 answers 表里）。" % (source, after)
    return {"ok": True, "removed": source, "left": after,
            "say": say, "effect": "source %s removed" % source}


# ============================================================ AI 出题（按考点卡）
# 「AI 出题」不是让模型凭空编：每道题必须挂在一条**真实依据**上（考点卡的 Q/A，
# 或者真题里的题干），生成完再让它盲答一遍 —— 跟它自己给的答案对不上的当场丢掉。
# 这样入库的题才是「有出处 + 自洽」，而不是一段看起来像题的文字。
# 生成的题单独放 data/gen_questions.json，跟真题分表；界面上按 origin=ai 标出来。
_GEN_KEEP = 200          # 一个科目最多留多少道生成题，超了从头丢（旧的先走）


def _json_arr_of(text):
    """从模型回复里抠出 JSON 数组；抠不出来就返回 None。"""
    s = re.sub(r"```(?:json)?", "", str(text or "")).strip()
    i, j = s.find("["), s.rfind("]")
    if i < 0 or j <= i:
        return None
    try:
        arr = json.loads(s[i:j + 1])
    except Exception:
        return None
    return arr if isinstance(arr, list) else None


def _json_obj_of(text):
    s = re.sub(r"```(?:json)?", "", str(text or "")).strip()
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        obj = json.loads(s[i:j + 1])
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


@tool("quiz_gen", config.PERM_NET,
      "AI 按考点卡出题：生成→盲答复核→进题源（每道带依据，可判分）")
def t_quiz_gen(subject=None, topic=None, n=5, lesson_id=None, **_):
    """这门课没有题就出不了题 —— 先是「依据」不够，不是模型不会写。

    依据从哪来（按优先级，都取真数据）：
      ① 考点卡：计算机 98+505 条、政治 613 条 Q/A；
      ② 真题/题库题干：英语、高数这类没有考点卡的科目，用本机已有的题当范本。
    两步真实：生成 → 盲答复核。复核不一致的直接丢，并在回执里报数。

    lesson_id：课堂里「这一讲练几题」走这条。讲次自己带着「对上了哪几个考点」
    （datahub.lesson_content 的 covers），不该让前端去猜 topic —— 猜错就出成别讲的题。
    """
    if lesson_id:
        c = datahub.lesson_content(lesson_id) or {}
        cov = c.get("covers") or []
        if not topic and cov:
            topic = cov[0].get("name")
        if not subject:
            subject = c.get("subject")
    les_title = None
    if lesson_id:
        # 讲次标题要留下来：题存进「AI 生成 · 某科」那个题源后，
        # 没有它就无法再回答「这几道是哪一讲出的」——切回这一讲就找不回来了。
        try:
            _sub, _les = datahub.find_lesson(datahub.proto(), lesson_id)
            les_title = (_les or {}).get("title")
        except Exception:
            les_title = None
    sub = datahub.subject_flex(datahub.proto(), subject or "")
    sid = (sub or {}).get("id") or datahub.canonical_subject_id(subject or "")
    sname = (sub or {}).get("name") or datahub.canonical_subject_name(sid) or (subject or "")
    if not sid:
        return {"ok": False, "error": "没说清是哪门课：" + str(subject or "（空）"),
                "say": "出题要先知道是哪门课（高等数学 / 政治 / 计算机 / 英语 / C 语言）。"}
    try:
        want = max(1, min(int(n or 5), 12))
    except (TypeError, ValueError):
        want = 5

    # ① 依据：考点卡优先
    anchors, why_src = [], ""
    for c in datahub.point_cards():
        if c.get("subject") != sid:
            continue
        for it in (c.get("items") or []):
            q = str(it.get("q") or "").strip()
            a = str(it.get("a") or "").strip()
            if q and a and (not topic or topic in q or topic in str(c.get("name") or "")):
                anchors.append({"card": c.get("name") or c.get("id"), "q": q, "a": a})
    if anchors:
        why_src = "考点卡"
    else:
        # ② 没考点卡：拿本机真题/题库的题干当范本（只当风格与范围参考）
        srcs = datahub.item_sources(sid)
        for s in srcs[:2]:
            # limit= 不是 n= ：source_questions 的第三个形参叫 limit。
            # 写成 n=8 的时候，凡是**没有考点卡**的科目（英语 / 高数）一走到这条
            # 兜底路径就当场 TypeError —— 政治有考点卡，所以一直没暴露。
            got = datahub.source_questions(s["id"], limit=8)
            for q in (got.get("questions") or []):
                if q.get("stem"):
                    anchors.append({"card": s.get("name") or s["id"], "q": q["stem"], "a": ""})
        if anchors:
            why_src = "本机真题/题库题干"
    if not anchors:
        return {"ok": False, "error": "这门课没有可作依据的材料",
                "say": ("「%s」这本机上既没有考点卡、也没有题 —— 没依据我不硬编。"
                        "先拉课程或题源，或者直接说「按考纲出题」，我按考纲来但会标「无本机依据」。"
                        % (sname or sid))}

    import random
    random.shuffle(anchors)
    use = anchors[:max(want * 2, want + 2)]
    mat = "\n".join("%d | %s | %s" % (i + 1, a["q"][:120], (a["a"] or "（无标准答案，仅供范围参考）")[:80])
                    for i, a in enumerate(use))
    sys_p = ("你是专升本命题人。只能依据给定材料出题，不许引入材料之外的知识点，"
             "也不许出「以上都对」这种废选项。")
    user_p = (
        "科目：%s\n材料（编号 | 题干 | 答案）：\n%s\n\n"
        "请出 %d 道四选一单选题。要求：\n"
        "1) 每题四个选项 A-D，只有一个正确答案；3 个干扰项要像真的（同层级、同词性）；\n"
        "2) 题干自足，不要写「根据材料1」；\n"
        "3) explain 说清为什么选它、另外三个错在哪（40 字以上）；\n"
        "4) ref 填你依据的材料编号（整数）。\n"
        "只输出 JSON 数组，不要任何解释文字：\n"
        '[{"stem":"","opts":{"A":"","B":"","C":"","D":""},"ans":"A","explain":"","ref":1}]'
        % (sname, mat, want))
    tick("让模型出题（依据 %d 条%s）" % (len(use), why_src), n=1, total=3)

    def _ask(sys_p, user_p, **kw):
        """当前这家说不了话就换一家能说话的，并如实回报用了谁。

        默认那家是「自己的 Key」，没填过就一直 ENABLE_LLM=false；
        这时候不该回「出不了题」，该换台子上真能说话的那家（WorkBuddy / Trae）。
        """
        r = model_router.chat(sys_p, user_p, **kw)
        if r.get("ok"):
            return r
        for p in (model_router.state().get("providers") or []):
            if p.get("usable") and p.get("provider") != model_router.current():
                r2 = model_router.chat(sys_p, user_p, provider=p["provider"], **kw)
                if r2.get("ok"):
                    return r2
        return r

    r = _ask(sys_p, user_p, temperature=0.5, max_tokens=2400, timeout=120)
    if not r.get("ok"):
        return {"ok": False, "error": r.get("reason") or "模型没回话",
                "provider": r.get("provider"), "model": r.get("model"),
                "say": "出不了题：模型没回话（%s）" % (r.get("reason") or "没给原因")}
    arr = _json_arr_of(r.get("text"))
    if not arr:
        return {"ok": False, "error": "模型回的不是 JSON", "raw": (r.get("text") or "")[:300],
                "say": "出不了题：模型回的东西不是题（不是 JSON 数组），没入库。"}

    # 结构校验：缺胳膊少腿的直接丢，不修不猜
    good, bad = [], []
    for x in arr:
        if not isinstance(x, dict):
            bad.append("不是对象")
            continue
        stem = str(x.get("stem") or "").strip()
        opts = x.get("opts") if isinstance(x.get("opts"), dict) else {}
        opts = {str(k).strip().upper()[:1]: str(v).strip() for k, v in opts.items()
                if str(v).strip()}
        ans = str(x.get("ans") or "").strip().upper()[:1]
        exp = str(x.get("explain") or "").strip()
        try:
            ref = int(x.get("ref") or 0)
        except (TypeError, ValueError):
            ref = 0
        if len(stem) < 8:
            bad.append("题干太短")
        elif len(opts) < 4 or not all(k in opts for k in ("A", "B", "C", "D")):
            bad.append("选项不足四个")
        elif ans not in opts:
            bad.append("答案不在选项里")
        elif len(exp) < 12:
            bad.append("没解析")
        elif not (1 <= ref <= len(use)):
            bad.append("依据编号对不上材料")
        else:
            good.append({"stem": stem, "opts": opts, "ans": ans, "explain": exp,
                         "ref": ref, "anchor": use[ref - 1]})
    if not good:
        return {"ok": False, "dropped": bad[:6], "count": len(arr),
                "say": "模型给了 %d 道，但一道都过不了结构校验（%s），没入库。"
                       % (len(arr), "、".join(sorted(set(bad))[:3]))}

    # 盲答复核：不给答案，让它当考生再做一遍
    blind = "\n\n".join(
        "第 %d 题：%s\nA. %s\nB. %s\nC. %s\nD. %s" % (
            i + 1, q["stem"], q["opts"]["A"], q["opts"]["B"], q["opts"]["C"], q["opts"]["D"])
        for i, q in enumerate(good))
    tick("盲答复核（%d 道）" % len(good), n=2, total=3)
    r2 = _ask(
        "你是考生。只做题，不解释。",
        blind + "\n\n只输出 JSON：{\"answers\":{\"1\":\"A\",\"2\":\"C\"}}",
        temperature=0, max_tokens=400, timeout=90)
    check = {}
    if r2.get("ok"):
        obj = _json_obj_of(r2.get("text")) or {}
        for k, v in (obj.get("answers") or {}).items():
            try:
                check[int(k)] = str(v).strip().upper()[:1]
            except (TypeError, ValueError):
                continue
    kept, mismatch = [], []
    for i, q in enumerate(good):
        got = check.get(i + 1)
        if got and got != q["ans"]:
            mismatch.append({"no": i + 1, "mine": q["ans"], "again": got,
                             "stem": q["stem"][:40]})
            continue
        kept.append(q)
    if not kept:
        return {"ok": False, "mismatch": mismatch[:6], "generated": len(arr),
                "say": ("生成了 %d 道，但盲答复核全对不上（自己两次答案不一致），"
                        "一道都没入库 —— 这种题入库只会误导。" % len(arr))}

    tick("写进题源", n=3, total=3)
    src_id = "ai-gen-%s" % sid
    data = datahub.gen_questions()
    srcs = [s for s in (data.get("sources") or []) if s.get("id") != src_id]
    old = next((s for s in (data.get("sources") or []) if s.get("id") == src_id), None)
    old_items = list((old or {}).get("items") or [])
    start = max([int(x.get("no") or 0) for x in old_items] or [0])
    new_items = []
    for i, q in enumerate(kept):
        a = q["anchor"]
        new_items.append({
            "no": start + i + 1, "stem": q["stem"], "opts": q["opts"], "ans": q["ans"],
            "explain": q["explain"], "part": topic or "按考点生成",
            "topic": "%s · %s" % (a.get("card") or "", (a.get("q") or "")[:30]),
            "ref_point": q["ref"], "check": "blind-ok" if r2.get("ok") else "unchecked",
            # 挂在哪个讲次下：当堂测的题要跟着这一讲，切回来还得在。
            "lesson_id": str(lesson_id) if lesson_id else None,
            "lesson_title": les_title,
        })
    # 老的在前、新的在后：题号只增不复用。
    # 以前是「新的插到最前面再统一重编号」——重编号之后，answers 里
    # 「第 3 题做错了」这条记录就指向了**另一道题**（换到 3 号位的新题），
    # 于是刚出的题会凭空显示「做过了」。题号是作答记录的主键，不能洗牌。
    all_items = old_items + new_items
    seen, uniq = set(), []
    for it in all_items:
        k = re.sub(r"\s+", "", str(it.get("stem") or ""))[:60]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(it)
    if len(uniq) > _GEN_KEEP:
        uniq = uniq[-_GEN_KEEP:]      # 超限就丢最老的，保留最新的
    # 刚出的题就是编号大于 start 的那几道（不带答案回给界面：当堂测要就地做，
    # 答案留在库里，判分走 grade_answer —— 跟练习页同一条链路，不另开一套。）
    fresh = [{"no": it["no"], "stem": it["stem"], "opts": it["opts"],
              "part": it.get("part"), "topic": it.get("topic")}
             for it in uniq if int(it.get("no") or 0) > start]
    srcs.append({"id": src_id, "subject": sid, "subject_name": sname,
                 "name": "AI 生成 · %s" % sname, "kind": "choice",
                 "judge": config.JUDGE_EXACT, "origin": "ai",
                 "why": "AI 按%s生成，盲答复核过（%s）" % (
                     why_src, r.get("model") or r.get("provider") or "模型"),
                 "gen_at": store.now(), "items": uniq})
    datahub.save_gen_questions({"sources": srcs})
    miss = len(good) - len(kept)
    return {"ok": True, "source": src_id, "generated": len(arr), "kept": len(kept),
            "dropped": len(bad), "mismatch": len(mismatch), "mismatch_sample": mismatch[:3],
            "in_source": len(uniq), "subject": sid, "subject_name": sname,
            "lesson_id": str(lesson_id) if lesson_id else None,
            "lesson_title": les_title,
            "anchor_from": why_src, "model": r.get("model") or r.get("provider"),
            "questions": fresh,
            "say": ("出了 %d 道（依据：%s），复核后入库 %d 道%s。已进题源「AI 生成 · %s」，"
                    "练习页能直接刷，判分按精确判。"
                    % (len(good), why_src, len(kept),
                       "，丢了 %d 道（自己两次答案不一致）" % miss if miss else "",
                       sname)),
            "effect": "+%d ai questions -> %s" % (len(kept), src_id),
            "note": "生成题跟真题分表存放（data/gen_questions.json），判分档 exact；"
                    "题目里的 topic 写着依据哪条考点。"}


@tool("lesson_quiz", config.PERM_LOCAL,
      "这一讲之前出过哪些题（AI 当堂测），带做过/对错，切回这一讲能接着做")
def t_lesson_quiz(lesson_id=None, **_):
    """当堂测的题必须跟讲次有对应关系 —— 出完就混进「AI 生成 · 某科」，
    切回这一讲就找不回来，等于每次都是新的。这里按 item 上的 lesson_id 把它们捞回来。"""
    if not lesson_id:
        return {"error": "没给讲次 id",
                "say": "要先知道是哪一讲，才能说这一讲出过什么题。"}
    lid = str(lesson_id)
    data = datahub.gen_questions()
    hits, src_id = [], None
    for s in (data.get("sources") or []):
        for it in (s.get("items") or []):
            if str(it.get("lesson_id") or "") == lid:
                src_id = s.get("id")
                hits.append(it)
    done = store.answered_by_source(src_id) if src_id else {}
    qs = []
    for it in hits:
        try:
            no = int(it.get("no") or 0)
        except (TypeError, ValueError):
            continue
        qs.append({"no": no, "stem": it.get("stem"), "opts": it.get("opts") or {},
                   "part": it.get("part"), "topic": it.get("topic"),
                   "done": no in done, "last_ok": done.get(no),
                   "lesson_title": it.get("lesson_title")})
    qs.sort(key=lambda x: x["no"])
    n = len(qs)
    dn = len([1 for q in qs if q["done"]])
    rt = len([1 for q in qs if q.get("last_ok") == 1])
    if n:
        say = ("这一讲已经出过 %d 道：做完 %d 道，其中对 %d 道。没做完的接着做，不够可以再出。"
               % (n, dn, rt))
    else:
        say = "这一讲还没出过题 —— 点「这一讲练 5 题」就出，出了就挂在这一讲名下，下次回来还在。"
    return {"lesson_id": lid, "lesson_title": (qs[0].get("lesson_title") if qs else None),
            "source": src_id, "total": n, "done": dn, "right": rt, "questions": qs,
            "say": say, "effect_kind": "noop",
            "effect": "lesson_quiz %s: %d questions" % (lid, n)}


@tool("weak_points", config.PERM_LOCAL,
      "我哪几块错得最多：按真作答聚合，给练习页「按我的弱项出题」用")
def t_weak_points(subject=None, limit=8, **_):
    """弱项不是猜的，是答案表里数出来的。

    两段分开报，不许混成一锅：
      ① parts —— 按「题源 + 分组」聚合真实作答，算错误率与错误数（样本 <2 的不进榜）
      ② tags  —— 错因标签分布（用户自己点的那种），它说明「为什么错」，不是「哪块弱」
    没有作答记录就返回空并说清楚，不拿考点卡的条数假装成薄弱程度。
    """
    sub = None
    if subject:
        s = datahub.subject_flex(datahub.proto(), subject)
        sub = (s or {}).get("id") or datahub.canonical_subject_id(subject)
    parts = store.weak_parts(sub, limit=limit)
    tags = store.tag_stats()
    top = parts[0] if parts else None
    return {"subject": sub, "parts": parts, "count": len(parts),
            "tags": (tags.get("tags") or [])[:6],
            "top": top,
            "empty": not parts,
            "say": ("错得最多的是「%s」：%d 题错 %d（正确率 %s%%）。"
                    % (top["label"], top["total"], top["wrong"], top["accuracy"])
                    if top else
                    "还没有足够的作答记录（同一块至少答过 2 题才算数），"
                    "先随便刷几道，这里才有得算。"),
            "note": "错误率按 answers 表真作答算，样本少于 2 题的分组不进榜。"}


@tool("paper_make", config.PERM_NET,
      "AI 组一套卷：优先抽真题，AI 题补覆盖不到的考点（可交卷判分）")
def t_paper_make(subject=None, n=20, name=None, **_):
    """组卷 ≠ 出一道题重复 N 次。

    组成 = 真题池（自带 15 套 + 网上拉回来的，按科目筛，只取能判分的题）
         + AI 题池（data/gen_questions.json 里这个科目的）

    四条规矩：
      ① **优先真题**：真题是真考过的，AI 题只补位；卷头如实报比例（真题 0 题也照报）。
      ② 每道题带 origin（real / ai），交卷前就知道这卷子里哪些是自己出的。
      ③ AI 题不够就地补一批（复用 quiz_gen 同一条生成→盲答复核链路）；
         补不齐就把卷子做小并在回执里说清楚，**不硬凑、不重复同一道**。
      ④ 落 data/papers_extra.json，origin=ai-paper，能走同一套交卷判分
         （分数按 raw/max_raw 归一化到 100，跟真题卷一个规则）。
    """
    sub = datahub.subject_flex(datahub.proto(), subject or "")
    sid = (sub or {}).get("id") or datahub.canonical_subject_id(subject or "")
    sname = (sub or {}).get("name") or datahub.canonical_subject_name(sid) or (subject or "")
    if not sid:
        return {"ok": False, "error": "没说清是哪门课：" + str(subject or "（空）"),
                "say": "组卷要先知道是哪门课（高等数学 / 政治 / 计算机 / 英语 / C 语言）。"}
    try:
        want = max(5, min(int(n or 20), 60))
    except (TypeError, ValueError):
        want = 20

    import random
    # ---- ① 真题池：只收能判分的题型，且必须有答案
    real = []
    for p in (datahub.exam_papers().get("papers") or []):
        if p.get("subject") != sid or p.get("origin") == "ai-paper":
            continue
        for g in (p.get("groups") or []):
            rule = config.EXAM_TYPE_RULES.get(g.get("type")) or {}
            if not rule.get("judgeable"):
                continue
            for q in (g.get("questions") or []):
                if not q.get("ans") or not (q.get("opts") or {}):
                    continue
                real.append({"type": g.get("type"), "stem": q.get("stem"),
                             "opts": q["opts"], "ans": q["ans"],
                             "from": p.get("name") or p.get("id"),
                             "year": p.get("year") or ""})
    random.shuffle(real)
    real = real[:max(int(want * 0.7), 1)] if real else []

    # ---- ② AI 池：已有就先用；不够就地补（补的是同一个题库，不另开一份）
    def _ai_pool():
        out = []
        for s in (datahub.gen_questions().get("sources") or []):
            if s.get("subject") != sid:
                continue
            for it in (s.get("items") or []):
                if it.get("ans") and it.get("opts"):
                    out.append({"type": "single", "stem": it.get("stem"),
                                "opts": it.get("opts"), "ans": it.get("ans"),
                                "topic": it.get("topic") or s.get("name"),
                                "from": s.get("name") or "AI 生成"})
        return out

    ai = _ai_pool()
    need = want - len(real)
    if len(ai) < need:
        tick("AI 题不够，先补一批（要 %d 道）" % (need - len(ai)), n=1, total=3)
        t_quiz_gen(subject=sid, n=min(12, max(need - len(ai), 3)))
        ai = _ai_pool()
    ai = ai[:max(need, 0)]

    picked = real + ai
    if len(picked) < 5:
        return {"ok": False, "real": len(real), "ai": len(ai),
                "say": ("只凑到 %d 题，做不成一套卷。这门课现在真题池 %d 道、AI 题池 %d 道，"
                        "先去练习页出一批题再来组卷。" % (len(picked), len(real), len(ai)))}

    # ---- ③ 按题型归组：真题的题型决定每题分值，AI 题一律单选
    groups, seen = {}, set()
    for i, q in enumerate(picked):
        key = re.sub(r"\s+", "", str(q.get("stem") or ""))[:60]
        if key in seen:
            continue
        seen.add(key)
        groups.setdefault(q["type"], []).append(q)
    out_groups = []
    for t, qs in groups.items():
        label = (config.EXAM_TYPE_RULES.get(t) or {}).get("label") or t
        # 规则表里 single 写的是「词汇与语法单选」——那是英语的说法。
        # 政治/计算机的组卷里挂这个标题，人会以为拿错了卷。
        if t == "single" and sid != "english":
            label = "四选一"
        out_groups.append({
            "type": t, "label": "%s（组卷）" % label, "material": None,
            "questions": [{"orig": q.get("from"), "stem": q["stem"], "opts": q["opts"],
                           "no": k + 1, "ans": q["ans"],
                           "origin": "ai" if q["type"] == "single" and q not in real else "real"}
                          for k, q in enumerate(qs)],
        })
    total = sum(len(g["questions"]) for g in out_groups)
    stamp = dt.datetime.now().strftime("%m%d-%H%M")
    pid = "paper:ai-%s-%s" % (sid, stamp)
    nm = str(name or "").strip() or ("AI 组卷 · %s · %d 题" % (sname, total))
    paper = {"id": pid, "name": nm, "region": "AI 组卷", "year": str(dt.date.today().year),
             "subject": sid, "pdf": None, "total": total, "answered": 0,
             "origin": "ai-paper", "answers": True,
             "pulled_at": store.now(),
             "mix": {"real": len(real), "ai": len(ai)},
             "groups": out_groups}
    tick("写进真题卷列表", n=2, total=3)
    ex = datahub.papers_extra()
    papers = [p for p in (ex.get("papers") or []) if p.get("id") != pid]
    papers.append(paper)
    datahub.save_papers_extra({"papers": papers})
    tick("核对题量", n=3, total=3)
    real_n = sum(1 for g in out_groups for q in g["questions"] if q.get("origin") == "real")
    ai_n = total - real_n
    return {"ok": True, "paper_id": pid, "name": nm, "subject": sid, "subject_name": sname,
            "total": total, "real": real_n, "ai": ai_n,
            "say": ("组好了：《%s》，共 %d 题 —— 真题 %d 道、AI 补 %d 道%s。"
                    "在「考场」里能直接开考，交卷按 raw/max_raw 归一化到 100 分。"
                    % (nm, total, real_n, ai_n,
                       "" if real_n else "（这门课本机还没有真题卷，整卷都是 AI 出的，"
                                        "卷头已标 origin=ai）")),
            "effect": "+1 ai paper / %d questions -> %s" % (total, pid),
            "note": "卷子落在 data/papers_extra.json，origin=ai-paper；"
                    "每道题都带 origin，真题与 AI 题分得开。"}


@tool("ai_probe", config.PERM_NET, "现场问一句：这家现在到底能不能真回话（不是看配置猜）")
def t_ai_probe(provider=None, **_):
    """「试一句」：真发一次请求，把三个数摆出来 —— 回了什么、等了多久、报错原文。

    为什么要有这个：configured=true 只说明「凭据文件读得到」，不说明「能说话」。
    WorkBuddy 5.6 把 token 就地加密那次，配置一切正常、界面全绿，一调就炸。
    与其让人猜，不如让界面当场打一发：回了话就亮绿，报错就把原始 reason 原样贴出来。
    失败也照实说失败 —— 这是唯一一种「自证可用」的方式。
    """
    import time as _t
    _mr = model_router          # 顶层已经 import 过：这里是包内模块，写成 import model_router 会找不到
    want = provider or _mr.current()
    ok, why = _mr.available(want)
    if not ok:
        return {"ok": False, "provider": want, "usable": False,
                "reason": why, "elapsed_ms": 0,
                "note": "还没登录/没开关，这一枪没打出去。原因照原话给你，不包装。"}
    t0 = _t.time()
    # 注意参数顺序：chat(system, user, provider=...)，不是 chat(provider, system, user)
    r = _mr.chat("只回三个字，不要标点。", "用中文回答：可用",
                 provider=want, max_tokens=40, timeout=45)
    ms = int((_t.time() - t0) * 1000)
    body = (r.get("text") or "").strip()
    return {
        "ok": bool(r.get("ok")),
        "provider": want,
        "provider_name": _mr.NAMES.get(want, want),
        "model": r.get("model") or _mr.model_of(want),
        "usable": bool(r.get("ok")) and bool(body),
        "elapsed_ms": ms,
        "said": body[:60],
        "reason": "" if (r.get("ok") and body) else (r.get("reason") or "回了 200 但正文是空的"),
        "note": "" if (r.get("ok") and body) else
                "这一枪没打通。上面那行是原始报错，界面不做美化 —— 美化过的错误最难查。",
    }


@tool("ai_login", config.PERM_NET, "把平台导出的登录态贴进来（不用装那个平台）")
def t_ai_login(provider=None, credential=None, **_):
    """「不用装平台也能登录」的入口。

    给它整份 JSON（平台上导出的那份凭据文件，全选复制），或 Trae 的
    iCubeAuthInfo 那一长串。认出来就存进 data/ai_cred/，以后自己续期。
    认不出来会把为什么认不出来说清楚，不猜、不半存。
    """
    if not provider:
        return {"ok": False, "error": "先说清是哪一家（workbuddy / trae）"}
    r = platform_ai.import_cred(provider, credential)
    if r.get("ok"):
        store.add_event("ai_login", payload="%s 登录态存进来了" % provider)
        r["state"] = model_router.state()
        r["say"] = "%s 的登录态认出来了，存进 data/ai_cred/%s.json，以后自己续期。" % (
            provider, provider)
        r["effect"] = "cred %s imported" % provider
    return r


@tool("ai_refresh", config.PERM_NET, "把这一家的登录态续期（token 快过期时用）")
def t_ai_refresh(provider=None, **_):
    """换一个新 token。换不到就说实话，不拿旧 token 冒充新的。

    apikey 那家没有这一说（Key 不会自己过期），会直接告诉你不用续。
    """
    provider = (provider or model_router.current()).strip().lower()
    if provider == "apikey":
        return {"ok": True, "provider": "apikey",
                "note": "这一家用的是 Key，不会过期，不用续。"}
    r = platform_ai.refresh(provider)
    r["provider"] = provider
    if r.get("ok"):
        r["state"] = model_router.state()
    return r


@tool("ai_forget", config.PERM_CONFIRM, "删掉这一家存在本机的登录态")
def t_ai_forget(provider=None, **_):
    """退出登录。只删研学台自己存的 data/ai_cred/<provider>.json，
    不动平台客户端的任何文件 —— 那是别人的地盘。
    """
    provider = (provider or "").strip().lower()
    if provider not in ("workbuddy", "trae"):
        return {"ok": False, "error": "只能删 workbuddy / trae 存在本机的登录态"}
    platform_ai.forget_cred(provider)
    say = ("%s 存在本机的登录态删掉了（data/ai_cred/%s.json）。"
           "平台上原来那份没动；要用得重新登。" % (provider, provider))
    return {"ok": True, "provider": provider, "state": model_router.state(),
            "say": say, "effect": "cred %s removed" % provider,
            "note": "删掉了。平台上原来那份登录态没动。"}


@tool("ai_apikey_set", config.PERM_CONFIRM,
      "填自己的模型 API（base_url / 模型名 / Key / 窗宽）—— 存进 server/config.local.json 并当场生效")
def t_ai_apikey_set(base_url=None, model=None, api_key=None, ctx=None, **_):
    """「apikey」那家的设置入口。

    以前只认 config.local.json 手写，界面上没有入口 —— 没配过的人看到的是一行
    「没配」，却没有地方填。这里补上：写文件、热更新内存里的 config、回显打码的 Key。

    只存不改选：填完不自动切过去。自动切会把正在用的一家换掉，
    万一这个 Key 是错的，整台机器当场不会说话 —— 要用请自己点「用这个」。
    """
    base = str(base_url or "").strip().rstrip("/")
    mod = str(model or "").strip()
    key = str(api_key or "").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if base and not base.lower().startswith(("http://", "https://")):
        return {"ok": False, "error": "base_url 要以 http:// 或 https:// 开头"}
    if not base and not mod and not key and ctx in (None, "", 0, "0"):
        return {"ok": False, "error": "四样都没填：base_url / model / api_key / ctx 至少给一样"}
    upd = {}
    if base:
        upd["LLM_BASE_URL"] = base
    if mod:
        upd["LLM_MODEL"] = mod
    if key:
        upd["LLM_API_KEY"] = key
        # 填了 Key 就是把「我要用自己这家」说明白了：ENABLE_LLM 还关着的话，
        # 存完照样显示「开关没开」，人填完还是不生效 —— 那是第二个填不上的坑。
        upd["ENABLE_LLM"] = True
    try:
        path = _cfg_local_write(upd)
    except Exception as e:
        return {"ok": False, "error": "写 config.local.json 失败：%s" % e}
    # 窗宽不是 config 里的键（每家各存一份，键是 kv 的 ai.ctx.<provider>）。
    # 不走 set_current —— 那会把正在用的一家换掉，填个窗宽不该顺带换模型。
    ctx_note = ""
    if ctx not in (None, "", 0, "0"):
        c = model_router.set_ctx("apikey", ctx)
        ctx_note = "，窗宽记成 %d" % c["ctx"] if c.get("ok") else "，窗宽没记上：%s" % c.get("error")
    st = model_router.state()
    there = len(config.LLM_API_KEY or "")
    host = re.sub(r"^https?://", "", config.LLM_BASE_URL or "")
    return {"ok": True, "base_url": config.LLM_BASE_URL, "model": config.LLM_MODEL,
            "key_masked": _mask_key(config.LLM_API_KEY), "key_len": there,
            "file": path, "providers": st.get("providers") or [],
            "say": ("存好了：%s @ %s，Key %s（%d 位），写进 server/config.local.json%s，当前进程已生效。"
                    "要用它说话就在上面点「切换」。"
                    % (config.LLM_MODEL or "模型没填", host or "地址没填",
                       _mask_key(config.LLM_API_KEY), there,
                       "（ENABLE_LLM 也一起打开了）" if "ENABLE_LLM" in upd else "") + ctx_note),
            "effect": "llm config -> %s @ %s" % (config.LLM_MODEL or "-", host or "-")}


@tool("ai_apikey_clear", config.PERM_CONFIRM, "清掉自己填的模型 Key（地址和模型名保留）")
def t_ai_apikey_clear(**_):
    try:
        _cfg_local_write({"LLM_API_KEY": ""})
    except Exception as e:
        return {"ok": False, "error": "写 config.local.json 失败：%s" % e}
    return {"ok": True, "base_url": config.LLM_BASE_URL, "model": config.LLM_MODEL,
            "key_masked": "", "say": "Key 清掉了（地址和模型名还留着）。",
            "effect": "llm key cleared"}


def _mask_key(k):
    """Key 只回显头 3 位和尾 4 位：够认出是哪一把，不把整把写进界面/日志。"""
    s = str(k or "")
    if not s:
        return ""
    if len(s) <= 8:
        return "…"
    return s[:3] + "…" + s[-4:]


def _cfg_local_write(updates):
    """改 server/config.local.json：先读整份再改，别把 BCZ token 那些一起冲掉。"""
    p = os.path.join(config.SERVER_DIR, "config.local.json")
    cur = {}
    if os.path.exists(p):
        try:
            with io.open(p, encoding="utf-8") as f:
                cur = json.load(f)
        except Exception:
            cur = {}
    if not isinstance(cur, dict):
        cur = {}
    cur.update(updates)
    tmp = p + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(cur, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)
    for k, v in updates.items():          # 热更新：不用重启才生效
        if hasattr(config, k):
            setattr(config, k, v)
    return p


@tool("ai_models", config.PERM_NET, "列出这一家现在真能用的模型（要联网问目录）")
def t_ai_models(provider=None, **_):
    """列目录。列不出来就说明为什么，不编模型名。

    WorkBuddy 走 /v3/config（实测 37 个模型），Trae 遍历五个 function 取并集
    （实测 39~46 个）。apikey 那家没有目录接口，只把 config 里配的那个报出来。

    顺手做「名字失效自愈」：目录是刚拉的真名单，上次选的模型名要是不在里面
    （上游改过目录 / 手滑存了个不存在的名字），当场修回默认名 —— 不然那个
    死名字会一直留在 kv 里，每次对话都空着回来，直到人自己想起来换。
    """
    provider = (provider or model_router.current()).strip().lower()
    r = model_router.models(provider)
    r["provider"] = provider
    cur = model_router.model_of(provider)
    ids = [m.get("id") for m in (r.get("models") or [])]
    if ids:
        # 目录存一份：换模型时补窗宽、界面点开详情要知道这个模型多少窗口/什么能力。
        model_router.set_catalog(provider, r.get("models") or [])
        # 当前这个模型的窗宽按刚拉的真目录对齐（之前可能是空的、或者是旧模型留下的）。
        for m in (r.get("models") or []):
            if m.get("id") == cur and isinstance(m.get("ctx"), int) and m["ctx"] > 0:
                model_router.set_ctx(provider, m["ctx"])
                r["ctx"] = m["ctx"]
                break
    r["current"] = cur
    r["stale"] = bool(cur and ids and cur not in ids)
    if r.get("stale"):
        fb = {"trae": config.TRAE_MODEL, "workbuddy": config.WB_MODEL}.get(provider)
        if fb and fb in ids:
            model_router.set_model(provider, fb)
            r["current"] = fb
            r["healed_to"] = fb
            r["stale"] = False
            r["note"] = ("「%s」已经不在这家的目录里，帮你切回「%s」。"
                         % (cur, fb)) + (r.get("note") or "")
    return r


@tool("ai_presets", config.PERM_LOCAL,
      "常见模型厂家的默认地址（接一家只用填 Key，地址从这张表里挑）")
def t_ai_presets(**_):
    """预设表只做一件事：把公开常量替人记住。

    地址以各家官方文档为准，但**不是真理** —— 厂家改域名从来不通知，
    所以界面上地址永远可改，这张表只负责把输入框先填好。
    型号不放进来：型号三个月就变，宁可现场拉 /models，也不给一份会过期的清单。
    """
    from . import presets
    rows = presets.all()
    return {"presets": rows, "count": len(rows),
            "note": "地址是默认值，可改；型号靠下面那个按钮现场拉，这张表里不放型号。"}


def _models_urls(base):
    """一家给一个地址，/models 可能长在三个地方 —— 都试一遍，谁也不猜。"""
    b = base.rstrip("/")
    cands = [b + "/models"]
    if b.endswith("/v1"):
        cands.append(b[:-3] + "/models")
    else:
        cands.append(b + "/v1/models")
    out = []
    for u in cands:
        if u not in out:
            out.append(u)
    return out


@tool("ai_models_probe", config.PERM_NET,
      "用地址 + Key 现场拉这家的模型清单（只读，不保存任何东西）")
def t_ai_models_probe(base_url=None, api_key=None, **_):
    """「这家到底有哪些型号」不能靠记，现场问一次最准。

    不存盘、不改 config —— 拉清单和「决定用哪家」是两件事，
    合成一件事的话，人只是想知道有哪些型号，却已经被切了线路。

    返回的每个型号都带一个 ctx（上下文窗宽），拉不到就空着，
    不拿「大概 128k」这种数去填。
    """
    base = (base_url or config.LLM_BASE_URL or "").strip().rstrip("/")
    key = (api_key or config.LLM_API_KEY or "").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not base:
        return {"ok": False, "error": "地址是空的：先从上面挑一家，或者自己填",
                "models": [], "count": 0}
    if not base.lower().startswith(("http://", "https://")):
        return {"ok": False, "error": "地址要以 http:// 或 https:// 开头",
                "models": [], "count": 0}
    if not key:
        return {"ok": False, "error": "先填 Key 再拉：拉清单也要鉴权",
                "models": [], "count": 0}
    if model_router.requests_missing():
        return {"ok": False, "error": "环境里没有 requests，发不出请求",
                "models": [], "count": 0}

    import json as _json
    import requests as _rq
    tried, last = [], ""
    for url in _models_urls(base):
        tried.append(url)
        try:
            resp = _rq.get(url, headers={"Authorization": "Bearer " + key},
                           timeout=15)
        except Exception as e:
            last = "请求没发出去：%s" % str(e)[:120]
            continue
        if resp.status_code in (401, 403):
            return {"ok": False, "error": "Key 不对或没权限（HTTP %d）" % resp.status_code,
                    "tried": tried, "models": [], "count": 0}
        if resp.status_code == 404:
            last = "这个地址没有 /models（HTTP 404）"
            continue
        if resp.status_code >= 400:
            last = "这家回了 HTTP %d" % resp.status_code
            continue
        try:
            data = resp.json()
        except Exception:
            last = "回的不是 JSON"
            continue
        rows = data if isinstance(data, list) else (
            data.get("data") or data.get("models") or [])
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            mid = r.get("id") or r.get("name") or r.get("model")
            if not mid:
                continue
            ctx = (r.get("context_window") or r.get("context_length")
                   or r.get("max_context_length") or r.get("ctx"))
            out.append({"id": str(mid),
                        "ctx": ctx if isinstance(ctx, int) and ctx > 0 else None})
        if not out:
            last = "这家回了个空清单"
            continue
        out.sort(key=lambda x: x["id"])
        return {"ok": True, "models": out, "count": len(out),
                "base_used": url.rsplit("/models", 1)[0], "tried": tried,
                "say": "拉到 %d 个型号（%s）" % (len(out), url.rsplit("/models", 1)[0])}
    return {"ok": False, "tried": tried,
            "error": "三个地址都没拉到清单：%s。有的厂家不开放 /models，"
                     "那就手填型号（看它文档里写的名字）。" % (last or "原因不明"),
            "models": [], "count": 0}


@tool("explain_stats", config.PERM_LOCAL, "讲题的家底：讲过多少、多少条依据全过、被打回几次")
def t_explain_stats(**_):
    """统计页和答辩都用得上的一句话：我们现在讲得出多少题、讲错率多少。

    这些数都是 explain 表里真有的行数，不是估的。
    """
    return store.explain_stats()


@tool("word_plan", config.PERM_LOCAL, "下一批词该背哪些：按本机记录排出顺序，并给出每个词的依据")
def t_word_plan(key=None, limit=None, **_):
    """背单词的决策层。

    以前的排卡是写死的「按词表顺序走」—— 那不是决策，那是翻页。
    现在顺序由本机记录决定：逾期没复习的先来，然后今天到期、答错过、真题高频，
    最后才是新词；每个词都附一句「凭什么排在这」，界面上能直接看到。

    没有记录可依的词不会凭空加分，它只会因为「词表第 N 个」被选中，
    而这个理由也会如实写出来 —— 不许出现「系统觉得你该背这个」这种话。
    """
    p = datahub.proto()
    if not key:
        r = t_resolve_group()
        key = r.get("key")
    ws = datahub.group_words(key) or []
    if not ws:
        return {"key": key, "count": 0, "order": [],
                "error": "这一组没有词（题源里没数据）"}
    mems = {w["w"]: (store.get_mem(w["w"]) or {}) for w in ws}
    freq = (p.get("vocab") or {}).get("freq_index") or {}
    stars = {r["word"] for r in store.list_star(2000)}
    res = decider.rank(ws, mems=mems, freq_index=freq, stars=stars, limit=limit)
    res["key"] = key
    res["note"] = ("每组词背多少个由你定（默认整组）；这里只排顺序，不替你决定量。"
                   if limit is None else
                   "只取前 %s 个：剩余的词排在后面，不是不背。" % limit)
    return res


@tool("writing_list", config.PERM_LOCAL, "作文题单：真题作文题，含要点与中英对照表")
def t_writing_list(**_):
    papers = writing.list_papers()
    return {"count": len(papers), "papers": papers,
            "dims": config.WRITING_DIMS,
            "max_score": config.WRITING_MAX_SCORE,
            "local_dims": config.WRITING_LOCAL_DIMS,
            "note": ("这台机器上还没有作文题库（writing_bank.json 不在数据目录里）"
                     if not papers else
                     "题目为真卷原题，要点与中英对照表都是原卷自带的。"
                     "local_dims 是本机算得出来的档，其余两档要模型判。")}


@tool("writing_grade", config.PERM_LOCAL, "批改一篇作文：本机先算能数的，模型那两档没接就如实不给")
def t_writing_grade(pid=None, essay=None, use_model=None, save=True, **_):
    """批改。

    分三块写清楚，谁都不许含糊：
      本机算的  词数 / 要点命中 / 格式 —— 数出来的，模型也改不了；
      模型算的  语言 / 文采 —— 模型没接就是「没判」，不给分也不给总分；
      留底      原文 + 两块结果分开存，改模型那块不用重写作文。
    """
    if not pid:
        return {"error": "没给作文题 id"}
    r = writing.grade(pid, essay, use_model=use_model)
    if not r.get("ok"):
        return r
    if save:
        try:
            r["saved_id"] = store.save_writing(
                pid, r.get("kind"), (essay or "").strip(), r.get("local"),
                {"dims": r.get("dims"), "level": r.get("level"),
                 "summary": r.get("summary"), "errors": r.get("errors"),
                 "advice": r.get("advice"), "sample": r.get("sample")}
                if r.get("model") else None,
                r.get("model"), r.get("score"))
        except Exception as e:
            r["saved_id"] = None
            r["save_error"] = str(e)
        store.add_event("writing", payload="pid=%s words=%s hit=%s/%s" % (
            pid, (r.get("local") or {}).get("words"),
            (r.get("local") or {}).get("points_hit"),
            (r.get("local") or {}).get("points_total")))
        _l = r.get("local") or {}
        _bits = ["%s 字" % (_l.get("words") or 0)]
        if _l.get("points_total"):
            _bits.append("要点 %s/%s" % (_l.get("points_hit"), _l.get("points_total")))
        if _l.get("score") is not None:
            _bits.append("%s 分" % _l.get("score"))
        r["say"] = "作文批完了：%s。%s" % (
            "、".join(_bits),
            ("结果已存进作文本（%s）。" % r["saved_id"]) if r.get("saved_id")
            else "这次没存进作文本。")
        r["effect"] = "writing %s graded%s" % (
            pid, " +saved" if r.get("saved_id") else "")
    return r


@tool("writing_mine", config.PERM_LOCAL, "我写过的作文（原文与判分都在，可回看）")
def t_writing_mine(pid=None, limit=20, **_):
    rows = store.list_writings(pid=pid, limit=limit)
    return {"count": len(rows), "items": rows, "stats": store.writing_stats(),
            "note": ("还没写过作文" if not rows else
                     "最新的在前面；score 为空的那一版是模型没接、只算了本机部分")}


@tool("plan_from_sentence", config.PERM_CONFIRM,
      "听一句话：认出要考什么 / 什么时候考 / 每天多久，认齐了就真排一张表")
def t_plan_from_sentence(text=None, **_):
    """这一层不是聊天。它只做三件事，顺序不能变：

      1. 先查自己有没有（说考研就顶回去，不拿专升本的课冒充考研计划）
      2. 认不出来的就问（没日期问日期，没时长问时长，不替他填一个）
      3. 认齐了就写预算 + 重排，把砍掉的每一讲连同「为什么砍」一起交出来

    写盘走 PERM_CONFIRM：改的是他的考试日期，这件事必须先让他点一次。
    """
    if not text or not str(text).strip():
        return {"ok": False, "kind": "empty", "say": "说一句话，例如「2027-03-15 专升本，每天 2 小时」。"}
    r = intent.plan_from_intent(str(text).strip())
    if r.get("ok"):
        store.add_event("plan_from_sentence", payload=r.get("say", "")[:120])
    return r


@tool("intent_parse", config.PERM_LOCAL, "只拆一句话，不写盘：看它认出了什么、每个值从哪读出来的")
def t_intent_parse(text=None, **_):
    """预演：跟 plan_from_sentence 走同一条判断链，只是最后一步不写盘。

    这样「它认出了什么」和「它真排出来什么」永远是同一套话 ——
    不会出现「预演说排不了、真按下去却给你排了」这种自相矛盾。
    """
    if not text or not str(text).strip():
        return {"ok": False, "error": "没给句子"}
    return intent.plan_from_intent(str(text).strip(), apply=False)


@tool("search_all", config.PERM_LOCAL, "搜课程 / 词 / 考点 / 题干（不返回答案）")
def t_search_all(q=None, limit=8, **_):
    if not q or not str(q).strip():
        return {"q": q, "lessons": [], "words": [], "cards": [], "questions": [],
                "total": 0, "hint": "输入关键词：讲次名 / 单词 / 中文释义 / 考点"}
    kw = str(q).strip().lower()
    p = datahub.proto()
    lessons, words, cards, questions = [], [], [], []

    for s in p.get("subjects") or []:
        for l in s.get("lessons") or []:
            if kw in (l.get("title") or "").lower() or kw in (l.get("chapter") or "").lower():
                lessons.append({"subject": s["id"], "subject_name": s["name"],
                                "cls": datahub.CLS.get(s["id"], "cs"),
                                "lesson_id": l.get("id"), "title": l.get("title"),
                                "chapter": l.get("chapter"), "dur": l.get("dur") or 0})
                if len(lessons) >= limit:
                    break
        if len(lessons) >= limit:
            break

    for key, ws in ((p.get("vocab") or {}).get("groups_words") or {}).items():
        for w in ws:
            if kw in str(w.get("w", "")).lower() or kw in str(w.get("cn", "")):
                words.append({"group": key, "w": w.get("w"), "cn": w.get("cn"),
                              "ph": w.get("ph"), "pos": w.get("pos"),
                              "mem": datahub.mem_of(w.get("w"))})
                if len(words) >= limit * 2:
                    break
        if len(words) >= limit * 2:
            break

    for c in p.get("point_cards") or []:
        for s in c.get("sample") or []:
            if kw in str(s.get("q", "")).lower() or kw in str(s.get("a", "")).lower():
                cards.append({"card": c["name"], "subject": c["subject"],
                              "q": s.get("q"), "pos": s.get("pos")})
                if len(cards) >= limit:
                    break
        if len(cards) >= limit:
            break

    for qq in ((p.get("exercise_bank") or {}).get("questions") or []):
        if kw in str(qq.get("stem", "")).lower():
            questions.append({"no": qq.get("no"), "part": qq.get("part"),
                              "stem": qq.get("stem")})
            if len(questions) >= limit:
                break

    store.add_event("search", payload=kw, qno=None)
    _tot = len(lessons) + len(words) + len(cards) + len(questions)
    # 词书不是预置的：搜不到不等于没有。用户要单词/词汇时，顺手让模型去百词斩
    # 现搜现拉（vocab_books → vocab_pull），不拿一份写死的词表顶上。
    _kwbook = ("单词", "词汇", "词表", "词书", "背词", "四级", "六级", "考研词", "英语词")
    out = {"q": q, "lessons": lessons, "words": words, "cards": cards,
           "questions": questions,
           "say": ("「%s」在本机找到 %d 条：讲次 %d / 词 %d / 考点 %d / 题 %d。" % (
               q, _tot, len(lessons), len(words), len(cards), len(questions)))
                  if _tot else ("本机数据里没有「%s」。可以换个词，或者让我联网搜。" % q),
           "effect": "search %d hits" % _tot,
           "total": _tot,
           "note": "结果直接来自本机数据文件；题目只给题干，不给答案"}
    if any(k in str(q) for k in _kwbook):
        out["next"] = ("要成体系的词表就别靠本机这点：先 vocab_books(keyword=\"%s\") 看真词书，"
                       "再 vocab_pull(book_id=…) 把整本拉进来。" % str(q).strip())
    return out


@tool("add_words_to_review", config.PERM_CONFIRM, "把某讲词群加进今天的复习")
def t_add_review(lesson_id=None, **_):
    if not lesson_id:
        return {"error": "没指定讲次"}
    r = datahub.lesson_words(lesson_id)
    if not r.get("is_word_lesson"):
        return {"error": "本讲不是单词课，没有可加的词群"}
    con = store.connect()
    added, touched = 0, 0
    try:
        for w in r["words"]:
            cur = con.execute("SELECT word FROM word_mem WHERE word=?", (w["w"],)).fetchone()
            if cur:
                con.execute("UPDATE word_mem SET due=? WHERE word=?", (store.today(), w["w"]))
                touched += 1
            else:
                con.execute(
                    "INSERT INTO word_mem(word,box,due,seen,right,wrong,last_ts)"
                    " VALUES(?,?,?,?,?,?,?)", (w["w"], 1, store.today(), 0, 0, 0, store.now()))
                added += 1
        con.commit()
    finally:
        con.close()
    store.add_event("queue_review", lesson_id=lesson_id, payload="%d+%d" % (added, touched))
    due = store.mem_stats()["due_today"]
    if added + touched:
        say = ("这一讲的 %d 个词进今天复习了：%d 个新开、%d 个从后面挪到今天。"
               "今天要背的一共 %d 个。" % (added + touched, added, touched, due))
    else:
        say = "这一讲的词一个都没加进去（本讲可能没有词，或者已经在队列里了）。"
    return {"lesson_id": lesson_id, "group": r["key"], "added": added,
            "moved_to_today": touched, "total": added + touched,
            "say": say, "effect": "%d words -> today (due %d)" % (added + touched, due),
            "due_today": due}


# ========================================================== 第 2 期：让错的有处去
@tool("list_wrong_words", config.PERM_LOCAL, "错词本：只列本机答错过的词")
def t_wrong_words(limit=200, **_):
    ws = store.wrong_words(limit)
    p = datahub.proto()
    freq = (p.get("vocab") or {}).get("freq_index") or {}
    idx = {}
    for g in (p.get("wordmap") or {}).get("groups") or []:
        for w in datahub.group_words(g["key"]):
            idx.setdefault(w["w"], g["key"])
    out = []
    for r in ws:
        w = r["word"]
        word = next((x for x in (datahub.group_words(idx[w]) if idx.get(w) else [])
                     if x.get("w") == w), None) if idx.get(w) else None
        out.append({"w": w, "box": r["box"], "due": r["due"],
                    "wrong": r["wrong"], "right": r["right"],
                    "group": idx.get(w), "ph": (word or {}).get("ph"),
                    "pos": (word or {}).get("pos"), "cn": (word or {}).get("cn"),
                    "freq": (freq.get(w) or {}).get("freq")})
    return {"count": len(out), "words": out,
            "note": ("错词本是空的：还没有答错过词" if not out else
                     "按答错次数排序，错得多的先来")}


@tool("review_today", config.PERM_LOCAL, "今天到期要复习的词：几个、都是哪些、档位与上次到期日")
def t_review_today(limit=200, **_):
    """到期复习队列的取数口子。

    研学台自己的调度写在 config.SM2_INTERVALS（对升一档、错打回 box1）；
    「不背单词」只公开了「科学记忆算法」这四个字，公式没公开 —— 所以这里
    不给任何「跟不背单词一样」的说法，只报本机真实的到期数据。"""
    rows = store.review_enriched(limit)
    st = store.mem_stats()
    boxes = {}
    for r in rows:
        boxes[r["box"]] = boxes.get(r["box"], 0) + 1
    # 旧进度导进来的词可能不在行课词表上（没有音标/释义/例句），单独挑出来：
    # 复习它只能是空卡，宁可从队列里剔掉，也不给一张没有答案的卡。
    orphans = [r["w"] for r in rows if r.get("orphan")]
    usable = [r for r in rows if not r.get("orphan")]
    return {"count": len(usable), "due_today": st["due_today"], "words": usable,
            "orphans": orphans, "orphan_count": len(orphans),
            "boxes": boxes, "intervals": list(config.SM2_INTERVALS),
            "note": ("今天没有到期要复习的词 —— 背过新词之后，它们会按上面的间隔天数回来"
                     if not usable else
                     "按到期日升序，档位低的先来；复习里答对升一档、答错打回 box1")
                    + (("；另有 %d 个旧进度里的词不在现在的行课词表上（没有音标释义例句），"
                        "先不摆出来复习" % len(orphans)) if orphans else "")}


@tool("star_word", config.PERM_LOCAL, "把词加进 / 移出生词本（手动标的，跟错词本两回事）")
def t_star_word(word=None, note=None, on=True, **_):
    if not word:
        return {"error": "没给单词"}
    if isinstance(on, str):
        on = on.strip().lower() in ("1", "true", "yes", "on")
    r = store.star_word(word, note, bool(on))
    store.add_event("star_word", word=word, payload=("on" if on else "off"))
    if isinstance(r, dict):
        r["say"] = ("「%s」%s。" % (word, "加进生词本了" if on else "从生词本拿掉了"))
        r["effect"] = "star %s %s" % (word, "on" if on else "off")
    return r


@tool("list_star_words", config.PERM_LOCAL, "生词本：手动标过的词")
def t_list_star(limit=200, **_):
    rows = store.list_star(limit)
    p = datahub.proto()
    gw = (p.get("vocab") or {}).get("groups_words") or {}
    idx = {}
    for key, arr in gw.items():
        for w in arr:
            idx.setdefault(w.get("w"), (key, w))
    freq = (p.get("vocab") or {}).get("freq_index") or {}
    out = []
    for r in rows:
        key, w = idx.get(r["word"], (None, None))
        mem = store.get_mem(r["word"]) or {}
        out.append({"w": r["word"], "ts": r["ts"], "note": r["note"],
                    "ph": (w or {}).get("ph"), "pos": (w or {}).get("pos"),
                    "cn": (w or {}).get("cn"), "group": key,
                    "box": mem.get("box"), "due": mem.get("due"),
                    "freq": (freq.get(r["word"]) or {}).get("freq")})
    return {"count": len(out), "words": out,
            "note": ("生词本是空的：在卡片上点「收藏」才会进来" if not out else
                     "按标的时间倒序")}


@tool("fav_sentence", config.PERM_LOCAL, "收藏 / 取消收藏一条真卷例句")
def t_fav_sent(word=None, text=None, src=None, kind=None, on=True, **_):
    if not word or not text:
        return {"error": "缺单词或缺例句原文"}
    if isinstance(on, str):
        on = on.strip().lower() in ("1", "true", "yes", "on")
    r = store.fav_sentence(word, text, src, kind, bool(on))
    store.add_event("fav_sentence", word=word, payload=("on" if on else "off"))
    if isinstance(r, dict):
        r["say"] = ("「%s」的这句例句%s。" % (word, "收进金句本了" if on else "从金句本拿掉了"))
        r["effect"] = "fav %s %s" % (word, "on" if on else "off")
    return r


@tool("list_fav_sentences", config.PERM_LOCAL, "收藏的例句")
def t_list_fav(limit=100, **_):
    rows = store.list_fav(limit)
    return {"count": len(rows), "sentences": rows,
            "note": ("还没收藏过例句" if not rows else "按收藏时间倒序，全部摘自真卷")}


@tool("checkin_calendar", config.PERM_LOCAL, "打卡日历：哪天真的背过词、背了几个、对了几个")
def t_checkin(days=70, **_):
    """日历只认真实作答事件（events.kind='grade_word'）。

    打开页面、翻卡、看例句都不算 —— 只有真点了「认识/不认识/选项」才记一笔。
    所以哪天没背就是空格，不填连续天数的假象。"""
    try:
        n = int(days)
    except Exception:
        n = 70
    n = max(7, min(n, 400))
    data = store.checkin_days(n)
    st = store.checkin_streak()
    return {"days": data, "streak": st["streak"], "checked_today": st["today"],
            "last": st["last"], "count": len(data),
            "note": ("还没有任何打卡记录：背过一次词这里才会有第一格" if not data else
                     "共 %d 天有背书记录 · 连续 %d 天" % (len(data), st["streak"]))}


@tool("word_goal", config.PERM_LOCAL, "今日词量：目标多少、已过多少")
def t_word_goal(**_):
    done = store.today_word_count()
    # 今日目标有两种来源：自己定过的（kv plan.vocab_goal）优先，没有就用配置默认值。
    # 词书一本都没有的时候，目标不该还是 28 —— 那是给「有词书要背」的场景定的数。
    has_book = bool((datahub.proto().get("vocab") or {}).get("lists"))
    goal = store.kv_get("word.goal")
    try:
        goal = int(goal) if goal not in (None, "") else None
    except (TypeError, ValueError):
        goal = None
    if goal is None:
        goal = config.TODAY_DAILY_WORDS if has_book else 0
    return {"goal": goal, "done": done, "left": max(goal - done, 0),
            "has_book": has_book,
            "recent": store.today_word_events()[:10],
            "note": ("这台机器上还没有词书，今日目标按 0 算 —— 不是把进度条填满，是没东西可背"
                     if not has_book else
                     "两个数字都来自本机作答记录，没背就是 0，不填进度条")}


@tool("save_note", config.PERM_LOCAL, "讲次笔记落库（按讲次存，带时间点）")
def t_save_note(lesson_id=None, text=None, pos_sec=0, **_):
    if not lesson_id:
        return {"error": "没指定讲次"}
    r = store.save_note(lesson_id, text, pos_sec)
    store.add_event("note", lesson_id=lesson_id, seconds=0,
                    payload="len=%d pos=%.0f" % (len(text or ""), float(pos_sec or 0)))
    _c = store.note_count()
    return {"note": r, "count": _c,
            "say": "笔记存下了（%d 字，挂在 %s 的第 %s 秒）。这一讲现在一共 %d 条笔记。" % (
                len(text or ""), lesson_id, ("%.0f" % float(pos_sec or 0)), _c),
            "effect": "+1 note (total %d)" % _c}


@tool("get_note", config.PERM_LOCAL, "取某个讲次的笔记")
def t_get_note(lesson_id=None, **_):
    """取笔记。合并时两边都改过的，落败版本留在 alt_text/alt_ts —— 这里一并交出去，
    不然冲突副本写了库却没人看得见，等于静默覆盖。"""
    if not lesson_id:
        return {"error": "没指定讲次"}
    n = store.get_note(lesson_id)
    if not n:
        return {"note": None, "text": "", "pos_sec": 0,
                "alt_text": "", "alt_ts": "", "has_conflict": False,
                "note_hint": "这一讲还没有笔记"}
    alt_text = n.get("alt_text") or ""
    alt_ts = n.get("alt_ts") or ""
    return {"note": n, "text": n.get("text") or "",
            "pos_sec": n.get("pos_sec") or 0,
            "updated_ts": n.get("updated_ts") or "",
            "alt_text": alt_text, "alt_ts": alt_ts,
            "has_conflict": bool(alt_text),
            "note_hint": ("两边都改过这条笔记：现在留着的是较新的那份，"
                          "另一份在 alt_text 里，要留哪个你说了算"
                          if alt_text else "")}


@tool("tag_error", config.PERM_LOCAL, "给答错的题打错因标签")
def t_tag_error(qno=None, part=None, tag=None, word=None, source=None, **_):
    r = store.add_error_tag(qno=qno, part=part, tag=tag, word=word)
    if r.get("error"):
        return r
    store.add_event("tag_error", part=part, qno=qno,
                    payload="tag=%s;src=%s" % (tag, source or datahub.SRC_GRAMMAR))
    r["stats"] = store.tag_stats()
    if isinstance(r, dict):
        r["say"] = "这道题打上了错因「%s」，下一张今日编排会按错因多的先补。" % tag
        r["effect"] = "tag %s -> %s" % (qno, tag)
    return r


@tool("error_tag_stats", config.PERM_LOCAL, "错因分布（反推该练什么）")
def t_tag_stats(**_):
    s = store.tag_stats()
    s["empty"] = not s["tags"]
    s["note"] = ("还没打过标签：答错一题就能选错因" if s["empty"]
                 else "标签决定下次练什么，不需要手动分类")
    return s


@tool("finish_lesson", config.PERM_LOCAL, "标记本讲看完（只写本机事件库）")
def t_finish_lesson(lesson_id=None, subject=None, pos_sec=0, **_):
    """B5 播完打勾：只写本机库，不动 progress.json（那个要你确认）。"""
    if not lesson_id:
        return {"error": "没指定讲次"}
    p = datahub.proto()
    sub, les = datahub.find_lesson(p, lesson_id)
    rec = store.set_lesson(lesson_id, subject or (sub or {}).get("id"),
                           status="done", pos_sec=pos_sec)
    store.add_event("lesson_finish", subject=(sub or {}).get("id"), lesson_id=lesson_id)
    _n = len(store.lessons_done())
    return {"lesson_id": lesson_id, "title": (les or {}).get("title"),
            "progress": rec, "lessons_done": _n,
            "say": "「%s」标成学完了。本机一共完成 %d 讲；要回写到 progress.json 再点「同步学丞」。" % (
                (les or {}).get("title") or lesson_id, _n),
            "effect": "done %d lessons total" % _n,
            "note": "已写进本机事件库；要同步到 progress.json 需再点一次确认"}


@tool("recent_tool_calls", config.PERM_LOCAL, "最近的工具调用审计")
def t_recent_calls(limit=12, **_):
    return {"calls": store.recent_tool_calls(limit),
            "counts": store.tool_call_counts()}


# ========================================================== 本机备份 / 恢复
def _backup_dir():
    os.makedirs(config.BACKUP_DIR, exist_ok=True)
    return config.BACKUP_DIR


def _backup_path(name):
    """只接受本目录里的备份文件名，挡掉 ../ 之类的穿越。
    自定义备份和恢复前安全副本都认，别的文件一律不碰。"""
    name = os.path.basename(str(name or ""))
    if not (name.startswith(config.BACKUP_PREFIX)
            and name.endswith(".db.json")):
        return None
    return os.path.join(_backup_dir(), name)


def _dump_tables(con):
    """把整库读成可恢复的结构（events/word_mem/... 全表，一条不落）。"""
    out = {}
    for (t,) in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
            " AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
        rows = con.execute("SELECT * FROM %s" % t).fetchall()
        out[t] = [dict(r) for r in rows]
    return out


@tool("make_backup", config.PERM_LOCAL, "把本机学习库导出成一个备份文件（含总数与文件名）")
def t_make_backup(**_):
    """G2：一键导出。备份 = 全库 JSON 快照，文件名带时间戳，写进 backup/ 目录。"""
    d = _backup_dir()
    con = store.connect()
    try:
        dump = _dump_tables(con)
    finally:
        con.close()
    counts = {t: len(r) for t, r in dump.items()}
    name = "%s%s.db.json" % (config.BACKUP_PREFIX,
                             dt.datetime.now().strftime("%Y%m%d_%H%M%S"))
    path = os.path.join(d, name)
    payload = {"format": "studydeck-backup-1",
               "created_at": store.now(),
               "db": config.DB_PATH,
               "counts": counts,
               "tables": dump}
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    _tot = sum(counts.values())
    return {"name": name, "path": path, "dir": d,
            "size": os.path.getsize(path), "counts": counts,
            "say": "导出了一份整库快照 %s（%.1f KB，共 %d 行：作答 %d / 单词 %d / 事件 %d）。"
                   "恢复会把当前库整个换成这份的样子。" % (
                       name, os.path.getsize(path) / 1024.0, _tot,
                       counts.get("answers", 0), counts.get("word_mem", 0),
                       counts.get("events", 0)),
            "effect": "backup %s (%d rows)" % (name, _tot),
            "events": counts.get("events", 0),
            "words": counts.get("word_mem", 0),
            "note": "整库快照，恢复会把当前库整个换成备份里的样子"}


@tool("list_backups", config.PERM_LOCAL, "列出本机已有的备份文件（时间、大小、条目数）")
def t_list_backups(limit=20, **_):
    """两类文件分开列：kind=backup 是自己点「导出一份备份」出来的，
    kind=before_restore 是恢复前自动留的安全副本——不混在一起，免得用户以为
    自己导了 6 份。两类都能用来恢复，恢复前那份就是为了「刚恢复错了还能退回来」。"""
    d = _backup_dir()
    mine, safety = [], []
    for n in sorted(os.listdir(d), reverse=True):
        if not n.startswith(config.BACKUP_PREFIX):
            continue
        p = os.path.join(d, n)
        try:
            st = os.stat(p)
        except OSError:
            continue
        auto = n.startswith(config.BEFORE_RESTORE_PREFIX)
        item = {"name": n, "size": st.st_size, "kind": "before_restore" if auto else "backup",
                "mtime": dt.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")}
        if n.endswith(".db.json"):
            try:
                with io.open(p, encoding="utf-8") as f:
                    head = json.load(f)
                item["counts"] = head.get("counts") or {}
                item["created_at"] = head.get("created_at")
                item["events"] = (head.get("counts") or {}).get("events")
            except Exception:
                item["broken"] = True
        (safety if auto else mine).append(item)
    lim = int(limit or 20)
    mine = mine[:lim]
    safety = safety[:5]
    return {"say": "", "dir": d, "count": len(mine), "backups": mine,
            "auto_count": len(safety), "auto": safety,
            "empty": not mine,
            "note": "没有备份就是没有，不列假的"}


@tool("restore_backup", config.PERM_CONFIRM, "从备份文件恢复本机学习库（会覆盖当前库）")
def t_restore_backup(name=None, **_):
    """G2 恢复：先把当前库另存为 before_restore_*.db.json，再整库替换。

    只认 config.BACKUP_PREFIX 开头的文件，读不到就报 error，不动现有数据。
    """
    if not name:
        return {"error": "没指定备份文件名"}
    tick("读备份文件", n=1, total=4)
    path = _backup_path(name)
    if not path or not os.path.exists(path):
        return {"error": "没有这个备份: %s" % name}
    try:
        with io.open(path, encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as e:
        return {"error": "备份文件读不出来: %s: %s" % (type(e).__name__, e)}
    tables = payload.get("tables")
    if not isinstance(tables, dict) or not tables:
        return {"error": "备份文件里没有数据表，拒绝恢复（当前库没动）"}

    # 恢复前先把当前状态也留一份，手滑能再退回来
    pre = None
    tick("把当前库先另存一份", n=2, total=4)
    try:
        con = store.connect()
        try:
            dump = _dump_tables(con)
        finally:
            con.close()
        pre = os.path.join(_backup_dir(), "%s%s.db.json" % (
            config.BEFORE_RESTORE_PREFIX, dt.datetime.now().strftime("%Y%m%d_%H%M%S")))
        tmp = pre + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as f:
            json.dump({"format": "studydeck-backup-1", "created_at": store.now(),
                       "db": config.DB_PATH,
                       "counts": {t: len(r) for t, r in dump.items()},
                       "tables": dump}, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, pre)
    except Exception:
        pre = None  # 留盘失败不阻断恢复，但要如实说没留

    con = store.connect()
    try:
        tick("清空九张表", n=3, total=4)
        for t in ("answers", "error_tags", "events", "notes", "tool_calls",
                  "word_mem", "lesson_progress", "exam_sessions", "kv"):
            try:
                con.execute("DELETE FROM %s" % t)
            except sqlite3.Error:
                pass
        applied = {}
        for t, rows in tables.items():
            tick("回填 %s" % t, n=4, total=4)
            if not isinstance(rows, list) or not rows:
                applied[t] = 0
                continue
            cols = list(rows[0].keys())
            sql = "INSERT OR REPLACE INTO %s(%s) VALUES(%s)" % (
                t, ",".join(cols), ",".join("?" * len(cols)))
            con.executemany(sql, [tuple(r.get(c) for c in cols) for r in rows])
            applied[t] = len(rows)
        con.commit()
    finally:
        con.close()
    total_rows = sum(v for v in applied.values() if isinstance(v, int))
    say = ("从 %s 恢复了 %d 行（%s）。%s" % (
        name, total_rows,
        "、".join("%s %d" % (k, v) for k, v in applied.items() if v),
        ("恢复前那份库存成了 %s，反悔能再恢复回去。" % os.path.basename(pre)) if pre
        else "没来得及留恢复前的快照，这次覆盖不可回退。"))
    return {"restored_from": name, "before": pre, "applied": applied,
            "say": say, "effect": "%d rows restored" % total_rows,
            "note": ("恢复前已把当时的库存成 %s" % os.path.basename(pre)) if pre
                    else "没来得及留恢复前的快照，这次覆盖不可回退"}


@tool("platform_reset", config.PERM_CONFIRM,
      "清空整个平台的学习数据（先自动存一份快照；必须把 confirm 写成「清空」才动手）")
def t_platform_reset(confirm=None, keep_model=True, **_):
    """清空 = 回到新装机：进度 / 作答 / 词记忆 / 事件 / 课程库 / 拉进来的词书 / 自导题源。

    三道闸，少一道都不动：
      ① 权限档位（PERM_CONFIRM，界面会先问一句）；
      ② confirm 必须**手打「清空」**两个字 —— 不认 true/1/yes，"嗯"也不行；
      ③ 清之前自动存一份全库快照，清完把快照名交出来，后悔还能点恢复。
    模型 Key、XMind 登录态、B 站登录态属于「接入配置」，默认保留（keep_model=true）；
    要一起清就把 keep_model 传 false。备份文件不删 —— 那是唯一的退路。
    """
    word = str(confirm or "").strip()
    if word != "清空":
        return {"ok": False, "need_word": "清空",
                "error": "要清空得把 confirm 写成「清空」两个字（不是 true，也不是嗯）",
                "say": "没清：还差你亲手打「清空」两个字。",
                "effect": "noop: 没确认"}
    keep = str(keep_model).strip().lower() not in ("0", "false", "no", "off")

    tick("清空前先存一份快照", n=1, total=3)
    snap = None
    try:
        b = t_make_backup()
        snap = b.get("file") or b.get("name")
    except Exception:
        snap = None

    tick("清数据库", n=2, total=3)
    wiped = {}
    con = store.connect()
    try:
        tabs = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()]
        for t in tabs:
            try:
                n = con.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
            except sqlite3.Error:
                continue
            if keep and t == "kv":
                # 接入配置留着：清完还得能跟模型说话、能同步 XMind
                rows = con.execute("SELECT k FROM kv").fetchall()
                drop = [k for (k,) in rows
                        if not (str(k).startswith("ai.")
                                or str(k).startswith("xmind")
                                or str(k).startswith("bili"))]
                for k in drop:
                    con.execute("DELETE FROM kv WHERE k=?", (k,))
                wiped[t] = len(drop)
            else:
                con.execute("DELETE FROM %s" % t)
                wiped[t] = n
        con.commit()
    finally:
        con.close()

    tick("清课程库 / 词书 / 题源", n=3, total=3)
    files = []
    for p in (config.COURSES_EXTRA, config.VOCAB_EXTRA, config.IMPORTED_SOURCES,
              getattr(config, "PAPERS_EXTRA", ""), getattr(config, "GEN_QUESTIONS", "")):
        try:
            if os.path.exists(p):
                os.remove(p)
                files.append(os.path.basename(p))
        except Exception:
            pass
    # 内存缓存必须一起清，否则界面还拿着上一版的课程库/词书
    for _c in (datahub._proto_cache, datahub._extra_cache, datahub._vocab_cache,
               datahub._exam_cache, datahub._imp_cache,
               datahub._paper_extra_cache, datahub._gen_cache):
        _c["key"] = None
        _c["data"] = None

    rows_total = sum(v for v in wiped.values())
    return {"ok": True, "rows": wiped, "rows_total": rows_total, "files": files,
            "snapshot": snap, "kept_model": keep,
            "say": ("清空了：%d 行学习数据、%d 个数据文件（%s）。清空前存了一份快照 %s，"
                    "要退回去就在快照列表点恢复。%s"
                    % (rows_total, len(files), "、".join(files) or "无",
                       snap or "（没存上，这次清空不可回退）",
                       "模型 Key 和登录态都留着。" if keep else "模型 Key 也一起清了。")),
            "effect": "reset %d rows / %d files" % (rows_total, len(files))}


# ========================================================== 多端同步（G1）
def _sync_dir(create=False):
    """同步目录 = config.SYNC_DIR 下的 SYNC_DIRNAME 子目录。

    两个口径：config.SYNC_DIR 是「那个网盘 / U 盘的根」，SYNC_DIRNAME 是本机放进
    去的那个文件夹 —— 不把人家的网盘根目录当成自己的产物，也不往那儿乱写。
    """
    d = os.path.join(config.SYNC_DIR, config.SYNC_DIRNAME)
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def _bundle_path(name):
    """只接受同步目录里的同步包文件名（带前缀 + 后缀），挡掉 ../ 穿越。"""
    name = os.path.basename(str(name or ""))
    if not (name.startswith(config.SYNC_BUNDLE_PREFIX)
            and name.endswith(".json")):
        return None
    return os.path.join(_sync_dir(), name)


def _read_bundle(path):
    """读一个同步包，顺手做基本体检：格式认得就是 True，读不出来给原因。"""
    if not path or not os.path.exists(path):
        return None, "没有这个同步包"
    try:
        with io.open(path, encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as e:
        return None, "同步包读不出来：%s: %s" % (type(e).__name__, e)
    ver = (payload or {}).get("format")
    if ver not in ("studydeck-sync-1",):
        return None, "这不是研学台的同步包（format=%s）" % ver
    tables = (payload or {}).get("tables") or {}
    if not isinstance(tables, dict) or not any(tables.values()):
        return None, "同步包里没有学习记录"
    return payload, None


@tool("sync_push", config.PERM_LOCAL,
      "把本机学习记录写一份到同步目录（网盘/U盘），另一台机器拉回来")
def t_sync_push(**_):
    """把本机库导出成一个同步包放进 SYNC_DIR，文件名带设备名和时间戳。

    只写本机那份，不去动别人的包 —— 两台机器各推各的，拉的时候才合并。
    """
    if not config.SYNC_ENABLED:
        return {"enabled": False, "error": "多端同步没开（config.SYNC_ENABLED=False）"}
    d = _sync_dir(create=True)
    bundle = store.export_bundle()
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_dev = re.sub(r"[^\w.-]+", "_", store.device_name())[:24] or "device"
    name = "%s%s_%s.json" % (config.SYNC_BUNDLE_PREFIX, safe_dev, stamp)
    path = os.path.join(d, name)
    payload = {"format": "studydeck-sync-1", "device": store.device_name(),
               "device_id": store.device_id(), "created_at": store.now(),
               "counts": bundle["counts"], "tables": bundle["tables"]}
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    store.kv_set("sync_last_push_at", store.now())
    return {"ok": True, "name": name, "path": path, "dir": d,
            "size": os.path.getsize(path), "counts": bundle["counts"],
            "events": bundle["counts"].get("events", 0),
            "words": bundle["counts"].get("word_mem", 0),
            "note": "写进同步目录了：在另一台机器上点「拉取别人的 → 合并」就能合进来"}


@tool("sync_peers", config.PERM_LOCAL, "看同步目录里现在有哪些机器推上来的包")
def t_sync_peers(limit=20, **_):
    """列同步目录里所有包，本机自己那份标 self=True，别台标 importable=True。

    看不出来就是没有，不列假包。"""
    if not config.SYNC_ENABLED:
        return {"enabled": False, "error": "多端同步没开", "peers": []}
    d = _sync_dir()
    if not os.path.exists(d):
        return {"enabled": True, "dir": d, "empty": True, "peers": [],
                "note": "同步目录还没建立：点一次「推出本机」就会建好"}
    me = store.device_id()
    peers = []
    for n in sorted(os.listdir(d), reverse=True):
        if not (n.startswith(config.SYNC_BUNDLE_PREFIX) and n.endswith(".json")):
            continue
        p = os.path.join(d, n)
        try:
            st = os.stat(p)
        except OSError:
            continue
        payload, err = _read_bundle(p)
        item = {"name": n, "size": st.st_size,
                "mtime": dt.datetime.fromtimestamp(st.st_mtime).strftime(
                    "%Y-%m-%d %H:%M:%S")}
        if err:
            item["broken"] = True
            item["why"] = err
        else:
            item["device"] = payload.get("device") or "未知设备"
            item["created_at"] = payload.get("created_at")
            item["counts"] = payload.get("counts") or {}
            item["events"] = (payload.get("counts") or {}).get("events")
            item["self"] = payload.get("device_id") == me
            item["importable"] = not item["self"]
        peers.append(item)
    lim = int(limit or 20)
    # count/others 报的是**整目录**的数，不是这一页的数 —— 界面按 peers 画行、
    # 按 others 数按钮，两者必须同一口径，否则一翻页就对不上（21 份包 vs 19 个按钮）。
    return {"enabled": True, "dir": d, "peers": peers[:lim],
            "count": len(peers),
            "shown": len(peers[:lim]),
            "self_count": len([x for x in peers if x.get("self")]),
            "others": len([x for x in peers if x.get("importable")]),
            "empty": not peers,
            "last_pull": store.kv_get("sync_last_pull_at"),
            "last_push": store.kv_get("sync_last_push_at"),
            "note": ("没有别的机器推过包" if not peers else
                     "本机那份也能拉，但自己和自己合并没有意义，默认挡掉")}


@tool("sync_pull", config.PERM_CONFIRM,
      "从同步目录里拉一个包合并进本机（先看 sync_peers 选哪个）")
def t_sync_pull(name=None, myself=False, **_):
    """把一个同步包合进本机。默认拒绝拉自己那份（自己和自己合并没意义）。

    合并是逐条比对、取并集，不是整库覆盖 —— 不丢任一台机器上的进度。
    冲突的笔记不静默覆盖：把另一份留进 alt_text / alt_ts，你自己挑留哪个。
    """
    if not config.SYNC_ENABLED:
        return {"enabled": False, "error": "多端同步没开"}
    if not name:
        return {"error": "没指定要拉哪个包（先调 sync_peers 看看有哪些）"}
    path = _bundle_path(name)
    if not path:
        return {"error": "文件名不合规：只认 %s 开头的同步包"
                         % config.SYNC_BUNDLE_PREFIX}
    payload, err = _read_bundle(path)
    if err:
        return {"error": err}
    if payload.get("device_id") == store.device_id() and not myself:
        return {"error": "这是本机自己推的包，合并自己和自己没有意义",
                "name": name, "hint": "要真这样做就传 myself=true"}
    tick("逐条比对 %s" % name, n=1, total=2)
    res = store.merge_bundle(payload)
    if res.get("error"):
        return res
    tick("写回本机库", n=2, total=2)
    store.kv_set("sync_last_pull_at", store.now())
    store.kv_set("sync_last_pull_from", name)
    say = ("从 %s 拉回来了：新纳进 %d 条、更新 %d 条%s"
           % (name, res["new"], res["changed"],
              ("，%d 条笔记两边都改过 —— 冲突版本存在 alt 里，去看看那条讲次的笔记"
               % res["notes_conflicts"]) if res["notes_conflicts"] else ""))
    if not res["new"] and not res["changed"]:
        say = "%s 里的东西本机都已经有了，这次合并没改动任何一行。" % name
    return {"ok": True, "pulled_from": name,
            "device": payload.get("device"),
            "created_at": payload.get("created_at"),
            "added": res["added"], "updated": res["updated"],
            "conflicts": res["conflicts"],
            "new": res["new"], "changed": res["changed"],
            "say": say, "effect": "+%d / ~%d" % (res["new"], res["changed"]),
            "notes_conflicts": res["notes_conflicts"],
            "note": say}


@tool("sync_status", config.PERM_LOCAL, "看当前同步链路是什么状态：目录在哪、本机谁、最后推拉时间")
def t_sync_status(**_):
    """状态卡肉眼能对账的那种：目录真实存在与否、本机 id/名字、上次推拉时间、
    目录里几个包。看不到数据就把「没有」说出来，不形式化。"""
    if not config.SYNC_ENABLED:
        return {"enabled": False, "note": "多端同步在 config 里被关掉了"}
    d = _sync_dir()
    ex = os.path.exists(d)
    try:
        files = [n for n in os.listdir(d) if n.startswith(config.SYNC_BUNDLE_PREFIX)
                 and n.endswith(".json")] if ex else []
    except OSError:
        files = []
    mine = [n for n in files if store.device_name().split("_")[0][:6] in n]
    return {"enabled": True, "dir": d, "dir_exists": ex,
            "device_id": store.device_id(), "device": store.device_name(),
            "bundles": len(files), "mine": len(mine),
            "last_push": store.kv_get("sync_last_push_at"),
            "last_pull": store.kv_get("sync_last_pull_at"),
            "last_pull_from": store.kv_get("sync_last_pull_from"),
            "note": "" if ex else "同步目录还没建立：点一次「推出本机」就会建好"}


@tool("xmind_connect", config.PERM_NET, "连 XMind：现开官方授权页（PKCE），把授权链接交给你点")
def t_xmind_connect(**_):
    """XMind 登录入口。

    以前只有 HTTP 路由（/api/xmind/login），界面上没有按钮、模型也不知道有这个动作 ——
    设置里那行只能显示「待配」，人找不到地方点。这里把它做成工具：
    返回真授权 URL（服务端也会试着直接拉起浏览器），前端拿 url 再开一次或换机器打开。
    """
    st = xmind.status()
    if st.get("connected"):
        return {"ok": True, "connected": True, "already": True,
                "scope": st.get("scope"), "left": st.get("left_text") or st.get("expires_in"),
                "say": "XMind 已经连着了（scope=%s）。要换账号就先断开再连。" % (st.get("scope") or ""),
                "effect": "noop: already connected"}
    r = xmind.start_login()
    if r.get("error"):
        return {"ok": False, "error": r.get("error"), "detail": r.get("detail", ""),
                "say": "没连上：%s" % r.get("error"), "effect": "0 login"}
    return {"ok": True, "connected": False, "url": r.get("url"),
            "redirect_uri": r.get("redirect_uri"), "scope": r.get("scope"),
            "opened": bool(r.get("opened")),
            "say": "授权页开出来了：在浏览器里点同意，回到这里点一次「检查状态」就通了。",
            "effect": "oauth url issued"}


@tool("xmind_disconnect", config.PERM_CONFIRM, "断开 XMind（只清本机 token，不动云端任何东西）")
def t_xmind_disconnect(**_):
    st = xmind.status()
    xmind.clear_token()
    return {"ok": True, "was_connected": bool(st.get("connected")),
            "say": "XMind 断开了（只清本机 token，云端导图一张都没动）。"
                   if st.get("connected") else "本来就没连着，已经清干净。",
            "effect": "xmind token cleared"}


@tool("xmind_list_maps", config.PERM_NET, "拉 XMind 云端导图列表（要先登录）")
def t_xmind_list_maps(**_):
    """列云端导图。工具名不写死——先问服务端它有哪些工具，再按关键字挑，
    挑不到就把真实工具表交出来让你自己看，绝不编一个工具名去调。"""
    st = xmind.status()
    if not st.get("connected"):
        return {"error": u"还没登录 XMind：点「登录 XMind」在官方授权页授权",
                "reason": st.get("reason"), "maps": []}
    tl = xmind.mcp_tools()
    if tl.get("error"):
        return {"error": u"拿不到工具表：" + str(tl.get("error")),
                "detail": tl.get("detail", ""), "maps": []}
    name = xmind.pick_tool(["list", "mindmap", "mindmaps"], tools=tl)
    if not name:
        return {"error": u"服务端工具表里找不到「列导图」的那一个",
                "tools": tl.get("tools", []), "maps": []}
    r = xmind.mcp_call(name, {})
    if r.get("error"):
        return {"error": u"调用 %s 失败：" % name + str(r.get("error")),
                "maps": [], "tool": name}
    txt = r.get("text") or ""
    maps = []
    try:
        d = json.loads(txt)
        if isinstance(d, list):
            maps = d
        elif isinstance(d, dict):
            maps = (d.get("mindmaps") or d.get("maps") or d.get("items")
                    or d.get("data") or [])
    except ValueError:
        maps = []
    return {"ok": True, "tool": name, "count": len(maps), "maps": maps,
            "raw": txt[:2000],
            "note": (u"从 XMind 云端拉到 %d 张导图" % len(maps)) if maps
                    else u"云端返回了内容但解析不出导图列表，原文附在 raw 里"}


@tool("xmind_read_map", config.PERM_NET, "读一张 XMind 云端导图（要先登录）")
def t_xmind_read_map(map_id=None, **_):
    """读单张导图。map_id 从 xmind_list_maps 的返回里取，本机不猜 ID。"""
    if not map_id:
        return {"error": u"没给 map_id（先调 xmind_list_maps 看看有哪些）"}
    st = xmind.status()
    if not st.get("connected"):
        return {"error": u"还没登录 XMind", "reason": st.get("reason")}
    tl = xmind.mcp_tools()
    if tl.get("error"):
        return {"error": u"拿不到工具表：" + str(tl.get("error"))}
    name = xmind.pick_tool(["read", "get"], tools=tl)
    if not name:
        return {"error": u"服务端工具表里找不到「读导图」的那一个",
                "tools": tl.get("tools", [])}
    r = xmind.mcp_call(name, {"map_id": map_id, "id": map_id})
    if r.get("error"):
        return {"error": u"调用 %s 失败：" % name + str(r.get("error"))}
    return {"ok": True, "tool": name, "map_id": map_id,
            "text": (r.get("text") or "")[:6000],
            "note": u"原文照抄云端返回，本机不改内容"}


# ---------------------------------------------------------------- 笔记画布（canvas）
NOTE_SRCS = [
    {"id": "local",     "name": "本地画布",   "kind": "builtin",
     "how": "直接在本机新建 / 编辑，不依赖任何外部账号", "ready": True},
    {"id": "xmind",     "name": "XMind",     "kind": "oauth",
     "how": "官方 MCP + OAuth 登录，拉你在平板 / 手机上做的导图", "ready": True},
    {"id": "markdown",  "name": "Markdown",  "kind": "file",
     "how": "粘贴或选一个 .md：一级标题做主干，缩进列表做分支", "ready": True},
    {"id": "obsidian",  "name": "Obsidian",  "kind": "file",
     "how": "指向你的库文件夹，读里面所有 .md（[[双链]] 原样保留）", "ready": True},
    {"id": "logseq",    "name": "Logseq",    "kind": "file",
     "how": "指向 graphs 目录，按 pages / journals 里的 .md 转成导图", "ready": True},
    {"id": "opml",      "name": "OPML",      "kind": "file",
     "how": "导入 .opml（XMind / 幕布 / MindManager 都能导出的通用大纲格式）", "ready": True},
    {"id": "joplin",    "name": "Joplin",    "kind": "api",
     "how": "填 Web Clipper Token，按笔记本 / 笔记层级拉成导图", "ready": True},
    {"id": "notion",    "name": "Notion",    "kind": "api",
     "how": "填 Integration Token，按页面 block 层级拉成导图", "ready": True},
    {"id": "yuque",     "name": "语雀",      "kind": "api",
     "how": "填 API Token，按知识库 / 文档层级拉成导图", "ready": True},
    {"id": "wolai",     "name": "我来 wolai", "kind": "api",
     "how": "填开放 API Token，按页面块层级拉成导图", "ready": True},
]


def _note_id(lesson_id, src, src_id):
    """画布 ID：同一讲次 + 同一来源 + 同一来源文件，只会有一张画布。

    以前笔记只有 lesson_id 一个键，换台机器同步就把另一份盖了；现在把来源写进主键，
    本地的和 XMind 拉下来的各占一行，互不覆盖。
    """
    return "%s|%s|%s" % (lesson_id or "free", src or "local", src_id or "-")


def _xm_tree(raw):
    """把 XMind 云端返回的导图 JSON 抹成本机的树。

    云端的形状不固定（有时是 {root:{...}}，有时是 {sheet:{rootTopic}}，
    有时 children 叫 topics/attached），所以这里不假设某一种，而是：
      1) 递归找「第一个带标题的字典」当根
      2) 子节点从 children / topics / attached / subtopics 里取，能取到哪个用哪个
      3) 标题字段依次试 title / text / name
    找不到就当空树，不编内容。
    """
    def kids(d):
        for k in ("children", "topics", "attached", "subtopics", "topicChildren"):
            v = d.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                for kk in ("attached", "topics", "children"):
                    if isinstance(v.get(kk), list):
                        return v[kk]
        return []

    def title(d):
        for k in ("title", "text", "name", "label"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""

    def walk(d, depth, seen):
        if not isinstance(d, dict) or depth > 14:
            return None
        t = title(d)
        ks = kids(d)
        if not t and not ks:
            return None
        node = {"id": "xm%d" % seen[0], "text": t or "(未命名)", "children": []}
        seen[0] += 1
        for c in ks:
            sub = walk(c, depth + 1, seen) if isinstance(c, dict) else None
            if sub:
                node["children"].append(sub)
        return node

    def find_root(d, depth=0):
        if not isinstance(d, dict) or depth > 8:
            return None
        if title(d):
            n = walk(d, 0, [0])
            if n:
                return n
        for k in ("root", "rootTopic", "sheet", "data", "mindmap", "document"):
            v = d.get(k)
            if isinstance(v, dict):
                n = find_root(v, depth + 1)
                if n:
                    return n
        return None

    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if not isinstance(raw, (dict, list)):
        return None
    if isinstance(raw, list):
        for it in raw:
            n = find_root(it)
            if n:
                return n
        return None
    return find_root(raw)


def _shape_simple(tree):
    """缩略图形状（复用 note_list 那套口径的前三层）。"""
    return _shape(tree)


@tool("note_pull_xmind", config.PERM_NET, "把 XMind 云端的一张导图拉成本机画布")
def t_note_pull_xmind(map_id=None, lesson_id=None, title=None, **_):
    if not map_id:
        return {"ok": False,
                "error": u"没给 map_id：先调 xmind_list_maps 看看云端有哪些图"}
    r = t_xmind_read_map(map_id=map_id)
    if r.get("error"):
        return {"ok": False, "error": r.get("error"), "detail": r.get("detail", "")}
    raw = r.get("text") or ""
    tree = _xm_tree(raw)
    if not tree:
        return {"ok": False,
                "error": u"云端返回的内容里找不到导图结构，原文附在 raw 里，本机不瞎猜",
                "raw": raw[:1500]}
    # 云端导图不一定带 relations/summaries，缺的就补空数组，跟本地画布同一套结构
    tree.setdefault("relations", [])
    tree.setdefault("boundaries", [])
    tree.setdefault("summaries", [])
    ttl = title or tree.get("text") or (u"XMind 导图")
    mid = _note_id(lesson_id, "xmind", map_id)
    store.save_canvas(mid, title=ttl, tree=tree, lesson_id=lesson_id,
                      src="xmind", src_id=map_id)
    store.add_event("note", lesson_id, payload="pull xmind %s" % map_id)
    _cn = _count_nodes(tree)
    return {"ok": True, "map": mid, "title": ttl, "src": "xmind",
            "src_id": map_id, "nodes": _cn,
            "say": u"从 XMind 拉下来了：「%s」%d 个节点，存进本机画布（id=%s）。"
                   u"改的是本机这份，云端没动。" % (ttl or map_id, _cn, mid),
            "effect": "xmind %s -> canvas %s (%d nodes)" % (map_id, mid, _cn),
            "tree": tree, "note": u"从 XMind 拉下来存在本机，改的是本机这份"}


def _count_nodes(n):
    if not isinstance(n, dict):
        return 0
    c = 1
    for k in (n.get("children") or []):
        c += _count_nodes(k)
    return c


@tool("note_push_xmind", config.PERM_NET, "把本机画布推成一张 XMind 云端导图")
def t_note_push_xmind(lesson_id=None, src="local", src_id=None,
                      map_id=None, title=None, **_):
    """推回云端。名字从服务端真实工具表里挑，挑不到就明说，不编工具名。"""
    got = t_note_load(lesson_id=lesson_id, src=src, src_id=src_id)
    if not got.get("ok") or not got.get("exists"):
        return {"ok": False, "error": u"本机这张画布还没存过，先存一次再推"}
    tree = got.get("tree") or {}
    tl = xmind.mcp_tools()
    if tl.get("error"):
        return {"ok": False, "error": u"拿不到 XMind 工具表：" + str(tl.get("error"))}
    names = [it.get("name") for it in (tl.get("tools") or [])]
    name = xmind.pick_tool(["create", "mindmap"], tools=tl) or \
           xmind.pick_tool(["add", "mindmap"], tools=tl)
    if not name:
        return {"ok": False,
                "error": u"XMind 工具表里没有「新建导图」这一类，推不上去",
                "tools": names}
    body = {"title": title or got.get("map", {}).get("title") or u"研学台导图",
            "content": tree}
    r = xmind.mcp_call(name, body)
    if r.get("error"):
        return {"ok": False, "error": u"调用 %s 失败：" % name + str(r.get("error")),
                "tool": name}
    return {"ok": True, "tool": name, "text": (r.get("text") or "")[:2000],
            "note": u"已推给 XMind，云端自己的返回原文附在 text 里"}


SHOT_DIR = os.path.join(config.APP_DATA_DIR, "shots")
SHOT_MAX = 12 * 1024 * 1024          # 单张上限 12MB，base64 膨胀后约 16MB


def _shot_abs(rel):
    """把库里的相对路径还原成盘上的绝对路径，并锁死在 data/shots 内。
    外面传 ../ 也出不去 —— 这是唯一一处按用户给的名字落盘的地方。"""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    p = os.path.abspath(os.path.join(SHOT_DIR, rel))
    if not p.startswith(os.path.abspath(SHOT_DIR) + os.sep):
        raise ValueError("路径越界：%s" % rel)
    return p


def _b64_write(data, rel):
    """data 可以是 data:image/png;base64,xxx 也可以只是裸 base64。写进盘，返回字节数。"""
    import base64
    if not data:
        raise ValueError("没给图片数据")
    if data.startswith("data:"):
        head, _, data = data.partition(",")
        if "base64" not in head:
            raise ValueError("只认 base64 编码的 data URL")
    raw = base64.b64decode(data, validate=False)
    if not raw:
        raise ValueError("解出来是空图")
    if len(raw) > SHOT_MAX:
        raise ValueError("图太大了（%.1f MB），上限 %d MB" % (len(raw) / 1048576.0, SHOT_MAX // 1048576))
    p = _shot_abs(rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(raw)
    return len(raw)


@tool("shot_save", config.PERM_LOCAL, "把一张图存进某个学科的截图库")
def t_shot_save(data=None, subject=None, lesson_id=None, title=None, w=None, h=None,
                tag="canvas", origin=None, pos_sec=None, src_path=None, **_):
    if not data:
        return {"ok": False, "error": "没收到图片数据"}
    subj = (subject or "free").strip() or "free"
    sid = "sh_%s_%s" % (re.sub(r"[^a-z0-9]+", "", subj.lower()) or "free",
                        uuid.uuid4().hex[:10])
    rel = "%s/%s.png" % (subj, sid)
    try:
        n = _b64_write(data, rel)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    # origin 不传就按 tag 推：老调用点（画布导出）不用改，行为不变
    org = origin or {"screen": "frame", "file": "upload"}.get(tag, "canvas")
    row = store.save_shot(sid, subj, rel, title=title or "未命名截图",
                          lesson_id=lesson_id, w=w, h=h, nbytes=n, tag=tag,
                          origin=org, pos_sec=pos_sec, src_path=src_path)
    store.add_event("shot", sid, payload="subject=%s origin=%s" % (subj, org))
    row["url"] = "/shots/" + rel
    return {"ok": True, "shot": row, "count": store.shot_count(subj),
            "say": "截图存进素材库了：%s（%.0f KB），%s 分类现在共 %d 张。" % (
                row.get("title") or sid, (n or 0) / 1024.0, subj, store.shot_count(subj)),
            "effect": "shot %s saved" % sid}


@tool("shot_frame", config.PERM_LOCAL, "把视频里的一帧存进素材库（带秒数，能在进度条上打点）")
def t_shot_frame(data=None, subject=None, lesson_id=None, pos_sec=None,
                 title=None, w=None, h=None, **_):
    """截帧和普通截图走同一条落盘路，只多记两件事：origin=frame、pos_sec。

    pos_sec 必须记：进度条上要打点、点一下要能跳回那一刻。
    没有它，素材库就只是一堆不知道在哪儿的图。
    """
    if pos_sec is None:
        return {"ok": False, "error": "截帧要带 pos_sec，否则不知道该回哪儿"}
    try:
        ps = round(float(pos_sec), 2)
    except (TypeError, ValueError):
        return {"ok": False, "error": "pos_sec 不是数字：%r" % (pos_sec,)}
    if not title:
        m, s = int(ps) // 60, int(ps) % 60
        title = "第 %d 讲 %02d:%02d" % (0, m, s) if ps < 3600 else "%02d:%02d" % (m, s)
    r = t_shot_save(data=data, subject=subject, lesson_id=lesson_id,
                    title=title, w=w, h=h, tag="screen",
                    origin="frame", pos_sec=ps)
    if r.get("ok"):
        r["pos_sec"] = ps
    return r


@tool("shot_upload", config.PERM_LOCAL, "把本机的一张图上传进素材库（origin=upload）")
def t_shot_upload(data=None, subject=None, lesson_id=None, title=None,
                  w=None, h=None, **_):
    return t_shot_save(data=data, subject=subject, lesson_id=lesson_id,
                       title=title or "上传的图", w=w, h=h, tag="file",
                       origin="upload")


@tool("shot_timeline", config.PERM_LOCAL, "某一讲的截图时间线（按秒排好，只给元数据）")
def t_shot_timeline(lesson_id=None, **_):
    """这一讲截过哪些帧、分别在第几秒。

    只回元数据（id / pos_sec / url / title），不回图内容 —— 进度条打点只需要
    「第几秒有个点」，图本身由浏览器按 url 懒加载。
    """
    if not lesson_id:
        return {"ok": False, "error": "没给讲次"}
    rows = store.list_shots(lesson_id=lesson_id, limit=500, origin="frame")
    pts = [{"id": r.get("id"), "pos_sec": r.get("pos_sec"), "url": r.get("url"),
            "title": r.get("title"), "ts": r.get("ts")}
           for r in rows if r.get("pos_sec") is not None]
    pts.sort(key=lambda x: x["pos_sec"])
    return {"ok": True, "lesson_id": lesson_id, "points": pts, "count": len(pts),
            "note": "只有截过帧的讲次才有时间线；没截过就是空的，不是取失败。"}


@tool("shot_list", config.PERM_LOCAL, "列截图库（可按学科 / 讲次 / 来源筛，可按关键词搜）")
def t_shot_list(subject=None, lesson_id=None, limit=200, q=None, origin=None, **_):
    rows = store.list_shots(subject=subject, lesson_id=lesson_id, limit=limit,
                            q=q, origin=origin)
    for r in rows:
        r["age"] = _ago(r.get("ts"))
        # 分组要用人话的讲次名。讲次 id 本身前端也有，标题前端拿不到别的讲，
        # 所以在这里补一次；查不到就老实留空，让前端退回显示 id。
        lid = r.get("lesson_id")
        if lid:
            _subj, les = datahub.find_lesson(datahub.proto(), lid)
            if les:
                r["lesson_title"] = les.get("title") or ""
    # 分桶给前端用（今天 / 昨天 / 本周 / 更早），但桶的边界按真实 ts 算，
    # 不在前端重算一遍 —— 两边算必然会出现「卡片在一个桶、分组在另一个桶」。
    return {"ok": True, "shots": rows, "count": len(rows), "q": q or "",
            "total": store.shot_count(subject), "subject": subject or "",
            "origin": origin or "", "tags": store.all_shot_tags(subject)}


@tool("shot_del", config.PERM_LOCAL, "从截图库里摘掉一条（盘上的图不删）")
def t_shot_del(id=None, **_):
    if not id:
        return {"ok": False, "error": "没给截图 id"}
    k = store.del_shot(id)
    if not k:
        return {"ok": False, "error": "截图库里没有这一条"}
    store.add_event("shot_del", id)
    return {"ok": True, "deleted": k,
            "say": "这条截图记录从库里删掉了。盘上的图还在 shots 目录里，没动。",
            "effect": "shot %s deleted" % id}


@tool("shot_rename", config.PERM_LOCAL, "给截图改个名字（只改库里的账，不动盘上的图）")
def t_shot_rename(id=None, title=None, **_):
    if not id:
        return {"ok": False, "error": "没给截图 id"}
    old = store.get_shot(id)
    if not old:
        return {"ok": False, "error": "截图库里没有这一条"}
    title = ("" if title is None else str(title)).strip()
    if len(title) > 60:
        title = title[:60]
    row = store.rename_shot(id, title)
    if not row:
        return {"ok": False, "error": "改名没写进去"}
    store.add_event("shot_rename", id, payload=(old.get("title") or "") + " -> " + title)
    return {"ok": True, "shot": row, "title": row.get("title") or "",
            "say": "改名了：「%s」→「%s」。" % (old.get("title") or "未命名", row.get("title") or ""),
            "effect": "rename %s" % id}


@tool("shot_tag", config.PERM_LOCAL, "给截图打标签 / 去掉标签（传完整标签数组，不是增量）")
def t_shot_tag(id=None, tags=None, **_):
    if not id:
        return {"ok": False, "error": "没给截图 id"}
    if tags is None:
        return {"ok": False, "error": "没给标签"}
    if isinstance(tags, str):
        # 允许前端图省事传 "数学,易错" 这种串
        tags = [t for t in re.split(r"[,，;；\s]+", tags) if t]
    if not isinstance(tags, (list, tuple)):
        return {"ok": False, "error": "标签要给一个数组"}
    row = store.tag_shot(id, list(tags))
    if not row:
        return {"ok": False, "error": "截图库里没有这一条"}
    store.add_event("shot_tag", id, payload=",".join(row.get("tags") or []))
    _tg = row.get("tags") or []
    return {"ok": True, "shot": row, "tags": _tg,
            "say": "标签改成：%s（%d 个）。" % ("、".join(_tg) if _tg else "（空）", len(_tg)),
            "effect": "tags %s" % ",".join(_tg)}


@tool("shot_disk", config.PERM_LOCAL, "截图库在本机占了多少字节")
def t_shot_disk(subject=None, **_):
    rows = store.list_shots(subject=subject, limit=5000)
    total = sum(int(r.get("bytes") or 0) for r in rows)
    by = {}
    for r in rows:
        k = r.get("subject") or "free"
        by.setdefault(k, {"n": 0, "bytes": 0})
        by[k]["n"] += 1
        by[k]["bytes"] += int(r.get("bytes") or 0)
    return {"ok": True, "total_bytes": total, "count": len(rows), "by_subject": by,
            "dir": SHOT_DIR}


def _shot_refs():
    """库里所有记录声明的文件（相对 data/shots 的路径，统一成 / 分隔）。"""
    refs = set()
    for r in store.list_shots(limit=100000):
        f = (r.get("file") or "").replace("\\", "/").strip("/")
        if f:
            refs.add(rel_norm(f))
    return refs


def rel_norm(p):
    return p.replace("\\", "/").strip("/")


def _shot_files():
    """data/shots 下真实存在的图片文件（相对路径）。"""
    out = []
    if not os.path.isdir(SHOT_DIR):
        return out
    for root, _dirs, files in os.walk(SHOT_DIR):
        for fn in files:
            if not fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                continue
            full = os.path.join(root, fn)
            rel = rel_norm(os.path.relpath(full, SHOT_DIR))
            try:
                sz = os.path.getsize(full)
            except OSError:
                sz = 0
            out.append({"file": rel, "bytes": sz})
    out.sort(key=lambda x: -x["bytes"])
    return out


@tool("shot_gc", config.PERM_LOCAL, "找出 / 清掉截图目录里没有库记录引用的图（不传 dry_run=False 就只统计）")
def t_shot_gc(dry_run=True, **_):
    """默认只统计不动手。dry_run=False 才真删 —— 删盘是不可逆操作，
    不给它一个「顺手就做了」的默认值。"""
    refs = _shot_refs()
    files = _shot_files()
    orphans = [f for f in files if f["file"] not in refs]
    used_bytes = sum(f["bytes"] for f in files)
    orphan_bytes = sum(f["bytes"] for f in orphans)
    deleted, failed = [], []
    if not dry_run:
        for f in orphans:
            try:
                path = _shot_abs(f["file"])
            except ValueError:
                failed.append({"file": f["file"], "error": "路径越界"})
                continue
            try:
                os.remove(path)
                deleted.append(f["file"])
            except OSError as e:
                failed.append({"file": f["file"], "error": str(e)})
    all_orphan = bool(files) and len(orphans) == len(files)
    warn = ""
    if all_orphan:
        warn = ("目录里 %d 张图全都没有库记录引用。如果你刚清过库，"
                "这些是清之前存的图 —— 清盘会把它们全部删掉。" % len(files))
    return {"ok": True, "dry_run": bool(dry_run),
            "files": len(files), "referenced": len(refs & {f["file"] for f in files}),
            "orphans": len(orphans),
            "orphan_bytes": orphan_bytes,
            "total_bytes": used_bytes,
            "kept_bytes": used_bytes - orphan_bytes,
            "deleted": len(deleted), "failed": len(failed),
            "all_orphan": all_orphan, "warn": warn,
            "top": orphans[:12],
            "note": ("只统计，没删。要真删把 dry_run 设成 false" if dry_run
                     else "已删 %d 个没有被引用的文件" % len(deleted))}


@tool("note_sources", config.PERM_LOCAL, "列出可以接入的笔记来源，带每个来源现在的连接状态")
def t_note_sources(**_):
    """能接哪些笔记软件、各自什么状态。

    **状态必须是真查出来的**：文件类看路径存不存在、API 类看 token 填没填、
    XMind 看 token 过期没。不假装能连，也不写死「已接入」。
    """
    try:
        xm = xmind.status() or {}
    except Exception as e:
        xm = {"connected": False, "reason": "XMind 模块没起来：%s" % e}
    out = []
    for s in NOTE_SRCS:
        d = dict(s)
        if s["id"] == "xmind":
            d["connected"] = bool(xm.get("connected"))
            d["state"] = (u"已登录" if xm.get("connected")
                          else (u"未登录：" + (xm.get("reason") or "")))
            d["cfg"] = {}
        else:
            st = notesrc.cfg_state(s["id"])
            d["connected"] = bool(st.get("connected"))
            d["state"] = st.get("state") or u""
            d["missing"] = st.get("missing")
            d["cfg"] = st.get("cfg") or {}
        d["hint"] = notesrc.HINTS.get(s["id"]) or {}
        out.append(d)
    ready = [x["id"] for x in out if x.get("connected")]
    return {"sources": out, "count": len(out), "ready": ready,
            "note": (u"%d 个来源里 %d 个现在能用：%s。"
                     u"其余点「设置」填上文件夹或 token 就能用"
                     % (len(out), len(ready), u"、".join(ready)))}


@tool("note_src_cfg", config.PERM_LOCAL, "记住某个笔记来源的文件夹路径或 token")
def t_note_src_cfg(src=None, path=None, token=None, base=None, clear=False, **_):
    """存配置。token 只存本机 SQLite，不出机器，也不回显给前端。"""
    if not src:
        return {"error": u"没说要配置哪个来源"}
    if src not in notesrc.FILE_SRCS + notesrc.API_SRCS:
        return {"error": u"%s 不是可以填凭证的来源" % src}
    d = notesrc.set_cfg(src, path=path, token=token, base=base, clear=clear)
    # 重填了路径说明用户想要一份干净的开始。留着旧 fingerprint 会导致
    # 「我明明重填了怎么一个都没导」——所以这里顺手把导入进度忘掉。
    if src in notesrc.FILE_SRCS:
        notesrc.reset_index(src)
    safe = dict(d)
    if safe.get("token"):
        safe["token"] = "已保存（%d 位）" % len(safe["token"])   # 不回显真 token
    st = notesrc.cfg_state(src)
    store.add_event("note_src_cfg", src, payload="path=%s token=%s" % (
        bool(d.get("path")), bool(d.get("token"))))
    return {"ok": True, "src": src, "cfg": safe,
            "connected": bool(st.get("connected")), "state": st.get("state") or "",
            "say": "%s 的凭证填好了，现在状态：%s。" % (src, st.get("state") or "未知"),
            "effect": "cfg %s -> %s" % (src, st.get("state") or ""),
            "note": u"%s：%s" % (src, st.get("state") or "")}


@tool("note_src_test", config.PERM_LOCAL, "连一下某个笔记来源，看是不是真能用")
def t_note_src_test(src=None, **_):
    """真发一次请求 / 真查一次路径。连不上就把原因原样交回去。"""
    if not src:
        return {"error": u"没说要测哪个来源"}
    r = notesrc.src_test(src)
    return r


@tool("note_src_list", config.PERM_LOCAL, "列某个笔记来源里能导入的条目")
def t_note_src_list(src=None, q=None, **_):
    """列条目。**不返回本机绝对路径**，只给相对 id 和标题。"""
    if not src:
        return {"error": u"没说要列哪个来源"}
    if src in ("local", "xmind"):
        return {"error": u"%s 不走这条路（本地画布在右侧坞里，XMind 在「来源」里）" % src}
    return notesrc.src_list(src, q)


@tool("note_src_probe", config.PERM_LOCAL,
      "扫一下本机有没有开着的 Joplin，有就把地址填好")
def t_note_src_probe(src="joplin", **_):
    """Joplin 是唯一不用注册第三方账号就能真连的云端类来源：
    桌面版自带本地 Web Clipper，开着就能读。探到了就把 base 写进配置，
    用户只剩「把 token 粘进去」这一步 —— 不用手抄端口，也不用猜是不是开错服务。"""
    if (src or "joplin") != "joplin":
        return {"ok": False, "error": u"现在只支持探测 Joplin（其它都是远端的，没有可探的东西）"}
    r = notesrc.joplin_probe()
    if r.get("ok"):
        # 探到了就把 base 存下来，省得用户照着提示手抄一遍
        notesrc.set_cfg("joplin", base=r["base"])
        store.add_event("note_src_probe", "joplin", payload="found=%s" % r["base"])
    return r


@tool("note_src_import", config.PERM_LOCAL,
      "批量/增量导入某个文件夹来源里的笔记，逐条报成败")
def t_note_src_import(src=None, since_ts=None, limit=None, lesson_id=None,
                      only=None, force=False, **_):
    """一批拉进来。force=True 忽略「上次之后没改过」的判断，全部重导。"""
    return notesrc.import_batch(src, since_ts=since_ts, limit=limit,
                                lesson_id=lesson_id, only=only, force=force)


@tool("note_src_state", config.PERM_LOCAL,
      "已连了哪些笔记文件夹、各自导了多少、上次导到什么时候")
def t_note_src_state(**_):
    return notesrc.import_state()


@tool("note_push_plan", config.PERM_LOCAL, "回写之前先说清要写到哪个文件、有没有被别人改过")
def t_note_push_plan(map_id=None, src=None, **_):
    """写在 Note src 里的画布拉进来之后还能改，改完要能送回去。
       送回去之前必须先摊开说：写哪个文件、自打拉进来之后外面改没改过。
       外界改过还硬盖 = 吃掉别人的编辑，所以这一步只报告，不写。"""
    if not map_id:
        return {"ok": False, "error": "没给画布 id", "need": "map_id"}
    row = store.get_canvas(str(map_id))
    if not row:
        return {"ok": False, "error": "本机没有这张画布（id=%s）" % map_id, "need": "map_id"}
    s = src or row.get("src")
    if not s or s == "local":
        return {"ok": False, "error": "这张画布是本机的（src=%s），没有可以写回去的外部笔记" % s}
    if s not in notesrc.FILE_SRCS:
        return {"ok": False, "error": "%s 还不支持写回去 —— 目前只有文件夹类笔记能双向同步" % s}
    d = notesrc.push_plan(s, {"src_id": row.get("src_id")})
    if not d.get("ok"):
        return d
    d["map_id"] = row.get("id")
    d["map_title"] = row.get("title")
    d["nodes"] = notesrc.count_nodes((row.get("tree") or {}))
    # 图片这笔账先摊开（开发文档 6.2）：assets 里的会跟着写回、外部引用原样带走、
    # 云端直链写回去就是死链 —— 有多少说多少，绝不假装它们能一起过去。
    d["imgs"] = notesrc.image_stats(row.get("tree") or {})
    return d


@tool("note_push_src", config.PERM_LOCAL, "把画布写回到它来自的那篇笔记里")
def t_note_push_src(map_id=None, src=None, force=False, backup=True, **_):
    if not map_id:
        return {"ok": False, "error": "没给画布 id", "need": "map_id"}
    row = store.get_canvas(str(map_id))
    if not row:
        return {"ok": False, "error": "本机没有这张画布（id=%s）" % map_id, "need": "map_id"}
    s = src or row.get("src")
    if not s or s == "local":
        return {"ok": False, "error": "这张画布是本机的（src=%s），没有可以写回去的外部笔记" % s}
    tree = row.get("tree") or {}
    d = notesrc.push_file_src(s, {"src_id": row.get("src_id")}, tree,
                              force=bool(force), backup=bool(backup))
    if d.get("ok"):
        store.add_event("note_push", str(map_id),
                        payload="src=%s file=%s force=%s" % (s, d.get("rel"), bool(force)))
        d["map_id"] = row.get("id")
        d["say"] = "写回去了：「%s」%s，%d 字节%s。" % (
            d.get("rel"), "（覆盖了原来那份）" if d.get("overwrote") else "（新建）",
            d.get("bytes") or 0, "，旧版留了 .bak" if d.get("backup") else "")
        d["effect"] = "push %s -> %s" % (map_id, d.get("rel"))
    return d


@tool("note_asset_put", config.PERM_LOCAL,
      "把一张图按哈希落进画布的资产目录（笔记旁 assets/ 或本机 data/assets），同图不重复存")
def t_note_asset_put(data=None, map_id=None, ext=None, **_):
    """画布插图的后端。规矩（开发文档 6.1）：
    - 画布挂在文件型笔记上（obsidian / logseq / markdown / opml）→
      写进「笔记文件夹/assets/」，md 里写相对引用 assets/<哈希>.<扩展名>，
      回写时原样带走 —— 这就是「怎么同步过去都保持不变」；
    - 本机画布 → data/assets/，/assets/ 路由代理出去；
    - 文件名 = 内容哈希前 20 位，同一张图存第二遍时直接复用（existed=true）。
    """
    if not data:
        return {"ok": False, "error": "没收到图片数据", "need": "data"}
    s = None
    if map_id:
        row = store.get_canvas(str(map_id))
        if not row:
            return {"ok": False, "error": "本机没有这张画布（id=%s）" % map_id, "need": "map_id"}
        s = row.get("src")
    r = notesrc.save_asset(data, src=s, ext=ext)
    if r.get("ok"):
        store.add_event("asset_put", r.get("rel") or "",
                        payload="src=%s existed=%s bytes=%s" % (s or "local", r.get("existed"), r.get("bytes")))
        r["md"] = "![图片](%s)" % r.get("rel") if s in notesrc.FILE_SRCS else "![图片](%s)" % r.get("url")
    return r


@tool("note_src_reset", config.PERM_LOCAL,
      "忘掉某个来源的导入进度（下次重扫全部）")
def t_note_src_reset(src=None, **_):
    """重填了路径之后调这个，否则旧 fingerprint 会让「重填」看起来像「没导」"""
    return notesrc.reset_index(src)


@tool("note_src_pull", config.PERM_LOCAL, "把某个来源里的一条笔记拉下来，转成导图树")
def t_note_src_pull(src=None, item=None, title=None, save=False, lesson_id=None, **_):
    """拉一条 → 转成树。save=True 就同时落库成一张画布。"""
    if not src or not item:
        return {"error": u"要同时给 src 和 item"}
    if src in ("local", "xmind"):
        return {"error": u"%s 不走这条路" % src}
    r = notesrc.src_pull(src, item, title)
    if not r.get("ok"):
        return r
    if save:
        mid = _note_id(lesson_id, src, item)
        store.save_canvas(mid, title=r.get("title") or title or item, tree=r["tree"],
                          lesson_id=lesson_id, src=src, src_id=str(item))
        store.add_event("note", mid, payload="pull %s -> %s" % (src, item))
        r["map"] = mid
        r["saved"] = True
    _n = len(r.get("nodes") or r.get("flat") or [])
    r["say"] = "从 %s 拉下来「%s」%s。%s" % (
        src, r.get("title") or title or item,
        ("，%d 个节点" % _n) if _n else "",
        ("已落库成本机画布（id=%s）。" % r["map"]) if r.get("saved")
        else "只在内存里转成了导图树，没落库 —— 要存就传 save=true。")
    r["effect"] = "pull %s/%s%s" % (src, item, " +saved" if r.get("saved") else "")
    return r


@tool("note_save", config.PERM_LOCAL, "整张画布落库（含节点树）")
def t_note_save(lesson_id=None, title=None, tree=None, src="local", src_id=None,
                map_id=None, lesson_ids=None, **_):
    """存画布。tree 整棵树原样落盘，服务端不解析不改写。

    map_id：带了就写那一张。必须支持这个参数，因为整库导入落库时用的 id 是文件
    指纹（obsidian:5ab277e9e3bc），跟 _note_id 拼出来的三元组 id 不是同一个 ——
    不给这个口子的话，用户改完从外面拉进来的图会存成另一张，原图不动，
    「推回去」推的还是老内容。前端打开哪张就存哪张，别让用户去猜。

    lesson_ids：这张画布挂到哪几讲。传 None = 不改（老调用点不受影响），
    传 [] = 明确清空。不要用 lesson_id 兼做这件事 —— 一张笔记同时属于好几讲，
    单值装不下。
    """
    if not map_id and not lesson_id and not src_id:
        return {"error": u"没给讲次也没给来源 ID，不知道这张图挂哪儿"}
    if map_id:
        mid = str(map_id)
        old_row = store.get_canvas(mid) or {}
        # 用户没传的字段从库里那行继承，别把 source / src_id 抹成空
        src = src or old_row.get("src") or "local"
        src_id = src_id if src_id is not None else old_row.get("src_id")
        if lesson_id is None:
            lesson_id = old_row.get("lesson_id")
    else:
        mid = _note_id(lesson_id, src, src_id)
    r = store.save_canvas(mid, title=title or u"未命名画布", tree=tree or {},
                          lesson_id=lesson_id, src=src, src_id=src_id,
                          lesson_ids=lesson_ids)
    if r.get("error"):
        return r
    store.add_event("note", lesson_id=lesson_id, seconds=0,
                    payload="canvas save %s src=%s" % (mid, src))
    return {"ok": True, "map": r, "count": store.canvas_count(),
            "say": "画布「%s」存下了，图库里一共 %d 张。" % (
                (r or {}).get("title") or mid, store.canvas_count()),
            "effect": "canvas %s saved" % mid,
            "lesson_ids": r.get("lesson_ids") or []}


@tool("note_del", config.PERM_CONFIRM, "删掉一张画布（只删库里的记录）")
def t_note_del(map_id=None, **_):
    """图库画布卡上那枚删除键走这里。

    写盘类，所以是 PERM_CONFIRM —— 前端第一下点亮、第二下才发，
    跟截图的 shot_del 同一套手感（那个是 PERM_LOCAL，因为盘上的图还在，摘错了能再导回来；
    画布没有盘上的副本，删了就真没了，所以这里要确认）。
    """
    if not map_id:
        return {"ok": False, "error": "没给画布 id"}
    old = store.get_canvas(map_id)
    if not old:
        return {"ok": False, "error": "图库里没有这一张"}
    k = store.del_canvas(map_id)
    if not k:
        return {"ok": False, "error": "没删掉，可能已经被删过了"}
    store.add_event("note_del", map_id)
    title = old.get("title") or ""
    say = ("画布「%s」从库里删了。盘上的原文件（如果有）没动 —— "
           "这一张是库里的记录，删了就找不回。" % (title or map_id))
    return {"ok": True, "deleted": k, "title": title,
            "say": say, "effect": "canvas %s deleted" % map_id}


@tool("note_groups", config.PERM_LOCAL, "按学科把画布分组，带每组张数与最近改动")
def t_note_groups(**_):
    """画布图库的学科 chip 行读它。

    分组依据是「挂的讲次 → 那一讲属于哪个学科」。挂不上任何讲次的归 unfiled ——
    这是合法状态（用户就是想先画再说），不是算不出来。查不到就说查不到，
    把张数照实写出来，别让那张画布在图库里消失。
    """
    rows = store.list_canvas(limit=1000)
    proto = datahub.proto()
    groups = {}
    unfiled = 0
    for r in rows:
        cls = None
        for lid in (r.get("lesson_ids") or []):
            sub, les = datahub.find_lesson(proto, lid)
            if sub:
                cls = datahub.CLS.get(sub.get("id"), "cs")
                break
        if not cls:
            unfiled += 1
            continue
        g = groups.setdefault(cls, {"cls": cls, "n": 0, "last": ""})
        g["n"] += 1
        ts = r.get("updated_ts") or ""
        if ts > g["last"]:
            g["last"] = ts
    # 科目名从 subjects 里取，取不到就用 cls 本身 —— 不编一个好听的名字
    name_of = {}
    for s in (proto.get("subjects") or []):
        name_of[datahub.CLS.get(s.get("id"), "cs")] = s.get("name") or s.get("id")
    out = []
    for cls, g in groups.items():
        out.append({"cls": cls, "name": name_of.get(cls, cls),
                    "n": g["n"], "last": g["last"]})
    out.sort(key=lambda x: (-x["n"], x["cls"]))
    return {"groups": out, "unfiled": unfiled, "total": len(rows),
            "note": (u"未挂讲次的有 %d 张 —— 它们不在任何学科下，不是因为算不出来。" % unfiled)
            if unfiled else u"每张画布都挂在某个学科下。"}


@tool("note_load", config.PERM_LOCAL, "取一张画布（含节点树）")
def t_note_load(lesson_id=None, src="local", src_id=None, **_):
    mid = _note_id(lesson_id, src, src_id)
    d = store.get_canvas(mid)
    if not d:
        return {"ok": True, "exists": False, "map": None, "tree": {},
                "note": u"这一讲还没有画布，点「新建画布」就有"}
    return {"ok": True, "exists": True, "map": d, "tree": d.get("tree") or {}}


@tool("note_open", config.PERM_LOCAL, "按画布 id 打开一张已经存过的画布")
def t_note_open(map_id=None, **_):
    """给「按 id 打开」用的：note_load 走的是 (讲次, 来源, 来源 id) 三元组，
       而整库导入回来的画布 id 里带了文件指纹，前端拼不出那个三元组，
       只能按 id 直接取。没有就明说没有，不返回一棵假树。"""
    if not map_id:
        return {"ok": False, "error": "没给画布 id", "need": "map_id"}
    d = store.get_canvas(str(map_id))
    if not d:
        return {"ok": False, "error": "本机没有这张画布（id=%s）" % map_id,
                "need": "map_id"}
    return {"ok": True, "exists": True, "map": d, "tree": d.get("tree") or {}}


@tool("note_list", config.PERM_LOCAL, "列画布（可按讲次 / 来源过滤）")
def t_note_list(lesson_id=None, src=None, limit=100):
    rows = store.list_canvas(lesson_id=lesson_id, src=src, limit=limit)
    now_ts = store.now()
    for r in rows:
        r["age"] = _ago(r.get("updated_ts"), now_ts)
        # 卡片上那张小图必须真是这张画布的结构，不能画假图。
        # 但列表一屏可能有几十张，也不能把整棵树吐给前端，
        # 所以只给前 3 层、最多 16 个节点的骨架（首 7 字 + 子节点）。
        full = store.get_canvas(r.get("id")) or {}
        r["shape"] = _shape(full.get("tree"))
        # 卡上「24 节点」必须是真的节点数：顺手在已经取到的整棵树上数一遍，
        # 不多查一次库。数不出来（树坏了）就留 None，界面显示占位 —— 不编。
        # 用现成的 _count_nodes（上面 note_pull_xmind 也在用它）——
        # 顺手在已经取到的整棵树上数一遍，不多查一次库。树坏了就是 0。
        r["nodes"] = _count_nodes(full.get("tree"))
    return {"maps": rows, "count": len(rows), "total": store.canvas_count()}



def _shape(tree, depth=0, budget=None):
    """把树压成缩略图骨架。

    卡片上那张小图必须真是这张画布的结构（项目铁律：派生不出的数字/图形一律不编），
    但 list 一次可能有几十张，不能把每棵树原样吐给前端。
    所以只取前 3 层、总共最多 16 个节点，每个节点只留首 7 个字 + 是否有色 + 子节点。
    """
    if budget is None:
        budget = [16]
    if not isinstance(tree, dict):
        return None
    budget[0] -= 1
    if budget[0] < 0:
        return None
    kids = []
    if depth < 2:
        for c in (tree.get("children") or []):
            if budget[0] < 0:
                break
            k = _shape(c, depth + 1, budget)
            if k:
                kids.append(k)
    txt = str(tree.get("text") or "").strip()
    return {"t": txt[:7], "c": kids,
            "k": 1 if (tree.get("children") or []) else 0,
            "col": tree.get("color") or ""}


def _ago(ts, now_ts=None):
    """把时间戳说成人话：刚 / N 分钟前 / N 小时前 / N 天前 / 日期。"""
    if not ts:
        return ""
    try:
        t = dt.datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return str(ts)[:10]
    n = now_ts or store.now()
    try:
        base = dt.datetime.strptime(n[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return str(ts)[:10]
    sec = (base - t).total_seconds()
    if sec < 90:
        return u"刚"
    if sec < 3600:
        return u"%d 分钟前" % int(sec / 60)
    if sec < 86400:
        return u"%d 小时前" % int(sec / 3600)
    if sec < 86400 * 7:
        return u"%d 天前" % int(sec / 86400)
    return str(ts)[:10]


@tool("note_from_md", config.PERM_LOCAL, "把一段 Markdown 转成导图树")
def t_note_from_md(text=None, title=None, **_):
    """Markdown → 树。解析逻辑在 notesrc.md_tree，这里只转发。

    规则：`#` 一级标题做主干，缩进列表做分支，其余正文进对应节点的备注。
    代码围栏里的内容不当标题解析。
    """
    return notesrc.md_tree(text, title)


def call(name, args=None, confirmed=False, progress=None):
    """统一入口：计时、审计、兜异常。

    progress：一个回调，工具在慢活里每做完一小步就调一次 tools.tick()，
    回调收到 {"msg": "...", "n": 3, "total": 6}。没有监听方（正常对话、脚本、测试）
    就是空操作 —— 不因为没人看就少干活，也不因为没人看就报假进度。
    """
    ent = REGISTRY.get(name)
    if not ent:
        return {"ok": False, "error": "未知工具: %s" % name,
                "tool": name, "perm": None, "ms": 0, "ts": store.now(), "data": {}}
    t0 = time.time()
    # 权限档在这里生效：ask 要人点头 / auto 直接放行 / readonly 一律挡住。
    # 档位本身只能由人改（perm.set_mode 不在工具注册表里），模型拧不大自己的权限。
    _pm = perm.mode()
    if ent["perm"] == config.PERM_CONFIRM and not confirmed and _pm == "readonly":
        ms = int((time.time() - t0) * 1000)
        store.log_tool(name, ent["perm"], json.dumps(args or {}, ensure_ascii=False)[:400],
                       False, ms, "只读档：写操作被挡")
        return {"ok": False, "blocked": True, "tool": name, "perm": ent["perm"],
                "ms": ms, "ts": store.now(), "data": {},
                "error": "现在是「只看不改」档，改本机的操作被挡住了。"
                         "要改就去设置里把权限档换成「先问我」或「完全信任」。"}
    if ent["perm"] == config.PERM_CONFIRM and not confirmed and _pm == "ask":
        ms = int((time.time() - t0) * 1000)
        store.log_tool(name, ent["perm"], json.dumps(args or {}, ensure_ascii=False)[:400],
                       False, ms, "等待用户确认")
        return {"ok": False, "need_confirm": True, "tool": name, "perm": ent["perm"],
                "desc": ent["desc"], "ms": ms, "ts": store.now(),
                "error": "这个工具会写盘，需要你确认后才执行", "data": {}}
    try:
        _PROG.cb = progress
        try:
            data = ent["fn"](**(args or {})) or {}
        finally:
            _PROG.cb = None
        ok = not data.get("error")
        # 有些工具（bili_verify、bili_search…）的业务失败写在 data["ok"]=False
        # 和 data["reason"] 里，没有 error 键 —— 原来会被包成 ok:true，
        # 模型看到第一句是 "ok": true 就当成了成功，回头把 "code=-404" 当事实用。
        if ok and data.get("ok") is False:
            ok = False
            if not data.get("error"):
                data["error"] = str(data.get("reason") or "工具自己判定这次没成")
        # 工具的 data.note 是给界面看的一句话，别当审计 note（类型不一定是字符串）
        note = data.get("note") if isinstance(data.get("note"), str) else None
    except Exception as e:  # 工具内部异常不外泄
        data = {"error": "%s: %s" % (type(e).__name__, e)}
        ok, note = False, "工具内部异常"
    ms = int((time.time() - t0) * 1000)
    _ensure_report(name, data, ok)
    store.log_tool(name, ent["perm"], json.dumps(args or {}, ensure_ascii=False)[:400],
                   ok, ms, note)
    return {"ok": ok, "tool": name, "perm": ent["perm"], "desc": ent["desc"],
            "ms": ms, "ts": store.now(), "data": data}


# ------------------------------------------------------------------ 接手一个空白的人
# 这七个工具是同一条流水线的动作，不是一个聊天框。
# 顺序是硬约束：start 只跑到「翻本机有什么」，后面每一站都要用户点一次才往下走 ——
# 因为中间每一站都可能需要他补一句话，抢着跑完就等于替他决定。
@tool("intake_start", config.PERM_LOCAL, "从零接手一件备考的事（要考什么、哪天考、每天多久都不知道时用）。已经聊过、只是要改某个数字的话别用它，直接调 plan_set_budget")
def t_intake_start(text=None, files=None, **_):
    """files 只收名字：本机没有视觉模型，读不了图里的字。收了就如实说只读了文件名。"""
    if not text or not str(text).strip():
        return {"ok": False, "reason": "说一句话再开始，例如「我想考专升本，2027 年 3 月 15 号」。"}
    return intake.start(str(text).strip(), files=files or [])


@tool("intake_step", config.PERM_LOCAL, "接手流水线往前走一站：去外面搜课程 → 核对分集数与总时长 → 拟计划")
def t_intake_step(**_):
    """一次推一站。前端照着 stages[i].status 画进度，画的是真进度，不是假动画。"""
    return intake.step()


@tool("intake_state", config.PERM_LOCAL, "看接手流水线现在走到哪一站了（刷新页面也能接上）")
def t_intake_state(**_):
    s = intake.load()
    if not s:
        return {"ok": True, "state": None,
                "note": "还没开始过。这一页本来就是空的 —— 空的含义是等你说第一句话。"}
    return {"ok": True, "state": s}


@tool("intake_reply", config.PERM_LOCAL, "补一句流水线问你的话：考试日期 / 每天学多久 / 考什么目标")
def t_intake_reply(field=None, value=None, text=None, **_):
    return intake.reply(field=field, value=value, text=text)


@tool("intake_pick", config.PERM_LOCAL, "从搜到的候选课程里挑要学的（一条都不勾就是都不学）")
def t_intake_pick(bvids=None, **_):
    return intake.pick(bvids=bvids or [])


@tool("intake_apply", config.PERM_CONFIRM, "认下这份计划：写进预算，排到课表")
def t_intake_apply(**_):
    """写盘走确认：改的是他的考试日期和每天时长。"""
    return intake.apply()


@tool("intake_reset", config.PERM_LOCAL, "忘掉这次接手，回到空白")
def t_intake_reset(**_):
    return intake.reset()


@tool("bili_search", config.PERM_NET, "去 B 站搜课：只返标题 / UP / 播放 / 时长 / BV 号")
def t_bili_search(keyword=None, limit=12, **_):
    """找课的第一枪。不下载、不转存，只把候选摆出来。"""
    if not keyword or not str(keyword).strip():
        return {"ok": False, "reason": "给个词再搜，例如「专升本 高数」。"}
    r = bili.search(str(keyword).strip(), limit=int(limit or 12))
    if isinstance(r, dict) and r.get("items"):
        _n = len(r["items"])
        _h = sum((it.get("secs") or 0) for it in r["items"]) / 3600.0
        r["say"] = ("在 B 站搜到 %d 门「%s」，合起来 %.1f 小时。都是候选 —— "
                    "时长/集数没核过，要入库先核一遍。" % (_n, keyword, _h))
        r["effect"] = "%d candidates" % _n
    return r


@tool("web_search", config.PERM_NET,
      "去全网搜（B 站视频 + 网页/教程/文章），要什么都先搜一次，别凭记忆说没有")
def t_web_search(keyword=None, limit=8, kind=None, **_):
    """一个入口把「外面有什么」摆出来。

    分两路：视频走 B 站（bv 号能直接拿来讲），网页走 Bing / DuckDuckGo。
    哪一路挂了不影响另一路 —— 返回里分别报，不假装都成功。
    """
    kw = str(keyword or "").strip()
    if not kw:
        return {"ok": False, "reason": "给个词再搜，例如「C 语言 专升本」。"}
    n = max(1, min(20, int(limit or 8)))
    want = str(kind or "all").lower()
    out = {"ok": True, "keyword": kw, "channels": {}}

    if want in ("all", "video", "bili", "b站"):
        try:
            v = bili.search(kw, limit=n)
            items = v.get("items") or []
            out["channels"]["video"] = {
                "ok": bool(v.get("ok")), "reason": v.get("reason"),
                "n": len(items),
                "items": [{"bvid": it.get("bvid"), "title": it.get("title"),
                           "up": it.get("up"), "play": it.get("play"),
                           "secs": it.get("secs"),
                           "hours": round((it.get("secs") or 0) / 3600.0, 1)}
                          for it in items],
                "note": "这些只是候选，课时长/集数没核过。要当成能学完的课，先 bili_verify。"}
        except Exception as e:
            out["channels"]["video"] = {"ok": False, "reason": str(e)[:200]}

    if want in ("all", "web", "page", "网页"):
        try:
            out["channels"]["web"] = websearch.search(kw, limit=n)
        except Exception as e:
            out["channels"]["web"] = {"ok": False, "reason": str(e)[:200]}

    ch = out["channels"]
    out["ok"] = any(bool((c or {}).get("ok")) for c in ch.values()) or not ch
    out["note"] = ("视频 %d 条，网页 %d 条。都是候选，没核过。"
                   % (len((ch.get("video") or {}).get("items") or []),
                      len((ch.get("web") or {}).get("items") or [])))
    return out


@tool("web_fetch", config.PERM_NET, "把一条搜索结果打开读正文（剥掉标签的纯文本）")
def t_web_fetch(url=None, max_chars=6000, **_):
    if not url:
        return {"ok": False, "reason": "给一个 http/https 地址。"}
    return websearch.fetch(str(url), max_chars=int(max_chars or 6000))


@tool("bili_verify", config.PERM_NET, "核一份课：分集数与总时长两项都对得上才算数")
def t_bili_verify(bvid=None, **_):
    """为什么非要核：B 站上标题写着「2027 全程班」实际只有 3 P 的课一抓一把。
    交叉核对只查两件能查的事 —— 分集数、总时长。对不上就扔，宁可少一个结果。"""
    if not bvid or not str(bvid).strip().upper().startswith("BV"):
        return {"ok": False, "reason": "给一个 BV 号。"}
    # 别 upper 整串：BV 号后 10 位是 base58，大小写变了就是另一个号，
    # view 直接回 code=-404。规范化统一交给 bili.norm_bv。
    tick("问这条课的基本信息（view）", n=1, total=2)
    r = bili.verify(str(bvid).strip())
    tick("对分集表与总时长", n=2, total=2)
    if isinstance(r, dict) and r.get("pages"):
        if r.get("ok"):
            r["say"] = "核过了：%s —— %d P / %.1f 小时，分集数和总时长两边对得上，可以入库。" % (
                r.get("title") or bvid, r.get("pages") or 0, r.get("hours") or 0)
        else:
            r["say"] = "这项对不上，先别入库：%s。%s（%d P / %.1f 小时）" % (
                r.get("reason") or "核对失败", r.get("title") or bvid,
                r.get("pages") or 0, r.get("hours") or 0)
        r["effect"] = "%s: %dP %.1fh %s" % (
            bvid, r.get("pages") or 0, r.get("hours") or 0,
            "ok" if r.get("ok") else "mismatch")
    return r

@tool("bili_pages", config.PERM_NET, "取一份课的分集表：每 P 的序号、标题、时长")
def t_bili_pages(bvid=None, limit=60, **_):
    """模型要知道「每天看第几集」就得有这张表。
    hint 里写着 bili_pages 却没有这个工具，等于教它去调一个不存在的东西 —— 实测它为此白转了三轮。"""
    if not bvid or not str(bvid).strip().upper().startswith("BV"):
        return {"ok": False, "reason": "给一个 BV 号。"}
    pg = bili.pages(str(bvid).strip())
    rows, err = pg if isinstance(pg, tuple) else (pg, None)
    if err:
        return {"ok": False, "reason": err}
    rows = rows or []
    keep = [{"p": x.get("page"), "t": (x.get("part") or "")[:40],
             "min": round((x.get("secs") or 0) / 60.0, 1)} for x in rows[:int(limit or 60)]]
    return {"ok": True, "bvid": bvid, "total": len(rows),
            "total_min": round(sum((x.get("secs") or 0) for x in rows) / 60.0, 1),
            "say": "这条课一共 %d 集，合计 %.1f 小时。" % (
                len(rows), sum((x.get("secs") or 0) for x in rows) / 3600.0),
            "effect": "%d pages" % len(rows),
            "pages": keep}


# ------------------------------------------------------------------ 能力清单
# 模型的处境：它看不见工具名（120 个全塞进提示词会烧光预算、还会挑不准），
# 索引（find_tool 的检索）又聋 —— 「搜资料」「去网上找」「找个课」都搜不到。
# 于是它以为自己只有「本机那点东西」，用户说「我想学 C 语言」，它只会答「本机没有」。
# 那张分类表才是它缺的东西：按「你要干什么」分堆，配上触发词。
# 这张表放在代码里而不是塞进提示词，是因为它得**可测** —— 有断言盯着
# 「每个工具都归了类」「触发词都能指到真工具」，写漏一个当场失败。
CATS = [
    ("找资料·联网", "用户要什么本机没有 —— 想学某门课、想找教程、想找真题，第一反应是出去搜，不是告诉他「没有」",
     ["想学", "找课", "搜课", "搜课程", "网上搜", "去网上找", "去搜", "搜一下", "搜索", "搜资料", "找资料",
      "资料", "教程", "考纲", "真题下载", "找视频", "视频课", "网课", "公开课", "b站", "B站",
      "有没有资源", "找点东西学", "学什么", "培训", "网上有没有",
      "找一门", "找几个", "找点", "哪里有", "去哪找", "网上有", "视频教程", "找一下", "推荐课",
      "找课", "课", "搜", "找"],
     ["web_search", "web_fetch", "bili_search", "bili_verify", "bili_pages", "search_all"]),

    ("接手·从零开始", "用户说了考试目标 / 日期 / 每天多久，要从零给他接住",
     ["专升本", "接一下", "从零开始", "帮我规划", "接手", "考什么", "报考"],
     ["intake_start", "intake_step", "intake_state", "intake_reply", "intake_pick", "intake_apply", "intake_reset"]),

    ("计划·预算·课表", "算离考试几天、每科能吃到第几讲、今天学什么",
     ["计划", "排计划", "排课", "课表", "剩几天", "够不够", "砍掉", "安排", "今天学什么", "这周", "每天多久", "预算"],
     ["plan_today", "plan_budget", "plan_set_budget", "plan_week", "pick_next_task",
      "plan_from_sentence", "intent_parse", "lesson_play_time", "today_summary"]),

    ("看本机有什么", "用户问「我这儿现在有什么 / 学到哪了」",
     ["有哪些", "有什么", "目录", "讲次", "课程库", "学到哪", "进度", "家底", "总览", "统计",
      "入库", "加进课程库", "加进来", "存下来", "落库", "记下来"],
     ["list_subjects", "list_lessons", "get_current_lesson", "list_lesson_content",
      "list_lesson_words", "lesson_play_time", "stats_overview", "checkin_calendar",
      "recent_tool_calls", "course_add"]),

    ("上课·记播放", "选讲次、上报看到哪、标记看完",
     ["上课", "选讲", "继续听课", "记一下进度", "看到哪了", "看完", "打卡"],
     ["pick_lesson", "log_playback", "mark_lesson_done", "finish_lesson", "sync_xuecheng"]),

    ("刷题·判分·错因", "做题、判分、看错在哪",
     ["刷题", "做题", "练习", "判分", "对答案", "错题", "错因", "错哪", "考试",
      "出题", "ai出题", "生成题", "给我出几道", "按考点出题"],
     ["list_item_sources", "pick_question_part", "make_quiz", "grade_answer",
      "analyze_errors", "list_errors", "tag_error", "error_tag_stats",
      "quiz_gen"]),

    ("真题卷", "整套真题卷：有哪些、取卷、交卷、历史得分；网上找卷拉进来",
     ["真题", "真题卷", "整套卷子", "模拟卷", "交卷", "考了多少分", "历年卷",
      "找卷子", "找真题", "拉一套卷", "网上的真题", "试卷资源"],
     ["list_exam_papers", "get_exam_paper", "submit_exam", "exam_scores",
      "paper_search", "paper_pull", "paper_drop"]),

    ("背单词", "背词、复习、错词本、生词本、词量目标",
     ["背单词", "背词", "单词", "复习", "错词", "生词", "词量", "打卡", "记单词", "词汇",
      "词书", "词表", "单词表", "专升本词汇", "考研词汇", "四级词汇", "换一本词书", "拉取单词"],
     ["review_today", "list_word_group", "grade_word", "word_plan", "word_goal",
      "list_wrong_words", "list_star_words", "star_word", "add_words_to_review",
      "resolve_vocab_group", "pick_word_mode", "fetch_word_detail", "word_sentences",
      "fav_sentence", "list_fav_sentences", "cache_asset",
      "vocab_books", "vocab_pull", "vocab_library"]),

    ("讲题·核对", "把一道题讲清楚，并回头核对讲得对不对",
     ["讲题", "这道题", "为什么错", "讲讲", "解释一下", "准确率", "讲得对不对"],
     ["explain_question", "rate_explain", "explain_coverage", "explain_stats", "ask_ai"]),

    ("作文", "作文题单、批改、我写过的",
     ["作文", "写作", "批改", "作文题"],
     ["writing_list", "writing_grade", "writing_mine"]),

    ("题源导入", "用户手里有自己的题库，要导进来",
     ["导入", "导入题库", "我自己的题", "换题库", "删掉题库"],
     ["source_import", "source_drop"]),

    ("出题·组卷", "AI 出题、按弱项练、组一套能交卷的卷子",
     ["出题", "出几道", "给我出题", "组卷", "组一套", "模拟卷", "模考",
      "弱项", "哪块最差", "薄弱"],
     ["quiz_gen", "weak_points", "paper_make"]),

    ("模型接入", "用户问「你现在用的是哪个模型 / 能不能换一家 / 我自己填 API」",
     ["模型", "换模型", "哪家模型", "接模型", "key", "apikey", "登录态", "能不能用",
      "填api", "自己的api", "base_url", "填key", "api地址"],
     ["ai_providers", "ai_use", "ai_probe", "ai_models", "ai_login", "ai_refresh", "ai_forget",
      "ai_apikey_set", "ai_apikey_clear", "ai_presets", "ai_models_probe"]),

    ("笔记·画布", "导图、笔记、截图、笔记来源导入",
     ["笔记", "画布", "导图", "思维导图", "截图", "xmind", "joplin", "整理成图",
      "登录xmind", "连xmind", "xmind登录", "xmind断开"],
     ["note_list", "note_open", "note_save", "note_load", "note_from_md",
      "save_note", "get_note",
      "xmind_connect", "xmind_disconnect",
      "xmind_list_maps", "xmind_read_map", "note_pull_xmind", "note_push_xmind",
      "shot_list", "shot_save", "shot_tag", "shot_rename", "shot_del", "shot_disk", "shot_gc",
      "note_sources", "note_src_list", "note_src_import", "note_src_state",
      "note_src_pull", "note_push_src", "note_push_plan",
      "note_src_cfg", "note_src_test", "note_src_probe", "note_src_reset"]),

    ("备份·同步", "备份这台机器的学习库、换机器接着学、或把整个平台清空重来",
     ["备份", "恢复", "同步", "换电脑", "导出数据", "另一台机器",
      "清空", "清空平台", "重置", "重来", "删掉所有数据"],
     ["make_backup", "list_backups", "restore_backup", "platform_reset",
      "sync_push", "sync_pull", "sync_peers", "sync_status"]),

    ("权限·这台机器", "用户问「现在改东西要不要我点确认 / 能不能直接改」",
     ["权限", "要确认吗", "能不能直接改", "信任"],
     ["perm_state"]),

    ("对话·助手自身", "换思考强度、看聊过什么、清空对话",
     ["清空对话", "聊过什么", "思考强度", "想细一点", "快一点"],
     ["agent_turn", "agent_resume", "agent_effort", "agent_history", "agent_reset",
      "agent_info"]),
]


def catalog(where=None):
    """给模型看的「你能干什么」。按类分堆，每类带触发词和工具名。

    where 给一个词时只回相关的几类（按类名/触发词/工具名/描述匹配），
    全给也没关系 —— 16 类大概 2500 字，比 120 行 schema 便宜得多。
    """
    rows = []
    for cid, why, keys, names in CATS:
        if where:
            hay = (cid + " " + why + " " + " ".join(keys) + " " + " ".join(names)).lower()
            if str(where).lower() not in hay and not any(
                    str(where) in k or k in str(where) for k in keys if len(k) >= 2):
                continue
        rows.append({"cat": cid, "why": why, "keys": keys[:8], "tools": names})
    return rows


# 按页面收窄能力清单（2026-10-24）。
# 实测：全量 16 类 = 2799 字，占系统提示 7439 字的 38%。
# 收窄到「核心 4 类 + 本页 1~3 类」≈ 1200 字，省下来的不是一点点。
# 但**不能收得太狠**：模型看不到某类工具，就会以为自己没这个本事（踩过）。
# 所以其余类在末尾用一行点名，并明确让它 find_tool 现查。
CORE_CATS = ("接手·从零开始", "计划·预算·课表", "看本机有什么", "找资料·联网")
FOCUS_CATS = {
    "today": ("计划·预算·课表", "接手·从零开始"),
    "classroom": ("上课·记播放", "讲题·核对", "看本机有什么"),
    "courses": ("看本机有什么", "题源导入", "找资料·联网"),
    "schedule": ("计划·预算·课表",),
    "vocab": ("背单词",),
    "practice": ("刷题·判分·错因", "讲题·核对"),
    "exam": ("真题卷",),
    "stats": ("计划·预算·课表", "备份·同步"),
    "writing": ("作文",),
    "canvas": ("笔记·画布",),
    "agent": ("模型接入", "备份·同步", "权限·这台机器"),
}


def catalog_text(where=None, focus=None):
    """把能力清单拼成给模型读的一段字。没工具的工具名会被标出来（写错要能看见）。

    where 是「按关键词查」（find_tool 用）；focus 是「按当前页面收窄」（系统提示用）。
    两个都没给就是全量。
    """
    rows = catalog(where)
    if not rows:
        rows = catalog()
    want = None
    if not where and focus:
        want = []
        for c in list(CORE_CATS) + list(FOCUS_CATS.get(str(focus), ())):
            if c not in want:
                want.append(c)
        if want:
            rows = [r for r in catalog() if r["cat"] in want]
    out = []
    for r in rows:
        bad = [n for n in r["tools"] if n not in REGISTRY]
        nm = "、".join(n for n in r["tools"] if n in REGISTRY)
        out.append("%s —— %s\n  用这些：%s\n  用户大概会说：%s"
                   % (r["cat"], r["why"], nm or "（无）", "、".join(r["keys"])))
        if bad:
            out.append("  （表里这几个名字不存在，忽略：%s）" % "、".join(bad))
    if want:
        rest = [r["cat"] for r in catalog() if r["cat"] not in want]
        if rest:
            out.append("\n其余能力这次没展开（要用就 find_tool 现查，别因为没有就说没有）：%s"
                       % "、".join(rest))
    return "\n".join(out)


# ------------------------------------------------------------------ 对话 agent
# 这四个不是「流程的四步」，是**一个能聊的助手**的四个动作：
#   说话（agent_turn）、查自己有哪些本事（find_tool 已在 agent 内部用）、
#   看聊过什么（agent_history）、把这段忘掉（agent_reset）。
# 真正的工具调用走 tools.call —— 也就是这个文件里的全部 113 个，一个不少。
@tool("agent_turn", config.PERM_NET, "跟助手说一句话：它自己决定要不要调工具")
def t_agent_turn(text=None, confirmed=None, focus=None, **_):
    """confirmed 形如 {tool, args}，是人刚点过「确认」的那一步。"""
    return agent.turn(text, confirmed=confirmed, focus=focus)


@tool("agent_resume", config.PERM_NET,
      "它上次没干完的活接着干完（不用人再说一遍「继续」）")
def t_agent_resume(**_):
    """上一轮撞到工具次数上限、半路停下时用它续跑。

    人看到的是「怎么停了」——他不想再打一遍「继续」。所以接着最后那句话再跑一轮，
    但系统提示换成「你已经查过了，接着往下走」。"""
    return agent.resume()


@tool("agent_history", config.PERM_LOCAL, "看这个助手跟你聊过什么（存在本机）")
def t_agent_history(limit=40, **_):
    return agent.history(limit=int(limit or 40))


@tool("session_list", config.PERM_LOCAL, "列出本机的会话（左侧那栏读它）")
def t_session_list(limit=60, include_archived=False, **_):
    # 升级上来的第一次：kv 里有旧对话、sessions 里还空 —— 先把它转成一条会话，
    # 否则界面上「有历史但没有会话」，切一下就把旧的丢在看不见的地方。
    if not str(store.kv_get(agent.KV_CUR) or "") and \
            not store.session_list(limit=1, include_archived=True):
        agent.migrate_legacy_thread()
    rows = store.session_list(limit=int(limit or 60), include_archived=bool(include_archived))
    return {"ok": True, "current": str(store.kv_get(agent.KV_CUR) or ""),
            "n": len(rows), "sessions": rows}


@tool("session_new", config.PERM_LOCAL, "开一条新会话（换话题时用，旧的留着）")
def t_session_new(title=None, focus=None, **_):
    sid = store.session_new(focus=focus, title=title)
    store.kv_set(agent.KV_CUR, sid)
    return {"ok": True, "id": sid,
            "say": "新会话开好了（%s）。原来那条还在会话列表里，随时能切。"
                   % (title or sid),
            "effect": "new session %s" % sid,
            "note": "新会话开好了，聊吧。"}


@tool("session_switch", config.PERM_LOCAL, "切到另一条会话（原来的轨迹一条不丢）")
def t_session_switch(sid=None, **_):
    return agent.switch_session(sid)


@tool("session_events", config.PERM_LOCAL, "一条会话的完整过程（按 seq 回放，含思考与工具）")
def t_session_events(sid=None, since_seq=0, limit=2000, **_):
    sid2 = str(sid or store.kv_get(agent.KV_CUR) or "")
    if not sid2:
        return {"ok": False, "error": "没有当前会话"}
    ev = store.ev_list(sid2, since_seq=int(since_seq or 0), limit=int(limit or 2000))
    return {"ok": True, "id": sid2, "n": len(ev), "events": ev}


@tool("session_search", config.PERM_LOCAL, "按内容搜会话（说过的话、它回的正文、搜到的结果都算）")
def t_session_search(q=None, limit=30, **_):
    rows = store.session_search(str(q or ""), limit=int(limit or 30))
    return {"ok": True, "q": q, "n": len(rows), "sessions": rows}


@tool("session_fork", config.PERM_LOCAL, "从某条会话的某一步分叉出一条新的（原来的不动）")
def t_session_fork(sid=None, upto_turn=None, title=None, **_):
    src = str(sid or store.kv_get(agent.KV_CUR) or "")
    r = store.session_fork(src, upto_turn=upto_turn, title=title)
    if not r:
        return {"ok": False, "error": "没这条会话：%r" % (src,)}
    return {"ok": True, "id": r["id"], "from": r["from"], "events": r["events"],
            "note": "分叉好了，原来的那条没动。要切过去就调 session_switch。"}


@tool("session_archive", config.PERM_LOCAL, "把一条会话归档（不删，列表里默认不显示）")
def t_session_archive(sid=None, undo=False, **_):
    sid2 = str(sid or store.kv_get(agent.KV_CUR) or "")
    if not store.session_get(sid2):
        return {"ok": False, "error": "没这条会话"}
    store.session_archive(sid2, flag=not undo)
    return {"ok": True, "id": sid2, "archived": not undo,
            "say": "%s（没删，只是列表里默认不显示）。" % (
                "归档了这条会话" if not undo else "把这条会话从归档里捞回来了"),
            "effect": "archive=%s" % (not undo)}


@tool("agent_reset", config.PERM_CONFIRM, "把对话记录清掉，从新的开始（要点两次）")
def t_agent_reset(**_):
    """清掉就没了，不可恢复 —— 所以跟 restore_backup 一样要二次确认。

    踩过：为了复现一个 bug 连着调了两次，把用户正聊着的四轮会话清掉了。
    清之前先把旧会话留在 `agent.thread.bak`（只留最近这一份），真误触了还能捞回来。
    """
    r = agent.reset()
    try:
        r = dict(r)
        r["note"] = ("清掉了。旧会话留了一份在 kv 的 agent.thread.bak（只留最近这一份），"
                     "真清错了可以从那儿捞回来。")
        n = r.get("kept") or 0
        r["say"] = ("对话记录清掉了（%s 条消息存在 agent.thread.bak），新会话已开。"
                    "想捞回来点「撤销清空」。" % (n if n else "0"))
        r["effect"] = "session %s" % (r.get("session") or "")
    except Exception:
        pass
    return r


@tool("agent_undo_reset", config.PERM_LOCAL,
      "上一次「清空对话」清掉的那份捞回来")
def t_agent_undo_reset(**_):
    return agent.restore_bak()


@tool("agent_effort", config.PERM_LOCAL,
      "看当前思考强度（low/medium/high），或传 level 改一下")
def t_agent_effort(level=None, **_):
    if level is None:
        return agent.effort()
    r = agent.set_effort(level)
    r = dict(r)
    r["levels"] = agent.effort()["levels"]
    return r


@tool("agent_info", config.PERM_LOCAL, "这个助手现在能用几个工具、走哪家模型")
def t_agent_info(**_):
    return agent.info()


# ---------------------------------------------------------------- 视频播放
#
# 课堂页要真能看课。走本机代理 /stream/<lesson_id>，不把 B 站直链交给前端：
#   1) 直链带签名，约 2 小时过期，前端存下来就是个会烂的地址；
#   2) 直链必须带 Referer: https://www.bilibili.com/ 才给流量，浏览器里带不了；
#   3) dash（1080P 只有 dash）音视频分离，要 ffmpeg 现场合流才播得动。
# 详见 docs/画布与课堂-开发文档.md 第 2.2 / 4.3 节。

KV_BILI_COOKIE = "bili.cookie"
KV_BILI_EXPIRES = "bili.expires_at"


def _bili_cookie():
    return store.kv_get(KV_BILI_COOKIE) or None


def _lesson_point(lesson_id):
    """lesson_id → (subject, lesson, bvid, page)。找不到就 (None, None, None, None)。"""
    try:
        proto = datahub.proto()
    except Exception:
        return None, None, None, None
    for s in proto.get("subjects") or []:
        for l in s.get("lessons") or []:
            if l.get("id") == lesson_id:
                return s, l, s.get("bvid"), int(l.get("page") or 1)
    return None, None, None, None


@tool("lesson_stream", config.PERM_NET,
      "取本讲的播放地址（走本机代理），带画质与过期时间")
def t_lesson_stream(lesson_id=None, qn=None, **_):
    if not lesson_id:
        return {"ok": False, "error": "没给讲次"}
    sub, les, bvid, pg = _lesson_point(lesson_id)
    if not les:
        return {"ok": False, "error": "本机没有这一讲：%s" % lesson_id}

    # 本地 mp4 优先：能离线看、拖进度条最快，也不吃网络
    if les.get("local"):
        return {"ok": True, "kind": "local", "src": "/media/" + str(les["local"]).lstrip("/"),
                "quality": None, "quality_name": "本地文件",
                "note": "这一讲有本地文件，不走网络"}

    if not bvid:
        return {"ok": False, "error": "这一讲没记 B 站号，播不了"}

    pgs, err = bili.pages(bvid)
    if err:
        return {"ok": False, "error": "取分集目录失败：" + err}
    hit = next((x for x in pgs if int(x.get("page") or 0) == pg), None)
    if not hit:
        return {"ok": False, "error": "这个 bvid 上没有第 %d P" % pg}

    cookie = _bili_cookie()
    want = int(qn or 64)
    tr, err = bili.track_url(bvid, hit["cid"], want, cookie=cookie)
    if err:
        # 登录态失效时先清 cookie 再试一次免登录 —— 别让页面变成一块错误
        if cookie:
            tr, err2 = bili.track_url(bvid, hit["cid"], 32, cookie=None)
            if not err2:
                return {"ok": True, "kind": tr["kind"], "src": "/stream/%s?q=%s" % (lesson_id, tr.get("quality") or 32),
                        "quality": tr.get("quality"), "quality_name": tr.get("quality_name"),
                        "kind_raw": tr["kind"], "dur_sec": tr.get("dur_sec"),
                        "expires_in": 7200, "login_lost": True,
                        "note": "登录已失效，先按 480P 播 —— 重新扫码后能到 1080P"}
        return {"ok": False, "error": err}

    return {"ok": True, "kind": tr["kind"], "src": "/stream/%s?q=%s" % (lesson_id, tr.get("quality") or 0),
            "quality": tr.get("quality"), "quality_name": tr.get("quality_name"),
            "kind_raw": tr["kind"], "dur_sec": tr.get("dur_sec"),
            "accept": tr.get("accept"), "expires_in": 7200,
            "logged_in": bool(cookie),
            "note": "直链约 2 小时过期，播放器每次打开会重新取"}


@tool("bili_login_qr", config.PERM_NET, "取一张 B 站登录二维码")
def t_bili_login_qr(**_):
    d, err = bili.qr_generate()
    if err:
        return {"ok": False, "error": err}
    return {"ok": True, **d,
            "note": "手机 B 站扫这个码确认。不读浏览器 cookie —— 各浏览器存法不一样，还会被独占锁。"}


@tool("bili_login_poll", config.PERM_NET, "查扫码状态，成功后把凭证存在本机")
def t_bili_login_poll(qrcode_key=None, **_):
    d, err = bili.qr_poll(qrcode_key)
    if err:
        return {"ok": False, "error": err}
    if d.get("ok") and d.get("cookie"):
        store.kv_set(KV_BILI_COOKIE, d["cookie"])
        store.kv_set(KV_BILI_EXPIRES, str(int(time.time()) + 180 * 86400))
        bili.clear_play_cache()
    _st = d.get("state") or ("成功" if d.get("ok") else "还在等")
    return {"ok": d.get("ok"), "code": d.get("code"), "state": _st,
            "say": ("扫码登录成好了，凭证存进本机（%d 字节，现在能看 1080P）。"
                    % len(d.get("cookie") or "")) if d.get("ok")
                   else "还没扫成，状态：%s。%s" % (
                       _st, ("%d 秒后再查。" % d.get("refresh_in")) if d.get("refresh_in") else ""),
            "effect": "bili login %s" % ("ok" if d.get("ok") else "pending"),
            "refresh_in": d.get("refresh_in"),
            "cookie_len": len(d.get("cookie") or "")}


@tool("bili_login_state", config.PERM_LOCAL, "看看现在登录没登录、还有多久过期")
def t_bili_login_state(**_):
    ck = _bili_cookie()
    exp = store.kv_get(KV_BILI_EXPIRES)
    left = None
    if exp:
        try:
            left = max(0, int(int(exp) - time.time()) // 86400)
        except Exception:
            left = None
    return {"logged_in": bool(ck), "expires_in_days": left,
            "note": ("已登录" + ("，约剩 %d 天" % left if left is not None else ""))
                    if ck else "没登录 —— 免登录只能到 480P，登录后能到 1080P"}


@tool("bili_logout", config.PERM_LOCAL, "退出登录，把本机的 SESSDATA 清掉")
def t_bili_logout(**_):
    store.kv_set(KV_BILI_COOKIE, "")
    store.kv_set(KV_BILI_EXPIRES, "")
    bili.clear_play_cache()
    return {"ok": True,
            "say": "B 站本机凭证删掉了，现在回到免登录（480P）。要看高清得重新扫码。",
            "effect": "bili cred removed",
            "note": "本机凭证已清掉，回到免登录（480P）"}


@tool("context_status", config.PERM_LOCAL,
      "这一轮上下文占了窗口多少：拼了几条、折叠了几条、窗宽多大（全是实测数）")
def t_context_status(**_):
    """回答"你还记得前面说过的吗"这类问题之前，先看一眼上下文到底怎么拼的。

    三样东西都是真数：上一次上游给的 prompt_tokens、目录给的窗宽、
    以及拼上下文时真折叠掉的条数。任何一个拿不到就写 null —— 不估。
    """
    provider = model_router.current()
    win = model_router.ctx_of(provider) or 0
    u = platform_ai.last_usage() or {}
    p = u.get("prompt_tokens")
    pct = round(p * 100.0 / win, 1) if (isinstance(p, int) and p > 0 and win) else None
    d = context.status()
    return {"ok": True, "provider": provider, "model": model_router.model_of(provider),
            "window": win or None, "last_prompt_tokens": p if isinstance(p, int) else None,
            "used_pct": pct,
            "kept": d.get("kept"), "folded": d.get("folded"),
            "tight": d.get("tight"),
            "note": ("窗口 %s，上次实测占 %s%%；拼上下文时留了 %s 条原文、折叠 %s 条。"
                     % (("%d" % win) if win else "不知道",
                        ("%.1f" % pct) if pct is not None else "?",
                        d.get("kept") if d.get("kept") is not None else "?",
                        d.get("folded") if d.get("folded") is not None else "?"))}


@tool("context_compact", config.PERM_LOCAL,
      "把上下文压到最紧：只留最近几条原文，早先的压成原话摘要（可关：on=false）")
def t_context_compact(on=True, **_):
    """压缩不是让模型自己总结 —— 摘要由本机函数从原话里摘，只丢措辞不丢数字。"""
    return agent.set_compact(bool(on))
