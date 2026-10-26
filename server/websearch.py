# -*- coding: utf-8 -*-
"""去全网找资料：B 站之外的第二个口子。

为什么要有它（2026-10-24）：
    用户说「我想学 C 语言」，助手只会在本机翻一遍然后回「本机没有」。
    B 站搜课已经能用了，但「专升本 C 语言考什么 / 考纲 / 真题解析」这类东西
    不在视频里，在网页里。少了这一路，它就只能说「我不知道」。

只做两件可核实的事：
    search(kw)  —— 拿到候选（标题 / 链接 / 摘要）。来源按顺序试，谁先通谁上。
    fetch(url)  —— 取一页正文并抽成纯文本，给模型读。

没网、被挡、超时，一律如实返回 reason，绝不编一条结果凑数。
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request

from . import config

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

TIMEOUT = 8

# 这些站点在无 JS 的纯 GET 下会直接把结果吐在 HTML 里，够用就不再多找。
# 顺序是「谁能用先试谁」：DuckDuckGo 的 html 端点最稳，Bing 次之。
_ENGINES = ("so360", "ddg", "bing")


def _get(url, timeout=TIMEOUT, referer=None):
    h = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    if referer:
        h["Referer"] = referer
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _clean(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    s = (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
          .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " "))
    return re.sub(r"\s+", " ", s).strip()


def _ddg(kw, limit):
    """DuckDuckGo 的 html 端点。结果在 result__a / result__snippet 里。"""
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(kw)
    html = _get(url)
    items = []
    for m in re.finditer(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>'
            r'(?:.*?class="result__snippet"[^>]*>(.*?)</a>)?', html, re.S):
        link = m.group(1)
        # ddg 会给跳转链，把真地址从 uddg= 里挖出来
        q = urllib.parse.urlparse(link)
        if "uddg=" in (q.query or ""):
            link = urllib.parse.unquote(urllib.parse.parse_qs(q.query)["uddg"][0])
        title = _clean(m.group(2))
        if not title:
            continue
        items.append({"title": title[:120], "url": link,
                      "snippet": _clean(m.group(3))[:200]})
        if len(items) >= limit:
            break
    return items


def _bing(kw, limit):
    url = "https://cn.bing.com/search?q=" + urllib.parse.quote(kw) + "&ensearch=0"
    html = _get(url)
    items = []
    for m in re.finditer(r'<li class="b_algo".*?</li>', html, re.S):
        blk = m.group(0)
        a = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', blk, re.S)
        if not a:
            continue
        sn = re.search(r'<p[^>]*>(.*?)</p>', blk, re.S)
        items.append({"title": _clean(a.group(2))[:120], "url": a.group(1),
                      "snippet": _clean(sn.group(1))[:200] if sn else ""})
        if len(items) >= limit:
            break
    return items


def _so360(kw, limit):
    """360 搜索。国内直连，中文长词比 Bing 准（实测 Bing 会把「专升本 C语言」拆成「专」）。"""
    url = "https://www.so.com/s?q=" + urllib.parse.quote(kw)
    html = _get(url)
    items = []
    seen = set()
    # 360 的结果标题在 <h3> 里，但 href 有的是直接外链、有的是 e.so.com 的跳转壳。
    # 壳子里的真地址在 target= 参数里（实测形如 target=https%3A%2F%2F...）。
    for m in re.finditer(r'<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
        href = m.group(1)
        title = _clean(m.group(2))
        if not title or title in seen:
            continue
        real = href
        q = urllib.parse.urlparse(href)
        if "so.com" in (q.netloc or "") and "target=" in (q.query or ""):
            real = urllib.parse.parse_qs(q.query).get("target", [href])[0]
        if not real.startswith("http"):
            continue
        seen.add(title)
        items.append({"title": title[:120], "url": real, "snippet": ""})
        if len(items) >= limit:
            break
    return items


_FN = {"so360": _so360, "ddg": _ddg, "bing": _bing}


def search(kw, limit=8):
    """按顺序试搜索引擎，第一个有结果的就用。全挂就如实说全挂。"""
    kw = str(kw or "").strip()
    if not kw:
        return {"ok": False, "reason": "给个词再搜"}
    tries = []
    for eng in _ENGINES:
        try:
            items = _FN[eng](kw, limit)
        except Exception as e:
            tries.append("%s 失败：%s" % (eng, str(e)[:80]))
            continue
        if items:
            return {"ok": True, "engine": eng, "keyword": kw, "n": len(items),
                    "items": items, "tried": tries,
                    "note": "这些是网页候选，没核过内容；要引用就先 fetch 把正文读回来。"}
        tries.append("%s 回了 0 条" % eng)
    return {"ok": False, "keyword": kw, "items": [], "tried": tries,
            "reason": "两个搜索引擎都没返回结果（%s）。" % "；".join(tries)}


def fetch(url, max_chars=6000):
    """把一页读成纯文本。只做「取回来并抽字」，不解释、不总结。"""
    url = str(url or "").strip()
    if not url.startswith("http"):
        return {"ok": False, "reason": "只接 http/https 的地址"}
    try:
        html = _get(url, timeout=12)
    except Exception as e:
        return {"ok": False, "url": url, "reason": "取不回来：%s" % str(e)[:120]}
    body = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    text = _clean(body)
    cut = len(text) > max_chars
    return {"ok": True, "url": url, "chars": len(text), "truncated": cut,
            "text": text[:max_chars],
            "note": "已剥掉标签的正文前 %d 字。" % max_chars}
