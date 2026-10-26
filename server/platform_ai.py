# -*- coding: utf-8 -*-
"""研学台 · 平台账号模型层（WorkBuddy / Trae）。

为什么单开一个文件，而不是塞进 llm.py：llm.py 只认 OpenAI 兼容的
/chat/completions，一个 Key 打天下。这两个平台不是那个形状 —— 它们的凭据
是「账号 token」，会过期、要刷新、刷新还有自己的接口和客户端 ID。混在一起
会让 llm.py 变成一坨 if，也会让「本机没接模型」这句诚实话变模糊。

三条硬规矩（跟全项目一致）：
1. 不编。凭据读不到就说读不到，刷新失败就说刷新失败，绝不返回一个假 token
   或一段假回答。
2. 能复用就复用。机器上已经装过的平台，它的登录态文件在这里直接读出来用 ——
   这就是「不用装平台也能登录」的前半段（装过的人不用再装一次、也不用重新扫码）。
3. 没装过的人也能进。提供「粘贴一段凭据文本」的入口：把平台那边导出的
   token / 刷新 token 贴进来即可，研学台自己续期。

凭据落盘位置：data/ai_cred/<provider>.json，不上传、不进同步包。
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import time

from . import config

try:
    import requests
except Exception:                                     # pragma: no cover
    requests = None


# ---------------------------------------------------------------------------
# 常量：全部实测过，不是猜的
# ---------------------------------------------------------------------------

WB_CN_CHAT_BASE = "https://copilot.tencent.com"
WB_REFRESH_PATH = "/v2/plugin/auth/token/refresh"
WB_CHAT_PATH = "/v2/chat/completions"
WB_CONFIG_PATH = "/v3/config"
WB_UA = "WorkBuddy/%s WorkBuddy/%s"
WB_FALLBACK_APP_VERSION = "5.5.6"

TRAE_GATEWAY_CN = "https://trae-api-cn.mchost.guru"
TRAE_GATEWAY_SG = "https://coresg-normal.trae.ai"
TRAE_CHAT_PATH = "/api/agent/v3/llm_utils_chat"
TRAE_DIR_PATH = "/api/ide/v1/get_detail_param"
TRAE_LEGACY_REFRESH_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken"
TRAE_CURRENT_REFRESH_PATH = "/trae/api/v3/oauth/ExchangeToken"
TRAE_CLIENT_ID_SOLO = "en1oxy7wnw8j9n"      # SOLO 包
TRAE_CLIENT_ID_DESKTOP = "ono9krqynydwx5"   # 桌面版
TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
TRAE_VERSION_CODE_FALLBACK = "20260716"

# 凭据文件候选位置（只读，不改不删；读不到就是没装过）
WB_CANDIDATES = [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
    os.path.join(os.environ.get("APPDATA", ""), "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
]
TRAE_CANDIDATES = [
    ("solo_cn", os.path.join(os.environ.get("APPDATA", ""), "TRAE SOLO CN", "User", "globalStorage", "storage.json")),
    ("solo", os.path.join(os.environ.get("APPDATA", ""), "TRAE SOLO", "User", "globalStorage", "storage.json")),
    ("desktop", os.path.join(os.environ.get("APPDATA", ""), "Trae", "User", "globalStorage", "storage.json")),
    ("desktop_cn", os.path.join(os.environ.get("APPDATA", ""), "Trae CN", "User", "globalStorage", "storage.json")),
]

TRAE_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide"


def cred_dir():
    d = os.path.join(config.APP_DATA_DIR, "ai_cred")
    if not os.path.exists(d):
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass
    return d


def _cred_path(provider):
    return os.path.join(cred_dir(), "%s.json" % provider)


def _read_json(path):
    try:
        with io.open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path, obj):
    try:
        with io.open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Trae 凭据解密（算法来自 dsh-buddy-hub/src/trae/decrypt.ts，本机两份文件实测能解）
# ---------------------------------------------------------------------------

_SALT_A = bytes([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
_SALT_B = bytes([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
_SALT_C = bytes([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
_SALT_D = bytes([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])


def _xor(a, b):
    return bytes(x ^ (b[i] if i < len(b) else 0) for i, x in enumerate(a))


def _aes_cbc(key, iv, data):
    raw = None
    try:
        from Crypto.Cipher import AES
        raw = AES.new(key, AES.MODE_CBC, iv).decrypt(data)
    except Exception:
        pass
    if raw is None:
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            d = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
            raw = d.update(data) + d.finalize()
        except Exception:
            pass
    if raw is None:
        raise RuntimeError("本机没有可用的 AES 实现（pycryptodome / cryptography 都没有）")
    try:
        n = raw[-1]
        if 1 <= n <= 16 and raw[-n:] == bytes([n]) * n:
            return raw[:-n]
    except Exception:
        pass
    return raw


def trae_decrypt(encoded):
    """解开 Trae storage.json 里那条 iCubeAuthInfo。实测本机两份文件都过校验。"""
    buf = base64.b64decode(encoded)
    if len(buf) <= 102:
        raise ValueError("Trae 凭据太短，不像加密块")
    head = buf[:6]
    if head == bytes([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]):
        salt = _xor(_SALT_A, _SALT_B)
    elif head == bytes([18, 57, 32, 32, 2, 3]):
        salt = _xor(_SALT_C, _SALT_D)
    else:
        raise ValueError("不认识的 Trae 凭据头：%s" % head.hex())
    random = buf[6:38]
    enc = buf[38:]
    first = hashlib.sha512(random).digest()
    derived = hashlib.sha512(first + salt).digest()
    out = _aes_cbc(derived[:16], derived[16:32], enc)
    if len(out) < 64:
        raise ValueError("解出来太短")
    if hashlib.sha512(out[64:]).digest() != out[:64]:
        raise ValueError("Trae 凭据校验不通过（不是这个文件，或格式变了）")
    return out[64:].decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# 从本机已装的客户端里读登录态
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# WorkBuddy 5.6+ 的 token 是就地加密的
#
# 2026-10 实测：workbuddy-desktop.info 里 auth.accessToken 不再是字符串，而是
#   {"$wbEncrypted": 1, "envelope": base64({suite,keyId,nonce,authTag,ciphertext})}
# 1331 字节的 AES-256-GCM 密文。老代码直接当成 token 字符串去拼 Authorization，
# 于是 step 报「can only concatenate str (not "dict") to str」——
# 界面却显示 configured / usable 全绿，这是最难发现的一种假。
#
# 打开它需要 atRestSecretKey，那把 key 只活在 WorkBuddy 自己的 Electron 私有绑定
# electron_browser_workbuddy_storage 里。所以必须用它的 exe 跑一次（run-as-node）：
#   WorkBuddy.exe -e 'process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()'
# 得到的 JSON 里 atRestSecretKey 是 base64(32 字节)，protectorKey = sha256(这个字符串)。
# AAD 是应用自己的 buildAuthenticatedContextAad，逐字节照抄：
#   "WB-AAD\0" | 0x01 | len+WBEV1 | len+sym-v1 | be32(suite) | len+keyId | 0x02 0x00 0x00
# 解不开（keyId 不符 / 标签不对）就如实报「这台机器的登录态是加密的，打不开」，
# 绝不拿密文去冒充 token。
# ---------------------------------------------------------------------------
WB_EXE_CANDIDATES = [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "WorkBuddy", "WorkBuddy.exe"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "WorkBuddy", "WorkBuddy.exe"),
    "F:/workbuddy/WorkBuddy.exe",
]
_WB_HELPER = ('try{process.stdout.write(String('
              'process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))}'
              'catch(e){process.stdout.write("ERR:"+e.message)}')
_WB_KEY_CACHE = {}


def _wb_at_rest_key():
    """让 WorkBuddy 自己把 atRestSecretKey 交出来。拿不到就说明为什么。"""
    if "k" in _WB_KEY_CACHE:
        return _WB_KEY_CACHE["k"], _WB_KEY_CACHE["why"]
    import subprocess
    tried = []
    env = dict(os.environ)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    for exe in WB_EXE_CANDIDATES:
        if not exe or not os.path.exists(exe):
            tried.append(exe or "(路径为空)")
            continue
        try:
            p = subprocess.run([exe, "-e", _WB_HELPER], capture_output=True,
                               env=env, timeout=60)
            txt = (p.stdout or b"").decode("utf-8", "replace").strip()
            if not txt or txt.startswith("ERR:"):
                tried.append(_base_name(exe) + "（%s）" % (txt[:60] or "没吐出东西"))
                continue
            j = json.loads(txt)
            secret = j.get("atRestSecretKey") or ""
            if not secret:
                tried.append(_base_name(exe) + "（返回里没有 atRestSecretKey）")
                continue
            _WB_KEY_CACHE["k"] = secret
            _WB_KEY_CACHE["why"] = None
            return secret, None
        except Exception as e:
            tried.append(_base_name(exe) + "（%s）" % (str(e)[:60],))
    why = ("这台机器上打不开 WorkBuddy 的加密登录态：没找到 WorkBuddy.exe，"
           "或者它没有那个私有绑定（试过：%s）" % "；".join(tried[-3:] or tried))
    _WB_KEY_CACHE["k"] = None
    _WB_KEY_CACHE["why"] = why
    return None, why


def _acct_text(v):
    """昵称在某些版本里也是加密信封 —— 界面要显示的是「谁」，不是一段 base64。"""
    if isinstance(v, dict):
        tok, _ = _wb_unwrap(v)
        return tok or "（昵称加密，解不开）"
    return v


def _base_name(p):
    try:
        return os.path.basename(p)
    except Exception:
        return str(p)


def _wb_unwrap(wrapped):
    """把 {$wbEncrypted:1, envelope} 解成明文 token。返回 (token, why)。"""
    if isinstance(wrapped, str):
        return wrapped, None
    if not isinstance(wrapped, dict) or not wrapped.get("envelope"):
        return None, "这个字段既不是字符串也不是加密信封，认不出来"
    try:
        import base64
        import hashlib
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception:
        return None, "环境里没有 cryptography，解不开 WorkBuddy 的加密登录态"
    secret, why = _wb_at_rest_key()
    if not secret:
        return None, why
    key = hashlib.sha256(secret.encode("utf-8")).digest()
    try:
        env = json.loads(base64.b64decode(wrapped["envelope"]).decode("utf-8"))
        key_id = env.get("keyId") or ""
        if hashlib.sha256(key).hexdigest()[:16] != key_id:
            return None, ("WorkBuddy 换了把 at-rest 钥匙（信封要 %s，本机这把是 %s）"
                          "—— 让它自己刷新一次登录再试" % (key_id, hashlib.sha256(key).hexdigest()[:16]))

        def _lp(s):
            b = s.encode("utf-8")
            return len(b).to_bytes(4, "big") + b
        suite = int(env.get("suite") or 1)
        aad = (b"WB-AAD\x00" + bytes([1]) + _lp("WBEV1") + _lp("sym-v1")
               + suite.to_bytes(4, "big") + _lp(key_id) + bytes([2, 0, 0]))
        pt = AESGCM(key).decrypt(base64.b64decode(env["nonce"]),
                                 base64.b64decode(env["ciphertext"]) + base64.b64decode(env["authTag"]),
                                 aad)
        return pt.decode("utf-8"), None
    except Exception as e:
        return None, "信封打不开（%s）" % (str(e)[:60],)


def _wb_from_file():
    tried = []
    for p in WB_CANDIDATES:
        if not p or not os.path.exists(p):
            tried.append(p or "(路径为空)")
            continue
        j = _read_json(p)
        if not isinstance(j, dict):
            tried.append(p)
            continue
        auth = j.get("auth") or {}
        acct = j.get("account") or {}
        raw = auth.get("accessToken")
        if not raw:
            tried.append(p + "（里面没有 accessToken）")
            continue
        tok, why = _wb_unwrap(raw)
        if not tok:
            tried.append(p + "（%s）" % why)
            continue
        rtok, _ = _wb_unwrap(auth.get("refreshToken"))
        nick = acct.get("nickname")
        if isinstance(nick, dict):
            nick, _ = _wb_unwrap(nick)
        return {
            "accessToken": tok,
            "refreshToken": rtok or "",
            "uid": acct.get("uid") or "",
            "nickname": nick or "",
            "enterpriseId": auth.get("enterpriseId") or "",
            "domain": auth.get("domain") or ((acct.get("sso") or {}).get("domain") or ""),
            "expiresAt": auth.get("expiresAt") or 0,
            "source": "desktop",
            "source_path": p,
        }, None
    return None, "本机没找到 WorkBuddy 的登录态（试过：%s）" % "；".join(tried[-2:] or tried)


def _trae_from_file():
    tried = []
    for edition, p in TRAE_CANDIDATES:
        if not p or not os.path.exists(p):
            tried.append(p or "(路径为空)")
            continue
        j = _read_json(p)
        if not isinstance(j, dict):
            tried.append(p)
            continue
        raw = j.get(TRAE_STORAGE_KEY)
        machine = j.get("telemetry.machineId") or ""
        device = j.get("telemetry.devDeviceId") or ""
        build = j.get("iCubeLastVersion") or ""
        if not isinstance(raw, str) or not raw.strip():
            tried.append(p + "（没有 %s）" % TRAE_STORAGE_KEY)
            continue
        try:
            plain = raw.strip() if raw.strip().startswith("{") else trae_decrypt(raw)
            o = json.loads(plain)
        except Exception as e:
            tried.append("%s（解不开：%s）" % (p, str(e)[:60]))
            continue
        tok = o.get("token") or ""
        if not tok:
            tried.append(p + "（解开后没有 token）")
            continue
        return {
            "token": tok,
            "accessToken": tok,
            "refreshToken": o.get("refreshToken") or "",
            "userId": str(o.get("userId") or ""),
            "host": o.get("host") or "",
            "userRegion": (o.get("userRegion") or {}).get("region") or "CN",
            "account": (o.get("account") or {}).get("username") or "",
            "expiredAt": o.get("expiredAt") or 0,
            "refreshExpiredAt": o.get("refreshExpiredAt") or 0,
            "edition": "solo" if "solo" in edition else "desktop",
            "machineId": machine,
            "deviceId": device,
            "buildVersion": build,
            "source": "desktop",
            "source_path": p,
        }, None
    return None, "本机没找到 Trae 的登录态（试过：%s）" % "；".join(tried[-2:] or tried)


# ---------------------------------------------------------------------------
# 凭据存 / 取 / 刷新
# ---------------------------------------------------------------------------

def load_cred(provider):
    """优先用研学台自己那份（刷新过、或粘贴进来的），没有再去读客户端文件。"""
    mine = _read_json(_cred_path(provider))
    if isinstance(mine, dict) and (mine.get("accessToken") or mine.get("token")):
        mine.setdefault("source", "studydeck")
        return mine, None
    if provider == "workbuddy":
        return _wb_from_file()
    if provider == "trae":
        return _trae_from_file()
    return None, "不认识的平台：%s" % provider


def save_cred(provider, cred):
    cred = dict(cred or {})
    cred["saved_at"] = int(time.time())
    cred["source"] = "studydeck"
    return _write_json(_cred_path(provider), cred)


def forget_cred(provider):
    p = _cred_path(provider)
    if os.path.exists(p):
        try:
            os.remove(p)
            return True
        except Exception:
            return False
    return False


def _post_json(url, body, headers, timeout=25):
    r = requests.post(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                      headers=headers, timeout=timeout)
    # 必须自己按 utf-8 解：这两个家回的是 text/event-stream，
    # requests 对 text/* 在没有 charset 时按 ISO-8859-1 解，中文会整段变乱码
    # （实测「可用」会变成「å¯ç¨」），那样讲题讲出来的就是一堆错字。
    return r.status_code, r.content.decode("utf-8", "replace")


def _ts(ms):
    """Trae 的过期时间是 ISO 字符串（2026-10-27T06:04:01.298Z），
    WorkBuddy 是毫秒整数。两种都要认，认不出来才说「未知」。"""
    if not ms:
        return "未知"
    if isinstance(ms, str):
        s = ms.strip().replace("Z", "")
        try:
            import datetime as _dt
            d = _dt.datetime.fromisoformat(s)
            return d.strftime("%Y-%m-%d %H:%M")
        except Exception:
            try:
                return _dt.datetime.fromtimestamp(int(ms) / 1000).strftime("%Y-%m-%d %H:%M")
            except Exception:
                return "未知"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(ms) / 1000))
    except Exception:
        return "未知"


def refresh(provider):
    """换一个新 token。换不到就说实话 —— 不拿旧 token 冒充新的。"""
    if requests is None:
        return {"ok": False, "reason": "环境里没有 requests，发不出请求"}
    cred, why = load_cred(provider)
    if not cred:
        return {"ok": False, "reason": why}
    try:
        if provider == "workbuddy":
            code, text = _post_json(
                WB_CN_CHAT_BASE + WB_REFRESH_PATH, {},
                {"Authorization": "Bearer " + cred["accessToken"],
                 "Accept": "application/json",
                 "X-Refresh-Token": cred.get("refreshToken") or "",
                 "X-Auth-Refresh-Source": "workbuddy",
                 "X-User-Id": cred.get("uid") or "",
                 "X-No-Enterprise-Id": "1",
                 "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy",
                 "X-IDE-Version": WB_FALLBACK_APP_VERSION, "X-Product": "SaaS",
                 "User-Agent": WB_UA % (WB_FALLBACK_APP_VERSION, WB_FALLBACK_APP_VERSION)})
            if code != 200:
                return {"ok": False, "reason": "刷新返回 HTTP %d：%s" % (code, text[:160])}
            d = json.loads(text)
            data = d.get("data") or {}
            if not data.get("accessToken"):
                return {"ok": False, "reason": "刷新回来了但没有 accessToken（code=%s）：%s"
                        % (d.get("code"), (d.get("msg") or "")[:120])}
            new = dict(cred)
            new["accessToken"] = data["accessToken"]
            if data.get("refreshToken"):
                new["refreshToken"] = data["refreshToken"]
            if data.get("expiresIn"):
                new["expiresAt"] = int(time.time() * 1000) + int(data["expiresIn"]) * 1000
            save_cred(provider, new)
            return {"ok": True, "expiresAt": new.get("expiresAt") or 0,
                    "note": "换好了，新的有效期到 %s" % _ts(new.get("expiresAt") or 0)}
        if provider == "trae":
            host = (cred.get("host") or "https://api.trae.cn").rstrip("/")
            edition = cred.get("edition") or "solo"
            ids = [TRAE_CLIENT_ID_SOLO, TRAE_CLIENT_ID_DESKTOP] if edition == "solo"                 else [TRAE_CLIENT_ID_DESKTOP, TRAE_CLIENT_ID_SOLO]
            errs = []
            for cid in ids:
                for path in (TRAE_LEGACY_REFRESH_PATH, TRAE_CURRENT_REFRESH_PATH):
                    body = {"ClientID": cid, "ClientSecret": "-",
                            "RefreshToken": cred.get("refreshToken") or "",
                            "UserID": cred.get("userId") or ""}
                    try:
                        code, text = _post_json(host + path, body,
                                                {"Content-Type": "application/json"})
                    except Exception as e:
                        errs.append("%s: %s" % (path, str(e)[:60]))
                        continue
                    try:
                        res = (json.loads(text).get("Result") or {})
                    except Exception:
                        errs.append("%s: 回来的不是 JSON" % path)
                        continue
                    tok = res.get("Token") or ""
                    if not tok:
                        try:
                            msg = (json.loads(text).get("ResponseMetadata") or {}).get("Error", {}).get("Message")
                        except Exception:
                            msg = None
                        errs.append("%s: %s" % (path, msg or "没有 Token"))
                        continue
                    new = dict(cred)
                    new["token"] = tok
                    new["accessToken"] = tok
                    if res.get("RefreshToken"):
                        new["refreshToken"] = res["RefreshToken"]
                    if res.get("TokenExpireAt"):
                        new["expiredAt"] = res["TokenExpireAt"]
                    if res.get("RefreshExpireAt"):
                        new["refreshExpiredAt"] = res["RefreshExpireAt"]
                    save_cred(provider, new)
                    return {"ok": True, "expiresAt": new.get("expiredAt") or 0,
                            "client_id": cid, "path": path,
                            "note": "换好了（%s），新的有效期到 %s" % (cid, _ts(new.get("expiredAt") or 0))}
            return {"ok": False, "reason": "四种组合都换不到：%s" % "；".join(errs[:4])}
    except Exception as e:
        return {"ok": False, "reason": "刷新时出错：%s" % str(e)[:160]}
    return {"ok": False, "reason": "不认识的平台：%s" % provider}


def status(provider):
    """不联网的状态快照 —— 界面会反复刷，不能每次都发请求。"""
    base = {"provider": provider,
            "name": {"workbuddy": "WorkBuddy", "trae": "Trae",
                     "apikey": "自己的 Key"}.get(provider, provider)}
    if provider == "apikey":
        ok = bool(config.ENABLE_LLM and config.LLM_API_KEY)
        k = config.LLM_API_KEY or ""
        base.update({"configured": bool(config.LLM_API_KEY), "usable": ok,
                     # 界面要把地址回填进抽屉 —— 不返回它，用户每次打开都得重新粘一遍。
                     "base_url": config.LLM_BASE_URL,
                     "key_masked": (k[:3] + "…" + k[-4:]) if len(k) > 10 else ("…" if k else ""),
                     "why": ("已配 Key：%s / %s" % (config.LLM_BASE_URL, config.LLM_MODEL)) if ok
                             else ("ENABLE_LLM=false，开关没开" if not config.ENABLE_LLM
                                   else "没配 LLM_API_KEY（写在 server/config.local.json）"),
                     "login": "key"})
        return base
    cred, why = load_cred(provider)
    if not cred:
        base.update({"configured": False, "usable": False, "why": why, "login": "none"})
        return base
    exp = cred.get("expiresAt") or cred.get("expiredAt") or 0
    mine = os.path.exists(_cred_path(provider))
    base.update({
        "configured": True,
        "usable": bool(cred.get("accessToken") or cred.get("token")),
        "from": "研学台自己存的（会自己续期）" if mine else "读的是平台上已登录的那份",
        "account": _acct_text(cred.get("nickname") or cred.get("account") or ""),
        "expires_at": exp,
        "expires_text": _ts(exp),
        "refreshable": bool(cred.get("refreshToken")),
        "login": "reuse" if cred.get("source") == "desktop" else "saved",
    })
    if provider == "trae":
        base["refresh_expire_text"] = _ts(cred.get("refreshExpiredAt") or 0)
    base["why"] = "登录态到 %s%s" % (_ts(exp),
                                    "，可以自己续期" if cred.get("refreshToken")
                                    else "，这段没有刷新 token，到期要重新取")
    return base


def providers():
    return [status(p) for p in ("apikey", "workbuddy", "trae")]


# ---------------------------------------------------------------------------
# 说话
# ---------------------------------------------------------------------------

_SSE_DATA = re.compile(r"^data:s*(.*)$", re.M)


def _sse_text(text):
    out = []
    for piece in _SSE_DATA.findall(text or ""):
        piece = piece.strip()
        if not piece or piece == "[DONE]":
            continue
        try:
            o = json.loads(piece)
        except Exception:
            continue
        if not isinstance(o, dict):
            continue    # 有的 data 片段本身是个 JSON 字符串，loads 出来不是 dict
        if isinstance(o.get("response"), str) and o["response"]:
            out.append(o["response"])                       # Trae
        for ch in (o.get("choices") or []):
            d = ch.get("delta") or {}
            if isinstance(d.get("content"), str) and d["content"]:
                out.append(d["content"])                    # WorkBuddy
    return "".join(out)


def _sse_stats(text):
    """这一家流的每一片里，正文多少字、思考多少字、为什么停。

    必须单独看这件事：WorkBuddy 的 auto 会落在推理模型上，max_tokens 全被
    reasoning_content 吃掉（实测 4000 token 里 reasoning_tokens=3999、
    finish_reason=length、正文 0 字）。不区分的话，上层只看到「模型回了空」，
    会当成「模型坏了」——其实是我们选错了模型，这两句必须分开说。
    """
    body, think, stop = [], [], ""
    for piece in _SSE_DATA.findall(text or ""):
        piece = piece.strip()
        if not piece or piece == "[DONE]":
            continue
        try:
            o = json.loads(piece)
        except Exception:
            continue
        if not isinstance(o, dict):
            continue    # 同 _sse_text：非 dict 片段直接跳过，不让 .get 炸掉整条流
        if isinstance(o.get("response"), str) and o["response"]:
            body.append(o["response"])
        for ch in (o.get("choices") or []):
            d = ch.get("delta") or {}
            if isinstance(d.get("content"), str) and d["content"]:
                body.append(d["content"])
            if isinstance(d.get("reasoning_content"), str) and d["reasoning_content"]:
                think.append(d["reasoning_content"])
            if ch.get("finish_reason"):
                stop = ch["finish_reason"]
    return "".join(body), len("".join(think)), stop


_ACT_RE = re.compile(r'\{\s*"action"\s*:.*?\}\s*$', re.S)


def _act_in_think(think_text):
    """思考里有没有已经想好的动作指令。

    推理模型跟普通模型不是两种生物：它只是把「想」和「说」分成两条流。
    这个后端的模型没有工具调用通道，动作只能靠正文里的 JSON 传 ——
    所以推理模型经常在思考里把 {"action":...} 想完，正文却还没轮到就撞了
    token 上限。这不是它不会做，是我们没接它的那条流。
    这里只认「思考末尾那个完整的 JSON」：中间那些半截草稿一律不认。
    """
    t = (think_text or "").strip()
    if not t:
        return None
    m = _ACT_RE.search(t)
    if not m:
        return None
    cand = m.group(0)
    try:
        o = json.loads(cand)
    except Exception:
        return None
    if isinstance(o, dict) and (o.get("action") or "").strip():
        return cand
    return None


def _wb_result(raw, model, reason):
    """把 WorkBuddy 的 SSE 收成一个统一形状的结果，并且能分辨「只思考没说话」。"""
    body, think, stop = _sse_stats(raw)
    if body:
        return {"ok": True, "text": body, "model": model, "reason": reason}
    if think:
        # 思考里已经想好了下一步要调什么 —— 那就当它说了，别浪费这一轮。
        act = _act_in_think(think)
        if act:
            return {"ok": True, "text": act, "model": model,
                    "reason": "正文没吐出来，这一步是从它的思考结尾捞回来的"}
        # 思考撞了预算、动作也没落全 —— 标成「只想了没说」，上层要再逼它一次。
        # 直接判死是最差的选择：它其实已经在干活了，只是没轮到开口。
        return {"ok": False, "text": None, "model": model, "think_only": True,
                "reason": ("这一轮 %d 个字全花在思考上，正文一个字没吐（停下的原因：%s）。"
                           "思考里也没落下完整动作。"
                           % (think, stop or "未知"))}
    return {"ok": False, "text": None, "model": model,
            "reason": "这家回了 200 但正文是空的（停下的原因：%s）。" % (stop or "未知")}


def _trae_function():
    """这次对话该带哪个 function。跟着模型走，不是写死一个。

    实测（2026-10-26）：Trae 的目录里每个模型都写着它属于哪个 function，
    而 function 对不上的时候上游照样 200、只是不吐字 ——
    deepseek-v4.1-flash 配 solo_work_lite 空流、配它自己的 solo_work_remote 就正常。
    所以这里读 kv 里存的 function（选模型时一起写进去），没存才用 config 的默认。
    """
    try:
        from . import model_router
        return model_router.function_of("trae") or config.TRAE_FUNCTION
    except Exception:
        return config.TRAE_FUNCTION


def _fix_route(provider, model):
    """200+空正文之后修路由：先把模型名对齐到它所属的 function，再考虑换模型。

    为什么是这个顺序：空正文最常见的原因不是「名字不存在」，而是「名字对、function 不对」。
    目录里每个模型都带 function，拿它对齐就行 —— 用户选中的模型不用被换掉。
    目录里压根没有这个名字（或目录拉不到），才退回 config 的默认模型。

    返回 (新模型名, 新function, 改了什么)；修不动返回 (None, None, None)。
    """
    try:
        from . import model_router        # 延迟导入：model_router 顶层 import 本模块
        r = models(provider)
        ms = r.get("models") or []
        if ms:
            cur_fn = model_router.function_of(provider)
            for m in ms:
                if m.get("id") == model and m.get("function"):
                    if m["function"] != cur_fn:
                        model_router.set_function(provider, m["function"])
                        return model, m["function"], "function"
                    return None, None, None      # 路由本来是对的，空另有原因，不乱动
            fb = {"trae": config.TRAE_MODEL, "workbuddy": config.WB_MODEL}.get(provider)
            if fb and fb != model:
                model_router.set_model(provider, fb)
                if provider == "trae":
                    model_router.set_function(provider, config.TRAE_FUNCTION)
                return fb, config.TRAE_FUNCTION, "model"
    except Exception:
        pass
    return None, None, None


def _heal_msg(provider, model, nm, nf, what):
    """把「为什么空」说清楚：是 function 对不上，还是名字根本不在目录里。"""
    if what == "function":
        return ("模型 '%s' 要用 function=%s 才吐字，已帮你改好 —— 重试一次就行"
                "（原先那次只是正文是空的）" % (model, nf))
    return ("模型名 '%s' 不在这家的目录里，已帮你切回 '%s' —— 重试一次就行"
            "（原先那次只是正文是空的）" % (model, nm))


# 最近一次真跑出来的用量。界面底部的状态条读它 ——
# 上游没给 usage 就什么都不写（不拿字数除时间凑一个 tok/s 出来）。
LAST = {}


def _stamp_usage(provider, model, usage, t0):
    """把这一轮的用量记进 LAST，并把累计值累加进 kv。

    「真」的标准：全是上游 token_usage 里数出来的字段。拿不到就没有这一项，
    状态条宁可缺一块，也不给一个估出来的数字。
    """
    ms = max(int((time.time() - (t0 or time.time())) * 1000), 1)
    out = {"provider": provider, "model": model, "ms": ms}
    u = usage or {}
    for k in ("prompt_tokens", "completion_tokens", "total_tokens",
              "cache_read_input_tokens", "reasoning_tokens"):
        if isinstance(u.get(k), int):
            out[k] = u[k]
    if out.get("completion_tokens"):
        out["tok_s"] = round(out["completion_tokens"] / (ms / 1000.0), 1)
    # 上下文占用：prompt / 这个模型的上下文窗口（窗口是选模型时从目录存下来的）
    try:
        from . import model_router
        ctx = int(model_router.ctx_of(provider) or 0)
    except Exception:
        ctx = 0
    if ctx and out.get("prompt_tokens"):
        out["ctx"] = ctx
        out["ctx_pct"] = round(out["prompt_tokens"] * 100.0 / ctx, 1)
    try:
        from . import store
        if out.get("total_tokens"):
            store.kv_set("usage.tokens", str(int(store.kv_get("usage.tokens") or 0) + out["total_tokens"]))
            store.kv_set("usage.prompt", str(int(store.kv_get("usage.prompt") or 0)
                                             + int(out.get("prompt_tokens") or 0)))
            store.kv_set("usage.cache_read", str(int(store.kv_get("usage.cache_read") or 0)
                                                 + int(out.get("cache_read_input_tokens") or 0)))
        out["cum_tokens"] = int(store.kv_get("usage.tokens") or 0)
        out["cum_prompt"] = int(store.kv_get("usage.prompt") or 0)
        out["cum_cache_read"] = int(store.kv_get("usage.cache_read") or 0)
    except Exception:
        pass
    LAST.clear()
    LAST.update(out)
    return out


def last_usage():
    return dict(LAST) if LAST else None


def chat(provider, system, user, model=None, temperature=None, max_tokens=None, timeout=None, effort=None):
    """返回 {ok, text, model, reason}。跟 llm.chat 一个形状，上层不用分叉。"""
    if requests is None:
        return {"ok": False, "reason": "环境里没有 requests，发不出请求", "text": None, "model": None}
    cred, why = load_cred(provider)
    if not cred:
        return {"ok": False, "reason": why, "text": None, "model": None}
    timeout = timeout or config.LLM_TIMEOUT
    t = config.LLM_TEMPERATURE if temperature is None else temperature
    try:
        if provider == "workbuddy":
            model = model or config.WB_MODEL
            url = WB_CN_CHAT_BASE + WB_CHAT_PATH
            headers = {
                "Authorization": "Bearer " + cred["accessToken"],
                "Content-Type": "application/json", "Accept": "text/event-stream",
                "X-User-Id": cred.get("uid") or "", "X-No-Enterprise-Id": "1",
                "X-Domain": cred.get("domain") or "",
                "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy",
                "X-IDE-Version": WB_FALLBACK_APP_VERSION, "X-Product": "SaaS",
                "Origin": "https://www.codebuddy.cn", "Referer": "https://www.codebuddy.cn/",
                "User-Agent": WB_UA % (WB_FALLBACK_APP_VERSION, WB_FALLBACK_APP_VERSION),
            }
            body = {"model": model, "stream": True, "temperature": t,
                    "max_tokens": max_tokens or config.LLM_MAX_TOKENS,
                    "messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": user}]}
            # 推理模型的思考也是从 max_tokens 里扣的。不显式给思考预算，
            # 它就会在「想完但还没说」的地方被截断 —— 表现是正文空、动作也没落。
            # 认这个字段的上游会按它切，不认的一律静默忽略，所以给上没坏处。
            body["thinking_budget"] = config.LLM_THINK_TOKENS
            # 思考强度：实测 low/medium 会被认（三次采样区间明显收窄/抬高），
            # high 与 medium 无差别。没有「关」这一档 —— 传 disabled 也是 200
            # 但思考量不变，因为它对不认识的字段一律静默忽略。
            ef = _effort_of(effort)
            if ef:
                body["reasoning_effort"] = ef
            code, text = _post_json(url, body, headers, timeout)
            if code != 200:
                # 常见的第一种失败是 token 过期。自动刷一次再试，但只试一次，
                # 并在返回里说清「刷新过」—— 不让这个重试变成掩盖问题。
                if code in (401, 403) and cred.get("refreshToken"):
                    r = refresh(provider)
                    if r.get("ok"):
                        cred, _ = load_cred(provider)
                        headers["Authorization"] = "Bearer " + cred["accessToken"]
                        code, text = _post_json(url, body, headers, timeout)
                        if code == 200:
                            return _wb_result(text, model, "token 已过期，自动刷新后重试成功")
                return {"ok": False, "reason": "WorkBuddy 返回 HTTP %d：%s" % (code, text[:200]),
                        "text": None, "model": model}
            return _wb_result(text, model, "ok")
        if provider == "trae":
            region = (cred.get("userRegion") or "CN").upper()
            base = TRAE_GATEWAY_SG if region.startswith("SG") else TRAE_GATEWAY_CN
            model = model or config.TRAE_MODEL
            build = cred.get("buildVersion") or ""
            vcode = build if build.isdigit() else TRAE_VERSION_CODE_FALLBACK
            rid = "11111111-2222-3333-4444-555555555555"

            def trae_headers(tok):
                return {
                    "Authorization": "Cloud-IDE-JWT " + tok,
                    "X-Ide-Token": tok, "X-Cloudide-Token": tok,
                    "x-uid": cred.get("userId") or "",
                    "x-plugin-channel": "icube-ai",
                    "User-Agent": "Trae/%s" % (build or "unknown"),
                    "x-app-id": TRAE_APP_ID,
                    "x-machine-id": cred.get("machineId") or "",
                    "x-device-id": cred.get("deviceId") or "",
                    "x-device-type": "windows",
                    "x-app-version": build, "x-ide-version": build,
                    "x-app-version-code": vcode, "x-ide-version-code": vcode,
                    "x-ide-version-type": "stable",
                    "x-custom-trace-id": "0" * 32,
                    "x-flow-traceparent": "04-%s-%s-01" % ("0" * 32, "0" * 16),
                    "request-traffic-type": "prod",
                    "Content-Type": "application/json", "Accept": "text/event-stream",
                    "x-request-id": rid, "x-trae-request-id": rid,
                }

            body = {"messages": [{"role": "system", "content": [{"type": "text", "text": system}]},
                                 {"role": "user", "content": [{"type": "text", "text": user}]}],
                    "model": model, "config_name": model,
                    "function": _trae_function(), "stream": True}
            tok = cred.get("accessToken") or cred.get("token") or ""
            code, text = _post_json(base + TRAE_CHAT_PATH, body, trae_headers(tok), timeout)
            if code != 200:
                if code in (401, 403) and cred.get("refreshToken"):
                    r = refresh(provider)
                    if r.get("ok"):
                        cred, _ = load_cred(provider)
                        tok = cred.get("accessToken") or cred.get("token") or ""
                        code, text = _post_json(base + TRAE_CHAT_PATH, body, trae_headers(tok), timeout)
                        if code == 200:
                            return {"ok": True, "text": _sse_text(text), "model": model,
                                    "reason": "token 已过期，自动刷新后重试成功"}
                return {"ok": False, "reason": "Trae 返回 HTTP %d：%s" % (code, text[:200]),
                        "text": None, "model": model}
            body_txt = _sse_text(text)
            if not body_txt:
                # 200 + 空正文：先修路由（function 对不上），修不动再换模型名。
                nm, nf, what = _fix_route(provider, model)
                if what:
                    return {"ok": False, "text": None, "model": nm,
                            "reason": _heal_msg(provider, model, nm, nf, what)}
                return {"ok": False, "text": None, "model": model,
                        "reason": ("Trae 回了 200 但正文是空的 —— 模型名和 function 都对，"
                                   "那就是上游这次没吐字，抓的原文里没有可用的内容")}
            return {"ok": True, "text": body_txt, "model": model, "reason": "ok"}
    except Exception as e:
        return {"ok": False, "reason": "调用出错：%s" % str(e)[:160], "text": None, "model": model}
    return {"ok": False, "reason": "不认识的平台：%s" % provider, "text": None, "model": None}


_EFFORTS = ("low", "medium", "high")


def _effort_of(v):
    """把界面上传的值收成三档之一。不合法就返回 None —— 宁可不传，
    也不给上游塞一个它不认识的字符串（那样等于没设，还会让人以为生效了）。"""
    k = str(v or "").strip().lower()
    if k in ("low", "l", "1", "低", "少"):
        return "low"
    if k in ("medium", "mid", "m", "2", "中"):
        return "medium"
    if k in ("high", "h", "3", "高", "多"):
        return "high"
    return None


def chat_stream(provider, system, user, model=None, temperature=None,
                max_tokens=None, timeout=None, effort=None):
    """流式版 chat：逐个 yield {"d": 文本片段}，最后 yield {"done": True, "model": ...}。

    出错就 yield {"error": 说明}，然后停 —— 不假装成功。
    上层（main.py 的 SSE 路由）照原样转发给浏览器。
    """
    if requests is None:
        yield {"error": "环境里没有 requests，发不出请求"}
        return
    cred, why = load_cred(provider)
    if not cred:
        yield {"error": why}
        return
    timeout = timeout or config.LLM_TIMEOUT
    t = config.LLM_TEMPERATURE if temperature is None else temperature

    try:
        if provider == "workbuddy":
            model = model or config.WB_MODEL
            url = WB_CN_CHAT_BASE + WB_CHAT_PATH
            headers = {
                "Authorization": "Bearer " + cred["accessToken"],
                "Content-Type": "application/json", "Accept": "text/event-stream",
                "X-User-Id": cred.get("uid") or "", "X-No-Enterprise-Id": "1",
                "X-Domain": cred.get("domain") or "",
                "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy",
                "X-IDE-Version": WB_FALLBACK_APP_VERSION, "X-Product": "SaaS",
                "Origin": "https://www.codebuddy.cn", "Referer": "https://www.codebuddy.cn/",
                "User-Agent": WB_UA % (WB_FALLBACK_APP_VERSION, WB_FALLBACK_APP_VERSION),
            }
            body = {"model": model, "stream": True, "temperature": t,
                    "max_tokens": max_tokens or config.LLM_MAX_TOKENS,
                    "messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": user}]}
            # 推理模型的思考也是从 max_tokens 里扣的。不显式给思考预算，
            # 它就会在「想完但还没说」的地方被截断 —— 表现是正文空、动作也没落。
            # 认这个字段的上游会按它切，不认的一律静默忽略，所以给上没坏处。
            body["thinking_budget"] = config.LLM_THINK_TOKENS
        elif provider == "trae":
            region = (cred.get("userRegion") or "CN").upper()
            base = TRAE_GATEWAY_SG if region.startswith("SG") else TRAE_GATEWAY_CN
            model = model or config.TRAE_MODEL
            build = cred.get("buildVersion") or ""
            vcode = build if build.isdigit() else TRAE_VERSION_CODE_FALLBACK
            rid = "11111111-2222-3333-4444-555555555555"
            tok = cred.get("accessToken") or cred.get("token") or ""
            url = base + TRAE_CHAT_PATH
            headers = {
                "Authorization": "Cloud-IDE-JWT " + tok, "X-Ide-Token": tok,
                "X-Cloudide-Token": tok, "x-uid": cred.get("userId") or "",
                "x-plugin-channel": "icube-ai",
                "User-Agent": "Trae/%s" % (build or "unknown"),
                "x-app-id": TRAE_APP_ID,
                "x-machine-id": cred.get("machineId") or "",
                "x-device-id": cred.get("deviceId") or "",
                "x-device-type": "windows",
                "x-app-version": build, "x-ide-version": build,
                "x-app-version-code": vcode, "x-ide-version-code": vcode,
                "x-ide-version-type": "stable",
                "x-custom-trace-id": "0" * 32,
                "x-flow-traceparent": "04-%s-%s-01" % ("0" * 32, "0" * 16),
                "request-traffic-type": "prod",
                "Content-Type": "application/json", "Accept": "text/event-stream",
                "x-request-id": rid, "x-trae-request-id": rid,
            }
            body = {"messages": [{"role": "system", "content": [{"type": "text", "text": system}]},
                                 {"role": "user", "content": [{"type": "text", "text": user}]}],
                    "model": model, "config_name": model,
                    "function": _trae_function(), "stream": True}
        else:
            yield {"error": "不认识的平台：%s" % provider}
            return

        r = requests.post(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                          headers=headers, timeout=timeout, stream=True)
        if r.status_code != 200:
            raw = r.content.decode("utf-8", "replace")
            # token 过期只重试一次，并把「刷新过」说清楚 —— 不让重试掩盖问题
            if r.status_code in (401, 403) and cred.get("refreshToken"):
                rf = refresh(provider)
                if rf.get("ok"):
                    yield {"error": "token 过期了，我刷新了一次但还没重发这一句 —— 再问一遍就行"}
                    return
            yield {"error": "%s 返回 HTTP %d：%s" % (provider, r.status_code, raw[:180])}
            return

        got = 0
        think = 0
        usage = {}                # 这一轮的用量（上游给了才有，没给就是空 —— 不估）
        t0 = time.time()
        tbuf = []                 # 思考全文，只为了「正文空时从思考里捞动作」
        for line in r.iter_lines(decode_unicode=False):
            if not line:
                continue
            try:
                ln = line.decode("utf-8", "replace").strip()
            except Exception:
                continue
            if not ln.startswith("data:"):
                continue
            piece = ln[5:].strip()
            if not piece or piece == "[DONE]":
                continue
            try:
                o = json.loads(piece)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue    # data 片段可能是 JSON 字符串 —— 上面 .get 一炸整条流就断
            # 用量：Trae 单独发一条 token_usage；WorkBuddy 是 OpenAI 形状的 usage。
            _u = o if isinstance(o.get("total_tokens"), int) else (
                o.get("usage") if isinstance(o.get("usage"), dict) else None)
            if _u:
                for _k in ("prompt_tokens", "completion_tokens", "total_tokens",
                           "cache_read_input_tokens", "reasoning_tokens"):
                    if isinstance(_u.get(_k), int):
                        usage[_k] = _u[_k]
            # Trae：顶层 response（正文）。thinking 那类字段也要单独标出来
            for rk in ("reasoning_content", "thinking", "reasoning"):
                rv = o.get(rk)
                if isinstance(rv, str) and rv:
                    think += len(rv)
                    tbuf.append(rv)
                    yield {"r": rv}
            v = o.get("response")
            if isinstance(v, str) and v:
                got += len(v)
                yield {"d": v}
                continue
            # WorkBuddy / OpenAI 形：choices[].delta
            for ch in (o.get("choices") or []):
                d = ch.get("delta") or {}
                c = d.get("content")
                if isinstance(c, str) and c:
                    got += len(c)
                    yield {"d": c}
                rc = d.get("reasoning_content")
                if isinstance(rc, str) and rc:
                    think += len(rc)
                    tbuf.append(rc)
                    yield {"r": rc}          # 思考过程单独标，前端折叠展示
        if got == 0 and think > 0:
            # 推理模型不是只会想不会做 —— 它在思考里往往已经把动作写完了，
            # 只是正文那一路先撞上了 token 上限。捞回来，这一轮就不算白跑。
            act = _act_in_think("".join(tbuf))
            if act:
                yield {"d": act, "fromThink": True}
                yield {"done": True, "model": model, "fromThink": True}
                return
            yield {"thinkOnly": think,
                   "error": ("这一轮 %d 字全花在思考上，正文一个字没吐，"
                             "思考结尾也没落下完整动作。" % think)}
            return
        if got == 0:
            nm, nf, what = _fix_route(provider, model)
            if what:
                yield {"error": _heal_msg(provider, model, nm, nf, what)}
            else:
                yield {"error": ("这一家流回来了，但正文是空的 —— 模型名和 function 都对，"
                                 "上游这次没吐字，抓的原文里没有可用内容")}
            return
        _stamp_usage(provider, model, usage, t0)
        yield {"done": True, "model": model, "usage": last_usage()}
    except Exception as e:
        yield {"error": "调用出错：%s" % str(e)[:160]}


def _trae_meta(x):
    """目录里一条模型记录 → 界面要的那几项。

    `context_window_tokens` 就是上下文窗口（实测 deepseek-v4.1-flash 给的是
    {"dev": 200000}）。原来这一项被整个丢掉，于是底部状态条的占用率永远算不出来 ——
    那不是"上游没给"，是取回来了没存。窗口拿不到就写 None，让界面缺这一块，
    绝不拿别的数凑一个百分比出来。
    """
    dc = x.get("display_config") or {}
    cw = x.get("context_window_tokens") or {}
    ctx = 0
    for k in ("dev", "prod", "max", "default", "staging"):
        v = cw.get(k)
        if isinstance(v, int) and v > 0:
            ctx = v
            break
    if not ctx:
        for v in cw.values():
            if isinstance(v, int) and v > 0:
                ctx = v
                break
    return {"name": dc.get("display_name") or x.get("config_name") or "",
            "ctx": ctx or None,
            "cap": dc.get("model_capability") or "",
            "mm": bool(dc.get("multimodal")),
            "tags": [t for t in (dc.get("tags") or []) if isinstance(t, str)]}


def models(provider):
    """列这家现在能用的模型。列不出来就说明为什么 —— 不编模型名。"""
    if requests is None:
        return {"ok": False, "reason": "环境里没有 requests", "models": []}
    cred, why = load_cred(provider)
    if not cred:
        return {"ok": False, "reason": why, "models": []}
    try:
        if provider == "workbuddy":
            headers = {
                "Authorization": "Bearer " + cred["accessToken"], "Accept": "application/json",
                "X-User-Id": cred.get("uid") or "", "X-No-Enterprise-Id": "1",
                "X-IDE-Type": "WorkBuddy", "X-IDE-Name": "WorkBuddy",
                "X-IDE-Version": WB_FALLBACK_APP_VERSION, "X-Product": "SaaS",
                "Origin": "https://www.codebuddy.cn", "Referer": "https://www.codebuddy.cn/",
                "User-Agent": WB_UA % (WB_FALLBACK_APP_VERSION, WB_FALLBACK_APP_VERSION),
            }
            r = requests.get(WB_CN_CHAT_BASE + WB_CONFIG_PATH, headers=headers, timeout=20)
            if r.status_code != 200:
                return {"ok": False, "reason": "目录返回 HTTP %d" % r.status_code, "models": []}
            d = r.json()
            rows = ((d.get("data") or d).get("models") or [])
            return {"ok": True, "models": [{"id": x.get("id"),
                                            "name": x.get("name") or x.get("id"),
                                            "ctx": (x.get("maxInputTokens")
                                                    or x.get("contextWindow")
                                                    or x.get("max_input_tokens")),
                                            "cap": x.get("modelType") or "",
                                            "mm": bool(x.get("multimodal")),
                                            "tags": []}
                                           for x in rows if x.get("id")]}
        if provider == "trae":
            region = (cred.get("userRegion") or "CN").upper()
            base = TRAE_GATEWAY_SG if region.startswith("SG") else TRAE_GATEWAY_CN
            tok = cred.get("accessToken") or cred.get("token") or ""
            build = cred.get("buildVersion") or ""
            vcode = build if build.isdigit() else TRAE_VERSION_CODE_FALLBACK
            headers = {"Authorization": "Cloud-IDE-JWT " + tok, "X-Ide-Token": tok,
                       "X-Cloudide-Token": tok, "x-uid": cred.get("userId") or "",
                       "x-app-id": TRAE_APP_ID,
                       "x-machine-id": cred.get("machineId") or "",
                       "x-device-id": cred.get("deviceId") or "",
                       "x-device-type": "windows",
                       "x-app-version-code": vcode, "x-ide-version-code": vcode,
                       "x-ide-version-type": "stable", "request-traffic-type": "prod",
                       "Content-Type": "application/json", "Accept": "application/json"}
            by_fn = {}
            meta = {}
            for fn in ("solo_work_remote", "solo_work_lite", "solo_agent_remote",
                       "chat_v3", "solo_coder"):
                try:
                    r = requests.post(base + TRAE_DIR_PATH, headers=headers, timeout=20,
                                      data=json.dumps({"function": fn, "config_names": None,
                                                       "need_prompt": False, "current_config_info": None,
                                                       "poly_prompt": True, "mode_type": None,
                                                       "agent_type": None}).encode("utf-8"))
                    if r.status_code != 200:
                        continue
                    for x in (r.json().get("config_info_list") or []):
                        cid = x.get("config_name")
                        if cid and cid not in by_fn:
                            by_fn[cid] = fn
                            meta[cid] = _trae_meta(x)
                except Exception:
                    continue
            got = []
            for k in sorted(by_fn):
                row = {"id": k, "name": (meta.get(k) or {}).get("name") or k,
                       "function": by_fn[k]}
                row.update({kk: vv for kk, vv in (meta.get(k) or {}).items() if kk != "name"})
                got.append(row)
            if not got:
                return {"ok": False, "reason": "五个目录函数都没给出模型（多半要重新取登录态）",
                        "models": []}
            return {"ok": True, "models": got}
    except Exception as e:
        return {"ok": False, "reason": "取目录出错：%s" % str(e)[:160], "models": []}
    return {"ok": False, "reason": "不认识的平台：%s" % provider, "models": []}


# ---------------------------------------------------------------------------
# 「不用装平台也能登录」：粘贴一段凭据进来
# ---------------------------------------------------------------------------

def import_cred(provider, raw):
    """吃三种东西：整份 JSON、Trae 那条加密串、或平台导出的凭据文本。

    能认出来就存，认不出来就把「为什么认不出来」说清楚 —— 不猜、不半存。
    """
    if provider not in ("workbuddy", "trae"):
        return {"ok": False, "reason": "只有 workbuddy / trae 支持贴凭据；apikey 那家填 Key 就行"}
    raw = (raw or "").strip()
    if not raw:
        return {"ok": False, "reason": "空的，没东西可认"}
    obj = None
    if raw.startswith("{") or raw.startswith("["):
        try:
            obj = json.loads(raw)
        except Exception as e:
            obj = None
            json_err = str(e)[:80]
            return {"ok": False, "reason": "这段看着像 JSON 但解析不了：%s" % json_err}
    if obj is None and not raw.startswith("{"):
        try:
            obj = json.loads(trae_decrypt(raw))
        except Exception:
            obj = None
    if obj is None:
        return {"ok": False,
                "reason": "认不出来。给它整份 JSON（平台导出的那份文件全选复制），"
                          "或 Trae 的 iCubeAuthInfo 那一长串。"}
    if provider == "trae":
        creds = obj if isinstance(obj, dict) else {}
        if isinstance(obj, dict) and isinstance(obj.get("data"), dict):
            creds = obj["data"]
        tok = creds.get("token") or creds.get("accessToken") or ""
        if not tok:
            return {"ok": False, "reason": "里面没有 token（找到的键：%s）"
                    % "、".join(list(creds)[:8])}
        save_cred("trae", {
            "token": tok, "accessToken": tok,
            "refreshToken": creds.get("refreshToken") or "",
            "userId": str(creds.get("userId") or ""),
            "host": creds.get("host") or "https://api.trae.cn",
            "userRegion": (creds.get("userRegion") or {}).get("region") or "CN",
            "account": (creds.get("account") or {}).get("username") or "",
            "expiredAt": creds.get("expiredAt") or creds.get("expireAt") or 0,
            "refreshExpiredAt": creds.get("refreshExpiredAt") or 0,
            "edition": creds.get("edition") or "solo",
            "machineId": creds.get("machineId") or "",
            "deviceId": creds.get("deviceId") or "",
            "buildVersion": creds.get("buildVersion") or "",
        })
        return {"ok": True, "provider": "trae",
                "note": "存好了。%s" % ("带刷新 token，到期能自己续"
                                        if creds.get("refreshToken")
                                        else "这段没有刷新 token，到期得再贴一次")}
    auth = obj.get("auth") if isinstance(obj.get("auth"), dict) else (obj if isinstance(obj, dict) else {})
    acct = obj.get("account") if isinstance(obj.get("account"), dict) else {}
    tok = auth.get("accessToken") or auth.get("token") or ""
    if not tok:
        return {"ok": False, "reason": "里面没有 accessToken（找到的键：%s）"
                % "、".join(list(obj)[:8] if isinstance(obj, dict) else [])}
    save_cred("workbuddy", {
        "accessToken": tok,
        "refreshToken": auth.get("refreshToken") or "",
        "uid": acct.get("uid") or auth.get("uid") or "",
        "nickname": acct.get("nickname") or "",
        "enterpriseId": auth.get("enterpriseId") or "",
        "domain": auth.get("domain") or ((acct.get("sso") or {}).get("domain") or ""),
        "expiresAt": auth.get("expiresAt") or 0,
    })
    return {"ok": True, "provider": "workbuddy",
            "note": "存好了。%s" % ("带刷新 token，到期能自己续"
                                    if auth.get("refreshToken")
                                    else "这段没有刷新 token，到期得再贴一次")}
