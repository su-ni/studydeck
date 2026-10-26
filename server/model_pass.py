# -*- coding: utf-8 -*-
"""讲题 · 模型层（第 4 步）。

分工必须说清楚，否则又会变成「模型随便讲」：

  evidence.py   捞证据（纯本地，零模型）—— 依据是死的
  llm.py        发请求（只管把文本拿回来）
  explain.py    组装四段（本机证据版，一个字都不用模型）
  model_pass.py 本文件：让模型**只在已捞出的证据上**把判断段说成人话

三条硬规矩，全部由代码强制，不靠提示词自觉：
  R1 只许用 given evidence。模型返回的每个 quote 必须在依据文本里**逐字**出现，
     找不到就丢掉这一句。整段一句都对不上 → 整段作废，退回本机证据版。
  R2 不许改答案。模型如果说标准答案是别的，直接判它错，整段作废。
  R3 讲完留底可比对。落库时 model 字段写真实模型名，confidence 按引文命中率打折，
     学生点「讲错了」能打回 —— 模型版和本机版永远并排存在，谁都盖不掉谁。
"""
from __future__ import annotations

import json
import re

from . import config
from . import llm
from . import model_router

_SYS = (
    "你是一名专升本辅导老师，正在给一名学生讲一道他刚做过的题。\n"
    "你只能使用「给定依据」里出现过的内容，不许引入外部知识，不许猜。\n"
    "给定的依据可能很少，甚至只有一条。依据不够就直接说依据不够，不要补充。\n"
    "必须输出 JSON，不要输出任何别的文字。"
)

_TMPL = """题源：{source}
题目：{stem}
{opts}
标准答案：{ans}
学生选的：{chosen}

给定依据（只能引用这里面的原句）：
{basis}

请输出如下 JSON：
{{
  "judge": "为什么这个答案对，以及其它选项错在哪。只根据给定依据说话。",
  "fix": "学生选的那个错在哪；他没选错就写空字符串。",
  "quotes": ["从依据里逐字抄下来的原句，最多 3 句"],
  "insufficient": false
}}

要求：
- quotes 里的每一句必须从上面的「给定依据」里逐字抄，不许改写、不许拼接、不许翻译。
- 学生没作答时 chosen 为空，fix 写空字符串。
- 如果依据不足以判断，把 insufficient 写成 true，并在 judge 里说明缺什么。
"""


def _basis_blob(ev):
    """把依据拼成给模型看的文本块（逐字原文，不做任何加工）。"""
    lines = []
    for i, b in enumerate(ev.get("basis") or []):
        t = (b.get("text") or "").strip()
        if t:
            lines.append("[%d] %s" % (i + 1, t))
    return "\n".join(lines) if lines else "（没有依据）"


def _opts_block(ev):
    opts = ev.get("opts")
    if not isinstance(opts, dict) or not opts:
        return "（这题没有选项，是填空/简答）"
    return "选项：\n" + "\n".join("%s. %s" % (k, v) for k, v in opts.items())


def _check_quotes(quotes, blob):
    """R1：每一句引文都必须逐字出现在依据里。

    比较时只抹掉空白和全角/半角差异，不做同义替换 —— 同义替换就是把
    「模型编的」当成「原文说的」，这正是要防的东西。
    """
    norm = re.sub(r"\s+", "", blob or "")
    out, bad = [], []
    for q in quotes or []:
        q = str(q or "").strip()
        if not q:
            continue
        if re.sub(r"\s+", "", q) in norm:
            out.append(q)
        else:
            bad.append(q)
    return out, bad


def _ans_ok(ev, ans):
    """R2：模型不许改答案。它没提答案算通过（它本来也没被要求复述答案）。"""
    if not ans:
        return True
    a = str(ans).strip()
    b = str(ev.get("ans") or "").strip()
    if not b:
        return True
    return a.upper() == b.upper() or a == b or a in b or b in a


def enhance(doc, ev=None):
    """拿本机证据版讲解 doc，让模型把「判断」「纠错」两段说得像人话。

    返回新的 doc（不改入参）。任何一步不过校验，就原样返回 doc ——
    界面照常显示本机证据版，只是 model 字段不是模型名，学生看不出差别，
    但我们自己（和统计页）知道这段是不是模型写的。
    """
    ev = ev or doc.get("evidence") or {}
    ok, why = model_router.available()
    if not ok:
        doc["model_pass"] = {"ok": False, "reason": why}
        return doc

    basis = _basis_blob(ev)
    if basis == "（没有依据）":
        # 没有依据就没有能引的原文，硬让模型讲必然变成编。这一步直接不做。
        doc["model_pass"] = {"ok": False, "reason": "这条题本机没捞到依据，模型没东西可讲"}
        return doc

    user = _TMPL.format(
        source=ev.get("source") or "",
        stem=ev.get("stem") or "",
        opts=_opts_block(ev),
        ans=ev.get("ans") or ev.get("ans_text") or "（题库没给）",
        chosen=doc.get("chosen") or "（没作答）",
        basis=basis,
    )

    last = {"ok": False, "reason": "没跑"}
    for attempt in range(config.EXPLAIN_MAX_RETRY + 1):
        r = model_router.chat(_SYS, user)
        if not r.get("ok"):
            last = {"ok": False, "reason": r.get("reason")}
            break
        obj, err = llm.parse_json(r.get("text"))
        if obj is None:
            last = {"ok": False, "reason": err}
            continue

        quotes, bad = _check_quotes(obj.get("quotes"), basis)
        hit = (len(quotes) / (len(quotes) + len(bad))) if (quotes or bad) else 0.0
        if quotes and hit < config.EXPLAIN_MIN_QUOTE_HIT:
            last = {"ok": False, "reason": "引文对不上原文：%s" % (bad[0][:40] if bad else "")}
            continue
        if not _ans_ok(ev, obj.get("answer")):
            last = {"ok": False, "reason": "模型想改答案，作废"}
            continue

        # 把模型的话装回四段结构：只替换 judge / fix 的正文，
        # 依据段和选项三态一律保留本机的（那是能核对的，不能被覆盖）。
        parts = []
        for p in doc.get("parts") or []:
            p = dict(p)
            if p.get("key") == "judge" and str(obj.get("judge") or "").strip():
                p["text_local"] = p.get("text") or ""
                p["text"] = str(obj["judge"]).strip()
                p["by"] = "model"
                p["quotes"] = quotes
            elif p.get("key") == "fix" and str(obj.get("fix") or "").strip():
                p["text_local"] = p.get("text") or ""
                p["text"] = str(obj["fix"]).strip()
                p["by"] = "model"
                p["quotes"] = quotes
            parts.append(p)

        out = dict(doc)
        out["parts"] = parts
        out["model"] = r.get("model") or model_router.model_of()
        out["model_provider"] = r.get("provider") or model_router.current()
        out["model_pass"] = {"ok": True, "quotes": len(quotes), "dropped": len(bad),
                             "insufficient": bool(obj.get("insufficient")),
                             "attempt": attempt + 1}
        # 有模型参与，置信度按引文命中率打折：模型说得再像，没引到原文就不该满信心
        base = float(doc.get("confidence") or 0)
        out["confidence"] = round(max(0.05, min(1.0, base * (0.85 + 0.15 * hit))), 3)
        return out

    out = dict(doc)
    out["model_pass"] = last
    return out
