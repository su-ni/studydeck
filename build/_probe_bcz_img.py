# -*- coding: utf-8 -*-
"""探针：拿到单词配图 image_file（get_word_topic_assets_v2），并验证 CDN 可下载"""
import io
import json
import sys
import time

sys.path.insert(0, r"F:/项目/反编译/bcz_analysis")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from bcz_client_demo import CompactReader, CompactWriter, DEFAULT_COOKIE, send_thrift  # noqa: E402

TOKEN = "RGOgSbz9nNeasOToGPdE7P0Io0W4uOyJ3sPBrv7tPtI="


def dec(b):
    return b.decode("utf-8", "replace") if isinstance(b, bytes) else b


def clean(d):
    if isinstance(d, dict):
        return {k: clean(v) for k, v in d.items()}
    if isinstance(d, list):
        return [clean(x) for x in d]
    return dec(d)


def build(method, fields):
    w = CompactWriter()
    w.message_begin(method, "CALL", 1)
    w.struct_begin()
    for fid, ctype, val in fields:
        w.field(fid, ctype, val)
    w.struct_end()
    return bytes(w.buf)


def ck():
    base = DEFAULT_COOKIE.format(ts=int(time.time()), serial=time.strftime("%d%H%M%S"))
    return base + ";access_token=" + TOKEN.replace("=", "%3D").replace("+", "%2B")


def call(host, service, method, fields):
    st, resp = send_thrift(host, service, method, build(method, fields), ck())
    r = CompactReader(resp)
    r.message_begin()
    return st, clean(r.read_struct())


# topic_id 从上一步 search_word_v2 拿到：abandon=4719
for word, tid in [("abandon", 4719), ("clean", 2782), ("integrity", None)]:
    if tid is None:
        st, res = call("https://resource.baicizhan.com", "resource_api",
                       "search_word_v2", [(1, "string", word)])
        rows = res.get("0") or []
        if not rows:
            print(word, "搜不到"); continue
        tid = rows[0].get("2")
    print("=" * 60)
    print(f"{word}  topic_id={tid}")
    print("=" * 60)
    for lvl in (0, 1):
        try:
            st, res = call("https://www.baicizhan.com", "words",
                           "get_word_topic_assets_v2",
                           [(1, "i32", lvl), (2, "list", ("i32", [tid]))])
            body = json.dumps(res, ensure_ascii=False)
            print(f"  lvl={lvl} -> {body[:900]}")
            if res.get("0"):
                break
        except Exception as e:
            print(f"  lvl={lvl} ERR {e}")
