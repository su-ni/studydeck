# -*- coding: utf-8 -*-
"""研学台 · 把死按钮变成真控件的 HTML 补丁。

设计稿里有几个"看起来能点但其实没接线"的控件：顶栏搜索、本门课讲次搜索、
全屏、练习页的"让 AI 讲清这题"、词群面板的"加进今天的复习"。
这里只负责给它们真身份（id）和真输入框，行为在 app.js 的接线增强里。
"""
import io
import os

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "web", "index.html")

EDITS = [
    ("顶栏搜索变真输入 + 结果面板",
     """        <button class="search"><svg class="ic" style="width:16px;height:16px"><use href="#i-search"/></svg>搜索课程 / 单词 / 考点<kbd>⌘K</kbd></button>""",
     """        <span class="sbox">
          <svg class="ic" style="width:16px;height:16px"><use href="#i-search"/></svg>
          <input id="searchIn" placeholder="搜索讲次 / 单词 / 考点 / 题干" autocomplete="off">
          <button class="sgo" id="searchBtn" aria-label="搜索">搜</button>
        </span>
        <div class="card" id="searchPop" hidden></div>"""),

    ("全屏按钮给 id", """          <button class="btn sm"><svg class="ic" style="width:15px;height:15px"><use href="#i-expand"/></svg>全屏</button>""",
     """          <button class="btn sm" id="fsBtn"><svg class="ic" style="width:15px;height:15px"><use href="#i-expand"/></svg>全屏</button>"""),

    ("讲次搜索变真输入", """              <button class="tocsearch"><svg class="ic" style="width:14px;height:14px"><use href="#i-search"/></svg>搜索本门课讲次…</button>""",
     """              <input class="tocsearch" id="tocSearch" placeholder="搜索本门课讲次…" autocomplete="off">"""),

    ("加进复习按钮给 id", """                  <button class="btn sm" style="margin-left:auto">把本讲词加进今天的复习</button>""",
     """                  <button class="btn sm" id="dwAdd" style="margin-left:auto">把本讲词加进今天的复习</button>"""),

    ("AI 讲题按钮给 id", """                <button class="btn sm" style="margin-top:12px"><svg class="ic" style="width:14px;height:14px"><use href="#i-spark"/></svg>让 AI 讲清这题</button>""",
     """                <button class="btn sm" id="pracAi" style="margin-top:12px"><svg class="ic" style="width:14px;height:14px"><use href="#i-spark"/></svg>让 AI 讲清这题</button>"""),
]

with io.open(PATH, encoding="utf-8") as f:
    text = f.read()

for label, old, new in EDITS:
    if text.count(old) != 1:
        raise SystemExit("✗ %s：命中 %d 次" % (label, text.count(old)))
    text = text.replace(old, new, 1)
    print("✓ %s" % label)

with io.open(PATH, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)
print("死按钮接线完成：%d 处" % len(EDITS))
