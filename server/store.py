# -*- coding: utf-8 -*-
"""研学台 · 学习事件库（SQLite）。

设计稿里所有"本次会话不落库"的地方，都收到这里：
  events            一切学习动作（看视频 / 翻词卡 / 切讲次 / 判分 / 完成讲次）
  word_mem          单词记忆状态（SM-2 box + 到期日）
  lesson_progress   讲次进度（含**播放位置**，旧 progress.json 里没有这个字段）
  answers           练习作答（判分结果 + 选择），错因归因的真源
  tool_calls        工具调用审计（Agent 工具台"最近调用"读它）
  kv                杂项
"""
import json
import os
import sqlite3
import datetime as dt
import platform
import uuid

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  lesson_id TEXT,
  word TEXT,
  part TEXT,
  qno INTEGER,
  ok INTEGER,
  seconds REAL DEFAULT 0,
  payload TEXT,
  uid TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_uid ON events(uid);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS word_mem(
  word TEXT PRIMARY KEY,
  box INTEGER NOT NULL DEFAULT 0,
  due TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  right INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  last_ts TEXT
);

CREATE TABLE IF NOT EXISTS lesson_progress(
  lesson_id TEXT PRIMARY KEY,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'doing',
  pos_sec REAL DEFAULT 0,
  updated_ts TEXT
);

CREATE TABLE IF NOT EXISTS answers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  qno INTEGER NOT NULL,
  part TEXT,
  chosen TEXT,
  ans TEXT,
  ok INTEGER NOT NULL,
  uid TEXT,
  source TEXT,
  subject TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_answers_uid ON answers(uid);
CREATE INDEX IF NOT EXISTS ix_answers_qno ON answers(qno);

CREATE TABLE IF NOT EXISTS tool_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  perm TEXT,
  args TEXT,
  ok INTEGER,
  ms INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS notes(
  lesson_id TEXT PRIMARY KEY,
  text TEXT,
  pos_sec REAL DEFAULT 0,
  updated_ts TEXT
);

CREATE TABLE IF NOT EXISTS error_tags(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  qno INTEGER,
  part TEXT,
  tag TEXT,
  word TEXT,
  uid TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_errortags_uid ON error_tags(uid);

CREATE TABLE IF NOT EXISTS exam_sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  judgeable INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  right INTEGER NOT NULL DEFAULT 0,
  raw REAL DEFAULT 0,
  max_raw REAL DEFAULT 0,
  scored REAL,
  seconds REAL DEFAULT 0,
  detail TEXT,
  uid TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_exam_uid ON exam_sessions(uid);
CREATE INDEX IF NOT EXISTS ix_exam_paper ON exam_sessions(paper_id, id);

CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);

-- 会话与事件流（2026-10-24 起）。
-- 以前一条会话塞在 kv['agent.thread'] 的一行 JSON 里：刷新能读，但存不下长轨迹、
-- 不能按会话分栏、也没法回放到第几步。改成 append-only 事件流，参照
-- DeepSeek Harness 的 session log（Model-visible means logged）。
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,          -- s-20261024-0430-ab12
  title TEXT,                   -- 第一句话截断，或模型起的标题
  focus TEXT,                   -- 从哪个页面开的
  provider TEXT, model TEXT,    -- 会话内不换模型，换就新开
  created_at TEXT, updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sessions_up ON sessions(archived, updated_at);

CREATE TABLE IF NOT EXISTS session_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_no INTEGER NOT NULL DEFAULT 0,   -- 第几个 turn
  step_no INTEGER NOT NULL DEFAULT 0,   -- 第几个 step（一次模型请求）
  seq INTEGER NOT NULL,                 -- 渲染顺序只认这个
  kind TEXT NOT NULL,                   -- turn/start|step/start|reasoning|tool/call|
                                        -- tool/result|assistant/message|ui/action|turn/end|error
  payload TEXT NOT NULL,                -- JSON
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ev_seq ON session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS ix_ev_kind ON session_events(session_id, kind);

-- 笔记画布。一张图＝一张导图，挂在讲次上，也可以不挂（free）。
-- 节点用 JSON 存整棵树：画布的编辑频次低、体量小，但结构经常变，
-- 每次改结构就加一张表改一遍 schema 不划算；整棵树存 JSON，结构随代码走。
CREATE TABLE IF NOT EXISTS canvas_maps(
  id TEXT PRIMARY KEY,
  lesson_id TEXT,
  title TEXT,
  src TEXT,                 -- 来源：local / xmind / obsidian / notion / markdown / joplin / logseq
  src_id TEXT,              -- 来源那边的文件 ID（XMind 的 mapId、Obsidian 的相对路径…）
  tree TEXT,                -- 整棵树 JSON
  updated_ts TEXT
);
CREATE INDEX IF NOT EXISTS ix_canvas_lesson ON canvas_maps(lesson_id);
CREATE INDEX IF NOT EXISTS ix_canvas_src ON canvas_maps(src, src_id);

-- 学科截图库。截下来的图按学科归档，源文件落在 data/shots/<学科>/ 下，
-- 库里只记元数据 + 文件名。图不进 sqlite：sqlite 存 BLOB 会让备份变成几百兆，
-- 而这些图本来就是文件，放盘上更实在。
CREATE TABLE IF NOT EXISTS shots(
  id TEXT PRIMARY KEY,
  subject TEXT,             -- 学科 id（english/math/cs/...）
  lesson_id TEXT,
  title TEXT,
  file TEXT,                -- data/shots/ 下的相对路径
  w INTEGER, h INTEGER,
  bytes INTEGER,
  tag TEXT,                 -- 来源：canvas（画布导出）/ screen（屏幕截取）/ file（选中文件）
  tags TEXT,                -- 标签，JSON 数组字符串；空就是没打标签
  ts TEXT
);
CREATE INDEX IF NOT EXISTS ix_shots_subject ON shots(subject, ts);
CREATE INDEX IF NOT EXISTS ix_shots_lesson ON shots(lesson_id);

-- AI 讲题的讲解留底。key 是「题源|ref|风格」，同一道题同一个风格只留最新一版，
-- 但每次生成都进 explain_log —— 前后说法不一致这件事要能查出来，不是靠记忆。
CREATE TABLE IF NOT EXISTS explain(
  k TEXT PRIMARY KEY,
  source TEXT,
  ref TEXT,
  style TEXT,
  body TEXT,          -- JSON：四段结构（定位/依据/判断/纠错）
  evidence TEXT,      -- JSON：依据快照（含每条 verified）
  confidence REAL,
  model TEXT,         -- 'local-evidence'（本机整理）或模型名
  verified INTEGER DEFAULT 0,   -- 依据是否全部通过复核
  votes_up INTEGER DEFAULT 0,
  votes_down INTEGER DEFAULT 0,
  ts TEXT,
  uid TEXT
);
CREATE INDEX IF NOT EXISTS ix_explain_ref ON explain(source, ref);

CREATE TABLE IF NOT EXISTS explain_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  ekey TEXT,
  source TEXT,
  ref TEXT,
  style TEXT,
  model TEXT,
  confidence REAL,
  verified INTEGER,
  body TEXT,
  uid TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_explainlog_uid ON explain_log(uid);
CREATE INDEX IF NOT EXISTS ix_explainlog_ref ON explain_log(source, ref, id);

-- 手动生词本：用户自己标的（跟「答错过的错词本」两回事，错词本是系统记的）
CREATE TABLE IF NOT EXISTS word_star(
  word TEXT PRIMARY KEY,
  ts TEXT,
  note TEXT
);
-- 收藏的例句（真卷原句，存原文和出处，不存生成的）
CREATE TABLE IF NOT EXISTS sent_fav(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  word TEXT,
  text TEXT,
  src TEXT,
  kind TEXT
);

-- 作文：原文、本机算的部分、模型判的部分，分别留底。
-- 分三列存是因为它们的可信度不一样 —— 词数和要点命中是数出来的，
-- 语言/文采是模型给的，模型说错要能单独改，不该把整篇重写一遍。
CREATE TABLE IF NOT EXISTS writings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pid TEXT,                    -- 作文题 id
  kind TEXT,                   -- 体裁（邀请信/通知/议论文…）
  essay TEXT,                  -- 学生原文，一个字不改
  local_json TEXT,             -- 本机算的：词数 / 要点命中 / 格式
  model_json TEXT,             -- 模型给的：维度分 / 总评 / 错误 / 建议
  model TEXT,                  -- 模型名；本机版写 'local'
  score REAL,                  -- 总分（模型没接就是 NULL，不填 0 冒充）
  uid TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_writings_uid ON writings(uid);
CREATE INDEX IF NOT EXISTS ix_writings_pid ON writings(pid, id);
"""


def now():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today():
    return dt.date.today().isoformat()


# --------------------------------------------------- 合并 / 覆盖时 proofreading
def connect(db_path=None):
    config.ensure_dirs()
    con = sqlite3.connect(db_path or config.DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init(db_path=None):
    con = connect(db_path)
    try:
        # 先补列再跑 schema：老库里 events 已经存在但没有 uid 列，直接跑新的
        # CREATE UNIQUE INDEX ... ON events(uid) 会报 no such column，整段失败。
        ensure_sync_columns(con)
        con.executescript(_SCHEMA)
        ensure_sync_columns(con)
        _backfill_answer_source(con)   # schema 落下来之后才谈得上回填
        con.commit()
    finally:
        con.close()


def ensure_sync_columns(con):
    """同步要用的附加结构 —— 已经存在的库也得能升上来，否则老机器上跑不了同步。
      events/answers/error_tags/exam_sessions 的 uid —— 每条记录的全球唯一身份，
        两台机器各记各的，合库时靠它去重；没有它同步就是把所有东西重插一遍。
      notes 的 alt_text/alt_ts —— 另一台机器改过同一条笔记时，把另一份留在这里，
        不静默覆盖；冲突要让你看得见、让你自己挑。

    补过的列再 ALTER 会报 duplicate column name，吞掉即可。
    """
    for t in ("events", "answers", "error_tags", "exam_sessions"):
        cols = {r["name"] for r in
                con.execute("PRAGMA table_info(%s)" % t).fetchall()}
        if cols and "uid" not in cols:
            try:
                con.execute("ALTER TABLE %s ADD COLUMN uid TEXT" % t)
            except sqlite3.Error:
                pass
            try:
                con.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_%s_uid ON %s(uid)"
                            % (t, t))
            except sqlite3.Error:
                pass
    # answers 的 source / subject：让五科作答进同一张表也能分清是谁的题。
    # 老库默认按 grammar780（以前唯一的题源）回填，历史数据不丢、不错归。
    acols = {r["name"] for r in con.execute("PRAGMA table_info(answers)").fetchall()}
    for c, ddl in (("source", "ALTER TABLE answers ADD COLUMN source TEXT"),
                   ("subject", "ALTER TABLE answers ADD COLUMN subject TEXT")):
        if acols and c not in acols:
            try:
                con.execute(ddl)
            except sqlite3.Error:
                pass
    # 全新库这时候还没有表（init 里这段跑在 executescript 之前），
    # 回填和索引都得等 schema 落下来再做；老库才现在就补。
    if acols:
        _backfill_answer_source(con)

    cols = {r["name"] for r in con.execute("PRAGMA table_info(notes)").fetchall()}
    for c, ddl in (("alt_text", "ALTER TABLE notes ADD COLUMN alt_text TEXT"),
                   ("alt_ts", "ALTER TABLE notes ADD COLUMN alt_ts TEXT")):
        if c not in cols:
            try:
                con.execute(ddl)
            except sqlite3.Error:
                pass

    # shots.tags —— 截图标签。老库里 shots 可能已经存在但没这一列，
    # 补上就行；表还不存在时 PRAGMA 返回空集，跳过（等 executescript 建表）。
    scols = {r["name"] for r in con.execute("PRAGMA table_info(shots)").fetchall()}
    if scols and "tags" not in scols:
        try:
            con.execute("ALTER TABLE shots ADD COLUMN tags TEXT")
        except sqlite3.Error:
            pass

    # shots.origin / pos_sec / src_path —— 素材库四类来源，见 docs/画布与课堂-开发文档.md 2.5。
    # origin 区分 frame（视频帧，带时间点）/ canvas（画布导出）/ upload / note（外部笔记里的图）。
    # 老行 origin 是 NULL，读的时候按 tag 推断（canvas→canvas、screen→frame、file→upload），
    # 不写回数据库 —— 迁移改错一次就回不去了，留在读的时候兜底更安全。
    for c, ddl in (("origin", "ALTER TABLE shots ADD COLUMN origin TEXT"),
                   ("pos_sec", "ALTER TABLE shots ADD COLUMN pos_sec REAL"),
                   ("src_path", "ALTER TABLE shots ADD COLUMN src_path TEXT")):
        if scols and c not in scols:
            try:
                con.execute(ddl)
            except sqlite3.Error:
                pass
    if scols:
        try:
            con.execute("CREATE INDEX IF NOT EXISTS ix_shots_origin ON shots(origin, ts)")
        except sqlite3.Error:
            pass

    # canvas_maps.lesson_ids —— 一张画布可以挂多讲。旧 lesson_id 留作「主讲次」，
    # 老数据、老备份、外部工具都还认得它。NULL 或 '[]' 表示没挂讲次。
    mcols = {r["name"] for r in con.execute("PRAGMA table_info(canvas_maps)").fetchall()}
    if mcols and "lesson_ids" not in mcols:
        try:
            con.execute("ALTER TABLE canvas_maps ADD COLUMN lesson_ids TEXT")
        except sqlite3.Error:
            pass


def _backfill_answer_source(con):
    """老库回填：以前 answers 里只有英语语法题库的作答，统一认成 grammar780。
    不这么做，升级后历史作答会在「按题源分组」里凭空消失。"""
    try:
        con.execute("UPDATE answers SET source='grammar780' WHERE source IS NULL"
                    " AND part IS NOT NULL")
        con.execute("UPDATE answers SET subject='english' WHERE subject IS NULL"
                    " AND source='grammar780'")
        con.execute("CREATE INDEX IF NOT EXISTS ix_answers_src ON answers(source)")
    except sqlite3.Error:
        # 空库/还没有 answers 表时这段没意义（init 会对新库再跑一次），静默跳过
        pass


# ---------------------------------------------------------------- 设备身份
def device_id():
    """本机身份证：一台机器一个，写进每个同步包，用来认「这条是哪台机器上发生的」。

    第一次调用时生成并存进 kv，之后一直复用；换机器就是新 id，不会撞。
    """
    did = kv_get("device_id")
    if did:
        return did
    did = "d-" + uuid.uuid4().hex[:12]
    kv_set("device_id", did)
    return did


def device_name():
    """给人看的设备名（界面显示用）。config 里没配就用主机名。"""
    return (config.SYNC_DEVICE_NAME or "").strip() or platform.node() or "本机"


def new_uid():
    """一条学习记录的全球唯一 id：设备 id + 时间 + 随机。

    有了它，两台机器各记各的，合在一起时靠 uid 去重 —— 同一条不会被记两遍，
    也不会因为「两边都删过又加回来」把对方的数据吃掉。
    """
    return "%s-%s-%s" % (device_id(),
                         dt.datetime.now().strftime("%Y%m%d%H%M%S"),
                         uuid.uuid4().hex[:6])


# ---------------------------------------------------------------- events
def add_event(kind, subject=None, lesson_id=None, word=None, part=None,
              qno=None, ok=None, seconds=0, payload=None, uid=None, ts=None):
    """记一条学习动作。uid 是同步用的稳定身份，外面没给就现场生成一个。"""
    con = connect()
    try:
        con.execute(
            "INSERT INTO events(ts,kind,subject,lesson_id,word,part,qno,ok,seconds,payload,uid)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (ts or now(), kind, subject, lesson_id, word, part, qno,
             None if ok is None else int(bool(ok)), float(seconds or 0),
             None if payload is None else str(payload), uid or new_uid()))
        con.commit()
    finally:
        con.close()


def recent_events(limit=20):
    con = connect()
    try:
        rows = con.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def events_today(kinds=None):
    con = connect()
    try:
        sql = "SELECT * FROM events WHERE substr(ts,1,10)=?"
        args = [today()]
        if kinds:
            sql += " AND kind IN (%s)" % ",".join("?" * len(kinds))
            args += list(kinds)
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def counts_by_part(kind):
    """按 kind 统计事件（如 exam_answer → 每套卷已答题数）。"""
    con = connect()
    try:
        return {r["part"]: r["c"] for r in con.execute(
            "SELECT part, COUNT(*) c FROM events WHERE kind=? AND part IS NOT NULL"
            " GROUP BY part", (kind,)).fetchall()}
    finally:
        con.close()


def exam_state_all():
    """{paper_id: {题号: 1 对 / 0 错}}，来自本机真实作答。"""
    out = {}
    con = connect()
    try:
        rows = con.execute(
            "SELECT part, qno, ok FROM events WHERE kind='exam_answer'"
            " AND part IS NOT NULL AND qno IS NOT NULL").fetchall()
    finally:
        con.close()
    for r in rows:
        out.setdefault(r["part"], {})[int(r["qno"])] = r["ok"]
    return out


def learning_seconds():
    """真实投入时长（秒）：只汇总事件里真的带了秒数的那些。

    play       = 看视频的真实秒数（前端每 10 秒上报一次实看时长）
    exam_tick  = 考场计时的真实秒数
    没有秒数的事件（切页、翻卡、判分）不算进时长——那是动作数，不是时间。
    """
    con = connect()
    try:
        r = con.execute(
            "SELECT SUM(seconds) s FROM events WHERE kind IN ('play','exam_tick')"
        ).fetchone()
        t = con.execute(
            "SELECT SUM(seconds) s FROM events WHERE kind IN ('play','exam_tick')"
            " AND substr(ts,1,10)=?", (today(),)).fetchone()
        by_kind = {x["kind"]: (x["s"] or 0) for x in con.execute(
            "SELECT kind, SUM(seconds) s FROM events WHERE kind IN ('play','exam_tick')"
            " GROUP BY kind").fetchall()}
        return {"total": round(r["s"] or 0, 1), "today": round(t["s"] or 0, 1),
                "by_kind": {k: round(v, 1) for k, v in by_kind.items()}}
    finally:
        con.close()


def play_seconds_of(lesson_id):
    """某一讲真实看过的秒数（本机记录的，没看过 = 0，不按课程时长估算）。"""
    con = connect()
    try:
        r = con.execute(
            "SELECT SUM(seconds) s FROM events WHERE kind='play' AND lesson_id=?",
            (lesson_id,)).fetchone()
        return round(r["s"] or 0, 1)
    finally:
        con.close()


def lesson_play_rows(limit=8):
    """看过的讲次各看了多少秒（有真实秒数的才列出来）。"""
    con = connect()
    try:
        return [{"lesson_id": x["lesson_id"], "seconds": round(x["s"] or 0, 1),
                 "last_ts": x["mx"]}
                for x in con.execute(
                    "SELECT lesson_id, SUM(seconds) s, MAX(ts) mx FROM events"
                    " WHERE kind='play' AND lesson_id IS NOT NULL AND seconds>0"
                    " GROUP BY lesson_id ORDER BY s DESC LIMIT ?", (limit,)).fetchall()]
    finally:
        con.close()


def last_7d_minutes():
    """最近 7 天每天的学习分钟（按 events.seconds 汇总，真实值，没记就是 0）。"""
    con = connect()
    try:
        rows = con.execute(
            "SELECT substr(ts,1,10) d, SUM(seconds) s FROM events"
            " GROUP BY d ORDER BY d DESC LIMIT 7").fetchall()
        return {r["d"]: round((r["s"] or 0) / 60.0, 1) for r in rows}
    finally:
        con.close()


# ---------------------------------------------------------------- word_mem
def get_mem(word):
    con = connect()
    try:
        r = con.execute("SELECT * FROM word_mem WHERE word=?", (word,)).fetchone()
        return dict(r) if r else None
    finally:
        con.close()


def all_mem():
    con = connect()
    try:
        return {r["word"]: dict(r)
                for r in con.execute("SELECT * FROM word_mem").fetchall()}
    finally:
        con.close()


# 旧工作台 progress.json 的那份词进度是**批量填充的演示数据**：
# xuecheng 84 条全是 box=1 / seen=1 / due=2026-10-17，top500 3 条日期全过期。
# 它们既没有对错、也没有任何真实练习痕迹，直接当「已背过」种进来，
# 就会凭空造出 86 个到期复习（还混进 1 个词表里根本没有的孤儿词）。
# 所以：**不种**。要背的词等你真背了才进 word_mem，一个数字都不编。
def import_legacy_mem(pairs):
    """旧格式词进度不再导入记忆库，只留一条事件说明为什么没导。

    真源始终是 SQLite 里由 grade_word 写出来的记录。
    """
    n = len([1 for w, v in (pairs or []) if w and isinstance(v, dict)])
    if n:
        add_event("legacy_skip", payload="progress.json 里 %d 条词进度是演示填充数据，不导入记忆库" % n)
    return 0


def grade_word(word, ok, fuzzy=False):
    """SM-2 简化版：对了升一档，错了打回 box1。返回新的记忆状态。

    fuzzy=True 是「自评：模糊」这一档 —— 人没答错，只是说不准。
    所以它既不记 right 也不记 wrong（不该进错词本），但间隔压到最短档，
    明天就回来：这种"好像见过但想不起来"的词，最需要的就是马上再见一面。
    """
    con = connect()
    try:
        r = con.execute("SELECT * FROM word_mem WHERE word=?", (word,)).fetchone()
        box = int(r["box"]) if r else 0
        seen = int(r["seen"]) if r else 0
        right = int(r["right"]) if r else 0
        wrong = int(r["wrong"]) if r else 0
        if fuzzy:
            box = 1
        else:
            box = min(box + 1, len(config.SM2_INTERVALS) - 1) if ok else 1
        seen += 1
        if fuzzy:
            pass
        elif ok:
            right += 1
        else:
            wrong += 1
        # 不认识 / 模糊 —— 当天就要再见一次，不能推到明天。
        # 以前这里一律按 SM2_INTERVALS[box] 后推，答错的词 box=1 → 隔 1 天，
        # 结果「当天再抽一次」永远抽不到，复习队列当天就空了。
        # 现在的口径：认了才真正排期，没认就 due=今天，本轮里反复回来直到答对。
        if not ok and not fuzzy:
            due = dt.date.today().isoformat()
        elif fuzzy:
            due = dt.date.today().isoformat()
        else:
            days = config.SM2_INTERVALS[min(box, len(config.SM2_INTERVALS) - 1)]
            due = (dt.date.today() + dt.timedelta(days=days)).isoformat()
        con.execute(
            "INSERT INTO word_mem(word,box,due,seen,right,wrong,last_ts)"
            " VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(word) DO UPDATE SET box=?,due=?,seen=?,right=?,wrong=?,last_ts=?",
            (word, box, due, seen, right, wrong, now(),
             box, due, seen, right, wrong, now()))
        con.commit()
        return {"word": word, "box": box, "due": due, "seen": seen,
                "right": right, "wrong": wrong}
    finally:
        con.close()


# 只有**真的作答过**的词才算到期复习。
# 旧工作台那份 progress.json 里有 84 条 box=1/seen=1/due 完全相同的批量填充数据，
# 它们既没对错也没真实练习记录，拿它们拼「今日到期 86 个」就是编数字。
# 判据：right+wrong>0（真判过对错），或者 last_ts 不是 legacy 来源。
REAL_MEM_SQL = "((right+wrong)>0 OR (last_ts IS NOT NULL AND last_ts NOT LIKE 'legacy%'))"


def due_words(limit=None):
    t = today()
    con = connect()
    try:
        sql = ("SELECT word, box, due FROM word_mem WHERE due<=? AND "
               + REAL_MEM_SQL + " ORDER BY due, box")
        args = [t]
        if limit:
            sql += " LIMIT ?"
            args.append(int(limit))
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def mem_stats():
    con = connect()
    try:
        # 入记忆 = 真正练过的词。legacy 批量填充的 84 条不算，否则首页永远写着「入记忆 152 词」
        n = con.execute("SELECT COUNT(*) c FROM word_mem WHERE " + REAL_MEM_SQL).fetchone()["c"]
        d = con.execute("SELECT COUNT(*) c FROM word_mem WHERE due<=? AND " + REAL_MEM_SQL,
                        (today(),)).fetchone()["c"]
        boxes = {r["box"]: r["c"] for r in con.execute(
            "SELECT box, COUNT(*) c FROM word_mem GROUP BY box").fetchall()}
        return {"words": n, "due_today": d, "boxes": boxes}
    finally:
        con.close()


# ------------------------------------------------------- 今日复习队列（到期闭环）
def review_queue(limit=None):
    """今天到期要复习的词 → 拼上行课表里的音标/词性/释义，能直接喂给卡片。

    真源两张表：
      word_mem   —— 谁到期了（due<=今天，越早到期、档位越低的先来）
      vocab.groups_words —— 这个词的音标词性释义在哪一组里（没有就只给词形）
    这样“今天到期 N 个”不是一个孤零零的数字，点进去就是能翻的一组卡。
    """
    con = connect()
    try:
        sql = ("SELECT word, box, due, seen, right, wrong FROM word_mem"
               " WHERE due<=? ORDER BY due, box, word")
        args = [today()]
        if limit:
            sql += " LIMIT ?"
            args.append(int(limit))
        rows = [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()
    return rows


def review_enriched(limit=None):
    """到期词 + 词条信息（音标/词性/释义/所属词组）。查不到词条的照实留空。"""
    rows = review_queue(limit)
    p = _proto()
    gw = (p.get("vocab") or {}).get("groups_words") or {}
    idx = {}
    for key, arr in gw.items():
        for w in arr:
            idx.setdefault(w.get("w"), (key, w))
    out = []
    for r in rows:
        key, w = idx.get(r["word"], (None, None))
        out.append({
            "w": r["word"], "box": r["box"], "due": r["due"],
            "seen": r["seen"], "right": r["right"], "wrong": r["wrong"],
            "ph": (w or {}).get("ph") or "", "pos": (w or {}).get("pos") or "",
            "cn": (w or {}).get("cn") or "", "group": key,
            # 旧进度里导进来的词可能不在现在的行课词表上：没有音标/释义/例句，
            # 摆出来只能是个空卡，复习不了。照实标出来，不拿假释义填。
            "orphan": not (w or {}).get("cn"),
        })
    return out


def _proto():
    """延迟导入 datahub，store 里不写死业务数据依赖。"""
    try:
        from . import datahub
    except ImportError:      # 直接以模块方式 import 时（tests/脚本）走绝对导入
        import datahub
    return datahub.proto()


def checkin_days(limit=70):
    """打卡日历：哪天真的背过词、各背了几个词/对几个。

    只认 events 里 kind='grade_word' 的记录 —— 打开页面不算，翻卡不算，
    真点了才算。这一天「背过」的判定就是当天有过一次作答。"""
    con = connect()
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT substr(ts,1,10) d,"
            " COUNT(*) n,"
            " SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok,"
            " COUNT(DISTINCT word) words"
            " FROM events WHERE kind='grade_word' AND word IS NOT NULL"
            " GROUP BY d ORDER BY d DESC LIMIT ?", (int(limit),)).fetchall()]
    finally:
        con.close()
    out = {}
    for r in rows:
        r["ok"] = int(r["ok"] or 0)
        out[r["d"]] = r
    return out


def checkin_streak():
    """连续打卡天数：从今天或昨天往回数，断一天就重来。"""
    days = set(checkin_days(400).keys())
    if not days:
        return {"streak": 0, "today": False, "last": None}
    import datetime as _dt
    base = _dt.date.today()
    if base.isoformat() not in days:
        base = base - _dt.timedelta(days=1)
        if base.isoformat() not in days:
            last = max(days)
            return {"streak": 0, "today": False, "last": last}
    n = 0
    while base.isoformat() in days:
        n += 1
        base = base - _dt.timedelta(days=1)
    return {"streak": n, "today": dt.date.today().isoformat() in days,
            "last": max(days)}


# ------------------------------------------------------------- 生词本 / 收藏
def star_word(word, note=None, on=True):
    con = connect()
    try:
        if on:
            con.execute(
                "INSERT INTO word_star(word,ts,note) VALUES(?,?,?)"
                " ON CONFLICT(word) DO UPDATE SET ts=?,note=?",
                (word, now(), note, now(), note))
        else:
            con.execute("DELETE FROM word_star WHERE word=?", (word,))
        con.commit()
        n = con.execute("SELECT COUNT(*) c FROM word_star").fetchone()["c"]
    finally:
        con.close()
    return {"word": word, "starred": bool(on), "count": n}


def list_star(limit=200):
    con = connect()
    try:
        return [dict(r) for r in con.execute(
            "SELECT word, ts, note FROM word_star ORDER BY ts DESC LIMIT ?",
            (int(limit),)).fetchall()]
    finally:
        con.close()


def fav_sentence(word, text, src=None, kind=None, on=True):
    con = connect()
    try:
        if on:
            row = con.execute(
                "SELECT id FROM sent_fav WHERE word=? AND text=?",
                (word, text)).fetchone()
            if not row:
                con.execute(
                    "INSERT INTO sent_fav(ts,word,text,src,kind) VALUES(?,?,?,?,?)",
                    (now(), word, text, src, kind))
        else:
            con.execute("DELETE FROM sent_fav WHERE word=? AND text=?",
                        (word, text))
        con.commit()
        n = con.execute("SELECT COUNT(*) c FROM sent_fav").fetchone()["c"]
    finally:
        con.close()
    return {"word": word, "faved": bool(on), "saved": bool(on), "count": n}


def list_fav(limit=100):
    con = connect()
    try:
        return [dict(r) for r in con.execute(
            "SELECT id, ts, word, text, src, kind FROM sent_fav"
            " ORDER BY id DESC LIMIT ?", (int(limit),)).fetchall()]
    finally:
        con.close()


# ------------------------------------------------------------ lesson_progress
def set_lesson(lesson_id, subject=None, status=None, pos_sec=None):
    con = connect()
    try:
        r = con.execute("SELECT * FROM lesson_progress WHERE lesson_id=?",
                        (lesson_id,)).fetchone()
        st = status or (r["status"] if r else "doing")
        pos = float(pos_sec) if pos_sec is not None else (r["pos_sec"] if r else 0)
        sub = subject or (r["subject"] if r else None)
        con.execute(
            "INSERT INTO lesson_progress(lesson_id,subject,status,pos_sec,updated_ts)"
            " VALUES(?,?,?,?,?) ON CONFLICT(lesson_id) DO UPDATE SET"
            " subject=?,status=?,pos_sec=?,updated_ts=?",
            (lesson_id, sub, st, pos, now(), sub, st, pos, now()))
        con.commit()
        return {"lesson_id": lesson_id, "subject": sub, "status": st, "pos_sec": pos}
    finally:
        con.close()


def get_lesson(lesson_id):
    con = connect()
    try:
        r = con.execute("SELECT * FROM lesson_progress WHERE lesson_id=?",
                        (lesson_id,)).fetchone()
        return dict(r) if r else None
    finally:
        con.close()


def recent_lesson(subject=None):
    """这个科目里最近动过、还没做完的那一讲。

    为什么需要它：用户点目录切讲次走的是 pick_lesson → set_lesson，只写这张表。
    以前 get_current_lesson 只认 derive_next 推出来的「下一讲」，
    于是点别的 P 界面纹丝不动 —— 用户说的「点其他 P 没用」就是这个：
    库写进去了，界面没读。

    取 status != 'done'：做完的不能再当「当前这一讲」。
    取 updated_ts 最新：pick / 播放 / 截帧都算「人在这一讲上」，取最近的那条。
    """
    con = connect()
    try:
        sql = ("SELECT * FROM lesson_progress"
               " WHERE status != 'done' AND lesson_id IS NOT NULL AND lesson_id != ''")
        args = []
        if subject:
            sql += " AND subject=?"
            args.append(subject)
        sql += " ORDER BY updated_ts DESC LIMIT 1"
        r = con.execute(sql, args).fetchone()
        return dict(r) if r else None
    finally:
        con.close()


def lessons_done(subject=None):
    con = connect()
    try:
        sql = "SELECT * FROM lesson_progress WHERE status='done'"
        args = []
        if subject:
            sql += " AND subject=?"
            args.append(subject)
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


# ---------------------------------------------------------------- answers
def add_answer(qno, part, chosen, ans, ok, uid=None, ts=None,
               source=None, subject=None):
    con = connect()
    try:
        con.execute(
            "INSERT INTO answers(ts,qno,part,chosen,ans,ok,uid,source,subject)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (ts or now(), int(qno), part, chosen, ans, int(bool(ok)),
             uid or new_uid(), source, subject))
        con.commit()
    finally:
        con.close()


def source_stats():
    """按题源统计本机真实作答：做过几道、对几道、错几道。没有记录就是 0。"""
    con = connect()
    try:
        rows = con.execute(
            "SELECT COALESCE(source,'grammar780') src, COUNT(*) n,"
            " SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok"
            " FROM answers GROUP BY src").fetchall()
        return [{"source": r["src"], "done": r["n"], "right": r["ok"] or 0,
                 "wrong": r["n"] - (r["ok"] or 0)} for r in rows]
    finally:
        con.close()


def error_by_part():
    """错因归因真源：每个考点做过多少、错多少。没有记录就是空，不编数字。"""
    con = connect()
    try:
        rows = con.execute(
            "SELECT part, COUNT(*) n, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) wrong"
            " FROM answers GROUP BY part ORDER BY wrong DESC").fetchall()
        return [{"part": r["part"], "done": r["n"], "wrong": r["wrong"] or 0}
                for r in rows]
    finally:
        con.close()


def answer_stats():
    con = connect()
    try:
        r = con.execute(
            "SELECT COUNT(*) n, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok FROM answers"
        ).fetchone()
        n = r["n"] or 0
        ok = r["ok"] or 0
        return {"answered": n, "right": ok, "wrong": n - ok,
                "accuracy": (round(ok * 100.0 / n, 1) if n else None)}
    finally:
        con.close()


def answered_qnos():
    con = connect()
    try:
        return {r["qno"]: r["ok"] for r in con.execute(
            "SELECT qno, MAX(ok) ok FROM answers GROUP BY qno").fetchall()}
    finally:
        con.close()


def answered_by_source(source):
    """某一个题源里做过哪些题、对没对 —— 按题号给，不按库里的全局题号。

    AI 生成的题跟真题是分表存的，题号只在自己那个题源里有意义；
    拿全局 answered_qnos 去套，会把「别的题源里刚好同号的那道题」的战绩
    算到它头上（当堂测切回来看见「这题做过了」其实是另一道题）。"""
    if not source:
        return {}
    con = connect()
    try:
        return {int(r["qno"]): int(r["ok"]) for r in con.execute(
            "SELECT qno, MAX(ok) ok FROM answers WHERE source=? GROUP BY qno",
            (str(source),)).fetchall()}
    finally:
        con.close()


def weak_parts(subject=None, limit=8, min_n=2):
    """按「题源 + 分组」聚合真作答，找出错得最多的那几块。

    只算 answers 表里真有的行 —— 一行就是一次真作答，没有推算。
    样本小于 min_n 的不进榜：错 1 次占 100% 的东西不叫弱项，叫噪声。
    """
    con = connect()
    try:
        sql = ("SELECT COALESCE(source,'') src, COALESCE(part,'') part,"
               " COUNT(*) n, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok,"
               " MAX(ts) last FROM answers")
        args = []
        if subject:
            sql += " WHERE subject=?"
            args.append(subject)
        sql += " GROUP BY src, part HAVING n >= ?"
        args += [int(min_n or 2)]
        sql += " ORDER BY (n - COALESCE(ok,0)) DESC, n DESC LIMIT ?"
        args.append(int(limit or 8))
        rows = con.execute(sql, args).fetchall()
    finally:
        con.close()
    out = []
    for r in rows:
        n = r["n"] or 0
        ok = r["ok"] or 0
        out.append({"source": r["src"], "part": r["part"],
                    "label": (r["part"] or r["src"] or "未分组"),
                    "total": n, "right": ok, "wrong": n - ok,
                    "accuracy": (round(ok * 100.0 / n, 1) if n else None),
                    "last": r["last"]})
    return out


# ---------------------------------------------------------------- tool_calls
def log_tool(name, perm, args, ok, ms, note=None):
    con = connect()
    try:
        con.execute(
            "INSERT INTO tool_calls(ts,name,perm,args,ok,ms,note) VALUES(?,?,?,?,?,?,?)",
            (now(), name, perm, None if args is None else str(args),
             int(bool(ok)), int(ms), note))
        con.commit()
        con.execute("DELETE FROM tool_calls WHERE id NOT IN"
                    " (SELECT id FROM tool_calls ORDER BY id DESC LIMIT 200)")
        con.commit()
    finally:
        con.close()


def recent_tool_calls(limit=12):
    con = connect()
    try:
        return [dict(r) for r in con.execute(
            "SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]
    finally:
        con.close()


def tool_call_counts():
    con = connect()
    try:
        return {r["name"]: r["c"] for r in con.execute(
            "SELECT name, COUNT(*) c FROM tool_calls GROUP BY name").fetchall()}
    finally:
        con.close()


# ---------------------------------------------------------------- 笔记（E1）
def save_note(lesson_id, text, pos_sec=0):
    if not lesson_id:
        return {"error": "没指定讲次"}
    con = connect()
    try:
        con.execute(
            "INSERT INTO notes(lesson_id,text,pos_sec,updated_ts) VALUES(?,?,?,?)"
            " ON CONFLICT(lesson_id) DO UPDATE SET text=?,pos_sec=?,updated_ts=?",
            (lesson_id, text or "", float(pos_sec or 0), now(),
             text or "", float(pos_sec or 0), now()))
        con.commit()
        r = con.execute("SELECT * FROM notes WHERE lesson_id=?", (lesson_id,)).fetchone()
        return dict(r)
    finally:
        con.close()


def get_note(lesson_id):
    if not lesson_id:
        return None
    con = connect()
    try:
        r = con.execute("SELECT * FROM notes WHERE lesson_id=?", (lesson_id,)).fetchone()
        return dict(r) if r else None
    finally:
        con.close()


def note_count():
    con = connect()
    try:
        return con.execute("SELECT COUNT(*) c FROM notes").fetchone()["c"]
    finally:
        con.close()


# ---------------------------------------------------------------- 笔记画布（canvas）
def save_canvas(map_id, title=None, tree=None, lesson_id=None, src="local",
                src_id=None, lesson_ids=None):
    """整个画布一次写完。tree 是节点树（dict），本机不解析它，只原样存。

    lesson_ids：挂到哪几讲（列表）。画布是「笔记」，一张笔记可以同时属于
    好几讲；lesson_id 保留为主讲次（列表里排第一的那个），旧代码还在读它。
    lesson_ids 传 None 表示「这次不改」，传 [] 表示「明确清空」—— 两者不能混。
    """
    if not map_id:
        return {"error": "没给画布 ID"}
    ids_s = None
    if lesson_ids is not None:
        ids = [x for x in (lesson_ids or []) if x]
        ids_s = json.dumps(ids, ensure_ascii=False) if ids else "[]"
        if ids and not lesson_id:
            lesson_id = ids[0]
    con = connect()
    try:
        if ids_s is None:
            con.execute(
                "INSERT INTO canvas_maps(id,lesson_id,title,src,src_id,tree,updated_ts)"
                " VALUES(?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET lesson_id=?, title=?, src=?, src_id=?,"
                " tree=?, updated_ts=?",
                (map_id, lesson_id, title, src, src_id,
                 json.dumps(tree, ensure_ascii=False), now(),
                 lesson_id, title, src, src_id,
                 json.dumps(tree, ensure_ascii=False), now()))
        else:
            con.execute(
                "INSERT INTO canvas_maps(id,lesson_id,lesson_ids,title,src,src_id,"
                "tree,updated_ts) VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET lesson_id=?, lesson_ids=?, title=?,"
                " src=?, src_id=?, tree=?, updated_ts=?",
                (map_id, lesson_id, ids_s, title, src, src_id,
                 json.dumps(tree, ensure_ascii=False), now(),
                 lesson_id, ids_s, title, src, src_id,
                 json.dumps(tree, ensure_ascii=False), now()))
        con.commit()
        r = con.execute("SELECT * FROM canvas_maps WHERE id=?", (map_id,)).fetchone()
        d = dict(r)
        d["lesson_ids"] = _lesson_ids_of(d)
        return d
    finally:
        con.close()


def get_canvas(map_id):
    if not map_id:
        return None
    con = connect()
    try:
        r = con.execute("SELECT * FROM canvas_maps WHERE id=?", (map_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        try:
            d["tree"] = json.loads(d.get("tree") or "{}")
        except ValueError:
            d["tree"] = {}
        return d
    finally:
        con.close()


def save_shot(shot_id, subject, file, title=None, lesson_id=None,
              w=None, h=None, nbytes=None, tag="canvas", ts=None,
              origin=None, pos_sec=None, src_path=None):
    """一张截图的元数据。真正的 png 已经由调用方写进 data/shots/ 了，这里只记账。

    origin：这张图从哪来 —— frame（视频截帧）/ canvas（画布导出）/
    upload（用户上传）/ note（外部笔记里的）。pos_sec 只有 frame 才有，
    是视频里的秒数，用来在进度条上打点、跳回去重看。
    """
    if not shot_id or not file:
        return {"error": "截图要 id 和文件路径"}
    con = connect()
    try:
        con.execute(
            "INSERT INTO shots(id,subject,lesson_id,title,file,w,h,bytes,tag,ts,"
            "origin,pos_sec,src_path)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET subject=?, lesson_id=?, title=?, file=?,"
            " w=?, h=?, bytes=?, tag=?, ts=?, origin=?, pos_sec=?, src_path=?",
            (shot_id, subject, lesson_id, title, file, w, h, nbytes, tag, ts or now(),
             origin, pos_sec, src_path,
             subject, lesson_id, title, file, w, h, nbytes, tag, ts or now(),
             origin, pos_sec, src_path))
        con.commit()
        r = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
        d = dict(r)
        if not d.get("origin"):
            d["origin"] = {"screen": "frame", "file": "upload"}.get(
                d.get("tag"), "canvas")
        return d
    finally:
        con.close()


def _tags_of(raw):
    """库里的 tags 是 JSON 数组字符串，读出来还原成 list。
    坏数据（手改过、旧版本写坏）当成没标签，不让它把整页崩掉。"""
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except Exception:
        return []
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if str(x).strip()]


def rename_shot(shot_id, title):
    """改名。只改 title，不动文件、不动 ts —— 改名不是重新截一张。
    title 传空等于清掉名字，前端会退回显示「未命名」。"""
    if not shot_id:
        return None
    con = connect()
    try:
        con.execute("UPDATE shots SET title=? WHERE id=?",
                    ((title or "").strip() or None, shot_id))
        con.commit()
        r = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["url"] = "/shots/" + (d.get("file") or "").replace("\\", "/")
        d["tags"] = _tags_of(d.get("tags"))
        return d
    finally:
        con.close()


def tag_shot(shot_id, tags):
    """写标签。传进来的是**完整**的标签数组（前端负责加减），
    不是增量 —— 这样两个人同时改也不会互相插一条进去。
    去重、去空、单条最长 20 字，最多 12 个，防止把标签当备注写。"""
    if not shot_id:
        return None
    clean, seen = [], set()
    for t in (tags or []):
        t = str(t).strip()[:20]
        if not t:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        clean.append(t)
        if len(clean) >= 12:
            break
    con = connect()
    try:
        con.execute("UPDATE shots SET tags=? WHERE id=?",
                    (json.dumps(clean, ensure_ascii=False) if clean else None, shot_id))
        con.commit()
        r = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["url"] = "/shots/" + (d.get("file") or "").replace("\\", "/")
        d["tags"] = _tags_of(d.get("tags"))
        return d
    finally:
        con.close()


def all_shot_tags(subject=None):
    """这个库里出现过的所有标签 + 各占几张。前端做标签筛选要它。"""
    rows = list_shots(subject=subject, limit=100000)
    cnt = {}
    for r in rows:
        for t in (r.get("tags") or []):
            cnt[t] = cnt.get(t, 0) + 1
    return sorted([{"tag": k, "n": v} for k, v in cnt.items()],
                  key=lambda x: (-x["n"], x["tag"]))


def get_shot(shot_id):
    if not shot_id:
        return None
    con = connect()
    try:
        r = con.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
        return dict(r) if r else None
    finally:
        con.close()


def list_shots(subject=None, lesson_id=None, limit=200, q=None, origin=None):
    """列截图。按学科 / 讲次 / 来源筛（不传就是全部），新的在前。
    每行给出 url（前端直接当 img src 用），省得每个调用点自己拼。
    q 是关键词：同时搜标题和讲次 id，大小写不敏感 —— 图一多就得能找。

    origin：frame（视频截帧）/ canvas（画布导出）/ upload（用户上传）/ note（外部笔记）。
    老行的 origin 是 NULL（迁移 002 之前存的），读时按 tag 推断，不写回数据库 ——
    迁移一次改错就回不去了，读时兜底最安全。
    """
    con = connect()
    try:
        sql = "SELECT * FROM shots WHERE 1=1"
        args = []
        if subject:
            sql += " AND subject=?"
            args.append(subject)
        if lesson_id:
            sql += " AND lesson_id=?"
            args.append(lesson_id)
        if origin:
            sql += " AND coalesce(origin, CASE tag WHEN 'screen' THEN 'frame'"\
                   " WHEN 'file' THEN 'upload' ELSE 'canvas' END)=?"
            args.append(origin)
        if q:
            sql += (" AND (lower(coalesce(title,'')) LIKE ?"
                    " OR lower(coalesce(lesson_id,'')) LIKE ?"
                    " OR lower(coalesce(tags,'')) LIKE ?)")
            like = "%" + str(q).lower() + "%"
            args.append(like)
            args.append(like)
            args.append(like)
        sql += " ORDER BY ts DESC, id DESC LIMIT ?"
        args.append(int(limit or 200))
        rows = [dict(r) for r in con.execute(sql, args).fetchall()]
        for r in rows:
            r["url"] = "/shots/" + (r.get("file") or "").replace("\\", "/")
            r["tags"] = _tags_of(r.get("tags"))
            if not r.get("origin"):
                r["origin"] = {"screen": "frame", "file": "upload"}.get(
                    r.get("tag"), "canvas")
        return rows
    finally:
        con.close()


def shot_count(subject=None):
    con = connect()
    try:
        if subject:
            return con.execute("SELECT COUNT(*) c FROM shots WHERE subject=?",
                               (subject,)).fetchone()["c"]
        return con.execute("SELECT COUNT(*) c FROM shots").fetchone()["c"]
    finally:
        con.close()


def del_shot(shot_id):
    """只删账，不删盘上的图 —— 万一是同一张图被两处引用，
    删文件会让另一处变坏图。真要清盘另开清理。"""
    if not shot_id:
        return 0
    con = connect()
    try:
        cur = con.execute("DELETE FROM shots WHERE id=?", (shot_id,))
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def list_canvas(lesson_id=None, src=None, limit=100):
    """列画布。只交摘要（不交整棵树）——列表页要的是「有几张、最后改的啥时候」，
    树太大，塞进列表会把页面撑爆。

    lesson_ids：一张画布可以挂多讲（迁移 001）。旧行的 lesson_id 是「主讲次」，
    lesson_ids 为空时读它就等于只有一讲 —— 向后兼容，不写回数据库。
    """
    con = connect()
    try:
        sql = ("SELECT id,lesson_id,lesson_ids,title,src,src_id,updated_ts"
               " FROM canvas_maps")
        w, a = [], []
        if lesson_id:
            # 主讲次匹配，或 (落库晚的) 多讲数组里含它。
            # 用 LIKE 而不是 json1 的 json_each：本机 python 自带 sqlite 不一定编了 json1。
            w.append("(lesson_id=? OR (lesson_ids IS NOT NULL"
                     " AND lesson_ids LIKE ?))")
            a.append(lesson_id)
            # 这里原来写的是 '%"%%s"%' 风格的格式串，`%"` 被 python 当成格式符，
            # 直接抛 ValueError: unsupported format character '"'。
            # 后果不是报错弹窗 —— 是 note_list(lesson_id) 整条路挂掉，
            # 课堂右栏永远显示「这一讲还没有笔记」，人以为笔记没存进去。
            a.append('"' + lesson_id + '"')
        if src:
            w.append("src=?"); a.append(src)
        if w:
            sql += " WHERE " + " AND ".join(w)
        sql += " ORDER BY updated_ts DESC LIMIT ?"
        a.append(limit)
        rows = [dict(r) for r in con.execute(sql, a).fetchall()]
        for r in rows:
            r["lesson_ids"] = _lesson_ids_of(r)
        return rows
    finally:
        con.close()


def _lesson_ids_of(row):
    """多讲数组。空数组时退回主讲次那一讲 —— 不编、不补。"""
    raw = row.get("lesson_ids")
    ids = []
    if raw:
        try:
            ids = [x for x in json.loads(raw) if x]
        except Exception:
            ids = []
    if not ids and row.get("lesson_id"):
        ids = [row["lesson_id"]]
    return ids


def del_canvas(map_id):
    """删一张画布（只删库里的记录，不碰任何文件 —— 画布只有树，没有附件）。
    返回删掉的行数：0 表示本来就没有这一条，界面照实说「没有这一条」。"""
    con = connect()
    try:
        cur = con.execute("DELETE FROM canvas_maps WHERE id=?", (map_id,))
        con.commit()
        return cur.rowcount or 0
    finally:
        con.close()


def canvas_count():
    con = connect()
    try:
        return con.execute("SELECT COUNT(*) c FROM canvas_maps").fetchone()["c"]
    finally:
        con.close()


# ---------------------------------------------------------------- AI 讲题（explain）
def _uid():
    """记录的全球唯一身份：两台机器各自生成也不会撞，合并时靠它去重。"""
    return uuid.uuid4().hex


def save_explain(source, ref, style, body, evidence, confidence, model,
                 verified=False):
    """存一版讲解。

    两件事同时做，缺一不可：
      explain      同一题同一风格只留最新一版（界面上看到的就是这个）
      explain_log  每次生成都留一条（用来查「同一道题前后说法不一致」）
    留底的意义不在于省事，在于能推翻：学生点「讲错了」，得能捞到当时到底说了什么。
    """
    ekey = "%s|%s|%s" % (source, ref, style)
    ts = now()
    uid = _uid()
    body_s = json.dumps(body, ensure_ascii=False)
    ev_s = json.dumps(evidence, ensure_ascii=False)
    con = connect()
    try:
        con.execute(
            "INSERT INTO explain(k,source,ref,style,body,evidence,confidence,"
            "model,verified,votes_up,votes_down,ts,uid)"
            " VALUES(?,?,?,?,?,?,?,?,?,0,0,?,?)"
            " ON CONFLICT(k) DO UPDATE SET body=?,evidence=?,confidence=?,"
            "model=?,verified=?,ts=?,uid=?,"
            " votes_up=explain.votes_up,votes_down=explain.votes_down",
            (ekey, source, ref, style, body_s, ev_s, float(confidence or 0),
             model, int(bool(verified)), ts, uid,
             body_s, ev_s, float(confidence or 0), model, int(bool(verified)),
             ts, uid))
        con.execute(
            "INSERT INTO explain_log(ts,ekey,source,ref,style,model,confidence,"
            "verified,body,uid) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (ts, ekey, source, ref, style, model, float(confidence or 0),
             int(bool(verified)), body_s, _uid()))
        con.commit()
        r = con.execute("SELECT * FROM explain WHERE k=?", (ekey,)).fetchone()
        return _explain_row(r)
    finally:
        con.close()


def _explain_row(r):
    if not r:
        return None
    d = dict(r)
    for k in ("body", "evidence"):
        try:
            d[k] = json.loads(d.get(k) or "null")
        except (ValueError, TypeError):
            d[k] = None
    return d


def get_explain(source, ref, style="standard"):
    con = connect()
    try:
        r = con.execute("SELECT * FROM explain WHERE k=?",
                        ("%s|%s|%s" % (source, ref, style),)).fetchone()
        return _explain_row(r)
    finally:
        con.close()


def vote_explain(source, ref, style="standard", up=False, down=False):
    """学生自己判这一讲对不对。打回不是删掉，是留痕 —— 讲错了要能被数出来。"""
    ekey = "%s|%s|%s" % (source, ref, style)
    con = connect()
    try:
        if up:
            con.execute("UPDATE explain SET votes_up=votes_up+1 WHERE k=?", (ekey,))
        if down:
            con.execute("UPDATE explain SET votes_down=votes_down+1 WHERE k=?", (ekey,))
        con.commit()
        r = con.execute("SELECT * FROM explain WHERE k=?", (ekey,)).fetchone()
        return _explain_row(r)
    finally:
        con.close()




# ------------------------------------------------------------ 作文留底（D5）
def save_writing(pid, kind, essay, local, model_json, model, score):
    """存一篇作文。原文一字不改；本机部分和模型部分分开存。

    model 为 None 表示这一版没有模型参与（模型没接 / 模型作废），
    此时 score 一律存 NULL —— 没有总分就是没有，不写 0 冒充。
    """
    con = connect()
    try:
        cur = con.execute(
            "INSERT INTO writings(ts,pid,kind,essay,local_json,model_json,"
            "model,score,uid) VALUES(?,?,?,?,?,?,?,?,?)",
            (now(), pid, kind, essay,
             json.dumps(local, ensure_ascii=False),
             json.dumps(model_json, ensure_ascii=False) if model_json else None,
             model or "local",
             None if score is None else float(score), _uid())
        )
        con.commit()
        return cur.lastrowid
    finally:
        con.close()


def list_writings(pid=None, limit=20):
    con = connect()
    try:
        sql = "SELECT * FROM writings"
        args = []
        if pid:
            sql += " WHERE pid=?"
            args.append(pid)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(int(limit))
        rows = [dict(r) for r in con.execute(sql, args).fetchall()]
        for r in rows:
            for k in ("local_json", "model_json"):
                try:
                    r[k] = json.loads(r.get(k) or "null")
                except (ValueError, TypeError):
                    r[k] = None
        return rows
    finally:
        con.close()


def writing_stats():
    """作文的家底：写过几篇、几篇有模型分、几分是本机算出来的。

    跟讲题同一个脾气 —— 没判过的篇数不算「0 分」，而是「没判」。
    """
    con = connect()
    try:
        t = con.execute("SELECT COUNT(*) c, AVG(score) a,"
                        " SUM(CASE WHEN score IS NULL THEN 1 ELSE 0 END) n"
                        " FROM writings").fetchone()
        m = con.execute("SELECT COUNT(*) c FROM writings WHERE model IS NOT NULL"
                        " AND model != ?", ("local",)).fetchone()["c"]
        total = int(t["c"] or 0)
        unscored = int(t["n"] or 0)
        return {"total": total,
                "scored": total - unscored,
                "unscored": unscored,
                "avg_score": (round(float(t["a"]), 1) if t["a"] is not None else None),
                "by_model": int(m or 0)}
    finally:
        con.close()


def explain_stats():
    """讲题的家底：讲过多少题、多少条依据全部复核通过、被打回多少。"""
    con = connect()
    try:
        t = con.execute("SELECT COUNT(*) c, SUM(verified) v,"
                        " SUM(votes_down) d, SUM(votes_up) u FROM explain").fetchone()
        by = [dict(r) for r in con.execute(
            "SELECT source, COUNT(*) n, SUM(verified) v FROM explain"
            " GROUP BY source ORDER BY n DESC").fetchall()]
        logn = con.execute("SELECT COUNT(*) c FROM explain_log").fetchone()["c"]
        # 模型参与过多少条 —— explain.model 不是 'local-evidence' 就是真模型名。
        # 这一行让「哪段话是模型写的」永远能查，而不是靠嘴说。
        m = con.execute("SELECT COUNT(*) c FROM explain WHERE model IS NOT NULL"
                        " AND model != 'local-evidence'").fetchone()["c"]
        return {"total": int(t["c"] or 0), "verified": int(t["v"] or 0),
                "votes_up": int(t["u"] or 0), "votes_down": int(t["d"] or 0),
                "revisions": int(logn or 0), "by_model": int(m or 0),
                "by_source": by}
    finally:
        con.close()



# ---------------------------------------------------------------- 错词本 / 今日词量（C6 / C7）
def wrong_words(limit=200):
    """错词本：答错过的词，错得多的排前面。"""
    con = connect()
    try:
        return [dict(r) for r in con.execute(
            "SELECT word, box, due, wrong, right, seen FROM word_mem"
            " WHERE wrong>0 ORDER BY wrong DESC, due LIMIT ?", (limit,)).fetchall()]
    finally:
        con.close()


def today_word_count():
    """今天真正在本机组里过过的词数（去重，来自作答事件）。"""
    con = connect()
    try:
        r = con.execute(
            "SELECT COUNT(DISTINCT word) c FROM events"
            " WHERE kind='grade_word' AND word IS NOT NULL AND substr(ts,1,10)=?",
            (today(),)).fetchone()
        return r["c"] or 0
    finally:
        con.close()


def today_word_events():
    con = connect()
    try:
        return [dict(r) for r in con.execute(
            "SELECT word, ok, ts FROM events"
            " WHERE kind='grade_word' AND word IS NOT NULL AND substr(ts,1,10)=?"
            " ORDER BY id DESC LIMIT 50", (today(),)).fetchall()]
    finally:
        con.close()


# ---------------------------------------------------------------- 错因打标（D5）
def add_error_tag(qno=None, part=None, tag=None, word=None, uid=None, ts=None):
    if not tag:
        return {"error": "没选错因"}
    uid = uid or new_uid()
    con = connect()
    try:
        con.execute(
            "INSERT INTO error_tags(ts,qno,part,tag,word,uid) VALUES(?,?,?,?,?,?)",
            (ts or now(), qno, part, tag, word, uid))
        con.commit()
        return {"ok": True, "tag": tag, "qno": qno, "part": part, "uid": uid}
    finally:
        con.close()


def tag_stats():
    con = connect()
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT tag, COUNT(*) c FROM error_tags GROUP BY tag ORDER BY c DESC").fetchall()]
        total = sum(r["c"] for r in rows)
        return {"tags": rows, "total": total}
    finally:
        con.close()


def tagged_qnos():
    con = connect()
    try:
        return {r["qno"]: r["tag"] for r in con.execute(
            "SELECT qno, tag FROM error_tags WHERE qno IS NOT NULL"
            " GROUP BY qno").fetchall()}
    finally:
        con.close()


# ---------------------------------------------------------------- 整卷（D4）
def save_exam_session(paper_id, judgeable, answered, right, raw, max_raw,
                      scored, seconds, detail, uid=None, ts=None):
    """一次交卷 = 一行。返回这行的 id（界面"最近交卷"要用）。"""
    con = connect()
    try:
        cur = con.execute(
            "INSERT INTO exam_sessions(ts,paper_id,judgeable,answered,right,raw,"
            "max_raw,scored,seconds,detail,uid) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (ts or now(), paper_id, int(judgeable), int(answered), int(right),
             float(raw), float(max_raw),
             None if scored is None else float(scored), float(seconds or 0),
             json.dumps(detail, ensure_ascii=False), uid or new_uid()))
        con.commit()
        return cur.lastrowid
    finally:
        con.close()


def exam_sessions(paper_id=None, limit=10):
    con = connect()
    try:
        if paper_id:
            rows = con.execute(
                "SELECT * FROM exam_sessions WHERE paper_id=?"
                " ORDER BY id DESC LIMIT ?", (paper_id, int(limit))).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM exam_sessions ORDER BY id DESC LIMIT ?",
                (int(limit),)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["detail"] = json.loads(d["detail"] or "[]")
            except Exception:
                d["detail"] = []
            out.append(d)
        return out
    finally:
        con.close()


def exam_best(paper_id):
    """这套卷历史上最高的一次得分（没交过卷就是 None，不填 0）。"""
    con = connect()
    try:
        r = con.execute(
            "SELECT MAX(scored) m, COUNT(*) n FROM exam_sessions"
            " WHERE paper_id=? AND scored IS NOT NULL", (paper_id,)).fetchone()
        return {"best": r["m"], "sessions": r["n"] or 0}
    finally:
        con.close()


# ---------------------------------------------------------------- kv
def kv_set(k, v):
    con = connect()
    try:
        con.execute("INSERT INTO kv(k,v) VALUES(?,?)"
                    " ON CONFLICT(k) DO UPDATE SET v=?", (k, str(v), str(v)))
        con.commit()
    finally:
        con.close()


# ---------------------------------------------------------------- 会话与事件流
# 设计依据见 docs/AI交互设计.md §4。要点：
#   · 会话是独立实体，能分栏、能归档、能 fork（fork 就是复制事件到新 session）
#   · 事件 append-only，只追加不修改；渲染顺序只认 seq
#   · seq 用「同会话内 MAX+1」在同一事务里算，单机单写够用
def _now_s():
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def session_new(focus=None, title=None, provider=None, model=None, sid=None):
    """开一条新会话，返回它的 id。"""
    sid = sid or ("s-%s-%s" % (dt.datetime.now().strftime("%Y%m%d-%H%M%S"),
                                uuid.uuid4().hex[:4]))
    now = _now_s()
    con = connect()
    try:
        con.execute("INSERT INTO sessions(id,title,focus,provider,model,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (sid, title, focus, provider, model, now, now))
        con.commit()
    finally:
        con.close()
    return sid


def session_get(sid):
    con = connect()
    try:
        row = con.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def session_list(limit=60, include_archived=False):
    """会话列表，最近改过的在前。带上事件数与最后一句，列表上就能看出聊到哪了。"""
    con = connect()
    try:
        where = "" if include_archived else "WHERE s.archived=0"
        cols = ("SELECT s.*, "
                "(SELECT COUNT(*) FROM session_events e WHERE e.session_id=s.id) AS events, "
                "(SELECT e2.payload FROM session_events e2 WHERE e2.session_id=s.id "
                " AND e2.kind IN ('turn/start','assistant/message') "
                " ORDER BY e2.seq DESC LIMIT 1) AS last")
        rows = con.execute(cols + " FROM sessions s " + where +
                           " ORDER BY s.updated_at DESC, s.id DESC LIMIT ?",
                           (int(limit),)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                p = json.loads(d.get("last") or "{}")
                d["last_text"] = p.get("text") or ""
            except Exception:
                d["last_text"] = ""
            d.pop("last", None)
            out.append(d)
        return out
    finally:
        con.close()


def session_touch(sid, title=None):
    """更新最后活动时间；title 传了就一起改（第一句话自动当标题）。"""
    con = connect()
    try:
        if title:
            con.execute("UPDATE sessions SET updated_at=?, title=? WHERE id=?",
                        (_now_s(), title, sid))
        else:
            con.execute("UPDATE sessions SET updated_at=? WHERE id=?", (_now_s(), sid))
        con.commit()
    finally:
        con.close()


def session_archive(sid, flag=True):
    con = connect()
    try:
        con.execute("UPDATE sessions SET archived=? WHERE id=?", (1 if flag else 0, sid))
        con.commit()
    finally:
        con.close()


def ev_add(sid, kind, payload=None, turn_no=0, step_no=0):
    """追加一条事件，返回它的 seq。payload 是 dict，落库前序列化。"""
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT COALESCE(MAX(seq),0)+1 FROM session_events WHERE session_id=?",
                          (sid,)).fetchone()
        seq = int(row[0])
        con.execute("INSERT INTO session_events(session_id,turn_no,step_no,seq,kind,payload,created_at)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (sid, int(turn_no or 0), int(step_no or 0), seq, kind,
                     json.dumps(payload or {}, ensure_ascii=False), _now_s()))
        con.execute("UPDATE sessions SET updated_at=? WHERE id=?", (_now_s(), sid))
        con.commit()
        return seq
    finally:
        con.close()


def ev_list(sid, since_seq=0, limit=2000):
    con = connect()
    try:
        rows = con.execute(
            "SELECT seq,turn_no,step_no,kind,payload,created_at FROM session_events"
            " WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
            (sid, int(since_seq or 0), int(limit))).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["payload"] = json.loads(d.get("payload") or "{}")
            except Exception:
                d["payload"] = {}
            out.append(d)
        return out
    finally:
        con.close()


def ev_count(sid):
    con = connect()
    try:
        return int(con.execute("SELECT COUNT(*) FROM session_events WHERE session_id=?",
                               (sid,)).fetchone()[0])
    finally:
        con.close()


def ev_max_turn(sid):
    con = connect()
    try:
        row = con.execute("SELECT COALESCE(MAX(turn_no),0) FROM session_events"
                          " WHERE session_id=?", (sid,)).fetchone()
        return int(row[0])
    finally:
        con.close()


def session_search(q, limit=30):
    """按内容搜会话：用户说的话、它回的正文、工具结果摘要都算。

    为什么搜 payload 而不是只搜标题：人记得的往往是「那次搜到的那门课」，
    不是自己开头打的那句话。
    """
    kw = ("%" + str(q or "").strip() + "%") if str(q or "").strip() else "%"
    con = connect()
    try:
        rows = con.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM session_events e2 WHERE e2.session_id=s.id) AS events"
            " FROM sessions s"
            " WHERE s.archived=0 AND ("
            "   s.title LIKE ? OR EXISTS (SELECT 1 FROM session_events e"
            "     WHERE e.session_id=s.id AND e.payload LIKE ?))"
            " ORDER BY s.updated_at DESC LIMIT ?", (kw, kw, int(limit))).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


def session_fork(sid, upto_turn=None, title=None):
    """从某条会话的某个 turn 分叉出一条新的，原来的不动。

    用途：一条会话里聊了三件事，只想带着前两件继续往深了问 ——
    复制到那一刻为止的事件，新会话接着聊，老的照原样留着。
    upto_turn 不传就整条复制。
    """
    src = session_get(str(sid or ""))
    if not src:
        return None
    ev = ev_list(src["id"])
    if upto_turn:
        ev = [e for e in ev if int(e.get("turn_no") or 0) <= int(upto_turn)]
    new_sid = session_new(focus=src.get("focus"),
                          title=(title or ((src.get("title") or "会话") + " · 分叉")),
                          provider=src.get("provider"), model=src.get("model"))
    for e in ev:
        try:
            ev_add(new_sid, e["kind"], e.get("payload") or {},
                   turn_no=e.get("turn_no") or 0, step_no=e.get("step_no") or 0)
        except Exception:
            continue
    return {"id": new_sid, "from": src["id"], "events": len(ev),
            "upto_turn": (int(upto_turn) if upto_turn else None)}


def kv_get(k, default=None):
    con = connect()
    try:
        r = con.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return r["v"] if r else default
    finally:
        con.close()


# ================================================================ 多端同步（G1）
# 口径：
#   events / answers / error_tags / exam_sessions —— 只增不加选择：按 uid 去重，缺的就补进来。
#   lesson_progress —— 按讲次逐条比 updated_ts，新的赢；谁也没标 done 就保留 done（不去旧恶化）。
#   word_mem —— 同上新建事实比，但「记ana得多/错得多」选汇总更高的那个。
#   notes —— 两边都改过就有冲突，不静默覆盖：把对方版本存进 alt_text/alt_ts 让你自己选。
#   tool_calls —— 审计流水，不同步（它只是本机调过什么的记录，合起来意义不大，还长很快）。
_SYNC_APPEND = ["events", "answers", "error_tags", "exam_sessions"]


def backfill_uids():
    """给同步功能上线前已经记下的老数据补 uid（这批没有 uid，合库时会重复）。

    老数据同一份在两个库里会各补一个不同的 uid，这是已知代价 —— 一次性合并后
    会重，之后在某一台机器上清一次即可。返回补了几条。
    """
    con = connect()
    n = 0
    try:
        for t in _SYNC_APPEND:
            rows = con.execute(
                "SELECT id, ts FROM %s WHERE uid IS NULL OR uid=''" % t).fetchall()
            for r in rows:
                con.execute("UPDATE %s SET uid=? WHERE id=?" % t,
                            (new_uid(), r["id"]))
                n += 1
        con.commit()
    finally:
        con.close()
    return n


def export_bundle():
    """把本机能同步的学习记录读成一个字典（不含 tool_calls 审计流水）。

    记录保持原字段导出，不在这一步改值 —— 怎么取舍由 merge_bundle 当场比对决定。
    """
    backfill_uids()
    con = connect()
    out = {"tables": {}, "counts": {}}
    try:
        for t in _SYNC_APPEND + ["lesson_progress", "word_mem", "notes"]:
            out["tables"][t] = [dict(r) for r in
                                con.execute("SELECT * FROM %s" % t).fetchall()]
        out["counts"] = {t: len(v) for t, v in out["tables"].items()}
    finally:
        con.close()
    return out


def merge_bundle(bundle):
    """把别台机器的 bundle 合进本机库。返回各表「新纳进几条 / 本机改了几条 / 冲突几条」。

    绝不整库覆盖：每条记录都当场比对，两端都有独立操作时取并集 / 取更晚的那一份。
    """
    tables = (bundle or {}).get("tables") or {}
    if not isinstance(tables, dict) or not tables:
        return {"error": "同步包里没有数据表", "applied": {}}
    added, updated, conflicts = {}, {}, []

    con = connect()
    try:
        for t in _SYNC_APPEND:
            rows = tables.get(t) or []
            a = u = 0
            for r in rows:
                if not isinstance(r, dict) or not r.get("uid"):
                    continue
                src = {k: v for k, v in r.items() if k != "id"}
                try:
                    before = con.total_changes
                    con.execute("INSERT OR IGNORE INTO %s(%s) VALUES(%s)" % (
                        t, ",".join(src.keys()), ",".join("?" * len(src))),
                        tuple(src.values()))
                    if con.total_changes > before:
                        a += 1
                except sqlite3.Error:
                    pass
            added[t], updated[t] = a, u

        # ---- lesson_progress：新的赢，且谁标了 done 就别弄丢
        a = u = 0
        for r in (tables.get("lesson_progress") or []):
            if not (r or {}).get("lesson_id"):
                continue
            mine = con.execute("SELECT * FROM lesson_progress WHERE lesson_id=?",
                               (r["lesson_id"],)).fetchone()
            if not mine:
                con.execute(
                    "INSERT INTO lesson_progress(lesson_id,subject,status,pos_sec,updated_ts)"
                    " VALUES(?,?,?,?,?)",
                    (r["lesson_id"], r.get("subject"), r.get("status") or "doing",
                     float(r.get("pos_sec") or 0), r.get("updated_ts") or now()))
                a += 1
                continue
            theirs_ts = (r.get("updated_ts") or "")
            mine_ts = (mine["updated_ts"] or "")
            if theirs_ts > mine_ts:
                status = mine["status"]
                if (r.get("status") == "done") or (mine["status"] == "done"):
                    status = "done"          # 一边做完就算做完，不倒退
                con.execute(
                    "UPDATE lesson_progress SET status=?, pos_sec=?, updated_ts=?"
                    " WHERE lesson_id=?",
                    (status, max(float(r.get("pos_sec") or 0),
                                 float(mine["pos_sec"] or 0)),
                     theirs_ts, r["lesson_id"]))
                u += 1
        added["lesson_progress"], updated["lesson_progress"] = a, u

        # ---- word_mem：seen/right/wrong 合并大的；box/due 取更靠后的那个
        a = u = 0
        for r in (tables.get("word_mem") or []):
            if not (r or {}).get("word"):
                continue
            w = r["word"]
            mine = con.execute("SELECT * FROM word_mem WHERE word=?", (w,)).fetchone()
            if not mine:
                con.execute(
                    "INSERT INTO word_mem(word,box,due,seen,right,wrong,last_ts)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (w, int(r.get("box") or 0), r.get("due"),
                     int(r.get("seen") or 0), int(r.get("right") or 0),
                     int(r.get("wrong") or 0), r.get("last_ts")))
                a += 1
                continue
            theirs_last = r.get("last_ts") or ""
            mine_last = mine["last_ts"] or ""
            box, due = mine["box"], mine["due"]
            if theirs_last > mine_last:      # 对方更晚练过 → 它的进度较新
                box, due = int(r.get("box") or 0), r.get("due")
            # 累计量取两边较大的：各自的练习次数都算数，合并后不能变少
            seen = max(int(mine["seen"] or 0), int(r.get("seen") or 0))
            right = max(int(mine["right"] or 0), int(r.get("right") or 0))
            wrong = max(int(mine["wrong"] or 0), int(r.get("wrong") or 0))
            if (seen, right, wrong, box, due) != (mine["seen"], mine["right"],
                                                  mine["wrong"], mine["box"], mine["due"]):
                con.execute(
                    "UPDATE word_mem SET box=?,due=?,seen=?,right=?,wrong=?,last_ts=?"
                    " WHERE word=?",
                    (box, due, seen, right, wrong,
                     max(theirs_last, mine_last), w))
                u += 1
        added["word_mem"], updated["word_mem"] = a, u

        # ---- notes：两边都有且内容不同 = 冲突，把对方版本留进 alt_* 给用户看
        a = u = 0
        for r in (tables.get("notes") or []):
            lid = (r or {}).get("lesson_id")
            if not lid:
                continue
            mine = con.execute("SELECT * FROM notes WHERE lesson_id=?", (lid,)).fetchone()
            tt = r.get("text") or ""
            if not mine:
                con.execute(
                    "INSERT INTO notes(lesson_id,text,pos_sec,updated_ts)"
                    " VALUES(?,?,?,?)",
                    (lid, tt, float(r.get("pos_sec") or 0),
                     r.get("updated_ts") or now()))
                a += 1
                continue
            mt = mine["text"] or ""
            if tt == mt:
                continue
            theirs_ts, mine_ts = r.get("updated_ts") or "", mine["updated_ts"] or ""
            if not mt:                       # 本机是空的，直接用它的
                con.execute("UPDATE notes SET text=?, updated_ts=? WHERE lesson_id=?",
                            (tt, max(theirs_ts, mine_ts), lid))
                u += 1
            elif theirs_ts > mine_ts:        # 对方更晚改 → 它的赢，旧的存进 alt
                con.execute(
                    "UPDATE notes SET alt_text=?, alt_ts=?, text=?, updated_ts=?"
                    " WHERE lesson_id=?",
                    (mt, mine_ts, tt, theirs_ts, lid))
                u += 1
                conflicts.append({"lesson_id": lid, "kept": theirs_ts,
                                  "kept_as_alt": mine_ts})
            else:                            # 本机更晚 → 本机赢，对方的存进 alt
                con.execute(
                    "UPDATE notes SET alt_text=?, alt_ts=? WHERE lesson_id=?",
                    (tt, theirs_ts, lid))
                conflicts.append({"lesson_id": lid, "kept": mine_ts,
                                  "kept_as_alt": theirs_ts})
        added["notes"], updated["notes"] = a, u

        con.commit()
    finally:
        con.close()
    return {"added": added, "updated": updated, "conflicts": conflicts,
            "new": sum(added.values()), "changed": sum(updated.values()),
            "notes_conflicts": len(conflicts)}
