# -*- coding: utf-8 -*-
"""研学台 · XMind 云端接入（OAuth + MCP）。

端点与授权方式是实测过的，不是猜的：
  GET  https://app.xmind.com/.well-known/oauth-protected-resource
       → {"resource":"https://app.xmind.com/api/mcp",
          "authorization_servers":["https://app.xmind.com"],
          "required_scopes":["mcp:connect"]}
  GET  https://app.xmind.com/.well-known/oauth-authorization-server
       → authorization_endpoint /oauth/consent, token_endpoint /api/oauth/token,
         registration_endpoint /api/oauth/register,
         token_endpoint_auth_methods_supported ["none"],   ← 公开客户端，不用 client_secret
         code_challenge_methods_supported ["S256"],        ← PKCE
         grant_types_supported ["authorization_code","refresh_token"]

所以流程是：动态注册拿 client_id → PKCE 授权码 → 换 token → 拿 token 打 MCP。
未登录时所有函数如实返回 connected=False，不编内容。

token 存本机 SQLite 的 kv 表（跟其它本机数据一样不出机器）；
file 模式另存一份到 APP_DATA_DIR/xmind_token.json，方便你 copy 到另一台机器。
"""
import base64
import hashlib
import io
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config, store

# ------------------------------------------------------------------ 常量
ISSUER = "https://app.xmind.com"
MCP_URL = "https://app.xmind.com/api/mcp"
RESOURCE = "https://app.xmind.com/api/mcp"
AUTH_ENDPOINT = "https://app.xmind.com/oauth/consent"
TOKEN_ENDPOINT = "https://app.xmind.com/api/oauth/token"
REGISTER_ENDPOINT = "https://app.xmind.com/api/oauth/register"
SCOPE = "openid mcp:connect"

REDIRECT_PATH = "/oauth/xmind/callback"
REDIRECT_URI = "http://127.0.0.1:%d%s" % (config.PORT, REDIRECT_PATH)
CLIENT_NAME = "研学台 StudyDeck"

MCP_PROTOCOL = "2025-06-18"
NET_TIMEOUT = 25

TOKEN_FILE = os.path.join(config.APP_DATA_DIR, "xmind_token.json")

# 进行中的授权（内存：state → verifier）。服务重启就作废，重新点登录即可。
_PENDING = {}
_session_id = None


# ------------------------------------------------------------------ 小工具
def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _http(url, data=None, headers=None, method=None, timeout=NET_TIMEOUT):
    body = None
    if data is not None:
        body = data if isinstance(data, (bytes, bytearray)) else json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return {"ok": True, "status": r.status, "headers": dict(r.headers),
                "text": r.read().decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "headers": dict(e.headers or {}),
                "text": e.read().decode("utf-8", "replace")}
    except Exception as e:                                  # 断网 / DNS / 超时
        return {"ok": False, "status": 0, "headers": {},
                "text": "%s: %s" % (type(e).__name__, e)}


def _jget(url, headers=None):
    r = _http(url, headers=headers)
    if not r["ok"]:
        return {}
    try:
        return json.loads(r["text"])
    except ValueError:
        return {}


# ------------------------------------------------------------------ token 存取
def _load_token():
    """先读 kv，再读文件（文件那份可能被手工 copy 过来）。"""
    raw = store.kv_get("xmind_token")
    if not raw and os.path.exists(TOKEN_FILE):
        try:
            with io.open(TOKEN_FILE, "r", encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            raw = None
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def _save_token(d):
    d = dict(d or {})
    d["saved_at"] = time.time()
    raw = json.dumps(d, ensure_ascii=False)
    store.kv_set("xmind_token", raw)
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        tmp = TOKEN_FILE + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as f:
            f.write(raw)
        os.replace(tmp, TOKEN_FILE)
    except OSError:
        pass
    return d


def clear_token():
    store.kv_set("xmind_token", "")
    try:
        if os.path.exists(TOKEN_FILE):
            os.remove(TOKEN_FILE)
    except OSError:
        pass
    global _session_id
    _session_id = None


def _client_id():
    """动态注册一次，拿到就存起来；以后复用。"""
    cid = store.kv_get("xmind_client_id")
    if cid:
        return cid
    r = _http(REGISTER_ENDPOINT, data={
        "client_name": CLIENT_NAME,
        "redirect_uris": [REDIRECT_URI],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": SCOPE,
    }, headers={"Content-Type": "application/json"})
    if not r["ok"]:
        return None
    try:
        d = json.loads(r["text"])
    except ValueError:
        return None
    cid = d.get("client_id")
    if cid:
        store.kv_set("xmind_client_id", cid)
    return cid


# ------------------------------------------------------------------ 授权
_PENDING_FILE = os.path.join(config.APP_DATA_DIR, "xmind_pending.json")


def _load_pending():
    """待授权记录落盘：原来只放内存，服务一重启就对不上 state，
    用户在浏览器点了同意也白点。这里读回来。"""
    if not os.path.exists(_PENDING_FILE):
        return {}
    try:
        with io.open(_PENDING_FILE, "r", encoding="utf-8") as f:
            d = json.loads(f.read() or "{}")
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_pending():
    try:
        os.makedirs(os.path.dirname(_PENDING_FILE), exist_ok=True)
        tmp = _PENDING_FILE + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(_PENDING, ensure_ascii=False))
        os.replace(tmp, _PENDING_FILE)
    except OSError:
        pass


def start_login(open_browser=True):
    """返回要打开的授权页 URL。前端拿它跳浏览器；回调落在本服务的 /oauth/xmind/callback。"""
    cid = _client_id()
    if not cid:
        return {"error": "拿不到 client_id：动态注册失败（联网了吗？）",
                "detail": "注册端点 %s" % REGISTER_ENDPOINT}
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = secrets.token_urlsafe(16)
    _PENDING.clear()
    # 重启后先把落盘那份捞回来，state 才对得上
    for k, v in _load_pending().items():
        if time.time() - float(v.get("at") or 0) <= 600:
            _PENDING[k] = v
    _PENDING[state] = {"verifier": verifier, "at": time.time()}
    # 清掉超过 10 分钟的半成品
    for k in [k for k, v in _PENDING.items() if time.time() - v["at"] > 600]:
        _PENDING.pop(k, None)
    _save_pending()
    q = urllib.parse.urlencode({
        "client_id": cid,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": RESOURCE,
    })
    url = "%s?%s" % (AUTH_ENDPOINT, q)
    out = {"url": url, "state": state, "redirect_uri": REDIRECT_URI,
           "client_id": cid, "scope": SCOPE}
    if open_browser:
        try:
            import webbrowser
            webbrowser.open(url)
            out["opened"] = True
        except Exception:
            out["opened"] = False
    return out


def finish_login(code, state):
    """回调里用：拿 code 换 token。"""
    if state not in _PENDING:            # 服务重启过，内存没了，去盘上找
        for k, v in _load_pending().items():
            if k not in _PENDING and time.time() - float(v.get("at") or 0) <= 600:
                _PENDING[k] = v
    pend = _PENDING.pop(state, None)
    _save_pending()
    if not pend:
        return {"error": "state 对不上或已过期（授权页开太久？重点一次登录）"}
    cid = store.kv_get("xmind_client_id") or _client_id()
    if not cid:
        return {"error": "本机没有 client_id，重新点登录"}
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": cid,
        "code_verifier": pend["verifier"],
        "resource": RESOURCE,
    }).encode("utf-8")
    r = _http(TOKEN_ENDPOINT, data=data,
              headers={"Content-Type": "application/x-www-form-urlencoded"})
    if not r["ok"]:
        return {"error": "换 token 失败（HTTP %s）" % r["status"], "detail": r["text"][:400]}
    try:
        d = json.loads(r["text"])
    except ValueError:
        return {"error": "换 token 返回的不是 JSON", "detail": r["text"][:400]}
    if not d.get("access_token"):
        return {"error": "没拿到 access_token", "detail": r["text"][:400]}
    d["expires_at"] = time.time() + float(d.get("expires_in") or 3600)
    _save_token(d)
    global _session_id
    _session_id = None
    return {"ok": True, "scope": d.get("scope"), "expires_in": d.get("expires_in")}


def refresh():
    t = _load_token()
    rt = t.get("refresh_token")
    if not rt:
        return {"error": "没有 refresh_token，重新登录一次"}
    cid = store.kv_get("xmind_client_id") or _client_id()
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "client_id": cid,
        "resource": RESOURCE,
    }).encode("utf-8")
    r = _http(TOKEN_ENDPOINT, data=data,
              headers={"Content-Type": "application/x-www-form-urlencoded"})
    if not r["ok"]:
        return {"error": "续期失败（HTTP %s）" % r["status"], "detail": r["text"][:300]}
    try:
        d = json.loads(r["text"])
    except ValueError:
        return {"error": "续期返回的不是 JSON"}
    if not d.get("access_token"):
        return {"error": "续期没给新 token", "detail": r["text"][:300]}
    d["expires_at"] = time.time() + float(d.get("expires_in") or 3600)
    if not d.get("refresh_token"):
        d["refresh_token"] = rt
    _save_token(d)
    return {"ok": True, "expires_in": d.get("expires_in")}


def access_token(auto_refresh=True):
    """拿一个还能用的 access_token；快过期就先续。没有就返回 None。"""
    t = _load_token()
    at = t.get("access_token")
    if not at:
        return None
    exp = float(t.get("expires_at") or 0)
    if exp and time.time() > exp - 60 and auto_refresh:
        r = refresh()
        if r.get("ok"):
            return _load_token().get("access_token")
        return None
    return at


def status():
    """真实的连接状态：token 过期就如实说过期，不再拿一个死 token 报「已登录」。"""
    t = _load_token()
    at = t.get("access_token")
    if not at:
        return {"connected": False, "reason": "还没登录过 XMind",
                "login": "点「登录 XMind」会在浏览器里打开官方授权页"}
    exp = float(t.get("expires_at") or 0)
    left = int(exp - time.time()) if exp else None
    if exp and time.time() > exp - 60:
        # 过期（或 60 秒内要过期）：先试着续一次，续不上就老实说过期
        r = refresh()
        if r.get("ok"):
            t = _load_token()
            exp = float(t.get("expires_at") or 0)
            left = int(exp - time.time()) if exp else None
        else:
            return {"connected": False,
                    "reason": "登录已过期，续不上：" + str(r.get("error") or "服务端没给原因"),
                    "detail": r.get("detail", ""),
                    "expired_at": t.get("expires_at"),
                    "has_refresh": bool(t.get("refresh_token")),
                    "login": "点顶栏「连 XMind」重新授权一次（浏览器里点同意）",
                    "token_file": TOKEN_FILE}
    return {"connected": True,
            "scope": t.get("scope") or "",
            "expires_in": max(0, left) if left is not None else None,
            "expires_at": t.get("expires_at"),
            "has_refresh": bool(t.get("refresh_token")),
            "saved_at": t.get("saved_at"),
            "token_file": TOKEN_FILE,
            "mcp": MCP_URL}


# ------------------------------------------------------------------ MCP 调用
def _mcp_post(payload, token, session_id=None):
    h = {"Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "Authorization": "Bearer %s" % token}
    if session_id:
        h["mcp-session-id"] = session_id
    r = _http(MCP_URL, data=payload, headers=h)
    if r["status"] == 401 and token:
        return {"_unauthorized": True, "raw": r}
    return {"status": r["status"], "headers": r["headers"], "text": r["text"], "ok": r["ok"]}


def _parse_mcp(r):
    """MCP 可能回 JSON，也可能回 SSE（text/event-stream）。两种都要能吃。"""
    txt = (r or {}).get("text") or ""
    if not txt:
        return None
    for line in txt.splitlines():
        if line.startswith("data:"):
            body = line[5:].strip()
            try:
                return json.loads(body)
            except ValueError:
                continue
    try:
        return json.loads(txt)
    except ValueError:
        return None


def mcp_initialize():
    """握手。MCP 要求先 initialize，并把回包里的 mcp-session-id 带回去。"""
    token = access_token()
    if not token:
        return {"error": "未登录 XMind"}
    r = _mcp_post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": MCP_PROTOCOL,
                              "capabilities": {},
                              "clientInfo": {"name": "studydeck", "version": "1.0"}}},
                  token)
    if r.get("_unauthorized"):
        return {"error": "token 被拒（401）", "detail": (r.get("raw") or {}).get("text", "")[:300]}
    if r.get("status") not in (200, 202):
        return {"error": "initialize 失败（HTTP %s）" % r.get("status"),
                "detail": (r.get("text") or "")[:300]}
    sid = (r.get("headers") or {}).get("mcp-session-id")
    global _session_id
    if sid:
        _session_id = sid
    # 通知一次 initialized，某些服务端要靠这个才肯干活
    _mcp_post({"jsonrpc": "2.0", "method": "notifications/initialized"}, token, sid or _session_id)
    msg = _parse_mcp(r)
    return {"ok": True, "session": sid, "server": (msg or {}).get("result", {}).get("serverInfo")}


def mcp_tools():
    """真的去问服务端有哪些工具 —— 名字不写死，因为它家工具表会变。"""
    token = access_token()
    if not token:
        return {"error": "未登录 XMind"}
    if not _session_id:
        init = mcp_initialize()
        if init.get("error"):
            return init
    r = _mcp_post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
                  access_token(), _session_id)
    if r.get("_unauthorized"):
        return {"error": "token 被拒（401），重新登录"}
    msg = _parse_mcp(r)
    if not msg:
        return {"error": "看不懂服务端的回包", "detail": (r.get("text") or "")[:300]}
    if msg.get("error"):
        return {"error": "服务端报错：%s" % (msg["error"].get("message") or msg["error"])}
    tools = ((msg.get("result") or {}).get("tools") or [])
    return {"ok": True, "count": len(tools),
            "tools": [{"name": t.get("name"),
                       "desc": (t.get("description") or "")[:200]}
                      for t in tools]}


def mcp_call(name, args=None):
    token = access_token()
    if not token:
        return {"error": "未登录 XMind"}
    if not _session_id:
        init = mcp_initialize()
        if init.get("error"):
            return init
    r = _mcp_post({"jsonrpc": "2.0", "id": int(time.time() * 1000) % 1000000,
                   "method": "tools/call",
                   "params": {"name": name, "arguments": args or {}}},
                  access_token(), _session_id)
    if r.get("_unauthorized"):
        return {"error": "token 被拒（401），重新登录"}
    msg = _parse_mcp(r)
    if not msg:
        return {"error": "看不懂服务端的回包", "detail": (r.get("text") or "")[:300]}
    if msg.get("error"):
        return {"error": "服务端报错：%s" % (msg["error"].get("message") or msg["error"])}
    res = msg.get("result") or {}
    out = {"ok": True, "tool": name}
    if isinstance(res.get("content"), list):
        out["text"] = "\n".join(
            (c.get("text") or "") for c in res["content"] if isinstance(c, dict))
    elif res.get("structuredContent") is not None:
        out["structured"] = res["structuredContent"]
    else:
        out["result"] = res
    out["is_error"] = bool(res.get("isError"))
    return out


def pick_tool(keywords, tools=None):
    """在真实工具表里按关键字挑一个，挑不到返回 None —— 不编工具名。"""
    t = tools if tools is not None else mcp_tools()
    lst = t.get("tools") or [] if isinstance(t, dict) else []
    for kw in keywords:
        for item in lst:
            n = (item.get("name") or "").lower()
            if kw.lower() in n:
                return item.get("name")
    return None
