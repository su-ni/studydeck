# -*- coding: utf-8 -*-
"""百词斩词条客户端（TCompactProtocol over HTTP，零第三方依赖）。

协议细节来自 `F:\项目\反编译\bcz_analysis\百词斩单词接口逆向报告.md`：
- URL：`POST {host}/rpc/{service}/{method}/{毫秒时间戳}`
- 请求体必须是 **4 字节大端长度帧 + TCompactProtocol 数据**（不帧直接 422）
- 响应同样是「长度帧 + Compact」，这里自动剥掉
- 鉴权靠 Cookie 里的 `access_token`；无 token 时服务端回 `"not login"`

规矩（跟这个项目其它地方一致）：
- **拿不到就返回 None 并说明原因，绝不编造**；
- 网络失败不抛出，交给上层决定是否回落本地推测；
- 只做读操作，不碰任何写接口。
"""
import json
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------- Compact 编解码

CTYPE = {"bool": 1, "byte": 3, "i16": 4, "i32": 5, "i64": 6, "double": 7,
         "string": 8, "list": 9, "set": 10, "map": 11, "struct": 12}
MTYPE = {"CALL": 1, "REPLY": 2, "EXCEPTION": 3, "ONEWAY": 4}


def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _zigzag32(n):
    return (n << 1) ^ (n >> 31)


def _zigzag64(n):
    return (n << 1) ^ (n >> 63)


class _Writer(object):
    def __init__(self):
        self.buf = bytearray()
        self._last_fid = 0
        self._stack = []

    def message_begin(self, name, mtype="CALL", seqid=1):
        self.buf.append(0x82)
        self.buf.append((1 << 5) | MTYPE[mtype])
        self.buf += _varint(seqid)
        self._binary(name.encode("utf-8"))

    def _binary(self, b):
        self.buf += _varint(len(b))
        self.buf += b

    def struct_begin(self):
        self._stack.append(self._last_fid)
        self._last_fid = 0

    def struct_end(self):
        self.buf.append(0x00)
        self._last_fid = self._stack.pop()

    def field(self, fid, ctype, value):
        delta = fid - self._last_fid
        if 0 < delta <= 15:
            self.buf.append((delta << 4) | CTYPE[ctype])
        else:
            self.buf.append(CTYPE[ctype])
            self.buf += _varint(_zigzag32(fid))
        self._last_fid = fid
        self._value(ctype, value)

    def _value(self, ctype, value):
        if ctype == "string":
            self._binary(value.encode("utf-8") if isinstance(value, str) else value)
        elif ctype in ("i32", "i16"):
            self.buf += _varint(_zigzag32(int(value)))
        elif ctype == "i64":
            self.buf += _varint(_zigzag64(int(value)))
        elif ctype == "bool":
            self.buf.append(1 if value else 2)
        elif ctype == "double":
            self.buf += struct.pack("<d", float(value))
        elif ctype == "struct":
            # 嵌套结构：value 是 [(fid, ctype, val), ...]。词书接口要传
            # List<TopicKey>，没有这一支就发不出请求。
            self.struct_begin()
            for fid, ct, val in (value or []):
                self.field(fid, ct, val)
            self.struct_end()
        elif ctype == "list":
            et_name, elems = value
            et = CTYPE[et_name]
            n = len(elems)
            if n <= 14:
                self.buf.append((n << 4) | et)
            else:
                self.buf.append(0xF0 | et)
                self.buf += _varint(n)
            for e in elems:
                self._value(et_name, e)
        else:
            raise ValueError("unsupported type: %s" % ctype)


class _Reader(object):
    def __init__(self, data):
        self.d = data
        self.p = 0
        self._stack = []
        self._last_fid = 0

    def _byte(self):
        b = self.d[self.p]
        self.p += 1
        return b

    def _varint(self):
        n = 0
        shift = 0
        while True:
            b = self._byte()
            n |= (b & 0x7F) << shift
            if not (b & 0x80):
                return n
            shift += 7

    def _zigzag(self):
        n = self._varint()
        return (n >> 1) ^ -(n & 1)

    def _binary(self):
        n = self._varint()
        b = self.d[self.p:self.p + n]
        self.p += n
        return b

    def message_begin(self):
        proto = self._byte()
        if proto != 0x82:
            raise ValueError("not compact protocol: 0x%02x" % proto)
        vt = self._byte()
        seqid = self._varint()
        name = self._binary().decode("utf-8", "replace")
        return {"type": vt & 0x1F, "seqid": seqid, "method": name}

    def read_struct(self):
        self._stack.append(self._last_fid)
        self._last_fid = 0
        out = {}
        while True:
            b = self._byte()
            if b == 0:
                break
            delta = (b & 0xF0) >> 4
            ctype = b & 0x0F
            fid = self._zigzag() if delta == 0 else self._last_fid + delta
            self._last_fid = fid
            out[fid] = self._read_value(ctype)
        self._last_fid = self._stack.pop()
        return out

    def _read_value(self, ctype):
        if ctype == 1:
            return True
        if ctype == 2:
            return False
        if ctype == 3:
            return self._byte()
        if ctype in (4, 5, 6):
            return self._zigzag()
        if ctype == 7:
            v = struct.unpack_from("<d", self.d, self.p)[0]
            self.p += 8
            return v
        if ctype == 8:
            return self._binary()
        if ctype in (9, 10):
            head = self._byte()
            size = (head & 0xF0) >> 4
            et = head & 0x0F
            if size == 15:
                size = self._varint()
            return [self._read_value(et) for _ in range(size)]
        if ctype == 11:
            size = self._varint()
            if size == 0:
                return {}
            kv = self._byte()
            kt, vt = (kv & 0xF0) >> 4, kv & 0x0F
            return {self._read_value(kt): self._read_value(vt) for _ in range(size)}
        if ctype == 12:
            return self.read_struct()
        raise ValueError("unknown ctype %s at %s" % (ctype, self.p))


# ---------------------------------------------------------------- 传输

CDN = "https://word.bczcdn.com"
HOST_WORDS = "https://www.baicizhan.com"
HOST_RES = "https://resource.baicizhan.com"
UA = "bcz_app/android/Pixel os_version/7.10.22"


def _cookie(access_token):
    ts = int(time.time())
    parts = [
        "device_name=android%2FPixel", "version=7.10.22", "os_version=7.10.22",
        "app_name=1", "channel=default", "client_time=%d" % ts,
        "device_id=0123456789abcdef",
        "serial=01234bcdef%s" % time.strftime("%d%H%M%S"),
        "time_zone=Asia%2FShanghai",
    ]
    if access_token:
        parts.append("access_token=" + urllib.parse.quote(access_token, safe=""))
    return ";".join(parts)


def call(host, service, method, fields, access_token=None, timeout=12):
    """发一次 Thrift 调用，返回 (ok, data_or_reason)。

    fields 形如 [(1, 'string', 'abandon'), (2, 'list', ('i32', [4719]))]
    """
    w = _Writer()
    w.message_begin(method, "CALL", 1)
    w.struct_begin()
    for fid, ctype, val in fields:
        w.field(fid, ctype, val)
    w.struct_end()
    body = bytes(w.buf)
    url = "%s/rpc/%s/%s/%d" % (host, service, method, int(time.time() * 1000))
    req = urllib.request.Request(url, data=struct.pack(">I", len(body)) + body,
                                 method="POST")
    req.add_header("Accept", "application/x-thrift")
    req.add_header("Content-Type", "application/x-thrift")
    req.add_header("User-Agent", UA)
    req.add_header("Cookie", _cookie(access_token))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        return False, "HTTP %s" % e.code
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)
    if len(raw) >= 4:
        flen = struct.unpack(">I", raw[:4])[0]
        if flen <= len(raw) - 4:
            raw = raw[4:4 + flen]
    try:
        rd = _Reader(raw)
        rd.message_begin()
        res = rd.read_struct()
    except Exception as e:
        return False, "解析失败: %s" % e
    # 服务端异常结构有两种：{1: 消息, 2: 错误码} 和 {1: 消息, 2: int}。
    # 原来只认「字段 2 是 dict」，于是 `keys not present` 这种被当成成功返回给了上层 ——
    # 拿到的「数据」其实是一句报错。
    err = res.get(2)
    if isinstance(err, dict):
        msg = err.get(1) or err.get(4)
        if isinstance(msg, bytes):
            msg = msg.decode("utf-8", "replace")
        return False, str(msg or "服务端异常")
    if 0 not in res and (1 in res or isinstance(err, int)):
        msg = res.get(1)
        if isinstance(msg, bytes):
            msg = msg.decode("utf-8", "replace")
        return False, str(msg or ("服务端异常 code=%s" % err))
    return True, res


def _s(b):
    return b.decode("utf-8", "replace") if isinstance(b, bytes) else b


# ---------------------------------------------------------------- 业务封装

def search(word, access_token=None):
    """文本 → [(词, topic_id, 释义, 音标)]，按匹配度由服务端排好序。"""
    ok, res = call(HOST_RES, "resource_api", "search_word_v2",
                   [(1, "string", word)], access_token)
    if not ok:
        return None, res
    rows = []
    for it in res.get(0) or []:
        if not isinstance(it, dict):
            continue
        rows.append({"word": _s(it.get(1)), "topic_id": it.get(2),
                     "mean_cn": _s(it.get(3)), "phonetic": _s(it.get(4))})
    return rows, None


def word_card(topic_id, access_token=None, level=0):
    """词卡：配图 / 变形图 / 例句 / 发音路径。字段号见逆向报告 7.2。

    返回的路径都是 CDN 相对路径（`/cropped_images/xxx.jpg`），要拼 `CDN` 才是完整地址。
    """
    ok, res = call(HOST_WORDS, "words", "get_word_topic_assets_v2",
                   [(1, "i32", level), (2, "list", ("i32", [int(topic_id)]))],
                   access_token)
    if not ok:
        return None, res
    rows = res.get(0) or []
    if not rows:
        return None, "没有返回词卡"
    it = rows[0]
    return {
        "topic_id": it.get(1),
        "word": _s(it.get(2)),
        "word_variants": _s(it.get(3)),
        "audio_path": _s(it.get(4)),        # /word_audios_dat/abandon.dat
        "image_file": _s(it.get(6)),        # /cropped_images/xxx.jpg  ← 配图
        "phonetic": _s(it.get(7)),
        "mean_cn": _s(it.get(8)),
        "mean_en": _s(it.get(9)),
        "short_phrase": _s(it.get(10)),
        "deformation_img": _s(it.get(11)),  # /df_transparent/xxx.png
        "sentence": _s(it.get(13)),
        "sentence_trans": _s(it.get(14)),
        "asset_pack": _s(it.get(17)),
    }, None


# ---------------------------------------------------------------- 词书（2026-10-26 打通）
# 为什么要有这一层：这个台子原来只有「一个词表快照」（3796 词，脚本离线拉的）。
# 用户要的是 AI 自己能把词书拉进来 —— 学丞那条线要用户买过课才能用，不能当通用源；
# 百词斩的词书是公开的，全量 2348 本，含 10 本专升本词书。
#
# 三段调用：
#   ① get_all_books_basic_info_v3（无参）→ 全部词书 id/名字/词数
#   ② get_word_list_status(book_id)     → 这本书全部词的 topic_id（数量正好等于词数）
#   ③ get_word_list_word_meta_v2(keys)  → topic_id → 单词/释义/美音音频
# 域名：②③ 在 learn.baicizhan.com（user_study），③ 在 resource.baicizhan.com（resource_api）。
HOST_LEARN = "https://learn.baicizhan.com"


def books(keyword=None, access_token=None):
    """全部词书 → [{id, name, words, cover, desc}]。keyword 非空就按名字粗筛。"""
    ok, res = call(HOST_LEARN, "user_study", "get_all_books_basic_info_v3",
                   [], access_token=access_token, timeout=20)
    if not ok:
        return None, res
    rows = ((res.get(0) or {}).get(1)) or []
    out = []
    kw = (keyword or "").strip()
    for b in rows:
        if not isinstance(b, dict):
            continue
        nm = _s(b.get(2)) or ""
        if kw and kw not in nm:
            continue
        out.append({"id": b.get(1), "name": nm, "words": b.get(3) or 0,
                    "cover": _s(b.get(7)), "desc": _s(b.get(8))})
    return out, None


def book_topics(book_id, access_token=None):
    """一本书里的全部词 → [{topic_id, level, tag, extra}]。"""
    ok, res = call(HOST_LEARN, "user_study", "get_word_list_status",
                   [(1, "i32", int(book_id))], access_token=access_token, timeout=30)
    if not ok:
        return None, res
    rows = res.get(0) or []
    if not isinstance(rows, list):
        return None, "返回结构不对：%s" % type(rows).__name__
    out = []
    for it in rows:
        if isinstance(it, dict) and it.get(1):
            out.append({"topic_id": it.get(1), "level": it.get(2) or 0,
                        "tag": it.get(3) or 0})
    return out, None


def topic_words(keys, access_token=None, batch=80):
    """topic 列表 → [{topic_id, word, mean_cn, audio_us}]。

    keys: [{"topic_id":..,"level":..,"tag":..}] 或 [topic_id, ...]。
    一次 80 个分批发，几百个一次发过去服务端会回 413/500。
    """
    seq = []
    for k in (keys or []):
        if isinstance(k, dict) and k.get("topic_id"):
            seq.append(k)
        elif isinstance(k, int):
            seq.append({"topic_id": k, "level": 0, "tag": 0})
    out = []
    for i in range(0, len(seq), batch):
        chunk = seq[i:i + batch]
        # 关键：服务端要的是 word_level_id 不是 0 的时候才认书，
        # 但从 get_word_list_status 拿到的 level 就是这本书的层级，照抄即可。
        payload = [(1, "list", ("struct", [
            [(1, "i32", int(x["topic_id"])),
             (2, "i32", int(x.get("level") or 0)),
             (3, "i32", int(x.get("tag") or 0))]
            for x in chunk]))]
        ok, res = call(HOST_RES, "resource_api", "get_word_list_word_meta_v2",
                       payload, access_token=access_token, timeout=30)
        if not ok:
            return (out or None), res
        for it in (res.get(0) or []):
            if not isinstance(it, dict):
                continue
            tk = it.get(1) or {}
            out.append({"topic_id": tk.get(1) if isinstance(tk, dict) else None,
                        "word": _s(it.get(2)), "mean_cn": _s(it.get(3)),
                        "audio_us": _s(it.get(4))})
    return out, None


def dict_entry(word, access_token=None):
    """词典全量：词根词缀、英美音标、分条释义、例句（带配图与音频）。"""
    ok, res = call(HOST_RES, "resource_api", "get_dict_by_word_v2",
                   [(1, "string", word)], access_token)
    if not ok:
        return None, res
    root = res.get(0)
    if not isinstance(root, dict):
        return None, "没有词典数据"
    head = root.get(1) or {}
    senses = []
    for s in root.get(2) or []:
        if isinstance(s, dict):
            senses.append({"pos": _s(s.get(3)), "cn": _s(s.get(4))})
    examples = []
    for e in root.get(4) or []:
        if isinstance(e, dict):
            examples.append({"en": _s(e.get(4)), "cn": _s(e.get(5)),
                             "img": _s(e.get(7)), "audio": _s(e.get(8))})
    return {
        "word": _s(head.get(2)),
        "uk": _s(head.get(3)), "us": _s(head.get(4)),
        "audio_us": _s(head.get(5)), "audio_uk": _s(head.get(6)),
        "etyma": _s(head.get(8)),
        "senses": senses[:8],
        "examples": examples[:5],
    }, None


def cdn_url(path):
    """把接口返回的相对路径拼成完整 CDN 地址；已经是完整 URL 就原样返回。"""
    if not path:
        return None
    p = str(path).strip()
    if p.startswith("http://") or p.startswith("https://"):
        return p
    if not p.startswith("/"):
        p = "/" + p
    return CDN + p


# ---------------------------------------------------------------- 素材落地

BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
REFERER = "https://www.baicizhan.com/"


def download(url, dest, timeout=15):
    """把 CDN 素材下到本地。

    CDN 对空 UA / 无 Referer 的请求直接 404，所以必须带浏览器头——这也是
    不能把 CDN 地址直接丢进 <img> 的原因（浏览器发的是页面 referer）。
    返回 (ok, bytes_len_or_reason)。
    """
    if not url:
        return False, "没有地址"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", BROWSER_UA)
    req.add_header("Referer", REFERER)
    req.add_header("Accept", "image/avif,image/webp,image/*,*/*;q=0.8")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        return False, "HTTP %s" % e.code
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)
    if len(data) < 256:
        return False, "文件太小（%d 字节），多半是错误页" % len(data)
    d = os.path.dirname(dest)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = dest + ".part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, dest)
    return True, len(data)
