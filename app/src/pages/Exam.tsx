import { useEffect, useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Sect, Li, Card, Paper, Sc, Row, Skel } from '../components/V6'
import { Sel } from '../components/Sel'
import { Spread, Leaf, paginate, perLeaf } from '../components/Spread'

/* 考场页 v6：按 design-v6.html:660-709 重画。
   上排四个 38px 数字，下面近五年五张卡 + 再往下一排小卡，
   最底下「交过的卷」每张卡按题型拆行 —— 分项得分来自本机判分，不是估的。
   做题时题干装在米白那张纸上：这是全页唯一一块亮面。 */

type PaperRow = {
  id: string; name: string; year: string; subject?: string; total: number; groups: number
  types: string[]; answered: number; right: number; wrong: number; score: number | null
  /* 网上拉来的卷：origin=web/pasted；answers=false 表示原页没答案，只能练不计分 */
  origin?: string; answers?: boolean
}
type ExQ = { no: number | string; orig: number; stem: string; opts: Record<string, string>; state: number | null }
type GDetail = { index: number; type: string; label: string; material?: string; pages?: string; questions: ExQ[] }
type Detail = {
  paper: { id: string; name: string; year: string; total: number }
  groups: { index: number; label: string; type: string; count: number }[]
  group: GDetail; group_index: number; answered: number
}
type Sess = {
  id: number; ts: string; paper_id: string; judgeable: number; answered: number
  right: number; raw: number; max_raw: number; scored: number | null; seconds: number
  detail: { qno: number; type: string; ok: number; each: number | null }[]
}

const TYPE_CN: Record<string, string> = {
  single: '单选', blank: '填空', cloze: '完形', reading: '阅读', seven: '七选五', short: '简答',
}

/* 卷名形如「2023 年 · 广东《公共英语》真题+答案」—— 15 张卡同前缀，扫不出差别。
   年份提成 16px 大字锚点，剩下那截去掉年份和「+答案」，只留「广东《公共英语》真题」。 */
function shortName(name: string, year: string) {
  let s = String(name || '')
  if (year) s = s.replace(new RegExp(year + '\\s*年?\\s*[·.]?\\s*'), '')
  s = s.replace(/\+\s*答案\s*$/, '').replace(/[·.]\s*$/, '').trim()
  return s || name || '未命名卷'
}

/* 交卷记录只带 paper_id（形如 `paper:2023-年-广东-公共英语-真题-答案`），不带卷名。
   以前把 paper_id 直接丢进 shortName：年份正则匹配不上，于是每次交卷都显示「广东《公共英语》真题」——
   两次交卷的卡看起来一模一样，分不清是哪一年。这里把 id 也拆一遍再交给同一个 shortName。 */
function nameOfId(id: string) {
  const raw = String(id || '').replace(/^paper:/, '').replace(/-/g, ' ').trim()
  const y = (raw.match(/(20\d{2})/) || [])[1] || ''
  return { name: shortName(raw, y), year: y }
}

const ysort = (a: PaperRow, b: PaperRow) => String(b.year || '').localeCompare(String(a.year || ''))

/* 一张卷卡。抽出来是因为它现在要出现在两个地方：真题那一栏和「AI 组卷」那一栏。
   两处共用一份渲染，才不会出现「AI 卷少了标签、真题卷多了标签」这种漂移。 */
function PaperCard({ p, best, onOpen }: { p: PaperRow; best: number | null; onOpen: () => void }) {
  return (
    <button className={'pc-mn' + (p.answered > 0 ? ' on' : '')} onClick={onOpen}>
      <div className="h">
        <span className="yr">{p.year || '—'}</span>
        <span className="nm">{shortName(p.name, p.year)}</span>
        {p.origin && p.origin !== 'builtin' ? (
          <span className="pw-tag">{p.origin === 'ai-paper' ? 'AI 组卷' : '网上拉取'}</span>
        ) : null}
      </div>
      <div className="mt">
        {p.groups} 部分 · {p.total} 题 · {(p.types || []).map((t) => TYPE_CN[t] || t).join('/')}
        {p.answers === false ? ' · 无答案，不计分' : ''}
      </div>
      <div className="f">
        <div className="tr-mn"><i style={{ width: (p.total ? (p.answered / p.total) * 100 : 0) + '%', background: 'var(--act)' }} /></div>
        <span>{p.answered > 0 ? `${p.answered} 题` : '未做'}</span>
      </div>
      <div className="go">{p.answered > 0 ? `重做 →${best != null ? ' ' + best + ' 分' : ''}` : '开始 →'}</div>
    </button>
  )
}

export function Exam({ base }: { base: Base }) {
  const lp = useTool<{ papers: PaperRow[]; total_questions?: number; answered_all?: number; note?: string }>('list_exam_papers')
  const sc = useTool<{ sessions?: Sess[]; count?: number; note?: string }>('exam_scores', { limit: 50 })
  const [pid, setPid] = useState<string | null>(null)
  const [gi, setGi] = useState(0)
  const det = useTool<Detail>('get_exam_paper', { paper_id: pid, group_index: gi }, { skip: !pid })
  const [ans, setAns] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /* AI 组卷：科目 + 题量两个参数就够 —— 组卷的活儿（优先抽真题、AI 补位、
     每道题标 origin）全在后端 paper_make 里，界面不重复一遍业务规则。 */
  const subs = (base.subjects ?? []).filter((s) => s.id)
  const [mkSub, setMkSub] = useState('')
  const [mkN, setMkN] = useState(20)
  const [mkBusy, setMkBusy] = useState(false)
  const [mkMsg, setMkMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!mkSub && subs.length) setMkSub(subs[0].id)
  }, [subs, mkSub])

  const papers = (lp.data?.papers ?? []).slice().sort(ysort)
  const sessions = sc.data?.sessions ?? []
  const qTotal = lp.data?.total_questions ?? papers.reduce((a, p) => a + (p.total || 0), 0)
  const done = papers.filter((p) => p.answered > 0)
  const scoredAll = sessions.map((s) => Number(s.scored)).filter((n) => Number.isFinite(n))
  const best = scoredAll.length ? Math.max(...scoredAll) : null

  const sessOf = (id: string) => sessions.filter((s) => s.paper_id === id)
  const bestOf = (id: string) => {
    const v = sessOf(id).map((s) => Number(s.scored)).filter((n) => Number.isFinite(n))
    return v.length ? Math.max(...v) : null
  }

  async function pick(q: ExQ, L: string) {
    if (!pid) return
    setAns((a) => ({ ...a, [String(q.no)]: L }))
    // 选一题就真判一题、真落一条 —— 但不把对错显示在题上：交卷前不泄答案。
    await callTool('grade_answer', { qno: q.no, chosen: L, kind: 'exam', part: pid }, { write: true })
  }

  async function submit() {
    if (!pid) return
    setBusy(true)
    const r = await callTool('submit_exam', { paper_id: pid }, { write: true })
    setBusy(false)
    const d: any = r.data || {}
    setMsg(r.ok
      ? { ok: true, t: `交卷了：${d.totals?.scored ?? '—'} / ${d.totals?.full ?? 100} 分（判了 ${d.totals?.answered ?? 0} 题，还有 ${d.totals?.unanswered ?? 0} 题没答）` }
      : { ok: false, t: r.error || '没交上' })
    if (r.ok) { lp.run(); sc.run(); setAns({}) }
  }

  /* ---------------------------------------------------------- 卷列表 */
  if (!pid) {
    /* 真题和 AI 组的卷分两栏：混在一起排，人分不清哪份是真考过的。
       「近三年」那栏只放真题 —— AI 卷自己有一栏。 */
    const aiPapers = papers.filter((p) => p.origin === 'ai-paper')
    const realPapers = papers.filter((p) => p.origin !== 'ai-paper')
    const near = realPapers.slice(0, 5)
    const rest = realPapers.slice(5)
    // 「动过」的分母是卷，不是题：15 份里碰过 2 份就是 2/15，别拿题数偷换分母。
    const pct = papers.length ? (done.length / papers.length) * 100 : 0
    return (
      <>
        <div className="kpi-mn">
          <div>
            <div className="k">卷子</div>
            <div className="v">{papers.length}<small>份</small></div>
            <div className="s">
              真题 {realPapers.length}{aiPapers.length ? ` · AI 组卷 ${aiPapers.length}` : ''} · 合计 {qTotal} 题
            </div>
          </div>
          <div>
            <div className="k">动过的</div>
            <div className="v">{done.length}<small>/ {papers.length}</small></div>
            <div className="m"><i style={{ width: pct + '%' }} /></div>
            <div className="s">{Math.round(pct)}% · 还有 {papers.length - done.length} 份没碰</div>
          </div>
          <div>
            <div className="k">交过</div>
            <div className="v">{sessions.length}<small>次</small></div>
            <div className="s">限时作答 · 交卷才算</div>
          </div>
          <div>
            <div className="k">最高一次</div>
            <div className="v" style={best == null ? { color: 'var(--tx3)' } : undefined}>
              {best != null ? best : '—'}<small>分</small>
            </div>
            <div className="s">{best != null ? `满分 100 · 得分率 ${Math.round(best)}%` : '还没交过卷'}</div>
          </div>
        </div>

        {papers.length ? (
          <>
            <div className="mkrow-mn">
              <span className="mk-lb">AI 组卷</span>
              <Sel value={mkSub} ariaLabel="组卷科目" onChange={(v) => setMkSub(v)}
                options={subs.map((s) => ({ value: s.id, label: s.name }))} />
              <Sel value={String(mkN)} ariaLabel="题量" onChange={(v) => setMkN(Number(v))}
                options={[10, 20, 30, 40].map((n) => ({ value: String(n), label: `${n} 题` }))} />
              <button className="pbtn-mn" disabled={mkBusy || !mkSub} onClick={async () => {
                setMkBusy(true); setMkMsg('正在组卷…（真题优先，缺的用 AI 补，约 10–30 秒）')
                const r = await callTool('paper_make', { subject: mkSub, n: mkN }, { write: true })
                const d: any = r.data || {}
                setMkBusy(false)
                setMkMsg(d.say || d.error || r.error || '没组出来')
                if (r.ok) { lp.run(); setTimeout(() => setMkMsg(null), 12000) }
              }}>{mkBusy ? '在组…' : '组一套'}</button>
              {mkMsg ? <span className="mk-msg">{mkMsg}</span> : null}
            </div>

            {aiPapers.length ? (
              <>
                <Sect title="AI 组卷" right={`${aiPapers.length} 份 · 自己出的卷，交卷照常判分`} />
                <div className="pgrid-mn">
                  {aiPapers.map((p) => (
                    <PaperCard key={p.id} p={p} best={bestOf(p.id)}
                      onOpen={() => { setPid(p.id); setGi(0); setAns({}); setMsg(null) }} />
                  ))}
                </div>
              </>
            ) : null}

            {near.length ? (
              <>
                <Sect title={near.length === 1 ? shortName(near[0].name, near[0].year)
                  : `${near[near.length - 1].year} — ${near[0].year} ${shortName(near[0].name, near[0].year)}`}
                  right="动过的才描边" />
                <div className="pgrid-mn">
                  {near.map((p) => (
                    <PaperCard key={p.id} p={p} best={bestOf(p.id)}
                      onOpen={() => { setPid(p.id); setGi(0); setAns({}); setMsg(null) }} />
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {!!rest.length ? (
          <>
            <Sect title="再往下" right={`${rest.length} 份 · 一屏能扫完`} />
            <div className="pgrid-mn small">
              {rest.map((p) => (
                <button key={p.id} className="pc-mn compact" onClick={() => { setPid(p.id); setGi(0); setAns({}); setMsg(null) }}>
                  <div className="h"><span className="yr">{p.year || '—'}</span></div>
                  <div className="mt">{p.total} 题 · {p.answered > 0 ? '答过 ' + p.answered : '未做'}</div>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {!papers.length ? (
          <div className="empty-mn">
            <b>本机没有真题卷</b>
            卷子不是预置死的：跟助手说「帮我找 2023 广东专升本政治真题」，它会去搜、去拉；
            也可以把卷子正文整段贴给它。拉进来的卷在这里标「网上拉取」，
            原页没答案的会写明「不计分」—— 不拿没答案的题算 0 分。
          </div>
        ) : null}

        {!!sessions.length ? (
          <>
            <Sect title={`交过的 ${sessions.length} 次`} right="按题型分项" />
            <div className="twocol-mn half">
              {sessions.slice(0, 4).map((s) => {
                const p = papers.find((x) => x.id === s.paper_id)
                // 逐题明细按题型归并 —— 每一行的分母是这次真的答过的题数，不是卷面总数。
                const by: Record<string, { n: number; hit: number; each: number | null }> = {}
                for (const d of s.detail || []) {
                  const k = d.type || '?'
                  const o = by[k] || (by[k] = { n: 0, hit: 0, each: d.each ?? null })
                  o.n++
                  if (d.ok) o.hit++
                  if (o.each == null) o.each = d.each ?? null
                }
                const rows = Object.keys(by).map((k) => ({ type: k, ...by[k] }))
                return (
                  <Card key={s.id} title={(p ? shortName(p.name, p.year) : nameOfId(s.paper_id).name)
                    + (p?.year || nameOfId(s.paper_id).year ? `　${p?.year || nameOfId(s.paper_id).year}` : '')}
                    note={`${String(s.ts || '').slice(0, 16).replace('T', ' ')} · ${s.scored != null ? s.scored + ' 分' : '没算分'}`}>
                    {rows.length
                      ? rows.map((r) => (
                        <Li key={r.type} label={TYPE_CN[r.type] || r.type}
                          pct={r.n ? (r.hit / r.n) * 100 : 0}
                          color={r.each == null ? 'var(--line2)' : 'var(--act)'}
                          value={r.each == null ? '不判分' : `${r.hit} / ${r.n}`} />
                      ))
                      : <div className="note-mn bare">这次交卷没有留下逐题明细。</div>}
                  </Card>
                )
              })}
            </div>
            <div className="note-mn">
              每次交卷一行，只算交过卷的那几次。
              {sessions.length > 4 ? ` 一共 ${sessions.length} 次，这里列最近 4 次。` : ''}
              自己写的填空本机判不了分，标「不判分」，不进总分。
            </div>
          </>
        ) : (
          <div className="note-mn">
            还没有交过卷 —— 分数只在你点了「交卷」之后才产生，之前一题一题的作答只记状态，不算分。
          </div>
        )}
      </>
    )
  }

  /* ---------------------------------------------------------- 做题 */
  const sessAll = sc.data?.sessions ?? []
  const g = det.data?.group
  const groups = det.data?.groups ?? []
  const total = (g?.questions || []).length
  const picked = Object.keys(ans).length
  /* 有材料的组（阅读/完形/七选五）才配得上对开两页：
     没有文章的那几组拆开只会左页空着，不如一张纸。 */
  const hasMat = !!g?.material && String(g.material).trim().length > 0

  /* 组卷：不是「一题一屏」，是「一张纸排满再换下一张」。
     题干和它的选项算一道，永远不拆开；屏幕够宽就并两张。 */
  const per = perLeaf(300, 118, 2, 10)
  const nc = typeof window !== 'undefined' && window.innerWidth >= 1180 ? 2 : 1

  /* 一道题 = 题干 + 选项，永远不拆。装不下才换下一张纸。 */
  const cell = (q: ExQ) => {
    const Ls = Object.keys(q.opts || {})
    return (
      <div className="qcell-mn" key={q.no}>
        <div className="qh">
          <span className="qn">{q.orig ?? q.no}</span>
          <span className="qk">{ans[String(q.no)] ? '已选 ' + ans[String(q.no)] : '未选'}</span>
        </div>
        <div className="stem-mn q">{q.stem}</div>
        <div className="opts-mn q">
          {Ls.map((L) => (
            <button key={L} className={'opt-mn' + (ans[String(q.no)] === L ? ' on' : '')}
              onClick={() => pick(q, L)} disabled={!pid}>
              <span className="l">{L}</span><span>{q.opts[L]}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }
  const qs = g?.questions || []

  const foot = (
    <div className="vote-mn">
      <button className={"pbtn-mn" + (busy ? " busy" : "")} disabled={!picked || busy} onClick={submit}>
        {busy ? '交卷中…' : '交这一组并算分'}
      </button>
      <span style={{ alignSelf: 'center', fontSize: 11.5, color: 'var(--ptx3)' }}>
        {msg ? msg.t : '按题型权重算分（权重在 server/config.py），没答的题记 0 分'}
      </span>
    </div>
  )

  return (
    <>
      <div className="srcbar-mn" style={{ alignItems: 'center' }}>
        <button className="pbtn-mn ghost" onClick={() => { setPid(null); setMsg(null) }}>← 换一卷</button>
        <b style={{ fontSize: 13.5 }}>{det.data?.paper?.name || '读卷中…'}</b>
        {groups.map((x) => (
          <button key={x.index} className={'schip-mn' + (x.index === gi ? ' on' : '')}
            onClick={() => { setGi(x.index); setAns({}) }}>
            <b>{x.label}</b><i>{x.count}</i>
          </button>
        ))}
        <span className="note-mn bare" style={{ marginLeft: 'auto' }}>
          {picked} / {total} 已选 · 交卷才算分
        </span>
      </div>

      {/* 做题态：一张纸排满好几道题，宽屏并两张 —— 阅读那一组左页放文章。
          右栏整块接到纸下面：纸都吃满整宽了，再硬塞 258px 只会又空一块。 */}
      {g ? (
        hasMat ? (
          <div className="qspread-mn" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
            <Leaf>
              <Paper cls="reading" kick={`${det.data?.paper?.year || ''} · ${g.label || '这一组'}`}
                chips={<>
                  <span className="pchip-mn">{total} 题</span>
                  <span className="pchip-mn">左页文章 · 右页题目</span>
                </>}>
                <div className="stem-mn material" style={{ whiteSpace: 'pre-wrap' }}>{g.material}</div>
              </Paper>
            </Leaf>
            <Leaf>
              <Paper kick="题目" chips={<span className="pchip-mn">交卷前不泄答案</span>}>
                {qs.map(cell)}
                {foot}
              </Paper>
            </Leaf>
          </div>
        ) : (
          <Spread cols={Math.min(nc, Math.ceil(qs.length / per))}>
            {paginate(qs, per).map((group, gi) => (
              <Leaf key={gi}>
                <Paper kick={`${det.data?.paper?.year || ''} · ${g.label || '这一组'} · 第 ${gi * per + 1} — ${gi * per + group.length} 题`}
                  chips={<>
                    <span className="pchip-mn">{group.length} 题</span>
                    <span className="pchip-mn">交卷前不泄答案</span>
                  </>}>
                  {group.map(cell)}
                  {gi === Math.ceil(qs.length / per) - 1 ? foot : null}
                </Paper>
              </Leaf>
            ))}
          </Spread>
        )
      ) : (
        det.loading
          ? <div className="qspread-mn" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}><Skel kind="paper" /><Skel kind="paper" /></div>
          : <div className="empty-mn"><b>这一组没有题</b>换一组试试。</div>
      )}

      <div className="twocol-mn" style={{ marginTop: 14 }}>

          <Sc title="这一卷">
            <Row k="卷名" v={det.data?.paper?.name || '—'} />
            <Row k="年份" v={det.data?.paper?.year || '—'} />
            <Row k="这一组" v={g?.label || '—'} />
            <Row k="题数" v={`${total} 题`} />
            <Row k="已选" v={`${picked} 题`} />
          </Sc>
          <Sc title="怎么算分">
            <Row k="判分" v="服务端 · 按题型权重" />
            <Row k="没答" v="记 0 分" />
            <Row k="交卷" v="才出分" />
            <div className="note-mn bare" style={{ paddingTop: 8 }}>
              交卷前不显示对错 —— 那是练习页的事。
            </div>
          </Sc>
          <Sc title="这卷交过几次">
            {sessAll.filter((s) => s.paper_id === pid).length ? (
              sessAll.filter((s) => s.paper_id === pid).slice(0, 3).map((s) => (
                <Row key={s.id} k={s.ts.slice(5, 16).replace('T', ' ')}
                  v={s.scored == null ? '未判' : `${s.scored} 分`} />
              ))
            ) : (
              <div className="note-mn bare">还没交过这一卷。</div>
            )}
          </Sc>
      </div>
    </>
  )
}
