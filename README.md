# 研学台 StudyDeck

按 `outputs/研学台-V3-设计稿.html` 落地出来的真项目：**前端是设计稿那套界面，数据和服务全走本机后端**。
不再有内联的 758KB JSON，不再有只写日志的假工具，进度与作答真落 SQLite。

## 跑起来

```bat
start.bat            :: 双击即可，自动开浏览器
```
或者：
```bash
python -m server.main          # → http://127.0.0.1:8770
python start.py                # 起服务 + 自动开浏览器
```

依赖：`fastapi` `uvicorn`（本机 `F:\Python\Python 3.13` 已装）。

## 目录

```
研学台/
├─ server/            后端
│  ├─ config.py       集中配置：路径 / 端口 / SM-2 间隔 / 外部能力开关
│  ├─ store.py        SQLite 事件库（events / word_mem / lesson_progress / answers / tool_calls / notes / error_tags / exam_sessions / kv）
│  ├─ datahub.py      数据中枢：只读复用旧工作台数据 + 事件库叠加
│  ├─ bcz.py          百词斩词条客户端（Thrift/TCompactProtocol，零依赖）
│  ├─ tools.py        126 个工具的真实现（界面唯一的取数口子）
│  └─ main.py         FastAPI 路由 + 静态托管
├─ web/               前端（index.html / app.css / app.js / img）
├─ build/             构建补丁（把设计稿拆开并接线，可重跑）
├─ tests/             无头验收（243 项断言）
└─ data/              study.db（学习事件）+ backup（整库 JSON 备份）+ cache/word（词条配图）
```

## 前端 → 后端 的契约

| 接口 | 用途 |
|---|---|
| `GET /api/base` | 首屏快照（实测约 221KB，不含 3790 词全量分组与 781 题正文） |
| `GET /api/tools` | 工具注册表 + 最近调用审计 |
| `POST /api/tool/{name}` | 调工具：`{args:{...}, confirm:true}` |
| `POST /api/event` | 埋点（白名单 kind：play / page / word_card / exam_tick / search / note） |
| `GET /api/progress` | 把本机已完成讲次并回旧进度文件（先备份） |

界面不直连数据文件，一切走工具；写盘类工具（`mark_lesson_done` / `sync_xuecheng` / `restore_backup`）
第一次点会要确认，第二次才真写。

## 学科切换

当前学科是一个全局选中态，**只能通过 `setSubject(id)` 改**——它负责校验、清空上一科的讲次、
持久化到 `localStorage['sd.subject']`、并重画顶栏标签与侧栏「接着学」。
三个入口（课程卡按钮、课堂内 `#clsMenu`、搜索框跳讲次）都走这一个函数；
刷新页面由 `restoreSubject()` 从 localStorage 恢复，不会再掉回英语。
服务端返回的 `subject` 是权威值，`get_current_lesson` / `pick_lesson` 拿到后会回写 `setSubject`。

课程库每张卡用自己那门课的封面（`img/courses/BVxxx.jpg`），`list_subjects` 必须带
`cover` / `bvid` / `video_up` / `video_pages` / `video_title`，少一个就会退回同一张占位图。

## 时间与备份的口径

- **投入时长只认真实上报的秒数**：看视频每 10 秒上报一次实看时长（拖动进度、跳断点、浏览器卡顿造成的空白段一律不算），考场每分钟打一次点。`store.learning_seconds()` 只统计 `events` 里 `kind IN ('play','exam_tick')` 且 `seconds>0` 的部分。
- 一条计时都没有时，统计页写"还没有真实计时"并说明是怎么记的，**不显示假的 0 分钟，也不按课程时长估算**。
- **备份是整库 JSON 快照**，落在 `data/backup/`，不上传任何地方。两类文件分开列：`studydeck_*.db.json` 是自己点「导出一份备份」出来的；`studydeck_before_restore_*.db.json` 是每次恢复前自动留的安全副本（恢复错了能退回来）。恢复会整库替换，必须点两次确认。

## 百词斩词条（配图 / 词根 / 例句）

背单词学习卡的那张图解插画不是本地素材，是**现拉百词斩词卡**：

1. `bcz.search(word)` 用文本搜到 `topic_id` → 2. `bcz.word_card(topic_id)` 拿 `cropped_images/xxx.jpg`
→ 3. `bcz.dict_entry(word)` 拿词根词缀（`etyma`）、分条释义、例句（例句也带配图）。

接口是 **Thrift over HTTP + TCompactProtocol**，`POST {host}/rpc/{service}/{method}/{毫秒时间戳}`，
请求体必须带 `[4字节大端长度]` 帧头。协议实现在 `server/bcz.py`，只依赖标准库。

**两个坑（都踩过）**：

- **必须带 token**。无 token 时 `resource_api` 直接回 `"not login"`，`words` 回
  `"Missing user credential info"`。token 放在 `server/config.local.json` 的 `BCZ_ACCESS_TOKEN`
  （主配置不落 token），由 `_apply_local_override()` 注入。
- **CDN 认 UA 和 Referer**，空 UA 直连 `word.bczcdn.com` 一律 404。所以**不能**把 CDN 地址
  直接写进 `<img>`——浏览器发的是页面自己的 referer。正确做法是服务端带浏览器头下下来、
  落到 `data/cache/word/`，再由 `GET /media/word/{name}` 代理出去，接口返回的是
  `/media/word/xxx_pic.jpg` 这个本地地址（`image_remote` 里留原始 CDN 地址备查）。

拿不到就**如实说为什么拿不到**（没配 token / 搜不到 / 网络没通 / 图加载失败），
回落到本地构词推测并标 `fallback_is_guess: true`，**不拿推测冒充实词条，也不放本地图假装配图**。
词源库里本来就没有拆词根的词（实测 `rank` / `twist`），界面写"没有拆词根"，不硬拆、不留空格子。

素材路由 `/media/word/{name}` 定义在 `/media/{rel:path}` **之前**——放到后面会被那条通配路由吃掉（踩过）。

## 数据来源（都可核对）

- 课程 / 讲次 / 时长：`workbench/data/courses.json`（时长为 ffprobe 实测）
- 词表：`workbench/data/vocab.json`（学丞 3790 词）+ wordmap 48 组映射
- 题库：`workbench/data/exercises.json` 的 grammar780（781 题，全带答案与解析）
- 真题：`workbench/data/exam_papers.json`（15 套 / 995 题，全带答案）
- 考点卡：`workbench/data/point_cards.json`（计算机 99 / 计算机 500 / 政治 390）
- 进度：本机 `data/study.db` + 继承的 `workbench/data/progress.json`

**规矩**：派生不出来的数字一律显示占位或"暂无"，不填估算值。

## 重建前端（改了设计稿之后）

```bash
python build/split_design.py        # 设计稿 → app.css / index.html / app.js（会覆盖 web/ 三件）
python build/patch_html.py          # 静态块换成容器
python build/patch_placeholders.py  # 清掉设计稿残留的假数字
python build/patch_controls.py      # 死按钮变真控件
python build/wire_js.py             # 假工具换成真服务调用（13 区块 + 8 补丁）
python build/wire_v2.py             # 第 2 期：错词本 / 今日词量 / 错题本 / 错因打标 / 笔记 / 播完打勾
python build/wire_v3.py             # 第 3 期：真卷例句替换占位助记图 / 整卷 120 分钟计时 / 交卷评分卡 + 历史
python build/wire_v4.py             # 第 4 期：统计页真实投入时长 / 提问带播放位置 / 本机备份导出与恢复
```

**必须按顺序全链重跑**——`split_design.py` 会把 `web/` 打回设计稿原样，
单独重跑它就会丢掉后面所有接线（踩过）。每处替换都断言命中次数，改不到就报错退出。
`wire_v2/v3` 的 `apply()` 带幂等守卫（新串已在文件里就跳过），所以可以放心重复跑。

## 验收

```bash
python tests/reset_db.py            # 先清事件库：验收里有对"干净起点"的绝对值断言
                                    # （删库后会自动重新导入一次旧进度记忆，所以服务要在这之后重启）
node tests/verify_app.mjs http://127.0.0.1:8770   # 243 项断言，FAIL 0
node tests/shot.mjs                 # 九页截图自查（溢出 / 坏图 / 控制台错误）
node tests/probe.mjs "#vocab"       # 单页诊断
```
`reset_db.py` 只清 `研学台/data/study.db`，不动 `workbench/data/progress.json` 的继承进度。

## 第 3 期落的东西

| 项 | 落点 |
|---|---|
| D4 整卷模考评分 | `config.EXAM_TYPE_RULES`（阅读 2.0 / 单选 1.0 / 完形 1.5 / 七选五 2.0；语法填空不判分）+ `store.exam_sessions` + 工具 `submit_exam` / `exam_scores` |
| C1 真卷例句 | `datahub.sentences_of(word)` 从 `exam_papers.json` 全文里抠原句，工具 `word_sentences`；卡片态的占位助记图 `img/mnemo.jpg` 已拆掉 |
| 计时口径 | 整卷 120 分钟（`config.EXAM_TOTAL_MINUTES`），到点不停卷只提示 |

没答的题记 0 分并如实显示"还有 N 题没做"；语法填空要自己写词，本机不判分、不计入总分。
原卷里没出现过的词不给例句，界面写"没有例句"——不编。

## 背单词三段流程（对齐「不背单词」）

以前的问题是：一进背单词页，模式条摊着「默写 / 听写 / 挖空 / 看词选义」任你点，卡片上还写着
「认识 / 不认识」两个按钮 —— 等于让人自己挑怎么背，还默认默写是正路。现在按真实的使用顺序分三段，
**默写这类加练不摆在必经路径上**：

| 段 | 界面 | 代码 |
|---|---|---|
| 1 第一遍见词 | 整张词面（词 / 音标 / 考频 / 释义 / 百词斩配图 / 一句真卷例句）+ 下面 2×2 四选一。选对＝认识；选错＝不认识，**当场把这个词塞到队尾再问一次**（只塞一次，不在队尾打转） | `PHASE==='first'`，队列 `FIRSTQ`，判定表 `FIRSTPASS`；`gradeFirst()` / `firstStep()` / `endFirstPass()` |
| 2 翻屏自评 | 只剩「← 不认识 / 认识 →」，上下键翻页，自评不判分 | `PHASE==='know'`，`markKnow()` / `endKnowPhase()` |
| 3 加练 | 到这一段模式条才出现，默写 / 听写 / 挖空 / 看词选义自己挑 | `PHASE==='drill'`，`paintModeBar()` 只在此时渲染 |

几条硬约束，改动时别退回去：

- **干扰项只从本组抽**，并且跳过同词、跳过前 5 字母相同的同根近形词（`stemOf`）、跳过与目标撞义的词
  （`shareSense`），也跳过选项之间互相撞义的；凑不齐三个就少给几个，绝不拿同根词或同义项凑数。
- **选项只给中文释义**（`bareCn`，取第一个义项并剥掉词性前缀），不带词性，否则词性就成了提示。
- **第一轮绝不露中文释义**：词根、分条释义、例句译文都属于答案，第一段全部不摆，
  只出「选它的意思 A B C D」。判分用的 `base` 必须是 `bareCn(w.cn)` —— 用整串 `cleanCn(w.cn)`
  去和选项的 `data-cn` 比，永远判错、永远标绿另一个选项（踩过）。
- **四个选项必须落在首屏内**（900px 视口，验收用 `getBoundingClientRect().bottom <= innerHeight` 硬查）。
- **选项容器不能叫 `#duoOpts`**：那是第三段「看词选义」的容器，`renderDrill` 在卡片模式下会把整个 `#duoOpts` 摘掉。
  第一轮用 `#firstOpts > #firstList`，否则第一轮永远点不到选项。
- **第一轮不许 shuffle**：`initRound()` 里 `queue = words.map(...)` 按列表顺序走，
  否则左侧词表第 1 个和卡片第 1 个对不上，用户会以为选错组了。
- **答错塞队尾只塞一次**：判「是不是重问那一次」用 `qi >= words.length`（追加的副本下标必然越过原始长度），
  不要用 `FIRSTPASS[w.w]==='no'` 这种持久标记 —— 一旦记成 'no' 就永久为真，队列会在队尾无限打转（踩过，实测 191 步没收尾）。
- 键盘：第一轮 A–D 选答案、空格发音、←/→ 跳过；第二轮 ↓/→ 认识、↑/← 不认识；`L` 键收起/展开左侧词表。

## 背单词三栏版式（`2026-10-17` 重做）

用户三次打回旧版（卡片词与列表首词对不上、选项不对应、按钮全堆在主视觉上），现在照参考稿做成一屏三栏：

| 列 | 内容 |
|---|---|
| 左 276px `#vxList` | `#wlistMeta` 进度 + `#duoProg` 进度条 + 词表 `#wordlistAll`（`.wt[data-w]`）+ 四格战绩 `#sOk/#sNo/#sBest/#sAcc`。`L` 键或 `#vxListToggle` 收起（`.vx.hide-list` 把左栏压成 0px），收起后左下角浮出 `#vxFab` |
| 中 1fr `#duoMain` | 顶栏 `#vxListToggle`/`#wmNow`/`#wGoal`/`#wrongBtn`（纯图标，数量在 `title` 里）/`#wmToggle`；`.vx-stage#duoBody` 卡片；`.vx-fb#duoFb` 反馈条（绝对定位在底部，不横穿卡片）；`.vx-modes#duoModes` 加练模式条（**只在 `PHASE==='drill'` 渲染**） |
| 右 264px | `#vxRing` CSS 圆环正确率 + `#vxAcc`/`#vxRight`/`#vxWrong`/`#vxRedo`/`#vxTotal` |

卡片结构由 `wordCardHTML(w,m,f,kin,phase)` 出：`.vx-card > .vx-card-hd`（`.vx-w` 词 / `.vx-wm` 音标发音 / `.vx-pic#wPic` 配图），
first 段出 `.vx-q` + `.vx-opts#firstList`，know/review 段出 `.vx-knowdef` + `.vx-ex #wSents` + `.vx-memo#wMemo`。

两个必踩的坑：

- **`loadWordExtra` 里的槽位选择器**：老写法 `picBox.querySelector('.wc-pic-slot')` 在新卡面上是 `null`，
  后面 `slot.innerHTML` 直接抛错，词根/分条释义整段被静默跳过（`#wMemo` 永远 0 行）。现在 `|| picBox` 兜住。
- **槽位必须在回调里重新取**：`loadWordExtra` 是每个词都调的异步请求，回来时用户可能已经翻页；
  开头取到的 `#wPic` / `#wMemo` 会是上一张卡的。用 `data-word !== word` 丢弃过期结果，
  但**第一遍没有 `#wMemo`（答案要藏住）**，不能因为 `memo` 为 null 就把配图和发音一起丢了。

## 第 4 期落的东西

| 项 | 落点 |
|---|---|
| F1 真实投入时长 | `store.learning_seconds()` / `play_seconds_of()` / `lesson_play_rows()` + 工具 `lesson_play_time`；统计页「真实投入时长」卡（总计 / 今日 / 看视频 / 考场计时 + 按讲次排行） |
| F2 没数据就说没数据 | `total=0` 时界面写"还没有真实计时"并说明记录方式，不显示 0 分钟、不按课程时长估算 |
| E2 带上下文提问 | `ask_ai` 新增 `lesson_id` / `pos_sec` 入参，返回 `context` 数组（讲次 / 章节 / 科目 / `视频位置：MM:SS`）；课堂提问在发送那一刻取 `video.currentTime` |
| G2 本机备份 | 工具 `make_backup` / `list_backups` / `restore_backup`（后者 PERM_CONFIRM）；备份 = 整库 JSON 快照，恢复前自动留 `before_restore` 副本，两类在界面上分开列 |

计时口径这一期才真正跑通：`log_playback` 现在真的写 `seconds`，前端用 `seeking` / `seeked` 标志挡掉拖动，
`seg<3` 挡掉浏览器卡顿留下的大空档，暂停与播完各补一次收尾上报，剩下不到 10 秒的那部分不丢。

## 百词斩配图这一期落的东西

| 项 | 落点 |
|---|---|
| 协议客户端 | `server/bcz.py`：`search` / `word_card` / `dict_entry` / `cdn_url` / `download`，TCompactProtocol 手写编解码，零第三方依赖 |
| 词条工具 | `fetch_word_detail` 重写：搜词 → 词卡 → 词典三步串起来，一次返回配图、词根词缀、分条释义、短语、词形变化、例句 |
| 素材落地 | `data/cache/word/*.jpg` 由服务端带 `User-Agent` + `Referer` 下载，`GET /media/word/{name}` 代理给前端 |
| 卡片态 | `#wPic`（配图槽）+ `#wPicSrc`（图注）+ `#wMemo`（词根 / 释义 / 短语 / 词形）；失败时槽位直接写失败原因 |
| 发音 | 优先用词条的英美音，没有才回落到教材原音 / 浏览器朗读，发音旁标出来源 |
| 缓存 | `data/cache/word/{word}.json`，`config.BCZ_CACHE_TTL_DAYS`（默认 30 天）；`force: true` 可强制刷新 |

学习卡的配图**不占位、不写死**：`img/mnemo.jpg` 那张占位图早就拆了，这一期换成真词图。
布局上 `.wcard` 是纵向堆叠（`duo-main` 本身是 column flex），配图和释义在 `.wcard-row` 里横排——
早先直接把所有子元素塞进横排 flex，结果单词被挤成一条竖线（踩过）。

**主图 404 的兜底**：百词斩词卡的 `image_file` 有一部分是旧格式
`/cropped_images/3_0_<时间戳>_<id>_c.jpg`，在 CDN 上已经失效（实测 `dormitory`、
`sophisticated` 返回 404，换 `_c.png`、去掉 `_c`、`i_1_…` 路径同样 404）。这时不摆空槽，
改用第 1 条例句的配图顶上，返回体标 `image_kind: "example"` + `image_example_index`，
界面图注改口成「主图在源站已失效，这是第 N 条例句的配图」，配图槽加虚线边——
用户一眼能看出这不是词的意象图。`image_kind: "word"` 才是真主图。
