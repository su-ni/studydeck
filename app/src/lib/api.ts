// 工具层：界面只调工具，不直连数据。
// 这一层是 web/app.js 里 callTool 的等价物 —— 返回体是包了一层的
// {ok, tool, perm, desc, ms, ts, data}，业务一律取 .data。

export type ToolRes = {
  ok: boolean
  tool: string
  perm?: string
  desc?: string
  ms?: number
  ts?: string
  tries?: number
  data?: any
  error?: string
  need_confirm?: boolean
  confirm_hint?: string
}

const CALL_TIMEOUT = 30000 // 一次调用最多等 30 秒
const CALL_RETRY = 2 // 网络层失败（连都没连上）重试两次

// 写工具不重试：重发可能让服务端多落一条。调用处显式声明 write:true。
function isNetErr(e: any) {
  const m = String(e?.message ?? e)
  return /Failed to fetch|NetworkError|Load failed|net::|ERR_|aborted|timeout|timed out/i.test(m)
}

export type CallOpts = { confirm?: boolean; write?: boolean }

export async function callTool<T = any>(name: string, args?: Record<string, any>, opts?: CallOpts): Promise<ToolRes & { data: T }> {
  const o = opts || {}
  const t0 = performance.now()
  const body = JSON.stringify({ args: args || {}, confirm: !!o.confirm })
  let tries = 0

  async function once(): Promise<ToolRes> {
    tries++
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const tid = ctl ? setTimeout(() => { try { ctl.abort() } catch {} }, CALL_TIMEOUT) : 0
    try {
      const r = await fetch('/api/tool/' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctl?.signal,
      })
      const res = (await r.json()) as ToolRes
      if (tid) clearTimeout(tid)
      res.ms = res.ms ?? Math.round(performance.now() - t0)
      res.tries = tries
      return res
    } finally {
      if (tid) clearTimeout(tid)
    }
  }

  async function again(e: any): Promise<ToolRes> {
    if (tries <= CALL_RETRY && !o.write && isNetErr(e)) {
      await new Promise((r) => setTimeout(r, 260 * tries))
      try { return await once() } catch (e2) { return await again(e2) }
    }
    const msg = String(e?.message ?? e)
    let why: string
    if (/aborted/i.test(msg)) why = `等了 ${Math.round(CALL_TIMEOUT / 1000)} 秒还没回来，先不等了`
    else if (isNetErr(e)) why = `连不上本机服务（${msg}），试了 ${tries} 次`
    else why = msg
    return { ok: false, tool: name, ms: Math.round(performance.now() - t0), error: '调用没成：' + why, data: {}, tries }
  }

  try { return (await once()) as ToolRes & { data: T } }
  catch (e) { return (await again(e)) as ToolRes & { data: T } }
}

// 首屏一次性数据（科目、工具表、品牌等），只在启动时拉一次。
export type Base = {
  built_at?: string
  kpi?: any
  subjects?: Subject[]
  vocab?: any
  wordmap?: any
  exercise_bank?: any
  exam?: any
  sources?: any
  point_cards?: any
  resources?: any
  tools?: { name: string; perm: string; desc: string }[]
  confirm_tools?: string[]
  brand?: any
}

export type Subject = {
  id: string
  name: string
  kind?: string
  score?: number
  accent?: string
  mode?: string
  bvid?: string
  video_up?: string | { name?: string } | null
  video_pages?: number
  cover?: string
  video_title?: string
  groups?: { name: string; count: number }[]
  lessons?: Lesson[]
  lessons_total?: number
  lessons_done?: number
  next?: any
}

export type Lesson = {
  id: string
  title: string
  chapter?: string
  dur?: number
  page?: number
  bvid?: string
  local?: string | null
}

let _base: Base | null = null
let _baseAt = 0
export async function loadBase(force = false): Promise<Base> {
  // 入库 / 助手改数据都发生在会话中间 —— 缓存 20 秒而不是整个会话，
  // 否则刚落库回来页面还显示旧的「0 课程」，人以为没写进去。
  if (_base && !force && Date.now() - _baseAt < 20_000) return _base
  const r = await fetch('/api/base', { cache: 'no-store' })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  _base = (await r.json()) as Base
  _baseAt = Date.now()
  return _base!
}
export function getBaseSync(): Base | null { return _base }
