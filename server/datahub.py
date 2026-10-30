# -*- coding: utf-8 -*-
"""研学台 · 数据中枢。

原则（沿用这个项目的老规矩）：**页面上每个数字都要能追到源头**。
- 课程 / 词表 / 题库 / 考点卡：只读复用 outputs/proto_data.json 与 workbench/data/*
- 进度、记忆状态、作答：以 SQLite 事件库为准（proto 是 18:37 的快照，早就过期了）
- 派生不出来的字段一律返回 None / 空数组，绝不填估算值
"""
import io
import json
import os
import re
import datetime as dt

from . import config, store

# 大块数据不进首屏：按需由工具取
_proto_cache = {"key": None, "data": None}
_exam_cache = {"key": None, "data": None}
_extra_cache = {"key": None, "data": None}
_vocab_cache = {"key": None, "data": None}
_card_cache = {"key": None, "data": None, "index": None, "parsed": None}

# 学科不再写死在这里。
# 以前是 TEACH_SUBJECTS = ("cs","english","math","politics","clang") + 一张 CLS 配色表，
# 后果是「换一门考试（考研 / 考编）就加不进来」—— 代码里没有那个学科的位置，
# 项目只能在专升本里打转。现在一律从数据里读：一个学科在 subjects.json 里
# 落一行，界面上就多一门课，不用改代码（见 subjects()）。
#
# 配色是按顺序轮着分配的一小圈，不是「哪个学科固定哪个颜色」：
# 一门课的颜色写在它自己的 accent 字段里（导入课程时可指定），没写才轮着给。
_ACCENT_RING = ("cs", "en", "ma", "po", "vo", "sh")


def subjects(proto_data=None):
    """所有学科，来自 proto_data.subjects（真源）。"""
    p = proto_data if proto_data is not None else proto()
    return p.get("subjects") or []


def subject_ids(proto_data=None):
    return [s.get("id") for s in subjects(proto_data)]


def cls_of(sub, index=0):
    """学科配色。优先用数据里写的 accent，没写就按位置轮流给。

    这条函数是从前 CLS 表的位置 —— 那时新学科取不到色，会一律回落成 "cs"，
    于是一门陌生的课显示成计算机的蓝色。现在回落值仍然存在，但只当作最后兜底。
    """
    if isinstance(sub, dict):
        acc = sub.get("accent")
        if acc:
            return acc
        try:
            i = subject_ids().index(sub.get("id"))
        except ValueError:
            i = index
        return _ACCENT_RING[i % len(_ACCENT_RING)]
    return _ACCENT_RING[index % len(_ACCENT_RING)]


# 兼容旧调用点：datahub.CLS.get(sid, "cs")
class _ClsMap(dict):
    def get(self, sid, default="cs"):
        sub = subject(proto(), sid)
        if not sub:
            return default
        return cls_of(sub)


CLS = _ClsMap()


def _stat_key(path):
    try:
        st = os.stat(path)
        return (int(st.st_mtime), st.st_size)
    except OSError:
        return None


def proto():
    """outputs/proto_data.json（已含 wordmap / 实测时长 / 781 题库）。按 mtime 缓存。"""
    key = _stat_key(config.PROTO_DATA)
    if _proto_cache["key"] == key and _proto_cache["data"] is not None:
        return _proto_cache["data"]
    with io.open(config.PROTO_DATA, encoding="utf-8") as f:
        data = json.load(f)
    data = _merge_courses_extra(data)
    data = _merge_vocab_extra(data)
    _proto_cache["key"] = key
    _proto_cache["data"] = data
    return data


def courses_extra():
    """用户自己挑进来、当场核过时长的课（config.COURSES_EXTRA）。读不到就当没有。"""
    key = _stat_key(config.COURSES_EXTRA)
    if _extra_cache["key"] == key and _extra_cache["data"] is not None:
        return _extra_cache["data"]
    try:
        with io.open(config.COURSES_EXTRA, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"subjects": []}
    if not isinstance(data, dict):
        data = {"subjects": []}
    data.setdefault("subjects", [])
    _extra_cache["key"] = key
    _extra_cache["data"] = data
    return data


def save_courses_extra(data):
    """写回 overlay。原子替换 —— 写一半崩掉会毁掉整份课程库。"""
    tmp = config.COURSES_EXTRA + ".tmp"
    os.makedirs(config.APP_DATA_DIR, exist_ok=True)
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, config.COURSES_EXTRA)
    _extra_cache["key"] = None
    _extra_cache["data"] = None
    _proto_cache["key"] = None
    _proto_cache["data"] = None
    return True


def _merge_courses_extra(proto_data):
    """把 overlay 里的科目并进 proto。同 id 的以 overlay 为准（用户后来挑的覆盖旧的）。"""
    extra = (courses_extra().get("subjects") or [])
    if not extra:
        return proto_data
    have = {s.get("id"): i for i, s in enumerate(proto_data.get("subjects") or [])}
    subs = list(proto_data.get("subjects") or [])
    for s in extra:
        sid = s.get("id")
        if sid in have:
            subs[have[sid]] = s
        else:
            subs.append(s)
    proto_data["subjects"] = subs
    return proto_data


def vocab_extra():
    """AI 从百词斩拉下来的词书（config.VOCAB_EXTRA）。读不到就当没有。"""
    key = _stat_key(config.VOCAB_EXTRA)
    if _vocab_cache["key"] == key and _vocab_cache["data"] is not None:
        return _vocab_cache["data"]
    try:
        with io.open(config.VOCAB_EXTRA, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"lists": []}
    if not isinstance(data, dict):
        data = {"lists": []}
    data.setdefault("lists", [])
    _vocab_cache["key"] = key
    _vocab_cache["data"] = data
    return data


def save_vocab_extra(data):
    """写回词书 overlay。原子替换，写一半崩掉会毁掉整份词表。"""
    tmp = config.VOCAB_EXTRA + ".tmp"
    os.makedirs(config.APP_DATA_DIR, exist_ok=True)
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, config.VOCAB_EXTRA)
    _vocab_cache["key"] = None
    _vocab_cache["data"] = None
    _proto_cache["key"] = None
    _proto_cache["data"] = None
    return True


def _merge_vocab_extra(proto_data, data=None):
    """把拉进来的词书并进 proto.vocab：元信息(lists) + 词条(groups_words) + 分组(by_unit)。

    只并 lists 是不够的 —— 界面按 groups_words 取词，词对不上就等于「有一本书、
    但一个词都翻不开」。三段一起并，词书才是真能用（Vocab 页能直接翻这一组）。
    同 id / 同 key 覆盖，重复拉同一本不会越并越多。
    """
    ex = data if isinstance(data, dict) else vocab_extra()
    extra = ex.get("lists") or []
    groups = ex.get("groups") or {}
    units = ex.get("units") or []
    if not (extra or groups or units):
        return proto_data
    vb = proto_data.get("vocab") or {}
    lists = list(vb.get("lists") or [])
    idx = {l.get("id"): i for i, l in enumerate(lists)}
    for l in extra:
        lid = l.get("id")
        if lid in idx:
            lists[idx[lid]] = l
        else:
            lists.append(l)
            idx[lid] = len(lists) - 1
    if groups:
        gw = dict(vb.get("groups_words") or {})
        for k, v in groups.items():
            ws = (v or {}).get("words") if isinstance(v, dict) else v
            if ws:
                gw[k] = ws
        vb["groups_words"] = gw
    if units:
        bu = [dict(u) for u in (vb.get("by_unit") or [])]
        seen = {u.get("unit"): i for i, u in enumerate(bu)}
        for u in units:
            nm = u.get("unit")
            if nm in seen:
                bu[seen[nm]] = u
            else:
                bu.append(u)
                seen[nm] = len(bu) - 1
        vb["by_unit"] = bu
    vb["lists"] = lists
    proto_data["vocab"] = vb
    return proto_data


def progress():
    """旧工作台的进度文件：sections / vocab / meta。读不到就当空。"""
    try:
        with io.open(config.PROGRESS_JSON, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"sections": {}, "vocab": {}, "meta": {}}


def exam_papers():
    """真题卷真源：workbench/data/exam_papers.json（15 套 / 995 题，每题带答案）。

    再并上 AI 从网上拉回来的卷（data/papers_extra.json）—— 只读源一个字都不改，
    拉回来的单独放一层，界面上按 origin 标清「自带 / 网上拉取」。
    """
    key = _stat_key(config.EXAM_PAPERS)
    if _exam_cache["key"] == key and _exam_cache["data"] is not None:
        return _exam_cache["data"]
    try:
        with io.open(config.EXAM_PAPERS, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"papers": []}
    data = _merge_papers_extra(data)
    _exam_cache["key"] = key
    _exam_cache["data"] = data
    return data


_paper_extra_cache = {"key": None, "data": None}


def papers_extra():
    """AI 拉回来的真题卷（config.PAPERS_EXTRA）。读不到就是空。"""
    path = getattr(config, "PAPERS_EXTRA", "")
    if not path:
        return {"papers": []}
    key = _stat_key(path)
    if _paper_extra_cache["key"] == key and _paper_extra_cache["data"] is not None:
        return _paper_extra_cache["data"]
    try:
        with io.open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"papers": []}
    if not isinstance(data, dict):
        data = {"papers": []}
    data.setdefault("papers", [])
    _paper_extra_cache["key"] = key
    _paper_extra_cache["data"] = data
    return data


def save_papers_extra(data):
    """写回拉来的卷。原子替换 + 清缓存，写一半崩掉不会毁掉整份。"""
    path = getattr(config, "PAPERS_EXTRA", "")
    if not path:
        return False
    os.makedirs(config.APP_DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    _paper_extra_cache["key"] = None
    _paper_extra_cache["data"] = None
    _exam_cache["key"] = None
    _exam_cache["data"] = None
    return True


def _merge_papers_extra(proto_data):
    """把拉来的卷并进 papers（同 id 覆盖，新的一律追加在后面）。"""
    extra = (papers_extra().get("papers") or [])
    if not extra:
        return proto_data
    papers = list(proto_data.get("papers") or [])
    idx = {p.get("id"): i for i, p in enumerate(papers)}
    for p in extra:
        pid = p.get("id")
        if not pid:
            continue
        if pid in idx:
            papers[idx[pid]] = p
        else:
            papers.append(p)
            idx[pid] = len(papers) - 1
    proto_data["papers"] = papers
    return proto_data


def point_cards():
    """考点卡真源：workbench/data/point_cards.json（cs 98 + cs 505 + 政治 613）。

    以前只从 proto_data 读到卡片**元信息**（名字/条数），题目正文一条都没进来。
    1216 条 Q/A 就躺在源文件里，练习页却只认英语语法题库 —— 这是「英语机」的主因。
    """
    key = _stat_key(config.POINT_CARDS)
    if _card_cache["key"] == key and _card_cache["data"] is not None:
        return _card_cache["data"]
    try:
        with io.open(config.POINT_CARDS, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"lists": []}
    lists = data.get("lists") or []
    _card_cache["key"] = key
    _card_cache["data"] = lists
    _card_cache["index"] = {c.get("id"): c for c in lists}
    _card_cache["parsed"] = None
    return lists


def point_card(card_id):
    point_cards()
    return (_card_cache["index"] or {}).get(card_id)


def _card_items(card_id):
    c = point_card(card_id)
    return (c or {}).get("items") or []


def exam_paper_meta():
    """卷元信息（含真实题量、真实已答/对错数），不带题目正文。"""
    state = store.exam_state_all()
    out = []
    for p in exam_papers().get("papers") or []:
        pid = p.get("id")
        st = state.get(pid) or {}
        total = sum(len(g.get("questions") or []) for g in p.get("groups") or [])
        right = len([1 for v in st.values() if v == 1])
        wrong = len([1 for v in st.values() if v == 0])
        out.append({
            "id": pid, "name": p.get("name"), "region": p.get("region"),
            "year": p.get("year"), "subject": p.get("subject"),
            "pdf": p.get("pdf"),
            "total": total or p.get("total"),
            "groups": len(p.get("groups") or []),
            "types": sorted(set(g.get("type") for g in p.get("groups") or [])),
            "answered": len(st), "right": right, "wrong": wrong,
            # 自带 / 网上拉取；网上拉的卷常常只有题没答案，界面要能标出来
            "origin": p.get("origin") or "builtin",
            "answers": p.get("answers", True),
            "source_url": p.get("source_url") or "",
            "score": (round(right * 100.0 / total, 1) if (total and st) else None),
        })
    return out


def exam_paper(paper_id, group_index=0, with_answer=False):
    p = None
    for x in exam_papers().get("papers") or []:
        if x.get("id") == paper_id:
            p = x
            break
    if not p:
        return {"error": "没有这套卷: %s" % paper_id}
    st = store.exam_state_all().get(paper_id) or {}
    groups = []
    for gi, g in enumerate(p.get("groups") or []):
        qs = []
        for q in g.get("questions") or []:
            item = {"no": q.get("no"), "orig": q.get("orig"), "stem": q.get("stem"),
                    "opts": q.get("opts"), "state": st.get(q.get("no"))}
            if with_answer:
                item["ans"] = q.get("ans")
            qs.append(item)
        groups.append({"index": gi, "type": g.get("type"), "label": g.get("label"),
                       "material": g.get("material"), "pages": g.get("material_pages"),
                       "questions": qs, "count": len(qs)})
    return {"paper": {"id": p.get("id"), "name": p.get("name"), "year": p.get("year"),
                      "pdf": p.get("pdf"), "total": sum(g["count"] for g in groups)},
            "group_index": int(group_index),
            "group": groups[int(group_index)] if groups else None,
            "groups": [{"index": g["index"], "label": g["label"], "type": g["type"],
                        "count": g["count"]} for g in groups],
            "answered": len(st)}


def exam_question(paper_id, no):
    for p in exam_papers().get("papers") or []:
        if p.get("id") != paper_id:
            continue
        for g in p.get("groups") or []:
            for q in g.get("questions") or []:
                if str(q.get("no")) == str(no):
                    return p, g, q
    return None, None, None


def exam_paper_shape(paper_id):
    """一套卷的题型构成：[{type,label,questions:[no...],judgeable}]，评分口径用。

    没答案的卷（AI 从网上拉的常见情况）一律 judgeable=False ——
    不然「没答案」会被算成「全错」，考完给个 0 分，是最坑人的假分数。
    """
    out = []
    for p in exam_papers().get("papers") or []:
        if p.get("id") != paper_id:
            continue
        has_ans = p.get("answers", True) is not False
        for g in p.get("groups") or []:
            t = g.get("type")
            rule = config.EXAM_TYPE_RULES.get(t) or {}
            qs = g.get("questions") or []
            out.append({
                "type": t, "label": g.get("label") or rule.get("label") or t,
                "index": g.get("label"),
                "judgeable": has_ans and bool(rule.get("judgeable")) and any(
                    (q.get("opts") or {}) for q in qs),
                "nos": [q.get("no") for q in qs],
            })
    return out


# ---------------------------------------------------------------- 真例句（C1）
_sent_cache = {"key": None, "idx": None, "sents": None}


def _build_sentences():
    """把真卷的阅读原文与长题干切成句子，建词 → 句索引。

    本机词表没有例句字段，但真卷里有 1722 句地道英文。按真实性铁律：
    宁可"这个词暂时没有真例句"，也不编一句。
    """
    sents = []
    for p in exam_papers().get("papers") or []:
        for g in p.get("groups") or []:
            src = "%s · %s" % (p.get("name") or "", g.get("label") or "")
            mat = g.get("material")
            if mat:
                for s in re.split(r"(?<=[.!?])\s+", mat):
                    s = " ".join(str(s).split())
                    if 40 <= len(s) <= 240:
                        sents.append({"t": s, "src": src, "kind": "阅读原文"})
            for q in g.get("questions") or []:
                st = " ".join(str(q.get("stem") or "").split())
                if 40 <= len(st) <= 240:
                    sents.append({"t": st, "src": src, "kind": "真题题干"})
    idx = {}
    for i, s in enumerate(sents):
        for tok in set(re.findall(r"[a-z][a-z'\-]+", s["t"].lower())):
            idx.setdefault(tok, []).append(i)
    return idx, sents


def sentences_of(word, limit=3):
    key = _stat_key(config.EXAM_PAPERS)
    if _sent_cache["key"] != key or _sent_cache["idx"] is None:
        _sent_cache["idx"], _sent_cache["sents"] = _build_sentences()
        _sent_cache["key"] = key
    idx, sents = _sent_cache["idx"], _sent_cache["sents"]
    hits = idx.get((word or "").lower()) or []
    out = []
    seen = set()
    for i in hits:
        s = sents[i]
        if s["t"] in seen:
            continue
        seen.add(s["t"])
        out.append(s)
        if len(out) >= int(limit or 3):
            break
    return {"word": word, "count": len(out), "sentences": out,
            "source": "workbench/data/exam_papers.json 的阅读原文与真题题干",
            "note": ("原卷里没出现过这个词，所以不给例句——不编句子"
                     if not out else "全部摘自真卷，不是模型生成的")}


def subject(proto_data, sid):
    for s in proto_data.get("subjects") or []:
        if s.get("id") == sid:
            return s
    return None


# 中文名 → 科目 id。模型经常把「英语」当 id 传给 course_add，
# 结果课程被归到一门新造的「英语」科目下，讲次 id 变成「英语-001」——
# 界面上五科旁边多出一门，进度也接不回原来的英语。
_NAME_ALIAS = {
    "math": ("数学", "高数", "高等数学", "微积分"),
    "english": ("英语", "英文"),
    "politics": ("政治", "政治理论"),
    "cs": ("计算机", "计算机基础", "计算机文化基础"),
    "clang": ("c语言", "c 语言", "c程序设计", "c 程序设计", "编程"),
}


def subject_flex(proto_data, key):
    """按 id / 中文名 / 名字里的一段认科目。

    为什么必须有：`subject()` 只认 id，而模型看见界面上写着「英语」，就照着传
    「英语」。这个值一旦落进课程库，就是给用户凭空加了一门课 —— 比报错糟得多。
    认不出来就返回 None，让调用方自己决定是拒收还是新建。
    """
    k = str(key or "").strip()
    if not k:
        return None
    subs = proto_data.get("subjects") or []
    hit = subject(proto_data, k)
    if hit:
        return hit
    kl = k.lower().replace(" ", "")
    for s in subs:
        sid = s.get("id") or ""
        for al in _NAME_ALIAS.get(sid, ()):
            if al.replace(" ", "") == kl:
                return s
    for s in subs:
        n = (s.get("name") or "").strip()
        if n and n == k:
            return s
    # 名字互相包含（「英语」对「专升本英语」、「数学」对「高等数学」）：取更短更贴的那个
    best = None
    for s in subs:
        n = (s.get("name") or "").strip()
        if not n:
            continue
        nl = n.lower().replace(" ", "")
        if kl and (kl in nl or nl in kl):
            if best is None or len(n) < len(best.get("name") or ""):
                best = s
    return best


def canonical_subject_id(key):
    """把「英语」「高数」「C 语言」这种写法认成规范科目 id。

    跟 subject_flex 的区别：**不依赖这门课已经存在**。空库里还没有 english 时，
    模型传「英语」也得落成 english，不能落成「英语」—— 那个 id 会一直烂在库里。
    认不出返回 None。
    """
    k = str(key or "").strip()
    if not k:
        return None
    kb = k.lower().replace(" ", "")
    for sid, aliases in _NAME_ALIAS.items():
        if kb == sid or kb in [a.replace(" ", "") for a in aliases]:
            return sid
    # 「专升本英语」「英语(二)」这类：别名是子串也算，取命中别名最长的那个
    best, bestlen = None, 0
    for sid, aliases in _NAME_ALIAS.items():
        for a in aliases:
            ab = a.replace(" ", "")
            if ab and ab in kb and len(ab) > bestlen:
                best, bestlen = sid, len(ab)
    return best


# 规范科目的中文显示名。**别拿课程标题当科目名** —— 课程库里一条记录 = 一门课，
# name 是「伍老师 各省真题阅读66篇」这种东西，写在 subject_name 上就成了另一门课的名字。
_SUBJECT_CN = {"math": "高等数学", "english": "英语", "politics": "政治",
               "cs": "计算机基础", "clang": "C 语言"}


def canonical_subject_name(key):
    """科目 id（或带 -bvxxx 后缀的课程 id）→ 规范中文名。认不出返回 None。"""
    k = str(key or "").strip()
    if not k:
        return None
    if k in _SUBJECT_CN:
        return _SUBJECT_CN[k]
    head = k.split("-")[0].lower()
    return _SUBJECT_CN.get(head)


def find_lesson(proto_data, lesson_id):
    for s in proto_data.get("subjects") or []:
        for l in s.get("lessons") or []:
            if l.get("id") == lesson_id:
                return s, l
    return None, None


def done_ids(subject_filter=None):
    """已完成讲次 = 旧 progress.sections(done) ∪ SQLite lesson_progress(done)。"""
    p = progress()
    ids = {}
    for lid, v in (p.get("sections") or {}).items():
        if isinstance(v, dict) and v.get("status") == "done":
            if subject_filter is None or lid.split("-")[0] == subject_filter:
                ids[lid] = (v.get("at") or "")
    con_rows = store.lessons_done(subject_filter)
    for r in con_rows:
        ids[r["lesson_id"]] = r.get("updated_ts") or ""
    return ids


def derive_next(proto_data, sub, done):
    """下一讲 = 从构建时的 next.id 出发，沿教学顺序往后找第一个没做完的。

    （lessons[] 的数组顺序 ≠ 教学顺序，这个坑这个项目踩过，所以锚点用后端算过的 next.id）
    """
    lessons = sub.get("lessons") or []
    if not lessons:
        return None
    anchor = (sub.get("next") or {}).get("id")
    start = 0
    for i, l in enumerate(lessons):
        if l.get("id") == anchor:
            start = i
            break
    for i in range(start, len(lessons)):
        if lessons[i].get("id") not in done:
            return lessons[i]
    for i in range(0, start):
        if lessons[i].get("id") not in done:
            return lessons[i]
    return None


def subject_progress(proto_data, sub, done):
    lessons = sub.get("lessons") or []
    d = [l for l in lessons if l.get("id") in done]
    d.sort(key=lambda l: lessons.index(l))
    nxt = derive_next(proto_data, sub, done)
    return {
        "lessons_done": len(d),
        "lessons_total": len(lessons),
        "done": d,                     # 全量：课表"本周实完成"、课程库"已上到"都要用
        "next": nxt,
        "pos": (store.get_lesson(nxt["id"]) if nxt else None),
    }


# ---------------------------------------------------------------- 词
def group_words(key):
    return ((proto().get("vocab") or {}).get("groups_words") or {}).get(key) or []


def mem_of(word):
    """单词记忆状态：SQLite 优先，旧 progress.vocab.xuecheng 兜底。"""
    m = store.get_mem(word)
    if m:
        return {"box": m["box"], "due": m["due"], "seen": m["seen"]}
    v = ((progress().get("vocab") or {}).get("xuecheng") or {}).get(word)
    if isinstance(v, dict):
        return {"box": v.get("box", 0), "due": v.get("due"),
                "seen": v.get("seen", 0), "source": "progress.json"}
    return None


def seed_legacy_mem():
    """旧工作台的词进度**不搬**（见 store.import_legacy_mem 的说明）。

    以前这里把 progress.json 里 87 条演示填充数据种成「已背过」，
    结果一进背单词页就有 86 个凭空到期；现在留空，让真实作答自己长出来。
    """
    if store.kv_get("legacy_mem_skipped") == "1":
        return 0
    store.kv_set("legacy_mem_skipped", "1")
    store.kv_set("legacy_mem_skipped_at", store.now())
    return 0


def current_group(proto_data):
    cur = ((proto_data.get("vocab") or {}).get("current") or {})
    key = cur.get("key")
    pod = proto().get("wordmap") or {}
    lidx = pod.get("lesson_index") or {}
    # 在当前词组对应的讲次里，挑第一个还没上完的
    ids = cur.get("lesson_ids") or []
    done = done_ids("english")
    live_id = None
    for lid in ids:
        if lid not in done:
            live_id = lid
            break
    # 进度又往前走了一个词组 → 跟随到新词组
    if not live_id:
        for l in (subject(proto_data, "english") or {}).get("lessons") or []:
            if l.get("id") in lidx and l.get("id") not in done:
                key = lidx[l["id"]]
                live_id = l["id"]
                break
    # 英语课一套词表都没有（空实例、或这门课没配讲义词表）时，别让背单词页空着：
    # 顶到「拉进来的第一本词书」的第 1 组，并在 why 里写明不是课程词表。
    # 只要课程有词表，就永远优先跟课程走 —— 这里只是兜底，不抢课程的位。
    book = None
    if not key or not group_words(key):
        u = next((u for u in (vocab_extra().get("units") or [])
                  if (u.get("lessons") or [])), None)
        if u:
            book = u
            key = "%s|%s" % (u.get("unit"), (u["lessons"][0] or {}).get("name"))
            live_id = None
    words = group_words(key) or cur.get("words") or []
    lid = None if book else (live_id or cur.get("lesson_id"))
    les = next((l for l in (subject(proto_data, "english") or {}).get("lessons") or []
                if l.get("id") == lid), None)
    out = {
        "key": key,
        "unit": (key or "|").split("|")[0],
        "lesson": (key or "|").split("|")[1] if key and "|" in key else "",
        "count": len(words),
        "words": words,
        "lesson_id": lid,
        "lesson_title": (les or {}).get("title"),
        "has_video": bool(lidx.get(lid)) if lid else False,
        "follow": "book" if book else "progress",
    }
    # why 一律现算（proto 里那句是构建时的快照，进度一动就过期）
    if book:
        out["why"] = ("英语课这边没有配套词表，按已经拉进来的词书「%s」走（第 1 组 %d 词）。"
                      "要背课程词表就在背单词页切回去。" % (book.get("unit") or "", len(words)))
    elif out["key"] and out["has_video"]:
        out["why"] = "英语词汇讲次里，「%s」是第一个还没上完的讲次，词组跟随它" % (
            out["lesson_title"] or out["lesson_id"] or "")
    elif out["key"]:
        out["why"] = ("词组 %s 是讲义附录词表（Unit 11/12），没有对应视频讲次" % out["key"])
    else:
        out["why"] = "词表没有可跟随的讲次"
    return out


def wordmap_groups(proto_data):
    pod = proto_data.get("wordmap") or {}
    groups = []
    mem = store.all_mem()
    for g in pod.get("groups") or []:
        known = 0
        for w in group_words(g["key"]):
            if w.get("w") in mem:
                known += 1
        groups.append({
            "key": g["key"], "unit": g["unit"], "lesson": g["lesson"],
            "count": g["count"], "first": g["first"], "last": g["last"],
            "sample": g.get("sample") or [],
            "has_video": bool(g.get("has_video")),
            "lesson_ids": [x.get("id") for x in (g.get("lessons") or [])],
            "mem_count": known,
        })
    return groups


def vocab_owner(proto_data=None):
    """词表属于哪门课。

    背单词不是每门课都有的事 —— 英语要背 3790 个词，高数不用背单词（它背的是公式，
    不是词表）。所以「背单词」这个入口要按科目出没，得有个真数据可依。

    判定顺序：
      1. proto.vocab.subject 显式写了归属，就用它；
      2. 没写但确实有词，归给 english（本机三本词书全是英语的）；
      3. 一个词都没有，返回 None —— 谁都不显示这一项。
    """
    p = proto_data if proto_data is not None else proto()
    vb = p.get("vocab") or {}
    has_words = bool(vb.get("groups_words") or vb.get("lists") or vb.get("sample"))
    if not has_words:
        return None
    return vb.get("subject") or "english"


# ---------------------------------------------------------------- 首屏
def bootstrap(include_lessons=False):
    """首屏快照。

    include_lessons=False（默认）时 subjects[] 里**不带** lessons：889 讲的完整数组
    实测 158KB，占整包七成，而真要用逐讲数据的页面（课程主页 / 课堂）走的是
    list_lessons 工具 —— 那里才是讲次加 done 标记的真源头。
    这里只留 dur_total（该科目所有 lesson.dur 之和，秒）和 done_n（已完成讲次数），
    够课程库算小时数、画进度条。

    但 done **照旧下发**（不计入 include_lessons）：老界面 web/app.js 真的在读它
    —— paintWeekDone 用 subjects[].done 画「本周完成」，课程卡用 s.done 最后一条
    显示「已上到」。它只有 4KB 左右（实测五科合计 4285 字节），拿掉的收益
    远不值得把老界面弄坏。

    done_n 直接取 subject_progress 算出来的 lessons_done，不再从 subjects[].done
    数一遍：同一次请求里同一个数不该有第二个口径，两边差一条就是「进度对不上」
    这种要查半天的怪事。

    老调用方要完整 lessons 就传 include_lessons=True（HTTP 上是 /api/base?full=1）。
    """
    p = proto()
    done = done_ids()
    vowner = vocab_owner(p)

    subjects = []
    for i, s in enumerate(p.get("subjects") or []):
        sp = subject_progress(p, s, done)
        row = {
            "id": s["id"], "name": s["name"], "kind": s.get("kind"),
            "score": s.get("score", 0), "accent": s.get("accent"),
            "mode": s.get("mode"), "bvid": s.get("bvid"),
            "video_up": s.get("video_up"), "video_pages": s.get("video_pages"),
            "cover": s.get("cover"), "video_title": s.get("video_title"),
            "groups": s.get("groups") or [],
            "lessons_total": sp["lessons_total"],
            "lessons_done": sp["lessons_done"],
            # done 一直给：老界面读它（见函数说明），只有 4KB，不值得为这点体积弄坏 /old
            "done": sp["done"],
            # 逐讲 dur 求和。dur 可能是 None（没核过时长的那几讲），按 0 计，
            # 不让整次加法炸掉；但也绝不编一个平均时长出来。
            "dur_total": sum(int(l.get("dur") or 0) for l in (s.get("lessons") or [])),
            "done_n": sp["lessons_done"],
            "next": sp["next"],
            "pos": sp["pos"],
            "cls": cls_of(s, i),
            # 这一门课有没有要背的词 —— 顶栏那句「背单词」按这个值出没
            "has_vocab": bool(vowner and s["id"] == vowner),
        }
        if include_lessons:
            # 老形状（?full=1）：lessons 全量照旧。dur_total / done_n 也一起给，
            # 免得老调用方为了两个数字再自己数一遍。
            row["lessons"] = s.get("lessons") or []
        subjects.append(row)

    cur = current_group(p)
    words = []
    for w in cur["words"]:
        m = mem_of(w["w"])
        words.append({"no": w.get("no"), "w": w["w"], "ph": w.get("ph"),
                      "pos": w.get("pos"), "cn": w.get("cn"), "mem": m,
                      "freq": (((p.get("vocab") or {}).get("freq_index") or {})
                               .get(w["w"]) or {}).get("freq")})
    cur = dict(cur, words=words)

    wm = wordmap_groups(p)
    bank = p.get("exercise_bank") or {}
    err = {e["part"]: e for e in store.error_by_part()}
    answered = store.answered_qnos()
    parts = []
    for pt in bank.get("parts") or []:
        e = err.get(pt["name"]) or {}
        qs = [q["no"] for q in (bank.get("questions") or []) if q.get("part") == pt["name"]]
        parts.append({
            "name": pt["name"], "n": pt.get("n", len(qs)),
            "done": len([q for q in qs if q in answered]),
            "wrong": e.get("wrong", 0),
            "ok": len([q for q in qs if answered.get(q) == 1]),
        })

    papers = exam_paper_meta()

    td = store.events_today()
    proto_kpi = p.get("kpi") or {}
    lesson_total = sum(s["lessons_total"] for s in subjects)
    mem = store.mem_stats()
    stats = store.answer_stats()

    kpi = {
        "subjects": len(subjects),
        "lesson_total": lesson_total,
        "lesson_done": len(done),
        # 词表总数是「本机真有这么多词」的意思。原来这里兜底写死 3790，
        # 空库里侧栏就会显示「背单词 3790」—— 一个库里零条词、界面却有 3790 词，
        # 评委一眼就看出这个数是编的。没有就是 0，不许兜底。
        "vocab_total": proto_kpi.get("vocab_total") or (len(p.get("vocab") or []) if isinstance(p.get("vocab"), list) else 0),
        "mem_xuecheng": mem["words"] or proto_kpi.get("mem_xuecheng", 0),
        "mem_top500": proto_kpi.get("mem_top500", 0),
        "mem_source": "SQLite 事件库" if mem["words"] else "progress.json（尚无本机作答）",
        "exam_papers": len(papers),
        "answered": stats["answered"],
        "accuracy": stats["accuracy"],
        "due_today": mem["due_today"],
        "boxes": mem["boxes"],
    }

    return {
        "built_at": p.get("built_at"),
        "generated_at": store.now(),
        "kpi": kpi,
        "subjects": subjects,
        "vocab": {
            "current": cur,
            "lists": (p.get("vocab") or {}).get("lists") or [],
            "freq_index": (p.get("vocab") or {}).get("freq_index") or {},
            "mem_counts": mem,
        },
        "wordmap": {
            "groups": wm,
            "summary": (p.get("wordmap") or {}).get("summary") or {},
            "lesson_index": (p.get("wordmap") or {}).get("lesson_index") or {},
        },
        "exercise_bank": {
            "id": bank.get("id"), "name": bank.get("name"), "desc": bank.get("desc"),
            "subject": bank.get("subject"), "total": bank.get("total"),
            "n_with_answer": bank.get("n_with_answer"),
            "n_with_explain": bank.get("n_with_explain"),
            "parts": parts,
        },
        "exam": {"papers": papers},
        # 题源注册表：练习页读它列入口，五科共用一张表（以前只有英语语法）
        "sources": _bootstrap_sources(),
        "point_cards": [
            {"id": c["id"], "name": c["name"], "desc": c.get("desc"),
             "subject": c.get("subject"), "kind": c.get("kind"), "count": c.get("count")}
            for c in (p.get("point_cards") or [])
        ],
        "resources": p.get("resources") or [],
        "events": {
            "today_count": len(td),
            "today_seconds": sum(e.get("seconds") or 0 for e in td),
            "days7": store.last_7d_minutes(),
            "recent": store.recent_events(12),
        },
        "tools_note": "所有页面数据都来自工具调用；此处只是首屏快照。",
    }


def _paper_answered(paper_id):
    """某套卷已答题数 = 事件库里记过的这道卷的作答（kind=exam_answer）。"""
    if not paper_id:
        return 0
    return store.counts_by_part("exam_answer").get(paper_id, 0)


# ================================================================ 题源
# 这一层的目的只有一个：**别让「加一种题」等于「改一遍工具」**。
# 不管来源是英语语法库、真题卷还是考点卡，吐出来的都是同一张 Item：
#   {id, subject, source, part, no, kind, stem, opts?, ans, explain?, topic, judge}
# 上层（make_quiz / grade_answer / 错因归因）只认这一张形状。
SRC_GRAMMAR = "grammar780"
SRC_EXAM = "exam_papers"
SRC_CS99 = "pc-cs99"
SRC_CS500 = "pc-cs500"
SRC_POL390 = "pc-pol390"

# 题源自报的门面。total 一律现算（len 真实数组），不吃卡片里写死的 count。
_SOURCE_STATIC = [
    {"id": SRC_GRAMMAR, "subject": "english", "name": "英语语法 · 经典必刷",
     "kind": "choice", "judge": config.JUDGE_EXACT,
     "why": "题库自带答案，四选一直接等值比对"},
    {"id": SRC_EXAM, "subject": "english", "name": "真题卷 · 选择题",
     "kind": "choice", "judge": config.JUDGE_EXACT,
     "why": "原卷答案；只收四选一题型，语法填空要自己写词，判不了"},
    {"id": SRC_CS99, "subject": "cs", "name": "计算机文化基础 · 99 条",
     "kind": "choice", "judge": config.JUDGE_EXACT,
     "why": "答案短（ENIAC / 冯·诺依曼），带空位，可造四选一"},
    {"id": SRC_CS500, "subject": "cs", "name": "计算机考点 · 505 条",
     "kind": "blank", "judge": config.JUDGE_AI_EXACT,
     "why": "填空题，标准答案长短不一，先等值、判不出再交给模型"},
    {"id": SRC_POL390, "subject": "politics", "name": "政治常考要点 · 613 条",
     "kind": "short", "judge": config.JUDGE_AI_SEMANTIC,
     "why": "简答题没有唯一写法，只能按要点命中评分"},
]

# 真题卷里能自动判分的题型（config.EXAM_TYPE_RULES.blank 明确不判）
_EXAM_JUDGEABLE = ("single", "reading", "cloze", "seven")


def item_sources(subject=None):
    """题源注册表：界面「练习」页的入口列表就是它，不再写死英语语法。

    两段拼起来：
      静态段  本机自带的那几个题库文件（语法 781 / 真题 975 / 考点卡 1216）；
      导入段  用户自己导进来的题（data/sources.json），科目随便写，
              判分档写在数据里（exact / ai_exact / ai_semantic / manual）。
    第二段是「换一门考试也能用」的关键：考研、考编的题只要导进来，
    就在同一张表里出现，判分走同一套四档，错因回流到同一张 error_tags。
    """
    out = []
    for s in _SOURCE_STATIC:
        n = _source_total(s["id"])
        if not n:
            continue        # 源头没数据就不摆出入口，不摆空壳
        row = dict(s)
        row["total"] = n
        row["origin"] = "builtin"
        # 注意：本函数有个叫 subject 的形参，把模块级 subject() 挡住了，
        # 所以这里显式取 globals 里那个函数，别写成 subject(_p, ...)
        _sub = globals()["subject"]
        row["subject_name"] = (_sub(proto(), s["subject"]) or {}).get("name") or s["subject"]
        out.append(row)
    for s in imported_sources():
        n = len(s.get("items") or [])
        if not n:
            continue
        row = {"id": s["id"], "subject": s.get("subject"), "name": s.get("name"),
               "kind": s.get("kind") or "choice",
               "judge": s.get("judge") or config.JUDGE_EXACT,
               "why": s.get("why") or "你自己导进来的题",
               # origin 透传：ai 生成的题要在界面上跟「自己导的」「自带的」分得清
               "origin": s.get("origin") or "import", "total": n,
               # 科目名优先用导入时写的中文名；没写就把 id 原样给界面，
               # 绝不拿「英语/高数」去套一套考研题 —— 那是替用户编科目
               "subject_name": s.get("subject_name") or s.get("subject_label")
                              or s.get("subject")} 
        out.append(row)
    if subject:
        out = [s for s in out if s["subject"] == subject]
    return out


# ---------------------------------------------------------------- 导入的题
# 一份 sources.json 长这样（可以有多份，每份是一个科目的一套题）：
#   {"sources": [{"id": "ky-math-2023", "subject": "kaoyan-math", "name": "考研数学一 · 2023 真题",
#                 "kind": "choice", "judge": "exact",
#                 "items": [{"no": 1, "stem": "…", "opts": {"A": "…", "B": "…"},
#                            "ans": "A", "explain": "…", "topic": "极限"}]}]}
# 不在这里判断「题好不好」—— 判断在判分和讲题那两步，这里只负责把它读出来。
_imp_cache = {"key": None, "data": None, "index": None}
_gen_cache = {"key": None, "data": None}


def gen_questions():
    """AI 生成的题（config.GEN_QUESTIONS）。跟真题分开放 —— 这两类不能混。"""
    path = getattr(config, "GEN_QUESTIONS", "")
    if not path:
        return {"sources": []}
    key = _stat_key(path)
    if _gen_cache["key"] == key and _gen_cache["data"] is not None:
        return _gen_cache["data"]
    try:
        with io.open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"sources": []}
    if not isinstance(data, dict):
        data = {"sources": []}
    data.setdefault("sources", [])
    _gen_cache["key"] = key
    _gen_cache["data"] = data
    return data


def save_gen_questions(data):
    path = getattr(config, "GEN_QUESTIONS", "")
    if not path:
        return False
    os.makedirs(config.APP_DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    _gen_cache["key"] = None
    _gen_cache["data"] = None
    _imp_cache["key"] = None
    _imp_cache["data"] = None
    return True


def imported_sources():
    path = getattr(config, "IMPORTED_SOURCES", None)
    if not path:
        return []
    # 生成题也参与这张表：练习页只有一个入口列表，分两张表就会「生成了却看不到」
    key = "%s|%s" % (_stat_key(path), _stat_key(getattr(config, "GEN_QUESTIONS", "")))
    if _imp_cache["key"] == key and _imp_cache["data"] is not None:
        return _imp_cache["data"]
    try:
        with io.open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"sources": []}
    srcs = [s for s in (data.get("sources") or []) if s.get("id")]
    seen = {s["id"] for s in srcs}
    for s in (gen_questions().get("sources") or []):
        if s.get("id") and s["id"] not in seen:
            srcs.append(s)
    _imp_cache["key"] = key
    _imp_cache["data"] = srcs
    _imp_cache["index"] = {s["id"]: s for s in srcs}
    return srcs


def imported_source(sid):
    imported_sources()
    return (_imp_cache["index"] or {}).get(sid)


def _source_total(sid):
    if sid == SRC_GRAMMAR:
        return len((proto().get("exercise_bank") or {}).get("questions") or [])
    if sid == SRC_EXAM:
        n = 0
        for p in exam_papers().get("papers") or []:
            for g in p.get("groups") or []:
                if g.get("type") in _EXAM_JUDGEABLE:
                    n += len(g.get("questions") or [])
        return n
    if sid in (SRC_CS99, SRC_CS500, SRC_POL390):
        return len(_card_items(sid))
    return 0


# ---------------------------------------------------------------- 选择项
_BLANK_TAIL = re.compile(r"(?:_{2,}|＿{2,}|…{2,}|\.{3,}|……)\s*$")


def blank_split(text):
    """把考点卡题干拆成 (考点, 要填的位置)。

    返回 dict：{stem, tail, inline}。inline=None 表示整句无空位 → 不造题。
    例：'世界上第一台计算机于1946 年诞生，它的名字叫？' → 考点='…的名字叫？'
    """
    s = str(text or "").strip()
    m = _BLANK_TAIL.search(s)
    if m:
        head, tail = s[:m.start()].rstrip(), s[m.start():].strip()
        return {"stem": head, "tail": tail, "inline": True, "asked": head[-10:]}
    # 整句加一个"想不起来了？"的问号收尾，不算改写内容
    return {"stem": s, "tail": "？", "inline": True, "asked": s[-10:]}


def _card_stem(item, kind):
    if kind == "qa":
        return blank_split(item.get("q"))
    if kind == "cloze":
        q = str(item.get("q") or "")
        m = _BLANK_TAIL.search(q)
        return {"stem": q[:m.start()].rstrip() if m else q,
                "tail": "", "inline": bool(m), "asked": q[-14:]}
    return {"stem": str(item.get("q") or ""), "tail": "", "inline": False,
            "asked": str(item.get("q") or "")[-14:]}


def build_choices(card_id, item, n=4, seed=0):
    """给「有确定空位、答案够短」的考点卡题造四选一。

    干扰项**只从同一张卡的其它真实答案里取**，不让模型编选项；
    拿不到足够干扰项就返回 None —— 宁可出填空题，也不凑假选项。
    返回 (opts, ans)：opts 形如 {"A": "ENIAC", ...}
    """
    ans = str(item.get("a") or "").strip()
    if not ans or len(ans) > 24:
        return None, None
    pool = []
    for it in _card_items(card_id):
        a = str(it.get("a") or "").strip()
        # 标准答案可能是「A、B、C」这种枚举（一条卡里本来就含逗号/顿号），
        # 那不是单个答案，不能当干扰项，否则同一题会出现两个真答案。
        if not a or a == ans or len(a) > 24 or a in pool:
            continue
        if re.search(r"[、,，；;/／]", a):
            continue
        pool.append(a)
    if len(pool) < n - 1:
        return None, None
    # 稳定取样：同一道题每次进来干扰项一致（否则同一题两次选项不同，没法二次做）
    idx = (int(item.get("no") or 0) * 7919 + int(seed)) % len(pool)
    picks = []
    i = idx
    while len(picks) < n - 1:
        cand = pool[i % len(pool)]
        if cand not in picks:
            picks.append(cand)
        i += 1
    letters = "ABCD"
    opts = {}
    ai = (int(item.get("no") or 0)) % n      # 答案位置也按题号固定，不随机
    pi = 0
    for li in range(n):
        if li == ai:
            opts[letters[li]] = ans
        else:
            opts[letters[li]] = picks[pi]
            pi += 1
    return opts, letters[ai]


def _parse_card_item(sid, kind, it):
    """考点卡一条 → 统一 Item（不带选项；选项是取题时按需造的）。"""
    pos = it.get("pos") or it.get("no")
    sp = _card_stem(it, kind)
    return {
        "id": "%s-%s" % (sid, pos), "source": sid,
        "subject": (point_card(sid) or {}).get("subject"),
        "part": it.get("grp") or (point_card(sid) or {}).get("name"),
        "no": int(it.get("no") or pos or 0),
        "kind": kind,
        "stem": sp["stem"], "tail": sp["tail"], "inline": sp["inline"],
        "opts": None,
        "ans": str(it.get("a") or ""),
        "full": it.get("full"),
        "explain": None,          # 考点卡没有解析，这一格永远空，绝不编
        "topic": it.get("grp") or (point_card(sid) or {}).get("name"),
    }


def _card_parsed(sid):
    """卡片已解析成统一 Item 的缓存（1216 条，别每次重算）。"""
    point_cards()
    cache = _card_cache["parsed"] or {}
    if sid in cache:
        return cache[sid]
    c = point_card(sid)
    kind = (c or {}).get("kind") or "qa"
    items = [_parse_card_item(sid, kind, it) for it in _card_items(sid)]
    cache[sid] = items
    _card_cache["parsed"] = cache
    return items


# ---------------------------------------------------------------- 取题
def default_source():
    """没有指定题源时，用「这台机器上真实存在的第一个题源」。

    以前这里写死 SRC_GRAMMAR（英语语法 781）—— 一台空白机器上根本没有题库文件，
    界面就会显示「grammar780 · 0 题」，看上去像题库坏了，其实是压根没有题源。
    现在先看有没有东西，没有就如实说没有。
    """
    try:
        for s in item_sources():
            if s.get("total"):
                return s["id"]
    except Exception:
        pass
    return None


def source_questions(source, part=None, limit=config.QUIZ_DEFAULT_SIZE, offset=0):
    """统一取题入口。返回 {source, parts, total, count, questions[]}，不带答案。"""
    if not source:
        source = default_source()
        if not source:
            return {"source": None, "subject": None, "part": None, "parts": [],
                    "total": 0, "offset": 0, "count": 0, "questions": [],
                    "judge": None, "empty": True,
                    "note": "这台机器上还没有任何题源：自带的题库文件不在，"
                            "也还没导入过题。练习页现在没东西可刷 —— 不是我把它藏起来了。"}
    meta = next((s for s in _SOURCE_STATIC if s["id"] == source), None)
    if not meta:
        # 导入的题源：不在静态表里，就在 sources.json 里
        imp = imported_source(source)
        if not imp:
            return {"error": "没有这个题源: %s" % source,
                    "sources": item_sources()}
        meta = {"id": source, "subject": imp.get("subject"),
                "kind": imp.get("kind") or "choice",
                "judge": imp.get("judge") or config.JUDGE_EXACT}
        rows, parts = [], {}
        for it in (imp.get("items") or []):
            pn = it.get("part") or imp.get("name") or "全部"
            parts[pn] = parts.get(pn, 0) + 1
            rows.append({
                "id": "%s-%s" % (source, it.get("no")), "source": source,
                "subject": meta["subject"], "part": pn, "group": pn,
                "no": it.get("no"), "kind": meta["kind"], "ref": str(it.get("no")),
                "stem": it.get("stem"), "tail": "", "inline": False,
                "opts": it.get("opts") or {}, "ans": it.get("ans"),
                "explain": it.get("explain"), "topic": it.get("topic"),
                "judge": meta["judge"],
            })
        if part:
            rows = [r for r in rows if r["part"] == part]
        slice_ = rows[int(offset):int(offset) + int(limit)]
        return {"source": source, "subject": meta["subject"], "part": part,
                "parts": [{"name": k, "n": v} for k, v in parts.items()],
                "total": len(rows), "offset": int(offset),
                "count": len(slice_), "questions": slice_,
                "judge": meta["judge"], "origin": "import"}

    if source == SRC_GRAMMAR:
        parts = [{"name": x["name"], "n": x.get("n")} for x in
                 (proto().get("exercise_bank") or {}).get("parts") or []]
        # 不指定分段就是全部 781 题 —— 以前这里偷偷把 part 落回第一段，
        # 于是「英语语法 · 经典必刷 781」永远只给得出那一段的 30 题，
        # 剩下的 751 题在这台机器上等于不存在（用户骂的「600 多题只显示十几题」）。
        r = questions_of_part(part, limit, offset, with_answer=True)
        for q in r["questions"]:
            q["source"] = source
            q["id"] = "%s-%s" % (source, q["no"])
            q["ref"] = str(q["no"])          # 讲题要按 ref 精确定位，不靠猜
            q["kind"] = "choice"
            q["judge"] = config.JUDGE_EXACT       # 英语语法库自带答案，四选一直接判
        return {"source": source, "subject": meta["subject"], "part": part,
                "parts": parts, "total": r["total"], "offset": int(offset),
                "count": len(r["questions"]), "questions": r["questions"],
                "judge": meta["judge"]}

    if source == SRC_EXAM:
        rows, parts = [], {}
        for p in exam_papers().get("papers") or []:
            for g in p.get("groups") or []:
                if g.get("type") not in _EXAM_JUDGEABLE:
                    continue
                parts[g.get("label")] = parts.get(g.get("label"), 0) + len(g.get("questions") or [])
                for q in g.get("questions") or []:
                    rows.append({
                        "id": "%s-%s-%s" % (source, p["id"], q["no"]),
                        "source": source, "subject": meta["subject"],
                        "part": p["id"], "group": g.get("label"), "type": g.get("type"),
                        "no": q["no"], "kind": "choice",
                        "ref": "%s|%s" % (p["id"], q["no"]),
                        "stem": q.get("stem"), "tail": "", "inline": False,
                        "opts": q.get("opts") or {}, "ans": q.get("ans"),
                        "explain": None, "topic": g.get("label"),
                    })
        # 分段过滤：以前这个分支**压根没有 if part**，练习页摆着分段下拉、
        # 选「完形填空」还是第 1 题 —— 选项动了，题不动。按题型名（label）或卷 id 都认。
        if part:
            rows = [r for r in rows if part in (r.get("group"), r.get("part"))]
        page = rows[int(offset):int(offset) + int(limit)]
        return {"source": source, "subject": meta["subject"], "part": part,
                "parts": [{"name": k, "n": v} for k, v in parts.items()],
                "total": len(rows), "offset": int(offset), "count": len(page),
                "questions": page, "judge": meta["judge"],
                "note": "真题卷只给四选一题型；语法填空要自己写词，本机不判，所以不列"}

    # 考点卡三张
    items = _card_parsed(source)
    groups, order = {}, []
    for it in items:
        g = it["part"]
        if g not in groups:
            groups[g] = 0
            order.append(g)
        groups[g] += 1
    if part:
        items = [it for it in items if it["part"] == part]
    total = len(items)
    page = []
    for it in items[int(offset):int(offset) + int(limit)]:
        q = dict(it)
        q["ref"] = str(q.get("no"))
        if meta["kind"] == "choice":
            opts, ans = build_choices(source, _card_item_by_no(source, it["no"]) or it)
            if opts:
                q["kind"] = "choice"
                q["opts"], q["ans"] = opts, ans
                q["judge"] = config.JUDGE_EXACT
            else:
                # 造不出可信选项 → 退成填空，判分档跟着变，界面据此改渲染
                q["kind"] = "blank"
                q["opts"] = None
                q["judge"] = config.JUDGE_AI_EXACT
        page.append(q)
    return {"source": source, "subject": meta["subject"], "part": part,
            "parts": [{"name": g, "n": groups[g]} for g in order],
            "total": total, "offset": int(offset), "count": len(page),
            "questions": page, "judge": meta["judge"],
            "note": "考点卡原样取出，没有解析就是没有——不编解析"}


def item_by_ref(source, ref):
    """按 (题源, 引用) 取一道题（带答案），判分用。

    ref 的语义随题源而定：语法库/考点卡是题号，真题卷是 "卷id|题号"。
    """
    source = source or SRC_GRAMMAR
    # 导入的题（考研/考编/任何考试）：同一形状，判分档从数据里读
    imp = imported_source(source)
    if imp:
        want = str(ref)
        for it in (imp.get("items") or []):
            if str(it.get("no")) == want:
                q = dict(it)
                q.update({"id": "%s-%s" % (source, want), "source": source,
                          "subject": imp.get("subject"),
                          "part": it.get("part") or imp.get("name"),
                          "kind": it.get("kind") or imp.get("kind") or "choice",
                          "judge": it.get("judge") or imp.get("judge") or config.JUDGE_EXACT,
                          "opts": it.get("opts") or {}, "ans": it.get("ans"),
                          "stem": it.get("stem"), "explain": it.get("explain"),
                          "full": it.get("full"), "topic": it.get("topic")})
                return q
        return None
    if source == SRC_GRAMMAR:
        q = question_by_no(ref)
        if not q:
            return None
        q = dict(q)
        q.update({"source": source, "id": "%s-%s" % (source, q["no"]),
                  "kind": "choice", "judge": config.JUDGE_EXACT})
        return q
    if source == SRC_EXAM:
        s = str(ref)
        if "|" in s:
            pid, no = s.split("|", 1)
        else:
            pid, no = None, s
        if pid:
            _, g, q = exam_question(pid, no)
            if not q:
                return None
            return {"id": "%s-%s-%s" % (source, pid, q["no"]), "source": source,
                    "subject": "english", "part": pid, "no": q["no"],
                    "kind": "choice", "judge": config.JUDGE_EXACT,
                    "stem": q.get("stem"),
                    "opts": q.get("opts") or {}, "ans": q.get("ans"),
                    "type": (g or {}).get("type"), "topic": (g or {}).get("label")}
        for p in exam_papers().get("papers") or []:
            for g in p.get("groups") or []:
                for q in g.get("questions") or []:
                    if str(q.get("no")) == str(no) and g.get("type") in _EXAM_JUDGEABLE:
                        return {"id": "%s-%s-%s" % (source, p["id"], q["no"]),
                                "source": source, "subject": "english",
                                "part": p["id"], "no": q["no"], "kind": "choice",
                                "judge": config.JUDGE_EXACT,
                                "stem": q.get("stem"), "opts": q.get("opts") or {},
                                "ans": q.get("ans"), "type": g.get("type"),
                                "topic": g.get("label")}
        return None
    for it in _card_parsed(source):
        if str(it["no"]) == str(ref):
            q = dict(it)
            q["judge"] = _CARD_JUDGE.get(source, config.JUDGE_AI_SEMANTIC)
            if source == SRC_CS99 or it.get("kind") == "qa":
                # 99 条卡在设计上就是四选一（desc 写着「问答自测，可四选一」）。
                # 取题时 build_choices 造得出来就按选项判，造不出来就退回按答案等值，
                # 反正答案都是 ENIAC 这种短词，等值本身也够准。
                opts, ans = build_choices(source, _card_item_by_no(source, it["no"]) or it)
                if opts:
                    q["kind"], q["opts"], q["ans"] = "choice", opts, ans
                    q["judge"] = config.JUDGE_EXACT
            return q
    return None


def _card_item_by_no(sid, no):
    """取考点卡**原始**条目（解析后的 Item 已没有 a 字段，造选项要用原答案）。"""
    for it in _card_items(sid):
        if str(it.get("no") or it.get("pos")) == str(no):
            return it
    return None


# 三张考点卡各自的判分档（取题/判分两处共用，别写两份）
_CARD_JUDGE = {
    SRC_CS99: config.JUDGE_EXACT,
    SRC_CS500: config.JUDGE_AI_EXACT,
    SRC_POL390: config.JUDGE_AI_SEMANTIC,
}


def _norm_text(s):
    """判分前的标准化：全半角、大小写、标点、空白全部抹平。"""
    import unicodedata
    t = unicodedata.normalize("NFKC", str(s or "")).lower()
    t = re.sub(r"[\s，,。．.、；;：:！!？?\"“”‘’'（）()\[\]【】\-—_…/\\|]+", "", t)
    return t


def _shorter(a, b):
    a, b = str(a or ""), str(b or "")
    return a if len(a) <= len(b) else b


def _model_available():
    """问一句「现在有没有模型能判」—— 不 import 上层，避免循环依赖。"""
    try:
        from . import model_router
        ok, why = model_router.available()
        return bool(ok), (why or "本机没接模型")
    except Exception as e:
        return False, "取不到模型状态（%s）" % e


def judge_answer(item, chosen):
    """判一道题。返回 {ok, band, ans, explain, note}。

    exact 档在这里真判；ai_exact / ai_semantic 在没接模型时**如实返回待判**，
    不猜、不给分、不写假记录 —— 判不了就说判不了（这个项目的老规矩）。
    """
    band = item.get("judge") or config.JUDGE_EXACT
    ans = item.get("ans")
    if item.get("kind") == "choice" or band == config.JUDGE_EXACT:
        ok = _norm_text(chosen) == _norm_text(ans) and bool(_norm_text(ans))
        return {"ok": ok, "band": config.JUDGE_EXACT, "ans": ans,
                "full": item.get("full"),
                "explain": item.get("explain"),
                "note": None if item.get("explain") else "这道题源头就没有解析，不编"}

    got, want = _norm_text(chosen), _norm_text(ans)
    if not want:
        # 标准答案本身就是空的（cs500 里有 97 条这样）→ 只能人工
        return {"ok": None, "band": config.JUDGE_MANUAL, "ans": ans,
                "explain": item.get("explain"),
                "note": "这条考点卡没有标准答案，判不了——需要人来看"}
    if band == config.JUDGE_AI_SEMANTIC:
        # 主观题：本机绝不判分。没接模型就如实说「判不了」，
        # 不拿「包含关系」冒充语义命中 —— 那是编分。
        ok_ai, why_ai = _model_available()
        if not ok_ai:
            return {"ok": None, "band": config.JUDGE_MANUAL, "ans": ans,
                    "want_band": band, "judged": False,
                    "explain": item.get("explain"),
                    "note": "这一档要模型判（ai_semantic），%s，先给标准答案自己对" % why_ai}
        return {"ok": None, "band": config.JUDGE_MANUAL, "ans": ans,
                "want_band": band, "judged": False,
                "explain": item.get("explain"),
                "note": "语义档要模型逐条比要点；本机只在讲题/批改那条链上接模型，"
                        "判分入口不偷偷调 —— 想让它判，请在讲题卡片上点「讲清这题」"}

    short, long_ = _shorter(got, want), (want if len(want) >= len(got) else got)
    if short and short in long_:
        return {"ok": True, "band": config.JUDGE_EXACT, "ans": ans,
                "explain": item.get("explain"),
                "note": "答案互相包含，按等值判过（不耗模型）"}
    if not (chosen or "").strip():
        return {"ok": False, "band": band, "ans": ans,
                "explain": item.get("explain"), "note": "没作答"}
    if not config.ENABLE_LLM:
        return {"ok": None, "band": config.JUDGE_MANUAL, "want_band": band,
                "ans": ans, "full": item.get("full"),
                "explain": item.get("explain"),
                "note": "这一档要模型判（%s），本机 ENABLE_LLM=false，先给标准答案自己对" % band}
    return {"ok": None, "band": band, "ans": ans, "full": item.get("full"),
            "explain": item.get("explain"),
            "note": "模型判分通道待接入：本次不给分，也不假装给分"}


def _bootstrap_sources():
    """首屏用的题源列表：带真实题量、判分档和本机真实做过的题数。"""
    stats = {}
    for r in store.source_stats():
        stats[r["source"]] = r
    out = []
    for s in item_sources():
        st = stats.get(s["id"]) or {}
        row = dict(s)
        row["done"] = st.get("done", 0)
        row["wrong"] = st.get("wrong", 0)
        row["right"] = st.get("right", 0)
        out.append(row)
    return out


# ---------------------------------------------------------------- 按需
def questions_of_part(part, limit=config.QUIZ_DEFAULT_SIZE, offset=0, with_answer=False):
    """part 给 None/空 = 跨段取全部（几百题的库不该被悄悄锁在第一段）。"""
    qs = (proto().get("exercise_bank") or {}).get("questions") or []
    if part:
        qs = [q for q in qs if q.get("part") == part]
    total = len(qs)
    ans = store.answered_qnos()
    page = qs[int(offset): int(offset) + int(limit)]
    out = []
    for q in page:
        item = {"no": q["no"], "part": q.get("part"), "topic": q.get("topic"),
                "page": q.get("page"), "stem": q.get("stem"), "opts": q.get("opts"),
                "done": q["no"] in ans, "last_ok": ans.get(q["no"])}
        if with_answer:
            item["ans"] = q.get("ans")
            item["explain"] = q.get("explain")
        out.append(item)
    return {"part": part, "total": total, "offset": int(offset),
            "count": len(out), "questions": out}


def question_by_no(qno):
    for q in (proto().get("exercise_bank") or {}).get("questions") or []:
        if q.get("no") == int(qno):
            return q
    return None


def lesson_words(lesson_id):
    """本讲词群：只给词汇讲次。语法/精讲课返回空 + 原因（这个项目的老坑，别改回去）。"""
    pod = proto().get("wordmap") or {}
    key = (pod.get("lesson_index") or {}).get(lesson_id)
    if not key:
        return {"lesson_id": lesson_id, "is_word_lesson": False, "key": None,
                "count": 0, "words": [],
                "reason": "这一讲不是单词课，没有配词表"}
    ws = group_words(key)
    return {"lesson_id": lesson_id, "is_word_lesson": True, "key": key,
            "count": len(ws),
            "words": [{"no": w.get("no"), "w": w["w"], "ph": w.get("ph"),
                       "pos": w.get("pos"), "cn": w.get("cn"), "mem": mem_of(w["w"])}
                      for w in ws]}


# 讲次标题里的考点词 → 题库分部（精确到分部名，不用子串，避免「名词」吃掉「名词性从句」）。
# 以前是拿标题括号里的前两个字做子串匹配（`pts[:2] in nm`），
# 结果「可数名词」匹配不上「名词」，「形容词副词区别」也匹配不上，
# 绝大多数语法讲次的 covers 全是空——等于这功能没生效。
# 左边 = 题库里的分部名（去掉「第 X 部分：」之后），右边 = 标题里出现就算命中的词。
_PART_RULES = [
    ("名词性从句", ("名词性从句", "宾语从句", "主语从句", "表语从句", "同位语从句")),
    ("定语从句", ("定语从句", "关系代词", "关系副词")),
    ("状语从句", ("状语从句", "状语")),
    ("非谓语动词", ("非谓语", "动词不定式", "动名词", "分词")),
    ("主谓一致", ("主谓一致",)),
    ("虚拟语气", ("虚拟语气", "虚拟")),
    ("倒装句", ("倒装",)),
    ("强调句", ("强调句", "强调")),
    ("反意疑问句", ("反意疑问", "附加疑问")),
    ("感叹句", ("感叹句",)),
    ("动词的时态语态", ("时态", "语态", "一般现在时", "一般过去时", "一般将来时",
                        "现在进行时", "过去进行时", "现在完成时", "过去完成时", "被动")),
    ("情态动词", ("情态动词",)),
    ("并列连词", ("并列连词", "并列句", "连词")),
    ("介词", ("介词",)),
    ("代词", ("代词",)),
    ("数词", ("数词",)),
    ("冠词", ("冠词",)),
    ("形容词和副词", ("形容词", "副词", "比较级", "最高级")),
    ("名词", ("名词", "所有格")),
]


def _part_plain(name):
    """`第十三部分：名词性从句` → `名词性从句`。

    注意不能用 `name.replace("部分：","")`：那会把「第」和序号一起留下，
    变成「第十三名词性从句」，精确比对就全落空了（踩过）。
    """
    return re.sub(r"^第[一二三四五六七八九十百]+部分[：:]\s*", "", str(name or "")).strip()


def _grammar_covers(pts):
    """把讲次标题括号里的考点词，映射到题库真实存在的分部。

    只返回题库里真有分部的；映射不上就返回空数组——**不硬凑**，
    界面会写"这讲没有对应的题库分部"，而不是随便塞一个不相干的考点。

    分部名是**精确匹配**（去掉「第 X 部分：」后整串相等），不是子串，
    所以「名词」不会顺带命中「名词性从句」（踩过：english-72 误命中第十三部分）。
    """
    bank = proto().get("exercise_bank") or {}
    parts = bank.get("parts") or []
    if not parts or not pts:
        return []
    blob = " ".join(pts)
    # 长关键词优先：「名词性从句」排在「名词」前面
    ordered = sorted(_PART_RULES,
                     key=lambda kv: -max((len(k) for k in kv[1]), default=0))
    hit, used = [], set()
    for kw, keys in ordered:
        matched = [k for k in keys if k in blob]
        if not matched:
            continue
        for pt in parts:
            nm = _part_plain(pt["name"])
            if nm != kw:            # 精确比对，不做子串
                continue
            if pt["name"] in used:
                continue
            used.add(pt["name"])
            hit.append({"kind": "题库考点", "name": pt["name"], "n": pt.get("n"),
                        "why": "本讲标题提到「%s」" % "/".join(matched[:2])})
    return hit


def _card_covers(sid, pts):
    """讲次标题里的考点词，去该科自己的考点卡分组里找。

    和 _grammar_covers 一样的规矩：匹配不上就返回空，不硬凑一个考点上去。
    """
    if not pts:
        return []
    cards = [c for c in _SOURCE_STATIC if c["subject"] == sid and c["id"] in
             (SRC_CS99, SRC_CS500, SRC_POL390)]
    if not cards:
        return []
    blob = " ".join(pts)
    hit = []
    for c in cards:
        for it in _card_parsed(c["id"]):
            g = it.get("part") or ""
            # 分组名去掉括注再比，否则「唯物论（第二章：物质和意识）」永远匹配不上
            gname = re.sub(r"[（(][^（）()]*[）)]", "", g).strip()
            if gname and (gname in blob or gname in (blob or "")):
                hit.append({"kind": "考点卡", "name": g, "n": len(_card_items(c["id"])),
                            "why": "本讲标题提到「%s」" % gname,
                            "source": c["id"]})
                break
    return hit


def lesson_content(lesson_id):
    """非词汇讲次的内容面：该科自己的考点卡 / 题库覆盖 + 从标题括号里提取的考点。"""
    p = proto()
    sub, les = find_lesson(p, lesson_id)
    if not les:
        return {"lesson_id": lesson_id, "subjects": []}
    title = les.get("title") or ""
    pts = re.findall(r"[（(]([^（）()]{2,30})[）)]", title)
    sid = sub["id"]
    # 以前是 if sid == "english"：切到计算机/政治，这一栏永远是空的。
    # 现在五科走同一条匹配，只是**各自匹配自己的题源**：
    #   英语 → 语法题库 19 个分部；计算机/政治 → 自己的考点卡分组。
    covers = _grammar_covers(pts)
    for hit in _card_covers(sid, pts):
        if hit not in covers:
            covers.append(hit)
    cards = [c for c in (p.get("point_cards") or []) if c.get("subject") == sid]
    return {
        "lesson_id": lesson_id, "subject": sid, "subject_name": sub["name"],
        "title": title, "chapter": les.get("chapter"),
        "points": pts,
        "covers": covers,
        "cards": [{"id": c["id"], "name": c["name"], "count": c["count"]} for c in cards],
        "resources": [r for r in (p.get("resources") or [])][:5],
    }


def vocab_follow_lesson():
    return current_group(proto())
