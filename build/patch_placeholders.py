# -*- coding: utf-8 -*-
"""研学台 · 清掉 HTML 里设计稿残留的假占位。

设计稿是静态稿，里面写死了不少"看起来像真的"的数字（假断点 00:32:10、
假答题卡"已答 12 / 45"、假进度 5/364）。这些在接真数据后必须变成中性占位，
否则页面在任何时刻都可能露出一个查不到源头的数字。
"""
import io
import os

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "web", "index.html")

EDITS = [
    ("首栏周次不装懂", '<span>课表</span><span class="cnt">第 6 周</span>',
     '<span>课表</span><span class="cnt">本周</span>'),
    ("时间轴标明是计划草案", '<h3>本周时间轴 · 第 6 周</h3>',
     '<h3>本周时间轴 · 计划草案（可改）</h3>'),
    ("目录进度条起点归零", '<div class="bar"><i class="en" style="width:2%"></i></div>',
     '<div class="bar"><i class="en" style="width:0%"></i></div>'),
    ("目录进度中性占位", '<b id="tocProg">5 / 364</b>', '<b id="tocProg">—</b>'),
    ("播放进度条起点归零", '<div class="bar"><i style="width:38%"></i></div>',
     '<div class="bar"><i style="width:0%"></i></div>'),
    ("删掉假断点 00:32:10", '<span>词锚点</span><span class="num" id="plineNow">00:32:10</span>',
     '<span>词锚点</span><span class="num" id="plineNow">00:00</span>'),
    ("练习题号中性占位", '<span class="bdg" id="pracNo">第 1 题</span><span class="bdg" id="pracPart">第一部分：名词</span>',
     '<span class="bdg" id="pracNo">—</span><span class="bdg" id="pracPart">—</span>'),
    ("练习会话条中性占位", '<div class="s"><span class="k">本组进度</span><span class="v">1 / 30</span></div>',
     '<div class="s"><span class="k">本组进度</span><span class="v">—</span></div>'),
    ("倒计时不预填", '<div class="timer" style="margin-top:10px" id="clock">20:00</div>',
     '<div class="timer" style="margin-top:10px" id="clock">--:--</div>'),
    ("答题卡不预填 12", '<span class="meta" id="sheetMeta">已答 12 / 45</span>',
     '<span class="meta" id="sheetMeta">—</span>'),
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
print("假占位清理完成：%d 处" % len(EDITS))
