# -*- coding: utf-8 -*-
"""研学台 · 模型路由：这一句到底交给谁说。

为什么要有这一层：现在本机有三条能说话的路 —— 自己的 Key（llm.py）、
WorkBuddy 账号（platform_ai.py）、Trae 账号（同一个文件）。上层（讲题、
作文批改、提问）不该知道走的是哪条，它只要一句「把这段说成人话」。

路由自己也不编：选了哪家、那家能不能用、不能用的原因，全部原样传回去。
选了 WorkBuddy 但它没登录，返回的就是「没登录」，不会悄悄回落到 Key 那家
假装成功——那种回落是最难被发现的一种假。

当前选择存在 kv 的 ai.provider（apikey / workbuddy / trae），默认 apikey。
"""
from __future__ import annotations

import json

from . import config
from . import llm
from . import platform_ai
from . import store

KV_PROVIDER = "ai.provider"
KV_MODEL = "ai.model.%s"          # 每家各自记住上次用的模型
KV_FUNCTION = "ai.function.%s"    # 平台家的 function（决定哪个模型名能说话）
KV_CTX = "ai.ctx.%s"              # 这个模型的上下文窗口（目录里给的，状态条算占用率用）
KV_CATALOG = "ai.catalog.%s"      # 上次拉到的整份目录（换模型时补窗宽 / 界面看详情用）

NAMES = {"apikey": "自己的 Key", "workbuddy": "WorkBuddy", "trae": "Trae"}


def current():
    p = (store.kv_get(KV_PROVIDER) or "apikey").strip().lower()
    return p if p in NAMES else "apikey"


def set_current(provider):
    provider = (provider or "").strip().lower()
    if provider not in NAMES:
        return {"ok": False, "error": "没有这一家：%s（可选 %s）"
                % (provider or "(空)", " / ".join(NAMES))}
    store.kv_set(KV_PROVIDER, provider)
    return {"ok": True, "provider": provider, "name": NAMES[provider],
            "note": "以后讲题就用 %s。随时能换回来。" % NAMES[provider]}


def model_of(provider=None):
    provider = provider or current()
    return store.kv_get(KV_MODEL % provider) or {
        "apikey": config.LLM_MODEL, "workbuddy": config.WB_MODEL,
        "trae": config.TRAE_MODEL}.get(provider, "")


def set_model(provider, model):
    provider = (provider or current()).strip().lower()
    if provider not in NAMES:
        return {"ok": False, "error": "没有这一家：%s" % provider}
    if not (model or "").strip():
        return {"ok": False, "error": "模型名是空的"}
    model = model.strip()
    store.kv_set(KV_MODEL % provider, model)
    # 换模型顺手把新模型的窗宽换成目录里那个 —— 不然占用率会一直按旧模型的窗口算。
    for m in catalog(provider):
        if m.get("id") == model and isinstance(m.get("ctx"), int) and m["ctx"] > 0:
            store.kv_set(KV_CTX % provider, str(m["ctx"]))
            return {"ok": True, "provider": provider, "model": model, "ctx": m["ctx"]}
    return {"ok": True, "provider": provider, "model": model}


def set_catalog(provider, rows):
    """把刚拉到的整份目录存下来。存它是为了两件事：换模型时补窗宽、
    界面点开详情能说清「这个模型多少窗口、什么能力」。"""
    try:
        store.kv_set(KV_CATALOG % (provider or current()).strip().lower(),
                     json.dumps(rows or [], ensure_ascii=False))
    except Exception as e:
        return {"ok": False, "error": str(e)[:120]}
    return {"ok": True, "n": len(rows or [])}


def catalog(provider=None):
    """上次拉到的目录。没拉过就是空列表 —— 界面据此不显示那段，不编。"""
    try:
        raw = store.kv_get(KV_CATALOG % (provider or current()).strip().lower())
        got = json.loads(raw) if raw else []
        return got if isinstance(got, list) else []
    except Exception:
        return []


def function_of(provider=None):
    """这家说话该带哪个 function。

    Trae 把这把钥匙按模型分开：同一个名字配错 function 就是 200+空流
    （实测 deepseek-v4.1-flash 只认 solo_work_remote）。所以它跟模型一起存，
    没存过才用 config 的默认值。WorkBuddy 没有这个概念，返回空串。
    """
    provider = provider or current()
    got = store.kv_get(KV_FUNCTION % provider)
    if got:
        return got
    return {"trae": config.TRAE_FUNCTION}.get(provider, "")


def set_function(provider, fn):
    provider = (provider or current()).strip().lower()
    if not fn:
        return {"ok": False, "error": "function 是空的"}
    store.kv_set(KV_FUNCTION % provider, fn.strip())
    return {"ok": True, "provider": provider, "function": fn.strip()}


def ctx_of(provider=None):
    """这个模型的上下文窗口（token 数）。不知道就返回 0 —— 界面据此不画占用率。

    kv 里没存过（老版本留下的、或者换模型时没带 ctx）就从上次拉到的目录里补：
    目录里每个模型本来就带 `context_window_tokens`，之前没存是漏了，不是没有。
    目录里也没有才返回 0 —— 那种情况界面上就缺这一块，不拿字数估一个百分比。
    """
    provider = provider or current()
    try:
        n = int(store.kv_get(KV_CTX % provider) or 0)
    except Exception:
        n = 0
    if n > 0:
        return n
    cur = model_of(provider)
    for m in catalog(provider):
        if m.get("id") == cur:
            v = m.get("ctx")
            if isinstance(v, int) and v > 0:
                return v
    return 0


def set_ctx(provider, ctx):
    try:
        n = int(ctx or 0)
    except Exception:
        return {"ok": False, "error": "ctx 不是数字"}
    if n <= 0:
        return {"ok": False, "error": "ctx 是空的"}
    store.kv_set(KV_CTX % (provider or current()), str(n))
    return {"ok": True, "provider": provider, "ctx": n}


def state():
    """界面要的那一份：选了谁、每家现在什么状态、当前模型名。"""
    cur = current()
    rows = platform_ai.providers()          # 已含 apikey 那家
    for r in rows:
        r["selected"] = (r["provider"] == cur)
        r["model"] = model_of(r["provider"])
    return {"current": cur, "current_name": NAMES.get(cur, cur),
            "model": model_of(cur), "function": function_of(cur),
            "ctx": ctx_of(cur), "providers": rows}


def available(provider=None):
    """跟 llm.available() 同一个形状：(bool, 原因)。"""
    provider = provider or current()
    if provider == "apikey":
        return llm.available()
    if requests_missing():
        return False, "环境里没有 requests，发不出请求"
    st = platform_ai.status(provider)
    if not st.get("configured"):
        return False, st.get("why") or "这一家还没登录"
    if not st.get("usable"):
        return False, st.get("why") or "这一家的登录态不可用"
    return True, "ok：%s（%s）" % (NAMES.get(provider, provider), st.get("account") or "已登录")


def requests_missing():
    try:
        import requests                      # noqa: F401
        return False
    except Exception:
        return True


def chat(system, user, provider=None, model=None, temperature=None,
         max_tokens=None, timeout=None, effort=None):
    """统一形状 {ok, text, model, reason}。走哪家就把哪家的原因原样带回来。

    effort 只对 WorkBuddy 有意义（实测它认 reasoning_effort），别的家传了也没人看。
    两条路（chat / chat_stream）签名保持一致，上层不用记哪个有哪个没有。
    """
    provider = provider or current()
    model = model or model_of(provider)
    if provider == "apikey":
        r = llm.chat(system, user, temperature=temperature,
                     max_tokens=max_tokens, timeout=timeout)
        r["provider"] = "apikey"
        return r
    r = platform_ai.chat(provider, system, user, model=model,
                         temperature=temperature, max_tokens=max_tokens,
                         timeout=timeout, effort=effort)
    r["provider"] = provider
    return r


def chat_stream(system, user, provider=None, model=None, temperature=None,
                max_tokens=None, timeout=None, effort=None):
    """流式版 chat。逐个 yield {"d": 片段}，最后 yield {"done": True, "model": ...}。

    只有 WorkBuddy / Trae 两家有流；自己的 Key 那家没接，如实说没接 ——
    不假装流式再一次性吐出来。
    """
    provider = provider or current()
    model = model or model_of(provider)
    if provider == "apikey":
        yield {"error": "「自己的 Key」这一家还没接流式；去上面模型列表换 WorkBuddy 或 Trae"}
        return
    for ev in platform_ai.chat_stream(provider, system, user, model=model,
                                      temperature=temperature, max_tokens=max_tokens,
                                      timeout=timeout,
                                        effort=effort):
        yield ev


def models(provider=None):
    provider = provider or current()
    if provider == "apikey":
        # OpenAI 兼容那家没有标准目录接口，不编清单：把配的那个报出来就好。
        return {"ok": True, "models": [{"id": config.LLM_MODEL,
                                        "name": config.LLM_MODEL + "（config 里配的）"}],
                "note": "这一家没有公开的模型目录接口，不列假清单；"
                        "想换模型直接改 server/config.local.json 的 LLM_MODEL。"}
    return platform_ai.models(provider)


def parse_json(text):
    return llm.parse_json(text)
