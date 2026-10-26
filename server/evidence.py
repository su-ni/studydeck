# -*- coding: utf-8 -*-
"""证据层：讲解之前先把「凭什么」捞出来（纯本地，不碰模型）。

设计铁律（docs/AI讲题-重新设计.md）：
  1. 先找证据再说话 —— 模型只能在给定证据上做判断；
  2. 每句话都要能点回去 —— 每段讲解都挂 evidence；
  3. 捞不到证据就说捞不到，绝不编。

这个模块只做第 1 步：给一道题（题源 + ref），把本机所有能支撑它的原文/规则
捞出来，切成可引用的句子。它不产生任何"解释"，只产证据。

为什么单独一层：证据是可以脱离模型被验证的（引文必须在原文里精确命中），
而模型的解释不能。把可验证的部分单独拎出来，是「AI 准不准」这件事能被量化
的前提。
"""
import re

from . import config
from . import datahub

# 句末切句：中英文都覆盖。保留分隔符，拼回去要还原成原文。
_SENT_SPLIT = re.compile(r"(?<=[。！？；.!?;])\s*")
# 一篇文章里句子太多时，给模型塞全文会淹没重点 —— 先按词重合度裁到最相关的几句
_STOP = set("""a an the is are was were be been being of to in on at for with and or but
if then than that this these those it its as by from not no do does did have has had
you we they he she i me my your our their them us can could should would may might must
will shall there here what which who whom whose when where why how all any both each few
more most other some such only own same so too very s t just don now""".split())


def _sentences(text):
    """把一段原文切成句子（保住标点，拼回去 == 原文）。"""
    s = str(text or "")
    if not s.strip():
        return []
    parts = [p for p in _SENT_SPLIT.split(s) if p.strip()]
    return parts


def _tokens(s):
    return [w for w in re.findall(r"[A-Za-z][A-Za-z'-]+", str(s or "").lower())
            if w not in _STOP and len(w) > 2]


def _chinese_tokens(s):
    """中文没有空格，用二字段粗切，只为算重合度，不做分词。"""
    s = re.sub(r"[^\u4e00-\u9fa5]", "", str(s or ""))
    return [s[i:i + 2] for i in range(len(s) - 1)]


_BLANK_NO = re.compile(r"[（(]?\s*(?:\d{1,3})\s*[）)]?\s*[_＿]{2,}|[_＿]{2,}\s*[（(]?\s*\d{1,3}")


def _blank_hit(no, sent):
    """这句话里是否真的有个"空"是这个编号占的。

    试卷 PDF 抽出来的空位长这样：The school work is just the 21 . ——
    编号孤零零夹在两个空格中间，没有任何下划线。所以判据不能只认下划线，
    得认「前后都不是字母数字的孤立数字」，同时这句里得有空位痕迹。
    """
    want = str(no or "").strip()
    if not want:
        return False
    # 试卷里的空位有两种写法，都得认：
    #   完形填空  the 21 .        —— 编号被空白/标点夹住
    #   语法填空  things __36__ (change) —— 下划线包着编号，后面常跟提示词
    # 不能要求两个连续空格：原文抽出来常常只有单空格，第一版就栽在这。
    plain = re.compile(r"(?:^|(?<=[\s，,、（(]))" + re.escape(want) +
                       r"(?=[\s，,、）).．;；]|$)")
    if plain.search(sent):
        return True
    underscored = re.compile(r"[_＿]{2,}\s*" + re.escape(want) + r"\s*[_＿]{2,}")
    return bool(underscored.search(sent))


def _blank_offset(material, numbers):
    """找出「原文空号」与「题号」的整体错位量，找不到就返回 0。

    真实踩到的情况：2023 广东《公共英语》完形填空，原卷短文里的空号是 21–35，
    而题库里这组题的题号是 16–30 —— 抽题时前面 5 题（阅读第二节）占掉了编号，
    短文里的号却没跟着改。差 5 不是猜的：把两种编号都列出来，如果每一个原文空号
    都能在题号序列里找到「同一个偏移」的对应，那这个偏移就是事实，不是臆测。
    只要有一个对不上，就返回 0，宁可说定位不到，也不挪着号乱引。
    """
    sents = _sentences(material)
    if not sents or not numbers:
        return 0
    nums = set(str(n) for n in numbers)
    i0 = int(min(int(n) for n in numbers))
    found = []
    for s in sents:
        cand = []
        for m in re.finditer(r"(?<![0-9A-Za-z])(\d{1,3})(?![0-9A-Za-z])", s):
            v = int(m.group(1))
            if 10 <= v <= 60 and re.search(r"\s{2,}|[_＿]{2,}|[.．]\s*$", s):
                cand.append(v)
        # 一句里只认一个候选：两句都带号的句子（"...a 25 ... 150 miles..."）
        # 分了也说不清哪个是空号，宁可跳过，不让脏数据把偏移算歪。
        if len(set(cand)) == 1:
            found.append(cand[0])
    if not found:
        return 0
    # 只留最长的连续号段：空号一定是连着的（21,22,23…），分值/年份不会连成串。
    # 这一步是必须的 —— "满分10 分" 里的 10 一度把偏移算歪成 6。
    seqs, cur = [], [sorted(set(found))[0]]
    for v in sorted(set(found))[1:]:
        if v == cur[-1] + 1:
            cur.append(v)
        else:
            seqs.append(cur)
            cur = [v]
    seqs.append(cur)
    seq = max(seqs, key=len)
    if len(seq) < 3:
        return 0
    # 偏移 = 原文空号 - 题号。题号 16 对应原文里的 21，偏移就是 +5：
    # 找原句时用「题号 + 偏移」，别把这个方向搞反（第一版就反了，全都定位不到）。
    off = seq[0] - i0
    mapped = [v - off for v in seq]
    if not all(str(m) in nums for m in mapped):
        return 0
    return off


def quote_for_blank(no, material, limit=2, offset=0):
    """完形/语法填空：题干只是个编号，真正的依据是「这个空所在的那句话」。

    把空号钉到所在句上，引出来的就是需要还原语境的那一句 —— 这才是该引的，
    而不是随便挑一句。原卷编号与题号整体错位时（offset != 0）按偏移找；
    offset 必须由 _blank_offset 证明过，不允许拍脑袋往里传。
    钉不到就老实返回空，让上层说"定位不到这句"。
    """
    sents = _sentences(material)
    if not sents:
        return []
    want = str(no or "").strip()
    if not want:
        return []
    try:
        want_c = str(int(want) + int(offset or 0))   # 题号 → 原文空号
    except (TypeError, ValueError):
        want_c = want
    hits = []
    for i, s in enumerate(sents):
        if _blank_hit(want_c, s):
            hits.append({"text": s.strip(), "index": i, "score": 1.0})
    for h in hits:
        h["mapped"] = want_c
    return hits[:limit]


def pick_quotes(stem, material, limit=3):
    """从原文里挑出与题目最相关的几句，返回 [{text, index, score}]。

    这是"引原文"能不能落地的关键：不能把 1853 字原文整篇丢给模型让它自己找，
    那样引用出来的句子经常在原文里找不到 —— 而引用不到即作废。
    """
    sents = _sentences(material)
    if not sents:
        return []
    q = set(_tokens(stem))
    scored = []
    for i, s in enumerate(sents):
        t = set(_tokens(s))
        if not t:
            continue
        # 题干关键词命中数 + 归一化，长句不天然占优
        hit = len(q & t)
        score = hit / (len(t) ** 0.5) if hit else 0.0
        if score > 0:
            scored.append({"text": s.strip(), "index": i, "score": round(score, 3)})
    scored.sort(key=lambda x: (-x["score"], x["index"]))
    out = scored[:limit]
    out.sort(key=lambda x: x["index"])      # 回到原文顺序，读起来才顺
    return out


def _quote_in_material(quote, material):
    """引文必须能在原文里逐字找到（去掉空白后比对），否则这条证据作废。"""
    a = re.sub(r"\s+", "", str(quote or ""))
    b = re.sub(r"\s+", "", str(material or ""))
    return bool(a) and a in b


def _card_group(sid, item):
    """考点卡题：同组其它题的真实答案/全文，可以当语境（不是编的）。"""
    grp = item.get("part")
    if not grp:
        return []
    out = []
    for it in datahub._card_parsed(sid):
        if it.get("part") != grp or str(it.get("no")) == str(item.get("no")):
            continue
        out.append(it)
    return out


def gather(source, ref, chosen=None):
    """给一道题捞证据。返回结构化 evidence，**不含任何模型产出**。

    返回：
      {
        source, ref, found: bool,
        stem, opts, ans, kind, judge,
        origin: 这题从哪来（文件名/卷名/卡片名 + 位置）,
        topic:  考点标签（哪来的也写清）,
        basis:  [{kind, text, where, verified}]   —— 答案依据
        context:[{text, where}]                    —— 背景材料（不作依据，只供理解）
        gaps:   [str]                              —— 捞不到证据的地方，要如实说
      }
    """
    item = datahub.item_by_ref(source, ref)
    if not item:
        return {"source": source, "ref": ref, "found": False,
                "gaps": ["题源里找不到这道题：%s / %s" % (source, ref)]}
    ev = {
        "source": source, "ref": ref, "found": True,
        "stem": item.get("stem"), "opts": item.get("opts"),
        "ans": item.get("ans"), "kind": item.get("kind"),
        "judge": item.get("judge"),
        "chosen": chosen,
        "topic": None, "origin": None,
        "basis": [], "context": [], "gaps": [],
    }

    # ---------- 语法库：自带官方解析，这是最硬的一种证据 ----------
    if source == datahub.SRC_GRAMMAR:
        q = datahub.question_by_no(ref) or {}
        ev["topic"] = {"text": q.get("topic") or q.get("part"),
                       "from": "题库自带 topic 字段", "verified": True}
        ev["origin"] = {"text": "英语语法专项 · 第 %s 页 · %s"
                        % (q.get("page"), q.get("part")),
                        "from": "exercises.json"}
        exp = q.get("explain")
        if exp:
            ev["basis"].append({"kind": "official", "text": exp,
                                "where": "题库自带解析（人工整理，非模型）",
                                "verified": True})
        else:
            ev["gaps"].append("这道语法题题库没带解析")
        return ev

    # ---------- 真题卷：没有解析，只能引原文 ----------
    if source == datahub.SRC_EXAM:
        pid = item.get("part")
        paper, group, raw = datahub.exam_question(pid, item.get("no"))
        if not paper:
            ev["gaps"].append("真题卷里定位不到这道题")
            return ev
        ev["topic"] = {"text": group.get("label"), "from": "卷面题型分组",
                       "verified": True}
        ev["origin"] = {"text": "%s · %s" % (paper.get("name"), group.get("label")),
                        "from": "exam_papers.json · 原卷"}
        mat = group.get("material")
        if mat:
            # 有原文的题型（阅读/完形/七选五）：引文是唯一正当依据。
            # 完形/语法填空的"题干"就是个编号，按题干词重合度去找句永远找不到 ——
            # 得改按空号钉它所在的那一句。
            stem_s = str(item.get("stem") or "").strip()
            if len(_tokens(stem_s)) < 2:
                nos = [q.get("no") for q in (group.get("questions") or [])]
                off = _blank_offset(mat, nos)
                picks = quote_for_blank(item.get("no"), mat, limit=2, offset=off)
                if picks and off:
                    ev["gaps"].append(
                        "原卷短文里的空号比题号大 %d（抽题时前面题型占了编号），"
                        "已按这个位移对齐，引的是原文里同一个空" % off)
                if not picks:
                    ev["gaps"].append("题干里没有可检索的词，也没在原文里定位到这个空所在的句子")
            else:
                picks = pick_quotes(stem_s, mat, limit=3)
            for p in picks:
                ok = _quote_in_material(p["text"], mat)
                ev["basis"].append({
                    "kind": "quote", "text": p["text"],
                    "where": "原文第 %d 句" % (p["index"] + 1),
                    "verified": ok})
            if not picks:
                ev["gaps"].append("题干与原文没有可对上的句子，这题不能靠原文定位")
            ev["context"].append({"text": mat[:600] + ("…" if len(mat) > 600 else ""),
                                  "where": "原文（共 %d 字 / %d 句）"
                                           % (len(mat), len(_sentences(mat)))})
        else:
            # 单选/语法填空：原卷没给解析，本机没有依据
            ev["gaps"].append("这道题原卷只给了答案，没有解析；"
                              "本机也没有可引的原文 —— 想讲清它要接模型讲语法规则")
        return ev

    # ---------- 考点卡：卡内全文就是依据 ----------
    card = datahub.point_card(source) or {}
    full = item.get("full")
    ans = item.get("ans")
    ev["topic"] = {"text": item.get("topic"), "from": "卡片分组字段",
                   "verified": True}
    ev["origin"] = {"text": "%s · 第 %s 条" % (card.get("name"), item.get("no")),
                    "from": "point_cards.json"}
    if full:
        # 卡内 full 是「题目 + 答案」的完整句，但注意：能造出四选一时 ans 已经被
        # 换成字母（B），真正要校验的是原卡里的答案文本 a。所以这里回原卡取 a。
        raw_a = str((datahub._card_item_by_no(source, item.get("no")) or {}).get("a")
                    or ans or "")
        inside = re.sub(r"\s+", "", raw_a) in re.sub(r"\s+", "", str(full))
        ev["basis"].append({"kind": "card_full", "text": full,
                            "where": "卡片原文（含标准答案）",
                            "verified": bool(inside)})
        if not inside:
            ev["gaps"].append("卡片的 full 里居然不含标准答案，这条依据不可信")
    elif ans:
        ev["basis"].append({"kind": "card_ans", "text": ans,
                            "where": "卡片标准答案（无全文）",
                            "verified": True})
    else:
        ev["gaps"].append("这张卡这一条没有答案")
    # 同组其它条目当语境：说明这一组在讲什么，不作依据
    sibs = _card_group(source, item)[:4]
    for s in sibs:
        ev["context"].append({"text": "%s　→　%s" % (s.get("stem"), s.get("ans")),
                              "where": "同组（%s）" % (s.get("part") or card.get("name"))})
    return ev


def verify_quotes(ev):
    """复核：所有 kind=quote 的依据必须能在 context 原文里找到，否则标 verified=False。

    模型讲完后再跑一次，用于计算「引用可靠率」。
    """
    mat = None
    for c in ev.get("context") or []:
        if "原文" in str(c.get("where") or ""):
            mat = c.get("text")
            break
    for b in ev.get("basis") or []:
        if b.get("kind") == "quote":
            if mat is None:
                b["verified"] = False
            else:
                # context 里的原文是截断过的，只在够长时比对
                b["verified"] = _quote_in_material(b.get("text"), mat) if len(mat) > 200 \
                    else b.get("verified", False)
    return ev
