# -*- coding: utf-8 -*-
"""作文批改：先算能算的，再决定要不要问模型。

规矩跟 AI 讲题一致 —— 没有依据不给分。

本机（不需要模型）能算的三件事：
  1. 字数：数出来的，不达标就扣分，这条谁都驳不倒；
  2. 要点命中：题目自带 points（如「班会时间 6月3日晚8点」），学生作文里
     有没有出现对应的英文说法（题目还自带 vocab 中英对照表，按表比对）；
  3. 格式：书信/通知该有的称呼、落款行数 —— 数行数，不评好坏。

语言（语法用词）和文采这两档本机算不了，必须模型。模型没接就如实写
「这两档算不了」，绝不拿字数凑一个总分出来。
"""
import json
import os
import re

from . import config, llm, model_router, store

# 模型要输出的 JSON 形状（写死在这里，模型照着填）
JSON_SCHEMA = ('{"dims":{"content":n,"language":n,"structure":n,"richness":n},'
               '"level":"一类/二类/三类/四类","summary":"一句话总评",'
               '"errors":[{"at":"原文片段","why":"错在哪","fix":"怎么改"}],'
               '"advice":["一条建议"],"sample":"升格片段，英文 60 词内"}')

_BANK = None


def bank(force=False):
    """读作文题库。文件不在就返回空列表 —— 界面会写「没有作文题」，不伪造。"""
    global _BANK
    if _BANK is not None and not force:
        return _BANK
    p = config.WRITING_BANK
    if not os.path.exists(p):
        _BANK = []
        return _BANK
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
    except (ValueError, OSError):
        _BANK = []
        return _BANK
    _BANK = d.get("items") or []
    return _BANK


def get(pid):
    return next((x for x in bank() if x.get("id") == pid), None)


def list_papers():
    """给界面列的题单：只给客观字段，不带任何「难度」之类的主观标签。"""
    return [{"id": x.get("id"), "year": x.get("year"), "kind": x.get("kind"),
             "max_score": x.get("max_score"), "min_words": x.get("min_words"),
             "prompt": x.get("prompt"), "points": x.get("points") or [],
             "vocab": x.get("vocab") or [],
             "answered": _answered_count(x.get("id"))}
            for x in bank()]


def _answered_count(pid):
    if not pid:
        return 0
    con = store.connect()
    try:
        return con.execute("SELECT COUNT(*) c FROM writings WHERE pid=?",
                           (pid,)).fetchone()["c"]
    except Exception:
        return 0
    finally:
        con.close()


# ------------------------------------------------------------ 本机能量化的部分
def _words(text):
    """英文词数：只数连续的字母串，标点数字不算。"""
    return len(re.findall(r"[A-Za-z][A-Za-z'\u2019-]*", text or ""))


def _has(text, s):
    if not s:
        return False
    return str(s).strip().lower() in (text or "").lower()


def _vocab_pair(paper, point):
    """从题目的中英对照表里，找出这条要点要写的英文说法。

    匹配办法：要点里出现对照表左侧的中文词，就把它对应的英文当判据。
    找不到就返回 None（这条要点本机判不了，交给模型或人工）。
    """
    best, best_len = None, 0
    for pair in (paper.get("vocab") or []):
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        cn, en = pair[0], pair[1]
        if not cn or not en:
            continue
        if cn in (point or "") and len(cn) > best_len:
            best, best_len = en, len(cn)
    if best:
        return best
    m = re.findall(r"[A-Za-z][A-Za-z ]{3,}", point or "")
    return m[0].strip() if m else None


def local_check(paper, essay):
    """本机三查：字数、要点命中、格式。返回的每一项都是数出来的。"""
    n = _words(essay)
    need = int(paper.get("min_words") or 0)
    words_ok = (need <= 0) or (n >= need)

    hits, unknown = [], []
    for pt in (paper.get("points") or []):
        pair = _vocab_pair(paper, pt)
        if pair:
            hits.append({"point": pt, "expect": pair, "hit": _has(essay, pair)})
        else:
            unknown.append(pt)
    hit_n = sum(1 for h in hits if h["hit"])

    lines = [x for x in re.split(r"\n+", (essay or "").strip()) if x.strip()]
    kind = paper.get("kind") or ""
    head = bool(re.search(r"(?im)^\s*(dear\b|notice\b|to whom)", essay or ""))
    tail = bool(re.search(r"(?im)^\s*(yours\b|sincerely\b|li hua\b|students.? union\b)",
                          essay or ""))
    if kind == "议论文":
        fmt_ok = len(lines) >= 3
        fmt_note = "议论文按段落数算：%d 段（少于 3 段扣结构分）" % len(lines)
    else:
        fmt_ok = head and tail
        fmt_note = ("应用文看称呼与落款：%s / %s" %
                    ("有称呼" if head else "缺称呼", "有落款" if tail else "缺落款"))

    return {
        "words": n, "min_words": need, "words_ok": words_ok,
        "points_total": len(paper.get("points") or []),
        "points_hit": hit_n, "point_hits": hits,
        "points_unknown": unknown,
        "lines": len(lines), "fmt_ok": fmt_ok, "fmt_note": fmt_note,
    }


# ------------------------------------------------------------ 模型那一档
def _model_prompt(paper, essay, local):
    dims = ", ".join("%s(%d分)" % (d["label"], d["max"]) for d in config.WRITING_DIMS)
    pts = "\n".join("- " + str(x) for x in (paper.get("points") or []))
    body = (
        "你是广东专升本《英语基础与写作》写作部分的阅卷老师。\n"
        "题目（%s年 · %s，满分 %s 分，不少于 %s 词）：\n%s\n\n"
        "要点：\n%s\n\n"
        "学生作文：\n%s\n\n"
        "本机已经数出来的事实（这些不许改，只许引用）：\n"
        "词数 %s（要求 %s）· 要点命中 %s/%s · %s\n\n"
        "请只输出 JSON，不要任何解释文字，形状如下：\n%s\n"
        "维度满分：%s。\n"
        "errors 里的 at 必须是学生作文里真实出现过的片段，编一条整份作废。\n"
        "打分保守：拿不准就给低一档，并在 summary 里写明为什么。"
    )
    return body % (paper.get("year"), paper.get("kind"), paper.get("max_score"),
                   paper.get("min_words"), paper.get("prompt"), pts, essay,
                   local["words"], local["min_words"], local["points_hit"],
                   local["points_total"], local["fmt_note"], JSON_SCHEMA, dims)


def grade(pid, essay, use_model=None):
    """批改一篇作文。

    use_model=None 看 config.ENABLE_LLM，False 强制只出本机部分。
    返回体里 model 字段永远写实话："local"（本机算的）/ 模型名 / None（没算）。
    """
    paper = get(pid)
    if not paper:
        return {"ok": False, "error": "没有这道作文题：%s" % pid}
    essay = (essay or "").strip()
    if not essay:
        return {"ok": False, "error": "作文是空的，没什么可判的"}

    local = local_check(paper, essay)
    out = {"ok": True, "pid": pid, "year": paper.get("year"),
           "kind": paper.get("kind"), "max_score": paper.get("max_score"),
           "local": local, "model": None, "score": None, "dims": None,
           "level": None, "summary": None, "errors": [], "advice": [],
           "sample": None, "note": None}

    # 走 model_router，不走 llm：用户在界面上选了 WorkBuddy / Trae，
    # 作文批改就得跟着换那家。直连 llm 的话，选了也白选 —— 那是最难发现的一种假。
    want = True if use_model is None else bool(use_model)
    ok, why = model_router.available()
    if not want or not ok:
        out["note"] = (
            "本机只算了能数的：词数 %d（要求 %d，%s）、要点命中 %d/%d、%s。"
            "语言与文采这两档本机算不了 —— 要判就得接模型，"
            "所以这两档现在不给分，也不给总分（拿字数凑总分就是编数字）。"
        ) % (local["words"], local["min_words"],
             "达标" if local["words_ok"] else "不达标",
             local["points_hit"], local["points_total"], local["fmt_note"])
        return out

    r = model_router.chat("你是严格保守的阅卷老师，只输出 JSON。",
                 _model_prompt(paper, essay, local),
                 temperature=config.LLM_TEMPERATURE,
                 max_tokens=config.LLM_MAX_TOKENS)
    if not r.get("ok"):
        out["note"] = (
            "本机部分算完了（词数 %d · 要点 %d/%d），但模型没接上：%s。"
            "语言与文采照旧不给分。") % (local["words"], local["points_hit"],
                                    local["points_total"],
                                    r.get("reason") or "未知原因")
        return out

    # 注意 parse_json 返回的是 (obj, 错误说明) 二元组 —— 之前这里直接拿元组当
    # 字典用，于是「模型回了合法 JSON」也被判成「不是 JSON」，作文批改这条链路
    # 从来就没跑通过。模型是好的，是我们把它答的东西读错了。
    data, perr = model_router.parse_json(r.get("text") or "")
    if not isinstance(data, dict):
        out["note"] = ("模型回了东西但不是 JSON（%s），整份作废，只留本机算的部分。"
                       % (perr or "解析不出来"))
        return out

    dims = data.get("dims") or {}
    clean, total = {}, 0.0
    for d in config.WRITING_DIMS:
        v = dims.get(d["key"])
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        v = max(0.0, min(v, float(d["max"])))
        clean[d["key"]] = round(v, 1)
        total += v

    errs = []
    for e in (data.get("errors") or []):
        if not isinstance(e, dict):
            continue
        at = str(e.get("at") or "").strip()
        if not at or not _has(essay, at):
            continue
        errs.append({"at": at, "why": e.get("why"), "fix": e.get("fix")})

    out.update({
        "model": r.get("model"), "model_provider": r.get("provider"),
        "score": round(total, 1),
        "dims": clean, "level": data.get("level"),
        "summary": data.get("summary"), "errors": errs,
        "advice": [x for x in (data.get("advice") or []) if isinstance(x, str)][:5],
        "sample": data.get("sample"),
        "note": ("模型判了语言与文采；词数和要点命中是本机数出来的，模型改不了"
                 if clean else None),
    })
    if not clean:
        out["note"] = "模型没给出任何维度分，整份作废，只留本机算的部分。"
    return out
