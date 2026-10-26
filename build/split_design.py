# -*- coding: utf-8 -*-
"""把 outputs/研学台-V3-设计稿.html 拆成真前端三件套。

设计稿是单文件（CSS + HTML + 758KB 内联 PROTO_DATA + JS）。
这里只做"物理拆分"：CSS / body 结构 / JS IIFE 各归各位，内联数据整块丢掉。
接线（API 驱动、真工具、落库）由 patch_frontend.py 负责，本脚本不碰逻辑。
"""
import io
import os
import re
import sys

ROOT = r"F:\项目\备考专升本"
SRC = os.path.join(ROOT, "outputs", "研学台-V3-设计稿.html")
DST = os.path.join(ROOT, "研学台", "web")

with io.open(SRC, encoding="utf-8") as f:
    lines = f.read().split("\n")


def find_line(pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit("找不到边界: " + pattern)


i_style_open = find_line(r"^<style>$")
i_style_close = find_line(r"^</style>$", i_style_open)
i_body = find_line(r"^<body>$")
i_data_script = find_line(r'<script id="PROTO_DATA"')
i_js_open = find_line(r"^<script>$", i_data_script)
i_js_close = find_line(r"^</script>$", i_js_open)
i_html_close = find_line(r"^</html>$")

css = "\n".join(lines[i_style_open + 1: i_style_close]).strip() + "\n"
body = "\n".join(lines[i_body + 1: i_data_script]).rstrip()
js = "\n".join(lines[i_js_open + 1: i_js_close]).strip() + "\n"

# body 里最后一个 </div> 是 .app 的收尾，保留；去掉多余尾空行
assert "</section>" in body, "body 结构异常"
assert "logTool" in js, "JS 结构异常"

index = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>研学台 · StudyDeck</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
%s
<script src="app.js"></script>
</body>
</html>
""" % body

os.makedirs(DST, exist_ok=True)
for name, text in (("app.css", css), ("index.html", index), ("app.js", js)):
    with io.open(os.path.join(DST, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("写出 %-11s %8d 字节 %5d 行" % (name, len(text.encode("utf-8")), text.count("\n") + 1))
