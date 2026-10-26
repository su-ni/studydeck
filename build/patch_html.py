# -*- coding: utf-8 -*-
"""研学台 · 前端 HTML 接线补丁。

设计稿的静态块要变成"由工具填"的容器：
- 练习页三个导航按钮补 id
- 考场页的硬编码阅读题换成容器（真题从 exam_papers.json 来）
- 课堂页侧舱四个面板换成容器
- 选课条加一个真实的科目弹层

每处替换都断言命中次数，改不到就报错退出（沿用本项目的老规矩）。
"""
import io
import os

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
PATH = os.path.join(WEB, "index.html")

EDITS = []


def E(label, old, new, n=1):
    EDITS.append((label, old, new, n))


# ---- 1. 练习页导航按钮 --------------------------------------------------
E("练习页导航按钮补 id", """              <div style="display:flex;gap:12px;margin-top:22px">
                <button class="btn">上一题</button>
                <button class="btn act" style="flex:1;justify-content:center">下一题 <svg class="ic" style="width:15px;height:15px"><use href="#i-arrow"/></svg></button>
                <button class="btn"><svg class="ic" style="width:14px;height:14px"><use href="#i-refresh"/></svg>重做本组</button>
              </div>""",
  """              <div style="display:flex;gap:12px;margin-top:22px">
                <button class="btn" id="pracPrev">上一题</button>
                <button class="btn act" id="pracNext" style="flex:1;justify-content:center">下一题 <svg class="ic" style="width:15px;height:15px"><use href="#i-arrow"/></svg></button>
                <button class="btn" id="pracReset"><svg class="ic" style="width:14px;height:14px"><use href="#i-refresh"/></svg>重做本组</button>
              </div>""")

# ---- 2. 选课条加科目弹层 -------------------------------------------------
E("课堂选课条加弹层容器", """          <button class="btn sm" id="tocBtn"><svg class="ic" style="width:15px;height:15px"><use href="#i-list"/></svg><span id="tocBtnT">收起目录</span></button>
          <span class="bdg" style="height:30px"><span class="dot ok"></span>跟随进度</span>""",
  """          <button class="btn sm" id="tocBtn"><svg class="ic" style="width:15px;height:15px"><use href="#i-list"/></svg><span id="tocBtnT">收起目录</span></button>
          <span class="bdg" style="height:30px" id="followBadge"><span class="dot ok"></span><span id="followT">跟随进度</span></span>""")

E("插入科目弹层", """        <div class="cls3" id="cls3">""",
  """        <div class="card" id="clsMenu" hidden></div>

        <div class="cls3" id="cls3">""")

# ---- 3. 课堂侧舱：四个静态面板换容器 -----------------------------------
E("侧舱-词群面板容器", """                <div class="dgrid" id="dwlist"></div>""",
  """                <div class="dgrid" id="dwlist"></div>
                <p class="sub" id="dwWhy" style="margin-top:14px"></p>""")

E("侧舱-讲义面板容器", """                  <figure class="pagethumb"><img src="img/desk.jpg" alt="讲义原页"></figure>
                  <div style="flex:1;min-width:0">
                    <div class="explain" style="margin-top:0"><div class="k">讲义原页 · p.14</div><p>讲义为 322 页纯扫描件，暂无文本层。词群按讲次顺序对齐，不保证与书上讲法逐字一致。可翻页、缩放、用本机程序打开。</p></div>
                    <div style="display:flex;gap:10px;margin-top:14px">
                      <button class="btn sm">上一页</button>
                      <button class="btn sm">下一页</button>
                      <button class="btn sm">跳到页码…</button>
                      <button class="btn sm"><svg class="ic" style="width:14px;height:14px"><use href="#i-file"/></svg>本机打开</button>
                    </div>
                  </div>""",
  """                  <figure class="pagethumb"><img id="dpImg" src="img/desk.jpg" alt="讲义"></figure>
                  <div style="flex:1;min-width:0">
                    <div class="explain" style="margin-top:0"><div class="k" id="dpHead">讲义</div><p id="dpNote">—</p></div>
                    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap" id="dpLinks"></div>
                  </div>""")

E("侧舱-当堂测面板容器", """                <div style="display:flex;gap:26px;align-items:flex-start">
                  <div class="explain" style="margin-top:0;flex:1"><div class="k">当堂测 · 已就绪</div><p>按你刚过的时间点（00:32:10）之前的 3 个词生成 3 道变式题，答完自动继续播放，不打断。</p></div>
                  <div style="flex:none;width:260px">
                    <button class="btn act block lg">开始 3 题当堂测</button>
                    <p class="sub" style="margin-top:10px">题型：看义写词 · 听辨 · 搭配</p>
                  </div>
                </div>""",
  """                <div style="display:flex;gap:26px;align-items:flex-start">
                  <div class="explain" style="margin-top:0;flex:1"><div class="k" id="dqHead">当堂测</div><p id="dqNote">—</p></div>
                  <div style="flex:none;width:260px">
                    <button class="btn act block lg" id="dqStart">开始当堂测</button>
                    <p class="sub" style="margin-top:10px" id="dqSub">—</p>
                  </div>
                </div>""")

E("侧舱-笔记容器", """                <textarea class="notearea" placeholder="本讲笔记…&#10;谓语 = 句子的发动机，先找动词再找主语。"></textarea>
                <div class="sub" style="margin-top:10px;display:flex"><span>自动存到本讲</span><span style="margin-left:auto">已同步 3 条</span></div>""",
  """                <textarea class="notearea" id="dnArea" placeholder="本讲笔记…&#10;谓语 = 句子的发动机，先找动词再找主语。"></textarea>
                <div class="sub" style="margin-top:10px;display:flex"><span>失焦即写入本机事件库</span><span style="margin-left:auto" id="dnState">—</span></div>""")

E("侧舱-提问容器", """                  <div style="flex:1">
                    <textarea class="notearea" style="min-height:104px" placeholder="为什么这句的谓语是 is 而不是 are？"></textarea>
                  </div>
                  <div style="flex:none;width:260px">
                    <div class="explain" style="margin-top:0"><div class="k">问守岸人</div><p>问题自动带上当前讲次与时间点，它会知道你卡在哪一句。</p></div>
                    <button class="btn block" style="margin-top:12px">带上 00:32:10 提问</button>
                  </div>""",
  """                  <div style="flex:1">
                    <textarea class="notearea" id="daArea" style="min-height:104px" placeholder="为什么这句的谓语是 is 而不是 are？"></textarea>
                    <div class="explain reveal" id="daOut" style="margin-top:14px"><div class="k">回答</div><p id="daOutT">—</p></div>
                  </div>
                  <div style="flex:none;width:260px">
                    <div class="explain" style="margin-top:0"><div class="k">问守岸人</div><p id="daHint">问题会带上当前讲次一起发出去。</p></div>
                    <button class="btn block" style="margin-top:12px" id="daBtn">提问</button>
                  </div>""")

# ---- 4. 考场页：硬编码题换成真卷容器 ------------------------------------
E("考场选卷按钮补 id", """          <button class="sel"><span id="examNameT">2023 年 · 广东《公共英语》真题+答案</span><svg class="ic cv" style="width:16px;height:16px"><use href="#i-cv"/></svg></button>
          <span class="bdg">45 题 · 满分 100</span>""",
  """          <button class="sel" id="examPick"><span id="examNameT">—</span><svg class="ic cv" style="width:16px;height:16px"><use href="#i-cv"/></svg></button>
          <span class="bdg" id="examMeta">—</span>""")

E("考场题目区换容器", """            <div class="passage" style="margin-bottom:20px">
              Why do we still read old books? Because a book is not a container of answers but a room you can walk into twice — the second time you notice the window, not the door.
            </div>
            <div class="q">
              <div class="qno"><span class="bdg">第 21 题 · 阅读理解 A 篇</span><span class="bdg warn">原卷答案</span></div>
              <div class="stem">According to the passage, what changes when a reader returns to the same book?</div>
              <div class="opts">
                <button class="opt"><i>A</i>The book is rewritten by the author.</button>
                <button class="opt ok"><i>B</i>The reader's attention falls on different details.<span class="bdg ok" style="margin-left:auto">正确答案</span></button>
                <button class="opt bad"><i>C</i>The answers in the book become clearer.<span class="bdg bad" style="margin-left:auto">你选的</span></button>
                <button class="opt"><i>D</i>The reader loses interest in the text.</button>
              </div>
            </div>""",
  """            <div class="pickbar" id="examGroups" style="box-shadow:none;margin-bottom:16px"></div>
            <div class="passage" id="examPassage" style="margin-bottom:20px;display:none">—</div>
            <div class="q">
              <div class="qno"><span class="bdg" id="examQNo">第 — 题</span><span class="bdg" id="examQLabel">—</span></div>
              <div class="stem" id="examStem">—</div>
              <div class="opts" id="examOpts"></div>
              <div class="explain reveal" id="examExp"><div class="k">判定</div><p id="examExpT">—</p></div>
              <div style="display:flex;gap:12px;margin-top:22px">
                <button class="btn" id="examPrevQ">上一题</button>
                <button class="btn act" id="examNextQ" style="flex:1;justify-content:center">下一题 <svg class="ic" style="width:15px;height:15px"><use href="#i-arrow"/></svg></button>
              </div>
            </div>""")

E("题目出处卡换容器", """              <div class="card"><div class="qsrc">
                <div class="kv"><span class="k">原卷</span><span class="v">刘晓艳资料包 · 专升本各地历年真题 · 2019 广东卷</span><span class="bdg ok">OCR 重建</span></div>
                <div class="kv"><span class="k">页码</span><span class="v">阅读理解 A 篇 · 原文页 3</span><span class="bdg ok">已校对</span></div>
                <div class="kv"><span class="k">标准答案</span><span class="v">随卷答案页 · 已录入</span><span class="bdg act">B</span></div>
              </div></div>""",
  """              <div class="card"><div class="qsrc" id="examSrc"></div></div>""")

E("交卷按钮补 id", """            <button class="btn act block lg" style="margin-top:20px">交卷看分</button>
            <p class="hint" style="margin-top:14px">绿色已答、红色错题、灰色原卷无答案不计分。点题号可跳到任意题。</p>""",
  """            <button class="btn act block lg" style="margin-top:20px" id="examSubmit">交卷看分</button>
            <p class="hint" id="examHint" style="margin-top:14px">绿色已答、红色错题。点题号跳到那一题；分数只按本机真实作答算。</p>""")

# ---- 5. 拼一下 -----------------------------------------------------------
with io.open(PATH, encoding="utf-8") as f:
    text = f.read()

for label, old, new, n in EDITS:
    got = text.count(old)
    if got != n:
        raise SystemExit("✗ %s：期望命中 %d 次，实际 %d 次" % (label, n, got))
    text = text.replace(old, new, n)
    print("✓ %s" % label)

with io.open(PATH, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)
print("index.html 更新完成，%d 处" % len(EDITS))
