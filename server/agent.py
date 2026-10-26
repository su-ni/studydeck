# -*- coding: utf-8 -*-
"""研学台 · 对话 agent。

为什么要有这一层（以及它和 intake 的区别）：

    intake 是一条固定流水线：听 → 翻本机 → 搜网 → 核一遍 → 拟计划。
    它的问题不是写得差，是**它替用户决定了要干什么** —— 人只想随便问一句
    「这词怎么记」，它也会把人拖过五站。这层反过来：模型自己决定说什么、
    要不要动工具、动哪个。五站退化成一个普通工具（intake_*），谁需要谁调。

设计约束：

1. **工具不写清单**。全部 113 个工具都在 tools.REGISTRY 里，这里不维护第二份名字表。
   给模型看的是 find_tool 检索到的条目，不是一次塞 113 行的巨型 schema ——
   塞满了模型反而挑不准，还白烧 token。
2. **循环有上限**。模型可以连续调工具，但一轮最多 MAX_ROUND 次，
   第 N 次之后强制要它给结论。防止它在一个查不到的东西上原地打转。
3. **每一步都留痕**。每次调用记进返回的 trace（工具名、参数、耗时、成败、结果摘要），
   前端右侧轨迹栏画的就是这个。没有 trace 的"我查了"等于没查。
4. **写盘要人点头**。tools.call 本身对 PERM_CONFIRM 会返回 need_confirm；
   这里不吞掉它，原样作为一个 pending 交给前端，人点了才带 confirmed=True 重放。
5. **不编**。模型说要调一个不存在的工具、或工具报错，就把错误原样回灌给模型，
   让它自己决定改口还是换个工具 —— 绝不在这里替它编一个结果。
"""
from __future__ import annotations

import json
import inspect
import re
import threading
import time

from . import config
from . import context
from . import datahub
from . import model_router
from . import store
from . import tools

# 一轮对话里模型最多连着调几次工具。超了就要求它收口。
# 12 不够用：核 6 条课的集数和时长就是 6 次 verify，加搜课、找工具、拟计划，
# 一轮很自然就过 12。给到 20，并且到 2/3 处开始提醒它「别再搜了，收口」。
MAX_ROUND = 200

# 「停一下」：用户按停之后，turn() 在最近的检查点收口（当前这一步模型调用
# 或工具跑完就停，不掐正在跑的请求 —— 掐了会让会话留下半截不明状态）。
_STOP = threading.Event()


def request_stop():
    """让正在跑的那一轮尽快停下。真正的检查点在 turn() 的循环里。"""
    _STOP.set()
    return {"ok": True, "note": "已发出停止信号，这一步跑完就停"}


# 上下文压缩：什么时候自动收紧。
# 口径只有一个 —— 上一次实测的 prompt_tokens 除以这个模型的窗口。
# 两个数任何一个拿不到就**不收紧**（宁可多占，也不凭字数猜一个百分比出来）。
CTX_TIGHT_AT = 0.68
# 用户手动点过「压缩」之后置位：尾部固定只留 7 条，直到再点一次解除。
_FORCE_TIGHT = [False]


def _pressure():
    """上一次实测的上下文占用（0~1）。拿不到返回 None。"""
    try:
        from . import platform_ai
        u = platform_ai.last_usage() or {}
        p = u.get("prompt_tokens")
        win = model_router.ctx_of() or 0
        if isinstance(p, int) and p > 0 and win > 0:
            return p / float(win)
    except Exception:
        pass
    return None


def set_compact(on=True):
    """手动压缩开关。返回的是**真折叠出来的数字**，不是承诺。

    打开之后每一轮拼上下文都按最紧的口径：只留最近 7 条原文，早先的压成
    原话摘要（用户说过的关键事实 + 助手说过的摘要 + 真调过哪些工具）。
    摘要由本机函数生成，不是让模型现编 —— 压缩只丢措辞，不丢数字。
    """
    _FORCE_TIGHT[0] = bool(on)
    if not on:
        return {"ok": True, "on": False,
                "note": "回到自动：实测占用超过窗口 %d%% 才收紧。" % int(CTX_TIGHT_AT * 100)}
    msgs = _load()
    head, tail = context.digest(msgs, tight=True)
    st = context.status()
    return {"ok": True, "on": True, "total": st.get("total"), "kept": st.get("kept"),
            "folded": st.get("folded"), "head_chars": st.get("head_chars"),
            "note": ("以后每一轮都按这个口径拼：只留最近 %d 条原文，早先 %s 条压成原话摘要。"
                     "再点一次解除。") % (st.get("kept"), st.get("folded"))}
# 收口提醒从第几轮开始加（到这儿还没收工，就得催它了）
WARN_ROUND = 12
# 一轮里工具返回塞回上下文的字符上限。工具结果经常上千行，全塞进去会把窗口吃光。
TOOL_CLIP = 1600
# 超长结果不砍头，先按「骨架保留 + 长列表压成摘要」瘦身一遍。
# 实测教训：intake_state 返回 17411 字符，candidates[0].bvid 在第 3354 个字符 ——
# 原来的 _clip 直接砍掉后 93%，模型是真没看见 BV 号，才回「号没带出来，你发我」。
TOOL_LIST_KEEP = 3
# 长期记忆：存在 kv 里的会话列表（只留最近 N 轮，太老的不值得占上下文）
KV_THREAD = "agent.thread"
KV_THREAD_BAK = "agent.thread.bak"      # reset 之前留的那一份，误触了能捞回来
KV_CUR = "agent.current_session"        # 当前会话 id（界面切会话就改这个键）

# 一轮对话的上下文，只给 _emit_turn 用。用 threading.local 而不是模块级变量：
# 同步接口跑在线程池里，两个请求同时进来时全局变量会互相串。
_TL = threading.local()
RKV_EFFORT = "agent.effort"      # 思考强度：low / medium / high
THREAD_MAX = 60


# 提示模型「怎么回一个动作」。放在模块级是因为这段文字里全是双引号，
# 在函数里用 % 拼会跟字符串引号打架，写错过两次。
_CALL_HINT = '要用就按 {"action":"call","tool":"名字","args":{...}} 回我。'

# 反过来：有些事只有人知道（考哪天、每天多久、要学哪几科），
# 这时候别在正文里问一句话让人自己打字 —— 用 ask 动作，界面会把它画成可点的选项。
_ASK_HINT = ('要人就回 {"action":"ask","questions":[{"question":"一句话问题","options":["选项A","选项B"],'
             '"multi":false}]}。一次问几件事就并列几个；选项是字符串数组，'
             '也可以写成 [{"label":"…","value":"…"}]。')
SYS = """你是「研学台」里的助手。这台机器是一个专升本学习工具，本地有课程、题库、真题卷、
背单词数据和笔记画布。你不是客服，也不是表单：你就是一个能聊的助手。

说话规矩：
- 用中文，像人一样说话。不铺垫、不复述用户的话、不说「好的，我来帮你」这类客套。
- 一次只说该说的。用户问一句短的，你就答一句短的。
- 不知道就说不知道。做不到就说做不到，并说明差什么。绝不编数据、绝不编工具结果。
- 用户只是闲聊、问概念、让你改个错别字，就正常聊，**不要**调任何工具。
- 只有当用户真的需要本机数据或需要动本机的东西时，才调工具。

**「本机没有」不是答案，是去搜的理由（这条最要紧）**：
- 用户说想学什么、想找什么资料、问到本机没存的东西时，**第一件事是出去搜**：
  web_search（视频 + 网页一次搜两路）、bili_search（只搜 B 站课）、web_fetch（把一条结果打开读正文）。
  本机没数据 ≠ 这件事办不成 —— 你手上有网，搜完把候选摆出来让人挑。
- **绝对不许**在只翻过本机之后就回「本机没有相关课程」然后收工。那是把「我没找」说成了「没有」。
- **只有工具真返回的才算依据。** 对话记录里你自己上一轮说过的话，不是依据 ——
  它会随上下文被压缩、被你自己的猜测污染。要核一件事就再调一次工具，
  别写「之前核过、失败了」这种你无法复现的话。查不到就说这一次查不到。
- 搜回来的是候选，不是事实：B 站课要说清「集数/时长还没核」，想当计划依据先 bili_verify 核一遍。
- 视频课、教程、考纲、真题解析，一样都先搜。用户要什么就搜什么，不要让他自己去找。
- **搜完不许撒手**。搜到候选之后，同一轮里接着做你能做的那一步：核时长（bili_verify）、
  按搜索结果算这门课要学多久、跟离考试的剩余时间比一比够不够，然后**直接给建议**。
  只有「选哪一条」这种真的只能由人定的事，才用 ask 让人点。
  反例（别这么干）：「想看哪个？」然后停工 —— 那是把活儿又丢回给人。

**你能干什么（这是你的本事清单，不是流程）**：
%CATALOG%

工具规矩：
- 上面这张清单是**分堆的**：先找跟这件事贴得最近的那一堆，再从里面挑工具直接调。
  拿不准具体名字就回 {"action":"catalog","q":"搜课"} 要这一堆的完整名字。
  这 120 个工具你都能调，不是只有那 8 个高频的。
- 需要真数据就调，不要凭空猜一个数字。调完把结果说成人话，别把 JSON 原样倒出来。
- 工具报错就如实告诉用户错在哪，可以换个工具再试一次，但同一个工具同样参数别重复调。
- **调之前先照它认的参数名填**（清单里每个工具后面都写了「参数：…」）。
  实测栽过：给 bili_search 传 q、给 intake_start 传 utterance、给 intake_step 传 id ——
  全是白跑一轮。报错里那句「它认的参数是：xxx」出现两次以上，就是你没看参数名。
- **「我手上没有这个号」说之前，先调一次能拿到它的工具。**
  实测栽过：intake_state 的 candidates 里本来就有 bvid，模型没查就回
  「号没带出来，你发我」—— 该做的活又丢回给用户了。
- **权限档是用户设的，你看得见但改不了**。调 perm_state 能看到现在是哪一档：
  「完全信任」= 写盘直接落盘，调完把改了什么说出来就行；
  「先问我」= 写盘会弹确认卡，你照常调你的，系统会等人点；
  「只看不改」= 写盘一律被挡，**别反复重试**，直接说「现在是只看不改档，要改得你在设置里换档」。
  「要不要我找工具改一下」「要不要我再看一眼」这种话**不要说** —— 那就是把选择又丢回去，
  用户要的是结果。判断该做就直接做，做完把结果说清楚。
  唯一需要人点头的是「改本机」那一步：系统会替你把确认卡弹出来，你照常调**你的 part** 就行。
- 要人拍板就回 {"action":"ask","question":"一句话问题","options":["选项A","选项B"],"multi":false}。
  选项是字符串数组，最多 8 个；可以多选就 "multi":true。
  例：问考哪几科 → options: ["高等数学","英语","计算机基础","C 语言","政治"], multi: true。
- **能给人「点一下就能往下走」的下一步，就给操作卡**（这是本产品最要紧的一条）：
  {"action":"propose","say":"一句话说你要给什么","card":{"title":"卡片标题","note":"一句补充","actions":[{"label":"按钮上的字","tool":"工具名","args":{},"confirm":false}]}}
  规矩：
  ① 最多 4 个按钮，每个**必须写全 tool 和 args** —— 点了就真调，不是摆设；
  ② 会改本机的工具（course_add / plan_set_budget / restore_backup / source_import）confirm 写 true；
  ③ **能点出来的事，绝不要让人打字描述**。搜完课就给他「入库」「全部入库」「再搜一批」；
     排完计划就给他「开始第一件」「换一批」；
  ④ ask 只用在「真的需要他回答一个问题」的时候（考哪几科、哪天考）；
     propose 用在「下一步有明确的几个动作」的时候。别把能点的事问成问题。
- 要改本机的东西（写计划、存笔记、标记看完、删画布）会需要用户确认 —— 这由系统处理，
  你照常调就行，不要自己先问「要不要我执行」。

**用户说要考什么、要开始备考**（这条最容易漏）：
- 他说的是一件事，不是一句话：比如「我想专升本」「我是广东考生」「明年三月考」「帮我排个计划」。
  这种时候要调 **intake_start**（说一句话就接手：先听懂，再翻本机有什么），
  不要拿 plan_today 去糊 —— 空机器上 plan_today 本来就是空的，问了等于白问。
- 接手之后流水线是四站：搜课程 → 核对分集数和总时长 → 拟计划。
  用 intake_step 往前走，用 intake_reply 补它问你的日期/时长，用 intake_pick 挑课。
  这些站要不要走由你判断：用户只让你「先看看有什么课」，那就只走到搜；他让你排，才排到底。
- **绝不许**在机器是空的时候反问「先从哪科入手」「你想学什么科目」。
  课程、题库、真题卷一样都没有的时候，正确的下一步是出去搜，不是问他。
  你可以顺便问他日期和每天能学多久（这两样查不到，只有他知道），但不能拿这个当借口不动手。

**查就查完（这条最容易犯）**：
- 你在一句话里说要查几件事，就必须在这一轮把它们都查完再回答。
  比如「得看今天还剩多少任务、离考试还有几天」—— 那就是两个工具：
  plan_today + plan_budget，两个都要调，不能查一个就收工。
- **绝不许**把「我自己一查就有」的东西推回给用户。下面这些都能自己查，不要问用户：
  什么时候考试（plan_budget）、每天多少分钟（plan_budget）、学到第几讲（get_current_lesson）、
  今天该干什么（plan_today）、错了多少题（stats_overview）、有哪些卷子（list_exam_papers）。
- 准备回答之前自检一遍：这句话里如果还出现「我查一下」「我得看看」「我需要知道你…才能算」
  「这个我没查到」这类字眼，说明还有活没干 —— 回去调工具，别把半截话交给用户。
- 用户报了新的硬参数（每天学几小时、考试改成哪天、要加哪一科），**直接调对应的写工具**：
  时长/日期就调 plan_set_budget（只改一项就只传那一项，比如 hours_per_day:3，它会把其余项沿用），
  它会自己弹确认卡，人点头才执行；调完它会把重算结果一起给你，你照着复述就行。
  **不要**先回一句「要不要我改」，也不要为了改个数字去走 intake 全流程（intake 是"从零接手"用的，
  已经聊过、只是改一个数，就别再把用户拖过五站）。
  而且是工具查完确认没有之后。这时候说清楚「本机没有这份数据」，不要绕 ——
  但「本机没有」后面必须接一句「外面有什么」（搜过之后再说），不能只说前半句。
- **查不到就报查不到，不许拿猜的数凑一版。** 不能说「先按已知的拟一版，等核出来再校正」——
  「已知的」如果是你估的，那这版计划整个是假的，用户还会照着它去学。
  查不到就说：这条没查到（差什么、为什么），然后把**已经查实的部分**给出来。
  一个数是核过的、一个数是估的，要分开标清楚，不许混在同一张表里。

**只读的事别问，直接做**：
- 搜课程、看本机有什么、算覆盖多少 —— 这些都是只读的，**不要**问「要我现在就去找吗」
  「要不要我帮你查」这种话，直接调工具做完再说。

**要人拍板就用 ask，不要在正文里打一串字让人自己看**：
- 下面这三样必须**用 ask 动作**问，不允许写在正文里让人自己打字：
  ① 考哪几科 / 要学哪几科（多选）② 考试日期 ③ 每天能学多久。
- **一次问全，不要一个问题一个来回。** 这几样都要问的时候，用 questions 数组
  全部放进**同一个** ask 动作里 —— 界面会把它们画成一个框，人一次选完点一次「发出去」，
  三样答案一起回来。别先问科目、等他答完再问日期，那是把一件事拆成三趟。
  格式：
  {"action":"ask","questions":[
    {"question":"要学哪几科","options":["高等数学","英语","计算机基础","C 语言","政治"],"multi":true},
    {"question":"考试是哪天","options":["2027-03-15","2027-04-15","我还不确定"]},
    {"question":"每天能学多久","options":["1 小时","2 小时","3 小时","4 小时以上"]}
  ]}
  人也能在这个框里自己打字，所以选项给常见的几个就够，不用穷举。
- 科目清单要**先列全再让人勾**。广东专升本工科通常这几门，按这个给选项（multi: true）：
  高等数学、英语、计算机基础、C 语言、政治。用户说了别的省份或别的情况就按他说的改。
  **不要**替他把科目定了，也不要只说「你想学哪科」就完事。
- 只有一个问题要用 ask 时，老的写法照样能用：
  {"action":"ask","question":"…","options":["…","…"],"multi":false}。

**连续调用（别吃白饭）**：
- 一件活儿要查好几处就连着查，一轮里可以把 find_tool / 检索 / 取数 / 再取数串起来。
- **互不依赖的几件事，一次并着要**，别一件一件排队 —— 排队就是让人多等好几倍。
  写法：{"action":"calls","list":[{"tool":"plan_today","args":{}},{"tool":"plan_budget","args":{}}]}
  一次最多 6 件，只能放只读的（会改本机的工具单独调，要人点头）。
  有先后关系的**不许**并发：比如先要讲课 id 再核这一讲 —— 那就分两步。
- 该列清单就列清单：比如「要学哪几科」，先把科目列全（广东专升本工科通常是
  高等数学、英语、计算机基础 / C 语言、政治），再用 ask 让人勾选。
  不要替他把科目定了，也不要只给一句话让他自己想。

回答长度：默认两三句。用户明确要求详细，才展开。
用 Markdown 排版：分点用「- 」，重点用 **粗体**，多个并列项分行写清。
"""


# ---------------------------------------------------------------- 会话
def _load():
    raw = store.kv_get(KV_THREAD) or "[]"
    try:
        d = json.loads(raw)
        return d if isinstance(d, list) else []
    except Exception:
        return []


# 一条助手消息在记录里能带的附加字段：工具轨迹、待确认、提问卡、模型信息、
# 思考过程。**这些只进本地记录、不进模型上下文** —— 模型那边只看 role+content
# （_render_ctx 会滤掉），所以留着它们不会让模型误以为自己上次吐过 JSON。
_EXTRA_KEYS = ("trace", "pending", "ask", "card", "meta", "think", "spans", "steps", "turn")


def _clean_row(x):
    """一条消息去掉多余字段（旧版本存下来的东西逐层剥干净）。"""
    if not isinstance(x, dict):
        return None
    role = x.get("role")
    if role not in ("user", "assistant"):
        return None
    c = str(x.get("content") or x.get("text") or "")
    if not c.strip():
        return None
    row = {"role": role, "content": c}
    if x.get("focus"):
        row["focus"] = x["focus"]
    for k in _EXTRA_KEYS:
        v = x.get(k)
        if v:
            row[k] = v
    return row


def _save(msgs):
    """把这一轮说完的话写进长期记录。

    ---- 为什么现在连工具轨迹一起存（人 2026-10-24 报的 bug）----
    「工具调用为什么刷新一下网页就不见了？」原先是设计成不存的：只留人说的话和我
    最终的回答。可人真正想看的是「它到底查了什么、查出什么」，刷新就没了等于
    这一轮的凭据全丢。所以现在把 trace / pending / ask / meta / think 一起写进
    每一条 assistant 上。

    界线还是守住：动作指令（{"action":"call"...}）和 find_tool 回灌的工具表
    **不进记录**；附加字段只给界面看，_render_ctx 拼上下文时不带它们。
    """
    clean = []
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        # content 有时不是字符串（并发的工具结果原样塞回来过），这里统一转文本，
        # 否则一条脏数据就能让整个 turn 在收尾时崩掉。
        c = context._txt(m).strip()
        if role not in ("user", "assistant") or not c:
            continue
        if role == "assistant" and c.startswith("{"):
            continue                      # 动作指令，不是话
        row = {"role": role, "content": c}
        if m.get("focus"):
            row["focus"] = m["focus"]
        for k in _EXTRA_KEYS:
            if m.get(k):
                row[k] = m[k]
        clean.append(row)
    keep = clean[-THREAD_MAX:]
    store.kv_set(KV_THREAD, json.dumps(keep, ensure_ascii=False))
    return keep


def _stamp(trace=None, ask=None, card=None, pending=None, meta=None, think=None, steps=None):
    """把这一轮的痕迹盖到最后那条 assistant 上 —— 先 _save 再 _stamp。

    为什么要分两步：跑的时候 msgs 里只有 role+content（那是给模型看的），
    工具轨迹压根不在里面。所以先把话存了，再按「最后一条助手消息」补痕迹。
    think 传进来的是这一轮攒下的思考片段（list），拼成一段再存。
    steps 是「想一段 → 调一个 → 再想一段」的顺序，前端按它画时间线。
    """
    if isinstance(think, list):
        think = "".join(think)
    # 用量也钉在这条记录上：刷新回来底部状态条才有数（不然只有当场那一屏看得见）。
    if meta and "usage" not in meta:
        try:
            from . import platform_ai
            u = platform_ai.last_usage()
            if u:
                meta = dict(meta)
                meta["usage"] = u
        except Exception:
            pass
    # 上下文是怎么拼的（折叠了几条、留了几条、吃紧没收紧）也钉上 ——
    # 状态条点开的详情读这一份，全是拼的时候数出来的。
    if meta is not None and "ctx" not in meta:
        c = context.status()
        if c:
            meta = dict(meta)
            meta["ctx"] = c
    rows = _load()
    if not rows:
        return rows
    for i in range(len(rows) - 1, -1, -1):
        if rows[i].get("role") == "assistant":
            row = rows[i]
            if trace:
                row["trace"] = [t for t in trace if isinstance(t, dict)][:40]
            if ask:
                row["ask"] = ask
            if card:
                row["card"] = card
            if pending:
                row["pending"] = pending
            if meta:
                row["meta"] = meta
            if think:
                row["think"] = think[:8000]
            if steps:
                # 只留最近 40 个节点，每段思考掐到 4000 字 —— kv 一行存不下几千字的循环输出
                keep = []
                for s in steps[:40]:
                    if not isinstance(s, dict):
                        continue
                    if s.get("k") == "think":
                        keep.append({"k": "think", "t": (s.get("t") or "")[:4000],
                                     "done": bool(s.get("done"))})
                    elif s.get("k") == "tool" and isinstance(s.get("x"), dict):
                        keep.append({"k": "tool", "x": s["x"]})
                if keep:
                    row["steps"] = keep
            rows[i] = row
            break
    store.kv_set(KV_THREAD, json.dumps(rows, ensure_ascii=False))
    # 顺手落事件流：会话分栏 / 回放 / 以后按 turn 分叉都读它。
    # 停止原因写明白 —— 只有 rounds 看不出「为什么停」。
    _emit_turn(getattr(_TL, "sid", None), getattr(_TL, "turn_no", 0),
               getattr(_TL, "user_text", None), steps,
               _last_assistant_text(),
               "pending" if pending else ("ask" if ask else "done"), meta, card=card)
    return rows


def _last_assistant_text():
    rows = _load()
    for r in reversed(rows):
        if r.get("role") == "assistant":
            return r.get("content") or ""
    return ""


def migrate_legacy_thread():
    """把 kv 里的旧对话转成一条真会话（事件流），只做一次。

    不做的后果很实在：旧对话在 kv 里、会话列表里却没有它；一旦切到别处再切回来，
    kv 会被事件流重建覆盖，那几轮对话就真没了。
    """
    raw = store.kv_get(KV_THREAD) or "[]"
    if raw.strip() in ("", "[]"):
        return ""
    try:
        rows = json.loads(raw)
    except Exception:
        return ""
    if not isinstance(rows, list) or not rows:
        return ""
    title = ""
    for r in rows:
        if isinstance(r, dict) and r.get("role") == "user" and (r.get("content") or "").strip():
            title = (r.get("content") or "").strip()[:40]
            break
    sid = store.session_new(focus="today", title=title, provider=None, model=None)
    turn = 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        role = r.get("role")
        body = (r.get("content") or "").strip()
        if role == "user":
            turn += 1
            store.ev_add(sid, "turn/start", {"text": body}, turn_no=turn)
        elif role == "assistant":
            if turn == 0:
                turn = 1
            steps = []
            if r.get("think"):
                steps.append({"k": "think", "t": r["think"][:4000], "done": True})
            for t in (r.get("trace") or [])[:20]:
                if isinstance(t, dict):
                    steps.append({"k": "tool", "x": t})
            for s2 in steps:
                if s2["k"] == "think":
                    store.ev_add(sid, "reasoning", {"text": s2["t"], "done": True},
                                 turn_no=turn, step_no=1)
                else:
                    store.ev_add(sid, "tool/call",
                                 {"tool": s2["x"].get("tool"), "args": s2["x"].get("args")},
                                 turn_no=turn, step_no=1)
                    store.ev_add(sid, "tool/result",
                                 {"tool": s2["x"].get("tool"), "ok": s2["x"].get("ok"),
                                  "ms": s2["x"].get("ms"), "summary": s2["x"].get("summary"),
                                  "ui": s2["x"].get("ui"), "error": s2["x"].get("error")},
                                 turn_no=turn, step_no=1)
            if body:
                store.ev_add(sid, "assistant/message",
                             {"text": body, "meta": r.get("meta") or {}},
                             turn_no=turn, step_no=2)
            store.ev_add(sid, "turn/end", {"reason": "migrated"}, turn_no=turn)
    store.kv_set(KV_CUR, sid)
    return sid


def cur_session(focus=None, provider=None, model=None):
    """当前会话。没有就开一条；换了模型就新开一条。

    为什么不许在会话里换模型：同一条轨迹里前半段一家模型想的、后半段另一家，
    回放时解释不通「它当时为什么那么判断」。dsh 也是这个规矩。
    返回 (sid, turn_no, 是不是新开的)。
    """
    sid = str(store.kv_get(KV_CUR) or "")
    s = store.session_get(sid) if sid else None
    switch = False
    if s:
        if provider and (s.get("provider") or "") and s["provider"] != provider:
            switch = True
        if model and (s.get("model") or "") and s["model"] != model:
            switch = True
    if (not s) or switch:
        # 第一次升级上来：kv 里有旧对话就先把它转成会话，别让它在切会话时丢掉
        if not s and not switch and not sid:
            _m = migrate_legacy_thread()
            if _m:
                return _m, store.ev_max_turn(_m) + 1, False
        sid = store.session_new(focus=focus, provider=provider, model=model)
        store.kv_set(KV_CUR, sid)
        return sid, 1, True
    return sid, store.ev_max_turn(sid) + 1, False


def _emit_turn(sid, turn_no, user_text, steps, final_text, reason, meta=None, card=None):
    """把这一轮的过程落成事件流（会话分栏 / 回放靠它）。

    写失败不许影响回答 —— kv 那份还在，界面照常能看。事件流是给「以后」用的：
    分栏、搜索、从某一步分叉。丢一条不该让这一轮白聊。
    """
    if not sid:
        return
    try:
        if user_text:
            store.ev_add(sid, "turn/start", {"text": user_text}, turn_no=turn_no)
            # 还没标题的会话，就拿第一句话当标题 —— 列表上「（还没起名）」堆一片没法挑
            _s = store.session_get(sid)
            if _s and not (_s.get("title") or "").strip():
                store.session_touch(sid, title=user_text[:40])
        step = 1
        for s2 in (steps or []):
            if not isinstance(s2, dict):
                continue
            if s2.get("k") == "think":
                store.ev_add(sid, "reasoning",
                             {"text": (s2.get("t") or "")[:4000], "done": bool(s2.get("done"))},
                             turn_no=turn_no, step_no=step)
            elif s2.get("k") == "tool":
                x = s2.get("x") or {}
                store.ev_add(sid, "tool/call",
                             {"tool": x.get("tool"), "args": x.get("args")},
                             turn_no=turn_no, step_no=step)
                store.ev_add(sid, "tool/result",
                             {"tool": x.get("tool"), "ok": bool(x.get("ok")),
                              "ms": x.get("ms"), "summary": x.get("summary"),
                              "ui": x.get("ui"), "error": x.get("error")},
                             turn_no=turn_no, step_no=step)
                step += 1
        if card:
            store.ev_add(sid, "ui/action", card, turn_no=turn_no, step_no=step)
        if final_text:
            store.ev_add(sid, "assistant/message",
                         {"text": final_text, "meta": meta or {}},
                         turn_no=turn_no, step_no=step)
        store.ev_add(sid, "turn/end", {"reason": reason, "meta": meta or {}},
                     turn_no=turn_no)
    except Exception:
        pass


def _rows_from_events(sid):
    """从事件流重建「界面要的行」。一条 turn 里的 reasoning / tool / 正文 聚成一条 assistant。

    这是分栏能用的前提：切到哪条会话，就重建哪条的界面与上下文。
    """
    ev = store.ev_list(sid)
    if not ev:
        return []
    rows = []
    cur = None

    turn_cur = [0]

    def _open():
        nonlocal cur
        if cur is None:
            # 带上 turn_no：界面上「从这一轮分叉」要用它的边界
            cur = {"role": "assistant", "content": "", "steps": [], "turn": turn_cur[0]}
            rows.append(cur)
        return cur

    for e in ev:
        k = e.get("kind")
        p = e.get("payload") or {}
        if k == "turn/start":
            turn_cur[0] = int(e.get("turn_no") or 0)
            rows.append({"role": "user", "content": p.get("text") or "", "turn": turn_cur[0]})
            cur = None
        elif k == "reasoning":
            r = _open()
            st = r["steps"]
            txt = p.get("text") or ""
            if st and st[-1].get("k") == "think" and not st[-1].get("done"):
                st[-1]["t"] = (st[-1].get("t") or "") + txt
            else:
                st.append({"k": "think", "t": txt})
            if p.get("done"):
                st[-1]["done"] = True
            r["think"] = "".join(s.get("t") or "" for s in st if s.get("k") == "think")[:8000]
        elif k == "tool/call":
            r = _open()
            st = r["steps"]
            if st and st[-1].get("k") == "think" and not st[-1].get("done"):
                st[-1]["done"] = True
            st.append({"k": "tool", "x": {"tool": p.get("tool"), "args": p.get("args") or {}}})
        elif k == "tool/result":
            r = _open()
            for s in reversed(r["steps"]):
                if s.get("k") == "tool" and (s["x"].get("tool") or "") == (p.get("tool") or ""):
                    s["x"].update({"ok": p.get("ok"), "ms": p.get("ms"),
                                   "summary": p.get("summary"), "ui": p.get("ui"),
                                   "error": p.get("error")})
                    break
            r["trace"] = [s["x"] for s in r["steps"] if s.get("k") == "tool"]
        elif k == "ui/action":
            r = _open()
            r["card"] = p
        elif k == "assistant/message":
            r = _open()
            r["content"] = p.get("text") or ""
            if p.get("meta"):
                r["meta"] = p.get("meta")
        elif k == "turn/end":
            cur = None
    return [r for r in rows
            if (r.get("content") or "").strip() or (r.get("steps") or [])]


def switch_session(sid):
    """切会话：把当前上下文和界面一起换成目标会话的。

    不能只改 KV_CUR 就完事 —— 模型上下文在 kv['agent.thread'] 里，
    不一起换的话，界面上是 A 会话、模型脑子里是 B 会话。
    """
    s = store.session_get(str(sid or ""))
    if not s:
        return {"ok": False, "error": "没这条会话：%r" % (sid,)}
    rows = _rows_from_events(s["id"])
    store.kv_set(KV_THREAD, json.dumps(rows, ensure_ascii=False))
    store.kv_set(KV_CUR, s["id"])
    return {"ok": True, "id": s["id"], "title": s.get("title"),
            "messages": len(rows), "note": "切过去了，接着上次说。"}


def history(limit=40):
    """给界面看的会话记录。assistant 上的 trace / ask / pending / meta 一起回。

    带的是原始内容（content），不是显示用的 text —— 界面那边两个都认。
    """
    # 界面优先从事件流重建：只有它带 turn_no（「从这一轮分叉」要用）。
    # kv 那份只是模型上下文，缺字段，当兜底。
    sid = str(store.kv_get(KV_CUR) or "")
    rows = _rows_from_events(sid) if sid else []
    if not rows:
        rows = [_clean_row(x) for x in _load()]
        rows = [r for r in rows if r]
    return {"ok": True, "messages": rows[-limit:], "count": len(rows),
            "session": sid,
            "note": "会话与过程存在本机 SQLite（sessions / session_events），跨次重启还在。"}


def reset():
    """清掉当前对话 —— 现在是「换一条新会话」，不是把旧的抹掉。

    清之前留一份最近的（agent.thread.bak），误触了还能捞回来。
    事件流不动：旧轨迹还在 sessions 里，会话分栏能翻回去看。
    踩过：为了复现 bug 连着调了两次，把用户正聊着的四轮会话清没了，没法还原。
    """
    old = store.kv_get(KV_THREAD) or "[]"
    kept = 0
    if old and old.strip() not in ("", "[]"):
        store.kv_set(KV_THREAD_BAK, old)
        try:
            kept = len(json.loads(old))
        except Exception:
            kept = 0
    store.kv_set(KV_THREAD, "[]")
    sid = store.session_new(focus="agent")
    store.kv_set(KV_CUR, sid)
    return {"ok": True, "note": "对话记录已清空，新会话已开。下次开口就是新的。",
            "kept": kept, "bak": (KV_THREAD_BAK if kept else None), "session": sid}


def restore_bak():
    """把 reset 留下的那一份捞回来（返回捞回了几条）。"""
    old = store.kv_get(KV_THREAD_BAK) or ""
    if not old or old.strip() in ("", "[]"):
        return {"ok": False, "error": "没有可捞的备份（agent.thread.bak 是空的）"}
    try:
        n = len(json.loads(old))
    except Exception:
        return {"ok": False, "error": "备份内容坏了，捞不回来"}
    store.kv_set(KV_THREAD, old)
    return {"ok": True, "restored": n,
            "note": "捞回来了 %d 条，接着上一次继续。" % n}


# ---------------------------------------------------------------- 工具检索
def _find_tool(q, limit=12):
    """按中文/英文关键词在 120 个工具里找。返回名字+描述，模型自己挑。

    光靠「名字 + 描述」做子串是**不够的**（2026-10-24 实测：「搜资料」「去网上找」
    「b站」「找课」全返回空，模型于是以为自己没这个本事）。所以先过一遍
    tools.CATS 的触发词表：哪一类的触发词命中，那一类的工具整堆抬上来。
    """
    q = (q or "").strip().lower()
    if not q:
        return {"ok": False, "error": "检索词是空的"}
    words = [w for w in q.replace("，", " ").replace(",", " ").split() if w]
    hits = {}
    # 一、先看类别触发词（这是最粗也最准的一层）
    # 单字触发词（找、搜、课）只在整句里**孤立出现**时才算命中 ——
    # 否则「找C语言课」会被「找」判成命中，「今天天气」也会被「今」误伤。
    for cid, why, keys, names in tools.CATS:
        cat_hit = 0
        for k in keys:
            if not k:
                continue
            if len(k) >= 2:
                if k in q or q in k:
                    cat_hit += 6
            elif k in q:
                cat_hit += 4
        if cat_hit:
            for n in names:
                ent = tools.REGISTRY.get(n)
                if ent:
                    hits[n] = hits.get(n, 0) + cat_hit
    # 二、再看工具名与描述的子串
    for name, ent in tools.REGISTRY.items():
        hay = (name + " " + (ent.get("desc") or "")).lower()
        score = 0
        if q in hay:
            score += 10
        for w in words:
            if w and w in hay:
                score += 3
        if score == 0:
            for w in words:
                if len(w) >= 2 and any(w[i:i + 2] in hay for i in range(len(w) - 1)):
                    score += 1
        if score:
            hits[name] = hits.get(name, 0) + score
    ordered = sorted(hits.items(), key=lambda kv: (-kv[1], kv[0]))
    out = [{"name": n, "desc": (tools.REGISTRY[n].get("desc") or ""),
            "perm": tools.REGISTRY[n].get("perm")} for n, _ in ordered[:limit]]
    for r in out:
        r["args"] = _params_of(r["name"]) or []
    return {"ok": True, "query": q, "tools": out, "count": len(out),
            "note": None if out else "没有工具匹配「%s」。换个词，或者这件事本机做不了。" % q}


def _catalog_of(q=None):
    """要某一堆本事，或者要全部。返回给模型读的一段字。"""
    txt = tools.catalog_text(q)
    return {"ok": True, "q": q, "text": txt, "find_tool_hint": _CALL_HINT}


def _tool_card(rows):
    """给模型看的一行行工具表。含 perm 和**它认的参数名**。

    参数名不能省：实测模型会把参数猜成 q / query，然后整轮白跑一次
    （bili_search 要的是 keyword）。猜错一次就是几十秒 + 一张失败卡。
    """
    out = []
    for r in rows:
        ag = r.get("args") or _params_of(r.get("name") or "") or []
        out.append("- %s（参数：%s）—— %s%s"
                   % (r["name"], "、".join(ag) or "无",
                      r["desc"],
                      "（要用户确认）" if r["perm"] == config.PERM_CONFIRM else ""))
    return "\n".join(out)


# ---------------------------------------------------------------- 执行
def _trim_deep(v, depth=0, keep_list=TOOL_LIST_KEEP, wide=False):
    """把超长结果压瘦：字典全留键，长列表只留前几条并注明共几条。

    跟「砍掉后面」的区别：砍掉后面会连关键标识（BV 号、id）一起砍没，
    模型就会编「我手上没有这个号」。这里保证每个键都还在，长的只减量。
    wide=True 时列表多留一些（给「候选课」这类必须比着看的结果）。
    """
    kl = keep_list * (3 if wide else 1)
    if isinstance(v, dict):
        if depth >= 6:
            return "…"
        out = {}
        # 先吐要紧的键：截断发生时，模型至少看得见「有哪些候选、挑了哪个、
        # 还缺什么、计划长什么样」，而不是被 stages 的日志撑满。
        _hot = ("ok", "bvid", "bvids", "id", "title", "up", "pages", "hours",
                "secs", "picked", "candidates", "need", "plan", "say",
                "status", "stage", "stage_title", "parsed", "date",
                "minutes_per_day", "error", "items", "rows", "total", "state")
        keys = sorted(v.keys(), key=lambda k: (0 if k in _hot else 1, list(v).index(k)))
        for k in keys:
            x = v[k]
            if isinstance(x, list) and len(x) > kl:
                head = [_trim_deep(i, depth + 1, keep_list, wide) for i in x[:kl]]
                out[k] = head + ["…（共 %d 条，只列前 %d 条；要更多调工具带 limit）"
                                 % (len(x), kl)]
            elif isinstance(x, str) and len(x) > 240:
                out[k] = x[:240] + "…"
            elif isinstance(x, list) and x and all(isinstance(i, dict) for i in x):
                out[k] = [_trim_deep(i, depth + 1, keep_list, wide) for i in x[:kl]]
            else:
                out[k] = _trim_deep(x, depth + 1, keep_list, wide)
        return out
    if isinstance(v, list):
        if depth >= 6:
            return ["…"]
        if len(v) > kl:
            return ([_trim_deep(i, depth + 1, keep_list, wide) for i in v[:kl]]
                    + ["…（共 %d 条）" % len(v)])
        return [_trim_deep(i, depth + 1, keep_list, wide) for i in v]
    if isinstance(v, str) and len(v) > 600:
        return v[:600] + "…"
    return v


def _slim_intake(v):
    """把 intake_state 压成模型要用的那张卡（见调用处注释）。"""
    st = v.get("state") if isinstance(v, dict) else None
    if not isinstance(st, dict):
        return v
    cands = []
    for c in (st.get("candidates") or [])[:8]:
        if not isinstance(c, dict):
            continue
        cands.append({k: c.get(k) for k in
                      ("bvid", "title", "up", "pages", "hours", "verified")
                      if c.get(k) not in (None, "")})
    stages = st.get("stages") if isinstance(st.get("stages"), list) else []
    idx = st.get("stage") if isinstance(st.get("stage"), int) else 0
    st_title = None
    if 0 <= idx < len(stages) and isinstance(stages[idx], dict):
        st_title = stages[idx].get("title")
    out = {"ok": v.get("ok", True), "state": {
        "id": st.get("id"), "stage": st.get("stage"),
        "stage_title": st_title,
        "parsed": st.get("parsed"), "need": st.get("need"),
        "picked": st.get("picked"), "candidates": cands,
        "say": st.get("say"), "status": st.get("status"),
        "plan": st.get("plan"),
        "verify_progress": st.get("verify_i"),
        "hint": "为了省窗口，候选里没带分集明细。要看每集标题和时长，"
                "调 bili_pages(bvid=…)。",
    }}
    return out


def _clip(v, name=None):
    """工具返回给模型看的那段文本。超长先瘦身、再兜底截断。

    有些结果（候选课、题源清单）必须并排比着看，宽一点不会误事：
    名字里带 pick / search / list / state / source 的多留几条。
    """
    wide = bool(name) and any(w in str(name) for w in
                              ("pick", "search", "list", "state", "source",
                               "verify", "base", "stats"))
    if not isinstance(v, str):
        # 先瘦 intake 那张卡（它自己知道哪些字段有用），再走通用压缩。
        # 顺序反了会踩坑：通用压缩会把 stages 这类长列表压成字符串，
        # 后面再按结构去读就是 'str' object has no attribute 'get'。
        v = _slim_intake(v)
        v = _trim_deep(v, wide=wide)
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
    if len(s) > TOOL_CLIP:
        s = s[:TOOL_CLIP] + "…（后面还有 %d 字符没显示）" % (len(s) - TOOL_CLIP)
    return s


# ---------------------------------------------------------------- 已经查过的候选
# 2026-10-26 用户当场点破：他上一轮已经搜完、核完、卡片也摆出来了，人回一句「全部入库」，
# 模型却把 bili_search 从头又跑一遍才肯入库。
# 根子在这里：trace / card 属于 _EXTRA_KEYS，只进本地记录、不进模型上下文；_render_ctx 只往里
# 写「这一轮真调用过：bili_search、bili_verify」这一串工具名 —— 标题、bvid、时长一个字都没给。
# 它手上没有 bvid，除了重搜确实没别的路。所以候选得单独记一份，并且摊进下一轮上下文。
_CAND = {}          # bvid -> {title, up, secs, pages, verified, imported, subject, at}
_CAND_CAP = 300     # 超过就清掉最早的一半，进程里不留一张无限长的表
_CAND_SEQ = [0]

# 一科在标题里常露的词。只认明确写了的，认不出就空着 —— 猜错归科比空着更坏。
_SUBJ_HINTS = (
    ("英语", ("英语", "english", "单词", "语法", "音标", "翻译", "作文", "阅读", "四级", "六级", "长难句")),
    ("高等数学", ("高数", "高等数学", "math", "微积分", "导数", "积分", "线性代数", "矩阵")),
    ("政治", ("政治", "politics", "毛概", "马原", "思修", "时事", "思政")),
    ("C语言", ("c语言", "c 语言", "clang", "指针", "结构体", "链表")),
    ("计算机基础", ("计算机", "数据结构", "操作系统", "计算机网络", "组成原理")),
)


def _cand_subject2(title, keyword=""):
    """(科目, 是不是只靠搜索词猜的)。

    标题里认出来的算准；只能从搜索词推的标记为「弱」—— 拿「专升本 英语」搜出来一条
    「电路全程班」，按搜索词会归成英语，入库之后就成了英语底下的噪音。
    所以弱的那些照样列出来给模型看，但不进自动入库那串 items。
    """
    t = (title or "").lower()
    for name, words in _SUBJ_HINTS:
        if any(w in t for w in words):
            return name, False
    if not t:
        kw = (keyword or "").lower()
        for name, words in _SUBJ_HINTS:
            if any(w in kw for w in words):
                return name, False
        return "", False
    kw = (keyword or "").lower()
    for name, words in _SUBJ_HINTS:
        if any(w in kw for w in words):
            return name, True
    return "", False


def _cand_subject(title, keyword=""):
    return _cand_subject2(title, keyword)[0]


def _remember_cand(name, data):
    """把真查到的课记进进程内的候选表 —— 下一轮模型手上要有 bvid 才不用重搜。"""
    if not isinstance(data, dict):
        return
    kw = ""
    if name in ("bili_search", "web_search", "search_all"):
        items = data.get("items")
        ch = (data.get("channels") or {}).get("video") or {}
        if not items:
            items = ch.get("items") or []
        kw = str(data.get("keyword") or ch.get("keyword") or "")
    elif name in ("bili_verify", "bili_pages", "course_add", "intake_verify", "intake_pick"):
        items = [data]
    else:
        return
    if not isinstance(items, list):
        return
    for it in items:
        if not isinstance(it, dict):
            continue
        bv = str(it.get("bvid") or "").strip()
        if not bv.upper().startswith("BV"):
            continue
        d = _CAND.get(bv)
        if d is None:
            _CAND_SEQ[0] += 1
            d = {"bvid": bv, "title": "", "up": "", "secs": 0, "pages": 0,
                 "verified": False, "imported": False, "subject": "", "at": _CAND_SEQ[0]}
            _CAND[bv] = d
            if len(_CAND) > _CAND_CAP:
                for k in sorted(_CAND, key=lambda x: _CAND[x]["at"])[:len(_CAND) // 2]:
                    _CAND.pop(k, None)
        tt = str(it.get("title") or it.get("name") or "")
        if tt and not d["title"]:
            d["title"] = tt[:80]
        if it.get("up") and not d["up"]:
            d["up"] = str(it["up"])[:24]
        try:
            if it.get("secs") and not d["secs"]:
                d["secs"] = int(it["secs"] or 0)
            if it.get("pages") and not d["pages"]:
                d["pages"] = int(it.get("pages") or 0)
        except (TypeError, ValueError):
            pass
        if not d["subject"]:
            # course_add 回来的 subject 是课程 id（english-bv1xxx），不是科目名，别拿它当科目
            subj = (str(it.get("subject_name") or "") if name == "course_add"
                    else str(it.get("subject") or ""))
            d["subject"] = subj[:12] or _cand_subject(tt, kw)
        if name == "bili_verify" and it.get("ok"):
            d["verified"] = True
        if name == "course_add" and it.get("ok"):
            d["imported"] = True
            d["verified"] = True


def _looks_course(secs, title=""):
    """像不像一门能上课的课程。宁可少摊一条，也别把搜索里的杂项塞进候选。"""
    try:
        s = int(secs or 0)
    except (TypeError, ValueError):
        s = 0
    if s and s < 900:           # 短于 15 分钟：预告、切片、铃声之类
        return False
    t = str(title or "")
    if any(w in t for w in ("起床铃声", "闹钟", "鬼畜", "搞笑", "直播回放", "花絮")):
        return False
    return True


def _cand_scan(msgs, back=6):
    """从最近几轮 trace / card 里把「真摆在人面前」的课捞回来。

    主清单只取**最近那一轮有课的那一轮**：更早那些轮的搜索结果跟眼前这句话没关系
    （实测把 33 门全摊出来，模型会挑几门不相干的往里塞）。更早的轮只用来补一件事
    —— 这门之前入没入过。

    走记录而不是只走 _CAND：服务重启过、或者这轮是别的进程写下的，进程内那张表是空的，
    但 trace 里 ui 的标题时长都还在。
    """
    def _of(m):
        """一条 assistant 消息里的候选（按展示顺序，同 bvid 只留第一次）。"""
        rows, idx = [], {}

        def _add(bv, **kw):
            bv = str(bv or "").strip()
            if not bv.upper().startswith("BV"):
                return None
            if bv in idx:
                return idx[bv]
            c = {"bvid": bv, "title": "", "secs": 0, "pages": 0, "subject": "",
                 "verified": False, "imported": False}
            c.update({k: v for k, v in kw.items() if v})
            idx[bv] = c
            rows.append(c)
            return c

        for t in (m.get("trace") or []):
            if not isinstance(t, dict):
                continue
            nm = t.get("tool") or ""
            ui = t.get("ui") or {}
            if isinstance(ui, dict) and ui.get("kind") == "courses":
                kw = ui.get("keyword") or ""
                for it in (ui.get("items") or []):
                    if not isinstance(it, dict):
                        continue
                    # 没时长、或者短到不像课的先剔掉。实测搜索里混着「0 分」「起床铃声」
                    # 那种东西，一股脑摊给模型，它会真的往里塞。
                    if not _looks_course(it.get("secs"), it.get("title")):
                        continue
                    # 只认「真课」还不够：拿「专升本 英语」搜出来的「电路全程班」也得防一手。
                    # 标题认不出的科目算弱证据 —— 照列，但不进自动入库那一串。
                    _sj, _weak = _cand_subject2(it.get("title"), kw)
                    _c = _add(it.get("bvid"), title=str(it.get("title") or "")[:46],
                              secs=it.get("secs") or 0, subject=_sj)
                    if _c and _weak:
                        _c["subject_weak"] = True
            bv = (t.get("args") or {}).get("bvid")
            if not bv:
                continue
            c = _add(bv)
            if not c:
                continue
            if nm == "course_add" and t.get("ok"):
                c["imported"] = True
            elif nm in ("bili_verify", "bili_pages") and t.get("ok"):
                c["verified"] = True
        # 卡片上的按钮也是「摆到人面前」的候选 —— 模型常直接拿老 bvid 出卡，一次搜索都不留
        for a in ((m.get("card") or {}).get("actions") or []):
            if not isinstance(a, dict) or a.get("tool") != "course_add":
                continue
            lb = str(a.get("label") or "")
            h = re.search(r"(\d+(?:\.\d+)?)\s*h", lb)
            c = _add((a.get("args") or {}).get("bvid"))
            if not c:
                continue
            if not c["title"]:
                c["title"] = (re.sub(r"^入库\s*", "", lb)[:46] or c["bvid"])
            if not c["secs"] and h:
                c["secs"] = int(float(h.group(1)) * 3600)
            if not c["subject"]:
                c["subject"] = _cand_subject(lb)
        return rows

    hist = [x for x in msgs if x.get("role") == "assistant"][-back:]
    primary, done = [], set()
    for m in reversed(hist):
        rows = _of(m)
        if rows and not primary:
            primary = rows
        for r in rows:
            if r["imported"]:
                done.add(r["bvid"])
    for c in primary:
        k = _CAND.get(c["bvid"])
        if k:
            c["verified"] = c["verified"] or k["verified"]
            c["pages"] = c["pages"] or k["pages"]
            c["secs"] = c["secs"] or k["secs"]
            c["subject"] = c["subject"] or k["subject"]
            if not c["title"]:
                c["title"] = k["title"]
        if c["bvid"] in done or (k and k["imported"]):
            c["imported"] = True
    return primary


_CAND_MAX = 10          # 上下文里最多摊几条，多了挤窗
# 明确表态的：出现就算同意，句子长短都认（「那就全部入库吧」也是同意）
_APPROVE_STRONG = ("全部入库", "都入库", "全入库", "都入", "都要", "全要", "都加", "全加",
                   "入库吧", "入库", "就这些", "都可以", "安排", "办了")
# 只有一个词的：必须整句就是它（或加个语气词），不然「好的同学问我怎么办」也会被当成同意
_APPROVE_WEAK = ("好", "好的", "好啊", "好呀", "好吧", "行", "行的", "可以", "可以的",
                 "嗯", "嗯嗯", "对", "对的", "是", "是的", "中", "OK", "ok")
_APPROVE_NO = ("不", "别", "等", "先", "算了", "再说", "否", "慢")


def _approve_of(text):
    """这句是不是「同意/都要」那种一两个字的回话。是就返回命中的词。

    判不准就返回 None —— 退回正常对话没有副作用；误判成同意则会直接把课入库，
    那是会改本机状态的事，宁可漏判。
    """
    t = re.sub(r"[\s，。、,．.!！?？~～…：:；;\-—_/]+", "", text or "")
    if not t or len(t) > 16:
        return None
    if any(w in t for w in _APPROVE_NO):
        return None
    for w in _APPROVE_STRONG:
        if w in t:
            return w
    for w in _APPROVE_WEAK:
        # 整句只有它，或者它后面跟一个语气词
        if t == w or (t.startswith(w) and len(t) <= len(w) + 2
                      and t[len(w):] in ("", "吧", "呀", "啊", "哦", "嗯", "的", "了", "嘛")):
            return w
    return None


def _cand_block(msgs, approve=None):
    """把「上一轮真查过的课」摊成几行；人已经同意时，把这一轮该干什么写死。"""
    cand = _cand_scan(msgs)
    if not cand:
        return ""
    live = [c for c in cand if not c["imported"]]
    done = [c for c in cand if c["imported"]]

    def _line(c):
        meta = []
        if c["subject"]:
            meta.append(c["subject"])
        if c["pages"]:
            meta.append("%d 集" % c["pages"])
        if c["secs"]:
            meta.append("%.1f 小时" % (c["secs"] / 3600.0))
        if c["verified"]:
            meta.append("时长已核")
        if c.get("subject_weak"):
            meta.append("科目存疑，入之前先问一句")
        return "- %s %s%s" % (c["bvid"], (c["title"] or "")[:44],
                              ("（%s）" % " / ".join(meta)) if meta else "")

    out = ["〔这些课你前几轮已经真搜过、核过了，bvid 是现成的 —— 别再搜一遍：〕"]
    for c in live[:_CAND_MAX]:
        out.append(_line(c))
    if len(live) > _CAND_MAX:
        out.append("- ……还有 %d 门没列" % (len(live) - _CAND_MAX))
    if done:
        out.append("已经入库过的（别再入，也别重搜）：%s"
                   % "、".join(c["bvid"] for c in done[:6]))
    if approve:
        # 科目只能靠搜索词猜的那些不塞进自动入库 —— 宁可少入一门，也别往库里塞错科。
        _ok = [c for c in live if not c.get("subject_weak")] or live
        if _ok:
            out.append(
                "〔用户这句是**同意**，不是要你再查。这一轮只做一件事：直接\n"
                '{"action":"call","tool":"course_add_many","args":{"items":[%s]}}\n'
                "把上面还没入库的那几门一次入完（bvid 照抄，name/subject 可以不写），"
                "然后一句话报「入了几门、共多少小时」。\n"
                "**不要**调 bili_search / intake_* / find_tool —— 课已经搜过核过了，"
                "重搜一遍等于把同一份 token 再烧一次。〕"
                % ", ".join('{"bvid":"%s"}' % c["bvid"] for c in _ok[:_CAND_MAX]))
        else:
            out.append(
                "〔用户这句是**同意**，但上面这些课**已经全入库了**：别重复入，也别重搜。"
                "一句话告诉他现状（入了几门、共多少小时），再问要不要接着往下排。〕")
    return "\n".join(out)


def _ui_of(name, data):
    """给界面用的结构化摘要 —— 跟给模型看的那段 summary 分两条路。

    为什么必须分开：summary 是给模型读的纯文本，为省 token 一律截到 300 字；
    搜索结果那种嵌套 JSON 一截就断在半截，前端 JSON.parse 必失败，于是
    「搜到的课」只能显示成一坨残缺文本（用户实测就是这么撞上的：看到了
    "bvid": "BV17a7K64ELH" 但看不到封面、时长、作者）。
    界面要的是**完整但精简**：只留挑课要看的六个字段，最多八条。
    """
    _remember_cand(name, data)     # 顺手记进候选表：下一轮模型要拿 bvid 直接入库
    if not isinstance(data, dict):
        return None
    if name in ("bili_search", "web_search", "search_all"):
        items = data.get("items")
        kw = data.get("keyword")
        if not items:
            ch = (data.get("channels") or {}).get("video") or {}
            items = ch.get("items") or []
            kw = kw or ch.get("keyword")
        if not isinstance(items, list) or not items:
            return None
        out = []
        for it in items[:8]:
            if not isinstance(it, dict):
                continue
            out.append({
                "bvid": it.get("bvid"),
                "title": str(it.get("title") or "")[:90],
                "up": it.get("up"),
                "play": it.get("play") or 0,
                "secs": it.get("secs") or 0,
                "pic": it.get("pic") or "",
            })
        return {"kind": "courses", "keyword": kw, "n": len(items), "items": out}

    if name == "bili_pages":
        pages = data.get("pages")
        if not isinstance(pages, list) or not pages:
            return None
        total = data.get("total") or len(pages)
        show = [{"p": x.get("p"), "t": str(x.get("t") or "")[:64], "min": x.get("min")}
                for x in pages[:12] if isinstance(x, dict)]
        return {"kind": "pages", "bvid": data.get("bvid"), "total": total,
                "total_min": data.get("total_min"), "pages": show,
                "more": max(0, int(total) - len(show))}

    if name == "plan_today":
        rows = data.get("rows")
        if not isinstance(rows, list) or not rows:
            return None
        return {"kind": "plan", "rule": data.get("rule"), "n": len(rows),
                "due_today": data.get("due_today"),
                "rows": [{"title": str(x.get("title") or "")[:72],
                          "meta": str(x.get("meta") or "")[:90],
                          "action": x.get("action"), "cls": x.get("cls")}
                         for x in rows[:6] if isinstance(x, dict)]}
    return None


def _params_of(name):
    """这个工具真正认哪些参数。

    必须查，不能直接把它给的 args 丢进去 —— tools.call 走的是
    ent["fn"](**args)，签名里没有的键会落进 **kwargs 被静默吞掉。
    上面真踩过：模型传 daily_minutes，工具要的是 minutes_per_day，
    结果日期写进去了、分钟数没写，界面看着「已保存」，实际只改了一半。
    """
    ent = tools.REGISTRY.get(name) or {}
    fn = ent.get("fn")
    if not fn:
        return None
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    names = []
    for p in sig.parameters.values():
        if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        names.append(p.name)
    return names


def _check_args(name, args):
    """返回 (干净的 args, 错误说明)。错就把「它认哪些参数」原样交出去，让模型自己改。"""
    if not args:
        return {}, None
    allow = _params_of(name)
    if allow is None:
        return args, None
    bad = [k for k in args if k not in allow]
    if not bad:
        return args, None
    return None, "工具「%s」没有 %s 这个参数。它认的参数是：%s。换个名字重调。" % (
        name, "、".join(bad), "、".join(allow) or "（无）")


# 给「正在干什么」配一句人话。没配到的就用工具名，别编。
_TOOL_SAY = {
    "bili_verify": "核这一条课的分集数和总时长",
    "bili_search": "在本机课程库里搜课",
    "bili_view": "取这条课的基本信息",
    "bili_pages": "拉分集列表",
    "course_add": "把这门课正式写进本机课程库",
    "intake_start": "接手这件事，先从课程库摸家底",
    "intake_step": "推下一步",
    "plan_budget": "按分数线切预算、排顺序",
    "plan_set_budget": "把预算写进本机",
    "plan_week": "排这一周的日程",
    "plan_today": "排今天该学什么",
    "find_tool": "看看自己有哪些本事能用",
    "stats_overview": "盘一遍本机数据",
}


# 本轮里失败过的「工具+参数」→ 失败原因。
# 只活一轮：turn() 开头清空，换条路重试的机会还在，但不能在同一轮里死磕。
_FAILED = {}

# 本轮里搜过的「工具+参数」→ 结果摘要。同样的词再搜一次就是白跑一遍，
# 人看到的正是「同意之后又把搜索流程走了一遍」。同样只活一轮。
# 只收「纯查」的几个：写盘工具（intake_apply 之类）同参数再来一次可能是真的还想再跑，不拦。
_DEDUPE_SEARCH = frozenset(["bili_search", "web_search", "search_all", "intake_state"])
_SEARCH_SEEN = {}


def _run_tools_parallel(pairs, sink=None):
    """同时跑几个互不依赖的只读工具，返回 [(trace卡片, 回灌给模型的文本)]。

    为什么要它：核三门课的集数、查今天该学什么 + 离考试几天 —— 这些之间没有先后关系。
    串着跑就是 3 倍等待，人对着一句话转十几秒，只会以为卡死了。
    只用线程并（工具是阻塞 HTTP / 本地查询，没有共享状态），不引 asyncio 重写一遍。
    """
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(6, len(pairs))) as ex:
        futs = [ex.submit(_run_tool, n, a, False, sink) for n, a in pairs]
        out = []
        for f in futs:
            try:
                out.append(f.result())
            except Exception as e:                      # 单个炸了不连累其它
                out.append(({"tool": "?", "ok": False, "ms": 0, "error": str(e)[:200]},
                            "有一个查询没跑成：%s" % e, None))
        return out


def _tool_pre(name, args):
    """① 前置：参数名校验 + 同一轮内同参去重。返回 (clean_args, sig, err)。

    err 非空 = 这一步不该继续，err = (给模型看的文本, trace 卡片)。
    规矩：校验失败不静默丢弃 —— 要把「它认哪些参数」原样贴回去，模型据此自己改。
    """
    clean, bad = _check_args(name, args)
    sig = "%s|%s" % (name, json.dumps(clean or args or {}, sort_keys=True, ensure_ascii=False))
    prev = _FAILED.get(sig)
    if prev is not None:
        # 同一个工具同样的参数已经失败过：别再跑第二遍。慢接口一次超时十几秒，
        # 重试三次人已经以为死机；而且模型经常「换个措辞再问一遍」，参数其实一模一样。
        return None, sig, (
            "工具 %s 刚刚已经用同样的参数失败过一次：%s。"
            "别再试这个了 —— 换条路，或者如实告诉用户这条没查到。" % (name, prev),
            {"tool": name, "args": args or {}, "ms": 0, "ok": False,
             "error": "（没重跑）%s" % prev})
    if bad:
        return None, sig, ("工具 %s 调不了：%s" % (name, bad),
                           {"tool": name, "args": args or {}, "ms": 0, "ok": False, "error": bad})
    return clean, sig, None


def _tool_exec(name, args, confirmed=False, sink=None):
    """② 执行：真调工具 + 计时。异常不吞 —— 打完堆栈再抛，上层才知道是执行炸了。

    sink 传进来就把工具内部的小步也推出去（「核第 3/6 条」这种）。这一步只是让
    人看得见进度：没有它，一个跑三十秒的工具在界面上和一个卡死的工具长得一模一样。
    """
    prog = None
    if sink is not None:
        def prog(d):
            try:
                sink({"t": "substep", "n": name, "msg": d.get("msg"),
                      "i": d.get("n"), "of": d.get("total")})
            except Exception:
                pass
    t0 = time.time()
    try:
        r = tools.call(name, args or {}, confirmed=confirmed, progress=prog)
    except Exception:
        import traceback
        traceback.print_exc()
        raise
    return r, int((time.time() - t0) * 1000)


def _tool_post(name, args, r, ms):
    """③ 收尾：裁给模型看的 summary + 出给界面看的 ui。返回 (card, data, err)。

    两条通道必须分开：summary 砍到 300 字无所谓（那是给模型读的）；
    ui 必须完整且精简，否则前端 JSON.parse 必失败 —— 搜索结果只能显示成半截文本。
    """
    data = r.get("data") if isinstance(r.get("data"), dict) else {}
    card = {"tool": name, "args": args or {}, "ms": ms, "ok": bool(r.get("ok"))}
    if r.get("need_confirm"):
        card["need_confirm"] = True
        return card, data, None
    if r.get("ok"):
        card["summary"] = _clip(data, name)[:300]
        ui = _ui_of(name, data)
        if ui:
            card["ui"] = ui
        return card, data, None
    err = r.get("error") or data.get("error") or "没返回内容"
    card["error"] = str(err)[:300]
    return card, data, str(err)


def _run_tool(name, args, confirmed=False, sink=None):
    """调一个真工具。返回 (给模型看的文本, trace 条目, pending)。

    只做编排：pre（校验/去重）→ exec（真跑）→ post（裁剪/出卡），
    拆开是为了「参数不对」和「执行炸了」在回放里能分开看。
    pending 非空表示这个工具要人确认，这一轮先停这儿 —— 不硬跑。
    """
    clean, sig, err = _tool_pre(name, args)
    if err:
        return (err[0], err[1], None)
    args = clean
    # 同一个搜索词，这一轮搜过一次就够了。第二次跑出来的就是同一份列表，
    # 白等两秒、白烧一份 token —— 人看到的是「它又把流程走了一遍」。
    if name in _DEDUPE_SEARCH and sig in _SEARCH_SEEN:
        _old = _SEARCH_SEEN[sig]
        return ("工具 %s：**同样的搜索这一轮已经做过了**，结果没变 —— %s\n"
                "不要用同一组参数再搜一遍，直接拿这些结果往下做。"
                % (name, _old),
                {"tool": name, "args": args, "ms": 0, "ok": True, "repeat": True,
                 "summary": _old[:300]}, None)
    # 开跑前先吱一声：慢工具（拉分集、核时长）一次几秒，不先报「正在干什么」只剩转圈。
    if sink:
        try:
            sink({"t": "run", "n": name, "desc": _TOOL_SAY.get(name) or name})
        except Exception:
            pass
    r, ms = _tool_exec(name, args, confirmed, sink=sink)
    card, data, bad = _tool_post(name, args, r, ms)
    if sink:
        try:
            sink({"t": "tool", "n": card.get("tool"), "ms": card.get("ms"),
                  "ok": card.get("ok"), "args": card.get("args"),
                  "summary": card.get("summary"), "ui": card.get("ui"),
                  "error": card.get("error"),
                  "need_confirm": bool(card.get("need_confirm"))})
        except Exception:
            pass
    if card.get("need_confirm"):
        return (None, card, {"tool": name, "args": args or {}, "desc": r.get("desc")})
    if r.get("ok"):
        _sum = _clip(data, name)[:600]
        if name in _DEDUPE_SEARCH:
            _SEARCH_SEEN[sig] = _sum
        return ("工具 %s 返回：%s" % (name, _clip(data, name)), card, None)
    _FAILED[sig] = str(bad or "")[:200]
    return ("工具 %s 失败：%s" % (name, bad or ""), card, None)



# ---------------------------------------------------------------- 说一句
# 模型想收工时，这句话里出现这些词 = 它自己承认还有活没干完。
# 不靠它自觉，机械拦一道：这些都能自己查，别把半截话交给用户。
_UNFINISHED = ("我查一下", "我再查", "我得查", "我需要查", "得看", "我得看",
               "我需要知道", "得知道你", "才能算", "这个我没查到", "我这儿没查到",
               "没有查到", "暂时查不到", "我需要先了解",
               # 下面这些是「宣告要去干活」——说完不调工具等于放空炮。
               # 实测模型就栽在这：回一句「我出去搜一遍」就收工了。
               "我出去搜", "我去搜", "我搜一遍", "搜一遍候选", "我出去找", "我去找",
               "我找一遍", "找一遍", "我去翻", "我翻一遍", "我先去找", "我先去搜",
               # 「卡住了就绕过去」——不查了，拿猜的先糊一版。
               # 实测模型会写「分集数等核出来再校正」，然后自己拍一版数字给用户。
               # 这比空等更坏：用户以为拿到了计划，其实是编的。
               "先拟一版", "先拟一版计划", "换个法子", "你别等了", "等核出来",
               "等核出来再", "核出来再校正", "按已知的", "先按已知", "我再核", "我去核")


# 把决策推回给人的句式。用户明确要求「他自己决策」，这类话一律打回重答。
_ASK_BACK = ("要不要我", "需要我", "要我来", "我可以帮你", "我帮你", "你看要不要",
             "需要你确认", "你确认一下", "你说一声", "你告诉我", "要我做吗", "需要我做吗",
             "你说怎么走", "你定", "你决定", "听你的", "你选", "要不要改",
             "要我改", "等你定", "你看行吗", "你觉得呢", "你想怎么")


def _defers(say):
    """是不是把「该不该做」又丢回给用户了。是就返回命中的那个词。"""
    t = (say or "")
    for w in _ASK_BACK:
        if w in t:
            return w
    return None


def _unfinished(say):
    """回一句人话，但里面还带着未完成信号 —— 返回命中的那个词，否则 None。"""
    t = (say or "")
    for w in _UNFINISHED:
        if w in t:
            return w
    return None


# 「下一步点这里」这类指路话 —— 它没回答任何东西，只是让人去按按钮。
# 2026-10-26 实况：13 轮搜课核课之后只吐一句「下一步可以点这两件事」，
# 用户看到的是一句废话加两个按钮，问他那句问题的答案一个字没有。
_POINTER_HEADS = ("下一步", "接下来", "下面", "往下", "你可以", "请点", "点下面",
                  "开始吧", "按下面", "选一个", "点一下")


def _pointer_only(say):
    """这句话是不是只有"往下点"的意思、一句正事都没说。

    判得很保守：短句才算（长句里带了内容就放过）。误判一次也只是催它补一句，不会丢东西。
    """
    t = (say or "").strip()
    if not t:
        return True
    if len(t) > 24:
        return False
    if any(t.startswith(h) for h in _POINTER_HEADS):
        return True
    return len(t) <= 8


# 这些事只有人知道，但**必须用提问框问**，不许写在正文里让人自己打字。
# 人看到一整段字还得自己组织答案，看到选项点一下就完事 —— 这是两回事。
_ASK_IN_TEXT = ("哪天考", "考试日期", "什么时候考", "每天多久", "每天大概", "能学多久",
                "学多长时间", "哪几科", "考哪几", "学哪几", "要考哪", "选哪几",
                "哪一门", "哪科")


def _asks_in_text(say):
    """回答里是不是把「该用提问框问的事」写成了正文。是就返回命中的那个词。"""
    t = (say or "")
    if "?" not in t and "？" not in t:
        return None
    for w in _ASK_IN_TEXT:
        if w in t:
            return w
    return None


def _ask(sys_p, ctx, temperature=0.3, max_tokens=None, timeout=60, sink=None,
         effort=None, think=None):
    # 不传就按配置给：这一份额度是「思考 + 正文」共用的，
    # 写死小数字会把推理模型卡在「想完了但没轮到说」。
    max_tokens = max_tokens or config.LLM_MAX_TOKENS
    """问模型一次，返回 (ok, say, reason, model)。

    sink 不是 None 就边走边把文字交出去（前端做打字机）。

    但动作指令（JSON）一个字都不能给人看 —— 人看到 {"action":"call"...} 只会懵。
    两种位置都要挡：
      1. 整段以 { 开头：纯指令，全程不吐；
      2. 先说一句人话再贴指令（模型经常这么干）：人话照吐，
         一旦攒出「{"action」就立刻收声，后面的 JSON 一个字都不往外给。
    """
    if sink is None:
        r = model_router.chat(sys_p, ctx, temperature=temperature,
                              max_tokens=max_tokens, timeout=timeout)
        return bool(r.get("ok")), (r.get("text") or ""), r.get("reason"), r.get("model")

    buf = []
    head_done = [False]
    err = [None]
    think_only = [0]
    got_model = [None]
    for ev in model_router.chat_stream(sys_p, ctx, temperature=temperature,
                                       max_tokens=max_tokens, timeout=timeout,
                                       effort=effort):
        if ev.get("done"):
            got_model[0] = ev.get("model") or got_model[0]
            continue
        if ev.get("error"):
            err[0] = ev["error"]
            think_only[0] = int(ev.get("thinkOnly") or 0)
            continue
        # 思考片段：单独一条事件，不参与「像不像 JSON」的判断 ——
        # 那个判断只管正文。想什么本来就该让人看见。
        r = ev.get("r") or ""
        if r:
            if think is not None:
                think.append(r)
            try:
                sink({"t": "think", "d": r})
            except Exception:
                pass
            continue
        d = ev.get("d") or ""
        if not d:
            continue
        buf.append(d)
        joined = "".join(buf)
        # 走到指令开头就收声（后面全是 JSON，吐出去人看不懂）。
        # 注意只停「往外吐」，buf 要继续攒完 —— 不然后面拿到的 say 是半截，
        # _parse_action 认不出动作，这一轮就白跑了。
        if joined.find('{"action') >= 0:
            continue
        if joined.find("DSML") >= 0:
            continue                        # 标签串也是指令，同样一个字都不吐
        if head_done[0]:
            sink(d)
            continue
        head = joined.lstrip()
        if not head:
            continue                        # 还全是空白，再等等
        if head.startswith("{") or looks_like_dsml(head):
            continue                        # 纯动作指令：一个字都不吐
        head_done[0] = True
        sink(joined)
    say = "".join(buf).strip()
    if err[0]:
        # 只想了没说 ≠ 出错。它已经在干活了，只是没轮到开口。
        # 上层看到 think_only 应该再逼它一次，别把这一轮判死。
        if think_only[0] and not say:
            return False, say, err[0], got_model[0], True
        return False, say, err[0], got_model[0]
    return True, say, None, got_model[0]


def _sys_prompt(eff="medium", focus=None):
    """拼系统提示词：SYS 里的 %CATALOG% 换成真清单，再接思考强度那一段。

    为什么不在模块级拼死：能力清单得跟着 tools.REGISTRY 走，
    模块加载时 tools 可能还没导完（tools 反过来 import agent）。
    """
    # 按当前页面收窄能力清单：全量 16 类 2799 字，收窄后约 1200 字。
    # 收窄不是藏能力 —— 没展开的类会在末尾点名，让模型用 find_tool 现查。
    return SYS.replace("%CATALOG%", tools.catalog_text(focus=focus)) + _EFFORT_PROMPT.get(eff, "")


# ---------------------------------------------------------------- 一轮对话
def turn(text, confirmed=None, focus=None, sink=None, effort=None, resuming=False):
    """用户说一句，模型回一句（中间可能调若干工具）。

    confirmed: 用户刚点了「确认」的那个工具 {tool, args}，这一轮先把它放行。
    focus: 前端可以把当前页面（比如 'vocab'）传进来，模型据此少问一句废话。
    """
    text = (text or "").strip()
    # 确认重放那一轮本来就没有新话（用户只是点了「确认」）——
    # 以前这里一并拦掉，表现就是人点了确认，它回一句「说一句话再发过来」。
    if not text and not (confirmed and confirmed.get("tool")):
        return {"ok": False, "error": "说一句话再发过来"}

    # 思考强度：调用方没指定就用上次存的那档。默认 medium ——
    # low 容易跳过该查的步骤，high 实测和 medium 打平（上游可能封顶）。
    eff = str(effort or store.kv_get(RKV_EFFORT) or "medium").lower()
    if eff not in ("low", "medium", "high"):
        eff = "medium"

    ok, why = model_router.available()
    if not ok:
        return {"ok": False, "error": "现在没有能用的模型：%s" % why,
                "note": "去设置页选一家，或者配自己的 Key。"}

    msgs = _load()
    trace = []
    think = []          # 这一轮模型想了什么（只给界面留底，不进上下文）
    # 过程顺序：想一段 → 调一个工具 → 再想一段。前端拿它画时间线，
    # 刷新回来也照这个顺序复原（think 是整串、trace 是数组，拼起来读就把顺序抹平了）。
    steps = []
    _outer = sink
    if _outer is not None:
        def _rec(ev, _o=_outer):
            if isinstance(ev, dict):
                _t = ev.get("t")
                if _t == "think":
                    _d = ev.get("d") or ""
                    if _d:
                        tail = steps[-1] if steps else None
                        if tail and tail.get("k") == "think" and not tail.get("done"):
                            tail["t"] = (tail.get("t") or "") + _d
                        else:
                            steps.append({"k": "think", "t": _d})
                elif _t == "tool":
                    tail = steps[-1] if steps else None
                    if tail and tail.get("k") == "think" and not tail.get("done"):
                        tail["done"] = True
                    steps.append({"k": "tool", "x": {
                        "tool": ev.get("n"), "args": ev.get("args") or {},
                        "ms": ev.get("ms"), "ok": bool(ev.get("ok")),
                        "summary": ev.get("summary"), "ui": ev.get("ui"),
                        "error": ev.get("error"),
                        "confirmed": ev.get("confirmed"),
                        "need_confirm": ev.get("need_confirm"),
                    }})
                elif _t == "token":
                    tail = steps[-1] if steps else None
                    if tail and tail.get("k") == "think" and not tail.get("done"):
                        tail["done"] = True
            _o(ev)
        sink = _rec
    pending = None
    _empty_nudged = False      # 模型吐过一次空没（吐空只催一次，不无限重问）
    _card_nudged = False       # 查到结果却没给按钮，催过一次没（只催一次，不然打转）

    # 用户确认过的那步先补跑，把它当成已经发生的事写进上下文
    if confirmed and confirmed.get("tool"):
        out, card, pend = _run_tool(confirmed["tool"], confirmed.get("args") or {},
                                    confirmed=True, sink=sink)
        card["confirmed"] = True
        trace.append(card)
        if out:
            msgs.append({"role": "system", "content": out})
        # 明确告诉模型「这一步已经办完了」。
        # 不写这句它会当成「我还没做」，回头再调一次同一个写工具，
        # 人就会看到确认卡又弹一遍 —— 明明第一次已经成功了。
        msgs.append({"role": "system", "content":
                     "上面这个「%s」是用户刚点了确认才执行的，已经办完，不要重复调用。"
                     "直接用结果回答用户。" % (confirmed.get("tool") or "")})
        if pend:
            pending = pend

    # 人已经回过话了，上一轮那张提问卡就作废 —— 它挂在那儿只会在刷新后重新长出来一张死卡。
    for _m in msgs:
        if _m.get("role") == "assistant" and _m.get("ask"):
            _m["ask"] = None

    # 同一句话不能连着出现两遍。
    # resume() 会把最后那句用户话摘掉再重放，但如果它本来就是最后一条（模型一句没回过），
    # 上下文里就会变成「用户：X / 用户：X」—— 模型会以为人在催，回头去重新排计划。
    _last = next((m for m in reversed(msgs) if (m.get("content") or "").strip()), None)
    if not (_last and _last.get("role") == "user" and _last.get("content") == text
            and _last.get("focus") == focus):
        user_msg = {"role": "user", "content": text}
        if focus:
            user_msg["focus"] = focus
        msgs.append(user_msg)

    # 上下文拼成一个文本给模型：这个后端的三家模型都只有 system/user 两个位置，
    # 没有真正的多轮 messages。所以把历史压成「对话记录」塞进 user，最省事也最不容易错。
    ctx = _render_ctx(msgs)
    # 这句是不是「同意」—— 同意的那一轮，搜课流程一律不许再走一遍。
    # 只在上下文里已经摆着现成候选时才算数，否则「入库」两个字就能把它卡死。
    _apv_hit = _approve_of(text) if _cand_scan(msgs) else None
    _apv_blocks = 0
    provider = model_router.current()
    model = model_router.model_of(provider)

    # 这一轮属于哪条会话：没有就开一条，模型换了就新开一条。
    _sid, _turn_no, _new_sess = cur_session(focus=focus, provider=provider, model=model)
    _TL.sid, _TL.turn_no, _TL.user_text = _sid, _turn_no, text

    _FAILED.clear()      # 新一轮：上一轮失败过的工具允许再试一次
    _SEARCH_SEEN.clear() # 新一轮：同一个搜索词第一遍才真去搜
    _STOP.clear()        # 新一轮开始，上一轮的停止信号不再管这一轮

    # 用户按了停 → 在最近的检查点收口：会话照常落盘，界面收到 ok=True 的 end。
    # pending 是不是要弹的确认卡、think/steps 都是收口现场的原样，不加工。
    def _hit_stop():
        if not _STOP.is_set():
            return None
        msgs.append({"role": "system", "content": "（用户按了停，这一轮到此为止）"})
        _save(msgs)
        _stamp(trace=trace, pending=pending, think=think, steps=steps,
               meta={"provider": provider, "model": model, "rounds": 0})
        return {"ok": True, "stopped": True, "text": "已停下。",
                "trace": trace, "pending": pending,
                "provider": provider, "model": model, "rounds": 0}

    # 进度条：每进一轮就先告诉人「这一步在干嘛」。
    # 不然它闷头串 20 次工具调用，屏幕上只有一个转圈，人只能干等或者来问「它是不是卡了」。
    def _step(n, label, total=None):
        if sink:
            try:
                sink({"t": "step", "n": n, "label": label,
                      "total": total or 0, "done": len(trace)})
            except Exception:
                pass

    for rnd in range(MAX_ROUND):
        _hit = _hit_stop()
        if _hit:
            return _hit
        _step(rnd + 1, "想一下接下来做什么" if rnd == 0 else "接着往下做")
        sys_p = _sys_prompt(eff, focus)
        if resuming and rnd == 0:
            sys_p += ("\n\n**这一轮是续跑**：上一轮你已经查过一轮了，下面上下文里那些工具结果都在。"
                      "不要再从头搜一遍 —— 拿已有的接着往下做，缺什么才补查，尽快收口给结论。")
        if rnd and rnd < WARN_ROUND:
            sys_p += ("\n\n你已经调了 %d 次工具。如果信息够了就直接回答；"
                      "如果还差，最多再调一两次；调不到就如实说调不到。" % rnd)
        elif rnd >= WARN_ROUND:
            sys_p += ("\n\n你已经调了 %d 次工具，还没收口。"
                      "**从现在起不要再搜、不要再核**：拿手上已有的结果直接下结论，"
                      "把查到的东西摆出来、把没查到的说成没查到，不要再开新的查询。" % rnd)
        okc, say, whyc, _m, *_rest = _ask(sys_p, ctx, temperature=0.3,
                                          timeout=60, sink=sink, effort=eff, think=think)
        if not okc:
            # 「全花在思考上」不是故障，是它还没轮到开口。逼它一次，别直接判死。
            if _rest and _rest[0]:
                msgs.append({"role": "system", "content":
                             "上一轮你只在思考，一个字都没说出来。别再权衡了："
                             "要么直接给出结论，要么立刻只回一个动作 JSON。"})
                _nthink = locals().get("_think_nudged", 0) + 1
                _think_nudged = _nthink
                if _nthink <= 2:
                    if sink is not None:
                        try:
                            sink({"t": "run", "n": "retry", "desc": "它只在想没说话，催一次"})
                        except Exception:
                            pass
                    continue
            # 路由被 platform_ai 当场修好了（function 对不上 / 名字不在目录里）：
            # 这一枪打空的原因在路由上，不在活上，重问一次就行 ——
            # 不重问的话，人就只看到一句报错，而那行报错其实已经自己好了。
            if not _empty_nudged and any(k in (whyc or "") for k in
                                         ("正文是空的", "不在这家的目录里", "已帮你改好", "已帮你切回")):
                _empty_nudged = True
                if sink is not None:
                    try:
                        sink({"t": "run", "n": "retry", "desc": "模型没吐字，路由修好了再问一次"})
                    except Exception:
                        pass
                msgs.append({"role": "system", "content":
                             "上一轮模型一个字都没吐出来。现在直接回答，不要输出空白。"})
                ctx = _render_ctx(msgs)
                continue
            return {"ok": False, "error": "模型没回话：%s" % whyc,
                    "trace": trace, "provider": provider, "model": model}
        say = (say or "").strip()
        # 吐空了（模型这一轮全是思考、正文一个字没有）—— 别把空气泡丢给人。
        # 催一次还空，就如实说没说出来，而不是留一片白让人自己猜是不是卡了。
        if not say and not _empty_nudged:
            _empty_nudged = True
            if sink is not None:
                try:
                    sink({"t": "run", "n": "retry", "desc": "这一轮它没说话，再问一次"})
                except Exception:
                    pass
            msgs.append({"role": "system", "content":
                         "刚才那一轮你一个字都没回。要么直接把结论说出来，要么调工具；"
                         "不要输出空白。"})
            ctx = _render_ctx(msgs)
            continue
        if not say:
            return {"ok": False, "error": "模型这一轮没说出话（连问两次都空）",
                    "trace": trace, "provider": provider, "model": model}
        act = _parse_action(say)

        # 模型没要工具 —— 大概率就是答案，收工。
        # 但先拦一道：如果这句话里它自己承认还有活没干完（「我查一下」「我需要知道…才能算」），
        # 那就是偷懒收工 —— 不采信，让它接着查。
        if not act:
            # 它把「该用提问框问的事」写进正文了 —— 打回去，让它改成 ask 动作。
            # 人说「不是发一句话让我自己看，是提问框」，这条就是照那句话做的。
            asked = _asks_in_text(say)
            if asked and rnd < MAX_ROUND - 2:
                msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             ("你这句话在问「%s」——这是要人拍板的事，不能用正文问。"
                              "改用 ask 动作，格式：{\"action\":\"ask\","
                              "\"question\":\"一句话问题\",\"options\":[\"选项A\",\"选项B\"],"
                              "\"multi\":false}。选项列全（最多 8 个），让人点一下就行。") % asked})
                ctx = _render_ctx(msgs)
                continue
            # 把选择丢回给人 —— 用户要的是结果，不是一串征询。
            # 只有在真的缺「只有人知道」的信息时才允许反问，那也必须走 ask。
            _d = _defers(say)
            if _d and rnd < MAX_ROUND - 2:
                msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             ("你说了「%s」—— 这是把决定又推回给用户了。"
                              "能自己查、自己能判断的，直接做掉再回答；"
                              "要动本机就直接调那个工具（系统会弹确认）。"
                              "只有缺「只有人知道」的信息时才用 ask，不要用正文问。") % _d})
                ctx = _render_ctx(msgs)
                continue
            weak = _unfinished(say)
            if weak and rnd < MAX_ROUND - 2:
                msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             "你这句话里有「%s」——说明还有活没干完就准备收工了。"
                             "考试日期、每天多少分钟、学到第几讲、今天该干什么，这些都是你自己"
                             "能查到的（plan_budget / get_current_lesson / plan_today / "
                             "stats_overview），不要问用户。现在去调，调完再回答。" % weak})
                ctx = _render_ctx(msgs)
                continue
            msgs.append({"role": "assistant", "content": say})
            _save(msgs)
            _stamp(trace=trace, pending=pending, think=think, steps=steps,
                   meta={"provider": provider, "model": model, "rounds": rnd + 1})
            return {"ok": True, "text": say, "trace": trace, "pending": pending,
                    "provider": provider, "model": model, "rounds": rnd + 1}

        kind = act.get("action")

        # 人已经说过「全部入库」了，它转头又把搜索流程跑一遍 —— 拦掉。
        # 2026-10-26 实况：这一轮烧了 find_tool + bili_search + plan_budget 才入一门，
        # 而那些 bvid 上一轮就摆在人眼前。课已经在手上了，重搜等于把同一份 token 再烧一次。
        # 只拦「重新找课」这一类，核时长（bili_verify）、真入库（course_add*）照常放行。
        if _apv_hit and _apv_blocks < 2 and kind in ("call", "calls", "find_tool", "catalog"):
            _want = []
            if kind == "call":
                _want = [act.get("tool") or ""]
            elif kind == "calls":
                _want = [x.get("tool") or "" for x in (act.get("list") or []) if isinstance(x, dict)]
            if kind in ("find_tool", "catalog") or any(n in _RE_SEARCH for n in _want):
                _apv_blocks += 1
                if say:
                    msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             "**停**：用户刚说的是「%s」，他已经同意了。"
                             "这件事上一轮就办到一半了 —— 那些课、bvid、时长都在上面的清单里，"
                             "不需要再搜、不用再查工具怎么用。\n"
                             "现在直接调 {\"action\":\"call\",\"tool\":\"course_add_many\","
                             "\"args\":{\"items\":[{\"bvid\":\"…\"}]}}，把清单里还没入库的一次入完。"
                             % _apv_hit})
                ctx = _render_ctx(msgs)
                continue

        # 一次要好几件互不依赖的查询 —— 并着跑，别一件一件排队。
        # 对标的是 Trae/WorkBuddy 的 parallel tool calls：人对「5 秒出结果」和
        # 「5 秒里一条条蹦」的耐心完全不一样。只并只读工具，写盘的一律排队等人点头。
        if kind == "calls":
            want = act.get("list") if isinstance(act.get("list"), list) else []
            want = [x for x in want if isinstance(x, dict) and x.get("tool")][:6]
            ready = []
            for x in want:
                nm = x.get("tool") or ""
                ag = x.get("args") if isinstance(x.get("args"), dict) else {}
                if nm not in tools.REGISTRY:
                    continue
                if (tools.REGISTRY.get(nm) or {}).get("perm") == config.PERM_CONFIRM:
                    continue                    # 要人点头的，不并
                ready.append((nm, ag))
            if len(ready) >= 2:
                if sink:
                    try:
                        sink({"t": "run", "n": "parallel",
                              "desc": "同时查 %d 件事" % len(ready)})
                    except Exception:
                        pass
                outs = _run_tools_parallel(ready, sink=sink)
                for c2, o2, _pend2 in outs:
                    trace.append(c2)
                    if o2:
                        msgs.append({"role": "system", "content": o2})
                    if _pend2:                  # 并发里冒出来的写操作也要人点头
                        pending = _pend2
                if say:
                    msgs.append({"role": "assistant", "content": say})
                ctx = _render_ctx(msgs)
                continue
            # 只剩一件（或者都要确认）—— 当单次调用来走，不特殊处理
            if ready:
                kind = "call"
                act = {"action": "call", "tool": ready[0][0], "args": ready[0][1]}

        if kind == "catalog":
            cat = _catalog_of(act.get("q"))
            _ct = {"tool": "catalog", "args": {"q": act.get("q")}, "ms": 0,
                   "ok": True, "summary": (cat.get("text") or "")[:300]}
            trace.append(_ct)
            if sink:
                try:
                    sink({"t": "tool", "n": "catalog", "ms": 0, "ok": True,
                          "args": {"q": act.get("q")},
                          "summary": (cat.get("text") or "")[:200]})
                except Exception:
                    pass
            msgs.append({"role": "assistant", "content": say})
            msgs.append({"role": "system", "content":
                         "这一堆工具是全的：\n%s\n\n%s" % (cat.get("text") or "", _CALL_HINT)})
            ctx = _render_ctx(msgs)
            continue

        if kind == "find_tool":
            found = _find_tool(act.get("q") or "")
            _ft = {"tool": "find_tool", "args": {"q": act.get("q")},
                   "ms": 0, "ok": found["ok"], "summary": _clip(found)[:300]}
            trace.append(_ft)
            if sink:
                try:
                    sink({"t": "tool", "n": "find_tool", "ms": 0, "ok": found["ok"],
                          "args": {"q": act.get("q")},
                          "summary": _clip(found.get("tools") or [])[:300]})
                except Exception:
                    pass
            body = ('检索「%s」得到这些工具：\n%s\n\n'
                    % (act.get('q'), _tool_card(found.get('tools') or [])
                       or '（一个都没找到）')) + _CALL_HINT
            msgs.append({"role": "assistant", "content": say})
            msgs.append({"role": "system", "content": body})
            ctx = _render_ctx(msgs)
            continue

        if kind == "call":
            _hit = _hit_stop()
            if _hit:
                return _hit
            name = act.get("tool") or ""
            # 会话管理是界面的事，模型不该碰：实测它拿 session_list / session_archive
            # 「整理会话」，把用户正聊着的几条全归档掉了（同时空转十几轮）。
            if name.startswith("session_") or name == "agent_reset":
                msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             "「%s」是界面上的会话管理功能，不归你调 —— 你也调不动。"
                             "用户问什么就直接答什么，别去动会话。" % name})
                ctx = _render_ctx(msgs)
                continue
            # 空转保护：轮数上限从 20 放开到 200 之后，必须有这道闸。
            # 实测 deepseek-v4.1-flash 会在 session_list ↔ session_archive 之间
            # 无限来回拨（十几轮），人看到的就是「一直不输出，卡住了」。
            # 判据不看轮数看「花样」：最近 12 次调用只有 1~2 个工具、且每个都重复 ≥4 次。
            _recent = [t.get("tool") for t in trace[-12:]
                       if isinstance(t, dict) and t.get("tool")]
            if len(_recent) >= 8:
                _uniq = set(_recent)
                _top = max(_recent.count(x) for x in _uniq) if _uniq else 0
                if len(_uniq) <= 2 and _top >= 4:
                    _names = " / ".join(sorted(_uniq))
                    _spin_n = locals().get("_spin_n", 0) + 1
                    _spin_n = _spin_n
                    if _spin_n >= 3:
                        # 提醒三次还在转：直接收口，别让人干等一个空转的循环
                        _save(msgs)
                        _stamp(trace=trace, pending=pending, think=think, steps=steps,
                               meta={"provider": provider, "model": model, "rounds": rnd + 1})
                        return {"ok": True, "trace": trace, "pending": pending,
                                "provider": provider, "model": model, "rounds": rnd + 1,
                                "text": ("这一轮它卡在「%s」之间来回拨了 %d 次，我把它停下来了。"
                                         "你要它干的事没做完 —— 再说一遍、或者把要做的事说具体点，"
                                         "我重开一轮。" % (_names, len(_recent)))}
                    if sink is not None:
                        try:
                            sink({"t": "run", "n": "spin",
                                  "desc": "它在「%s」之间打转，打断它" % _names})
                        except Exception:
                            pass
                    msgs.append({"role": "assistant", "content": say})
                    msgs.append({"role": "system", "content":
                                 "你已经在 %s 之间来回调了 %d 次，结果不会变。"
                                 "**立刻停止调工具**：用已经拿到的结果直接回答用户；"
                                 "缺什么就直说缺什么、在哪个页面能自己看。"
                                 % (_names, len(_recent))})
                    ctx = _render_ctx(msgs)
                    continue
            args = act.get("args") if isinstance(act.get("args"), dict) else {}
            if confirmed and name == confirmed.get("tool"):
                # 同一个写工具本轮已经跑过了，再调一次就是把确认卡弹第二遍
                msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             "「%s」这一轮已经执行过了，别再调。用已有结果回答。" % name})
                ctx = _render_ctx(msgs)
                continue
            if name not in tools.REGISTRY:
                # 不编、不猜：直接告诉模型这名字不存在，并把它自己检索出来的候选再贴一次
                near = [n for n in tools.REGISTRY if name and name[:4] in n][:6]
                msgs.append({"role": "assistant", "content": say})
                msgs.append({"role": "system", "content":
                             "没有叫 %s 的工具。%s用 find_tool 重新检索。"
                             % (name, ("相近的有：" + "、".join(near) + "。") if near else "")})
                ctx = _render_ctx(msgs)
                continue
            out, card, pend = _run_tool(name, args, sink=sink)
            trace.append(card)
            if pend:
                pending = pend
                # 要人点头：模型想干什么这一句要留住，人得看懂再点。
                # 它没说人话就替它说明白 —— 但只陈述「要调哪个工具、动什么」，
                # 不替它编结果。
                said = (say or "").strip()
                # 这一轮的 say 往往就是那句 {"action":"call",...} 本身 ——
                # 拿它当人话回给用户，屏幕上就是一串 JSON。这种要换成人话。
                if said.startswith("{") or not said:
                    said = "我要调「%s」——%s。这一步会改本机，你点确认我才执行。" % (
                        pend.get("tool") or name,
                        pend.get("desc") or "这会写盘")
                msgs.append({"role": "assistant", "content": said})
                _save(msgs)
                _stamp(trace=trace, pending=pending, think=think, steps=steps,
                       meta={"provider": provider, "model": model, "rounds": rnd + 1})
                return {"ok": True, "text": said, "trace": trace, "pending": pending,
                        "provider": provider, "model": model, "rounds": rnd + 1,
                        "note": "这一动会改本机，等你点确认。"}
            if say:
                msgs.append({"role": "assistant", "content": say})
            msgs.append({"role": "system", "content": out})
            ctx = _render_ctx(msgs)
            continue

        if kind == "propose":
            # 它给出「点一下就往下走」的下一步。这一轮到此为止，卡片画出来等人点。
            # 按钮点下去是真调工具 —— 所以校验不过就退回普通回答，绝不给死按钮。
            card = _card_of(act)
            if card:
                # 用动作里自带的那句话，不用模型原文 —— 原文就是那串 JSON
                said = str(act.get("say") or "").strip() or card.get("title") or "下一步"
                # 「下一步可以点这两件事」不算回答。
                # 2026-10-26 实况：用户问「用两句话介绍这个台子」，它串了 13 轮搜课核课，
                # 最后只吐一句「下一步可以点这两件事」加两个按钮 —— 用户一个字都没得到，
                # 界面上看就是「卡在这儿了」。按钮是补充，不能顶替答案，所以先打回去一次。
                if _pointer_only(said) and not _card_nudged:
                    _card_nudged = True
                    msgs.append({"role": "assistant", "content": said})
                    msgs.append({"role": "system", "content":
                                 "你把整段回答换成了「下一步点这里」，用户问的那件事一个字没答。"
                                 "现在先用正文把结论说清楚：查到了什么、结论是什么、"
                                 "他问的那句话怎么答。按钮只能摆在结论后面，不能代替结论。"})
                    ctx = _render_ctx(msgs)
                    continue
                msgs.append({"role": "assistant", "content": said})
                _save(msgs)
                _stamp(trace=trace, card=card, think=think, steps=steps,
                       meta={"provider": provider, "model": model, "rounds": rnd + 1})
                return {"ok": True, "text": said, "trace": trace, "pending": None,
                        "card": card, "provider": provider, "model": model, "rounds": rnd + 1}
            msgs.append({"role": "assistant", "content": say})
            msgs.append({"role": "system", "content":
                         "这个 propose 我画不出来：card.actions 里每个都要有 tool（必须是清单里的名字）"
                         "和 args（对象），最多 4 个；而且**不许放只记状态、点了不产生结果的工具**"
                         "（intake_pick 就是这种：它只记下你挑中哪几门，课程库一个字没动）。"
                         "要真入库就用 course_add（一门一个按钮，带 bvid/name/subject）"
                         "或 intake_apply（把已核过的课一次全落库）。"
                         "要么按这个重发，要么直接说结论。" + _CALL_HINT})
            ctx = _render_ctx(msgs)
            continue
        if kind == "ask":
            # 它要人拍板。这一轮到此为止 —— 界面会把选项画成可点的框，
            # 人点一下就把答案当下一句 user 发回来，流水线接着走。
            box = _ask_of(act)
            if box:
                said = box["question"]
                msgs.append({"role": "assistant", "content": said})
                _save(msgs)
                _stamp(trace=trace, ask=box, think=think, steps=steps,
                       meta={"provider": provider, "model": model, "rounds": rnd + 1})
                return {"ok": True, "text": said, "trace": trace, "pending": None,
                        "ask": box, "provider": provider, "model": model, "rounds": rnd + 1}
            # 结构不合法就当它没问，让它重新组织一句话
            msgs.append({"role": "assistant", "content": say})
            msgs.append({"role": "system", "content":
                         "这个 ask 我没看懂：question 和 options（1~8 个）都要有。"
                         "要么按格式重发一次 ask，要么直接给结论。" + _CALL_HINT})
            ctx = _render_ctx(msgs)
            continue

        # 看不懂的动作 —— 当成普通回答，别让它把对话卡死
        msgs.append({"role": "assistant", "content": say})
        # 已经查到结果、准备收工，却只给了话没给按钮 —— 催它一次用 propose。
        # 只催一次：再多就是打转，人看着像卡死。
        if trace and not _card_nudged:
            _card_nudged = True
            msgs.append({"role": "system", "content":
                         "你这一轮已经查到结果了。下一步如果有明确能点的动作，就用 propose 给出按钮"
                         "（最多 4 个，每个 tool 和 args 都写全）。真的没有可点的就直接结束，别硬凑。"})
            ctx = _render_ctx(msgs)
            continue
        _save(msgs)
        _stamp(trace=trace, think=think, steps=steps,
               meta={"provider": provider, "model": model, "rounds": rnd + 1})
        return {"ok": True, "text": say, "trace": trace, "pending": None,
                "provider": provider, "model": model, "rounds": rnd + 1}

    # 用完次数还没收口：让它就现有信息给结论
    _okc, _say, _whyc, _m, *_rest = _ask(
        _sys_prompt(eff, focus)
        + "\n\n工具次数用完了。就现有信息直接回答，并说明哪部分没查到。", ctx,
        temperature=0.3, timeout=60, sink=sink, effort=eff, think=think)
    say = (_say or "").strip() if _okc else ""
    if not say:
        say = "工具调太多次还没结论，我先停下。你可以把问题问窄一点。"
    msgs.append({"role": "assistant", "content": say})
    _save(msgs)
    _stamp(trace=trace, think=think, steps=steps,
           meta={"provider": provider, "model": model, "rounds": MAX_ROUND})
    return {"ok": True, "text": say, "trace": trace, "pending": None,
            "provider": provider, "model": model, "rounds": MAX_ROUND}


def _last_user(msgs):
    for m in reversed(msgs):
        if m.get("role") == "user" and (m.get("content") or "").strip():
            return m
    return None


def resume(sink=None, effort=None):
    """接着上一轮没干完的活往下走。

    为什么需要它：模型一轮最多调 MAX_ROUND 次工具，核完 6 条课就到了上限，
    屏幕上留下「正在核第五条」就断了 —— 人只会问「怎么停了」。
    这里把最后那句用户话再喂一遍，但把第一句系统提示换成「你已经查过了」，
    它就不会从头再搜一遍，而是接着往下收口。
    """
    msgs = _load()
    u = _last_user(msgs)
    if not u:
        return {"ok": False, "error": "没有可以接着干的活"}
    text = u.get("content") or ""
    # 摘掉这条 user，让 turn() 重新追加（否则上下文里会出现两遍同一句）
    try:
        msgs.remove(u)
    except ValueError:
        pass
    _save(msgs)
    return turn(text, focus=u.get("focus"), sink=sink, effort=effort, resuming=True)


def _render_ctx(msgs):
    """把历史行拼成模型能读的文本。带 focus 的那句单独标出来。

    只读 role 和 content：trace / ask / pending / meta 那些是给界面看的记录，
    模型看不见 —— 看见就会学着「上次我也吐过这种 JSON」。
    唯一的例外是 _cand_block：它只从 trace 里取 bvid/标题/时长/核没核过这几项事实，
    压成「你上一轮查过哪些课」，不把 trace 原样塞回去。
    """
    # 老的那截压成摘要、近的保留原文 —— 原来写死 msgs[-24:]，
    # 一轮串十几个工具就能把"每天能学 3 小时"这种话挤出窗口，
    # 人看到的就是"它失忆了"。压缩只丢措辞，不丢数字（见 context.py）。
    # 什么时候收紧：手动点过压缩，或者实测占用已经过了窗口的 68%。
    p = _pressure()
    tight = bool(_FORCE_TIGHT[0]) or (p is not None and p >= CTX_TIGHT_AT)
    head, tail = context.digest(msgs, tight=tight)
    lines = [head] if head else []
    for m in tail:
        role = m.get("role")
        c = context._txt(m).strip()
        if not c:
            continue
        if role == "user":
            f = m.get("focus")
            lines.append("用户：%s%s" % (c, ("（他正看着「%s」那一页）" % f) if f else ""))
        elif role == "assistant":
            # 把自己上一轮「真调过哪些工具」也写回去。没有这一行，
            # 模型只记得自己说过的话 —— 实测它会把上一轮编的
            # 「bili_verify 全失败 -404」当成事实抄进下一轮。
            tr = m.get("trace") or []
            tg = ""
            if tr:
                names = []
                for x in tr:
                    nm = (x or {}).get("tool") or ""
                    if nm and nm not in names:
                        names.append(nm)
                tg = "〔这一轮真调用过：%s〕" % "、".join(names[:8])
            elif any(w in c for w in ("-404", "核不到", "取不到", "没查到", "失败了")):
                # 这一轮一个工具都没调，却下了「查不到」的结论 —— 那是猜的。
                # 实测后果：模型把上一轮这句猜的话当成事实，反复引用，
                # 明明 bili_verify 是通的（200 集 / 64.9 小时）也说核不到。
                tg = "〔这句里的结论没经工具确认，别当依据〕"
            lines.append("你：%s%s" % (c, tg))
        else:
            lines.append("（系统）%s" % c)
    # 上一轮真查过的课，摊在问题前面。这一块是给「我同意 → 你入库」这条最常走的路补的：
    # 没有它，模型手上只有自己上一轮写的那段话（标题 + 小时数），没有 bvid，
    # 于是它只能把 bili_search 再跑一遍 —— 人看到的就是「同一件事干了两遍，token 白烧」。
    _lu = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
    _ut = (_lu or {}).get("content") or ""
    _apv = _approve_of(_ut)
    # 只在「这句话跟课有关」时摊候选：不然人问「今天学什么」，上下文里先糊上十门课，
    # 白白多几百字 token。判准了就摊，判不准不摊 —— 少摊不漏事。
    if _apv or any(w in _ut for w in ("课", "入库", "搜", "选", "加进", "哪门", "这门", "那门")):
        _blk = _cand_block(msgs, _apv)
        if _blk:
            lines.append(_blk)
    lines.append("\n现在回这一句。要调工具就**只**回一个 JSON："
                 '{"action":"find_tool","q":"检索词"} 或 '
                 '{"action":"call","tool":"工具名","args":{...}}；'
                 "不调工具就直接说人话，不要包 JSON。")
    return "\n".join(lines)


def _opts_of(raw):
    """选项两种写法都收：字符串数组（label 与 value 相同）和 {label, value}。"""
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raw = [raw]
    out = []
    for o in raw[:8]:
        if isinstance(o, dict):
            lb = str(o.get("label") or o.get("value") or o.get("k") or "").strip()
            vl = str(o.get("value") or o.get("label") or o.get("k") or "").strip()
        else:
            lb = vl = str(o or "").strip()
        if lb:
            out.append({"label": lb[:40], "value": vl[:80]})
    return out


# 这些工具不能当按钮：点了不产生任何看得见的变化，人只会以为「做完了」，其实什么都没发生。
# 2026-10-26 实况：卡片上写着「入库高数 + C 语言」，按钮的 tool 却是 intake_pick ——
# 它只把你挑中的 BV 号记进流水线状态，课程库一个字没动；前端看到 ok=True 就打「已执行」。
# 所以这一层直接不给它上按钮：要么换成真写库的（course_add / intake_apply），要么别提。
_CARD_NOOP = {"intake_pick", "intake_reset", "intake_state", "agent_reset",
              "context_status", "context_compact", "find_tool"}

# 手上已经有候选课时，这些工具不许再跑一遍 —— 它们的唯一产出就是「候选」。
# bili_verify 不在里面：核时长是补事实，不算重搜。
_RE_SEARCH = frozenset(["bili_search", "web_search", "search_all", "intake_start",
                        "intake_step", "intake_reply", "intake_state", "intake_pick",
                        "intake_apply"])


def _card_tool_ok(t):
    """这个工具配不配当一个按钮。

    判据只有一条：**点下去之后，用户能在界面上看见变化吗。**
    只改流水线内部状态、只读、只开关的东西都不算 —— 那不是动作，那是记一笔。
    """
    if not t:
        return False
    if t in _CARD_NOOP:
        return False
    if t.startswith("session_"):
        return False
    return True


def _card_of(act):
    """把模型给的 propose 动作整理成操作卡。

    校验很硬：按钮点下去是**真调工具**，所以 tool 必须在注册表里、args 必须是对象、
    而且这个工具点完必须真产生可见变化（见 _card_tool_ok）。
    凑不出一个合法按钮就当它没提议 —— 宁可只剩一句话，也不给一个点了没反应的死按钮。
    """
    c = act.get("card") if isinstance(act, dict) else None
    if not isinstance(c, dict):
        return None
    acts = c.get("actions")
    if not isinstance(acts, list):
        return None
    out = []
    for a in acts[:4]:
        if not isinstance(a, dict):
            continue
        t = str(a.get("tool") or "").strip()
        if t not in tools.REGISTRY or not _card_tool_ok(t):
            continue
        ent = tools.REGISTRY.get(t) or {}
        # 点按钮本身就是那次确认。模型忘了写 confirm 时不能让它在这卡住 ——
        # 写盘类工具不带 confirm 会弹「需要你确认后才执行」，人看到的还是"按钮没反应"。
        cf = bool(a.get("confirm")) or ent.get("perm") == config.PERM_CONFIRM
        out.append({"label": (str(a.get("label") or t))[:16],
                    "tool": t,
                    "args": a.get("args") if isinstance(a.get("args"), dict) else {},
                    "confirm": cf})
    if not out:
        return None
    # 同一门课在卡上出现两次，是模型常犯的错（2026-10-26 实况：三颗按钮里两颗是同一个 bvid，
    # 挂出来叫「全部入库（3 门）」，实际只有 2 门）。按 bvid 去重，后出现那颗里有用的参数
    # 合并进先出现的那颗 —— 人点了「全部入库」，就该正好入完、不多不少。
    _seen, _uniq = {}, []
    for a in out:
        bv = str((a.get("args") or {}).get("bvid") or "") if a["tool"] == "course_add" else ""
        if bv:
            if bv in _seen:
                for k, v in (a.get("args") or {}).items():
                    if v and not _seen[bv]["args"].get(k):
                        _seen[bv]["args"][k] = v
                continue
            _seen[bv] = a
        _uniq.append(a)
    out = _uniq
    # 按钮只带 bvid 也能点：name / subject 缺了就用手上已有的候选补上。
    # 不补的话点下去会被 course_add 打回「没说这门课归到哪一科」—— 人看到的是「按钮没反应」。
    # 候选表在进程里，重启就空；所以再挂一层「库里那条记录」—— 这门入过库就一定补得上。
    _lib = None
    for a in out:
        if a["tool"] != "course_add":
            continue
        _bv = str((a.get("args") or {}).get("bvid") or "")
        _cd = _CAND.get(_bv)
        if not _cd and _bv:
            try:
                if _lib is None:
                    _lib = {str(s.get("bvid") or ""): s
                            for s in (datahub.courses_extra().get("subjects") or [])}
                _row = _lib.get(_bv)
                if _row:
                    _cd = {"title": _row.get("name"),
                           "subject": datahub.canonical_subject_name(
                               _row.get("subject_id") or _row.get("id")) or ""}
            except Exception:
                _cd = None
        if not _cd:
            continue
        if not a["args"].get("name") and _cd.get("title"):
            a["args"]["name"] = _cd["title"][:60]
        if not a["args"].get("subject") and _cd.get("subject"):
            a["args"]["subject"] = _cd["subject"]
    # 「入库这门」摆了三个，人的念头是「全部入库」。三次点击不是体验问题，是设计漏了：
    # 只要卡上有两门以上 course_add，就自动补一颗批量按钮（点它走同一条 course_add）。
    # 补在最后而不是替掉哪个 —— 单门和批量都得留着，人才有得选。
    _ca = [a for a in out if a["tool"] == "course_add" and a["args"].get("bvid")]
    if len(_ca) >= 2:
        out.append({
            "label": "全部入库（%d 门）" % len(_ca),
            "tool": "course_add_many",
            "args": {"items": [{"bvid": a["args"].get("bvid"),
                                "name": a["args"].get("name"),
                                "subject": a["args"].get("subject")} for a in _ca]},
            "confirm": True,
            "batch": True,
        })
    return {"title": (str(c.get("title") or ""))[:90],
            "note": (str(c.get("note") or ""))[:140],
            "actions": out}


def _ask_of(act):
    """把模型给的 ask 动作整理成前端能直接画的结构。

    两种写法都收：
      ① 单问（老样子）：{"question": "...", "options": [...], "multi": false}
      ② 一次问几样：{"questions": [{"question": "...", "options": [...]}, ...]}
         —— 人 2026-10-24 要的就是这个：别一个问题一个来回，一次问全，
         人在这一个框里选完（或自己写），点一次「发出去」全部答完。

    规范不出来的就返回 None —— 宁可当成普通回答，也不画一个点不动的空框。
    """
    if not isinstance(act, dict):
        return None

    groups = []
    raw_groups = act.get("questions")
    if isinstance(raw_groups, list):
        for g in raw_groups:
            if not isinstance(g, dict):
                continue
            q = str(g.get("question") or g.get("q") or "").strip()
            opts = _opts_of(g.get("options"))
            if not q:
                continue
            groups.append({"question": q[:200], "options": opts,
                           "multi": bool(g.get("multi")) and len(opts) > 1})
    groups = groups[:5]

    if len(groups) > 1:
        # 多问里允许某一题不给选项 —— 那就是「你自己写」，前端只留输入框。
        if not any(g["options"] for g in groups):
            return None
        return {"question": "有几件事想先问清楚", "options": [], "multi": False,
                "groups": groups}
    if len(groups) == 1 and groups[0]["options"]:
        g = groups[0]
        return {**g, "groups": groups}

    q = str(act.get("question") or act.get("q") or "").strip()
    opts = _opts_of(act.get("options"))
    if not q or not opts:
        return None
    one = {"question": q[:200], "options": opts,
           "multi": bool(act.get("multi")) and len(opts) > 1}
    return {**one, "groups": [one]}


def _json_blocks(s):
    """把一段话里所有看起来像 JSON 的块挖出来（按花括号配对，不是正则）。

    模型经常「先说一句人话，再把动作指令附在最后」——只认「整段以 { 开头」
    会把它漏掉，结果那一串 JSON 原样落到屏幕上给人看。所以这里改成扫全段。
    """
    out = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] != "{":
            i += 1
            continue
        depth = 0
        j = i
        in_str = False
        esc = False
        while j < n:
            c = s[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        break
            j += 1
        if j < n and depth == 0:
            out.append(s[i:j + 1])
            i = j + 1
        else:
            i += 1
    return out


# 提示词里写的是纯 JSON，但模型行为不可控：实测 deepseek-v4-flash 走 WorkBuddy
# 中转时，会有几轮不吐 JSON 而吐一种带全角竖线的标签串：
#   <｜｜DSML｜｜ calls>
#   <｜｜DSML｜｜ invoke name="call">
#   <｜｜DSML｜｜ parameter name="tool" string="true">intake_state</｜｜DSML｜｜ parameter>
#   <｜｜DSML｜｜ parameter name="args" string="false">{}</｜｜DSML｜｜ parameter>
#   </｜｜DSML｜｜ invoke>
#   </｜｜DSML｜｜ calls>
# 以前解析层只认 JSON，认不出就整段当回答 —— 人看到的就是一屏标签，然后报「回复出错」。
# 所以解析层自己吃掉它：认出来当动作执行，认不出来才当正文。
_DSML_INVOKE = re.compile(r'invoke\s+name="([A-Za-z_]+)"(.*?)</[^\n]*?invoke\s*>', re.S)
_DSML_PARAM = re.compile(r'parameter\s+name="([A-Za-z_]+)"\s+string="(\w+)"\s*>(.*?)</', re.S)


def looks_like_dsml(s):
    """流式往外吐字时用：这段像不像标签串。像就一个字都别给人看。

    只看开头那几个字符 —— 正文里偶现 DSML 三个字母不该把整段话吞掉。
    """
    if not s:
        return False
    head = s.lstrip()
    return head.startswith("<") and "DSML" in head[:24]


def _parse_dsml(say):
    """把上面那种标签串翻成内部动作 dict。翻不出来返回 None。"""
    if not say or "DSML" not in say:
        return None
    items = []
    for act, body in _DSML_INVOKE.findall(say):
        kv = {}
        for pname, is_str, pval in _DSML_PARAM.findall(body):
            v = pval.strip()
            if is_str != "true":          # string="false" 的那一路值是 JSON
                try:
                    v = json.loads(v)
                except Exception:
                    pass
            kv[pname] = v
        if kv.get("tool"):
            items.append((act.lower(), kv))
    if not items:
        return None
    if len(items) == 1:
        act, kv = items[0]
        if act not in ("call", "ask", "find_tool", "catalog", "propose"):
            act = "call"
        return {"action": act, "tool": kv.get("tool"),
                "args": kv.get("args") if isinstance(kv.get("args"), dict) else {}}
    return {"action": "calls",
            "list": [{"tool": kv.get("tool"),
                      "args": kv.get("args") if isinstance(kv.get("args"), dict) else {}}
                     for _, kv in items]}


def _parse_action(say):
    """模型回的这段里有没有动作指令。有就返回 dict，没有返回 None。

    只认 find_tool / call / calls / ask 四种，宁可漏认也不误认 —— 误认会把一句正常回答吞掉。
    但**位置不再要求整段以 { 开头**：模型习惯先说一句人话再贴指令，
    这时候也要认出来，否则那串 JSON 会被当成回答直接显示给人看。
    两种写法都吃：纯 JSON，以及上面那种 DSML 标签串。
    """
    if not say:
        return None
    d = _parse_dsml(say)
    if d:
        return d
    for blk in _json_blocks(say):
        d, err = model_router.parse_json(blk)
        if err or not isinstance(d, dict):
            continue
        act = (d.get("action") or "").strip().lower()
        if act in ("find_tool", "call", "calls", "ask", "catalog", "propose"):
            return d
    return None


# ---------------------------------------------------------------- 给前端的元信息
_EFFORT_WHY = {
    "low": "答得短、回得快。适合闲聊、查一个数、确认一件事。",
    "medium": "默认档。该查几步就查几步，说清楚但不啰嗦。",
    "high": "想得细。会先逐条分析再下结论，适合排计划、比较取舍。",
}

# 真正起作用的东西：往系统提示词里加一段。
# 实测（同一问题、同一模型）：low 档正文 158 字，high 档 2601 字，差 16 倍；
# 而 reasoning_effort 字段对上游没有可辨影响（low 6326 vs high 6311，区间重叠）。
_EFFORT_PROMPT = {
    "low": ("\n\n【这次要短】直接给结论或结果，不要展开推理过程，"
            "不要罗列你考虑过的每一步。能一句说清就一句，最多五句。"),
    "medium": "",
    "high": ("\n\n【这次要想细】动手之前先把情况拆开逐条分析："
             "每个选项的利弊、各自的量级、互相冲突的地方。"
             "分析完再给结论，并把关键依据写出来。"),
}


def effort():
    cur = str(store.kv_get(RKV_EFFORT) or "medium").lower()
    if cur not in _EFFORT_WHY:
        cur = "medium"
    return {"ok": True, "current": cur,
            "levels": [{"k": k, "why": v, "on": k == cur} for k, v in _EFFORT_WHY.items()],
            "note": "三档改的是「回答要多细」：低档只要结论（实测 158 字），"
                    "高档先逐条分析再下结论（实测 2601 字）。"
                    "上游的 reasoning_effort 字段也照传，但实测对思考量没有可辨影响，"
                    "真正起作用的是提示词；没有「完全关掉思考」这一档。"}


def set_effort(level=None):
    k = str(level or "").strip().lower()
    if k not in _EFFORT_WHY:
        return {"ok": False, "error": "只有 low / medium / high 三档，收到的是 %r" % (level,)}
    store.kv_set(RKV_EFFORT, k)
    return {"ok": True, "current": k, "why": _EFFORT_WHY[k]}


def info():
    return {"ok": True, "tools": len(tools.REGISTRY), "max_round": MAX_ROUND,
            "provider": model_router.current(), "model": model_router.model_of(),
            "effort": str(store.kv_get(RKV_EFFORT) or "medium"),
            "confirm_tools": sorted(config.CONFIRM_TOOLS),
            "note": "整个研学台的 %d 个工具都能调；改盘的那几个要你点头。" % len(tools.REGISTRY)}
