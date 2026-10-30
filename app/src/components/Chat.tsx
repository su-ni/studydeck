import { useEffect, useMemo, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { Icon } from '../components/Icon'
import { ModelPicker } from '../components/ModelPicker'
import { EffortPicker } from '../components/EffortPicker'
import { PermPicker } from '../components/PermPicker'
import { setIntent } from '../lib/intent'
import {
  asrStatus, cancel as asrCancel, clearError as asrClearError,
  snapshot as asrSnapshot, start as asrStart, stop as asrStop,
  subscribe as asrSubscribe, takeText as asrTakeText,
  type AsrState,
} from '../lib/recorder'
import { md } from '../md'

/* ================= 今日页：一个能聊的助手 =================

   这里**不是**一条流水线。人在框里说什么都行 —— 闲聊、问概念、让它改个错别字。
   要不要去查本机、要不要去搜课、要不要排计划，由模型自己判断（见 server/agent.py）。

   ---- 布局（用户 2026-10-23 定，按 Trae / WorkBuddy / DSH 那类产品的样子）----
   ① 空白态：输入框在页面正中，上面一行招呼，下面一排引子。不是一个「卡片浮在半空」。
   ② 发出后：输入框吸在底部，对话在上面滚。整页只有一条滚动条，就是对话那条。
   ③ 想改上一句：点那条用户气泡就把原话填回输入框，不用往上翻着找。
   工具调用和思考过程**直接长在对话流里**，不另开侧栏 —— 读回答时视线就在这一条上。 */

type Trace = {
  tool: string
  args?: Record<string, unknown>
  ms?: number
  ok?: boolean
  summary?: string
  /* 后端另给一份「完整但精简」的结构（summary 是给模型看的，截到 300 字，
     解析不了）。搜索类工具靠它摊成课程卡。 */
  ui?: { keyword?: string; n?: number; items?: Record<string, any>[] } | null
  error?: string
  need_confirm?: boolean
  confirmed?: boolean
}

type Pending = { tool: string; args: Record<string, unknown>; desc?: string }

/* 操作卡：模型给的「下一步」按钮。点了是真调工具，不是摆设。
   为什么要有它：能点出来的事不该让人打字描述（用户原话）。 */
/* batch：后端自动补的那颗「全部入库」。它不是模型提议的，是界面补的便利按钮，
   样式上要能看出来（主按钮色），否则一排四个按钮长得一样，人不知道点哪个省事。 */
type CardAct = { label: string; tool: string; args: Record<string, unknown>; confirm?: boolean; batch?: boolean }
type Card = { title?: string; note?: string; actions: CardAct[] }

/* 一个提问框：模型要人拍板时给出来的可点选项。
   单选点一下就走；多选要先勾再点「就这些」。 */
type AskOpt = { label: string; value: string }
/* 一组问题。模型一轮问几样就有几组 —— 都在同一个框里问完、一次发出去。 */
type AskGroup = { question: string; options: AskOpt[]; multi: boolean; hint?: string }
type Ask = {
  /* 单组时用这两个（老格式，后端也还这么给）；多组时看 groups。 */
  question?: string
  options?: AskOpt[]
  multi?: boolean
  groups?: AskGroup[]
  hint?: string
}

/* 用量：全是上游 token_usage 里数出来的字段。拿不到就没有这一项 ——
   状态条宁可缺一块，也不给估出来的数字。 */
type Usage = {
  provider?: string; model?: string; ms?: number; tok_s?: number
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number
  cache_read_input_tokens?: number; reasoning_tokens?: number
  ctx?: number; ctx_pct?: number
  cum_tokens?: number; cum_prompt?: number; cum_cache_read?: number
}
/* 上下文是怎么拼的：拼之前一共几条、留了几条原文、折叠了几条、头部摘要多长、
   有没有因为吃不消而收紧。全是后端拼的时候数出来的（context.digest 的 LAST）。 */
type CtxInfo = {
  total?: number; kept?: number; folded?: number
  head_chars?: number; ctx_chars?: number; tight?: boolean
}
type Meta = {
  provider?: string; model?: string; rounds?: number; max_rounds?: number
  usage?: Usage | null; ctx?: CtxInfo | null
}

/* token 数目写成 12.3k / 1.2M。数不出来就返回空串 —— 不拿别的单位顶替。 */
function fmtTok(n?: number | null): string {
  if (typeof n !== 'number' || !isFinite(n)) return ''
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

/* 一条助手消息内部的「过程」，按它真实干活的先后顺序排：
   想一段 → 调个工具 → 再想一段 → 再调一个 → 最后说话。

   2026-10-24 用户的原话：「为什么所有的思考都集中在一个气泡里面？它不应该是分开的吗？
   某个思考的时候调用工具，那下一次思考不应该出现在这个调用工具下面的吗？」
   以前 think 是一整串、trace 是一个数组，两者拼起来读就把顺序抹平了 ——
   现在按顺序存 steps，界面从上往下读就是他刚才的经历。 */
type Step =
  | { k: 'think'; t: string; done?: boolean }
  | { k: 'tool'; x: Trace }

type Msg = {
  role: 'user' | 'assistant'
  text: string
  /* steps 是新的：过程按顺序。think / trace 是老字段，只为了把旧记录
     和「后端还没存 steps」的情形也能画出来（降级：思考在前、工具按序在后）。 */
  steps?: Step[]
  trace?: Trace[]
  think?: string
  pending?: Pending | null
  ask?: Ask | null
  card?: Card | null
  meta?: Meta
  /* 这是第几轮：界面上「从这一轮分叉」要用它当边界（fork 只允许切在 turn 边界） */
  turn?: number
}

/* 后端 + 事件流 + kv 三种来源的行，统一成界面用的 Msg。
   「最后一条、且后面没人回过话」的 ask 才算还挂着 —— 历史上答过的卡不恢复，
   长回来一张点不动的死卡比没有更糟。 */
function normMsgs(rows: any[]): Msg[] {
  return rows
    .map((m: any) => {
      const row: Msg = { role: m.role, text: (m.text ?? m.content ?? '').trim() }
      if (m.role === 'assistant') {
        if (Array.isArray(m.steps) && m.steps.length) row.steps = m.steps
        if (Array.isArray(m.trace) && m.trace.length) row.trace = m.trace
        if (m.think) row.think = m.think
        if (m.ask && rows[rows.length - 1] === m) row.ask = m.ask
        if (m.card && Array.isArray(m.card.actions) && m.card.actions.length) row.card = m.card
        if (m.pending) row.pending = m.pending
        if (m.meta) row.meta = m.meta
        if (typeof m.turn === 'number') row.turn = m.turn
      }
      return row
    })
    .filter((m) => m.text.length > 0 || (m.steps || []).length > 0)
}

const FOCUS_NAME: Record<string, string> = {
  today: '今日', classroom: '课堂', courses: '课程库', schedule: '课表', vocab: '背单词',
  practice: '练习', exam: '考场', stats: '统计', writing: '作文', agent: '设置', canvas: '画布',
}

/* 空态给几句话当引子。故意分成四类 —— 前三句都不是「填目标」，
   因为这里本来就该能随便聊，不该一进门就把人推到「你要考什么」。 */
const TRY = [
  { t: '随便问', s: 'abandon 和 give up 有什么区别？' },
  { t: '问进度', s: '我今天该学什么？' },
  { t: '要它动手', s: '帮我找 C 语言的课，排一个两周的计划' },
  { t: '试试别的', s: '把我这个月的学习情况说个总结' },
]

function argLine(a?: Record<string, unknown>) {
  if (!a) return ''
  const s = JSON.stringify(a)
  return s === '{}' ? '' : s.length > 70 ? s.slice(0, 70) + '…' : s
}

/* steps 是可变累积的，进 React 状态得换个新引用，否则界面不重画。 */
function cloneSteps(a: Step[]): Step[] {
  return a.map((s) => (s.k === 'think' ? { ...s } : { ...s, x: { ...s.x } }))
}

/* 正文开始吐 / 工具要跑了 —— 说明上一段思考已经想完了，给它封口。
   封口之后那段思考就自动收起，位置让给下一段。 */
function sealThink(steps: Step[]) {
  const prev = steps[steps.length - 1]
  if (prev && prev.k === 'think' && !prev.done) prev.done = true
}

/* ---------------- 搜索结果：当场摊成课程卡 ----------------

   用户 2026-10-24 的原话：「他搜索完之后就给我这些信息，但我没有办法看到这些东西……
   然后我会确定吗？但是我不知道它长啥样啊。」
   以前 bili_search 只有一个「返回」按钮，点开是一坨 JSON —— 等于让人对着 BV 号挑课。
   现在把搜到的课当场摊成卡：封面、标题、up、时长、播放量，下面「用这门」，
   点一下选学科就入库，全程不用打一个字。 */

const SUBJECTS = [
  { id: 'cs', name: '计算机' },
  { id: 'english', name: '英语' },
  { id: 'math', name: '高数' },
  { id: 'politics', name: '政治' },
  { id: 'clang', name: 'C 语言' },
]

function fmtDur(secs?: number) {
  const n = Number(secs) || 0
  if (!n) return ''
  const h = Math.floor(n / 3600)
  const m = Math.round((n % 3600) / 60)
  return h ? h + ' 时 ' + m + ' 分' : m + ' 分'
}

function fmtPlay(n?: number) {
  const v = Number(n) || 0
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿'
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万'
  return String(v)
}

function BiliCard({ it }: { it: Record<string, any> }) {
  const [pick, setPick] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [bad, setBad] = useState(false)
  const [imgBad, setImgBad] = useState(false)
  const [steps, setSteps] = useState<RunStep[]>([])

  async function addTo(sid: string) {
    setBusy(sid)
    setBad(false)
    setMsg('')
    setSteps([])
    try {
      /* 入库要走三个真步骤（取信息 → 拉分集 → 写库），这里把每一步都摊出来，
         别让人对着一个不动的字等。 */
      const r = await runToolStream('course_add',
        { bvid: it.bvid, name: it.title, subject: sid }, true,
        (s) => setSteps((prev) => prev.filter((x) => x.id !== s.id).concat([s])))
      const d = r.data || {}
      if (r.ok && d.ok !== false) {
        setMsg(effectOf(d) || ('已入库：' + String(it.title || it.bvid).slice(0, 30)))
        setPick(false)
      } else {
        setBad(true)
        setMsg(d.reason || d.error || r.error || '没入成，原因没拿到')
      }
    } catch (e) {
      setBad(true)
      setMsg(e instanceof Error ? e.message : '连不上本机服务')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="bcard">
      <div className="bcard-cv">
        {it.pic && !imgBad ? (
          <img src={String(it.pic)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgBad(true)} />
        ) : (
          <span className="bcard-ph">{String(it.up || '?').slice(0, 1)}</span>
        )}
        {it.secs ? <span className="bcard-dur">{fmtDur(it.secs)}</span> : null}
      </div>
      <div className="bcard-bd">
        <div className="bcard-t" title={it.title}>{it.title || it.bvid}</div>
        <div className="bcard-m">
          {it.up || '未知作者'}{it.play ? ' · ' + fmtPlay(it.play) + ' 播放' : ''}
        </div>
        <div className="bcard-a">
          <button className="btn xs" onClick={() => setPick(!pick)} disabled={!!busy}>
            {pick ? '算了' : '用这门'}
          </button>
          {msg ? <span className={'bcard-msg' + (bad ? ' bad' : '')}>{msg}</span> : null}
        </div>
        {pick ? (
          <div className="bcard-sub">
            <span>归到哪一科：</span>
            {SUBJECTS.map((s) => (
              <button key={s.id} className="btn xs" disabled={!!busy} onClick={() => addTo(s.id)}>
                {busy === s.id ? '…' : s.name}
              </button>
            ))}
          </div>
        ) : null}
        <RunTrace steps={steps} busy={!!busy} />
      </div>
    </div>
  )
}

/* 一组课 + 批量入库。
   为什么要批量：搜出来 4 门，一门门点「用这门→选学科」是 8 次点击；
   一把入库是 2 次。少交互的实质就在这种地方，不是把按钮做大。 */
function BiliCards({ items }: { items: Record<string, any>[] }) {
  const [pick, setPick] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  async function addAll(sid: string) {
    setBusy(sid)
    setMsg('')
    let ok = 0
    for (const it of items) {
      const r = await callTool<any>('course_add',
        { bvid: it.bvid, name: it.title, subject: sid }, { confirm: true })
      if (r.ok && r.data && r.data.ok !== false) ok++
    }
    setBusy('')
    setPick(false)
    setMsg('入了 ' + ok + ' / ' + items.length + ' 门')
  }

  return (
    <div className="bwrap">
      <div className="bcards">
        {items.map((it, i) => <BiliCard it={it} key={String(it.bvid || i)} />)}
      </div>
      <div className="ball">
        <button className="btn xs" onClick={() => setPick(!pick)} disabled={!!busy}>
          {pick ? '算了' : '全部入库'}
        </button>
        {pick ? (
          <>
            <span>归到哪一科：</span>
            {SUBJECTS.map((s) => (
              <button key={s.id} className="btn xs" disabled={!!busy} onClick={() => addAll(s.id)}>
                {busy === s.id ? '入库中…' : s.name}
              </button>
            ))}
          </>
        ) : null}
        {msg ? <span className="ball-msg">{msg}</span> : null}
      </div>
    </div>
  )
}

/* 分集表：一门课有多少集、每集多长。
   以前这里只显示 {"total":72,"pages":[...]} —— 想知道「一共多少集」得自己数。 */
function PagesCard({ d }: { d: Record<string, any> }) {
  const mins = Number(d.total_min) || 0
  return (
    <div className="pcard">
      <div className="pcard-h">
        <b>{d.total} 集</b>
        {mins ? <span>{Math.round(mins / 6) / 10} 小时</span> : null}
        {d.bvid ? <span className="pmono">{String(d.bvid)}</span> : null}
      </div>
      {(d.pages || []).map((p: Record<string, any>, i: number) => (
        <div className="prow" key={i}>
          <span className="prow-i">{p.p}</span>
          <span className="prow-t">{p.t}</span>
          <span className="prow-m">{p.min} 分</span>
        </div>
      ))}
      {d.more ? <div className="pcard-e">还有 {d.more} 集没列出来</div> : null}
    </div>
  )
}

/* 今日安排：三件事排成一张表，右边标着各自动作。
   比让模型复述一遍强：它复述会漏项，这里是工具的原始返回。 */
function PlanCard({ d }: { d: Record<string, any> }) {
  return (
    <div className="plan">
      {(d.rows || []).map((r: Record<string, any>, i: number) => (
        <div className="planrow" key={i}>
          <span className="plan-n">{i + 1}</span>
          <span className="plan-b">
            <span className="plan-t">{r.title}</span>
            {r.meta ? <span className="plan-m">{r.meta}</span> : null}
          </span>
          {r.action ? <span className="plan-a">{r.action}</span> : null}
        </div>
      ))}
      {d.rule ? <div className="plan-e">{d.rule}</div> : null}
    </div>
  )
}

/* 结构化结果：搜课 / 分集表 / 今日安排。
   对话里的 ToolLine 和卡片按钮都走这一个组件 —— 同一份回执在哪儿都长一样，
   不会出现「对话里能看到封面，点按钮只得到一句调通了」。 */
function UiBlock({ ui, tool, ok, ms }: {
  ui: any; tool: string; ok: boolean; ms?: number | null
}) {
  const [open, setOpen] = useState(true)
  const own = Array.isArray(ui?.items) && ui.items.length ? ui.items : null
  const ch = ui?.channels?.video?.items
  const vids = Array.isArray(ch) && ch.length ? ch : null
  const list = (own || vids) as Record<string, any>[] | null
  const kind = ui?.kind as string | undefined
  if (!(kind === 'pages' || kind === 'plan' || list)) return null
  const kw = ui?.keyword || ui?.channels?.video?.keyword || ''
  const head = kind === 'pages' ? '分集表' : kind === 'plan' ? '今日安排'
    : (tool === 'bili_search' || tool === 'web_search' || tool === 'search_all'
      ? '搜到的课' : tool)
  const sub = kind === 'pages' ? String(ui?.total ?? '') + ' 集'
    : kind === 'plan' ? String(ui?.n ?? '') + ' 件'
    : (kw ? '「' + kw + '」 ' : '') + String(list ? list.length : 0) + ' 门'
  return (
    <div className={'cln rich' + (ok ? '' : ' bad')}>
      <button className="cln-hd" onClick={() => setOpen(!open)}>
        <span className="cln-dot" data-ok={ok ? '1' : '0'} />
        <b>{head}</b>
        <em>{sub}</em>
        <span className="cln-ms">{ms != null ? ms + 'ms' : ''}</span>
        <span className="cln-cv">{open ? '收起' : '展开'}</span>
      </button>
      {open ? (
        kind === 'pages' ? <PagesCard d={ui} />
          : kind === 'plan' ? <PlanCard d={ui} />
          : <BiliCards items={list as Record<string, any>[]} />
      ) : null}
    </div>
  )
}

/* 一条工具调用：状态点 + 名字 + 参数 + 耗时，点开看返回。
   它跟这句话是同一个整体，所以不当「附件」缩进，而是当成这段过程的一行。
   搜索结果单独走一条路：直接摊成卡片，不用点开。 */
/* 工具在界面上不该以 `plan_today` 这种名字出现 —— 那是代码里的叫法。
   常用工具给一句人话，没登记的退回原名（宁可露名，也不编一个假名字）。 */
const TOOL_CN: Record<string, string> = {
  plan_today: '排今天的任务', stats_overview: '读进度', list_subjects: '读课程',
  list_item_sources: '读题源', lesson_quiz: '取这一讲的题', make_quiz: '出题',
  get_current_lesson: '看学到哪了', bili_search: '搜 B 站课程', intake_pick: '核对课程',
  course_add: '入库课程', course_add_many: '批量入库', vocab_library: '读词书',
  vocab_pull: '拉词书', grade_answer: '判分', lesson_notes: '读笔记',
  explain_coverage: '算可讲率', explain_stats: '读讲题记录', checkin_calendar: '读打卡',
}

function ToolLine({ x }: { x: Trace }) {
  const [open, setOpen] = useState(false)
  const data = useMemo(() => {
    if (x.ui) return x.ui
    try {
      return x.summary ? JSON.parse(x.summary) : null
    } catch {
      return null
    }
  }, [x.summary, x.ui])
  const own = Array.isArray(data?.items) && data.items.length ? data.items : null
  const ch = data?.channels?.video?.items
  const vids = Array.isArray(ch) && ch.length ? ch : null
  const list = (own || vids) as Record<string, any>[] | null
  const kind = data?.kind as string | undefined

  if (kind === 'pages' || kind === 'plan' || list) {
    return <UiBlock ui={data} tool={x.tool} ok={!!x.ok} ms={x.ms} />
  }

  return (
    <div className={'cln' + (x.ok ? '' : ' bad')}>
      <button className="cln-hd" onClick={() => setOpen(!open)}>
        <span className="cln-dot" data-ok={x.ok ? '1' : '0'} />
        <b>{TOOL_CN[x.tool] || x.tool}</b>
        <em>{argLine(x.args)}</em>
        <span className="cln-ms">{x.ms != null ? x.ms + 'ms' : ''}</span>
        <span className="cln-cv">{open ? '收起' : '返回'}</span>
      </button>
      {open && (
        <div className="cln-bd">
          {x.confirmed && <div className="cln-tag">你点过确认</div>}
          {x.need_confirm && <div className="cln-tag warn">等确认</div>}
          {x.error ? <div className="cln-err">{x.error}</div> : <pre>{x.summary || '（无返回摘要）'}</pre>}
        </div>
      )}
    </div>
  )
}

/* 跑一个工具，把过程一步一步接住。

   ---- 人 2026-10-26 的原话 ----
   「主要是我点击这个执行后，你应该给我看到过程才对呀，不然我怎么知道到底在不在运行呢？
     这个时候我也应该要看见 AI 在做的事情才对呀。」
   原来卡片按钮是一次静默 callTool：点下去只有「执行中…」，而 intake_pick 要真跑
   三十秒核六门课 —— 界面上跟卡死一模一样。所以改成走 /api/tool/{name}/run（SSE）：
   开始、中间每一步、结果都推过来，界面照着画。
   工具自己没报进度也照样看得见「在跑」—— 至少有一条「跑着…」在动。 */
type RunStep = { id: number; msg: string; n?: number; total?: number }

async function runToolStream(
  tool: string, args: Record<string, any>, confirm: boolean,
  onStep: (s: RunStep) => void,
): Promise<{ ok: boolean; ms?: number; data: any; ui?: any; error?: string; need_confirm?: boolean; perm?: string }> {
  const res = await fetch(`/api/tool/${encodeURIComponent(tool)}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: args || {}, confirm: !!confirm }),
  })
  if (!res.ok || !res.body) throw new Error('服务没回：HTTP ' + res.status)
  const rd = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let end: any = null
  let k = 0
  while (true) {
    const { done, value } = await rd.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let o: any
        try { o = JSON.parse(line.slice(6)) } catch { continue }
        if (o.t === 'start') {
          onStep({ id: k++, msg: (o.desc || o.tool) + '' })
        } else if (o.t === 'step') {
          onStep({ id: k++, msg: o.msg || '', n: o.n, total: o.total })
        } else if (o.t === 'alive') {
          /* 工具自己没报进度：至少把「还活着 + 真过了几秒」摆出来。
             用固定 id，界面上是同一行在跳秒，不会堆成十几行。 */
          onStep({ id: -1, msg: `还在跑…（已 ${o.sec} 秒）` })
        } else if (o.t === 'end') {
          end = o
        }
      }
    }
  }
  if (!end) return { ok: false, data: {}, error: '连接断了，没收到结果' }
  return end
}

/* 从工具回执里挑一句「它到底干了什么」。

   2026-10-26 出事的就是这一步：原来只要 ok 为真就打「做完了」，
   而 intake_pick 返回 ok=True 却什么都没写进课程库 —— 人看到「已执行」，
   去课程库一看还是空的。所以现在只认工具自己写的那句话（say / effect），
   它没说自己改了什么，我们就不许替它宣布成功。 */
function effectOf(d: any): string {
  if (!d || typeof d !== 'object') return ''
  for (const k of ['say', 'effect']) {
    const v = d[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/* 跑的过程摊在按钮下面：一行一步，小圆点是「正在做的那一步」。 */
function RunTrace({ steps, busy }: { steps: RunStep[]; busy: boolean }) {
  if (!steps.length && !busy) return null
  return (
    <div className="acard-run">
      {steps.map((s, i) => (
        <div className="arow" key={s.id}>
          <span className={'adot' + (busy && i === steps.length - 1 ? ' live' : '')} />
          <span className="atxt">
            {s.msg}
            {typeof s.n === 'number' && typeof s.total === 'number' ? `（${s.n}/${s.total}）` : ''}
          </span>
        </div>
      ))}
      {busy && !steps.length ? (
        <div className="arow">
          <span className="adot live" />
          <span className="atxt">跑着…</span>
        </div>
      ) : null}
    </div>
  )
}

/* 操作卡：标题 + 一句说明 + 最多四个按钮。
   按钮点下去真调工具 —— 需要写盘的带 confirm，等于「你点了就是同意」。
   跑的过程实时摊出来；结果只认工具自己说的那句成效，不替它宣布成功。 */
function ActionCard({ c }: { c: Card }) {
  const [busy, setBusy] = useState('')
  const [steps, setSteps] = useState<RunStep[]>([])
  const [msg, setMsg] = useState('')
  const [bad, setBad] = useState(false)
  const [mid, setMid] = useState(false)
  const [gone, setGone] = useState('')
  const [ms, setMs] = useState<number | null>(null)
  const [ui, setUi] = useState<any>(null)
  const [uiTool, setUiTool] = useState('')

  async function run(a: CardAct) {
    setBusy(a.label)
    setMsg('')
    setBad(false)
    setMid(false)
    setSteps([])
    setMs(null)
    setUi(null)
    setUiTool(a.tool)
    /* 心跳行（id=-1）只留最新一条，其余照顺序追加。 */
    const pushStep = (s: RunStep) => setSteps((prev) => prev.filter((x) => x.id !== s.id).concat([s]))
    try {
      const r = await runToolStream(a.tool, a.args || {}, !!a.confirm, pushStep)
      const d = r.data || {}
      setMs(typeof r.ms === 'number' ? r.ms : null)
      if (r.ui) setUi(r.ui)
      if (r.need_confirm) {
        setBad(true)
        setMsg('这一步要你确认才会真执行，刚才没动手')
        return
      }
      if (r.ok && d.ok !== false) {
        setGone(a.label)
        const eff = effectOf(d)
        const writes = r.perm === 'confirm'
        const ek = d.effect_kind as string | undefined
        /* 工具自己说了「没改动」或「没说改了什么」都照它的话显示，
           但两者的后续动作不一样：noop 是正常结果（黄），unknown 要人去核（红）。
           只读工具真拿到东西了（比如搜到 5 门课），那句话是结果不是警告，不上黄。 */
        setMid(ek === 'noop' || (!eff && !writes))
        if (ek === 'unknown') {
          setBad(true)
          setMsg(eff || `${a.tool} 没回报改了什么，你自己核一下`)
        } else if (eff) setMsg(eff)
        else if (writes) {
          setBad(true)
          setMsg(`${a.tool} 调通了，但它没回报这次改了什么，你自己核一下`)
        } else {
          setMsg(`调通了${typeof r.ms === 'number' ? `（${(r.ms / 1000).toFixed(1)} 秒）` : ''}—— 这一步只读，没改动本机`)
        }
      } else {
        setBad(true)
        setMsg(d.reason || d.error || r.error || '没成，原因没拿到')
      }
    } catch (e) {
      setBad(true)
      setMsg(e instanceof Error ? e.message : '连不上本机服务')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="acard">
      {c.title ? <div className="acard-t">{c.title}</div> : null}
      {c.note ? <div className="acard-n">{c.note}</div> : null}
      <div className="acard-a">
        {c.actions.map((a, i) => (
          <button
            key={i}
            className={'btn xs' + (i === 0 || a.batch ? ' act-main' : '') + (a.batch ? ' act-batch' : '')}
            disabled={!!busy}
            onClick={() => run(a)}
          >
            {busy === a.label ? '执行中…' : (gone === a.label ? '执行过' : a.label)}
          </button>
        ))}
        {msg ? <span className={'acard-msg' + (bad ? ' bad' : mid ? ' mid' : '')}>{msg}</span> : null}
      </div>
      <RunTrace steps={steps} busy={!!busy} />
      {ui ? <UiBlock ui={ui} tool={uiTool} ok ms={ms} /> : null}
      {ms != null && !busy ? (
        <div className="acard-took">用时 {(ms / 1000).toFixed(1)} 秒</div>
      ) : null}
    </div>
  )
}

/* 思考过程：分两态。

   进行中（live）—— 默认展开，边想边把字吐出来。不展开就等于让人对着
   「思考过程」干等，看不到它在干什么。
   想完了 —— 自动收起成一行「思考过程 · N tok」，点开还能看全文。
   人手动点过之后就按人的来，不再被自动收放覆盖（manual）。

   2026-10-24 用户要求：「思考完成就自动收起，下次思考自动展开」。
   2026-10-26：**不许再写「N 字」**。字数是字符数，跟烧了多少 token 没关系，
   拿它冒充用量是骗人。只有本轮上游真给了 reasoning_tokens 才写 tok，
   而且只有这一段思考时才对得上号（有好几段就归到整轮，不硬摊）。
   拿不到就不写 —— 宁可这一行只剩标题。 */
function Think({ s, live, tok }: { s: string; live?: boolean; tok?: number }) {
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? !!live
  if (!s.trim()) return null
  return (
    <div className={'cthink' + (open ? ' open' : '') + (live ? ' live' : '')}>
      <button className="cthink-hd" onClick={() => setManual(!open)}>
        <span className="cthink-ic" aria-hidden="true">✳</span>
        <b>{live ? '正在想' : '思考过程'}</b>
        {typeof tok === 'number' && tok > 0 ? <em>{fmtTok(tok)} tok</em> : null}
        <span className="cln-cv">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        /* 思考内容也走 Markdown：模型在思考里写的列表、表格、代码片段，
           按原样摊成纯文本会很难读（它经常用 - 列点、用 ``` 贴代码）。 */
        <div className="cthink-bd" dangerouslySetInnerHTML={{ __html: md(s) }} />
      )}
    </div>
  )
}

/* 过程时间线：想一段 → 调一个工具 → 再想一段 → …，按它真实干活的顺序往下排。
   live 只给最后一个节点：正在想的那一段要展开跟随，前面想完的已经收起来了。
   thinkTok：本轮上游给的 reasoning_tokens。**只在整轮只有一段思考时**才贴到那段上 ——
   三段思考摊一个总数，等于给每段都编了个数。 */
function StepFlow({ steps, live, thinkTok }: { steps: Step[]; live?: boolean; thinkTok?: number }) {
  const thinks = steps.filter((s) => s.k === 'think').length
  return (
    <div className="csteps">
      {steps.map((s, i) =>
        s.k === 'think' ? (
          <Think key={i} s={s.t} live={!!live && i === steps.length - 1}
            tok={thinks === 1 ? thinkTok : undefined} />
        ) : (
          <ToolLine x={s.x} key={i} />
        )
      )}
    </div>
  )
}

/* 一个提问框：模型要人拍板时给出来的东西。

   ---- 人 2026-10-24 的原话 ----
   「让他做完完整的提问和选项，直接给我，让我选择完之后发出去。现在他给我三个问题，
    我点一个就直接发过去了，哪有这样问的。」
   所以这里有两条硬规矩：
   ① 点选项**永远只是选中**，绝不发出去。单选用圆点、多选用方框，都要再点「发出去」。
   ② 模型一轮抛几个问题就在一个框里问完（Ask 可以是分组），底下只有一颗「发出去」，
      答齐了一次性发回去 —— 不允许一个问题一个来回，更不允许点一下就替我回答。

   还要能自己打字：选项里没有的那一条，人有话说。 */
/* 底部状态条：轮次 / 步数 / 吐字速度 / 累计用量 / 上下文占用。
   每个数字都来自这一轮上游真的吐出来的 token_usage（platform_ai._stamp_usage）。
   上游没给就整块不画 —— 不拿「字数 ÷ 时间」凑一个像样的 tok/s 糊弄人。

   2026-10-26 用户要求：「为什么不能点开看详情？」「环形百分比的事，上下文百分比，
   以及上下文自动压缩工具」——
   所以这一条现在是按钮：点开是这一轮的完整账（prompt / 输出 / 缓存 / 思考 / 耗时 /
   累计 / 窗口 / 占用率 / 上下文拼了几条折叠了几条），底下带一个「立刻压缩」。
   缺的项**整行不画**，不写 0，也不拿别的单位顶上。 */
function ChatStat({ m, busy }: { m?: Msg; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [cOn, setCOn] = useState(false)
  const [cBusy, setCBusy] = useState(false)
  const [cNote, setCNote] = useState('')
  const u = m?.meta?.usage
  const cx = m?.meta?.ctx
  const rounds = m?.meta?.rounds || 0
  const steps = (m?.trace || []).length
  const cumTok = u?.cum_tokens
  const cachePct = (u?.cum_prompt && u?.cum_cache_read)
    ? Math.round((u.cum_cache_read * 100) / u.cum_prompt) : null
  const pct = u?.ctx_pct
  const hasAny = rounds > 0 || !!u
  if (!hasAny) {
    return (
      <span className="cstat-tip">
        Enter 发送 · Shift+Enter 换行 · 点上面任意一条你说的话可以改
      </span>
    )
  }
  const r = 5.4, C = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct || 0))
  /* 占用率越高环越警觉：过半换黄，过八成换红。颜色只表达「还剩多少地方」，不做装饰。 */
  const ringColor = p >= 80 ? 'var(--bad)' : p >= 50 ? 'var(--warn)' : 'var(--act)'

  async function toggleCompact() {
    if (cBusy) return
    setCBusy(true)
    try {
      const rr = await fetch('/api/agent/compact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !cOn }),
      })
      const d = await rr.json()
      setCOn(!!d.on)
      setCNote((d.note as string) || '')
    } catch {
      setCNote('连不上本机服务，没压成')
    } finally {
      setCBusy(false)
    }
  }

  const rows: [string, string][] = []
  if (m?.meta?.provider) {
    rows.push(['模型', (m.meta.provider || '') + (m.meta.model ? ' · ' + m.meta.model : '')])
  }
  if (rounds > 0) {
    rows.push(['轮次', `${rounds}${m?.meta?.max_rounds ? '/' + m.meta.max_rounds : ''} 轮 · ${steps} 步`])
  }
  if (typeof u?.ms === 'number') rows.push(['本轮耗时', (u.ms / 1000).toFixed(1) + ' 秒'])
  if (typeof u?.tok_s === 'number') rows.push(['吐字速度', u.tok_s + ' tok/s'])
  if (typeof u?.prompt_tokens === 'number') rows.push(['本轮输入', fmtTok(u.prompt_tokens) + ' tok'])
  if (typeof u?.completion_tokens === 'number') rows.push(['本轮输出', fmtTok(u.completion_tokens) + ' tok'])
  if (typeof u?.total_tokens === 'number') rows.push(['本轮合计', fmtTok(u.total_tokens) + ' tok'])
  if (typeof u?.cache_read_input_tokens === 'number') {
    rows.push(['命中缓存', fmtTok(u.cache_read_input_tokens) + ' tok'])
  }
  if (typeof u?.reasoning_tokens === 'number') {
    rows.push(['思考用量', fmtTok(u.reasoning_tokens) + ' tok'])
  }
  if (typeof cumTok === 'number' && cumTok > 0) {
    rows.push(['累计 token', fmtTok(cumTok) + (cachePct != null ? `（缓存命中 ${cachePct}%）` : '')])
  }
  if (typeof u?.ctx === 'number') rows.push(['上下文窗口', fmtTok(u.ctx) + ' tok'])
  if (typeof pct === 'number') rows.push(['本次占用', p + '%'])
  if (cx && typeof cx.total === 'number') {
    rows.push(['上下文拼装', `${cx.total} 条 → 留 ${cx.kept} · 折叠 ${cx.folded}` +
      (cx.tight ? '（已收紧）' : '')])
  }

  return (
    <div className="cstat-wrap">
      {open && (
        <div className="cstat-pop" role="dialog" aria-label="这一轮的用量明细">
          <div className="csp-hd">
            <b>这一轮的账</b>
            <button className="csp-x" onClick={() => setOpen(false)} aria-label="收起">×</button>
          </div>
          <div className="csp-body">
            {rows.length ? rows.map(([k, v]) => (
              <div className="csp-row" key={k}>
                <span className="csp-k">{k}</span>
                <span className="csp-v">{v}</span>
              </div>
            )) : (
              <div className="csp-row">
                <span className="csp-k">用量</span>
                <span className="csp-v">这一轮上游没给 token 用量，所以这里没有数字可看</span>
              </div>
            )}
          </div>
          <div className="csp-ft">
            <button className={'csp-btn' + (cOn ? ' on' : '')} onClick={toggleCompact} disabled={cBusy}>
              {cBusy ? '处理中…' : cOn ? '解除压缩' : '立刻压缩上下文'}
            </button>
            {cNote ? <span className="csp-note">{cNote}</span> : (
              <span className="csp-note">
                压缩只折叠措辞：你说过的关键事实和你真调过的工具都会留一行原话摘要。
              </span>
            )}
          </div>
        </div>
      )}
      <button className="cstat" onClick={() => setOpen((o) => !o)}
        title="点开看这一轮的用量明细">
        {rounds > 0 && (
          <span className="cst">
            <Icon n="clock" size={12} />
            {rounds} 轮 {steps} 步{u?.tok_s ? ` · ${u.tok_s} tok/s` : ''}
          </span>
        )}
        {typeof cumTok === 'number' && cumTok > 0 && (
          <span className="cst">
            <Icon n="stack" size={12} />
            {fmtTok(cumTok)} tok{cachePct != null ? ` · 缓存命中 ${cachePct}%` : ''}
          </span>
        )}
        {typeof pct === 'number' && (
          <span className="cst" title={`这一个模型的窗口 ${fmtTok(u?.ctx)} tok，这次请求带了 ${fmtTok(u?.prompt_tokens)} tok`}>
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
              <circle cx="7" cy="7" r={r} fill="none" stroke="var(--line2)" strokeWidth="1.7" />
              <circle cx="7" cy="7" r={r} fill="none" stroke={ringColor} strokeWidth="1.7"
                strokeDasharray={`${(C * p) / 100} ${C}`} strokeLinecap="round"
                transform="rotate(-90 7 7)" />
            </svg>
            {p}%
          </span>
        )}
        {busy ? <span className="cst run">跑着…</span> : null}
        <span className="cst-more">{open ? '收起' : '详情'}</span>
      </button>
    </div>
  )
}

function AskBox({ a, locked, onSend }: { a: Ask; locked?: boolean; onSend: (txt: string) => void }) {
  const groups: AskGroup[] = a.groups && a.groups.length
    ? a.groups
    : [{ question: a.question || '', options: a.options || [], multi: !!a.multi }]
  /* picked[i]：第 i 组勾中的 value 列表；extra[i]：第 i 组人自己打的字。 */
  const [picked, setPicked] = useState<string[][]>(() => groups.map(() => []))
  const [extra, setExtra] = useState<string[]>(() => groups.map(() => ''))

  const toggle = (gi: number, v: string) => {
    if (locked) return
    setPicked((p) => {
      const n = p.map((x) => x.slice())
      const cur = n[gi] || []
      if (groups[gi].multi) {
        n[gi] = cur.indexOf(v) >= 0 ? cur.filter((x) => x !== v) : cur.concat([v])
      } else {
        n[gi] = cur[0] === v ? [] : [v]   /* 单选框再点一下能取消 —— 选错了得有退路 */
      }
      return n
    })
  }
  /* 人自己写的字也留一份在 ref 里：React 的 setState 是异步的，
     手快的人写完立刻按 Enter，这一帧 extra 还是旧的，会被判成「没答」。
     两个来源都算数，就不怕先后顺序。 */
  const extraRef = useRef<string[]>(groups.map(() => ''))
  const setEx = (gi: number, s: string) => {
    extraRef.current[gi] = s
    setExtra((p) => { const n = p.slice(); n[gi] = s; return n })
  }

  /* 一组里有几样都算「答了」：勾了选项，或者自己写了字。 */
  const filled = (gi: number) =>
    (picked[gi] || []).length > 0 || (extra[gi] || '').trim().length > 0 ||
    (extraRef.current[gi] || '').trim().length > 0
  const ready = groups.length > 0 && groups.every((_, gi) => filled(gi))
  const nth = groups.length > 1 ? groups.filter((_, gi) => filled(gi)).length : 0

  /* 拼成一句话发回去。一组一问就原样给答案；多组就「问：答」分行 ——
     模型看得懂，人也看得懂自己刚发了什么。 */
  const submit = () => {
    if (!ready || locked) return
    const lines: string[] = []
    groups.forEach((g, gi) => {
      const parts: string[] = []
      const pk = picked[gi] || []
      if (pk.length) parts.push(pk.join('、'))
      const ex = ((extra[gi] || '') || (extraRef.current[gi] || '')).trim()
      if (ex) parts.push(ex)
      if (!parts.length) return
      const ans = parts.join('；')
      lines.push(groups.length > 1 && g.question ? g.question + '：' + ans : ans)
    })
    if (lines.length) onSend(lines.join('\n'))
  }

  return (
    <div className={'cask' + (locked ? ' locked' : '')}>
      {groups.map((g, gi) => (
        <div className="cask-g" key={gi}>
          <b className="cask-q">
            {groups.length > 1 && <span className="cask-no">{gi + 1}</span>}
            {g.question || '想清楚了吗'}
            <em className="cask-tag">{g.multi ? '可多选' : '单选'}</em>
          </b>
          {g.options.length > 0 && (
            <div className="cask-opts">
              {g.options.map((o) => {
                const on = (picked[gi] || []).indexOf(o.value) >= 0
                return (
                  <button
                    key={o.value}
                    className={'cask-opt' + (on ? ' on' : '')}
                    disabled={locked}
                    onClick={() => toggle(gi, o.value)}
                  >
                    <span className="cask-box" data-on={on ? '1' : '0'} data-multi={g.multi ? '1' : '0'} />
                    {o.label}
                  </button>
                )
              })}
            </div>
          )}
          {/* 选项里没有的那一条：人自己有话说。这是「完整提问」，不是猜谜。 */}
          {!locked && (
            <input
              className="cask-in"
              value={extra[gi] || ''}
              placeholder={g.hint || (g.options.length ? '或者自己写' : '自己写一句：日期、时长、科目都行')}
              onChange={(e) => setEx(gi, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
          )}
        </div>
      ))}
      <div className="cask-ft">
        <span className="cask-n">
          {locked ? '已经发出去了'
            : !ready ? (groups.length > 1 ? '还有 ' + (groups.length - nth) + ' 个没答' : '选一个，或者自己写')
              : groups.length > 1 ? groups.length + ' 个都答了' : '可以发'}
        </span>
        <div className="sp" />
        <button className="btn sm act" onClick={submit} disabled={!ready || locked}>
          {locked ? '已发送' : '发出去'}
        </button>
      </div>
    </div>
  )
}

export function Chat({
  page,
  onToggle,
  toggleLabel,
}: {
  page: string
  /* 今日页右上角那个「看今天的安排」按钮，画在聊天区自己的顶栏里。 */
  onToggle?: () => void
  toggleLabel?: string
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  /* 拖/粘进来的东西。浏览器拿不到真实路径（安全限制），所以落地成本机文件，
     再把路径拼进这一句话里 —— 模型要的是「在哪」，不是几十兆 base64。 */
  const [atts, setAtts] = useState<{ path: string; name: string; size: number; kind: string }[]>([])
  const [dropOn, setDropOn] = useState(false)
  const [busy, setBusy] = useState(false)
  /* 上一轮是不是半路停了（撞上限/断流）—— 是就摆一颗「接着干」 */
  const [stalled, setStalled] = useState(false)
  /* 它现在到底在干什么。看得见进度，人才不会隔十秒来问一句「卡了？」 */
  /* 这个名字以前叫 Step —— 它把模块级那个「思考步骤」的 Step 类型遮住了，
     runWork 里的 `const steps: Step[]` 于是被解析成进度条的类型，编译报
     「Type 'Step' is missing the following properties: k, t」。改成 Prog 各归各。 */
  type Prog = { n: number; total: number; label: string; doing: string; done: number }
  const [step, setStep] = useState<Prog | null>(null)
  const stepRef = useRef<Prog | null>(null)
  const [elapsed, setElapsed] = useState(0)

  /* 秒表：只要在跑就每秒加一。数字自己在动，人就知道它还活着。 */
  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t0 = Date.now()
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [busy])
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)
  /* 会话分栏：本机的会话列表 + 当前是哪条 + 面板开没开 */
  const [sess, setSess] = useState<Array<{ id: string; title?: string | null; events?: number }>>([])
  const [curSid, setCurSid] = useState('')
  const [sessOpen, setSessOpen] = useState(false)
  const [sessQ, setSessQ] = useState('')
  /* 是否贴底。人往上翻去看历史时不再自动拽回底部 —— 那是「正在读」，不是「正在等」。 */
  const [atBottom, setAtBottom] = useState(true)
  /* 正在改第几条用户消息（null = 不是在改）。只把原话填回输入框，
     不删历史 —— 删了服务端那条还在，模型照样看得见，那就是假的。 */
  const [editIdx, setEditIdx] = useState<number | null>(null)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)

  /* ---- 语音输入 ----------------------------------------------------------
     录音器在 lib/recorder.ts 里，是模块级单例 —— 这里只订阅它的状态。
     所以切页、点别处、Chat 整个卸载都不会打断录音；只有点麦克风才会停。 */
  const [asr, setAsr] = useState<AsrState>(asrSnapshot())
  useEffect(() => asrSubscribe(setAsr), [])

  /* 按下麦克风那一刻输入框里已有的字。实时的字都接在它后面，
     这样「先打半句再补一句语音」不会把打好的冲掉。 */
  const liveBaseRef = useRef('')

  /* 实时上屏：录音期间后端每切出一句就把文字送回来，这里立刻写进输入框。
     —— 人要的就是这个：话还没说完，前面的字已经在框里了。 */
  useEffect(() => {
    if (asr.phase !== 'recording') return
    if (!asr.live) return
    setText(liveBaseRef.current + asr.live)
    requestAnimationFrame(() => {
      const t = taRef.current
      if (!t) return
      t.style.height = 'auto'
      t.style.height = Math.min(t.scrollHeight, 132) + 'px'
    })
  }, [asr.live, asr.phase])

  /* Ctrl/Cmd+F：这一屏没有顶栏（Chat 自己占满，不走 Shell），
     所以 App 那只框压根不在这儿 —— 不补这一段的话，在聊天里按 Ctrl+F
     会唤出浏览器的查找栏，显得「搜索在这页坏了」。
     做法跟别处一致：焦点在自己的输入框/文本域里时让给浏览器原生查找，
     否则发一个事件请 App 打开居中的搜索弹窗（App 是唯一持有它状态的地方）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || (e.key !== 'f' && e.key !== 'F')) return
      const t = e.target as HTMLElement | null
      const tag = (t?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (t as any)?.isContentEditable) return
      e.preventDefault()
      window.dispatchEvent(new Event('sd:search-open'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* 停止后的收尾：把最后半句也拿到，替换成完整文字。
     取一次即清（recorder.takeText），所以切页回来不会重复粘一遍。 */
  useEffect(() => {
    if (asr.phase !== 'idle') return
    const got = asrTakeText()
    if (!got) return
    setText(liveBaseRef.current + got)
    requestAnimationFrame(() => {
      const t = taRef.current
      if (!t) return
      t.style.height = 'auto'
      t.style.height = Math.min(t.scrollHeight, 132) + 'px'
      t.focus()
    })
  }, [asr.phase])

  /* 麦克风：三种情况
       还在录 → 停（这是唯一能停的方式）
       正在转 → 不理
       没模型 → 送去设置页语音分区，装完回来就能用
     注意这里没有任何「点空白就结束」的监听 —— 那是要刻意写才会有的，不写就没有。 */
  async function onMic() {
    if (asr.phase === 'recording') { await asrStop(); return }
    if (asr.phase === 'transcribing') return
    if (asr.phase === 'error') asrClearError()

    const s = await asrStatus()
    if (!s || !s.installed) {
      setIntent({
        page: 'agent',
        sec: 'voice',
        note: s
          ? '语音模型还没装。在这儿点一下「装」，回来再按麦克风就能说话。'
          : '连不上本机服务，没法确认语音模型装没装。',
      })
      location.hash = 'agent'
      return
    }
    liveBaseRef.current = text
    await asrStart()
  }

  const mmss = (n: number) => {
    const m = Math.floor(n / 60)
    const s = n % 60
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
  }

  /* 这一轮的流式请求。「停一下」= 先让后端在检查点收口，再掐掉本地这条读流。 */
  const acRef = useRef<AbortController | null>(null)

  /* 历史：跨次重启还在（存在本机 kv 表）。

     人 2026-10-24 报的 bug：「工具调用刷新一下网页就不见了」。
     原先后端只存 role+content，刷新回来 trace / ask / pending / meta 全空。
     现在这些都跟着那条 assistant 一起存（见 agent._stamp），这里逐条还原：

       - trace  → 那一轮它查了什么、查出什么，点开还能看返回摘要；
       - ask    → 提问卡还在，但已经答过了，按 locked 只读渲染；
       - pending→ 等确认的那一步也留着（不然刷新之后就没法确认了）；
       - meta   → 用的哪家模型、跑了几轮；
       - think  → 那次想了什么。

     老的记录（改之前存的）没有这些字段，渲染出来只有话，也不会报错。 */
  useEffect(() => {
    let alive = true
    /* 后端存的字段是 content（model 那边的叫法），这边显示用的叫 text。 */
    type HRow = {
      role: 'user' | 'assistant'
      content?: string
      text?: string
      steps?: Step[]
      trace?: Trace[]
      think?: string
      ask?: Ask | null
      pending?: Pending | null
      card?: Card | null
      meta?: Meta
      turn?: number
    }
    callTool<{ messages: HRow[] }>('agent_history', { limit: 60 }).then((r) => {
      if (!alive) return
      const rows = (r.ok && r.data?.messages) || []
      const norm = normMsgs(rows)
      if (norm.length) setMsgs(norm)
      setLoaded(true)
      loadSessions()
    })
    return () => { alive = false }
  }, [])

  /* 滚到底：直接量那一条滚动容器的 scrollHeight，不用 scrollIntoView ——
     后者会把外层任何能滚的祖先一起带着滚，页面就多出一条滚动条。 */
  useEffect(() => {
    if (!loaded) return
    const b = bodyRef.current
    if (!b || !atBottom) return
    b.scrollTop = b.scrollHeight
  }, [msgs, loaded, atBottom])

  /* 内嵌网页自己报高度：模型画的那张小卡片多高只有它自己知道，
     固定 320px 要么留白要么截断。只认带 sdFrameH 的消息，别的 postMessage 一概不理。 */
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const h = (e.data || {}).sdFrameH
      if (typeof h !== 'number' || h < 40) return
      const frames = document.querySelectorAll('.mhtml iframe')
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i] as HTMLIFrameElement
        if (f.contentWindow === e.source) {
          f.style.height = Math.min(760, Math.max(90, h + 4)) + 'px'
          return
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  /* 输入框随字数长高，封顶 200px 之后自己滚。 */
  useEffect(() => {
    const t = taRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(200, Math.max(52, t.scrollHeight)) + 'px'
  }, [text])

  function onBodyScroll() {
    const b = bodyRef.current
    if (!b) return
    const gap = b.scrollHeight - b.scrollTop - b.clientHeight
    setAtBottom(gap < 48)
  }

  function jumpBottom() {
    const b = bodyRef.current
    if (!b) return
    b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }

  /* 点用户那条气泡：原话填回输入框，光标落尾。人不用往上翻着找自己刚写错的那句。 */
  /* 提问卡什么时候只读：它后面已经有人回过话了，或者它自己正在跑。
     判据只认「这一条之后有没有 user 消息」——assistant 尾巴、空消息都不算，
     否则流刚结束那一帧就会把刚画出来的卡判成已发送。 */
  function askLocked(i: number) {
    /* 不看 busy：刚收到 ask 那一帧 busy 还在收尾，拿它判会把刚画出来的卡画成「已发送」。
       只认「这条之后人有没有回过话」——这是唯一需要只读的情形。 */
    return msgs.slice(i + 1).some((x) => x.role === 'user' && !!(x.text || '').trim())
  }

  function editFrom(i: number) {
    const m = msgs[i]
    if (!m || m.role !== 'user') return
    setText(m.text)
    setEditIdx(i)
    const t = taRef.current
    if (t) { t.focus(); requestAnimationFrame(() => { try { t.setSelectionRange(m.text.length, m.text.length) } catch {} }) }
  }

  /* ---- 收件箱：拖进来 / 粘进来的文件先落盘，再把路径交给助手 ---- */
  async function uploadOne(f: File) {
    // 文件夹拖进来时浏览器的相对路径是 "子目录/文件.txt"，压成一层文件名
    const raw = ((f as unknown as { webkitRelativePath?: string }).webkitRelativePath || f.name)
      .replace(/\//g, '__') || 'paste.bin'
    try {
      const r = await fetch('/api/inbox?name=' + encodeURIComponent(raw), {
        method: 'POST', body: f,
      })
      const d = await r.json()
      if (!d?.ok) { setErr(d?.detail || '这个文件没收下'); return null }
      return { path: d.path as string, name: d.name as string, size: d.size as number, kind: d.kind as string }
    } catch {
      setErr('传文件时连不上本机服务')
      return null
    }
  }

  async function addFiles(list: File[]) {
    if (!list.length) return
    const got: { path: string; name: string; size: number; kind: string }[] = []
    for (const f of list.slice(0, 120)) {         // 整个文件夹最多 120 个，多的先不要
      const a = await uploadOne(f)
      if (a) got.push(a)
    }
    if (got.length) setAtts((x) => [...x, ...got])
    if (list.length > 120) setErr('文件太多，只收了前 120 个')
  }

  /* 拖文件夹时 File 列表是空的，得顺着 entry 往下翻 */
  async function walkEntry(entry: any, out: File[], depth = 0): Promise<void> {
    if (out.length >= 120 || depth > 6) return
    if (entry.isFile) {
      const f = await new Promise<File | null>((res) => entry.file(res, () => res(null)))
      if (f) out.push(f)
      return
    }
    if (entry.isDirectory) {
      const rd = entry.createReader()
      const batch: any[] = await new Promise((res) => rd.readEntries(res, () => res([])))
      for (const e of batch) await walkEntry(e, out, depth + 1)
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDropOn(false)
    const dt = e.dataTransfer
    const entries: any[] = []
    for (let i = 0; i < dt.items.length; i++) {
      const en = (dt.items[i] as any).webkitGetAsEntry?.()
      if (en) entries.push(en)
    }
    if (entries.length) {
      const out: File[] = []
      for (const en of entries) await walkEntry(en, out)
      if (out.length) { await addFiles(out); return }
    }
    if (dt.files?.length) await addFiles(Array.from(dt.files))
  }

  async function onPaste(e: React.ClipboardEvent) {
    const fs: File[] = []
    for (const it of Array.from(e.clipboardData?.items || [])) {
      if (it.kind !== 'file') continue
      const f = it.getAsFile()
      if (f) {
        // 剪贴板里的截图没有文件名，给个能认出来的
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        fs.push(f.name && f.name !== 'image.png'
          ? f : new File([f], 'paste-' + Date.now() + '.' + ext, { type: f.type }))
      }
    }
    if (fs.length) { e.preventDefault(); await addFiles(fs) }
  }

  async function send(q0?: string, confirmed?: Pending) {
    const q = (q0 ?? text).trim()
    /* 只拖了文件、一个字没打也算一句话 —— 用户就是这个意思（「看看这个」） */
    if ((!q && !atts.length) || busyRef.current) return
    const attached = atts.length > 0
    /* 气泡里显示的是人说的原话，发给模型的那句后面挂真实路径 */
    const forModel = attached
      ? (q || '看看这些文件') + '\n\n' + atts.map((a) => `[附件] ${a.path}`).join('\n')
      : q
    busyRef.current = true
    setBusy(true)
    setErr('')
    setAtBottom(true)
    const ac = new AbortController()
    acRef.current = ac

    /* hasA：这一轮有没有已经开了 assistant 气泡。
       工具可能在第一个字之前就先跑（先查再答），所以不能靠「收到 token」判断。 */
    let hasA = false
    const patchA = (patch: Partial<Msg>) => {
      if (!hasA) {
        hasA = true
        setMsgs((m) => [...m, { role: 'assistant', text: '', ...patch }])
        return
      }
      setMsgs((m) => {
        const n = m.slice()
        const k = n.length - 1
        if (k >= 0) n[k] = { ...n[k], ...patch }
        return n
      })
    }

    if (!confirmed) {
      setMsgs((m) => [...m, { role: 'user', text: q || '（发了 ' + atts.length + ' 个文件）' }])
      setText('')
      setAtts([])
      setEditIdx(null)
    } else {
      /* 确认重放：不追加用户气泡（那句已经在了），但要把上一轮的 pending 摘掉 */
      setMsgs((m) => {
        const n = m.slice()
        for (let i = n.length - 1; i >= 0; i--) {
          if (n[i].role === 'assistant' && n[i].pending) {
            n[i] = { ...n[i], pending: null }
            break
          }
        }
        return n
      })
    }

    let acc = ''
    let think = ''
    const trace: Trace[] = []
    const steps: Step[] = []
    let ended = false
    /* 轮数顶满 = 它是被工具上限掐停的，不是自己说完了。这种要给「接着干」。 */
    let roundsHitCap = false

    try {
      const res = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 档位由 EffortPicker 写在后端，这里不用再传；后端 turn() 自己读 kv。
        body: JSON.stringify({ text: forModel, confirmed: confirmed || null, focus: page }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
      const rd = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        /* SSE 用空行分帧；收到的那一块可能断在半行，剩下的留在 buf 等下一块 */
        let cut = buf.indexOf('\n\n')
        while (cut >= 0) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          cut = buf.indexOf('\n\n')
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            let o: Record<string, unknown>
            try { o = JSON.parse(line.slice(5).trim()) } catch { continue }
            const kind = o.t as string
            if (kind === 'token') {
              const d = (o.d as string) || ''
              if (!d) continue
              acc += d
              sealThink(steps)          // 开始说话了，上一段思考到此为止
              patchA({ text: acc, steps: cloneSteps(steps) })
            } else if (kind === 'think') {
              const d = (o.d as string) || ''
              if (!d) continue
              think += d
              /* 还是同一段思考就往后接，已经调过工具了就另起一段 ——
                 这样「想→做→再想」在界面上是三个块，不是一个越来越长的气泡。 */
              const tail = steps[steps.length - 1]
              if (tail && tail.k === 'think' && !tail.done) tail.t += d
              else steps.push({ k: 'think', t: d })
              patchA({ steps: cloneSteps(steps), think })
            } else if (kind === 'step') {
              /* 它在干活，不是卡住了：把「第几轮」「正在做什么」推到界面上。 */
              stepRef.current = {
                n: (o.n as number) || 0,
                total: (o.total as number) || 20,
                label: (o.label as string) || '',
                doing: stepRef.current?.doing || '',
                done: (o.done as number) || 0,
              }
              setStep({ ...stepRef.current })
            } else if (kind === 'run') {
              /* 某个慢工具刚开跑：这一刻起它确实在等接口，不是死机。 */
              stepRef.current = {
                n: stepRef.current?.n || 1,
                total: stepRef.current?.total || 20,
                label: stepRef.current?.label || '',
                doing: (o.desc as string) || (o.n as string) || '',
                done: stepRef.current?.done || 0,
              }
              setStep({ ...stepRef.current })
            } else if (kind === 'substep') {
              /* 工具内部的一小步：「核第 3/6 条 · BV1xx —— 136 P / 103.1 小时」。
                 这不是动画，是工具自己报的真进度；没有它，跑三十秒和卡死长得一样。 */
              stepRef.current = {
                n: stepRef.current?.n || 1,
                total: stepRef.current?.total || 20,
                label: stepRef.current?.label || '',
                doing: ((o.msg as string) || '') +
                  (typeof o.i === 'number' && typeof o.of === 'number' ? `（${o.i}/${o.of}）` : ''),
                done: stepRef.current?.done || 0,
              }
              setStep({ ...stepRef.current })
            } else if (kind === 'tool') {
              trace.push({
                tool: (o.n as string) || '',
                args: (o.args as Record<string, unknown>) || {},
                ms: (o.ms as number) || 0,
                ok: !!o.ok,
                summary: (o.summary as string) || undefined,
                ui: (o.ui as Trace['ui']) || null,
                error: (o.error as string) || undefined,
                need_confirm: !!o.need_confirm,
              } as Trace)
              sealThink(steps)          // 要调工具了，这段思考想完了
              steps.push({ k: 'tool', x: trace[trace.length - 1] })
              patchA({ steps: cloneSteps(steps), trace: trace.slice() })
            } else if (kind === 'end') {
              ended = true
              const mr = (o.max_rounds as number) || 0
              roundsHitCap = mr > 0 && ((o.rounds as number) || 0) >= mr
              const finalText = (o.text as string) || acc
              sealThink(steps)
              patchA({
                text: finalText,
                think: think || undefined,
                trace: trace.slice(),
                steps: cloneSteps(steps),
                pending: (o.pending as Pending) || null,
                ask: (o.ask as Ask) || null,
                /* 操作卡必须挂上去。原来这里漏了 card 这一行，后端明明把卡片推过来了，
                   屏幕上却只剩一句「这几个核过的，点一下就入库」—— 按钮一颗都没有。
                   刷新一下反而能看到（那是从记录里恢复的），所以这个 bug 只在当场出现。 */
                card: (o.card as Card) || null,
                meta: {
                  provider: o.provider as string,
                  model: o.model as string,
                  rounds: o.rounds as number,
                  max_rounds: mr,
                  usage: (o.usage as Usage) || null,
                  ctx: (o.ctx as CtxInfo) || null,
                },
              })
              if (!o.ok) setErr((o.error as string) || '没回话')
            } else if (kind === 'err') {
              setErr((o.error as string) || '出错了')
            }
          }
        }
      }
      if (!ended) setErr('连接断了，这句没答完')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        /* 自己按的停：不是故障，把已经吐出来的字留下来就行 */
        patchA({ text: acc || '（已停下）' })
      } else {
        /* 浏览器的 fetch 在网络层失败只会给「network error / Failed to fetch」——
           那句话帮不到人。说清是「服务那边断了」，不是模型不干活。 */
        const msg = e instanceof Error ? e.message : ''
        setErr((msg && msg !== 'network error' && msg !== 'Failed to fetch')
          ? msg
          : '连不上本机服务 —— 8771 那个进程可能退出了，重开一下（start-blank.bat）再发')
        patchA({ text: acc || '（没答完）' })
      }
    } finally {
      /* 这一轮是不是「活干到一半停了」：撞工具上限（rounds 顶满）或断流。
         人看到「怎么停了」时，给他一颗按钮，别再让他打一遍「继续」。 */
      setStalled(!ended || roundsHitCap)
      busyRef.current = false
      setBusy(false)
      stepRef.current = null
      setStep(null)
      acRef.current = null
    }
  }

  /* 「接着干」：不新加一句用户话，直接让后端把上一轮续上。
     走 agent_resume —— 它会把最后那句用户话重放一遍，但系统提示换成「你已经查过了」。 */
  async function resumeRun() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setStalled(false)
    setErr('')
    const ac = new AbortController()
    acRef.current = ac
    let hasA = false
    const patchA = (patch: Partial<Msg>) => {
      if (!hasA) { hasA = true; setMsgs((m) => [...m, { role: 'assistant', text: '', ...patch }]); return }
      setMsgs((m) => { const n = m.slice(); const k = n.length - 1; if (k >= 0) n[k] = { ...n[k], ...patch }; return n })
    }
    let acc = ''
    let think = ''
    const trace: Trace[] = []
    const steps: Step[] = []
    let ended = false
    let capped = false
    try {
      const res = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '', resume: true, focus: page }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
      const rd = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await rd.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let cut = buf.indexOf('\n\n')
        while (cut >= 0) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          cut = buf.indexOf('\n\n')
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            let o: Record<string, unknown>
            try { o = JSON.parse(line.slice(5).trim()) } catch { continue }
            const kind = o.t as string
            if (kind === 'token') { const d = (o.d as string) || ''; if (!d) continue; acc += d; sealThink(steps); patchA({ text: acc, steps: cloneSteps(steps) }) }
            else if (kind === 'think') {
              const d = (o.d as string) || ''
              if (!d) continue
              think += d
              const tail = steps[steps.length - 1]
              if (tail && tail.k === 'think' && !tail.done) tail.t += d
              else steps.push({ k: 'think', t: d })
              patchA({ steps: cloneSteps(steps), think })
            }
            else if (kind === 'step') {
              stepRef.current = { n: (o.n as number) || 0, total: (o.total as number) || 20, label: (o.label as string) || '', doing: stepRef.current?.doing || '', done: (o.done as number) || 0 }
              setStep({ ...stepRef.current })
            }
            else if (kind === 'run') {
              stepRef.current = { n: stepRef.current?.n || 1, total: stepRef.current?.total || 20, label: stepRef.current?.label || '', doing: (o.desc as string) || (o.n as string) || '', done: stepRef.current?.done || 0 }
              setStep({ ...stepRef.current })
            }
            else if (kind === 'substep') {
              stepRef.current = { n: stepRef.current?.n || 1, total: stepRef.current?.total || 20, label: stepRef.current?.label || '',
                doing: ((o.msg as string) || '') + (typeof o.i === 'number' && typeof o.of === 'number' ? `（${o.i}/${o.of}）` : ''),
                done: stepRef.current?.done || 0 }
              setStep({ ...stepRef.current })
            }
            else if (kind === 'tool') {
              trace.push({ tool: (o.n as string) || '', args: (o.args as Record<string, unknown>) || {}, ms: (o.ms as number) || 0, ok: !!o.ok, summary: (o.summary as string) || undefined, ui: (o.ui as Trace['ui']) || null, error: (o.error as string) || undefined } as Trace)
              sealThink(steps)
              steps.push({ k: 'tool', x: trace[trace.length - 1] })
              patchA({ steps: cloneSteps(steps), trace: trace.slice() })
            } else if (kind === 'end') {
              ended = true
              const mr2 = (o.max_rounds as number) || 0
              capped = mr2 > 0 && ((o.rounds as number) || 0) >= mr2
              sealThink(steps)
              patchA({
                text: (o.text as string) || acc,
                think: think || undefined,
                trace: trace.slice(),
                steps: cloneSteps(steps),
                pending: (o.pending as Pending) || null,
                ask: (o.ask as Ask) || null,
                /* 续跑这条路原来也漏了 card：捡回来的那半截活干完给了卡片，
                   屏幕上照样一颗按钮都没有。两条路必须同时补，否则「按继续」又是空的。 */
                card: (o.card as Card) || null,
                meta: {
                  provider: o.provider as string, model: o.model as string,
                  rounds: o.rounds as number, max_rounds: mr2,
                  usage: (o.usage as Usage) || null,
                  ctx: (o.ctx as CtxInfo) || null,
                },
              })
              if (!o.ok) setErr((o.error as string) || '没回话')
            } else if (kind === 'err') setErr((o.error as string) || '出错了')
          }
        }
      }
      if (!ended) setErr('连接断了，这句没答完')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        patchA({ text: acc || '（已停下）' })   // 续跑被停：留下已经吐出来的字
      } else {
        const msg = e instanceof Error ? e.message : ''
        setErr((msg && msg !== 'network error' && msg !== 'Failed to fetch')
          ? msg : '连不上本机服务 —— 8771 那个进程可能退出了，重开一下（start-blank.bat）再发')
      }
    } finally {
      busyRef.current = false
      setBusy(false)
      setStalled(!ended || capped)
      stepRef.current = null
      setStep(null)
      acRef.current = null
    }
  }

  /* 「停一下」：先让后端在检查点收口（会话照常落盘），再掐掉本地这条读流。
     只掐流不让后端停的话，它还会闷头把 20 轮工具跑完 —— 白烧一次模型。 */
  async function stopRun() {
    try { await fetch('/api/agent/stop', { method: 'POST' }) } catch { /* 服务没回也照样收 */ }
    acRef.current?.abort()
  }

  async function confirm(p: Pending) {
    /* 人点了「确认」：把这一步带 confirmed 重放一次。
       agent 那边会先补跑这一步再接着答。 */
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    await send(lastUser?.text || '（确认执行）', p)
  }

  async function clearAll() {
    if (!window.confirm('把这段对话清掉？清掉之后它就不记得聊过什么了。')) return
    await callTool('agent_reset', {})
    setMsgs([])
    setErr('')
    setEditIdx(null)
    loadSessions()
  }

  /* ---- 会话分栏 ----
     像正常 agent 软件那样：多条会话分开存，左边能切。
     底层是 sessions / session_events 两张表，切的时候顺带把模型上下文也换过去
     （只改界面不换上下文的话，屏幕上是一条会话、模型脑子里是另一条）。
     切换后整页重载一次：历史、步骤、滚动位置全部按新会话重建，比手工 diff 可靠。 */
  async function loadSessions(kw?: string) {
    const term = String(kw ?? sessQ).trim()
    const r = term
      ? await callTool<any>('session_search', { q: term })
      : await callTool<any>('session_list', { limit: 40 })
    if (r.ok && r.data) {
      setSess(r.data.sessions || [])
      if (!term) setCurSid(r.data.current || '')
    }
  }

  async function archiveSess(id: string) {
    await callTool('session_archive', { sid: id })
    loadSessions()
  }

  async function forkSess(id: string) {
    const r = await callTool<any>('session_fork', { sid: id })
    if (r.ok) loadSessions()
    else setErr(r.error || '分叉没成')
  }

  /* 从某一轮之后分叉：只允许切在 turn 边界（fork at a turn boundary）。
     切在 step 中间的话，分出来的第一件事就是「工具调了、结果还没回来」，回放到那儿就断了。 */
  async function forkAt(turn: number) {
    const r = await callTool<any>('session_fork', { upto_turn: turn })
    if (r.ok) {
      await loadSessions()
      setSessOpen(true)
    } else {
      setErr(r.error || '分叉没成')
    }
  }

  async function switchTo(id: string) {
    if (!id || id === curSid) { setSessOpen(false); return }
    const r = await callTool<any>('session_switch', { sid: id })
    if (!r.ok) { setErr(r.error || '切不过去，原因没拿到'); return }
    setSessOpen(false)
    setCurSid(id)
    setErr('')
    setEditIdx(null)
    /* 不刷页：后端已经把上下文换成目标会话了，这里只要把界面上的消息换掉。
       重载会让整页闪一下，长会话看着像卡了。 */
    const h = await callTool<{ messages: any[] }>('agent_history', { limit: 60 })
    setMsgs(h.ok && h.data?.messages ? normMsgs(h.data.messages) : [])
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    loadSessions()
  }

  async function newSession() {
    const r = await callTool<any>('session_new', {})
    if (!r.ok) { setErr(r.error || '新会话没开成'); return }
    setSessOpen(false)
    setCurSid(r.data?.id || '')
    setMsgs([])
    setErr('')
    setEditIdx(null)
    loadSessions()
  }

  const empty = loaded && msgs.length === 0

  /* 底部状态条读最后一条带 meta 的助手消息 —— 刷新回来也照样有（meta 跟着记录存）。 */
  const lastStat = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const x = msgs[i]
      if (x.role === 'assistant' && x.meta) return x
    }
    return undefined
  }, [msgs])

  return (
    <div className={'chat' + (empty ? ' is-empty' : '')}>
      {/* 顶栏只有一行：这是谁的对话 + 切回卡片看板。不占高度，也不学仪表盘那一套标题块。 */}
      <div className="chat-head">
        <span className="chat-who">
          <span className="live" />
          研学台助手
          <em>{FOCUS_NAME[page] || page}</em>
        </span>
        <div className="sp" />
        {/* 会话分栏：几条会话分开存，点一下切过去，不用把旧的清掉 */}
        <div className="sess-wrap">
          <button className="btn sm" onClick={() => { setSessOpen(!sessOpen); loadSessions() }}>
            会话 {sess.length || ''}
          </button>
          {sessOpen && (
            <div className="sesspop">
              <div className="sesspop-h">
                <span>本机的会话</span>
                <button className="ubtn" onClick={newSession}>新开一条</button>
              </div>
              <div className="sesspop-q">
                <input
                  value={sessQ}
                  placeholder="搜说过的话、搜到的课…"
                  onChange={(e) => { setSessQ(e.target.value); loadSessions(e.target.value) }}
                />
              </div>
              <div className="sesspop-l">
                {sess.map((s) => (
                  <div className={'sessrow' + (s.id === curSid ? ' on' : '')} key={s.id}>
                    <button className="sessmain" onClick={() => switchTo(s.id)}>
                      <b>{s.title || '（还没起名）'}</b>
                      <em>{s.events || 0} 条过程</em>
                    </button>
                    <div className="sessacts">
                      <button className="ubtn" title="从这条复制一份继续聊，原来的不动" onClick={() => forkSess(s.id)}>分叉</button>
                      <button className="ubtn" title="归档：不删，列表里默认不显示" onClick={() => archiveSess(s.id)}>归档</button>
                    </div>
                  </div>
                ))}
                {!sess.length && (
                  <div className="sesspop-e">{sessQ ? '没搜到相关的会话' : '还没有会话，说一句话就有第一条。'}</div>
                )}
              </div>
            </div>
          )}
        </div>
        {onToggle && (
          <button className="btn sm" onClick={onToggle}>{toggleLabel || '换一种看法'}</button>
        )}
      </div>

      <div className="chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {empty ? (
          <div className="cgreet">
            <h1>想学什么、想问什么，直接说</h1>
            <p>
              它不是表单，也不会一进门就问你「考什么」。<br />
              你说目标它就去找课排计划；你只是随口问，它就只回话。
            </p>
          </div>
        ) : (
          <div className="cflow">
            {msgs.map((m, i) => m.role === 'user' ? (
              <div className={'cmsg user' + (editIdx === i ? ' editing' : '')} key={i}>
                <div className="uacts">
                  <button className="ubtn" onClick={() => editFrom(i)} title="把这句话填回输入框改">改</button>
                </div>
                <div className="cbub" dangerouslySetInnerHTML={{ __html: md(m.text) }} />
              </div>
            ) : (
              <div className="cmsg assistant" key={i}>
                {/* 想一段 → 调一个 → 再想一段：按它实际干活的顺序，从上往下读就是过程 */}
                {m.steps && m.steps.length ? (
                  <StepFlow steps={m.steps} live={busy && i === msgs.length - 1}
                    thinkTok={m.meta?.usage?.reasoning_tokens} />
                ) : (
                  <>
                    {m.think ? <Think s={m.think} tok={m.meta?.usage?.reasoning_tokens} /> : null}
                    {(m.trace || []).map((x, k) => <ToolLine x={x} key={k} />)}
                  </>
                )}
                {m.text ? (
                  <div className="cbub" dangerouslySetInnerHTML={{ __html: md(m.text) }} />
                ) : null}
                {m.turn ? (
                  <div className="cmeta">
                    <button
                      className="cmeta-act"
                      onClick={() => forkAt(m.turn as number)}
                      title="复制到这一轮为止，新开一条接着聊；原来这条不动"
                    >
                      从这儿分叉
                    </button>
                  </div>
                ) : null}
                {m.card ? <ActionCard c={m.card} /> : null}
                {m.ask ? (
                  <AskBox
                    a={m.ask}
                    /* 只有「它正等着你回答」时才锁：就是最后一条、且它没在跑。
                       之前的写法是 i < msgs.length - 1 || busy —— 流一结束 busy 还是 true 的那一帧，
                       整张卡就被画成已发送；更糟的是刷新回来时只要有半截空消息在后面，
                       最后一张卡也会被误判成过期。所以直接认 m.ask 本身：答完就清掉，清了才锁。 */
                    locked={askLocked(i)}
                    /* 发出去就当场清掉这一条卡：不然刷新回来，服务器上那行还带着 ask，
                       一张已经答过的卡会重新长出来。 */
                    onSend={(t) => {
                      setMsgs((n) => { const c = n.slice(); c[i] = { ...c[i], ask: null }; return c })
                      send(t)
                    }}
                  />
                ) : null}
                {m.pending && (
                  <div className="cbub warn">
                    <b>这一步要改本机：{m.pending.desc || m.pending.tool}</b>
                    <div className="cargs">{argLine(m.pending.args) || '（无参数）'}</div>
                    <div className="cacts">
                      <button className="btn sm act" onClick={() => confirm(m.pending!)}>执行</button>
                      <button
                        className="btn sm"
                        onClick={() => setMsgs((n) => {
                          const c = n.slice()
                          c[i] = { ...c[i], pending: null }
                          return c
                        })}
                      >算了</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {/* 它在干活的时候，把「第几轮、正在做什么、已经花了多久」摊出来。
                只有一个转圈的话，人分不清是在等接口还是死机了。 */}
            {busy && (
              <div className="cmsg assistant">
                <div className="cbub typing cprog">
                  <i /><i /><i />
                  <span className="cprog-t">
                    {step && step.doing
                      ? step.doing
                      : step
                        ? step.label || '正在想'
                        : '正在接上'}
                  </span>
                  {step && (
                    <span className="cprog-n">
                      第 {step.n}{step.total ? '/' + step.total : ''} 轮{step.done ? ` · 已查 ${step.done} 条` : ''}
                    </span>
                  )}
                  {elapsed > 0 && <span className="cprog-s">{elapsed}s</span>}
                </div>
              </div>
            )}
            {err && <div className="cmsg assistant"><div className="cbub bad">{err}</div></div>}
            {/* 半路停了就把话说清：是谁停的、为什么停，别让人以为它答完了。 */}
            {!busy && stalled && !empty && (
              <div className="cmsg assistant">
                <div className="cbub warn">
                  <b>这一轮它停在半路了</b>
                  <div>工具调用次数到顶，或者连接断了。前面查到的东西都还在，接着跑就行。</div>
                  <div className="cacts">
                    <button className="btn sm act" disabled={busy} onClick={resumeRun}>接着干</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 往上翻着读历史时，右下角给一颗「回到底部」；不自动拽，也不占布局。 */}
      {!empty && !atBottom && (
        <button className="jump" onClick={jumpBottom} title="回到最新一条">
          <Icon n="chev" size={14} />
        </button>
      )}

      <div className="chat-dock">
        <div className="dock-in">
          {/* 麦克风出问题就在这儿说清楚：被拒、被占用、没设备，三种原因给三种说法。
              点一下关掉，不自己消失 —— 一句话没听清就飘走的提示等于没说。 */}
          {asr.error ? (
            <button className="mic-err" onClick={asrClearError} title="知道了">
              <span>{asr.error}</span>
              <Icon n="x" size={11} />
            </button>
          ) : null}
          <div
            className={'cbox' + (busy ? ' busy' : '') + (dropOn ? ' dropping' : '')}
            onDragOver={(e) => { e.preventDefault(); if (!dropOn) setDropOn(true) }}
            onDragLeave={(e) => {
              /* 只有真的离开这个框才收高亮 —— 从 textarea 移到按钮上不该闪 */
              if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDropOn(false)
            }}
            onDrop={onDrop}
          >
            {atts.length ? (
              <div className="atts">
                {atts.map((a, i) => (
                  <span key={a.path + i} className="att" title={a.path}>
                    <Icon n={a.kind === 'image' ? 'img' : 'md'} size={11} />
                    <b>{a.name.length > 22 ? a.name.slice(0, 20) + '…' : a.name}</b>
                    <em>{a.size >= 1048576
                      ? (a.size / 1048576).toFixed(1) + 'M'
                      : Math.max(1, Math.round(a.size / 1024)) + 'K'}</em>
                    <button onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}
                      title="不发了"><Icon n="x" size={10} /></button>
                  </span>
                ))}
              </div>
            ) : null}
            {dropOn ? <div className="drop-hint">松手就收下 —— 文件、图片、整个文件夹都行</div> : null}
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              onPaste={onPaste}
              placeholder={'说句话。问进度、问概念、让它找课排计划都行 —— 不想动工具它就只跟你聊。'}
              onChange={(e) => {
                setText(e.target.value)
                /* 输入框跟着内容长高（封顶 5 行）—— 贴一段讲义、一次说三件事，
                   都不至于在一个 1 行高的框里蠕动。Trae/WorkBuddy 就是这么做的。 */
                const t = e.target
                t.style.height = 'auto'
                t.style.height = Math.min(t.scrollHeight, 132) + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  /* 正在说话不发：发了之后框被清空，后半句的实时字就接不上前面了。 */
                  if (asr.phase !== 'recording') send()
                }
                if (e.key === 'Escape' && editIdx != null) { setEditIdx(null); setText('') }
                /* ↑ 调回上一条自己说过的话：改一句话不用翻上去点 */
                if (e.key === 'ArrowUp' && !text && !busy) {
                  const mine = [...msgs].reverse().find((m) => m.role === 'user' && (m.text || '').trim())
                  if (mine) { e.preventDefault(); setText(mine.text) }
                }
              }}
            />
            <div className="cbar">
              <ModelPicker />
              <EffortPicker disabled={busy} />
              <PermPicker disabled={busy} />
              <div className="sp" />
              {msgs.length > 0 && (
                <button className="clr" onClick={clearAll} title="把这段对话清掉">清空</button>
              )}
              {/* 麦克风挨着清空、在它右边。录音时按钮自己变色，旁边跟一颗真实的秒数；
                  再点一次就是停 —— 除此之外没有任何东西能让它停。 */}
              <button
                className={'mic' + (asr.phase === 'recording' ? ' rec' : '')
                  + (asr.phase === 'transcribing' ? ' wait' : '')}
                onClick={onMic}
                disabled={asr.phase === 'transcribing'}
                title={asr.phase === 'recording' ? '点一下：停止并转成文字'
                  : asr.phase === 'transcribing' ? '正在转写…'
                    : '点一下开始说话（说完再点一下）'}
              >
                <Icon n="mic" size={14} />
              </button>
              {asr.phase === 'recording' ? (
                <span className="mic-t">
                  <i className="dot" />{mmss(asr.seconds)}
                  {asr.live ? ' · 已出 ' + asr.live.length + ' 字' : ''}
                  {' · 再点停'}
                </span>
              ) : asr.phase === 'transcribing' ? (
                <span className="mic-t dim">在收尾…</span>
              ) : null}
              {busy ? (
                <button className="send stop" onClick={stopRun}
                  title="停一下（这一步跑完就停，已说的话保留）">
                  <Icon n="stop" size={14} />
                </button>
              ) : (
                <button
                  className="send"
                  onClick={() => send()}
                  disabled={(!text.trim() && !atts.length) || asr.phase === 'recording'}
                  title={asr.phase === 'recording' ? '先把话说完' : '发送（Enter）'}
                >
                  <Icon n="chev" size={15} />
                </button>
              )}
            </div>
          </div>

          {empty ? (
            <div className="chips">
              {TRY.map((x) => (
                <button className="chip" key={x.t} onClick={() => send(x.s)}>
                  <b>{x.t}</b>
                  {x.s}
                </button>
              ))}
            </div>
          ) : (
            <div className="cfoot">
              {editIdx != null
                ? '正在改第 ' + (editIdx + 1) + ' 句 · 发出去是重新问一遍，旧记录还在（Esc 取消）'
                : <ChatStat m={lastStat} busy={busy} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
