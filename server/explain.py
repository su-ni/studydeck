# -*- coding: utf-8 -*-
"""讲题：把证据组装成四段讲解（纯本地，模型可选）。

为什么不是「把题丢给模型让它解释」：
  那样产出的话没法核对，学生只能赌它没说错。这里反过来 ——
  先把依据捞齐（evidence.py），再让讲解**只说依据支撑得住的话**；
  依据不足就明说「这题本机讲不了，只能靠背」，而不是硬编一段。

四段（docs/AI讲题-重新设计.md）：
  1 定位  这题考什么（来自真题分组 / 题库 topic / 卡片分组，都不是推的）
  2 依据  凭什么这么答（官方解析 / 原文原句 / 卡内全文；每条带出处）
  3 判断  逐个选项对照依据；没有依据支撑的选项标「未验证」，不假装排除
  4 纠错  只在答错时出现，拿他选的去撞依据，指出撞在哪

model='local-evidence' 表示这段完全没有模型参与，每个字都能追到本机数据；
接上模型后同一结构不变，只是「判断」段写得更像是在讲课，且必须带 evidence。
"""
import re

from . import config
from . import datahub
from . import evidence
from . import store

STYLE_STANDARD = "standard"
STYLE_PICK = "pick"        # 只讲正确项为什么对（重做时用）
STYLE_WRONG = "wrong"      # 只讲他选的那项错在哪（错题重做时用）


def _norm(s):
    return re.sub(r"\s+", "", str(s or "")).lower()


_RULE = re.compile(r"^(?P<word>[A-Za-z][A-Za-z'\-]*)\s*[“\"']?(?P<cn>[^”\"']*)[”\"']?"
                r"\s*(?:修饰|需接|接|用于)\s*(?P<what>[^；;。]+)")


def _rules(basis_text):
    """把依据切成分句，认出形如「few“很少”…修饰可数名词复数」这种规则句。

    题库解析是人写的，规则通常压在一句话里用分号串起来：
      few“很少”和many“许多”修饰可数名词复数；little“很少”和much“许多”修饰不可数名词。
    要拿它判选项，得先把规则拆成一条条（词 → 适用对象），否则只能整段字符串比对，
    那既判不准也讲不清。
    """
    out = []
    txt = str(basis_text or "")
    # 先按句号/分号切成"规则块"，再在块内按"和"拆并列词
    for chunk in re.split(r"[；;。\n]", txt):
        chunk = chunk.strip().rstrip("，, ")
        if not chunk:
            continue
        m = re.search(r"(?:修饰|需接|用于)\s*([^；;。，,]+)$", chunk)
        if not m:
            continue
        what = m.group(1).strip()
        head = chunk[:m.start()]
        words = re.findall(r"([A-Za-z][A-Za-z'\-]*)\s*[“\"']", head)
        for w in words:
            out.append({"word": w.lower(), "what": what})
    return out


def _noun_class(stem, ans_word):
    """题干里那个空后面跟的名词是可数还是不可数。

    只有能从规则文本本身读出"可数/不可数"这两个词时才判，否则 None。
    这是能被核对的部分：不可数 → little/much；可数复数 → few/many。
    """
    s = str(stem or "")
    tail = re.split(r"___+|\(_+\)|_____", s)
    if len(tail) < 2:
        return None
    rest = tail[-1].strip()
    m = re.match(r"([A-Za-z][A-Za-z'\-]*)", rest)
    if not m:
        return None
    noun = m.group(1).lower()
    if not noun.endswith("s") or noun.endswith("ss"):
        return "uncountable"        # juice / water / money 这类结尾没 s
    return "countable"


def _sense_hint(ev):
    """依据里的句意线索（肯定/否定）。

    语法题真正卡人的往往不是规则本身 —— 是「few/little = 几乎没有」这类否定义。
    依据原文常写「由……可知果汁所剩无几」，把这半句捞出来当判据，比空说"句意不对"有用。
    """
    for b in ev.get("basis") or []:
        t = str(b.get("text") or "")
        m = re.search(r"(由[^，。；]{0,30}可知[^。；]{0,40})", t)
        if m:
            return m.group(1).strip()
    return ""


def _apply_rule(word, rules, noun_class, ev):
    """把「词 → 修饰什么」这条规则套到题干上，返回 (state, 说明)。

    三层证据强度，越靠后越弱：
      规则明确写了这个词 + 题干名词类别判得出 → 判错，并说出凭什么
      只在规则里出现过，套不上题干          → unknown，明说套不上
      压根没出现                            → unknown，明说依据没谈
    最强的一层才敢判错。剩下的都留在"没谈到"，因为猜错的代价比不说高得多。
    """
    nw = _norm(word)
    mine = [r for r in rules if r["word"] == nw.lower()]
    if not mine:
        blob = _norm(" ".join(str(b.get("text") or "") for b in
                              (ev.get("basis") or [])))
        if nw and nw in blob:
            return "unknown", "依据里出现过这个词，但没说它对不对"
        return "unknown", "依据没谈到这个说法"
    if not noun_class:
        return "unknown", "规则里有它，但题干名词可数与否判不出，套不上"
    want = " ".join(r["what"] for r in mine)
    fits = ("不可数" in want and noun_class == "uncountable") or \
           ("可数" in want and noun_class == "countable" and "不可数" not in want)
    if fits:
        # 语法上它也说得通 —— 这题区分的就不是可数不可数，是句意（肯定/否定）。
        # 依据原文里若有句意线索，就照着说；没有就老实承认它说得通但答案不是它。
        sense = _sense_hint(ev)
        if sense:
            return "wrong", "语法上它说得通，但句意不对：%s" % sense
        return "unknown", "语法上它也说得通，这题靠的是句意（依据没写清是哪一条）"
    return "wrong", "依据规则：%s 只修饰「%s」，题干这里不是" % (word, want)


def _opt_lines(ev):
    """逐个选项对照依据 —— 这是「判断」段的主体。

    三态，宁可说不知道也不猜：
      right    就是标准答案（答案是字母就认字母；答案是文本就认文本）
      unknown  依据里没谈到这个选项 —— 没谈到的，不能替它判错
      wrong    只有在依据里**确实出现了这个选项的说法、且该说法被依据否定**时才判错

    第一版这里写错过：依据里出现「few 修饰可数名词复数」，A 选项正是 few，
    于是被判成「与依据冲突」—— 其实依据是在解释它，不是在否定它。
    同一个词既可能是正确答案的解释对象，也可能是错误答案，
    所以「出现」不等于「冲突」，得看依据对它是肯定还是否定。
    """
    opts = ev.get("opts") or {}
    ans = str(ev.get("ans") or "").strip().upper()
    text_ans = _norm(ev.get("ans_text"))
    bases = [(b.get("text") or "") for b in (ev.get("basis") or [])
             if b.get("verified")]
    blob = _norm(" ".join(str(t) for t in bases))
    rules = []
    for t in bases:
        rules.extend(_rules(t))
    noun_class = _noun_class(ev.get("stem"), (ev.get("opts") or {}).get(ans))
    stem_txt = ev.get("stem")
    at_blank = _at_blank(stem_txt, (ev.get("opts") or {}).get(ans))
    # 空位上原本那个词（题干里 ___ 后面紧跟的词）。跟选项词是同一类词，
    # 才能说「这个选项能填这个空」；不同的（few 对 juice）就是填不进去。
    slot_word = _norm(_slot_word(stem_txt))
    ans_text = _norm((ev.get("opts") or {}).get(ans) or ev.get("ans_text"))
    out = []
    for k in sorted(opts.keys()):
        v = str(opts.get(k) or "")
        nv = _norm(v)
        is_right = (k.upper() == ans) or (text_ans and nv and nv == text_ans)
        if is_right:
            out.append({"opt": k, "text": v, "state": "right", "pos": "standard",
                        "note": "标准答案就写在原卷上"})
            continue
        # 依据里提到这个词，先分「在讲它」还是「只是例句里出现过」——
        # 这个区别要摆出来，不能都叫「依据没谈到」。
        # 只有「空位和选项都是确定的限定词」时才敢说填不进去；
        # 疑问句的倒装（What big ___ the tiger has!）、the number of 这类，
        # 空位后面跟的本来就是别的成分，硬判会误伤。
        if _DET.match(nv) and nv not in ("a", "an", "the") and not _fits_slot(v, slot_word, ans_text, ev):
            # 空位上要的是「juice」这类实词，选项是 few/much 这类限定词 ——
            # 词性对不上，填进去句子不成立。这是题干结构给的结论，不是依据没讲清。
            out.append({"opt": k, "text": v, "state": "unknown", "pos": "other_slot",
                        "note": "空位上要的是「%s」这种词，这个选项填进去句子不成立"
                                % _slot_word(ev.get("stem"))})
            continue
        mentions = _mentions(bases, v)
        if not mentions:
            out.append({"opt": k, "text": v, "state": "unknown", "pos": "absent",
                        "note": "依据没谈到这个说法"})
            continue
        ruleset = []
        for t in mentions:
            ruleset.extend(_rules(t))
        verdict, why = _apply_rule(v, ruleset or rules, noun_class, ev)
        # 依据在讲它，但它不在题干那个空位上——例句里的位置不能拿来判这题。
        if verdict == "wrong" and at_blank is False:
            out.append({"opt": k, "text": v, "state": "unknown", "pos": "elsewhere",
                        "note": "依据是在讲它（原文：%s），可题干那个空位不是它——凭现有依据排除不了"
                                % _clip(mentions[0], 26)})
            continue
        out.append({"opt": k, "text": v, "state": verdict, "pos": "here", "note": why})
    return out


def _clip(s, n):
    s = str(s or "").replace(chr(10), " ").strip()
    return s if len(s) <= n else s[:n] + "…"


def _mentions(bases, word):
    """依据里**确实在讲这个词**的句子（不是随便出现一下）。

    判据只有两条：这个词被引号括起来，或者紧跟着「修饰/表示/用于/指」
    这类在解释它的动词。只做到这一步，多的不猜。
    """
    w = str(word or "").strip()
    if not w:
        return []
    # 匹配一律从词本身开始写（前面不加任何元字符）。
    # 原因：这个 Python 构建里「元字符 + 字面量」的前缀匹配行为不稳，
    # 写 .few / [“”]few 会漏；写成 few 打头则稳定。
    e = re.escape(w)
    quots = "".join([chr(8220), chr(8221), chr(39), "`"])
    pat = e + "(?:[" + quots + "]|" + r"\s*(?:只|仅)?\s*(?:修饰|表示|用于|指|后面接|后接))"
    out = []
    for t in bases:
        for piece in re.split(r"[\uff1b;\u3002\n]", str(t or "")):
            m = re.search(pat, piece)
            if m:
                out.append(piece.strip())
    return [p for p in out if p]


def _strip_bracket_hints(s):
    """去掉题干里的括号提示词：___ (juice) 这类。

    提示词是给考生的线索（把词变成正确形式），不是空位上要填的东西，
    留着它的话「空位后面第一个词」永远是提示词本身，位置判断就全错了。
    """
    return re.sub(r"[\(\uff08]\s*[A-Za-z][A-Za-z '’\-]*[\)\uff09]", " ", str(s or ""))


def _at_blank(stem, word):
    """这个词是不是就落在题干那个空位上（True/False），判不出就 None。

    语法填空题干常带括号提示 —— 「There is little ___ (juice) left.」——
    空位后面紧跟的是提示词，不是这个位置上要填的词。所以要先切掉
    空格＋括号提示，再看空位后面第一个英文词。
    """
    s = str(stem or "")
    w = str(word or "").strip()
    if not w or not re.search(r"___+|\(_+\)", s):
        return None
    s = _strip_bracket_hints(s)
    parts = re.split(r"___+|\(_+\)", s)
    if len(parts) < 2:
        return None
    head = parts[-1].lstrip()
    m = re.match(r"([A-Za-z][A-Za-z'\-]*)", head)
    if not m:
        return None
    return m.group(1).lower() == w.lower()


def _ans_at_blank(stem, ans_opt):
    """标准答案落不落在题干空位上。

    只看「空位后面紧跟的那个词是不是它」—— 不能拿选项文本去比，
    因为选项就是这些词本身，永远相等，判出来恒为 True。
    """
    hit = _at_blank(stem, (stem and _slot_word(stem)) or "")
    return hit


_DET = re.compile(r"^(?:a|an|the|this|that|these|those|my|your|his|her|our|their|its|"
                   r"some|any|no|every|each|another|other|much|many|(?:a )?few|(?:a )?little|"
                   r"enough|more|most)$")


def _fits_slot(opt_text, slot_word, ans_text, ev):
    """把选项填进空位以后句子还成不成立 —— 只看最粗的一层：是不是同类词。

    判据（任一成立就算能填，能填就交给依据去判）：
      · 就是标准答案本身
      · 选项词与空位上那个词有包含关系（juice / juices）
    「few / much 这类限定词 vs juice 这类名词」词类不同 → 填不进去。
    词类拿不到就返回 True（宁可说判不了，不硬判）。
    """
    v = _norm(opt_text)
    sw = _norm(slot_word)
    at = _norm(ans_text)
    if not v:
        return True
    if at and (v == at or v in at or at in v):
        return True
    if not sw:
        return True
    if v == sw or v in sw or sw in v:
        return True
    if _DET.match(v) and not _DET.match(sw):
        return False
    if _DET.match(sw) and not _DET.match(v):
        return False
    return True


def _slot_word(stem):
    """题干空位后面紧跟的那个英文词（空位上要填的东西）。"""
    s = _strip_bracket_hints(stem)
    parts = re.split(r"___+|\(_+\)", s)
    if len(parts) < 2:
        return ""
    m = re.match(r"([A-Za-z][A-Za-z'\-]*)", parts[-1].lstrip())
    return m.group(1) if m else ""


def _locate(ev):
    t = ev.get("topic") or {}
    o = ev.get("origin") or {}
    return {"text": t.get("text") or "题源没标考点",
            "from": t.get("from") or "",
            "origin": o.get("text") or "",
            "origin_from": o.get("from") or ""}


def _basis_lines(ev):
    """依据列表。where 不只标出处，还标「它在依据里是什么角色」。

    同一段文字，对标准答案是解释、对别的选项是旁证 —— 都得说清楚，
    否则读的人会以为依据在支持所有选项。
    """
    out = []
    for b in (ev.get("basis") or []):
        kind = b.get("kind")
        role = {"official": "官方解析原文",
                "quote": "原卷原文，逐字核对过",
                "card_full": "卡片全文（标准答案在里面）",
                "card_ans": "卡片标准答案（这张卡没有全文）"}.get(kind, "依据")
        where = b.get("where") or ""
        # 出处文字里已经带了同样的角色（例如卡片的 where 就叫「卡片标准答案」），不重复写。
        if where and (role[:4] in where or where[:4] in role):
            shown = where
        else:
            shown = role + ("　·　" + where if where else "")
        out.append({"kind": kind, "role": role, "text": b.get("text"),
                    "where": shown, "verified": bool(b.get("verified"))})
    return out


def _confidence(ev):
    """这一讲有多可信 —— 用能核对的东西算，不拍脑袋。

    依据只要有一条没过复核，整段就打折：讲解的价值全押在依据上。
    一条依据都没有的题（原卷只给答案的单选题）置信度直接压到 0.2，
    它照样能讲，但界面上必须看起来就像「这题没什么可讲的」。
    """
    basis = ev.get("basis") or []
    if not basis:
        return 0.2
    ok = sum(1 for b in basis if b.get("verified"))
    ratio = ok / float(len(basis))
    kinds = {b.get("kind") for b in basis}
    weight = {"official": 1.0, "quote": 0.95, "card_full": 0.95,
              "card_ans": 0.85}.get(sorted(kinds)[0], 0.8)
    gaps = ev.get("gaps") or []
    pen = 0.15 * len(gaps)
    return round(max(0.05, min(1.0, ratio * weight - pen)), 3)


def _verdict(conf, ev):
    if not ev.get("found"):
        return "讲不了", "题源里找不到这道题，没有依据可讲。"
    if not (ev.get("basis") or []):
        return "只能靠背", "这道题本机捞不到任何依据（原卷只给了答案）。" \
                          "硬讲就是编，所以只把标准答案给你。"
    if conf >= 0.85:
        return "有据可依", "依据来自本机真实资料，且通过了逐条复核。"
    if conf >= 0.6:
        return "依据部分成立", "有依据，但有地方没复核过，看完自己再核一遍。"
    return "证据偏弱", "依据不全，这段只当提示，别当结论。"


# 五科讲次/资料里出现过的考点名 —— 只要命中，就能把这道题钉回本机资料
# （哪怕它本身没解析，也不用硬背）。这是「可定位」这条路的全部依据。
_ANCHOR_ALIAS = {
    "词汇与语法单选": ["词汇", "语法", "词性", "名词", "动词", "形容词", "副词", "介词",
                       "连词", "代词", "时态", "从句", "非谓语"],
    "完形填空": ["完形", "上下文", "词义辨析"],
    "阅读理解": ["阅读", "篇章", "主旨", "细节"],
    "阅读第二节 · 七选五": ["七选五", "篇章结构", "衔接"],
    "语言运用第二节 · 语法填空": ["语法填空", "词形变化", "非谓语"],
}


def _anchor_note(source, ev):
    """这道题在本机资料里有没有落点。

    有落点 ≠ 有答案。真题卷 430 道词汇语法单选原卷只给答案，
    但它们几乎都落在语法题库的 19 个分部和 364 讲英语课的考点词表上。
    说清「钉在哪一讲/哪一部分」，比假装读过原卷实在。
    """
    topic = (ev.get("topic") or {}).get("text") or ""
    grp = ""
    if source.startswith("pc-"):
        raw = datahub._card_item_by_no(source, ev.get("ref") or "")
        grp = (raw or {}).get("grp") or ""
    label = topic or grp
    if not label:
        return ""
    hits = []
    for key, words in _ANCHOR_ALIAS.items():
        if key in label:
            hits = [w for w in words if w]
            break
    return ("钉在「%s」上 —— 本机资料里对应 %s 的讲次与练习。"
            % (label, "、".join(hits[:3]) if hits else "同一条目" ))


def build(source, ref, chosen=None, style=STYLE_STANDARD):
    """组装一段四段式讲解（**不落库**，纯计算）。"""
    ev = evidence.gather(source, ref, chosen=chosen)
    if not ev.get("found"):
        return {"source": source, "ref": ref, "found": False,
                "verdict": "讲不了", "verdict_note": ev["gaps"][0],
                "confidence": 0.0, "model": "local-evidence",
                "evidence": ev}

    # 原卡答案文本（造过四选一后 ans 变成字母了，纠错时要拿文本比）
    raw = datahub._card_item_by_no(source, ref) if source.startswith("pc-") else None
    ev["ans_text"] = (raw or {}).get("a") or ""

    conf = _confidence(ev)
    verdict, note = _verdict(conf, ev)
    opts = _opt_lines(ev) if isinstance(ev.get("opts"), dict) else []

    # 本机资料里能不能给这个考点找出处（语法题库的 part / 考点卡的 grp）
    anchor = _anchor_note(source, ev)
    if anchor and not (ev.get("basis") or []):
        verdict = "无解析 · 可定位"
        note = anchor
    elif anchor and anchor not in (note or ""):
        note = (note or "") + "　" + anchor

    lo = _locate(ev)
    parts = []
    parts.append({"key": "locate", "title": "定位",
                  "text": ("这题考的是「%s」" % lo["text"]) if ev.get("topic") else
                          "题源没给考点标签，只能按题干判断。",
                  "from": lo["from"],
                  "origin": lo["origin"], "origin_from": lo["origin_from"]})

    bl = _basis_lines(ev)
    if bl:
        # 「依据」是库里能逐字核对的原文，跟「题库自带解析」不是一回事：
        # 很多真题只有答案没有解析，依据是从考点卡/同考点题里找到的旁证。
        # 这层区别必须写在文案里，否则人会以为上面说「没有解析」和这里有「依据」互相打脸。
        parts.append({"key": "basis", "title": "依据",
                      "text": "共 %d 条依据，%d 条通过复核。依据是库里能核对的原文（考点卡、题库、讲次），不是现编的解析。"
                              % (len(bl), sum(1 for b in bl if b["verified"])),
                      "lines": bl})
    else:
        parts.append({"key": "basis", "title": "依据",
                      "text": ("捞不到依据 —— 原卷只给了答案没给解析。" if source == datahub.SRC_EXAM
                               else "捞不到这道题的依据。"),
                      "lines": []})

    # 背景材料：不作依据，只帮理解。以前 evidence 捞了但这里没输出，等于白捞 ——
    # 阅读原文那 600 字、同考点参照题，全都没到人眼前。
    ctx = ev.get("context") or []
    if ctx:
        parts.append({"key": "context", "title": "参考",
                      "text": "下面这些不是这道题的依据，只是帮你理解这类考法。"
                              "引文对不上原题的时候，宁可不看。",
                      "lines": [{"text": c.get("text"), "where": c.get("where"),
                                 "verified": c.get("verified")} for c in ctx]})

    if opts:
        absent = [o["opt"] for o in opts if o.get("pos") == "absent"]
        elsewhere = [o["opt"] for o in opts if o.get("pos") == "elsewhere"]
        other = [o["opt"] for o in opts if o.get("pos") == "other_slot"]
        killed = [o["opt"] for o in opts if o.get("state") == "wrong"]
        t = "标准答案 %s。" % (ev.get("ans") or "?")
        bits = []
        if killed:
            bits.append("%s 依据明确否掉了" % "、".join(killed))
        if elsewhere:
            bits.append("%s 依据讲过、可讲的是别的位置，套不到这个空上" % "、".join(elsewhere))
        if other:
            bits.append("%s 填进去句子不成立（空位上要的是「%s」）"
                        % ("、".join(other), _slot_word(ev.get("stem")) or "别一种词"))
        if not bits and len(opts) > 1:
            bits.append("其余选项依据里没提，也不替你判错")
        if bits:
            t += "其余选项：" + "；".join(bits) + "。"
        parts.append({"key": "judge", "title": "判断", "text": t, "opts": opts})
    else:
        exp = (raw or {}).get("a") or ev.get("ans") or ""
        parts.append({"key": "judge", "title": "判断",
                      "text": ("标准答案：%s" % exp) if exp else "这题没有可判的答案。",
                      "opts": []})

    if chosen:
        c = str(chosen).strip()
        right = str(ev.get("ans") or "").strip()
        is_right = c.upper() == right.upper() or _norm(c) == _norm(ev.get("ans_text"))
        line = ""
        if is_right:
            line = "你选的是 %s，和标准答案一致。" % c
        else:
            line = "你选的是 %s，标准答案是 %s。" % (c, right)
            # 撞证据：他选的那个选项文本在依据里出现过吗
            pick = (ev.get("opts") or {}).get(c) or c
            blob = _norm(" ".join(str(b.get("text") or "")
                                  for b in (ev.get("basis") or [])))
            if _norm(pick) and _norm(pick) in blob:
                line += "你选的「%s」在依据里确实出现过 —— 但它不是这题问的那个。" % pick
            else:
                line += "你选的「%s」在依据里找不到，属于原文没提过的说法。" % pick
        parts.append({"key": "fix", "title": "纠错", "text": line,
                      "right": is_right})

    for g in ev.get("gaps") or []:
        parts[-1].setdefault("gaps", []).append(g)

    return {
        "source": source, "ref": ref, "found": True,
        "stem": ev.get("stem"), "opts": ev.get("opts"), "ans": ev.get("ans"),
        "ans_text": ev.get("ans_text"), "chosen": chosen,
        "verdict": verdict, "verdict_note": note,
        "confidence": conf, "model": "local-evidence",
        "verified": bool(bl) and all(b["verified"] for b in bl),
        "parts": parts, "gaps": ev.get("gaps") or [],
        "evidence": ev,
    }


def explain(source, ref, chosen=None, style=STYLE_STANDARD, save=True, use_model=None):
    """讲一道题，并留底。返回的就是要发给前端的那份。

    use_model：None = 看 config.ENABLE_LLM（默认行为）；False = 强制只走本机证据版。
    两条路产出的结构完全一样，只有 model 字段不同 —— 所以同一个界面能并排演示
    「本机版」与「模型版」，这本身就是讲题准不准的证据。
    """
    doc = build(source, ref, chosen=chosen, style=style)
    want_model = config.ENABLE_LLM if use_model is None else bool(use_model)
    if want_model and doc.get("found"):
        from . import model_pass
        doc = model_pass.enhance(doc, doc.get("evidence") or {})
    if save and doc.get("found"):
        try:
            store.save_explain(source, ref, style, doc, doc.get("evidence") or {},
                               doc.get("confidence") or 0, doc.get("model"),
                               doc.get("verified"))
        except Exception:       # 留底失败不能连带讲解一起失败
            pass
    return doc
