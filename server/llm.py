# -*- coding: utf-8 -*-
"""研学台 · 模型调用层。

只做三件事：拼请求、发请求、把回来的东西变成能用的 JSON。
不判断题目、不组装讲解 —— 那是 explain.py 的活。

设计约束（都是踩过的坑）：
1. 只认 OpenAI 兼容的 /chat/completions。DeepSeek / 通义 / Kimi / ollama 全是这个形状，
   换供应商只改 config 里的 LLM_BASE_URL，代码不动。
2. 只依赖 requests。这个项目不引第三方 SDK，装不上、版本冲突、SDK 改接口，全都不该
   拖垮学习工具。
3. 模型说的话必须能验。所以 chat() 只负责「把模型给的一段文本拿回来」，
   生成完立刻由调用方（explain.py）拿证据去核对，核对不过就当没说。
4. ENABLE_LLM=False 时如实返回没接，绝不返回编的内容。界面上那句「本机未接模型」
   就是从这里来的。
"""
from __future__ import annotations

import json
import re

from . import config

try:
    import requests
except Exception:                                    # pragma: no cover
    requests = None


def available():
    """能不能真调模型。前端拿这个决定按钮说什么。"""
    if not config.ENABLE_LLM:
        return False, "ENABLE_LLM=false：本机没开模型开关"
    if config.LLM_MOCK:
        return True, "mock：离线假答，不联网（仅测试用）"
    if not config.LLM_API_KEY:
        return False, "没配 LLM_API_KEY（写在 server/config.local.json 里）"
    if requests is None:
        return False, "环境里没有 requests，发不出请求"
    return True, "ok"


def _post(url, payload, headers, timeout):
    return requests.post(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                         headers=headers, timeout=timeout)


def chat(system, user, temperature=None, max_tokens=None, timeout=None):
    """调一次模型，返回 {ok, text, model, reason, raw}。

    ok=True 时 text 是模型给的原样文本（不做任何清洗）——
    清洗和校验是调用方的事，这里洗干净了反而看不出模型哪句是编的。
    """
    ok, why = available()
    if not ok:
        return {"ok": False, "reason": why, "text": None, "model": None}

    if config.LLM_MOCK:
        return {"ok": True, "text": _mock_text(user), "model": "mock", "reason": "mock"}

    url = config.LLM_BASE_URL.rstrip("/") + "/chat/completions"
    payload = {
        "model": config.LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": config.LLM_TEMPERATURE if temperature is None else temperature,
        "max_tokens": config.LLM_MAX_TOKENS if max_tokens is None else max_tokens,
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Bearer " + config.LLM_API_KEY,
    }
    try:
        r = _post(url, payload, headers, config.LLM_TIMEOUT if timeout is None else timeout)
    except Exception as e:
        return {"ok": False, "reason": "请求发不出去：%s" % str(e)[:120], "text": None, "model": None}

    if r.status_code != 200:
        return {"ok": False, "reason": "模型返回 HTTP %d：%s" % (r.status_code, r.text[:160]),
                "text": None, "model": None}
    try:
        d = r.json()
        text = d["choices"][0]["message"]["content"]
    except Exception:
        return {"ok": False, "reason": "回来的不是预期结构：%s" % r.text[:160],
                "text": None, "model": None}
    return {"ok": True, "text": text, "model": config.LLM_MODEL, "reason": "ok"}


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.M)


def parse_json(text):
    """从模型回复里抠出 JSON。模型经常在前后加解释或代码围栏，这里全兜住。

    返回 (obj, None) 或 (None, 错误说明)。解析不出来就是解析不出来，不回退成猜测。
    """
    if not text:
        return None, "模型没有返回内容"
    t = _FENCE.sub("", text).strip()
    if t.startswith("{") or t.startswith("["):
        try:
            return json.loads(t), None
        except Exception:
            pass
    # 抠第一个完整的 {...}
    start = t.find("{")
    if start >= 0:
        depth = 0
        for i in range(start, len(t)):
            if t[i] == "{":
                depth += 1
            elif t[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(t[start:i + 1]), None
                    except Exception as e:
                        return None, "JSON 抠出来了但解析失败：%s" % str(e)[:80]
    return None, "回复里找不到 JSON：%s" % t[:80]


def _mock_text(user):
    """离线假答：只用来跑通链路和测试，内容明显是假的，不会混进真讲解。"""
    return json.dumps({
        "judge": "（离线 mock）这一步本该由模型写，现在没有联网。",
        "fix": "（离线 mock）",
        "confidence_note": "mock",
    }, ensure_ascii=False)
