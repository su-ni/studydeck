# -*- coding: utf-8 -*-
"""文件与库的通用读写。

为什么要这一层：
原来每加一个功能就加一个工具（排课要 plan_set_budget、加课要 course_add、
改配置要 ai_apikey_set…），工具涨到 175 个还是不敷用——用户想改的东西永远比
预埋的工具多一条。于是换个做法：给它看和改的能力本身。

四条边界，除此之外不设限：
  1. 只能在应用目录（研学台/）内活动，`..` 爬不出去；
  2. data/ai_cred 不给看（那是 OAuth 凭据，读进上下文只会白烧 token）；
  3. 写之前先备份到 data/backup/fs/，写用临时文件 + 原子替换，半截文件不会落地；
  4. 单次读/写有体积上限，超了就分段，不静默截断（截断会让模型以为文件就这么多）。
"""
import fnmatch
import functools
import hashlib
import os
import re
import shutil
import sqlite3
import threading
import time

from . import config, docs

ROOT = config.APP_DIR            # 相对路径的基准：研学台/
LIMIT = config.PROJECT_ROOT      # 项目根（相对路径用 ../ 能上到这里）

# 挡的是「读进来只会白烧 token 或害人」的东西，不是「不许出门」。
# 2026-10-30 用户驳回了一版「只能在项目内活动」的限制：他要拖文件夹、发截图、
# 粘一条 F 盘以外的路径。所以现在**全盘可读**，只这几处除外。
DENY_ABS = (
    "data/ai_cred",        # 本机 OAuth 令牌
    ".ssh", ".aws", ".gnupg", ".config/gcloud",   # 密钥
    "AppData/Local/Google/Chrome/User Data",       # 浏览器登录态
    "AppData/Roaming/Microsoft/Credentials",
)
# 这些地方**能读不能写**：改了要么把系统弄坏，要么把别人的软件弄坏，
# 不可能是本意。其余的盘随便写（写前都备份）。
WRITE_DENY_ABS = ("C:/Windows", "C:/Program Files", "C:/Program Files (x86)",
                  "C:/ProgramData", "/System", "/usr", "/etc", "/bin")

MAX_READ = 400 * 1024          # 一次读这么多字
MAX_WRITE = 4 * 1024 * 1024    # 一次写这么多字
MAX_LS = 400
BACKUP_KEEP = 60               # 备份留最近这么多份
DOC_SPAN = 60000               # 文档一次给这么多字（约 3 万汉字，够读一章）
DOC_MAX = 3000000              # 单份文档最多拆这么多字，超了截断并说明

_DOC_CACHE = {}
_DOC_LOCK = threading.Lock()

_BIN_EXT = (".mp4", ".mkv", ".webm", ".zip", ".7z", ".gz", ".png", ".jpg", ".jpeg",
            ".gif", ".webp", ".woff", ".woff2", ".ttf", ".bin", ".onnx", ".pt", ".db")


# ------------------------------------------------------------------ 路径
def _deny_abs():
    """绝对化的禁读清单。`data/ai_cred` 相对项目，其余相对用户主目录。"""
    home = os.path.expanduser("~")
    out = []
    for d in DENY_ABS:
        base = ROOT if d.startswith("data/") else home
        out.append(os.path.abspath(os.path.join(base, d)))
    return out


def _in(full, base):
    a = full.replace("\\", "/").rstrip("/").lower()
    b = base.replace("\\", "/").rstrip("/").lower()
    return a == b or a.startswith(b + "/")


def _safe(rel, for_write=False):
    """把用户给的路径解析成绝对路径。

    相对路径以 研学台/ 为基准（`data/plan.json` 就是它），绝对路径照直用 ——
    用户拖进来的截图可能在 D 盘、桌面、微信缓存里，那些都得能读。
    只挡两样：读进来纯属有害的（令牌/密钥/浏览器登录态），
    和写进去一定出事的（系统目录）。别的都放行。
    """
    rel = (rel or ".").replace("\\", "/").strip()
    if re.match(r"^[A-Za-z]:", rel) or rel.startswith("/"):
        full = os.path.abspath(rel)
    else:
        full = os.path.abspath(os.path.join(ROOT, rel))
    for bad in _deny_abs():
        if _in(full, bad):
            raise ValueError("这一块不给读写：%s（本机凭据，读了只会白烧上下文）"
                             % os.path.basename(bad))
    if for_write:
        for bad in WRITE_DENY_ABS:
            if _in(full, bad):
                raise ValueError("%s 是系统目录，只给读不给写 —— 改坏的是整台机器" % bad)
    return full


def _rel(full):
    """项目内给相对路径（好写），项目外给绝对路径。

    以前一律 relpath，结果 F:/tmp/x 显示成 `../../../tmp/x` —— 模型以为自己还在
    项目附近，会顺手再拼一次 `../`，越走越远。
    """
    try:
        r = os.path.relpath(full, ROOT).replace("\\", "/")
    except ValueError:
        return full.replace("\\", "/")
    return r if not r.startswith("..") else full.replace("\\", "/")


def _is_bin(path):
    return path.lower().endswith(_BIN_EXT)


# ------------------------------------------------------------------ 看
def ls(rel=".", pattern=None):
    """列一层目录。给的是真 stat，不是猜的。"""
    full = _safe(rel)
    if not os.path.exists(full):
        return {"ok": False, "error": "没有这个路径：%s" % rel}
    if os.path.isfile(full):
        return {"ok": True, "path": _rel(full), "type": "file",
                "size": os.path.getsize(full),
                "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(full)))}
    out = []
    try:
        names = sorted(os.listdir(full))
    except OSError as e:
        return {"ok": False, "error": "读不了这个目录：%s" % e}
    for n in names:
        if pattern and not fnmatch.fnmatch(n, pattern):
            continue
        p = os.path.join(full, n)
        try:
            st = os.stat(p)
            isdir = os.path.isdir(p)
        except OSError:
            continue
        out.append({"name": n + ("/" if isdir else ""), "dir": isdir,
                    "size": 0 if isdir else st.st_size,
                    "mtime": time.strftime("%m-%d %H:%M", time.localtime(st.st_mtime))})
        if len(out) >= MAX_LS:
            break
    return {"ok": True, "path": _rel(full) or ".", "type": "dir",
            "count": len(out), "items": out,
            "note": ("超过 %d 条只列了前面这些，用 pattern 收窄" % MAX_LS) if len(out) >= MAX_LS else ""}


def _read_doc(full, kind, start=1):
    """文档：拆出全文，按字符窗口给。拆开的全文缓存住 ——
    一本 PDF 拆一次要好几秒，模型连着问三句不该拆三遍。"""
    st = os.stat(full)
    key = (full, int(st.st_mtime), st.st_size)
    with _DOC_LOCK:
        hit = _DOC_CACHE.get(key)
    if hit is None:
        hit = docs.extract(full, max_chars=DOC_MAX)
        with _DOC_LOCK:
            if len(_DOC_CACHE) > 6:      # 只留最近几份，别把内存吃穿
                _DOC_CACHE.clear()
            _DOC_CACHE[key] = hit
    if not hit.get("ok"):
        return {"ok": False, "path": _rel(full), "kind": hit.get("kind"),
                "size": hit.get("size"), "error": hit.get("error")}

    text = hit["text"]
    total = len(text)
    off = max(0, int(start or 1) - 1)
    if off >= total:
        return {"ok": False, "error": "start=%d 超过全文长度（共 %d 字）" % (off + 1, total)}
    body = text[off:off + DOC_SPAN]
    more = off + len(body) < total
    return {"ok": True, "path": _rel(full), "kind": hit["kind"], "chars": total,
            "from": off + 1, "to": off + len(body), "truncated": more,
            "content": body,
            "note": ("这是 %s，共 %d 字。还剩 %d 字 —— 接着读就把 start 设成 %d"
                     % (hit["kind"], total, total - off - len(body), off + len(body) + 1))
                    if more else ("这是 %s，共 %d 字，已经读到末尾" % (hit["kind"], total))}


def read(rel, start=1, lines=400):
    """读文件。

    纯文本按行读（带行号）；docx / pdf / xlsx / pptx / odt / epub / rtf 走 docs 拆成字。
    文档模式下 `start` 是**字符位置**（不是行号），一次最多给 DOC_SPAN 字 ——
    一本书几十万字，一次全塞进去窗口就爆了，所以分段并说明还剩多少。
    """
    full = _safe(rel)
    if not os.path.exists(full):
        return {"ok": False, "error": "没有这个文件：%s" % rel}
    if os.path.isdir(full):
        return {"ok": False, "error": "%s 是目录，用 fs_ls 列它" % rel}

    kind = docs.kind_of(full)
    if kind not in ("text", "unknown"):
        return _read_doc(full, kind, start)

    if _is_bin(full):
        return {"ok": False, "error": "%s 是二进制/媒体文件（%d 字节），这里只读文本"
                                     % (_rel(full), os.path.getsize(full))}
    size = os.path.getsize(full)
    if size > MAX_READ:
        return {"ok": False, "error": "文件 %d 字节，超过单次上限 %d。用 start/lines 分段读，"
                                      "或先用 fs_grep 定位" % (size, MAX_READ)}
    for enc in ("utf-8", "utf-8-sig", "gbk"):
        try:
            with open(full, "r", encoding=enc) as f:
                all_lines = f.read().splitlines()
            break
        except UnicodeDecodeError:
            continue
    else:
        return {"ok": False, "error": "%s 不是能按文本读的文件" % _rel(full)}

    total = len(all_lines)
    start = max(1, int(start or 1))
    lines = max(1, min(int(lines or 400), 4000))
    chunk = all_lines[start - 1:start - 1 + lines]
    body = "\n".join("%5d| %s" % (start + i, ln) for i, ln in enumerate(chunk))
    return {"ok": True, "path": _rel(full), "total_lines": total,
            "start": start, "end": start + len(chunk) - 1,
            "truncated": start + len(chunk) - 1 < total,
            "content": body}


def grep(pattern, rel=".", glob=None, limit=80):
    """按正则搜。返回命中的行，带行号——搜完直接去 fs_read 那几行改。"""
    full = _safe(rel)
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return {"ok": False, "error": "正则写错了：%s" % e}
    limit = max(1, min(int(limit or 80), 300))
    hits = []
    scanned = 0

    def scan(p):
        nonlocal scanned
        if len(hits) >= limit:
            return
        if os.path.getsize(p) > MAX_READ or _is_bin(p):
            return
        scanned += 1
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                for i, ln in enumerate(f, 1):
                    if rx.search(ln):
                        hits.append({"file": _rel(p), "line": i, "text": ln.rstrip()[:400]})
                        if len(hits) >= limit:
                            return
        except OSError:
            return

    if os.path.isfile(full):
        scan(full)
    else:
        for dirpath, dirnames, filenames in os.walk(full):
            dirnames[:] = [d for d in dirnames
                           if d not in ("node_modules", ".git", "__pycache__", "app-dist", "models")]
            for n in filenames:
                if glob and not fnmatch.fnmatch(n, glob):
                    continue
                if len(hits) >= limit:
                    break
                scan(os.path.join(dirpath, n))
    return {"ok": True, "pattern": pattern, "hits": hits, "count": len(hits),
            "files_scanned": scanned,
            "note": ("命中到上限 %d 条，收窄 pattern 能看全" % limit) if len(hits) >= limit else ""}


# ------------------------------------------------------------------ 改
def _backup(full, daily=False):
    """写之前留一份。备份失败也不拦着用户改文件，但要如实说出来。

    daily=True 时一天最多一份（库文件几十兆，一天十份会撑爆盘）。
    """
    if not os.path.exists(full):
        return None
    try:
        d = os.path.join(config.APP_DATA_DIR, "backup", "fs")
        os.makedirs(d, exist_ok=True)
        stamp = time.strftime("%Y%m%d") if daily else time.strftime("%Y%m%d_%H%M%S")
        # 路径加 6 位指纹：现在能改项目外的文件了，光靠文件名会在备份目录里撞车
        tag = hashlib.md5(os.path.abspath(full).encode("utf-8")).hexdigest()[:6]
        dst = os.path.join(d, "%s__%s__%s" % (stamp, tag, os.path.basename(full)))
        if daily and os.path.exists(dst):
            return _rel(dst) if dst.startswith(ROOT) else dst
        shutil.copy2(full, dst)
        olds = sorted((os.path.join(d, n) for n in os.listdir(d)), key=os.path.getmtime)
        for p in olds[:-BACKUP_KEEP]:
            try:
                os.remove(p)
            except OSError:
                pass
        return _rel(dst) if dst.startswith(ROOT) else dst
    except Exception:
        return None


def _atomic_write(full, text):
    os.makedirs(os.path.dirname(full) or ROOT, exist_ok=True)
    tmp = full + ".sdtmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, full)


def write(rel, content, append=False):
    """整份覆盖或追加。返回改了多少字节、备份到哪儿——这些都要如实报给界面。"""
    content = "" if content is None else str(content)
    b = content.encode("utf-8")
    if len(b) > MAX_WRITE:
        return {"ok": False, "error": "内容 %d 字节超过单次上限 %d" % (len(b), MAX_WRITE)}
    full = _safe(rel, True)
    if os.path.isdir(full):
        return {"ok": False, "error": "%s 是目录" % rel}
    existed = os.path.exists(full)
    before = os.path.getsize(full) if existed else 0
    bak = _backup(full)
    try:
        if append and existed:
            with open(full, "a", encoding="utf-8", newline="\n") as f:
                f.write(content)
        else:
            _atomic_write(full, content)
    except OSError as e:
        return {"ok": False, "error": "写不进去：%s" % e}
    after = os.path.getsize(full)
    return {"ok": True, "path": _rel(full), "created": not existed, "append": bool(append),
            "bytes_before": before, "bytes_after": after, "backup": bak}


def edit(rel, old, new, replace_all=False):
    """精确替换。`old` 不唯一就拒绝——宁可让模型再说清楚点，也不要它改错地方。"""
    got = read(rel, 1, 4000)
    if not got.get("ok"):
        return got
    if got.get("truncated"):
        return {"ok": False, "error": "文件有 %d 行，超过一次能读的范围，改不了。"
                                      "用 fs_write 整份重写，或先分段确认" % got["total_lines"]}
    full = _safe(rel, True)
    with open(full, "r", encoding="utf-8") as f:
        text = f.read()
    hits = text.count(old)
    if hits == 0:
        return {"ok": False, "error": "文件里没有这段原文，一个字都没改。"
                                      "先用 fs_grep 或 fs_read 核对原文（空格缩进也算）"}
    if hits > 1 and not replace_all:
        return {"ok": False, "error": "这段原文出现了 %d 次，不敢替你猜改哪一处。"
                                      "写长一点让它唯一，或明确要 replace_all" % hits}
    out = text.replace(old, new) if replace_all else text.replace(old, new, 1)
    bak = _backup(full)
    try:
        _atomic_write(full, out)
    except OSError as e:
        return {"ok": False, "error": "写不进去：%s" % e}
    return {"ok": True, "path": _rel(full), "replaced": hits if replace_all else 1,
            "backup": bak, "bytes_before": len(text.encode("utf-8")),
            "bytes_after": os.path.getsize(full)}


# ------------------------------------------------------------------ 库
_RO_HEAD = ("select", "with", "pragma", "explain")


def _ro(sql):
    head = (sql or "").strip().lstrip("(").split(None, 1)
    return bool(head) and head[0].lower() in _RO_HEAD


def sql(query, params=None, db="data/study.db", limit=200, write=False):
    """直接对 SQLite 说话。改数据要显式写 write=True（工具层据此要确认）。

    只跑一条语句：多语句拼在一起最容易「改了一半才发现第 3 条写错」。
    """
    q = (query or "").strip().rstrip(";")
    if not q:
        return {"ok": False, "error": "SQL 是空的"}
    if ";" in q:
        return {"ok": False, "error": "一次只跑一条语句（检测到分号）。分几次来"}
    path = _safe(db or "data/study.db", True)
    if not os.path.exists(path):
        return {"ok": False, "error": "没有这个库：%s" % db}
    ro = _ro(q)
    if not ro and not write:
        return {"ok": False, "error": "这条会改库（%s 开头），要写就得走 db_exec"
                                      % (q.split(None, 1) or ["?"])[0]}
    bak = None
    if not ro:
        # 库是按天留一份：一天里改十次不用十份 38MB 的副本，但改坏了能回到今天开头
        bak = _backup(path, daily=True)
    con = None
    try:
        con = sqlite3.connect(path, timeout=8)
        if ro:
            # Windows 上 file:...?mode=ro 的盘符容易出岔子，用 query_only 更稳
            con.execute("PRAGMA query_only=1")
        con.row_factory = sqlite3.Row
        cur = con.execute(q, list(params or []))
        if ro:
            rows = [dict(r) for r in cur.fetchmany(max(1, min(int(limit or 200), 2000)))]
            cols = [d[0] for d in (cur.description or [])]
            con.close()
            return {"ok": True, "mode": "read", "db": _rel(path), "columns": cols,
                    "rows": rows, "count": len(rows),
                    "note": ("只取了前 %d 行，用 limit 调大" % limit) if len(rows) >= limit else ""}
        n = cur.rowcount
        con.commit()
        con.close()
        return {"ok": True, "mode": "write", "db": _rel(path), "affected": n,
                "backup": bak, "sql": q[:200]}
    except sqlite3.Error as e:
        try:
            if con is not None:
                con.close()
        except Exception:
            pass
        return {"ok": False, "error": "SQLite 说：%s" % e}


# ------------------------------------------------------------------ 别抛给前端
# 工具层的约定是「出错就回 ok=False + error，别把 500 甩到界面上」。
# 越界、没权限、路径里有非法字符这些都是预料之中的拒绝，不是崩溃。
def _guarded(fn):
    @functools.wraps(fn)
    def inner(*a, **kw):
        try:
            return fn(*a, **kw)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        except OSError as e:
            return {"ok": False, "error": "文件系统说：%s" % e}
        except Exception as e:  # 兜底：宁可回一句话，也不要 500
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    return inner


for _f in (ls, read, grep, write, edit, sql):
    globals()[_f.__name__] = _guarded(_f)
