# -*- coding: utf-8 -*-
"""研学台 · 服务入口。

    python -m server.main          # 或  start.bat
    → http://127.0.0.1:8770
"""
import asyncio
import io
import json
import os
import re
import subprocess
import time
import sys
import urllib.parse
import urllib.request

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (HTMLResponse, JSONResponse, FileResponse, PlainTextResponse,
                               RedirectResponse, StreamingResponse)
from fastapi.staticfiles import StaticFiles

if __package__ in (None, ""):                       # 允许 python server/main.py 直接跑
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from server import (agent, asr, bili, config, context, datahub, notesrc, perm, platform_ai,
                        store, streamer, tools, xmind)
else:
    from . import (agent, asr, bili, config, context, datahub, notesrc, perm, platform_ai,
                   store, streamer, tools, xmind)

app = FastAPI(title="研学台 StudyDeck")

store.init()
datahub.seed_legacy_mem()


@app.get("/api/health")
def health():
    return {"ok": True, "db": config.DB_PATH, "proto": config.PROTO_DATA,
            "proto_exists": os.path.exists(config.PROTO_DATA),
            "generated_at": store.now()}


# ---------------------------------------------------------------------------
# 语音转文字
# 模型不进启动路径：这三个接口是唯一入口，没人调 → 一个字节都不加载。
# 音频走原始 body，不经 JSON —— base64 会让 5 分钟录音多撑三分之一体积。
# ---------------------------------------------------------------------------
@app.get("/api/asr/status")
def api_asr_status():
    return asr.status()


@app.post("/api/asr/setup")
def api_asr_setup(req: dict | None = None):
    force = bool((req or {}).get("force"))
    return asr.setup_async(force=force)


@app.post("/api/asr/unload")
def api_asr_unload():
    asr.unload()
    return {"ok": True, "say": "语音模型已从内存放掉"}


@app.post("/api/asr/transcribe")
async def api_asr_transcribe(request: Request):
    data = await request.body()
    if len(data) > 40 * 1024 * 1024:
        raise HTTPException(413, "音频太大（上限 40MB）")
    r = asr.transcribe(data, request.headers.get("content-type", ""))
    return r


# 实时：前端每 ~100ms 送一块 Int16 PCM，够一句就转出来。
# 转写是阻塞的（几百毫秒），走线程池，别把事件循环卡住 ——
# 卡住的话前端那些并发的小块会排队排到天荒地老。
@app.post("/api/asr/live/start")
def api_asr_live_start(sid: str):
    return asr.live_start(sid)


@app.post("/api/asr/live/feed")
async def api_asr_live_feed(sid: str, request: Request, rate: int = 48000):
    data = await request.body()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "单块太大")
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(asr.live_feed, sid, data, rate)


@app.post("/api/asr/live/finish")
def api_asr_live_finish(sid: str):
    return asr.live_finish(sid)


@app.get("/api/base")
def api_base():
    """首屏快照：不含 3790 词全量分组与 781 题正文（那两块按需走工具取）。"""
    d = datahub.bootstrap()
    d["tools"] = tools.registry_public()      # 工具注册表（Agent 工具台要用）
    d["confirm_tools"] = sorted(config.CONFIRM_TOOLS)
    d["brand"] = {"title": config.APP_TITLE, "subtitle": config.APP_SUBTITLE}
    return d


@app.get("/api/tools")
def api_tools():
    return {"tools": tools.registry_public(),
            "confirm_tools": sorted(config.CONFIRM_TOOLS),
            "recent": store.recent_tool_calls(12)}


@app.get("/api/build")
def api_build():
    """前端版本号：三个静态文件的最新 mtime，页面拿它自证「我看到的是不是最新版」。"""
    stamp = 0
    for name in ("index.html", "app.js", "app.css", "canvas.css", "canvas.js"):
        try:
            stamp = max(stamp, int(os.path.getmtime(os.path.join(config.WEB_DIR, name))))
        except OSError:
            pass
    return {"stamp": stamp,
            "build": time.strftime("%Y%m%d-%H%M", time.localtime(stamp)) if stamp else ""}


@app.get("/api/perm")
async def api_perm_get():
    """权限档当前是哪一档。界面用它画开关。"""
    return {"ok": True, **perm.state()}


@app.post("/api/perm")
async def api_perm_set(request: Request):
    """换档。**只给人用** —— 没注册成工具，模型自己调不到，拧不大自己的权限。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    r = perm.set_mode(body.get("mode"))
    return {"ok": r.get("ok"), **perm.state(), "note": r.get("note"),
            "error": r.get("error")}


@app.post("/api/tool/{name}")
async def api_tool(name: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    args = body.get("args") or {}
    confirmed = bool(body.get("confirm"))
    return tools.call(name, args, confirmed=confirmed)


@app.post("/api/tool/{name}/run")
async def api_tool_run(name: str, request: Request):
    """跑一个工具，**把过程推出来**（SSE）。

    为什么非要有这条：卡片上的按钮原来是一次静默 callTool —— 点下去界面只有
    「执行中…」三个字，而 intake_pick 要真跑三十秒核六门课。人盯着一动不动的字，
    除了「是不是卡了」没别的可判断。这里把开始 / 中间每一步 / 结果都推出去，
    界面照着画成一条时间线：调了什么、核到第几条、跑了几秒、成没成。

    事件：
      {t:"start", tool, desc, args}          开跑
      {t:"step",  msg, n, total}             中间一步（工具自己 tick 出来的）
      {t:"end",   ok, ms, data, error}       结束，data 是工具原样的回执
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    args = body.get("args") or {}
    confirmed = bool(body.get("confirm"))
    ent = tools.REGISTRY.get(name) or {}

    def _gen():
        import queue as _q
        import threading as _th

        q = _q.Queue()
        box = {}

        def work():
            try:
                r = tools.call(name, args, confirmed=confirmed,
                               progress=lambda d: q.put({"t": "step", **d}))
                box["r"] = r
            except Exception as e:
                import traceback
                traceback.print_exc()
                box["r"] = {"ok": False, "error": "工具炸了：%s" % str(e)[:200], "data": {}}
            q.put({"__end__": True})

        yield "data: " + json.dumps({"t": "start", "tool": name,
                                     "desc": ent.get("desc") or "",
                                     "perm": ent.get("perm") or "",
                                     "args": args},
                                    ensure_ascii=False) + "\n\n"
        th = _th.Thread(target=work, daemon=True)
        th.start()
        t0 = time.time()
        while True:
            try:
                ev = q.get(timeout=3)
            except Exception:
                # 工具自己没吭声也别让人干等：报一个「还在跑 + 真过了几秒」。
                # 这不是假进度 —— 秒数是从开跑算到现在的真实时间。
                yield "data: " + json.dumps({"t": "alive",
                                             "sec": int(time.time() - t0)},
                                            ensure_ascii=False) + "\n\n"
                continue
            if ev.get("__end__"):
                break
            yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"

        r = box.get("r") or {"ok": False, "error": "没有结果", "data": {}}
        data = r.get("data") if isinstance(r.get("data"), dict) else {}
        # 只读按钮也要有产出：搜课 / 拉分集 / 排今日 —— 结果得画成卡片，
        # 不能只报一句「调通了」。跟对话里走的是同一个摘要函数，口径一致。
        try:
            ui = agent._ui_of(name, data)
        except Exception:
            ui = None
        slim = dict(data)
        # intake 那类工具会把整份流水线状态塞回来，几十 KB —— 界面用不上，别顺着管子推。
        if len(json.dumps(slim, ensure_ascii=False)) > 8000:
            slim.pop("state", None)
        yield "data: " + json.dumps({"t": "end", "ok": bool(r.get("ok")),
                                     "ms": r.get("ms"), "data": slim,
                                     "ui": ui,
                                     "perm": ent.get("perm") or "",
                                     "error": r.get("error"),
                                     "need_confirm": bool(r.get("need_confirm"))},
                                    ensure_ascii=False) + "\n\n"

    return StreamingResponse(_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.post("/api/agent/stop")
async def api_agent_stop():
    """按停正在跑的那一轮：agent 在最近的检查点收口（当前这步跑完就停）。"""
    return agent.request_stop()


@app.post("/api/agent/compact")
async def api_agent_compact(request: Request):
    """上下文压缩开关。body {"on": true/false}，不给就默认打开。

    返回的是真折叠出来的数字（数出来的条数），不是"已优化"这种话。
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    on = body.get("on")
    if on is None:
        on = True
    return agent.set_compact(bool(on))


@app.post("/api/agent/stream")
async def api_agent_stream(request: Request):
    """流式版 agent_turn。边算边推，前端做打字机。

    用 POST（body 里有 text），所以不能走 EventSource，前端用 fetch + ReadableStream。
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    text = (body.get("text") or "").strip()
    confirmed = body.get("confirmed") or None
    focus = body.get("focus") or None
    effort = body.get("effort") or None      # low/medium/high；不传就用上次存的那档
    resuming = bool(body.get("resume"))      # 续跑：把上一轮没干完的活接着干

    import queue as _q
    import threading as _th

    def _gen():
        q = _q.Queue()
        done = {}

        def sink(piece):
            # 两种东西都从这根管子过：模型吐的字（str）和工具轨迹（dict）。
            # 无脑包成 token 会把轨迹包坏，前端拿到一个既不是字也不是轨迹的东西。
            if isinstance(piece, dict):
                q.put(piece)
            elif piece:
                q.put({"t": "token", "d": piece})

        def work():
            try:
                if resuming:
                    # 续跑不带新话：agent.resume() 自己会把最后那句用户话重放一遍
                    r = agent.resume(sink=sink, effort=effort)
                else:
                    r = agent.turn(text, confirmed=confirmed, focus=focus, sink=sink, effort=effort)
                done["r"] = r
            except Exception as e:                      # 不让异常把连接掐死
                # 留一份完整堆栈：只回一句「算崩了：xxx」的话，
                # 这种 AttributeError 根本没法定位到是哪一行。
                try:
                    import traceback
                    traceback.print_exc()
                except Exception:
                    pass
                done["r"] = {"ok": False, "error": "算崩了：%s" % str(e)[:200]}
            q.put({"__end__": True})

        th = _th.Thread(target=work, daemon=True)
        th.start()
        # 心跳：模型第一片可能要等好几秒，不发点东西浏览器/代理会以为连接死了
        while True:
            try:
                ev = q.get(timeout=12)
            except Exception:
                yield ": ping\n\n"
                continue
            if ev.get("__end__"):
                break
            yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"

        r = done.get("r") or {"ok": False, "error": "没有结果"}
        trace = r.get("trace") or []
        # 工具轨迹已经由 agent 的 sink 实时推过了（每调完一个立刻推一条），
        # 这里不再重复吐 —— 再吐一遍右栏每行会出现两次。
        end = {"t": "end", "ok": bool(r.get("ok")), "text": r.get("text") or "",
               "trace": trace, "pending": r.get("pending"),
               "provider": r.get("provider"), "model": r.get("model"),
               "rounds": r.get("rounds"), "error": r.get("error"),
               # 轮数上限由后端给，前端不再写死 20 —— 上限改了界面得跟着变
               "max_rounds": agent.MAX_ROUND,
               # 这一轮真跑出来的用量（上游没给就没有，界面据此留空）
               "usage": platform_ai.last_usage(),
               # 上下文怎么拼的：折叠几条、留几条、吃紧时有没有收紧（全是数出来的）
               "ctx": context.status(),
               "stopped": bool(r.get("stopped")),
               "note": r.get("note"), "ask": r.get("ask"),
               # 操作卡也必须推出去：漏了它，界面上就只剩那串 JSON
               "card": r.get("card")}
        yield "data: " + json.dumps(end, ensure_ascii=False) + "\n\n"

    return StreamingResponse(_gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.get("/api/xmind/status")
def api_xmind_status():
    """XMind 云端链路状态：连没连、scope、还有多久过期、token 落在哪。"""
    return xmind.status()


@app.post("/api/xmind/login")
def api_xmind_login():
    """开登录：动态注册 + PKCE，返回官方授权页 URL（同时试着拉起浏览器）。"""
    r = xmind.start_login()
    return r


@app.get("/oauth/xmind/callback")   # 必须跟 xmind.REDIRECT_PATH 一字不差，否则 XMind 跳回来 404
@app.get("/api/xmind/callback")        # 老地址留着兜底：人手工粘进来的可能是这一条
async def api_xmind_callback(request: Request):
    """XMind 授权完跳回来的落点。拿到 code 换 token，然后告诉用户可以关掉这个页。"""
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    err = request.query_params.get("error")
    err_desc = request.query_params.get("error_description") or ""
    if err:
        return HTMLResponse(_xmind_cb_html(False, "XMind 那边没给授权：%s %s" % (err, err_desc)))
    if not code:
        return HTMLResponse(_xmind_cb_html(False, "回调里没有 code"))
    r = xmind.finish_login(code, state)
    if r.get("error"):
        return HTMLResponse(_xmind_cb_html(False, r["error"]))
    return HTMLResponse(_xmind_cb_html(True, "已连上 XMind（scope=%s）" % (r.get("scope") or "")))


@app.post("/api/xmind/code")
async def api_xmind_code(request: Request):
    """人工兜底：授权完如果浏览器没跳回来，把回调 URL（或只把 code）粘进来，这里照样换 token。
    redirect_uri 必须是 127.0.0.1 这个本机地址，公网地址 XMind 不给跳。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = (body.get("url") or body.get("code") or "").strip()
    if not raw:
        return {"ok": False, "error": "没给回调 URL 或 code"}
    code2, state2 = raw, ""
    if "code=" in raw:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query)
        code2 = (q.get("code") or [""])[0]
        state2 = (q.get("state") or [""])[0]
    r = xmind.finish_login(code2, state2)
    if r.get("error"):
        return {"ok": False, "error": r["error"], "detail": r.get("detail") or ""}
    return {"ok": True, "status": xmind.status()}


def _xmind_cb_html(ok, msg):
    color = "#2e9e6b" if ok else "#c0504d"
    return ("<html><body style='font-family:system-ui;padding:40px;background:#faf7f2'>"
            "<div style='max-width:520px;margin:60px auto;background:#fff;border:1px solid #e6e0d6;"
            "border-radius:14px;padding:28px'>"
            "<h2 style='color:%s;margin:0 0 10px'>%s</h2>"
            "<p style='color:#5b5348;line-height:1.7'>%s</p>"
            "<p style='color:#8a8172;font-size:13px'>回到研学台，点「拉 XMind 导图」就能同步。</p>"
            "</div></body></html>" % (color, "连上了" if ok else "没连上", msg))


@app.post("/api/xmind/logout")
def api_xmind_logout():
    """断开：只清本机 token，不动 XMind 云端任何东西。"""
    xmind.clear_token()
    return {"ok": True, "connected": False}


@app.post("/api/event")
async def api_event(request: Request):
    """前端埋点（看视频的秒数、翻卡、切页）。只收白名单 kind，不收任意结构。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    kind = str(body.get("kind") or "")
    if kind not in ("play", "page", "word_card", "exam_tick", "search", "note"):
        return JSONResponse({"ok": False, "error": "不接受的 kind"}, status_code=400)
    store.add_event(kind, subject=body.get("subject"), lesson_id=body.get("lesson_id"),
                    word=body.get("word"), part=body.get("part"),
                    qno=body.get("qno"), seconds=body.get("seconds") or 0,
                    payload=body.get("payload"))
    return {"ok": True}


@app.get("/api/progress")
def api_progress():
    """把本机已完成讲次并回旧进度文件（先备份）。这是管理动作，不是页面数据。"""
    return tools.sync_progress_file()


MEDIA_TYPES = {
    ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
    ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".json": "application/json", ".txt": "text/plain",
}


# 词条素材（百词斩配图 / 变形图）落在 data/cache/word，由服务代理出去：
# 直接把 CDN 地址写进 <img> 会被 CDN 挡（它认 UA 和 Referer），所以先在服务端拉下来。
# 注意：这条必须定义在 /media/{rel:path} 之前，否则会被那条通配路由吃掉。
_WORD_ASSET_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".dat": "audio/mpeg", ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
}


@app.get("/media/word/{name}")
def word_asset(name: str):
    """只放行 data/cache/word 下的白名单扩展名文件，文件名不许带路径分隔符。"""
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="非法文件名")
    ext = os.path.splitext(name)[1].lower()
    if ext not in _WORD_ASSET_TYPES:
        raise HTTPException(status_code=403, detail="不允许的素材类型: %s" % ext)
    path = os.path.join(config.APP_DATA_DIR, "cache", "word", name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="素材不存在: %s" % name)
    return FileResponse(path, media_type=_WORD_ASSET_TYPES[ext], headers={
        "Cache-Control": "public, max-age=604800",
    })


@app.get("/media/{rel:path}")
def media(rel: str):
    """本机课程文件（视频 / 音频 / 讲义 PDF）。只允许白名单扩展名，且锁在项目根目录内。"""
    try:
        path = tools.safe_media_path(rel)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ext = os.path.splitext(path)[1].lower()
    if ext not in MEDIA_TYPES:
        raise HTTPException(status_code=403, detail="这个扩展名不允许通过服务读取: %s" % ext)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="文件不存在: %s" % rel)
    stat = os.stat(path)
    return FileResponse(path, media_type=MEDIA_TYPES[ext], headers={
        "Accept-Ranges": "bytes",
        "Content-Length": str(stat.st_size),
        "Cache-Control": "no-cache",
    })


# ---------------------------------------------------------------- 前端
_APP_DIST = os.path.join(config.WEB_DIR, "app-dist")

if os.path.isdir(_APP_DIST):
    app.mount("/app/assets", StaticFiles(directory=os.path.join(_APP_DIST, "assets")), name="app-assets")

    @app.get("/app", include_in_schema=False)
    @app.get("/app/{rel:path}", include_in_schema=False)
    def react_app(rel: str = ""):
        """新版 React 前端。老的三件套（index.html/app.js/app.css）仍然挂在 /，
           两边并存，随时可以来回切。"""
        idx = os.path.join(_APP_DIST, "index.html")
        if not os.path.exists(idx):
            raise HTTPException(status_code=404, detail="还没构建 React 前端：cd app && npm run build")
        return FileResponse(idx, headers={"Cache-Control": "no-store, must-revalidate"})

app.mount("/img", StaticFiles(directory=os.path.join(config.WEB_DIR, "img")), name="img")

_OLD_HEADERS = {"Cache-Control": "no-store, must-revalidate"}


# 老界面原本把静态件挂在根上（/app.css 之类）。新版占了根，这里把裸路径
# 重定向到 /old/ 底下那份，免得旧书签或浏览器缓存拿到 404 白屏。
@app.get("/app.css", include_in_schema=False)
@app.get("/app.js", include_in_schema=False)
@app.get("/canvas.css", include_in_schema=False)
@app.get("/canvas.js", include_in_schema=False)
def old_root_asset(request: Request):
    return RedirectResponse(url="/old" + request.url.path, status_code=307)


# ---- 老界面（三件套 + 画布）：整套挪到 /old 底下，随时能回看对照 ----
# 具体的必须先注册，否则会被末尾的 /old/{rel:path} 吃掉。
@app.get("/old/app.css", include_in_schema=False)
def old_css():
    return FileResponse(os.path.join(config.WEB_DIR, "app.css"), media_type="text/css",
                        headers=_OLD_HEADERS)


@app.get("/old/app.js", include_in_schema=False)
def old_js():
    return FileResponse(os.path.join(config.WEB_DIR, "app.js"),
                        media_type="application/javascript", headers=_OLD_HEADERS)


@app.get("/old/canvas.css", include_in_schema=False)
def old_canvas_css():
    return FileResponse(os.path.join(config.WEB_DIR, "canvas.css"), media_type="text/css",
                        headers=_OLD_HEADERS)


@app.get("/old/canvas.js", include_in_schema=False)
def old_canvas_js():
    return FileResponse(os.path.join(config.WEB_DIR, "canvas.js"),
                        media_type="application/javascript", headers=_OLD_HEADERS)


app.mount("/old/img", StaticFiles(directory=os.path.join(config.WEB_DIR, "img")), name="old-img")


@app.get("/old", include_in_schema=False)
@app.get("/old/{rel:path}", include_in_schema=False)
def old_app(rel: str = ""):
    return FileResponse(os.path.join(config.WEB_DIR, "index.html"), headers=_OLD_HEADERS)


# ---- 新版 React 前端：根路径直接出新版 ----
@app.get("/", include_in_schema=False)
def index():
    idx = os.path.join(_APP_DIST, "index.html")
    if not os.path.exists(idx):
        return PlainTextResponse(
            "还没构建 React 前端：cd app && npm run build\n"
            "老界面临时入口：http://127.0.0.1:%d/old" % config.PORT,
            status_code=404)
    return FileResponse(idx, headers=_OLD_HEADERS)


@app.get("/shots/{rel:path}")
def shots_static(rel: str):
    """截图库里的图。锁死在 data/shots 内，任何 ../ 都出不去；
    截图是本机自己截的，不会变，所以给一天缓存，不跟其它静态文件那样 no-store。"""
    root = os.path.abspath(os.path.join(config.APP_DATA_DIR, "shots"))
    p = os.path.abspath(os.path.join(root, rel.replace("\\", "/")))
    if not p.startswith(root + os.sep):
        raise HTTPException(status_code=400, detail="路径越界")
    ext = os.path.splitext(p)[1].lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif"}.get(ext)
    if not mime:
        raise HTTPException(status_code=403, detail="截图库只放图片")
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="截图不存在: %s" % rel)
    return FileResponse(p, media_type=mime,
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/assets/{name}")
def assets_static(name: str):
    """本机画布的图片资产（data/assets/）。文件名是哈希，不存在子目录。"""
    root = os.path.abspath(os.path.join(config.APP_DATA_DIR, "assets"))
    p = os.path.abspath(os.path.join(root, os.path.basename(name)))
    ext = os.path.splitext(p)[1].lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif"}.get(ext)
    if not mime:
        raise HTTPException(status_code=403, detail="资产目录只放图片")
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="资产不存在: %s" % name)
    return FileResponse(p, media_type=mime,
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/noteimg/{src}")
def noteimg_static(src: str, p: str = ""):
    """外部笔记里的图，引用式预览（开发文档 6.1）：永远读原文件，不拷贝。

    p 是相对该笔记文件夹根的路径。路径必须落在配置的文件夹里出不去，
    只认图片扩展名。外部文件被删/改名时这里 404 —— 画布上显示破图，
    这就是「引用式」说清楚的代价，缓存缩略图是另一回事（data/thumbs，未做）。
    """
    if not p:
        raise HTTPException(status_code=400, detail="缺图片相对路径 ?p=")
    cfgp = notesrc.get_cfg(src).get("path")
    base = os.path.abspath(notesrc._expand(cfgp)) if cfgp else None
    # 配置的路径可能是单个 .md 文件 —— 相对引用是相对它所在的文件夹
    if base and os.path.isfile(base):
        base = os.path.dirname(base)
    if not base or not os.path.isdir(base):
        raise HTTPException(status_code=404, detail="%s 还没配文件夹" % src)
    q = os.path.abspath(os.path.join(base, p.replace("\\", "/")))
    if not q.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="路径越界")
    ext = os.path.splitext(q)[1].lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml"}.get(ext)
    if not mime:
        raise HTTPException(status_code=403, detail="只代理图片文件")
    if not os.path.isfile(q):
        raise HTTPException(status_code=404, detail="原文件不在了: %s" % p)
    return FileResponse(q, media_type=mime,
                        headers={"Cache-Control": "public, max-age=3600"})


# ---------------------------------------------------------------- 视频代理
#
# 把 B 站直链挡在本机这一层后面，前端只认 /stream/<lesson_id>：
#   · 直链带签名、约 2 小时过期 —— 交给前端就是个会烂的地址
#   · 直链必须带 Referer: https://www.bilibili.com/ 才给流量，浏览器里带不了
#   · dash（1080P 只有 dash）音视频分离，得合流
#
# 合流为什么不在管道里做：ffmpeg 的 -headers 只对紧跟其后的第一个 -i 生效，
# 第二个输入照样 403（实测：server returned 403 Forbidden）。所以先把两条轨
# 落到本地缓存，再从本地文件合流 —— 顺带把「同一讲反复打开」变成零下载。
#
# 拖进度条必须能拖：合流产物是整个缓存文件，用 Range 回 206 + Content-Range。
# 不做这个，浏览器会把整个输出当直播流，进度条根本动不了。

FFMPEG = os.environ.get("SD_FFMPEG") or "F:/ffmpeg/bin/ffmpeg.exe"
_UP_HEADERS = {"Referer": "https://www.bilibili.com/",
               "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/120.0.0.0 Safari/537.36")}
# 合流 / 缓存 / 预热队列都在 server/streamer.py：这里只管 HTTP 这一层。
# 以前「点播放才开始合」是本文件的一部分，现在合流能提前在后台跑，
# 逻辑挪走之后这一层只剩「有缓存就发、没有就合、合完发」。


@app.get("/stream/{lesson_id}")
async def stream_lesson(lesson_id: str, request: Request, q: int = 0):
    """本讲的播放文件。local 直接跳 /media；dash 先合流再当本地文件发。

    q 不传就跟用户在设置里选的那一档（play.qn）；都没有才 720P。
    """
    sub, les, bvid, pg = tools._lesson_point(lesson_id)
    if not les:
        raise HTTPException(status_code=404, detail="本机没有这一讲：%s" % lesson_id)
    if les.get("local"):
        return RedirectResponse("/media/" + str(les["local"]).lstrip("/"), status_code=302)
    if not bvid:
        raise HTTPException(status_code=404, detail="这一讲没记 B 站号，播不了")

    qq = int(q or 0) or int(store.kv_get("play.qn") or 0) or 64
    # 缓存里降级找：1080 没合过但 480 合过，就别再合一遍
    path, size, qq = streamer.ready_any(lesson_id, qq)

    if not path:
        pgs, err = bili.pages(bvid)
        if err:
            raise HTTPException(status_code=502, detail="取分集目录失败：" + err)
        hit = next((x for x in pgs if int(x.get("page") or 0) == pg), None)
        if not hit:
            raise HTTPException(status_code=404, detail="这个 bvid 上没有第 %d P" % pg)
        # 登录态失效就退到免登录的 480P，别让页面变成一块错误
        tr, err = bili.track_url(bvid, hit["cid"], qq, cookie=tools._bili_cookie())
        if err or tr.get("kind") != "dash":
            tr, err = bili.track_url(bvid, hit["cid"], 32, cookie=None)
        if err:
            raise HTTPException(status_code=502, detail=err)
        if tr.get("kind") == "durl":
            # 单文件，不用合流，直接回源透传
            rng = request.headers.get("range")
            try:
                up = _upstream_durl(tr["url"], rng)
            except Exception as e:
                bili.clear_play_cache()
                raise HTTPException(status_code=502, detail="回源失败（%s）" % str(e)[:80])
            hdr = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
            for k, v in (("Content-Length", "content-length"), ("Content-Range", "content-range")):
                if up.headers.get(v):
                    hdr[k] = up.headers.get(v)

            def gen_durl():
                try:
                    while True:
                        chunk = up.read(65536)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    up.close()

            return StreamingResponse(gen_durl(), status_code=206 if rng else 200,
                                     media_type="video/mp4", headers=hdr)
        if not os.path.exists(FFMPEG):
            raise HTTPException(status_code=501,
                                detail="这台机器上没有 ffmpeg（找的是 %s）—— dash 合流做不了，"
                                       "设 SD_FFMPEG 指一下" % FFMPEG)
        # 合流走 streamer.ensure：同一讲有锁 —— 后台正在合这一讲时这里等它做完，
        # 不会再下一次、也不会两个 ffmpeg 抢着写同一个临时文件。
        try:
            path = await asyncio.get_event_loop().run_in_executor(
                None, streamer.ensure, lesson_id, tr.get("quality") or qq, tr)
        except Exception as e:
            raise HTTPException(status_code=502, detail="合流失败：%s" % str(e)[:160])
        if not path:
            raise HTTPException(status_code=502, detail="这一讲合不出能播的文件")
        size = os.path.getsize(path)

    # 播放即「这条还在用」：缓存满了按 mtime 清最老的，正在看的不能被清。
    try:
        os.utime(path)
    except OSError:
        pass
    return _send_range(path, size, request)


def _upstream_durl(url, rng=None):
    req = urllib.request.Request(url, headers={**_UP_HEADERS, **({"Range": rng} if rng else {})})
    return urllib.request.urlopen(req, timeout=20)


def _send_range(path, size, request):
    """按 Range 发本地文件。拖进度条全靠这里。"""
    rng = request.headers.get("range")
    hdr = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    if not rng:
        def gen_all():
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(262144)
                    if not chunk:
                        break
                    yield chunk
        hdr["Content-Length"] = str(size)
        return StreamingResponse(gen_all(), media_type="video/mp4", headers=hdr)

    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    if not m:
        raise HTTPException(status_code=416, detail="Range 读不出来")
    a = int(m.group(1)) if m.group(1) else 0
    b = int(m.group(2)) if m.group(2) else size - 1
    a = max(0, min(a, size - 1))
    b = max(a, min(b, size - 1))
    n = b - a + 1
    hdr.update({"Content-Range": "bytes %d-%d/%d" % (a, b, size),
                "Content-Length": str(n)})

    def gen_part():
        with open(path, "rb") as f:
            f.seek(a)
            left = n
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk

    return StreamingResponse(gen_part(), status_code=206, media_type="video/mp4", headers=hdr)


@app.get("/favicon.ico")
def favicon():
    return PlainTextResponse("", status_code=204)


def _open_browser(url: str):
    """服务起来后开一次浏览器（只有明确要开的时候才开）。开不了就算了，不该因为这事起不来服务。"""
    try:
        import threading, webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    except Exception:
        pass


def _warm_kb():
    """后台预热语义检索的编码模型。

    不预热的下场：第一次搜要等 8–15 秒加载模型，用户以为「搜索坏了」。
    预热多占约 100MB 内存，换来第一次搜就是毫秒级 —— 这笔账划算。
    起在守护线程里、延后几秒，别跟启动抢 IO；预热失败也不影响服务
    （真用到的时候 kb 会自己再试一次，并把原因说出来）。
    """
    try:
        import time as _t
        _t.sleep(3)
        from . import kb
        r = kb.available()
        print("语义检索预热：%s" % ("就绪，%d 维" % (r.get("dim") or 0) if r.get("ok")
                                 else (r.get("why") or "不可用")))
    except Exception:
        pass


def main():
    import threading
    import uvicorn
    url = "http://%s:%d/" % (config.HOST, config.PORT)
    print("研学台 → %s" % url)
    print("（老界面还在：%sold）" % url)
    # 默认不开浏览器：自动化跑测试、起后台服务的时候，突然弹窗会把人从正在干的事上打断。
    # 要开就明确说 —— start.bat 会设 SD_OPEN_BROWSER=1，双击启动照旧弹。
    if os.environ.get("SD_OPEN_BROWSER") == "1":
        _open_browser(url)
    threading.Thread(target=_warm_kb, daemon=True, name="kb-warm").start()
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
