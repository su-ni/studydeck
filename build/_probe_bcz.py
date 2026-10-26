# -*- coding: utf-8 -*-
"""探针：百词斩免 token 能拿到哪些单词数据（重点：配图 URL）"""
import io
import json
import sys
import time

sys.path.insert(0, r"F:/项目/反编译/bcz_analysis")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from bcz_client_demo import CompactReader, CompactWriter, DEFAULT_COOKIE, send_thrift  # noqa: E402


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


cookie = DEFAULT_COOKIE.format(ts=int(time.time()), serial=time.strftime("%d%H%M%S"))
WORD = sys.argv[1] if len(sys.argv) > 1 else "abandon"


def call(host, service, method, fields):
    body = build(method, fields)
    st, resp = send_thrift(host, service, method, body, cookie)
    r = CompactReader(resp)
    msg = r.message_begin()
    return st, clean(r.read_struct())


print("词:", WORD)
print()

# 1) search_word_v2 —— 报告标记为「文本→数据主入口」，实测看免 token 行不行
print("=" * 60)
print("[1] resource_api / search_word_v2")
print("=" * 60)
try:
    st, res = call("https://resource.baicizhan.com", "resource_api",
                   "search_word_v2", [(1, "string", WORD)])
    print("HTTP", st)
    print(json.dumps(res, ensure_ascii=False)[:1500])
except Exception as e:
    print("ERR", type(e).__name__, e)

print()
# 2) get_dict_by_word_v2 —— 词典全量
print("=" * 60)
print("[2] resource_api / get_dict_by_word_v2")
print("=" * 60)
try:
    st, res = call("https://resource.baicizhan.com", "resource_api",
                   "get_dict_by_word_v2", [(1, "string", WORD)])
    print("HTTP", st)
    print(json.dumps(res, ensure_ascii=False)[:2000])
except Exception as e:
    print("ERR", type(e).__name__, e)

print()
# 3) get_word_topic_assets_v2 —— 词卡，配图就在这（字段6 image_file）
print("=" * 60)
print("[3] words / get_word_topic_assets_v2  (topic_id 先试一个已知值)")
print("=" * 60)
for lvl, tid in [(0, 2782), (1, 2782), (0, 130680)]:
    try:
        st, res = call("https://www.baicizhan.com", "words",
                       "get_word_topic_assets_v2",
                       [(1, "i32", lvl), (2, "list", ("i32", [tid]))])
        print(f"  lvl={lvl} tid={tid} HTTP {st} -> {json.dumps(res, ensure_ascii=False)[:600]}")
    except Exception as e:
        print(f"  lvl={lvl} tid={tid} ERR {type(e).__name__} {e}")
