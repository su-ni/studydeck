// 语音输入 · 模块级录音器（实时版）
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
//   · 唯一的自动停是 5 分钟上限，到点自己停并照常收尾。
//
// 为什么不用 MediaRecorder：
//   MediaRecorder 给的是 webm 分片，只有第一片带容器头，后面的片单独解不开 ——
//   想边录边转就得把整段攒起来重解，录得越久越慢。这里改成 AudioWorklet 直接取
//   原始 PCM（每 100ms 一块，Int16 小端），后端拿到就能算，零解码。
//
// 为什么 AudioContext 不指定 16000：
//   实测在 headless Chrome 里 new AudioContext({sampleRate:16000}) 会拿到一整条
//   静音的流（RMS 恒为 0）。用系统默认（48k）就正常。降采样交给后端做。

const MAX_SEC = 300
const CHUNK_MS = 100

export type AsrPhase = 'idle' | 'recording' | 'transcribing' | 'error'

export type AsrState = {
  phase: AsrPhase
  seconds: number
  error: string
  lastMs: number
  /** 录音过程中实时累积出来的文字。停止后由 takeText() 取走整段。 */
  live: string
}

let _state: AsrState = { phase: 'idle', seconds: 0, error: '', lastMs: 0, live: '' }
const _subs = new Set<(s: AsrState) => void>()

let _ctx: AudioContext | null = null
let _node: AudioWorkletNode | null = null
let _stream: MediaStream | null = null
let _timer: ReturnType<typeof setInterval> | null = null
let _t0 = 0
let _sid = ''
let _pendingText = ''

// 发送队列：块必须按顺序到后端，所以串行发。后端切句时会阻塞几百毫秒，
// 这期间前端照常往里塞，塞的是内存里的 ArrayBuffer，不会丢音频。
const _queue: ArrayBuffer[] = []
let _pumping = false
let _stopping = false

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

/** 取走这次转写出来的整段文字。取一次就空，避免切页回来重复粘一遍。 */
export function takeText() {
  const t = _pendingText
  _pendingText = ''
  return t
}

export function isRecording() {
  return _state.phase === 'recording'
}

function newSid() {
  return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function teardown() {
  if (_timer) { clearInterval(_timer); _timer = null }
  try { if (_node) _node.port.onmessage = null } catch { /* 已经关了 */ }
  try { _node?.disconnect() } catch { /* 已经断了 */ }
  try { _ctx?.close() } catch { /* 已经关了 */ }
  if (_stream) {
    for (const t of _stream.getTracks()) {
      try { t.stop() } catch { /* 已经停了 */ }
    }
    _stream = null
  }
  _node = null
  _ctx = null
}

/* 采集器：攒够 100ms 就 post 一次。放在 AudioWorklet 里跑，
   不受主线程渲染卡顿影响（主线程在画消息的时候也不会漏采样）。 */
const TAP_CODE = `
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.cap = Math.max(1, Math.round(sampleRate * ${CHUNK_MS} / 1000))
    this.buf = new Float32Array(this.cap)
    this.n = 0
    this.silent = 0
  }
  process(inputs) {
    var ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (var i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n >= this.cap) {
        var out = this.buf.slice(0, this.n)
        this.port.postMessage(out, [out.buffer])
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('mic-tap', MicTap)
`

function f32ToI16(f: Float32Array): ArrayBuffer {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) {
    let v = f[i]
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out.buffer
}

async function pump() {
  if (_pumping) return
  _pumping = true
  try {
    while (_queue.length) {
      const body = _queue.shift() as ArrayBuffer
      const rate = _ctx?.sampleRate || 48000
      try {
        const r = await fetch(
          `/api/asr/live/feed?sid=${encodeURIComponent(_sid)}&rate=${rate}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body },
        )
        const d = await r.json()
        if (d && d.ok === false && d.error) {
          emit({ error: d.error })
        } else if (d && d.text) {
          emit({ live: _state.live + d.text })
        }
      } catch {
        // 单块失败不致命：后面还有块，而且停止时会用 finish 收尾。
        // 这里不弹错，免得网络抖一下就打断人说话。
      }
    }
  } finally {
    _pumping = false
  }
}

/** 开始录。要麦克风权限，第一次浏览器会弹一次 —— 拒绝就如实报，不假装在录。 */
export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (_state.phase === 'recording') return { ok: true }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    emit({ phase: 'error', error: '这个浏览器没有录音接口' })
    return { ok: false, error: '这个浏览器没有录音接口' }
  }
  if (typeof AudioWorkletNode === 'undefined') {
    emit({ phase: 'error', error: '这个浏览器不支持音频采集（缺 AudioWorklet）' })
    return { ok: false, error: '这个浏览器不支持音频采集（缺 AudioWorklet）' }
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

  _sid = newSid()
  _queue.length = 0
  _stopping = false

  try {
    // 先告诉后端开一个会话。失败也继续录 —— 停止时还有一次机会收尾。
    try {
      await fetch(`/api/asr/live/start?sid=${encodeURIComponent(_sid)}`, { method: 'POST' })
    } catch { /* 后端不在也让人先说，块会排队 */ }

    const ctx = new AudioContext()
    await ctx.resume()
    const url = URL.createObjectURL(new Blob([TAP_CODE], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)

    const node = new AudioWorkletNode(ctx, 'mic-tap')
    node.port.onmessage = (ev) => {
      if (_stopping) return
      _queue.push(f32ToI16(ev.data as Float32Array))
      if (_queue.length > 600) _queue.shift()   // 60 秒积压说明后端挂了，丢最老的
      void pump()
    }

    const src = ctx.createMediaStreamSource(stream)
    src.connect(node)

    _ctx = ctx
    _node = node
    _stream = stream
  } catch (e: any) {
    try { for (const t of stream.getTracks()) t.stop() } catch { /* 无所谓 */ }
    try { _ctx?.close() } catch { /* 无所谓 */ }
    _ctx = null
    const msg = '录音器起不来：' + (e?.message || '未知原因')
    emit({ phase: 'error', error: msg })
    return { ok: false, error: msg }
  }

  _t0 = Date.now()
  emit({ phase: 'recording', seconds: 0, error: '', live: '' })
  _timer = setInterval(() => {
    const s = Math.floor((Date.now() - _t0) / 1000)
    emit({ seconds: s })
    if (s >= MAX_SEC) void stop()
  }, 1000)

  return { ok: true }
}

/** 停止并收尾。返回这次录到的整段文字（拿不到就空串，原因在 state.error 里）。 */
export async function stop(): Promise<string> {
  if (_state.phase !== 'recording') return ''

  _stopping = true
  const seconds = Math.floor((Date.now() - _t0) / 1000)
  teardown()
  emit({ phase: 'transcribing', seconds })

  // 等队列里的块发完，否则最后半句会丢在内存里
  const deadline = Date.now() + 15000
  while ((_queue.length || _pumping) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80))
  }

  const t0 = Date.now()
  let tail = ''
  try {
    const r = await fetch(`/api/asr/live/finish?sid=${encodeURIComponent(_sid)}`, { method: 'POST' })
    const d = await r.json()
    if (d && d.ok === false && d.error) {
      emit({ phase: 'error', error: d.error, lastMs: Date.now() - t0 })
      _pendingText = _state.live
      return _pendingText
    }
    tail = String(d?.text || '')
  } catch (e: any) {
    emit({ phase: 'error', error: '收尾失败：' + (e?.message || '连不上本机服务') })
    _pendingText = _state.live
    return _pendingText
  }

  const full = _state.live + tail
  _pendingText = full
  emit({ phase: 'idle', error: '', live: full, lastMs: Date.now() - t0, seconds })
  return full
}

/** 点了「算了」：丢掉这段，不转写。 */
export function cancel() {
  _stopping = true
  _queue.length = 0
  teardown()
  if (_sid) { fetch(`/api/asr/live/finish?sid=${encodeURIComponent(_sid)}`, { method: 'POST' }).catch(() => { }) }
  _sid = ''
  _pendingText = ''
  emit({ phase: 'idle', seconds: 0, error: '', live: '' })
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
