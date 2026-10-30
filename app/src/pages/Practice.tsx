import { useEffect, useMemo, useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Collapse, Sect, Paper, Sc, Row, Bar, PBtn, Skel, clsColor } from '../components/V6'
import { Sel } from '../components/Sel'
import { Spread, Leaf, paginate, perLeaf } from '../components/Spread'

/* 练习页 v6：按 design-v6.html:309-421 重画，但排版改了 ——
   用户原话：题目用不上那么大空间，别一题一屏；能摆两张纸就摆两张，
   题干和选项算一道题、不拆开，一道挨一道排下去。
   所以这一页的纸是「一组题」，不是「一道题」：一页 5 道，窄屏 4 道，宽屏并两页。
   讲题四段仍然挂在它自己那一道题下面，就地展开 —— 位置永远是「解答该在的地方」。 */

type Q = {
  no: number; part: string; topic?: string; stem: string; opts: Record<string, string>
  ans?: string; explain?: string; id?: string; done?: boolean; last_ok?: number; kind?: string
  /* ref 是「讲题」定位用的键：语法库是题号，真题卷是 `paper:…|题号`，导入题源是题号。
     少了它就只能靠猜，讲题会讲错题 —— 所以取题接口一直带着它，别在这里丢掉。 */
  ref?: string; source?: string
}

/* 讲题返回的结构（server/explain.py:506-515）。四段固定：定位 / 依据 / 判断 / 纠错。
   每段下面的 lines[] 是逐字引文，带 where（出处）与 verified（是否在原文里命中）。
   verified=false 的引文整段作废 —— 所以这里必须把「没通过」画出来，不能只画通过的。 */
type ExLine = { kind: string; role?: string; text: string; where?: string; verified?: boolean }
type ExOpt = { opt: string; text: string; state?: string; note?: string }
type ExPart = { key: string; title: string; text?: string; from?: string; origin?: string; lines?: ExLine[]; opts?: ExOpt[]; gaps?: string[] }
type ExDoc = {
  found?: boolean; verdict?: string; verdict_note?: string; confidence?: number
  model?: string; verified?: boolean; parts?: ExPart[]; gaps?: string[]
  ans?: string; chosen?: string | null; reason?: string
}
type Src = {
  id: string; name: string; subject?: string; subject_name?: string
  kind: string; judge: string; why?: string; total: number; done?: number; wrong?: number
}
type Quiz = { questions: Q[]; parts: { name: string; n: number }[]; total: number }
type Cov = {
  total?: number; by_verdict?: Record<string, number>; speakable?: number
  speakable_rate?: number; avg_confidence?: number; by_source?: Record<string, Record<string, number>>
  stored?: Record<string, number>; note?: string
}

const JUDGE_CN: Record<string, string> = {
  exact: '精确判分',
  ai_exact: 'AI 判分·对答案',
  ai_semantic: 'AI 判分·看意思',
  manual: '人工判',
}
const KIND_CN: Record<string, string> = { choice: '单选', blank: '填空', short: '简答' }

// 题源卡的科目点。实现统一在 V6.clsColor，这里只留一个转发 ——
// 服务端给的是 coral/teal 这类颜色词，自己抄一份映射必然抄漏。
const SUB_COLOR: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_t, k: string) => clsColor(k),
})

// 四段固定顺序 —— 服务端按 key 给，这里只负责按序摆出来，不重排不改名。
const PART_ORDER = ['locate', 'basis', 'context', 'evidence', 'judge', 'fix']

/* 一张纸装几题：按窗口高低算，装得下就往下排，不是写死 5。
   reserve 是纸外面还占着的高度（外壳 56 + KPI 之外的 chip 行 + 纸头 + 内边距）。 */
function perPage(): number {
  return perLeaf(330, 96, 3, 10)
}

/* 摆几张纸：屏幕宽就并两张，窄了就一张 —— 用户要的是「能两面就两面」。 */
function cols(): number {
  if (typeof window === 'undefined') return 2
  return window.innerWidth >= 1180 ? 2 : 1
}

export function Practice({ base, initSid, entry }: {
  base: Base
  /* 两条进来的路，默认落点不一样：
       · 顶栏「练习」= 这门课当前这一讲的练习（上到哪讲到哪讲）
       · 左栏「练习」= 我要刷题，默认这门课整本
     initSid 是全局当前课程 —— 练习页不许自己另存一个科目。 */
  initSid?: string
  entry?: 'tab' | 'rail'
}) {
  /* 题源列表自己拉一份：AI 刚生成的题要立刻出现在这一行，
     靠 bootstrap 那份快照就得刷新页面才看得见（那是用户骂过的「刷新才出现」）。 */
  const ls = useTool<{ sources: Src[] }>('list_item_sources', {})
  const srcs: Src[] = ls.data?.sources ?? ((base as any).sources ?? [])
  const [genBusy, setGenBusy] = useState<'' | 'subject' | 'weak'>('')
  const [genMsg, setGenMsg] = useState<string | null>(null)
  const [srcId, setSrcId] = useState<string>('')
  const [part, setPart] = useState<string>('')
  /* 一次取多少题、从第几题开始 —— 题库几百题，没有这两个就没有「刷完」这回事：
     以前写死 n:10、offset:0，781 题的库永远只露出最前面 10 道，
     后面 771 道在这台机器上等于不存在。 */
  const [size, setSize] = useState<number>(20)
  const [offset, setOffset] = useState<number>(0)
  const [jump, setJump] = useState<string>('')
  /* 分段改成下拉后就不需要「展开/收起」这个开关了 —— 19 段全铺在一行才是问题本身 */
  const reset = () => { setOffset(0); setJump(''); setPicked({}); setJudged({}); setEx({}); setTagFor(null) }

  /* 两种出题：按这一科（考点卡随机抽）/ 按我的弱项（先数出错得最多的那块再出）。
     弱项那条不是拍脑袋 —— weak_points 是拿 answers 表的真作答聚合出来的，
     同一块至少答过 2 题才进榜，凑不出就如实说「记录不够」。 */
  async function gen(mode: 'subject' | 'weak') {
    if (!curSrc) return
    setGenBusy(mode); setGenMsg(mode === 'weak' ? '正在数你错得最多的那块…' : '正在按考点卡出题…')
    try {
      let topic: string | undefined
      let say = ''
      if (mode === 'weak') {
        const w = await callTool('weak_points', { subject: curSrc.subject, limit: 5 })
        const d: any = w.data || {}
        const top = d.top
        if (!top) { setGenMsg(d.say || '还没有足够的作答记录，先随便刷几道再来'); return }
        topic = String(top.part || top.label || '')
        say = `按弱项「${top.label}」出（这块 ${top.total} 题错了 ${top.wrong} 题）`
      }
      const r = await callTool('quiz_gen',
        { subject: curSrc.subject, topic, n: mode === 'weak' ? 5 : 3 }, { write: true })
      const g: any = r.data || {}
      setGenMsg(r.ok ? (say ? say + ' —— ' + (g.say || '') : (g.say || '出好了'))
        : (g.say || g.error || r.error || '没出成，看看模型那边能不能说话'))
      if (r.ok) { ls.run(); setTimeout(() => setGenMsg(null), 10000) }
    } finally {
      setGenBusy('')
    }
  }

  /* 窗口变了重算：一页几题、并几页 */
  const [per, setPer] = useState(perPage)
  const [nc, setNc] = useState(cols)
  useEffect(() => {
    const on = () => { setPer(perPage()); setNc(cols()) }
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  /* 两级切换：先科目、再题源，题型多于一种时再多一排。
     以前是把 8 个题源平铺一行 —— 英语的语法题库和政治的考点卡挨在一起，
     想找某个题源得把整行读完。先选科，候选立刻少一半。 */
  const [subF, setSubF] = useState(initSid || '')
  const [kindF, setKindF] = useState('')
  /* 范围三档（真的三档，不摆做不到的档位）：
       本讲   → 这一讲的当堂测题（lesson_quiz 按 lesson_id 捞，出了就挂在那一讲名下）
       整门课 → 这门课题源里的题（make_quiz 按题源取，题源带 subject）
       全部课 → 五门课题源混排（不过滤）
     「本章」没做：题库的题只带分段，没有章字段，硬做一个只是骗人。 */
  const [scope, setScope] = useState<'lesson' | 'course' | 'all'>(
    entry === 'rail' ? 'course' : 'lesson')
  const subList = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>()
    for (const s of srcs) {
      const id = s.subject || ''
      if (!id) continue
      const e = m.get(id) || { id, name: s.subject_name || id, n: 0 }
      e.n += 1
      m.set(id, e)
    }
    return Array.from(m.values())
  }, [srcs])
  const visible = useMemo(() => srcs.filter(
    (s) => (!subF || s.subject === subF) && (!kindF || s.kind === kindF)), [srcs, subF, kindF])
  /* 当前这门课根本没有题源时（比如高数），subF 会落在一个不存在的科目上，
     下拉就显示成「—」—— 一个空的框比「全部」更容易让人以为是坏的。回落到全部。 */
  useEffect(() => {
    if (subF && srcs.length && !srcs.some((s) => s.subject === subF)) setSubF('')
  }, [srcs, subF])
  const kinds = useMemo(() => {
    const pool = subF ? srcs.filter((s) => s.subject === subF) : srcs
    const set: string[] = []
    for (const s of pool) if (s.kind && set.indexOf(s.kind) < 0) set.push(s.kind)
    return set
  }, [srcs, subF])

  const curSrc = useMemo(() => srcs.find((s) => s.id === srcId) ?? visible[0], [srcs, srcId, visible])
  useEffect(() => {
    if (!srcId && srcs.length) setSrcId(srcs[0].id)
  }, [srcs, srcId])
  /* 换了科目/题型之后，原来选中的题源可能已经不在候选里 ——
     那就落到第一项，别让下面还挂着别的科目的题。 */
  useEffect(() => {
    if (visible.length && !visible.some((s) => s.id === srcId)) {
      setSrcId(visible[0].id); setPart(''); reset()
    }
  }, [visible, srcId])

  /* 当前这一讲：练习要「跟着进度走」，就得先知道进度停在哪。
     这个值来自后端真状态（pick_lesson / 播放记录 / 上次断点都算），不是前端猜的。 */
  const cl = useTool<{ lesson?: { id?: string; title?: string; chapter?: string } }>(
    'get_current_lesson', initSid ? { subject: initSid } : {})
  const curLid = cl.data?.lesson?.id
  const curTitle = cl.data?.lesson?.title

  /* 换范围时把科目筛选一起归位：选「全部课」就该真的不过滤，
     选「本讲 / 整门课」就该回到当前这门课 —— 否则会出现
     「范围写着整门课，题全是政治」的错位。 */
  useEffect(() => {
    if (scope === 'all') setSubF('')
    else if (initSid) setSubF(initSid)
  }, [scope, initSid])

  const q = useTool<Quiz>('make_quiz',
    { source: curSrc?.id, part: part || undefined, n: size, offset },
    { skip: !curSrc || scope === 'lesson' })
  /* 本讲模式走另一个题源：这一讲的当堂测。它跟题库不同源 ——
     题库按分段刷，当堂测按讲次出，题号各算各的，混在一起会互相盖掉。 */
  const lq = useTool<{ questions?: any[]; total?: number; done?: number; right?: number; source?: string }>(
    'lesson_quiz', { lesson_id: curLid }, { skip: scope !== 'lesson' || !curLid })
  const err = useTool<{ tags: { tag: string; c: number }[]; total: number }>('error_tag_stats')
  const wrong = useTool<{ errors: any[] }>('list_errors', { limit: 50 })
  const cov = useTool<Cov>('explain_coverage')

  const [picked, setPicked] = useState<Record<string, string>>({})
  const [judged, setJudged] = useState<Record<string, { ok: boolean; ans: string }>>({})
  const [tagFor, setTagFor] = useState<string | null>(null)

  /* 讲题：一题一份，键是「题源|定位键」。换了题源就整批作废。 */
  const [ex, setEx] = useState<Record<string, ExDoc>>({})
  const [exBusy, setExBusy] = useState<string | null>(null)
  const [voted, setVoted] = useState<Record<string, 'up' | 'down'>>({})

  /* 本讲的题：把 lesson_quiz 的字段摊成跟题库一样的 Q，好让下面那套纸卡原样复用。
     source 必须带上 —— 判分要知道这题归哪个题源；不带就判不了，只能干看。 */
  const lessonQs: Q[] = useMemo(() => (lq.data?.questions ?? []).map((x: any) => ({
    no: x.no, part: x.part, topic: x.topic, stem: x.stem, opts: x.opts || {},
    done: x.done, last_ok: x.last_ok, source: lq.data?.source, ref: String(x.no),
  })), [lq.data])

  const list: Q[] = scope === 'lesson' ? lessonQs : (q.data?.questions ?? [])
  /* 库里一共多少题、现在看到第几题 —— 这两个数必须来自服务端回的 total/offset，
     不能拿「本组几题」冒充「一共几题」。以前页头只写「本轮 10 题」，
     781 题的库看起来就像只有 10 题，剩下 771 题没人知道去哪刷。 */
  const parts: { name: string; n: number }[] = scope === 'lesson' ? [] : (q.data?.parts ?? [])
  const total: number = scope === 'lesson' ? lessonQs.length : (q.data?.total ?? list.length)
  const from = list.length ? offset + 1 : 0
  const to = offset + list.length
  const hasPrev = offset > 0
  const hasNext = total > 0 && to < total
  const keyOf = (x: Q) => (x.id || String(x.no))

  /* 翻页：只换 offset，本组的作答就地清掉 —— 题都换了，
     「已完成 3/20」还挂着上一组那 3 个就是假数字。判分早落库了，不会丢。
     落点必须落在组边界上：以前直接 clamp 到 total-1，跳到第 90 题（只有 49 题）
     会停在 offset=48，屏幕上只剩「第 49–49 题」孤零零一道。 */
  const maxOff = Math.max(0, Math.floor((total - 1) / size) * size)
  function turn(delta: number) {
    const o = Math.min(Math.max(0, offset + delta), maxOff)
    if (o === offset) return
    setOffset(o); setJump(''); setPicked({}); setJudged({}); setEx({}); setTagFor(null)
  }
  function doJump() {
    const n = parseInt(jump, 10)
    if (!Number.isFinite(n)) { setJump(''); return }
    const want = Math.min(Math.max(1, n), Math.max(1, total)) - 1
    const o = Math.min(Math.floor(want / size) * size, maxOff)
    setOffset(o); setJump(''); setPicked({}); setJudged({}); setEx({}); setTagFor(null)
  }

  async function submit(x: Q, letter: string) {
    const k = keyOf(x)
    if (judged[k]) return
    setPicked((p) => ({ ...p, [k]: letter }))
    const r = await callTool('grade_answer', {
      source: x.source || curSrc?.id, part: x.part, qno: x.no, chosen: letter, id: x.id,
    }, { write: true })
    const d: any = r.data || {}
    setJudged((j) => ({ ...j, [k]: { ok: !!d.ok, ans: d.ans || '—' } }))
    /* 判错时外层 ok 也是 false。拿它当刷新条件的话，答错的题不进错题本 ——
       恰恰是最该进的那一类。看 judged。 */
    if (d.judged) { err.run(); wrong.run() }
  }

  async function tag(x: Q, t: string) {
    if (!tagFor) return
    await callTool('tag_error', { id: x.id, qno: x.no, part: x.part, source: x.source || curSrc?.id, tag: t }, { write: true })
    setTagFor(null); err.run()
  }

  /* 讲清这题：先让服务端把依据捞齐，再按四段讲。
     这不是「问模型」——模型没接也讲得出（model='local-evidence'），
     接了模型也只是措辞更顺，每句话仍然要挂在依据上，引文对不上原文整段作废。 */
  async function askExplain(x: Q) {
    const src = x.source || curSrc?.id
    const rf = x.ref || String(x.no)
    const ek = src + '|' + rf
    // 已经讲过的题，这个按钮是「收起」，不是「再讲一遍」。
    // 原来这里不看 ex 里有没有这一条，点了照样去服务端重捞一次，
    // 结果讲解永远不会消失 —— 按钮写着收起、行为却是再翻一遍。
    if (ex[ek]) {
      setEx((m) => { const c = { ...m }; delete c[ek]; return c })
      return
    }
    if (exBusy) return
    setExBusy(ek)
    const r = await callTool<ExDoc>('explain_question', { source: src, ref: rf, chosen: picked[keyOf(x)] || null })
    setExBusy(null)
    setEx((m) => ({ ...m, [ek]: (r.data as ExDoc) || { reason: r.error || '讲不了：没有依据' } }))
  }

  async function vote(x: Q, up: boolean) {
    const src = x.source || curSrc?.id
    const rf = x.ref || String(x.no)
    const ek = src + '|' + rf
    if (!ex[ek]?.found) return
    const r = await callTool('rate_explain', { source: src, ref: rf, up, down: !up }, { write: true })
    if (r.ok) setVoted((v) => ({ ...v, [ek]: up ? 'up' : 'down' }))
  }

  const answeredCount = Object.keys(judged).length
  const rightCount = Object.values(judged).filter((x) => x.ok).length
  const errs = wrong.data?.errors || []

  const cv = cov.data
  const vT = cv?.total || 0
  const vSpeak = cv?.speakable ?? 0
  const vFull = cv?.by_verdict?.['有据可依'] ?? 0
  const vPart = cv?.by_verdict?.['依据部分成立'] ?? 0
  const vNone = cv?.by_verdict?.['无解析 · 可定位'] ?? cv?.by_verdict?.['无解析·可定位'] ?? 0
  const pctOf = (n: number) => (vT ? (n / vT) * 100 : 0)

  return (
    <>
      {/* 范围条：这一页最先要回答的不是「哪个题源」，而是「练哪一块」。
          从顶栏进来默认「本讲」（跟着你上到的那一讲），从左栏进来默认「整门课」。
          改成「全部课程」时科目筛选自动清空 —— 两个筛选器不许互相打架。 */}
      <div className="rng-mn">
        <span className="lb">范围</span>
        <div className="seg" role="tablist" aria-label="练习范围">
          <button role="tab" aria-selected={scope === 'lesson'}
            className={scope === 'lesson' ? 'on' : ''}
            disabled={!curLid}
            title={curLid ? '跟着你上到的那一讲走' : '还没开始学任何一讲，先看整门课'}
            onClick={() => { setScope('lesson'); reset() }}>本讲</button>
          <button role="tab" aria-selected={scope === 'course'}
            className={scope === 'course' ? 'on' : ''}
            onClick={() => { setScope('course'); reset() }}>整门课</button>
          <button role="tab" aria-selected={scope === 'all'}
            className={scope === 'all' ? 'on' : ''}
            onClick={() => { setScope('all'); reset() }}>全部课程</button>
        </div>
        <span className="rng-now">
          {scope === 'lesson'
            ? (curLid ? (curTitle || curLid) : '还没开始学任何一讲')
            : scope === 'course'
              ? `${(base as any).subjects?.find((s: any) => s.id === initSid)?.name || '这门课'} · 全部题`
              : '五门课混排'}
        </span>
        <span className="sp" />
        {/* 本讲 0 题时给一条明路：这一讲没出过题，最容易让人以为「练习页坏了」。
            不自动跳走（那是替用户做决定），但把出口摆在原地。 */}
        {scope === 'lesson' && !total ? (
          <button className="rng-go" onClick={() => { setScope('course'); reset() }}>
            这一讲还没出题，改看整门课 →
          </button>
        ) : null}
        <span className="rng-n">{total} 题</span>
      </div>

      {/* 一个控件行：科目 / 题型 / 题源 / 分段 —— 全是同一种下拉。
          以前这里是「下拉 + chip 墙 + 折叠按钮」三种控件混着摆，
          点「选分段」还会从下面长出十几个 chip，看着像两套界面拼起来的。
          同一个动作（筛一批题出来）就该用同一种控件。 */}
      <div className="srcbar-mn pktool-mn">
        <label className="pksel">
          <span>科目</span>
          <Sel value={subF} ariaLabel="按科目筛题源"
            onChange={(v) => { setSubF(v); setKindF('') }}
            options={[
              { value: '', label: `全部（${srcs.length}）` },
              ...subList.map((x) => ({ value: x.id, label: x.name, note: String(x.n) })),
            ]} />
        </label>
        {kinds.length > 1 ? (
          <label className="pksel">
            <span>题型</span>
            <Sel value={kindF} ariaLabel="按题型筛" onChange={(v) => setKindF(v)}
              options={[
                { value: '', label: '全部' },
                ...kinds.map((k) => ({ value: k, label: KIND_CN[k] || k })),
              ]} />
          </label>
        ) : null}
        <span className="barsep-mn" />
        {/* 题源改成下拉：8 个题源平铺成 chip 行，每个 200px 宽、还要换行，
            整块看起来就是一排 tab，题目被压到第二屏。下拉占一格，选哪个一目了然。 */}
        {visible.length ? (
          <label className="pksel">
            <span>题源</span>
            <Sel value={curSrc?.id ?? ''} ariaLabel="选题源"
              onChange={(v) => { setSrcId(v); setPart(''); reset() }}
              options={visible.map((s) => ({
                value: s.id,
                label: s.name + ((s as any).origin === 'ai' ? ' · AI' : ''),
                note: kinds.length > 1 && s.kind
                  ? `${s.total} 题 · ${KIND_CN[s.kind] || s.kind}`
                  : `${s.total} 题`,
              }))} />
          </label>
        ) : null}
        {!visible.length ? (
          <span className="srcbar-empty">这一科还没有题源 —— 可以让助手去拉一份，或者在上面按这一科出几道。</span>
        ) : null}
        {/* 分段也是筛选，所以也是下拉：选项里带每段多少题，选之前就知道这段有多长。
            只有一段时不摆这个下拉 —— 那等于一个永远只有一个选项的框。 */}
        {parts.length > 1 ? (
          <label className="pksel">
            <span>分段</span>
            <Sel value={part} ariaLabel="选分段"
              onChange={(v) => { setPart(v); reset() }}
              options={[
                { value: '', label: `全部（${parts.reduce((a, x) => a + x.n, 0)}）` },
                ...parts.map((x) => ({ value: x.name, label: x.name, note: String(x.n) })),
              ]} />
          </label>
        ) : null}
        {/* AI 出题：两个门 —— 按这一科随机抽考点，或按数出来的弱项出。
            生成要真调模型（十几秒），所以按钮自己带状态，不假装秒回。 */}
        {curSrc ? <span className="barsep-mn" /> : null}
        <div className="pkgen-mn">
          <PBtn ghost disabled={!!genBusy || !curSrc}
            title="按这门课的考点卡出几道题（生成后盲答复核，不一致的不入库）"
            onClick={() => gen('subject')}>
            {genBusy === 'subject' ? '出题中…' : '按这一科出 3 题'}
          </PBtn>
          <PBtn ghost disabled={!!genBusy || !curSrc}
            title="按你答得最差的那一块出题（同一块至少答过 2 题才算数）"
            onClick={() => gen('weak')}>
            {genBusy === 'weak' ? '出题中…' : '按我的弱项出 5 题'}
          </PBtn>
        </div>
      </div>

      {genMsg ? <div className="note-mn bare" style={{ marginTop: 8 }}>{genMsg}</div> : null}

      {list.length ? (
        <>
          {/* 这一行不是装饰：它回答「这套题一共有多少、我刷到哪了、下一批怎么翻」。
              少了它，几百题的库就只剩眼前这一组 —— 刷完也不知道还有没有。 */}
          <div className="qhead-mn qnav-mn">
            <span className="pos">
              第 <b>{from}</b>–<b>{to}</b> 题 · 共 <b>{total}</b> 题{part ? ' · ' + part : ''}
            </span>
            <div className="pn-mn">
              <button disabled={!hasPrev} onClick={() => turn(-size)}>← 上一组</button>
              <button disabled={!hasNext} onClick={() => turn(size)}>下一组 →</button>
            </div>
            <label className="pksel">
              <span>每组</span>
              <Sel value={String(size)} ariaLabel="每组多少题"
                onChange={(v) => {
                  setSize(Number(v)); setOffset(0); setJump('')
                  setPicked({}); setJudged({}); setEx({})
                }}
                options={[10, 20, 50, 100].map((n) => (
                  { value: String(n), label: `${n} 题`, disabled: total > 0 && n > total }
                ))} />
            </label>
            <span className="jump-mn">
              <input className="inp-mn" value={jump} inputMode="numeric" placeholder="题号"
                aria-label="跳到第几题"
                onChange={(e) => setJump(e.target.value.replace(/[^\d]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') doJump() }} />
              <button onClick={doJump}>跳</button>
            </span>
            <span className="rt">
              本组做完 {answeredCount} / {list.length}
              {answeredCount ? ` · 对 ${rightCount}（${Math.round((rightCount / answeredCount) * 100)}%）` : ''}
            </span>
          </div>

          <Spread cols={Math.min(nc, Math.ceil(list.length / per))}>
            {paginate(list, per).map((group, gi) => (
              <Leaf key={gi}>
                <Paper kick={
                  /* 纸头写真实题号区间（跟每题左上那个号对得上，可核对），
                     拿不到题号的源才退回「本组第几题」这种相对序号。 */
                  (group[0]?.no != null && group[group.length - 1]?.no != null)
                    ? `第 ${group[0].no} — ${group[group.length - 1].no} 题`
                    : `本组第 ${gi * per + 1} — ${gi * per + group.length} 题`
                }
                  chips={<>
                    <span className="pchip-mn">{KIND_CN[group[0]?.kind || 'choice'] || group[0]?.kind || '单选'}</span>
                    <span className="pchip-mn">{group[0]?.part || '本轮'}</span>
                  </>}>
                  {group.map((x) => {
                    const k = keyOf(x)
                    const jd = judged[k]
                    const myPick = picked[k]
                    const src = x.source || curSrc?.id
                    const rf = x.ref || String(x.no)
                    const ek = src + '|' + rf
                    const doc = ex[ek]
                    const parts = (doc?.parts || []).slice().sort((a, b) => {
                      const i = PART_ORDER.indexOf(a.key), j = PART_ORDER.indexOf(b.key)
                      return (i < 0 ? 99 : i) - (j < 0 ? 99 : j)
                    })
                    const vd = doc?.verdict || ''
                    const vdTone = vd === '有据可依' ? '' : vd === '依据部分成立' ? ' part' : ' weak'
                    return (
                      <div className={'qcell-mn' + (jd ? ' done' : '')} key={k}>
                        <div className="qh">
                          <span className="qn">{x.no}</span>
                          {x.part ? <span className="qp">{x.part}</span> : null}
                          <span className="qk">
                            {x.explain ? '题库自带解析' : '无逐题解析'}
                            {x.done ? (x.last_ok ? ' · 做对过' : ' · 错过') : ''}
                          </span>
                          {jd ? (
                            <span className={'qj' + (jd.ok ? ' ok' : ' no')}>{jd.ok ? '对' : `错 · 答案 ${jd.ans}`}</span>
                          ) : null}
                          <button className="qlink" onClick={() => askExplain(x)} disabled={exBusy === ek}>
                            {exBusy === ek ? '翻依据…' : doc ? '收起' : '讲这题'}
                          </button>
                        </div>

                        <div className="stem-mn q">{x.stem}</div>

                        <div className="opts-mn q">
                          {Object.keys(x.opts || {}).map((L) => {
                            // 一色一职：琥珀=你选的，绿=答案，红=你选错的那一个。
                            const cls = jd
                              ? (L === jd.ans ? ' ok' : L === myPick ? ' no' : '')
                              : (myPick === L ? ' on' : '')
                            return (
                              <button key={L} className={'opt-mn' + cls} disabled={!!jd} onClick={() => submit(x, L)}>
                                <span className="l">{L}</span><span className="t">{x.opts[L]}</span>
                              </button>
                            )
                          })}
                        </div>

                        {/* 判完的解析 + 自己标的错因，就地挂在这道题下面 */}
                        {jd ? (
                          <div className="qfb-mn">
                            {/* 有逐题解析就显示；没有而且还没讲过，才提示一句。
                                讲过之后下面就有「依据」段了（依据=库里原文，不是解析），
                                这里再说「不编」会跟它打架。 */}
                            {x.explain ? (
                              <div className="tx">{x.explain}</div>
                            ) : doc ? null : (
                              <div className="tx dim">本题没有逐题解析。点「讲这题」，依据从题库和考点卡里现找 —— 找不到就说找不到。</div>
                            )}
                            {!jd.ok ? (
                              tagFor === k ? (
                                <div className="tagrow-mn">
                                  {['没记住', '看错题干', '语法不熟', '单词不认识', '算错'].map((t) => (
                                    <button key={t} className="pbtn-mn ghost" onClick={() => tag(x, t)}>{t}</button>
                                  ))}
                                  <button className="pbtn-mn ghost" onClick={() => setTagFor(null)}>算了</button>
                                </div>
                              ) : (
                                <button className="pbtn-mn ghost" onClick={() => setTagFor(k)}>标个错因</button>
                              )
                            ) : null}
                          </div>
                        ) : null}

                        {/* 讲题四段：紧跟在这道题下面，不用滚回去找。
                            收起不是直接删节点 —— 那就成了硬切。Collapse 会先播 190ms 再卸载。 */}
                        {/* 关键：Collapse 会在收起动画期间继续渲染子节点，
                            而此时 doc 已经是 undefined —— 所以里面的每个 doc.x
                            都必须走这一层「有 doc 才算」的守卫，否则收起必崩。 */}
                        <Collapse open={!!doc}>
                          {doc ? (<div className="exp-mn">
                            <div className="exhd-mn">
                              <span className={'vd-mn' + (doc.found ? vdTone : ' weak')}>{doc.found ? (vd || '—') : '讲不了'}</span>
                              {doc.found ? <span className="conf-mn">置信 {Math.round((doc.confidence || 0) * 100)}%</span> : null}
                              <span className="who-mn">
                                {doc.found
                                  ? (doc.model === 'local-evidence' ? '本机依据 · 未用模型' : '模型 ' + (doc.model || '—'))
                                  : '依据从本机资料里捞，不是先问模型'}
                              </span>
                              <button className="qlink" onClick={() => setEx((m) => { const c = { ...m }; delete c[ek]; return c })}>收起</button>
                            </div>
                            {doc.found ? (
                              <>
                                {doc.verdict_note ? <div className="tx" style={{ marginTop: 8 }}>{doc.verdict_note}</div> : null}
                                {parts.map((p) => (
                                  <div className="expart-mn" key={p.key}>
                                    <div className="ix">{p.title}</div>
                                    <div className="tx">
                                      {p.text}
                                      {(p.lines || []).map((l, i) => (
                                        <div className={'quote-mn' + (l.verified === false ? ' bad' : '')} key={i}>
                                          {l.text}
                                          <div className="from">
                                            {l.where || '—'}{p.from ? '　·　' + p.from : ''}
                                            {/* 三态：true 才算"逐字比对通过"，false 明说没通过，
                                                undefined 是「参考材料」这类压根没参与复核的 —— 不能
                                                默认说它通过了，那是把没验过的东西说成验过了。 */}
                                            {l.verified === true ? '　·　逐字比对通过'
                                              : l.verified === false ? '　·　这条没通过复核，不算依据'
                                                : ''}
                                          </div>
                                        </div>
                                      ))}
                                      {/* 逐项判断：正确的那行字变绿，其余保持灰 —— 绿红只给判分。 */}
                                      {!!(p.opts || []).length ? (
                                        <div className="optjudge-mn">
                                          {(p.opts || []).map((o, i) => (
                                            <div className={'oj-mn' + (o.state === 'right' ? ' y' : o.state === 'wrong' ? ' n' : '')} key={i}>
                                              <b>{o.opt} {o.text}</b><span>{o.note || ''}</span>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                      {(p.gaps || []).map((g, i) => (
                                        <div className="quote-mn bad" key={i}>讲不了的地方：{g}</div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                                {(doc.gaps || []).length && !(doc.parts || []).length ? (
                                  <div className="tx" style={{ marginTop: 8 }}>{(doc.gaps || []).join('；')}</div>
                                ) : null}
                                <div className="vote-mn">
                                  <span>这段讲得对吗：</span>
                                  {voted[ek] ? (
                                    <span>{voted[ek] === 'up' ? '已记下：讲得对' : '已记下：讲错了'}　统计页那个数字会跟着变。</span>
                                  ) : (
                                    <>
                                      <button className={'vb-mn' + (voted[ek] === 'up' ? ' y' : '')} onClick={() => vote(x, true)}>讲得对</button>
                                      <button className="vb-mn" onClick={() => vote(x, false)}>讲错了</button>
                                    </>
                                  )}
                                  <span style={{ marginLeft: 'auto' }}>同一题重讲会多留一版，好查前后说法是否一致</span>
                                </div>
                              </>
                            ) : (
                              <div className="tx" style={{ marginTop: 8 }}>
                                {doc.reason || doc.verdict_note || '这道题在本机找不到可核对的依据 —— 不编一个给你。'}
                              </div>
                            )}
                          </div>) : null}
                        </Collapse>
                      </div>
                    )
                  })}
                </Paper>
              </Leaf>
            ))}
          </Spread>

          {/* 右栏那两块（这数字怎么来的）现在接到纸下面：纸已经吃满整宽，
              还硬塞 258px 窄栏就又回到「右边空一块」的老毛病。 */}
          <div className="twocol-mn half">
            <Sc title="整库讲题覆盖">
              <Bar label="能讲" value={vT ? `${vSpeak} / ${vT}` : '—'} pct={pctOf(vSpeak)} color="var(--ok)" />
              <Bar label="有据可依" value={vFull || '—'} pct={pctOf(vFull)} color="var(--act)" />
              <Bar label="依据部分成立" value={vPart || '—'} pct={pctOf(vPart)} color="var(--warn)" />
              <Bar label="无解析 · 可定位" value={vNone || '—'} pct={pctOf(vNone)} color="var(--line2)" />
              <div className="note-mn" style={{ marginTop: 10 }}>
                {cv?.note || '「无解析」不算失败 —— 原卷只给答案没给依据，本机不编，让人自己背。'}
              </div>
            </Sc>

            <Sc title="最近的错题">
              {errs.length ? (
                <>
                  <div className="spots-mn">
                    {errs.slice(0, 4).map((e: any, i: number) => (
                      <div key={i} className="spot-mn">
                        <div className="sh"><b>{e.stem}</b></div>
                        <div className="sm">
                          <span>你选 <b style={{ color: 'var(--bad)' }}>{e.chosen || '—'}</b></span>
                          <span>答案 <b style={{ color: 'var(--ok)' }}>{e.ans || '—'}</b></span>
                          <span>{e.tag || '没标错因'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="note-mn" style={{ marginTop: 9 }}>
                    共 {errs.length} 条。只有最近 4 条 —— 错题不是用来欣赏的，是拿来重做的。
                  </div>
                </>
              ) : (
                <div className="note-mn bare">还没有错题 —— 答错之后才会进这里。</div>
              )}
            </Sc>
          </div>
        </>
      ) : q.loading ? (
        /* 出题时先把纸的位置占住：骨架的尺寸照真题的尺寸画，
           题一到就直接换上去，不会「先空一大片、再猛跳一下」。 */
        <div className="qspread-mn" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
          <Skel kind="paper" />
          <Skel kind="paper" />
        </div>
      ) : (
        <div className="empty-mn">
          <b>这个源暂时出不了题</b>
          换一个题源试试，也可能这个源的题都做完了。
        </div>
      )}

      <Sect title="错在哪 · 自己标的" right={`${err.data?.total ?? 0} 条`} />
      {(err.data?.tags || []).length ? (
        <div className="srcs-mn">
          {(err.data?.tags || []).map((t) => (
            <div key={t.tag} className="src-mn">
              <div className="sh"><b>{t.tag}</b><span className="tg-mn md">{t.c} 次</span></div>
              <div className="sm">
                <span>占 {err.data?.total ? Math.round((t.c / err.data.total) * 100) : 0}%</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="note-mn">
          还没有标过错因 —— 答错之后点「标个错因」才有。
        </div>
      )}
    </>
  )
}
