# -*- coding: utf-8 -*-
"""临时探针：验证 G1 多端同步的 push → pull 链路（用完删）。"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import config, store, tools  # noqa: E402


def d(call_res):
    return call_res.get("data") or {}


print("SYNC_DIR:", config.SYNC_DIR)
print("device:", store.device_name(), store.device_id())

# 本机造点数据
store.add_event("play", lesson_id="english-68", seconds=42.5)
store.grade_word("abandon", True)
store.add_answer(101, "语法", "B", "B", True)
store.save_note("english-68", "本机写的笔记", 12.0)
store.set_lesson("english-68", "english", status="doing", pos_sec=42.0)

r = tools.call("sync_push", {})
print("push:", {k: d(r).get(k) for k in ("ok", "name", "events", "words", "counts")})
print("  error:", d(r).get("error"))

r = tools.call("sync_status", {})
print("status:", {k: d(r).get(k) for k in
                  ("enabled", "dir_exists", "bundles", "mine", "last_push")})

peers = d(tools.call("sync_peers", {}))
print("peers count:", peers.get("count"), "others:", peers.get("others"))
p0 = (peers.get("peers") or [{}])[0]
print("peer0 self:", p0.get("self"), "importable:", p0.get("importable"),
      "device:", p0.get("device"))

r = tools.call("sync_pull", {"name": p0.get("name")})
print("pull self (should error):", d(r).get("error"))

# 造一个"别人"的包：改 device_id，并给它几条本机没有的记录
alt_bundle = store.export_bundle()
dd = os.path.join(config.SYNC_DIR, config.SYNC_DIRNAME)
alt_name = config.SYNC_BUNDLE_PREFIX + "otherbox_20260101_000000.json"
alt_payload = {"format": "studydeck-sync-1", "device": "另一台机器",
               "device_id": "d-ffffffffffff", "created_at": store.now(),
               "counts": alt_bundle["counts"], "tables": alt_bundle["tables"]}
alt_payload["tables"]["word_mem"].append(
    {"word": "zoomingexample", "box": 2, "due": "2030-01-01", "seen": 3,
     "right": 3, "wrong": 0, "last_ts": "2030-01-01 00:00:00"})
alt_payload["tables"]["answers"].append(
    {"ts": "2030-01-01 00:00:00", "qno": 999, "part": "句子", "chosen": "A",
     "ans": "A", "ok": 1, "uid": "d-ffffffffffff-20300101000000-abc123"})
alt_payload["tables"]["notes"].append(
    {"lesson_id": "english-68", "text": "另一台机器写的笔记", "pos_sec": 30.0,
     "updated_ts": "2030-01-01 00:00:00", "alt_text": None, "alt_ts": None})
alt_payload["tables"]["lesson_progress"].append(
    {"lesson_id": "english-99", "subject": "english", "status": "done",
     "pos_sec": 0.0, "updated_ts": "2030-01-01 00:00:00"})
with io.open(os.path.join(dd, alt_name), "w", encoding="utf-8") as f:
    json.dump(alt_payload, f, ensure_ascii=False)

before = store.mem_stats()["words"]
before_ans = store.answer_stats()
r = tools.call("sync_pull", {"name": alt_name}, confirmed=True)
x = d(r)
print("pull other: ok=%s new=%s changed=%s notes_conflicts=%s"
      % (x.get("ok"), x.get("new"), x.get("changed"), x.get("notes_conflicts")))
print("  error:", x.get("error"))
print("  note:", x.get("note"))
print("  added:", json.dumps(x.get("added"), ensure_ascii=False))
print("  updated:", json.dumps(x.get("updated"), ensure_ascii=False))
print("  conflicts:", json.dumps(x.get("conflicts"), ensure_ascii=False)[:200])
print("words before/after:", before, "→", store.mem_stats()["words"])
print("answers before/after:", before_ans, "→", store.answer_stats())
print("note english-68:", json.dumps(store.get_note("english-68"), ensure_ascii=False))
print("lesson english-99:", store.get_lesson("english-99"))

# 幂等：再拉一次同一包，不应该重复加
x2 = d(tools.call("sync_pull", {"name": alt_name}, confirmed=True))
print("pull twice new/changed:", x2.get("new"), x2.get("changed"))
print("words after 2nd:", store.mem_stats()["words"])
