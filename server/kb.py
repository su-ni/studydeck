# -*- coding: utf-8 -*-
"""研学台 · 知识索引（向量检索）。

为什么要有它：题库、考点卡、AI 生成题、讲次标题加起来两千多条，靠关键词搜
只能命中字面。学生问「进程和线程啥区别」，库里那条卡叫「程序与进程」——
字面搜不到，这不是知识的缺失，是入口的缺失。

三条铁律（跟 explain.py 一个原则：先有依据再说话）：

1. **索引是内容的从属物，不是独立资产。** 内容和向量同库同事务（都在 study.db），
   内容删了向量跟着没，不会出现「索引里搜得到、点进去是空的」。
2. **主键是内容自己的 (source, ref)，不是自增号。** AI 把同一道题重新生成一版，
   拿同样的键覆盖就行，不会多出一条重复的；题号也不洗牌。
3. **写入即索引，不是批量作业。** 编一条 16 毫秒（实测 CPU，24M 参数模型），
   落库那一刻顺手做完，用户根本感觉不到。只有几千条一起灌时才需要排队，
   而且从头到尾「边编边能搜」——不需要停下来重建。

模型：BAAI/bge-small-zh-v1.5（24M 参数，512 维）。选它不是因为最小，
是因为实测在这台机器上「建 1997 条 32 秒、查一次 0.25 毫秒、矩阵 3.9MB」，
全部在 CPU 上跑，不需要显卡。第一台机器没 GPU 也能用，这是本机优先的底线。
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time

from . import config, store

MODEL_NAME = "BAAI/bge-small-zh-v1.5"
DIM_HINT = 512
# BGE 中文系列的官方检索前缀：只加在「问句」这一侧，文档侧不加。
# 不加也能用，但实测短问句对长条目的分数会整体压平，加了区分度明显。
QP = "为这个句子生成表示以用于检索相关文章："

_SCHEMA = """
CREATE TABLE IF NOT EXISTS kb_item(
  id TEXT PRIMARY KEY,          -- source#ref：内容是自己的主键，重生成就覆盖
  subject TEXT,
  kind TEXT,                    -- 语法题 / 考点 / 真题 / AI 生成题 / 讲次
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,           -- 正文 sha1：没变就不重编，省掉那 16 毫秒
  vec BLOB,                     -- float32 × 512，little-endian
  model TEXT,
  dim INTEGER,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS ix_kb_subject ON kb_item(subject);
CREATE INDEX IF NOT EXISTS ix_kb_kind ON kb_item(kind);
CREATE INDEX IF NOT EXISTS ix_kb_source ON kb_item(source);
"""

_tok = None
_mdl = None
_dim = DIM_HINT
_lock = threading.Lock()
_load_err = None
# 写操作把版本号推一格；检索侧看见版本变了就重读向量，保证「刚写进去的立刻能搜到」
_ver = [0]


_CONN = threading.local()


def _open():
    """建一条 kb 专用的连接。

    为什么不能用 store.connect()：它建出来的连接带 SQLite 默认的线程归属
    （只能在创建它的那个线程里用）。而 Web 服务是「一个请求一个线程」——
    服务启动时预热线程先碰一次 kb，之后真正处理搜索请求的是别的线程，
    一检索就抛
      「SQLite objects created in thread X can only be used in thread Y」。
    表现很坑：单独跑脚本一切正常，只有从界面上搜才报「语义检索出错」。
    """
    import sqlite3 as _sq
    con = _sq.connect(config.DB_PATH, timeout=10)
    con.row_factory = _sq.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    return con


def _conn():
    """每个线程一条连接，线程内复用。

    为什么不是「全局一条 + check_same_thread=False + 一把锁」：
    那条路能跑，但等于把 SQLite 自己的并发保护拆了再手工补一把大锁，
    任何一次 kb 读写都会把其它请求（包括无关的写盘）挡在门外。
    线程本地连接没有这个代价 —— 连接很轻，一个线程池也就那么几个线程，
    而「每个线程一条」正是 SQLite 文档推荐的做法。

    又为什么不每次新建：那样句柄会漏（见 kb 原注释，几百次调用就漏干净了）。
    线程内复用 + 线程间隔离，两头都要。
    """
    c = getattr(_CONN, "c", None)
    if c is None:
        c = _open()
        _CONN.c = c
    return c


def ensure_schema(conn=None):
    c = conn or _conn()
    c.executescript(_SCHEMA)
    c.commit()


def ensure_schema(conn=None):
    c = conn or _conn()
    c.executescript(_SCHEMA)
    c.commit()


def _load():
    """懒加载编码模型。第一次真正要编码时才加载 —— 别拖慢服务启动。

    没装 transformers / 模型下不下来，都如实报错，不静默退化成关键词匹配：
    退化了但界面还显示「语义检索已开」，那是最坏的一种假。
    """
    global _tok, _mdl, _dim, _load_err
    if _mdl is not None:
        return True
    with _lock:
        if _mdl is not None:
            return True
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer
        except Exception as e:
            _load_err = ("这台机器上没有 transformers / torch，语义检索用不了：%s。"
                         "装法：pip install transformers torch" % e)
            return False
        try:
            # 先只用本地缓存：模型下好之后，transformers 默认还会去 HuggingFace 做一次
            # HEAD 确认，断网/证书出问题时那个重试是 8 秒 × 5 次（实测整整卡 60 秒），
            # 一次检索变成一分钟，用户只会以为「搜索坏了」。
            _tok = AutoTokenizer.from_pretrained(MODEL_NAME, local_files_only=True)
            _mdl = AutoModel.from_pretrained(MODEL_NAME, local_files_only=True).eval()
        except Exception:
            # 本地没有（第一次用）才联网下一次，约 95MB
            try:
                _tok = AutoTokenizer.from_pretrained(MODEL_NAME)
                _mdl = AutoModel.from_pretrained(MODEL_NAME).eval()
            except Exception as e:
                _load_err = ("编码模型 %s 加载失败：%s。"
                             "第一次要联网下一次（约 95MB），下好之后就都在本地了。"
                             % (MODEL_NAME, e))
                return False
        try:
            import torch
            torch.set_num_threads(min(8, os.cpu_count() or 4))
            _dim = int(_mdl.config.hidden_size)
            _load_err = None
            return True
        except Exception as e:
            _load_err = "编码模型起来了但读不出维度：%s" % e
            return False


def available():
    """能用就说能，不能用就说为什么。不猜。"""
    ok = _load()
    return {"ok": ok, "model": MODEL_NAME, "dim": _dim, "why": None if ok else _load_err}


def encode(texts, is_query=False, batch=32):
    """把一批文本编成归一化向量（float32 ndarray）。

    归一化之后余弦相似度就是点积，检索那一步能省掉两次开方 ——
    1997 条 × 512 维做一遍，0.25 毫秒和 0.4 毫秒的区别，但白拿的为什么不拿。
    """
    text = [(QP + t) if is_query else t for t in texts]
    out = []
    for i in range(0, len(text), batch):
        chunk = text[i:i + batch]
        try:
            import numpy as np
            import torch
            b = _tok(chunk, padding=True, truncation=True, max_length=256,
                     return_tensors="pt")
            with torch.no_grad():
                o = _mdl(**b).last_hidden_state[:, 0]
            v = torch.nn.functional.normalize(o, dim=-1).numpy().astype("float32")
            out.append(v)
        except Exception as e:
            raise RuntimeError("编码失败：%s" % e)
    import numpy as np
    return np.vstack(out) if out else np.zeros((0, _dim), dtype="float32")


def _hash(text):
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def put_many(items, encode_text=True):
    """批量写入（同一个事务）。items 每项：{source, ref, subject, kind, title, text}

    返回 {"added", "updated", "skipped", "failed"}。
    skipped 是 hash 没变的 —— 这些一条都不重编，同步时省下的时间全在这儿。
    """
    if not items:
        return {"added": 0, "updated": 0, "skipped": 0, "failed": 0}
    c = _conn()
    ensure_schema(c)
    old = {}
    for row in c.execute("select id, hash from kb_item"):
        old[row[0]] = row[1]

    todo, stat = [], {"added": 0, "updated": 0, "skipped": 0, "failed": 0, "dup": 0}
    seen_key = {}
    for it in items:
        text = (it.get("text") or "").strip()
        source = str(it.get("source") or "").strip()
        ref = str(it.get("ref") or "").strip()
        if not text or not source or not ref:
            stat["failed"] += 1
            continue
        key = "%s#%s" % (source, ref)
        # 同一个键在这一批里出现两次 = collect() 的 ref 拼错了，后一条会盖掉前一条。
        # 不静默吞：数出来报给调用方（2026-10-30 实测政治卡因此丢了 522 条）。
        if key in seen_key:
            stat["dup"] += 1
            continue
        seen_key[key] = 1
        h = _hash(text)
        if old.get(key) == h:
            stat["skipped"] += 1
            continue
        todo.append((key, it, text, h, key in old))

    if not todo:
        return stat
    if encode_text and not _load():
        raise RuntimeError(_load_err or "编码模型不可用")
    vecs = encode([t[2] for t in todo]) if encode_text else [None] * len(todo)

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        for (key, it, text, h, is_upd), v in zip(todo, vecs):
            blob = v.tobytes() if v is not None else None
            c.execute(
                "insert into kb_item(id,subject,kind,source,ref,title,text,hash,vec,model,dim,ts)"
                " values(?,?,?,?,?,?,?,?,?,?,?,?)"
                " on conflict(id) do update set subject=excluded.subject,kind=excluded.kind,"
                " title=excluded.title,text=excluded.text,hash=excluded.hash,"
                " vec=excluded.vec,model=excluded.model,dim=excluded.dim,ts=excluded.ts",
                (key, it.get("subject"), it.get("kind"), it.get("source"), str(it.get("ref")),
                 it.get("title"), text, h, blob, MODEL_NAME, _dim, now))
            stat["updated" if is_upd else "added"] += 1
        c.commit()
    except Exception:
        c.rollback()
        raise
    _ver[0] += 1
    return stat


def put(source, ref, subject=None, kind=None, title=None, text=None):
    """写一条。这是「写入即索引」的唯一入口 —— 内容落库的地方顺手调它。"""
    return put_many([{"source": source, "ref": ref, "subject": subject,
                      "kind": kind, "title": title, "text": text}])


# ---------------------------------------------------------------------------
# 笔记 / 画布：写入即索引
# ---------------------------------------------------------------------------
# 为什么单独给它们两个函数：collect() 只在 kb_build 时被走一遍，
# 而笔记和画布是**用户随手改**的 —— 刚记的一句、刚画的一个节点，
# 下一秒搜就要能搜到。等下次全量重建等于「搜不到刚写的东西」。

def index_note(lesson_id, text, extra=""):
    """一条笔记落库 → 顺手进索引。"""
    lid = str(lesson_id or "").strip()
    txt = str(text or "").strip()
    if not lid or not txt:
        return 0
    return put_many([{
        "source": "note", "ref": lid,
        "subject": (lid.split("-")[0] or None),
        "kind": "笔记", "title": _clean(txt, 34),
        "text": _clean(("%s %s" % (extra or "", txt)), 800),
    }]).get("added", 0) + 0


def index_canvas(map_id, title=None, tree=None, lesson_id=None):
    """一张画布落库 → 把整棵树摊成一段文字再进索引。

    跟 collect() 里第 7 段用的是同一套摊法（缩进拼路径），
    两边保持一致：不然「全量重建之后」和「刚存完」搜出来的内容会不一样。
    """
    mid = str(map_id or "").strip()
    if not mid:
        return 0
    buf = []

    def _flatten(node, dep=0):
        if isinstance(node, dict):
            t = node.get("text") or node.get("title") or ""
            if t:
                buf.append(("  " * dep) + str(t))
            for ch in node.get("children") or []:
                _flatten(ch, dep + 1)
        elif isinstance(node, list):
            for ch in node:
                _flatten(ch, dep)

    try:
        _flatten(tree or {}, 0)
    except Exception:
        pass
    txt = " / ".join(x.strip() for x in buf if x.strip())[:900]
    if not txt:
        txt = str(title or "").strip()
    if not txt:
        # 空画布没什么可搜的，但也别留一条旧的在上面 —— 那样会搜到已经删掉的内容。
        drop("canvas", mid)
        return 0
    return put_many([{
        "source": "canvas", "ref": mid,
        "subject": (str(lesson_id or mid).split("-")[0] or None),
        "kind": "画布", "title": _clean(str(title or txt), 34),
        "text": _clean(txt, 900),
    }]).get("added", 0)


def drop(source=None, ref=None):
    """删内容时一起删向量，别留孤儿。source/ref 都不给就清空整表。"""
    c = _conn()
    ensure_schema(c)
    if source is None and ref is None:
        c.execute("delete from kb_item")
    elif source is not None and ref is None:
        c.execute("delete from kb_item where source=?", (source,))
    else:
        c.execute("delete from kb_item where source=? and ref=?", (source, str(ref)))
    c.commit()
    _ver[0] += 1


def index_gen_source(src):
    """AI 刚生成的一批题，落盘之后顺手进索引。

    这就是「写入即索引」：不等到下次 kb_build，落库这一刻编完。
    编完的收益很实在 —— 下一句「上次你给我出过一道类似的」才搜得到，
    出题前也能先查重（同一道题别出第二遍）。
    """
    sid, sub = src.get("id"), src.get("subject")
    items = []
    for it in src.get("items") or []:
        stem = (it.get("stem") or "").strip()
        if not stem:
            continue
        opts = it.get("opts") or {}
        t = stem
        if isinstance(opts, dict) and opts:
            t += "｜" + " ".join("%s.%s" % (k, v) for k, v in opts.items())
        if it.get("explain"):
            t += "｜解析：" + str(it["explain"])
        items.append({"source": sid, "ref": str(it.get("no")), "subject": sub,
                      "kind": "AI 生成题", "title": _clean(stem, 34), "text": _clean(t, 1200)})
    return put_many(items)


def index_paper(paper, pid=None):
    """网上拉回来 / 新导入的一整套卷，落盘之后顺手进索引。"""
    pid = pid or paper.get("id") or ""
    sub = paper.get("subject") or "english"
    items = []
    for gi, g in enumerate(paper.get("groups") or []):
        for q in g.get("questions") or []:
            stem = (q.get("stem") or "").strip()
            if not stem:
                continue
            opts = q.get("opts") or {}
            t = stem
            if isinstance(opts, dict) and opts:
                t += "｜" + " ".join("%s.%s" % (k, v) for k, v in opts.items())
            items.append({"source": "paper", "ref": "%s#g%s-%s" % (pid, gi, q.get("no")),
                          "subject": sub, "kind": "真题",
                          "title": _clean(stem, 34), "text": _clean(t, 1200)})
    return put_many(items)


def drop_paper(pid):
    """卷被删掉了，索引里那套题也一起走。

    不做这一步的下场是：搜得到、点进去是空的 —— 那比搜不到更让人恼火。
    """
    if not pid:
        return 0
    c = _conn()
    ensure_schema(c)
    pat = str(pid) + "#%"
    n = 0
    for src in ("paper", "paper-material"):
        cur = c.execute("delete from kb_item where source=? and ref like ?", (src, pat))
        n += cur.rowcount or 0
    c.commit()
    if n:
        _ver[0] += 1
    return n


_CACHE = {"ver": -1, "rows": [], "mat": None}


def _matrix(c, subject=None):
    """把向量读成一张矩阵。只在写入之后重读一次，平时都走内存。"""
    import numpy as np
    key = (subject or "",)
    cache = _CACHE.setdefault(key, {"ver": -1, "rows": [], "mat": None})
    if cache["ver"] == _ver[0] and cache["mat"] is not None:
        return cache["rows"], cache["mat"]
    sql = ("select id,subject,kind,source,ref,title,text,vec,dim from kb_item "
           "where vec is not null")
    args = []
    if subject:
        sql += " and subject=?"
        args.append(subject)
    rows, vecs = [], []
    for r in c.execute(sql, args):
        blob = r[7]
        if not blob:
            continue
        rows.append({"id": r[0], "subject": r[1], "kind": r[2], "source": r[3],
                     "ref": r[4], "title": r[5], "text": r[6]})
        vecs.append(np.frombuffer(blob, dtype="float32"))
    mat = np.vstack(vecs) if vecs else np.zeros((0, _dim), dtype="float32")
    cache.update({"ver": _ver[0], "rows": rows, "mat": mat})
    return rows, mat


def search(q, subject=None, k=5, kind=None, min_score=0.52, skip_kinds=("单词",),
           _allow_cross=True):
    """按语义找。返回 [{score, subject, kind, source, ref, title, text}]。

    subject 给了就只在这个科目里找 —— 这不是可选优化，是必须：
    实测全库混检时「进程和线程」会被 781 条英语语法题淹没（top1 只有 0.483，
    还答非所问）；加上科目过滤，同类问题 9/9 命中正确科目。

    min_score 是「宁可说没有，也不硬凑」的闸：实测对的和错的隔着一条线，
    真命中基本 ≥0.60，答非所问基本 ≤0.55。低于线的直接不返回，并在 note 里
    说清「库里没有直接相关的」—— 给一个 0.4 分的答案比不给更坏，学生会当真。

    但科目也会被传错（模型判断失误，或者人在英语课上问政治）。所以本科目里
    没找到、或者找到的分很低（<0.60）时，自动去全库再搜一次：如果别处明显更对，
    就用别处那条，并标 cross_subject=True 告诉调用方「这个知识点不在当前科目里」。
    不这么做的话，「虚拟语气」会命中「虚拟现实技术」，而真正的答案就躺在隔壁。
    """
    q = (q or "").strip()
    if not q:
        return {"ok": False, "error": "没给要搜的话", "hits": []}
    if not _load():
        return {"ok": False, "error": _load_err or "编码模型不可用", "hits": []}
    import numpy as np
    # 问句里明说了「单词 / 词汇」，就把词条放进来搜 —— 不然用户问「表示开始的单词」
    # 会得到一条语法题（实测 0.545 命中「They were abroad…」），莫名其妙。
    if skip_kinds and any(w in q for w in ("单词", "词汇", "词表", "背词", "英文词")):
        skip_kinds = ()
    c = _conn()
    ensure_schema(c)
    rows, mat = _matrix(c, subject)
    if not rows:
        return {"ok": True, "hits": [], "note": "索引还是空的，先建一次库（kb_build）"}
    qv = encode([q], is_query=True)[0]
    scores = mat @ qv
    order = np.argsort(-scores)
    hits = []
    for j in order:
        r = rows[int(j)]
        if kind and r["kind"] != kind:
            continue
        # 默认跳过「单词」这一类：7846 条词条跟几万字的题/考点混在一个语义空间里，
        # 会把正经的知识问题挤偏。要搜词就明确 kind="单词"（那时 skip 自动让路）。
        if not kind and skip_kinds and r["kind"] in skip_kinds:
            continue
        sc = float(scores[int(j)])
        if sc < min_score:
            continue
        hits.append({"score": round(sc, 4), **r})
        if len(hits) >= max(1, int(k)):
            break

    # 本科目里没把握 —— 去全库再找一次，别让「隔壁就有」变成「没有」
    if subject and _allow_cross and (not hits or hits[0]["score"] < 0.60):
        alt = search(q, subject=None, k=k, kind=kind, min_score=min_score,
                     skip_kinds=skip_kinds, _allow_cross=False)
        if alt.get("hits") and (not hits or alt["hits"][0]["score"] > hits[0]["score"] + 0.02):
            alt["cross_subject"] = True
            alt["note"] = ("当前科目（%s）里没有对得上的，但「%s」科目里有：%s"
                           % (subject, alt["hits"][0].get("subject") or "别的",
                              (alt["hits"][0].get("title") or "")[:30]))
            return alt

    out = {"ok": True, "q": q, "subject": subject, "scanned": len(rows), "hits": hits}
    if not hits:
        out["note"] = ("这台机器的库里没有跟「%s」直接对得上的条目（扫了 %d 条，"
                       "最高只有 %.3f）。要么换个说法，要么让 AI 上网补这段知识。"
                       % (q, len(rows), float(scores.max()) if len(scores) else 0))
        out["weak"] = True
    else:
        out["weak"] = hits[0]["score"] < 0.60
    return out


# ---------------------------------------------------------------------------
# 建库：把库里现有的东西摊平成待索引条目
# ---------------------------------------------------------------------------

def _clean(s, n=None):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s[:n] if n else s


def collect(subjects=None):
    """从各数据源摊平出待索引条目。纯读，不写库。

    只收「将来会被找出来」的东西：真题、考点卡、AI 生成题、讲次标题。
    一次性的问答消息、临时检索中间结果不进 —— 那些被搜到的概率接近零，
    收进来只会让矩阵变大、让检索变慢。
    """
    from . import datahub
    out = []

    # 1) 语法题库（781，带官方解析）
    try:
        bank = (datahub.proto() or {}).get("exercise_bank") or {}
        for q in bank.get("questions") or []:
            stem = q.get("stem") or ""
            if not stem:
                continue
            opts = q.get("opts") or {}
            t = stem
            if opts:
                t += "｜" + " ".join("%s.%s" % (k, v) for k, v in opts.items())
            if q.get("explain"):
                t += "｜解析：" + str(q["explain"])
            out.append({"source": "grammar780", "ref": str(q.get("no")),
                        "subject": "english", "kind": "语法题",
                        "title": _clean(stem, 34), "text": _clean(t, 1200)})
    except Exception:
        pass

    # 2) 考点卡（计算机 603 + 政治 613）
    try:
        for card in datahub.point_cards() or []:
            cid = card.get("id") or ""
            sub = "cs" if str(cid).startswith("pc-cs") else "politics"
            items = card.get("items") or card.get("sample") or []
            # 政治的 no 是「组内编号」：613 条只有 91 个不同的 no，每个重复 22 次。
            # 直接拿 no 当主键会让 522 条互相覆盖（实测只进了 224 条，静默丢掉一大半）。
            # grp 名的先后顺序就是源文件里的顺序，稳定；拼上组序号才是全局唯一。
            grps = []
            for it in items:
                g = str(it.get("grp") or "")
                if g and g not in grps:
                    grps.append(g)
            _ref_seq = {}
            for it in items:
                t = it.get("full") or ("%s %s" % (it.get("q") or "", it.get("a") or ""))
                if not str(t).strip():
                    continue
                g = str(it.get("grp") or "")
                if g:
                    # 源数据里连「组序号 + 组内编号」都不唯一（pc-pol390 的 g1 有两条 no=38）。
                    # 第二次起补个 #n —— 宁可 ref 难看一点，也不能让一条题把另一条盖掉。
                    base = "g%d-%s" % (grps.index(g), it.get("no"))
                    seq = _ref_seq.get(base, 0) + 1
                    _ref_seq[base] = seq
                    ref = base if seq == 1 else "%s#%d" % (base, seq)
                else:
                    ref = str(it.get("no"))
                out.append({"source": cid, "ref": ref, "subject": sub,
                            "kind": "考点", "title": _clean(it.get("q") or t, 34),
                            "text": _clean(t, 1200)})
    except Exception:
        pass

    # 3) AI 生成的题（用户明确要求：这些不是一次性产物，要能被找回来）
    try:
        for s in (datahub.gen_questions() or {}).get("sources") or []:
            sid, sub = s.get("id"), s.get("subject")
            for it in s.get("items") or []:
                stem = it.get("stem") or ""
                if not stem:
                    continue
                opts = it.get("opts") or {}
                t = stem
                if opts:
                    t += "｜" + " ".join("%s.%s" % (k, v) for k, v in opts.items())
                if it.get("explain"):
                    t += "｜解析：" + str(it["explain"])
                out.append({"source": sid, "ref": str(it.get("no")), "subject": sub,
                            "kind": "AI 生成题", "title": _clean(stem, 34),
                            "text": _clean(t, 1200)})
    except Exception:
        pass

    # 4) 真题卷题目 + 阅读原文（原文单独成条：讲解要「引第几段第几句」时靠它定位）
    try:
        pack = datahub.exam_papers() or {}
        for p in pack.get("papers") or []:
            pid = p.get("id") or ""
            sub = p.get("subject") or "english"
            for gi, g in enumerate(p.get("groups") or []):
                mat = _clean(g.get("material"), 1500)
                if len(mat) > 80:
                    out.append({"source": "paper-material",
                                "ref": "%s#g%s" % (pid, gi), "subject": sub,
                                "kind": "阅读原文", "title": _clean(mat, 34), "text": mat})
                for q in g.get("questions") or []:
                    stem = q.get("stem") or ""
                    if not stem:
                        continue
                    opts = q.get("opts") or {}
                    t = stem
                    if isinstance(opts, dict) and opts:
                        t += "｜" + " ".join("%s.%s" % (k, v) for k, v in opts.items())
                    # 题号在一套卷里可能跨组重复，拼上组序号才是全局唯一
                    out.append({"source": "paper", "ref": "%s#g%s-%s" % (pid, gi, q.get("no")),
                                "subject": sub, "kind": "真题",
                                "title": _clean(stem, 34), "text": _clean(t, 1200)})
    except Exception:
        pass

    # 5) 讲次标题（"这个知识点在哪一讲"，比题更常被问）
    try:
        for sub in datahub.subjects() or []:
            sid = sub.get("id")
            for les in sub.get("lessons") or []:
                name = les.get("name") or les.get("title") or ""
                if not name:
                    continue
                out.append({"source": "lesson", "ref": "%s:%s" % (sid, les.get("id")),
                            "subject": sid, "kind": "讲次",
                            "title": _clean(name, 34),
                            "text": _clean("%s %s" % (name, les.get("desc") or ""), 300)})
    except Exception:
        pass

    # 6) 自己的笔记：最该被搜到却最容易被忘的一块
    try:
        import sqlite3 as _sq
        c = _conn()
        for r in c.execute("select lesson_id, text, pos_sec, updated_ts from notes"):
            txt = (r["text"] or "").strip()
            if not txt:
                continue
            les = ""
            try:
                les = (datahub.find_lesson(datahub.proto(), r["lesson_id"]) or {}).get("name") or ""
            except Exception:
                pass
            out.append({"source": "note", "ref": str(r["lesson_id"]),
                        "subject": (str(r["lesson_id"]).split("-")[0] or None),
                        "kind": "笔记", "title": _clean(txt, 34),
                        "text": _clean(("%s %s" % (les, txt)), 800)})
    except Exception:
        pass

    # 7) 画布（XMind 式的知识图）：把整棵树摊成一段文字再编
    try:
        c = _conn()

        def _flatten(node, buf, dep=0):
            if isinstance(node, dict):
                t = node.get("text") or node.get("title") or ""
                if t:
                    buf.append(("  " * dep) + str(t))
                for ch in node.get("children") or []:
                    _flatten(ch, buf, dep + 1)
            elif isinstance(node, list):
                for ch in node:
                    _flatten(ch, buf, dep)

        for r in c.execute("select id, lesson_id, title, tree, updated_ts from canvas_maps"):
            buf = []
            try:
                _flatten(json.loads(r["tree"] or "{}"), buf)
            except Exception:
                pass
            txt = " / ".join(x.strip() for x in buf if x.strip())[:900]
            if not txt:
                txt = r["title"] or ""
            if not txt:
                continue
            out.append({"source": "canvas", "ref": str(r["id"]),
                        "subject": (str(r["lesson_id"] or r["id"]).split("-")[0] or None),
                        "kind": "画布", "title": _clean(r["title"] or txt, 34),
                        "text": _clean(txt, 900)})
    except Exception:
        pass

    # 8) 词书（7846 条）。单独标成「单词」，默认不混进语义检索 ——
    #    找词本来就有专门工具（搜中文释义 / 词详情 / 词书列表），7846 条词
    #    丢进同一个语义空间会把「虚拟语气」这种问题挤偏。要搜词就 kind="单词"。
    try:
        gw = (datahub.proto().get("vocab") or {}).get("groups_words") or {}
        seen_w = set()
        for unit, words in gw.items():
            for w in words or []:
                word = str(w.get("w") or "").strip()
                if not word or word.lower() in seen_w:
                    continue
                seen_w.add(word.lower())
                cn = str(w.get("cn") or "").strip()
                out.append({"source": "word", "ref": word.lower(), "subject": "english",
                            "kind": "单词", "title": "%s %s" % (word, cn[:16]),
                            "text": _clean("%s %s %s %s" % (word, w.get("ph") or "",
                                                            w.get("pos") or "", cn), 200)})
    except Exception:
        pass
    return out


def build(subjects=None, only_if_empty=False):
    """把现有内容全量过一遍（hash 没变的会跳过，所以重复跑很便宜）。"""
    c = _conn()
    ensure_schema(c)
    if only_if_empty:
        n = c.execute("select count(*) from kb_item").fetchone()[0]
        if n:
            return {"ok": True, "skipped": True, "items": n, "note": "已经有 %d 条，没动" % n}
    items = collect(subjects)
    st = put_many(items)
    total = c.execute("select count(*) from kb_item where vec is not null").fetchone()[0]
    return {"ok": True, "collected": len(items),
            "added": st["added"], "updated": st["updated"], "skipped": st["skipped"],
            "failed": st["failed"], "indexed": total}


def stats():
    """家底：多少条、分几类、占多少空间、模型是哪个。"""
    c = _conn()
    ensure_schema(c)
    total = c.execute("select count(*) from kb_item").fetchone()[0]
    ready = c.execute("select count(*) from kb_item where vec is not null").fetchone()[0]
    by_kind = {}
    for k, n in c.execute("select kind, count(*) from kb_item group by kind order by 2 desc"):
        by_kind[k or "(未标)"] = n
    by_sub = {}
    for k, n in c.execute("select subject, count(*) from kb_item group by subject order by 2 desc"):
        by_sub[k or "(未标)"] = n
    bytes_ = c.execute("select sum(length(vec)) from kb_item").fetchone()[0] or 0
    return {"total": total, "ready": ready, "by_kind": by_kind, "by_subject": by_sub,
            "vec_mb": round(bytes_ / 1048576, 2), "model": MODEL_NAME, "dim": _dim,
            "loaded": _mdl is not None, "why": None if _mdl is not None else _load_err}
