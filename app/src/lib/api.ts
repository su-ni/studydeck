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
  /* 每次响应都是「这一刻」—— 它不是数据，是这台机器几点生成的。
     loadBase 比对内容时会把它摘掉，见 stableOf()。 */
  generated_at?: string
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
  /* /api/base 不再下发每一讲（889 讲光 lessons[] 就占掉大半个 245KB），
     只给一个总秒数。想拿讲次列表的走 list_lessons 工具，那里才是真源头。
     字段特意删掉而不是留成可选：留在类型里，下一个人读 s.lessons 会拿到
     undefined，累加出来的时长静静地变 0，界面上只是「时长未记」。 */
  dur_total?: number
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
/* 上一次响应带的 ETag。只放内存：刷新一次重新谈一遍条件请求，
   代价是一个 304，比在 localStorage 里维护一份会过期的校验值省心。 */
let _etag = ''

/* 内容指纹：比对「有没有真的变」用。
   为什么不能直接 JSON.stringify 整个包：服务端每次都会盖一个新的 generated_at
   （就是响应那一刻的时间），整份字节永远不会相等 —— 拿它做判据等于每次都
   「变了」，setState 换新对象，整棵树重渲染，正是要挡的那个坑。
   所以只摘掉这一个每次必变的字段；其余（subjects / kpi / vocab…）原样参与比对。
   代价是 JSON 序列化一遍 200KB 的包，比一次网络往返 + 全树重渲染便宜得多。
   键序不需要额外排序：同一个服务端每次都是同样的序列化顺序，而且真换了顺序
   也只是多判一次「变了」，不会漏掉真变化。 */
function stableOf(b: Base): string {
  return JSON.stringify(b, (k, v) => (k === 'generated_at' ? undefined : v))
}

let _stable = ''

/* 拿首屏数据。
   - force=false：20 秒内直接用缓存（入库 / 助手改数据都发生在会话中间，
     缓一整个会话的话刚落库回来页面还显示「0 课程」）。
   - 条件请求：带着上次的 ETag 去问，服务端 304 就说明内容没动。
     304 时【必须返回同一个对象引用】—— App 那边 setBase 拿到同一个引用会直接
     bailout，不重渲染；这里如果顺手 _base = {..._base} 造一个新的，
     60 秒一次的全树重渲染就白省了。
   - 200 时也不无脑换对象：服务端没上 ETag、或者 ETag 没命中时，靠 stableOf
     自己比对一次内容，没变还是返回旧引用。这样「后端还没改」也不会退化成
     每分钟一次的重渲染。
   - 304 也刷新 _baseAt：它的意思是「你手上那份仍然是最新的」，不是「没拿到数据」。 */
export async function loadBase(force = false): Promise<Base> {
  if (_base && !force && Date.now() - _baseAt < 20_000) return _base
  const headers: Record<string, string> = {}
  if (_etag) headers['If-None-Match'] = _etag
  // cache:'no-store' 仍然保留 —— 浏览器自己的 HTTP 缓存不该替我们做决定，
  // 条件请求是我们显式发的。
  const r = await fetch('/api/base', { cache: 'no-store', headers })
  if (r.status === 304) {
    // 没有 _base 却收到 304 是服务端/代理的错配（比如有人手动带了头）。
    // 不当成成功，也不静默返回 null —— 报出去，走调用处的错误分支。
    if (!_base) throw new Error('HTTP 304 但本地没有缓存可复用')
    _baseAt = Date.now()
    return _base
  }
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const fresh = (await r.json()) as Base
  const et = r.headers.get('ETag')
  if (et) _etag = et
  _baseAt = Date.now()
  const st = stableOf(fresh)
  // 内容没变：丢掉新解析出来的这份，把旧引用还回去。
  if (_base && st === _stable) return _base
  _base = fresh
  _stable = st
  return fresh
}
export function getBaseSync(): Base | null { return _base }
