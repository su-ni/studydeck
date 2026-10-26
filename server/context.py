# -*- coding: utf-8 -*-
"""研学台 · 上下文管理（对标 Trae / WorkBuddy 的"记忆"）。

为什么需要它：

    原来 _render_ctx 是 msgs[-24:] —— 硬截断。
    工具轨迹（trace）本身也占 msgs 的行，一轮串 15 次工具就能把那 24 行吃光，
    于是"人三句前刚说过每天能学 3 小时"这件事被挤出去了。
    人看到的表现就是：**它失忆了**。

    这里改两件事：
    1. 每次拼上下文时，把"老的那一截"压成一份摘要留在最前面（谁说了什么、
       定了哪些数），近的若干条保留原文。
    2. 摘要不是模型现编的 —— 它由本机的真实函数生成：数字是从 msgs 里挑出来的
       用户原话 + 工具写过的 KV。**没有一段是猜的**。
       这一点很重要：压缩只许丢措辞，不许凭空生成事实。
"""
from __future__ import annotations

import re

# 近多少行保留原文。太少了人会觉得它在忘事，太多了压不下去。
KEEP_TAIL = 18
# 上下文吃紧时收到多少。7 条 = 最近两三个来回，够它接着上一步往下做。
KEEP_TAIL_TIGHT = 7


def _tools_seen(msgs):
    """早先那些轮真调过哪些工具（从本机记录里挑，不是模型自己说的）。

    这一行比什么都值：模型失忆之后最常见的毛病是把同一件事重搜一遍，
    或者把上轮"查不到"的猜测当成事实。把工具名摆给它看，它就知道哪些已经查过了。
    """
    out = []
    for m in msgs:
        for x in (m.get("trace") or []):
            nm = (x or {}).get("tool") or ""
            if nm and nm not in out:
                out.append(nm)
    return out


def _txt(m):
    """一条消息的正文。content 有可能是 dict（工具结果原样塞回来的），统一转文本。

    原来这里直接 .strip()，一旦上下文里混进一条 dict 就整个 turn 崩掉 ——
    表现是"算崩了：'dict' object has no attribute 'strip'"，看不出跟上下文有关。
    """
    c = m.get("content") if isinstance(m, dict) else m
    if isinstance(c, dict):
        try:
            import json as _j
            return _j.dumps(c, ensure_ascii=False)
        except Exception:
            return str(c)
    return (c or "") if isinstance(c, str) else str(c or "")


def _is_fact(s):
    """这句话里带不带"只有人知道、必须记住"的东西。

    考哪天、每天多少分钟、学哪几科、分数目标 —— 这些丢了，
    后面它就会再问一遍，或者拿默认值瞎排。
    """
    t = s or ""
    if not t:
        return False
    pats = (r"\d{4}\s*[-/.年]\s*\d{1,2}",          # 日期
            r"\d+\s*月", r"\d+\s*日",
            r"\d+\s*(分钟|小时|个?小时|min|h)\b",   # 时长
            r"\d+\s*\u5206",                        # 分数
            r"(每天|每日|一周|每周|周末|早上|晚上|下班|上班)",
            r"(高等数学|高数|英语|政治|计算机|C\s*语言|语文|数学|管理学|专业课)",
            r"(考|科目|哪几科|目标|志愿|学校)")
    return any(re.search(p, t) for p in pats)


def _facts(msgs):
    """把用户说过的"关键事实"挑出来（原话，不加工）。"""
    out = []
    for m in msgs:
        if m.get("role") != "user":
            continue
        c = _txt(m).strip()
        if c and _is_fact(c) and c not in out:
            out.append(c)
    return out


def _said(msgs, n=6):
    """老对话里助手说过什么 —— 只留第一句，够看出"聊过这件事"就行。"""
    out = []
    for m in msgs:
        if m.get("role") != "assistant":
            continue
        c = _txt(m).strip().replace("\n", " ")
        if not c:
            continue
        if "{" in c and "action" in c:
            continue                     # 动作 JSON 不是人话
        out.append(c[:80])
    return out[-n:]


# 最近一次拼上下文时的真实数字。状态条点开详情读它 —— 全是数出来的，不是算出来的。
LAST = {}


def digest(msgs, keep_tail=None, tight=False):
    """返回 (头部摘要文本, 保留原文的行)。

    宁可少压一点：拿不准就不压。压错一句"每天 3 小时"比多占 200 token 贵得多。

    tight=True 是"上下文真的吃紧了"（由 agent 按实测 prompt_tokens / 窗宽判定），
    这时尾部从 18 条收到 7 条，摘要里多补一行"早先真调过哪些工具" ——
    模型失忆后最爱干的事就是把查过的东西重查一遍。
    """
    if keep_tail is None:
        keep_tail = KEEP_TAIL_TIGHT if tight else KEEP_TAIL
    msgs = [m for m in msgs if _txt(m).strip()]
    total_chars = sum(len(_txt(m)) for m in msgs)
    if len(msgs) <= keep_tail + 4:
        LAST.clear()
        LAST.update({"total": len(msgs), "kept": len(msgs), "folded": 0,
                     "head_chars": 0, "ctx_chars": total_chars, "tight": bool(tight)})
        return "", msgs
    old, recent = msgs[:-keep_tail], msgs[-keep_tail:]
    facts = _facts(old)
    said = _said(old)
    tools = _tools_seen(old)
    lines = ["【早先聊过的（系统压缩，是原话摘出来的，不是编的）】"]
    if facts:
        lines.append("用户说过的关键事实：")
        for f in facts[-8:]:
            lines.append("  · " + f[:120])
    if said:
        lines.append("你已经说过的（摘要）：")
        for s in said:
            lines.append("  · " + s)
    if tools:
        lines.append("早先你已经真调过这些工具（别再从头查一遍）：" + "、".join(tools[:10]))
        if len(tools) > 10:
            lines.append("  （还有 %d 个，从略）" % (len(tools) - 10))
    if not facts and not said and not tools:
        lines.append("（前面那几轮没有留下需要记住的东西）")
    lines.append("【以下是最近的对话原文】")
    head = "\n".join(lines)
    kept_chars = sum(len(_txt(m)) for m in recent)
    LAST.clear()
    LAST.update({"total": len(msgs), "kept": len(recent),
                 "folded": len(msgs) - len(recent), "head_chars": len(head),
                 "ctx_chars": len(head) + kept_chars, "tight": bool(tight)})
    return head, recent


def status():
    """上一份上下文的真实构成。没拼过就是空 dict。"""
    return dict(LAST) if LAST else {}

