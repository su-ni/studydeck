// 语音输入 · 模块级录音器
//
// 为什么不做成组件的 state：
//   人要的是「说一句话，按一下停」。说的过程里可能去翻讲义、切课程、点别的地方 ——
//   这些动作在 React 里都可能让 Chat 卸载。录音要挂在组件上，一卸载就断，
//   人话说到一半被打断，这功能就废了。
//   所以录音器和状态一起放在模块作用域，跟着页面活，不跟着组件活。
//
// 明确的边界：
//   · 只有 stop() 会停 —— 不监听 document 的 click / pointerdown / blur / visibilitychange。
//     点屏幕任何地方都不影响录制。
//   · 唯一的自动停是 5 分钟上限（跟后端 MAX_SEC 对齐），到点自己停并照常转写。
//
// 转写结果不直接塞进谁家 state：放在 takeText() 里，谁在场谁取，取完即清。

const MAX_SEC = 300

export type AsrPhase = 'idle' | 'recording' | 'transcribing' | 'error'

export type AsrState = {
  phase: AsrPhase
  seconds: number
  error: string
  lastMs: number
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

let _state: AsrState = { phase: 'idle', seconds: 0, error: '', lastMs: 0 }
const _subs = new Set<(s: AsrState) => void>()

let _mr: MediaRecorder | null = null
let _stream: MediaStream | null = null
let _chunks: Blob[] = []
let _timer: ReturnType<typeof setInterval> | null = null
let _t0 = 0
let _pendingText = ''
let _mime = ''

function emit(patch: Partial<AsrState>) {
  _state = { ..._state, ...patch }
  for (const f of _subs) {
    try { f(_state) } catch { /* 订阅方自己炸了不能拖垮录音 */ }
  }
}

export function subscribe(fn: (s: AsrState) => void) {
  _subs.add(fn)
  fn(_state)
  return () => { _subs.delete(fn) }
}

export function snapshot() {
  return _state
}

/** 取走这次转写出来的文字。取一次就空，避免切页回来重复粘一遍。 */
export function takeText() {
  const t = _pendingText
  _pendingText = ''
  return t
}

export function isRecording() {
  return _state.phase === 'recording'
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch { /* 老浏览器可能直接抛 */ }
  }
  return ''
}

function teardown() {
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_stream) {
    for (const t of _stream.getTracks()) {
      try { t.stop() } catch { /* 已经停了 */ }
    }
    _stream = null
  }
  _mr = null
}

/** 开始录。要麦克风权限，第一次浏览器会弹一次 —— 拒绝就如实报，不假装在录。 */
export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (_state.phase === 'recording') return { ok: true }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    emit({ phase: 'error', error: '这个浏览器没有录音接口' })
    return { ok: false, error: '这个浏览器没有录音接口' }
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (e: any) {
    const n = String(e?.name || '')
    const msg = n === 'NotAllowedError' || n === 'SecurityError'
      ? '麦克风没被允许。浏览器地址栏左边的锁形图标里把「麦克风」改成允许，再点一次。'
      : n === 'NotFoundError' || n === 'DevicesNotFoundError'
        ? '这台机器上没找到麦克风。'
        : n === 'NotReadableError'
          ? '麦克风被别的程序占着（会议软件、录音机之类），关掉它再来。'
          : '开不了麦克风：' + (e?.message || n || '未知原因')
    emit({ phase: 'error', error: msg })
    return { ok: false, error: msg }
  }

  const mime = pickMime()
  if (!mime) {
    try { for (const t of stream.getTracks()) t.stop() } catch { /* 无所谓 */ }
    emit({ phase: 'error', error: '这个浏览器录不出能识别的音频格式' })
    return { ok: false, error: '这个浏览器录不出能识别的音频格式' }
  }

  _stream = stream
  _chunks = []
  _mime = mime
  _t0 = Date.now()

  try {
    const mr = new MediaRecorder(stream, { mimeType: mime })
    _mr = mr
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) _chunks.push(ev.data)
    }
    // 每秒切一片：长时间录制时内存里不会攒一个整段大文件
    mr.start(1000)
  } catch (e: any) {
    teardown()
    const msg = '录音器起不来：' + (e?.message || '未知原因')
    emit({ phase: 'error', error: msg })
    return { ok: false, error: msg }
  }

  emit({ phase: 'recording', seconds: 0, error: '' })
  _timer = setInterval(() => {
    const s = Math.floor((Date.now() - _t0) / 1000)
    emit({ seconds: s })
    // 唯一会自动停的情况：到上限。跟点哪儿没关系。
    if (s >= MAX_SEC) void stop()
  }, 1000)

  return { ok: true }
}

/** 停止并转写。返回识别出的文字（拿不到就空串，原因在 state.error 里）。 */
export async function stop(): Promise<string> {
  if (_state.phase !== 'recording' || !_mr) return ''

  const mr = _mr
  const seconds = Math.floor((Date.now() - _t0) / 1000)

  const blob: Blob = await new Promise<Blob>((resolve) => {
    const done = () => resolve(new Blob(_chunks, { type: _mime }))
    try {
      mr.onstop = done
      if (mr.state !== 'inactive') mr.stop()
      else done()
    } catch {
      done()
    }
  })

  teardown()
  emit({ phase: 'transcribing', seconds })

  if (!blob.size) {
    emit({ phase: 'error', error: '这段没录到声音', seconds })
    return ''
  }

  const t0 = Date.now()
  try {
    const r = await fetch('/api/asr/transcribe', {
      method: 'POST',
      headers: { 'content-type': _mime || 'application/octet-stream' },
      body: blob,
    })
    const d = await r.json()
    const ms = Date.now() - t0
    if (!d?.ok) {
      emit({ phase: 'error', error: d?.error || '没转出来', lastMs: ms, seconds })
      return ''
    }
    _pendingText = String(d.text || '')
    emit({ phase: 'idle', error: '', lastMs: ms, seconds: d.seconds ?? seconds })
    return _pendingText
  } catch (e: any) {
    const msg = '转写请求失败：' + (e?.message || '连不上本机服务')
    emit({ phase: 'error', error: msg })
    return ''
  }
}

/** 点了「算了」：丢掉这段，不转写。 */
export function cancel() {
  if (_state.phase === 'recording' && _mr) {
    try {
      _mr.onstop = null
      if (_mr.state !== 'inactive') _mr.stop()
    } catch { /* 无所谓 */ }
  }
  teardown()
  _chunks = []
  _pendingText = ''
  emit({ phase: 'idle', seconds: 0, error: '' })
}

/** 把上次那条错误抹掉（人点了「知道了」）。 */
export function clearError() {
  if (_state.phase === 'error') emit({ phase: 'idle', error: '' })
}

/** 模型装没装 —— 不碰录音，只问服务端。 */
export type AsrStatus = {
  installed: boolean
  loaded: boolean
  size: number
  cached: number
  job?: { running: boolean; stage: string; bytes: number; total: number; error: string; done: boolean }
}

export async function asrStatus(): Promise<AsrStatus | null> {
  try {
    const r = await fetch('/api/asr/status', { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}
