# -*- coding: utf-8 -*-
"""本机播放缓存 + 后台预热队列。

为什么要有这一层：
  B 站 dash 是「视频轨 + 音频轨」两路，浏览器播不了；得先拉下来合成本地 mp4
  （-c copy + faststart）。以前这一步发生在「点播放」那一刻 —— 每换一讲，
  人都要盯着「正在合成」等十几秒到半分钟，171 讲就是 171 次等待。

  现在把「合」和「看」拆开：一进课堂，当前这一讲立刻排进后台队列；
  正在看第 N 讲的时候，N+1、N+2 已经在合了。人只在第一次真正要播的那一讲上等。

规矩（都是踩过的）：
  · 一个工人串行。ffmpeg 拷流不重，但下发吃带宽，并发只会把正在看的那一讲拖卡。
  · 同一讲只排一次。排过的不会再排，否则点两下就排两条。
  · 同一讲上锁：浏览器同步请求碰上「正在合这一讲」，等它做完就好，不能重合成一份
    写同一个临时文件。
  · 缓存按 SD_STREAM_GB（默认 20GB）清最老的；正在播的和队列里排着的不清。
  · 预热失败不吵人。记一笔，等真播的时候还走原来的同步路径，该怎么报怎么报。
  · 目录从 config 现取，不在模块顶层固化 —— config 会被 config.local.json 改掉
    （空库实例 data-blank），固化就是写到别的实例的缓存里。
"""
import os
import queue
import subprocess
import threading
import time

from . import config

FFMPEG = os.environ.get("SD_FFMPEG") or "F:/ffmpeg/bin/ffmpeg.exe"
Q_DEFAULT = 64
Q_FALLBACK = (64, 32, 16)
# 跟 main._UP_HEADERS 同一份：B 站直链要 Referer，少了就是 403。
# 不复用那个常量是为了不反向 import main —— main 已经 import 本模块。
UP_HEADERS = {"Referer": "https://www.bilibili.com/",
              "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                             "AppleWebKit/537.36 (KHTML, like Gecko) "
                             "Chrome/120.0.0.0 Safari/537.36")}


def stream_dir():
    return os.path.join(config.APP_DATA_DIR, "stream")


def path_of(lesson_id, q):
    return os.path.join(stream_dir(), "%s.q%s.mp4" % (lesson_id, q))


def ready(lesson_id, q=Q_DEFAULT):
    """这一讲这一档已经合好了没。回 (path, size)，没有就 (None, 0)。"""
    p = path_of(lesson_id, q)
    try:
        if os.path.exists(p):
            n = os.path.getsize(p)
            if n > 10240:
                return p, n
    except OSError:
        pass
    return None, 0


def ready_any(lesson_id, q=Q_DEFAULT):
    """先看要的那一档，再看降级档（1080 没合过但 480 合过就别再合一遍）。

    回 (path, size, q)。都没有就 (None, 0, q)。
    """
    p, n = ready(lesson_id, q)
    if p:
        return p, n, q
    for alt in Q_FALLBACK:
        if alt == q:
            continue
        p, n = ready(lesson_id, alt)
        if p:
            return p, n, alt
    return None, 0, q


def cached_count(lesson_ids, q=Q_DEFAULT):
    """这些讲次里有几讲已经能秒开。界面「已备好 12 / 40 讲」就取这个数。"""
    n = 0
    for lid in lesson_ids or []:
        p, _n, _alt = ready_any(lid, q)
        if p:
            n += 1
    return n


# ---------------------------------------------------------------- 合成

def _fetch_track(url, dest):
    """把一条轨拉成本地 m4s。已经下过就跳过。"""
    import urllib.request
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        return dest
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers=UP_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    return dest


def build(lesson_id, q, video, audio):
    """两条轨 → 一个能拖着看的 mp4。同步做，几十秒（一讲约 30MB~900MB）。

    同一讲同一画质只做一次；之后再打开直接吃缓存。
    """
    d = stream_dir()
    os.makedirs(d, exist_ok=True)
    vp = _fetch_track(video, os.path.join(d, "%s.q%s.v.m4s" % (lesson_id, q)))
    ap = _fetch_track(audio, os.path.join(d, "%s.q%s.a.m4s" % (lesson_id, q))) if audio else None
    out = os.path.join(d, "%s.q%s.mp4" % (lesson_id, q))
    tmp = out + ".part"
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", vp]
    if ap:
        cmd += ["-i", ap, "-map", "0:v:0", "-map", "1:a:0"]
    else:
        cmd += ["-map", "0:v:0"]
    # faststart：moov 前置，浏览器拿到头就能拖，不用先下完
    # 显式指定容器：临时文件叫 .part，ffmpeg 认不出扩展名
    cmd += ["-c", "copy", "-f", "mp4", "-movflags", "+faststart", tmp]
    r = subprocess.run(cmd, capture_output=True, timeout=900)
    if r.returncode != 0 or not os.path.exists(tmp):
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError((r.stderr or b"").decode("utf-8", "replace")[:200] or "ffmpeg 合流失败")
    os.replace(tmp, out)
    # 轨文件占地方，合完就删 —— 留 mp4 一份就够
    for f in (vp, ap):
        try:
            if f and os.path.exists(f):
                os.remove(f)
        except OSError:
            pass
    trim(out)
    return out


def _tracks(lesson_id, q):
    """问 B 站要这一讲的轨道。回 (video, audio)；本地文件或单文件流回 (None, None)。"""
    from . import bili, tools as T          # 懒 import：tools 顶层就 import 本模块
    sub, les, bvid, pg = T._lesson_point(lesson_id)
    if not les:
        raise RuntimeError("本机没有这一讲：%s" % lesson_id)
    if les.get("local"):
        return None, None
    if not bvid:
        raise RuntimeError("这一讲没记 B 站号，播不了")
    pgs, err = bili.pages(bvid)
    if err:
        raise RuntimeError("取分集目录失败：" + err)
    hit = next((x for x in pgs if int(x.get("page") or 0) == pg), None)
    if not hit:
        raise RuntimeError("这个 bvid 上没有第 %d P" % pg)
    tr, err = bili.track_url(bvid, hit["cid"], q, cookie=T._bili_cookie())
    if err or tr.get("kind") != "dash":
        tr, err = bili.track_url(bvid, hit["cid"], 32, cookie=None)
    if err:
        raise RuntimeError(err)
    if tr.get("kind") != "dash":
        return None, None                   # durl：单文件直连，不用合
    return tr["video"], tr.get("audio")


# ---------------------------------------------------------------- 缓存上限

def trim(keep_path=None, limit_gb=None):
    """合流缓存按总大小清理，最老的先走。

    一讲约 30MB~300MB，一节 900 讲的课能吃掉几十 GB —— 不设上限，
    磁盘迟早被悄无声息塞满。默认 20GB，SD_STREAM_GB 可调。
    队列里排着的（马上要播）不删，删了等于白合。
    """
    try:
        d = stream_dir()
        if not os.path.isdir(d):
            return 0
        cap = float(limit_gb if limit_gb is not None
                    else os.environ.get("SD_STREAM_GB", "20")) * 1024 ** 3
        files = []
        for n in os.listdir(d):
            if not n.endswith(".mp4"):
                continue
            p = os.path.join(d, n)
            try:
                files.append((os.path.getmtime(p), os.path.getsize(p), p))
            except OSError:
                continue
        total = sum(x[1] for x in files)
        if total <= cap:
            return 0
        keep_abs = os.path.abspath(keep_path) if keep_path else None
        with _lock:
            keep_ids = set(_seen)
        files.sort()
        freed = 0
        for _, sz, p in files:
            if total - freed <= cap * 0.8:      # 一次清到八成就停，不反复清
                break
            if keep_abs and os.path.abspath(p) == keep_abs:
                continue
            lid = os.path.basename(p).split(".q")[0]
            if lid in keep_ids:
                continue
            try:
                os.remove(p)
                freed += sz
            except OSError:
                pass
        return freed
    except Exception:
        return 0


# ---------------------------------------------------------------- 后台队列

_QUE = queue.Queue()
_seen = set()
_locks = {}
_lock = threading.Lock()
_thread = None
_state = {"busy": None, "done": 0, "fail": 0, "queued": 0, "skipped": 0, "msg": ""}
# 「人还在学」的唯一判据：最近有没有播放打点。没人看的时候后台还在合，
# 就是白占带宽和磁盘 —— 一门课 900 讲合完能把 20GB 顶满，人却早就去睡了。
_active = {"ts": 0.0, "lid": None}


def mark_active(lesson_id=None):
    """有人在这儿看。进课堂、每次播放打点都会叫一下。"""
    _active["ts"] = time.time()
    if lesson_id:
        _active["lid"] = lesson_id


def active_recent(win=900):
    return (time.time() - _active["ts"]) < win


def _lock_of(lid):
    """每讲一把锁。同步播放请求和预热线程撞在同一讲上时，后者等前者，不并写。"""
    with _lock:
        l = _locks.get(lid)
        if l is None:
            l = _locks[lid] = threading.Lock()
        return l


def ensure(lesson_id, q=Q_DEFAULT, tr=None):
    """保证这一讲在本机能拖：有缓存直接回，没有就合。

    回路径；本地文件 / 单文件流 / 取不到轨道时回 None（调用方自己决定怎么播）。
    """
    p, _ = ready(lesson_id, q)
    if p:
        return p
    with _lock_of(lesson_id):
        p, _ = ready(lesson_id, q)
        if p:
            return p
        if tr and tr.get("kind") == "dash":
            video, audio = tr["video"], tr.get("audio")
            qq = tr.get("quality") or q
        else:
            video, audio = _tracks(lesson_id, q)
            qq = q
        if not video:
            return None
        return build(lesson_id, qq, video, audio)


def _worker():
    while True:
        lid = _QUE.get()
        try:
            # 人已经走了（15 分钟没有播放打点）：剩下的不合了。
            # 队列要当场清干净，否则人下次回来会看到「在合第 37 讲」这种莫名其妙的进度。
            if not active_recent():
                with _lock:
                    _state["skipped"] += 1
                    _seen.discard(lid)
                continue
            with _lock:
                _state["busy"] = lid
            try:
                got = ensure(lid, Q_DEFAULT)
                with _lock:
                    if got:
                        _state["done"] += 1
                    _state["msg"] = ""
            except Exception as e:
                with _lock:
                    _state["fail"] += 1
                    _state["msg"] = str(e)[:140]
            finally:
                with _lock:
                    _state["busy"] = None
                    _seen.discard(lid)
        finally:
            _QUE.task_done()


def _start():
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_worker, name="stream-warm", daemon=True)
    _thread.start()


def warm(lesson_ids, q=Q_DEFAULT):
    """把还没缓存的讲排进后台。已经在队列或缓存里的跳过，回真排进去的条数。"""
    added = 0
    with _lock:
        for lid in lesson_ids or []:
            if not lid or lid in _seen:
                continue
            p, _n, _alt = ready_any(lid, q)
            if p:
                continue
            _seen.add(lid)
            _QUE.put(lid)
            added += 1
        _state["queued"] += added
    if added:
        _start()
    return added


def pending():
    """队列里还有几讲没合（含正在合的那一讲）。"""
    with _lock:
        return _QUE.qsize() + (1 if _state["busy"] else 0)


def status():
    """给界面和工具看的真数：队列、已完成、失败、缓存占用。"""
    with _lock:
        st = dict(_state)
        st["pending"] = _QUE.qsize() + (1 if _state["busy"] else 0)
    try:
        d = stream_dir()
        n = 0
        b = 0
        for f in os.listdir(d):
            if not f.endswith(".mp4"):
                continue
            try:
                n += 1
                b += os.path.getsize(os.path.join(d, f))
            except OSError:
                pass
        st["files"] = n
        st["bytes"] = b
    except Exception:
        st["files"] = 0
        st["bytes"] = 0
    st["cap_gb"] = float(os.environ.get("SD_STREAM_GB", "20"))
    st["ffmpeg"] = os.path.exists(FFMPEG)
    return st
