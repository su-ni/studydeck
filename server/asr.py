# -*- coding: utf-8 -*-
"""本机语音转文字（faster-whisper / CTranslate2，纯 CPU）。

三条规矩，跟这个项目别处一致：

1. **进程启动绝不碰模型。** 没人在设置里点过「装」，这个模块连 faster_whisper
   都不 import —— 装它的代价是几十秒和几百兆内存，不该由「打开应用」来付。
2. **「模型文件在」和「模型已加载」是两件事。** status() 分开报：装没装看目录，
   加载没加载看 _MODEL。人要知道现在到底在等谁。
3. **听不清就说听不清。** 空音频、纯噪声、太短，一律如实返回，不拿相似的一句顶上。

模型落在 data/asr/models/<repo>/ —— 跟着本机数据走，不进版本库（data/ 已忽略）。
本机 HF 缓存里已经有的话优先从缓存装（秒完成、不联网），没有才真下。
"""
import io
import os
import re
import threading
import time

from . import config

# base 模型：中文能听、CPU 上够快。换大模型只改这一行，别的都不用动。
REPO = "Systran/faster-whisper-base"
MODEL_DIR = os.path.join(config.APP_DATA_DIR, "asr", "models", REPO.replace("/", "--"))
MAX_SEC = 300          # 一次最多听 5 分钟，超了截断并如实说
SAMPLE_RATE = 16000

_MODEL = None
_VAD = None            # 这台机器的 VAD 能不能用，探一次记下来
_LOAD_LOCK = threading.Lock()

# 安装任务的状态。没有任务时 running=False。
_JOB = {
    "running": False, "stage": "", "bytes": 0, "total": 0,
    "error": "", "done": False, "started": 0.0,
}
_JOB_LOCK = threading.Lock()


def _set_job(**kw):
    with _JOB_LOCK:
        _JOB.update(kw)


def _files_ok(d):
    """目录里有没有能用的模型：model.bin + 词表/config 至少各一。"""
    if not os.path.isdir(d):
        return False
    names = set(os.listdir(d))
    if "model.bin" not in names:
        return False
    return bool(names & {"tokenizer.json", "vocabulary.txt"})


def _dir_size(d):
    n = 0
    try:
        for root, _dirs, files in os.walk(d):
            for f in files:
                try:
                    n += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    return n


def _cached_size():
    """HF 缓存里那份有多大 —— 只用来在设置页如实说明「本机已有，可秒装」。"""
    try:
        from huggingface_hub import scan_cache_dir
        for r in scan_cache_dir().repos:
            if r.repo_id == REPO:
                return int(r.size_on_disk)
    except Exception:
        pass
    return 0


def status():
    """装没装、加载没加载、本机缓存有没有 —— 三个独立的事实。"""
    installed = _files_ok(MODEL_DIR)
    return {
        "repo": REPO,
        "installed": installed,
        "loaded": _MODEL is not None,
        "size": _dir_size(MODEL_DIR) if installed else 0,
        "cached": _cached_size(),
        "dir": MODEL_DIR,
        "engine": "faster-whisper (CTranslate2, CPU int8)",
        "max_sec": MAX_SEC,
        "job": dict(_JOB),
    }


def _cache_dir():
    """本机 HF 缓存里那份模型长什么样。

    不走 huggingface_hub 的 snapshot_download(local_files_only=True) —— 它在
    local_dir 模式下还要校验一堆东西，这里证书一断就静默失败。直接看缓存快照
    目录里有没有 model.bin，有就抄过来，离线也能装。
    """
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        base = HF_HUB_CACHE
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    snap = os.path.join(base, "models--" + REPO.replace("/", "--"), "snapshots")
    if not os.path.isdir(snap):
        return None
    for rev in os.listdir(snap):
        d = os.path.join(snap, rev)
        if _files_ok(d):
            return d
    return None


def _copy_from(src):
    """把缓存快照里的文件抄到本项目目录。快照里多是软链，copy2 会跟过去拿真身。"""
    import shutil
    os.makedirs(MODEL_DIR, exist_ok=True)
    names = [n for n in os.listdir(src) if n.endswith((".json", ".bin", ".txt"))]
    total = 0
    for n in names:
        p = os.path.join(src, n)
        try:
            total += os.path.getsize(p)
        except OSError:
            pass
    _set_job(total=total, bytes=0, stage="从本机缓存复制")
    done = 0
    for n in names:
        p = os.path.join(src, n)
        shutil.copy2(p, os.path.join(MODEL_DIR, n))
        try:
            done += os.path.getsize(p)
        except OSError:
            pass
        _set_job(bytes=done, stage="复制 " + n)


def _download_blocking():
    """把模型落到本项目目录。

    先看本机 HF 缓存 —— 有就直接抄，不联网、不重下 140MB。缓存也没有才走网络。
    两条路都按文件累计字节，进度是真的。
    """
    _set_job(running=True, stage="查本机缓存", bytes=0, total=0,
             error="", done=False, started=time.time())

    src = _cache_dir()
    if src:
        _set_job(stage="本机已有缓存，直接复制")
        _copy_from(src)
    else:
        _set_job(stage="本机没有缓存，联网下载")
        from huggingface_hub import snapshot_download
        os.makedirs(MODEL_DIR, exist_ok=True)
        snapshot_download(REPO, local_dir=MODEL_DIR,
                          allow_patterns=["*.json", "*.bin", "*.txt"],
                          max_workers=4)

    _set_job(stage="核对文件")
    if not _files_ok(MODEL_DIR):
        raise RuntimeError("装完了但目录里缺 model.bin / 词表，不能算装好")

    got = _dir_size(MODEL_DIR)
    _set_job(stage="装好了：%.1f MB" % (got / 1048576), bytes=got, total=got,
             running=False, done=True)


def setup_async(force=False):
    """触发安装。已经在跑就直接返回当前进度，不重复开线程。"""
    if _JOB["running"]:
        return {"started": False, "job": dict(_JOB), "say": "已经在装了"}
    if _files_ok(MODEL_DIR) and not force:
        return {"started": False, "job": dict(_JOB),
                "say": "本机已经有模型了（%.1f MB），不用再装" % (_dir_size(MODEL_DIR) / 1048576)}

    def run():
        try:
            _download_blocking()
        except Exception as e:
            _set_job(running=False, done=False, error="%s: %s" % (type(e).__name__, e),
                     stage="没装成")

    threading.Thread(target=run, daemon=True, name="asr-setup").start()
    return {"started": True, "job": dict(_JOB), "say": "开始装模型"}


def load():
    """真正把模型读进内存。只有这里会 import faster_whisper。"""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    if not _files_ok(MODEL_DIR):
        raise RuntimeError("还没装模型")
    with _LOAD_LOCK:
        if _MODEL is not None:
            return _MODEL
        t0 = time.time()
        from faster_whisper import WhisperModel
        _MODEL = WhisperModel(MODEL_DIR, device="cpu", compute_type="int8",
                              cpu_threads=max(2, (os.cpu_count() or 4) // 2))
        print("语音模型已加载：%.1fs" % (time.time() - t0), flush=True)
    return _MODEL


def unload():
    """把模型放掉，内存还回去。下次用再加载。"""
    global _MODEL
    with _LOAD_LOCK:
        _MODEL = None


def _vad_ok():
    """这台机器的 onnxruntime 能不能撑起 faster-whisper 的 VAD。

    VAD 是可选件：它靠 silero 的 onnx 模型剪掉静音段，少了它 whisper 照样能转，
    只是遇到前后大片静音时容易自己编（「谢谢观看」那类）。这台机器上
    onnxruntime 是个缺了 pybind 扩展的残壳（SessionOptions 都没有），所以先探一次，
    探不通就走下面 _trim_silence 那条路 —— 自己按能量把首尾静音剪掉。
    """
    global _VAD
    if _VAD is not None:
        return _VAD
    try:
        import onnxruntime as ort
        ort.SessionOptions()
        _VAD = True
    except Exception:
        _VAD = False
    return _VAD


def _trim_silence(a, sr=SAMPLE_RATE, win=0.03, drop_db=30.0, pad=8):
    """把首尾的静音剪掉。没有 VAD 时的降级方案，只做「掐头去尾」，不动中间。

    一帧 30ms 算 RMS，比整段峰值低 30dB 以上的算没声。中间那些停顿不碰 ——
    人说话本来就有停顿，切碎了反而接不上。
    """
    try:
        import numpy as np
    except Exception:
        return a
    w = int(sr * win)
    n = len(a) // w
    if n < 4:
        return a
    fr = np.asarray(a[: n * w], dtype="float32").reshape(n, w)
    rms = np.sqrt((fr ** 2).mean(axis=1) + 1e-12)
    db = 20.0 * np.log10(rms + 1e-12)
    thr = max(db.max() - drop_db, -48.0)
    keep = db > thr
    if not keep.any():
        return a
    i0 = max(0, int(np.argmax(keep)) - pad)
    i1 = min(n, n - int(np.argmax(keep[::-1])) + pad)
    return a[i0 * w: i1 * w]


_HAN = re.compile(r"[\u4e00-\u9fff]")


def _norm_punct(t):
    """whisper 中文出来是半角标点（「,」「?」），塞进输入框很扎眼。

    只有中文占多数时才换 —— 夹着大半段英文的时候乱换，反而会把 URL、代码弄坏。
    """
    if not t:
        return t
    han = len(_HAN.findall(t))
    if han < max(4, len(t) * 0.3):
        return t
    for a, b in ((",", "，"), ("?", "？"), ("!", "！"), (":", "："), (";", "；")):
        t = t.replace(a, b)
    return t


def transcribe(data, mime=""):
    """一段音频 → 文字。

    data 是浏览器 MediaRecorder 吐出来的原始字节（webm/opus，也可能是 mp4/ogg）。
    解码交给 faster-whisper 自己的 PyAV，不依赖本机装没装 ffmpeg 命令行。
    """
    if not data:
        return {"ok": False, "error": "没收到音频", "text": ""}
    if not _files_ok(MODEL_DIR):
        return {"ok": False, "error": "还没装语音模型", "need_setup": True, "text": ""}

    t0 = time.time()
    try:
        from faster_whisper.audio import decode_audio
        audio = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    except Exception as e:
        return {"ok": False, "error": "这段音频解不开：%s" % type(e).__name__, "text": ""}

    n = int(len(audio))
    seconds = n / float(SAMPLE_RATE)
    if n < SAMPLE_RATE * 0.3:
        return {"ok": False, "error": "太短了（不到 0.3 秒）", "seconds": seconds, "text": ""}

    cut = False
    if seconds > MAX_SEC:
        audio = audio[: MAX_SEC * SAMPLE_RATE]
        seconds = MAX_SEC
        cut = True

    try:
        m = load()
    except Exception as e:
        return {"ok": False, "error": "模型加载失败：%s" % e, "text": ""}

    use_vad = _vad_ok()
    if not use_vad:
        audio = _trim_silence(audio)

    t1 = time.time()
    try:
        segs, info = m.transcribe(
            audio,
            language="zh",
            beam_size=5,
            vad_filter=use_vad,
            vad_parameters={"min_silence_duration_ms": 500} if use_vad else None,
            initial_prompt="以下是普通话的句子，用简体中文。",
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
        )
        parts = []
        for s in segs:
            t = (s.text or "").strip()
            if t:
                parts.append(t)
    except Exception as e:
        return {"ok": False, "error": "转写失败：%s" % e, "text": ""}
    text = "".join(parts).strip()
    text = _norm_punct(text)

    if not text:
        return {"ok": False, "error": "这段没听出字（可能是静音或噪声）",
                "seconds": seconds, "elapsed": time.time() - t1, "text": ""}

    return {
        "ok": True,
        "text": text,
        "seconds": round(seconds, 1),
        "elapsed": round(time.time() - t1, 2),
        "cost": round(time.time() - t0, 2),
        "truncated": cut,
        "vad": use_vad,
        "lang": getattr(info, "language", "zh"),
    }
