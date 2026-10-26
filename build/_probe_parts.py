# -*- coding: utf-8 -*-
import io
import sys

sys.path.insert(0, ".")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from server import datahub  # noqa: E402

parts = (datahub.proto().get("exercise_bank") or {}).get("parts") or []
for pt in parts:
    nm = pt["name"]
    stripped = nm.replace("部分：", "")
    print(repr(nm), "->", repr(stripped), "n=", pt.get("n"))
