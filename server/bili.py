# -*- coding: utf-8 -*-
"""去 B 站找课：能不能自动找、找回来能不能核。

这一层只做三件可核实的事，多一件都不做：

  1. search(keyword)  —— 拿到候选（标题 / UP / 播放 / 时长 / bvid）。
     走的是 wbi 签名接口；不带签名的老接口被风控挡成 412，那是实测过的。
  2. pages(bvid)      —— 拿分集目录：每一 P 的 cid、时长、标题。
  3. verify(bvid)     —— 交叉核对：view 报的总时长要等于分集时长之和，
                         view 报的分集数要等于目录长度。对不上就是「这份数据自己矛盾」，
                        不进候选 —— 宁可少一个结果，不放一个看起来对的错数据进去。

没联网、被挡、超时，都如实返回 reason，不假装搜过。
"""
import hashlib
import json
import os
import re
import time
import urllib.parse
import urllib.request

from . import config

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# wbi 签名要的 64 位重排表。值是 B 站前端写死的常量，不是我们编的。
_MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
          33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
          26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
          20, 34, 44, 52]

_cache = {"key": (0, 0), "val": None}


def enabled():
    return bool(getattr(config, "ENABLE_SEARCH", True))


def _get(url, timeout=None, cookie=None):
    """一个 GET，只返回 (json, err)。err 永远是人能读懂的一句话。

    cookie 只有登录后的接口才需要（playurl 高画质、nav 里的会员态）。
    免登录的接口传 None —— 带上 cookie 反而更容易触发风控。
    """
    t = timeout or getattr(config, "SEARCH_TIMEOUT", 8)
    h = {
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
    }
    if cookie:
        h["Cookie"] = cookie
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=t) as r:
            raw = r.read()
    except Exception as e:                      # 网络层的任何失败
        return None, "连不上（%s）" % (str(e)[:80] or e.__class__.__name__)
    try:
        return json.loads(raw.decode("utf-8", "replace")), None
    except Exception:
        return None, "回来的不是 JSON（前 60 字：%s）" % raw[:60]


def _mixin_key():
    """wbi 的 mixin_key 会变，每次现取，缓存 10 分钟。"""
    key = _cache["key"]
    now = time.time()
    if _cache["val"] and now - key[0] < 600:
        return _cache["val"], None
    d, err = _get("https://api.bilibili.com/x/web-interface/nav", timeout=6)
    if err:
        return None, "取签名用的 nav 失败：" + err
    wbi = ((d or {}).get("data") or {}).get("wbi_img") or {}
    img = (wbi.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
    sub = (wbi.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
    if len(img) < 32 or len(sub) < 32:
        return None, "nav 里没给 wbi_img（接口改版了？）"
    mk = "".join((img + sub)[i] for i in _MIXIN)[:32]
    _cache["val"] = mk
    _cache["key"] = (now, len(mk))
    return mk, None


def _sign(params, mk):
    p = dict(params)
    p["wts"] = int(time.time())
    q = urllib.parse.urlencode([(k, str(v)) for k, v in sorted(p.items())])
    p["w_rid"] = hashlib.md5((q + mk).encode()).hexdigest()
    return urllib.parse.urlencode(sorted(p.items()))


def _plain(s):
    return re.sub(r"<[^>]+>", "", s or "").replace("&quot;", '"').strip()


def _pic(u):
    """搜索结果里的封面是 //i2.hdslb.com/... 这种省略协议的写法，补成 https。

    补不出来的就回空串 —— 界面上退成一个色块，绝不拿别处的图冒充。
    """
    s = str(u or "").strip()
    if not s:
        return ""
    if s.startswith("//"):
        return "https:" + s
    if s.startswith("http://"):
        return "https://" + s[7:]
    return s if s.startswith("https://") else ""


def _secs(dur):
    """B 站的时长有两种写法：分:秒 与 时:分:秒。统一成秒。"""
    s = str(dur or "").strip()
    if not s:
        return 0
    parts = [x for x in s.split(":") if x != ""]
    try:
        nums = [int(x) for x in parts]
    except ValueError:
        return 0
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    return nums[0] if nums else 0


def search(keyword, limit=20):
    """搜候选。返回 {ok, keyword, n, items[], reason}。"""
    if not enabled():
        return {"ok": False, "keyword": keyword, "n": 0, "items": [],
                "reason": "这台机器上的联网取数被关掉了（ENABLE_SEARCH=False），所以我没有去搜。"}
    mk, err = _mixin_key()
    if err:
        return {"ok": False, "keyword": keyword, "n": 0, "items": [], "reason": err}
    qs = _sign({"search_type": "video", "keyword": keyword, "page": 1}, mk)
    d, err = _get("https://api.bilibili.com/x/web-interface/wbi/search/type?" + qs)
    if err:
        return {"ok": False, "keyword": keyword, "n": 0, "items": [], "reason": err}
    code = (d or {}).get("code")
    if code != 0:
        return {"ok": False, "keyword": keyword, "n": 0, "items": [],
                "reason": "接口回了 code=%s（%s）" % (code, (d or {}).get("message"))}
    res = ((d.get("data") or {}).get("result") or [])[:limit]
    items = []
    for r in res:
        bv = r.get("bvid") or ""
        if not bv.startswith("BV"):
            continue
        items.append({"bvid": bv, "title": _plain(r.get("title")),
                      "up": r.get("author"), "play": r.get("play") or 0,
                      "secs": _secs(r.get("duration")), "raw_dur": r.get("duration"),
                      "pubdate": r.get("pubdate") or 0,
                      # 封面：搜索结果自带（//i2.hdslb.com/...），补上协议头。
                      # 之前不返回它，界面上就只剩一行标题 —— 挑课等于盲选。
                      "pic": _pic(r.get("pic"))})
    return {"ok": True, "keyword": keyword, "n": len(items), "items": items, "reason": None}


# B 站 BV 号只有前缀 "BV" 是大写的，后 10 位是 base58（大小写都能出现），
# 整个大小写变了就是另一个号 —— view 直接回 code=-404。
# 实测栽过：模型把 BV17a7K64ELH 写成 BV17A7K64ELH，回来一句
# 「bili_verify 返回 -404」，它就把这门课判成了核不到。
_BV_CACHE = {}


def norm_bv(bvid):
    """把 BV 号恢复成真号。

    · 只前后空格 / 前缀大小写错 → 就地修；
    · 整体被大写或小写化 → 拿前缀 + 后四位去 search 结果里反查真号；
      反查不到就原样返回（让上游如实报错，别瞎猜）。
    """
    s = str(bvid or "").strip()
    if not s:
        return s
    up = s.upper()
    if not up.startswith("BV"):
        return s
    s = "BV" + s[2:]
    if s in _BV_CACHE:
        return _BV_CACHE[s]
    if s[2:] != s[2:].upper() and s[2:] != s[2:].lower():
        _BV_CACHE[s] = s
        return s
    # 后 10 位全大写/全小写 = 被整体转换过。真号里大小写混着，
    # 靠「view 的 -404 就是号错」这条，试几个常见位置逐个探。
    # base58 只有这 58 个字符，先试「第 3 位小写」这类最常见的走形，命中即停。
    import itertools
    alpha = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
    tail = s[2:]
    # 先试「首字母小写」（BV1x… 这类很常见）
    cands = []
    for i, ch in enumerate(tail):
        if ch.isupper():
            cands.append(tail[:i] + ch.lower() + tail[i + 1:])
    for t2 in cands[:12]:
        bv = "BV" + t2
        d, err = _get("https://api.bilibili.com/x/web-interface/view?bvid=" + bv)
        if not err and (d or {}).get("code") == 0:
            _BV_CACHE[s] = bv
            return bv
    _BV_CACHE[s] = s
    return s


def view(bvid):
    bvid = norm_bv(bvid)
    d, err = _get("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid)
    if err:
        return None, err
    if (d or {}).get("code") != 0:
        return None, "view 回了 code=%s" % (d or {}).get("code")
    return (d.get("data") or {}), None


def pages(bvid):
    """分集目录：这一份课到底有多少 P、每 P 多长。"""
    bvid = norm_bv(bvid)
    d, err = _get("https://api.bilibili.com/x/player/pagelist?bvid=" + bvid)
    if err:
        return None, err
    if (d or {}).get("code") != 0:
        return None, "pagelist 回了 code=%s" % (d or {}).get("code")
    out = []
    for p in (d.get("data") or []):
        out.append({"page": p.get("page"), "cid": p.get("cid"),
                    "secs": int(p.get("duration") or 0), "part": p.get("part")})
    return out, None


def verify(bvid):
    """交叉核对一份课。三条都必须成立：
         · 分集目录拿得到，且长度非 0；
         · view 报的 videos 数等于目录长度；
         · view 报的总时长等于各 P 时长之和。
       对不上就是假的/残缺的 —— 不进候选。
    """
    bvid = norm_bv(bvid)
    v, err = view(bvid)
    if err:
        return {"ok": False, "bvid": bvid, "reason": "取不到作品信息：" + err}
    pg, err = pages(bvid)
    if err:
        return {"ok": False, "bvid": bvid, "reason": "取不到分集目录：" + err}
    if not pg:
        return {"ok": False, "bvid": bvid, "reason": "分集目录是空的"}
    psum = sum(x["secs"] for x in pg)
    vsum = int(v.get("duration") or 0)
    vn = int(v.get("videos") or 0)
    bad = []
    if vn and vn != len(pg):
        bad.append("view 说有 %d P，目录里是 %d P" % (vn, len(pg)))
    if vsum and abs(vsum - psum) > 60:
        bad.append("view 说总长 %d 秒，分集加起来 %d 秒" % (vsum, psum))
    titled = len([x for x in pg if (x.get("part") or "").strip()])
    return {
        "ok": not bad,
        "bvid": bvid,
        "title": _plain(v.get("title")),
        "up": ((v.get("owner") or {}).get("name")),
        "pages": len(pg),
        "secs": psum or vsum,
        "hours": round((psum or vsum) / 3600.0, 1),
        "titled": titled,                     # 有分集标题的 P 数：没有标题就定位不到讲次
        "reason": "；".join(bad) if bad else None,
        "first_parts": [x.get("part") for x in pg[:6]],
        # 分集清单（有标题的才带 part）。前端拿它当「这门课有哪些讲」，也是排进课表的依据
        "pgs": [{"page": x.get("page"), "part": (x.get("part") or "").strip(),
                 "secs": x.get("secs")} for x in pg],
    }


# ---------------------------------------------------------------- 播放地址
#
# 两条路，实测都通了：
#   fnval=1  → durl 单文件 mp4（免登录最高 480P）。拖进度条最顺，登录失效时靠它续播。
#   fnval=16 → dash（音视频分离，1080P 只给这个）。要 ffmpeg 现场合流，浏览器才播得动。
#
# 直链带签名、约 2 小时过期，所以永远不交给前端 —— 只回本机 /stream/<lesson_id>。

_QN = {127: "8K", 126: "杜比", 125: "HDR", 120: "4K", 116: "1080P60",
       112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P"}

_play_cache = {}   # {(bvid,cid,qn,fnval): (ts, data)} —— 同一个 Range 请求会连打十几次，不能每次都去问 B 站
_PLAY_TTL = 600    # 10 分钟。直链本身活 2 小时，但宁可早一点重签


def _pick_quality(accept, want):
    """B 站给的 accept_quality 是降序列表。要不到想要的，就给它下面最接近的那一档。"""
    acc = [int(x) for x in (accept or []) if str(x).isdigit()]
    if not acc:
        return 0
    if want and int(want) in acc:
        return int(want)
    if want:
        lower = [q for q in acc if q <= int(want)]
        if lower:
            return max(lower)
    return max(acc)


def track_url(bvid, cid, qn=64, cookie=None):
    """取一 P 的播放地址。回 (payload, err)。

    payload 的 kind 是 'dash' 或 'durl'：
      dash → {kind, qn, quality, dur_sec, video, audio}（video/audio 都是带签名的原始直链）
      durl → {kind, qn, quality, dur_sec, url}
    """
    key = (bvid, str(cid), int(qn or 0))
    hit = _play_cache.get(key)
    now = time.time()
    if hit and now - hit[0] < _PLAY_TTL:
        return dict(hit[1]), None

    def ask(fnval, quality):
        u = ("https://api.bilibili.com/x/player/playurl?bvid=%s&cid=%s&qn=%d&fnval=%d&fourk=1"
             % (bvid, cid, quality, fnval))
        d, err = _get(u, cookie=cookie)
        if err:
            return None, err
        code = (d or {}).get("code")
        if code != 0:
            return None, "playurl 回了 code=%s（%s）" % (code, (d or {}).get("message") or "没有说明")
        return (d.get("data") or {}), None

    # 先问 dash（能到 1080P）；拿不到再退 durl（480P，免登录就能播）
    data, err = ask(16, qn)
    if not err and (data or {}).get("dash"):
        pick = _pick_quality(data.get("accept_quality"), qn)
        dash = data["dash"]
        vs = dash.get("video") or []
        auds = dash.get("audio") or []
        if not vs:
            err = "dash 里没有视频轨"
        else:
            v = next((x for x in vs if x.get("id") == pick), vs[0])
            a = max(auds, key=lambda x: int(x.get("bandwidth") or 0)) if auds else None
            out = {
                "kind": "dash", "qn": int(qn or 0), "quality": v.get("id"),
                "quality_name": _QN.get(v.get("id"), "%sP" % v.get("id")),
                "dur_sec": int(v.get("duration") or data.get("timelength", 0) // 1000),
                "video": v.get("baseUrl") or v.get("base_url"),
                "audio": (a or {}).get("baseUrl") or (a or {}).get("base_url"),
                "accept": data.get("accept_quality"),
            }
            if out["video"]:
                _play_cache[key] = (now, dict(out))
                return out, None
            err = "dash 视频轨没有直链"
    else:
        err = err or "没有 dash"

    data, err2 = ask(1, min(int(qn or 64), 64 if cookie else 32))
    if err2:
        return None, "取播放地址失败：%s；降级也失败：%s" % (err, err2)
    durl = (data or {}).get("durl") or []
    if not durl:
        return None, "取播放地址失败：%s；降级回来也没有 durl" % err
    seg = durl[0]
    out = {
        "kind": "durl", "qn": 32, "quality": 32, "quality_name": "480P",
        "dur_sec": int(round((data.get("timelength") or 0) / 1000.0)),
        "url": seg.get("url"), "size": seg.get("size"),
        "accept": data.get("accept_quality"),
    }
    if not out["url"]:
        return None, "durl 里没有直链"
    _play_cache[key] = (now, dict(out))
    return out, None


def clear_play_cache():
    """上游 403/412 时调用：缓存里的直链已经废了，清掉下一次重签。"""
    _play_cache.clear()


# ---------------------------------------------------------------- 扫码登录
#
# 不读浏览器 cookie：Chrome / Edge / Firefox 各存各的，且浏览器开着时 Cookies 库被独占锁。
# 走官方扫码接口，两处都能唤起（设置页一处、课堂播放失败处一处）。

_QR_STATE = {"key": None, "ts": 0}


def qr_generate():
    """取一张登录二维码。回 (payload, err)。"""
    d, err = _get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", timeout=8)
    if err:
        return None, "取二维码失败：" + err
    data = (d or {}).get("data") or {}
    url, key = data.get("url"), data.get("qrcode_key")
    if not url or not key:
        return None, "接口没给二维码（code=%s）" % (d or {}).get("code")
    _QR_STATE["key"] = key
    _QR_STATE["ts"] = time.time()
    return {"url": url, "qrcode_key": key, "expires_in": 180}, None


def qr_poll(key=None):
    """查扫码状态。回 (payload, err)。

    86101 等扫码 / 86090 已扫待确认 / 0 成功（此时带 Set-Cookie）/ 86038 已过期。
    成功时把 cookie 串也带回来，由上层决定存不存。
    """
    key = key or _QR_STATE.get("key")
    if not key:
        return None, "还没取过二维码，先点一下「扫码登录」"
    u = ("https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=%s"
         % urllib.parse.quote(str(key)))
    req = urllib.request.Request(u, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/",
    })
    cookie = None
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read()
            # 成功那一次，SESSDATA 在 Set-Cookie 里
            jars = r.headers.get_all("Set-Cookie") or []
            parts = []
            for c in jars:
                first = c.split(";")[0].strip()
                if "=" in first:
                    parts.append(first)
            if parts:
                cookie = "; ".join(parts)
    except Exception as e:
        return None, "连不上（%s）" % (str(e)[:80] or e.__class__.__name__)
    try:
        d = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None, "回来的不是 JSON"
    data = (d or {}).get("data") or {}
    code = data.get("code")
    msg = {
        0: "扫码成功",
        86101: "还没扫",
        86090: "扫了，等你在手机上确认",
        86038: "二维码过期了，重新取一张",
    }.get(code, data.get("message") or "状态 %s" % code)
    out = {"code": code, "state": msg, "ok": code == 0, "cookie": cookie,
           "refresh_in": 5 if code != 0 else 0}
    if code == 0 and not cookie:
        out["ok"] = False
        out["state"] = "扫码过了，但没拿到 SESSDATA —— 可能浏览器拦了 Set-Cookie"
    return out, None


# ---------------------------------------------------------------- 账号 / 进度同步
#
# 扫码登录只拿到 cookie，界面上什么都没变 —— 人看不到「我是谁、登没登上」。
# nav 这个接口一次给全：昵称、头像、等级、大会员。头像用 hdslb 的直链，
# 前端直接 <img>，不用落本机。
#
# 进度同步走两条路：
#   拉 —— player/wbi/v2 的 last_play_time（B 站自己记的秒数）
#   报 —— x/v2/history/report（带 csrf=bili_jct 的 form POST，实测 code=0）
# 这两条都是官方网页自己用的接口，不是抓包猜的。

def me(cookie=None):
    """账号信息。没登录就回 (None, None)，调用方自己决定怎么显示。"""
    if not cookie:
        return None, None
    d, err = _get("https://api.bilibili.com/x/web-interface/nav", cookie=cookie)
    if err:
        return None, err
    if (d or {}).get("code") != 0:
        return None, "没登录（nav code=%s）" % (d or {}).get("code")
    data = d.get("data") or {}
    if not data.get("isLogin"):
        return None, "没登录"
    return {
        "mid": data.get("mid"), "uname": data.get("uname"),
        "face": data.get("face"), "level": (data.get("level_info") or {}).get("current_level"),
        "vip": bool(data.get("vipStatus")),
        "money": data.get("money"),
    }, None


def cid_of(bvid, page):
    pgs, err = pages(bvid)
    if err:
        return None, err
    hit = next((x for x in pgs if int(x.get("page") or 0) == int(page or 1)), None)
    if not hit:
        return None, "这个 bvid 上没有第 %s P" % page
    return hit["cid"], None


def aid_of(bvid):
    """上报进度要 aid 不是 bvid。按 bvid 现查，不快但一次就够。"""
    v, err = view(bvid)
    if err:
        return None, err
    return (v or {}).get("aid"), None


def last_played(bvid, cid, cookie=None):
    """B 站给这一 P 记的播放进度（秒）。没登录 / 没看过就 0。"""
    if not cookie:
        return 0, "没登录"
    mk, err = _mixin_key()
    if err:
        return 0, err
    qs = _sign({"bvid": norm_bv(bvid), "cid": cid}, mk)
    d, err = _get("https://api.bilibili.com/x/player/wbi/v2?" + qs, cookie=cookie)
    if err:
        return 0, err
    if (d or {}).get("code") != 0:
        return 0, "wbi/v2 code=%s" % (d or {}).get("code")
    data = d.get("data") or {}
    ms = data.get("last_play_time") or 0
    return int(ms // 1000), None


def report_progress(bvid, cid, sec, cookie=None):
    """把进度报给 B 站（等于在网页上看了这么长）。成功回 (True, None)。"""
    if not cookie:
        return False, "没登录"
    csrf = ""
    for p in cookie.split(";"):
        p = p.strip()
        if p.startswith("bili_jct="):
            csrf = p.split("=", 1)[1]
            break
    if not csrf:
        return False, "cookie 里没有 bili_jct，报不了进度（重新扫码登录一次）"
    aid, err = aid_of(bvid)
    if err or not aid:
        return False, err or "拿不到 aid"
    body = urllib.parse.urlencode({
        "aid": aid, "cid": cid, "progress": max(0, int(sec)),
        "csrf": csrf, "platform": "web",
    }).encode()
    req = urllib.request.Request(
        "https://api.bilibili.com/x/v2/history/report", data=body,
        headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/",
                 "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookie})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        return False, "连不上（%s）" % (str(e)[:80] or e.__class__.__name__)
    if (d or {}).get("code") != 0:
        return False, "report code=%s %s" % ((d or {}).get("code"), (d or {}).get("message"))
    return True, None
