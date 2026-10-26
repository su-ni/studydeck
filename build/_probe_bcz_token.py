# -*- coding: utf-8 -*-
"""探针：带 access_token 实测百词斩单词数据 + 配图 URL"""
import io
import json
import sys
import time

sys.path.insert(0, r"F:/项目/反编译/bcz_analysis")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from bcz_client_demo import CompactReader, CompactWriter, DEFAULT_COOKIE, send_thrift  # noqa: E402

# 从 kv_user_info 里读出来的真实 token
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


def cookie_with_token():
    base = DEFAULT_COOKIE.format(ts=int(time.time()), serial=time.strftime("%d%H%M%S"))
    return base + ";access_token=" + TOKEN.replace("=", "%3D").replace("+", "%2B")


def call(host, service, method, fields):
    st, resp = send_thrift(host, service, method, build(method, fields), cookie_with_token())
    r = CompactReader(resp)
    r.message_begin()
    return st, clean(r.read_struct())


WORD = sys.argv[1] if len(sys.argv) > 1 else "abandon"
print("词:", WORD)
print()

print("=" * 60)
print("[1] search_word_v2（带 token）")
print("=" * 60)
st, res = call("https://resource.baicizhan.com", "resource_api",
               "search_word_v2", [(1, "string", WORD)])
print("HTTP", st)
print(json.dumps(res, ensure_ascii=False)[:1200])
print()

print("=" * 60)
print("[2] get_dict_by_word_v2（带 token）")
print("=" * 60)
st, res = call("https://resource.baicizhan.com", "resource_api",
               "get_dict_by_word_v2", [(1, "string", WORD)])
print("HTTP", st)
print(json.dumps(res, ensure_ascii=False)[:2500])
print()

print("=" * 60)
print("[3] get_word_search / 其他候选")
print("=" * 60)
for m in ("word_search",):
    try:
        st, res = call("https://www.baicizhan.com", "words", m, [(1, "string", WORD)])
        print(f"  {m} HTTP {st} -> {json.dumps(res, ensure_ascii=False)[:400]}")
    except Exception as e:
        print(f"  {m} ERR {e}")
