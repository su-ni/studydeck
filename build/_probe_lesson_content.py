# -*- coding: utf-8 -*-
import io
import sys

sys.path.insert(0, ".")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from server import datahub  # noqa: E402

cases = ["english-68", "english-72", "english-75", "english-83", "english-90",
         "english-95", "english-100", "english-105"]
for lid in cases:
    d = datahub.lesson_content(lid)
    if not d.get("subject"):
        continue
    print(lid, "|", d.get("title"))
    print("   points:", d.get("points"))
    print("   covers:", [(c["name"], c["why"]) for c in d.get("covers") or []])
