import { useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Sect, Card, Li, Verdict, clsColor } from '../components/V6'
import { md, WD } from '../lib/fmt'

/* 课表页 v6：按 design-v6.html:498-580 重画。
   上排四个 38px 数字（距考 / 待学 / 吃下砍掉 / 每天），下面七列一天一列，
   列里的块按科目走左边条那一条颜色，最底下一条本周合计条 + 砍掉的讲次四张卡。
   砍掉的理由一律读服务端 plan_budget 的 cut_sample[].why，前端不自己编。 */

type Blk = { cls: string; subject: string; subject_name: string; title: string; chapter: string; lesson_id: string | null; minutes: number; start: string; part?: boolean }
type Day = { date: string; wd: number /* 0=周一 … 6=周日 */; is_today: boolean; minutes: number; blocks: Blk[] }
type Sub = {
  id: string; name: string; cls: string; score: number; weight: number
  quota_minutes: number; used_minutes: number; lessons_total: number; lessons_done: number
  keep: number; cut: number; keep_hours: number; cut_hours: number; reach: string; reach_chapter: string
}
type Week = {
  exam_date: string; days_left: number; minutes_per_day: number; today: string
  days: Day[]; subjects: Sub[]; total_minutes: number; coverage: number
  pending_hours: number; keep_hours: number; cut_hours: number
  subjects_excluded?: any[]; excluded_count?: number
  set?: boolean; ok?: boolean; reason?: string; note?: string
  cut_sample?: { subject: string; cls: string; id: string; title: string; chapter: string; minutes: number; why: string }[]
  cut_total?: number; vocab_minutes?: number; rule?: string
}

// 科目色只给身份，不给判分 —— 一屏七列，整块上色就是噪点。
// 实现统一在 V6.clsColor：服务端 cls 是 coral/teal 这类颜色词，不是 cs/en。
const colOf = (id: string) => clsColor(id)

export function Schedule({ base, go }: {
  base: Base
  go?: (p: any, o?: { sid?: string }) => void
}) {
  const wk = useTool<Week>('plan_week')
  const [mins, setMins] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const d = wk.data
  const per = mins ?? d?.minutes_per_day ?? 150
  const noBasis = d && d.set === false

  async function setBudget() {
    setBusy(true)
    const r = await callTool('plan_set_budget', { minutes_per_day: per }, { write: true })
    setBusy(false)
    if (r.ok) wk.run()
  }

  const subs = d?.subjects ?? []
  const days = d?.days ?? []
  // 一周合计已经现算：块分钟只到讲次，背单词那 20 分钟不进块，所以
  // 不能拿 d.total_minutes（服务端按 每天×7 算的）当合计 —— 会显示 21300
  // 而下面是 1640。合计就用这一周所有列的分钟相加，与服务端给的
  // days[].minutes 是一致的。
  const weekMinutes = days.reduce((a, x) => a + (x.minutes || 0), 0)
  const cov = d?.coverage != null ? Math.round(d.coverage * 1000) / 10 : null
  const cutSample = (d?.cut_sample || []).slice(0, 4)
  const cutTotal = d?.cut_total ?? 0
  const pending = d?.pending_hours ?? 0
  const keep = d?.keep_hours ?? 0
  const cut = d?.cut_hours ?? 0
  const vocab = d?.vocab_minutes ?? 0

  // 按科目把本周分钟数汇总，喂给底部那条合计条 —— 分母是这一周真的排掉的时间
  const bySub: { name: string; cls: string; minutes: number }[] = []
  if (days.length) {
    const m = new Map<string, number>()
    for (const day of days) {
      for (const b of day.blocks || []) {
        const k = (b.subject || '?') + '|' + (b.subject_name || '')
        m.set(k, (m.get(k) || 0) + (b.minutes || 0))
      }
    }
    for (const [k, v] of m) {
      const [id, name] = k.split('|')
      bySub.push({ name: name || id, cls: id, minutes: v })
    }
    bySub.sort((a, b) => b.minutes - a.minutes)
  }
  const barSum = bySub.reduce((a, x) => a + x.minutes, 0)

  async function openBlock(b: Blk) {
    if (b.lesson_id) await callTool('pick_lesson', { lesson_id: b.lesson_id }, { write: true })
    go?.('classroom', b.subject ? { sid: b.subject } : undefined)
  }

  return (
    <>
      <div className="kpi-mn">
        <div>
          <div className="k">距考试</div>
          <div className="v">{d?.days_left ?? '—'}<small>天</small></div>
          <div className="s">{d?.exam_date ? `${d.exam_date} · 广东专升本` : '考试日期没定 —— 排不出来'}</div>
        </div>
        <div>
          <div className="k">待学</div>
          <div className="v">{pending ? pending.toFixed(1) : '—'}<small>小时</small></div>
          <div className="s">{subs.reduce((a, s) => a + (s.lessons_total || 0), 0) || 0} 讲 · 有分值的科目</div>
        </div>
        <div>
          <div className="k">吃下 / 砍掉</div>
          <div className="v">{keep ? keep.toFixed(1) : '—'}<small>/ {cut ? cut.toFixed(1) : '—'} 小时</small></div>
          <div className="m"><i style={{ width: (cov ?? 0) + '%' }} /></div>
          <div className="s">覆盖率 {cov != null ? cov + '%' : '—'}{cutTotal ? ` · 砍 ${cutTotal} 讲` : ''}</div>
        </div>
        <div>
          <div className="k">每天</div>
          <div className="v"><input type="number" value={per} min={15} max={600} step={10}
            onChange={(e) => setMins(Number(e.target.value))} /></div>
          <div className="s">
            分钟{vocab ? ` · 其中背单词 ${vocab} 分钟` : ''}
            {mins != null && mins !== d?.minutes_per_day ? (
              <button className="pbtn-mn ghost" style={{ marginLeft: 8 }} onClick={setBudget} disabled={busy}>
                {busy ? '重排中…' : '重排'}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {noBasis ? (
        <Verdict tone="bad" tag="空着不是排错"
          title={d?.reason || '还没定考试日期和每天时长，排不出来 —— 不是算不出来，是没有依据。'}
          desc="在上面「每天」那一格填个数字，再去设置里落一次考试日期：这两个数一进来，整张表当场就排出来了。" />
      ) : null}

      {!noBasis && !!days.length ? (
        <>
          <Sect title="这七天" right={d ? `今天 ${md(d.today)} · 每天 ${per} 分钟` : undefined} />
          <div className="wk-mn">
            {days.map((day) => {
              const used = (day.blocks || []).reduce((a, b) => a + (b.minutes || 0), 0)
              const rest = Math.max(0, (day.minutes || 0) - used)
              return (
                <div key={day.date} className={'wcol-mn' + (day.is_today ? ' today' : '')}>
                  <div className="dh">
                    {/* 服务端 wd 是 0..6（周一到周日）—— python 的 weekday()，不是 1..7。
                        直接当 1-based 用会整体错一天：今天周五被写成周一。 */}
                    <b>{day.is_today ? '今天' : '周' + (WD[day.wd] ?? '?')}</b>
                    <span>{md(day.date)}</span>
                    <em>{day.minutes ? day.minutes + '′' : '—'}</em>
                  </div>
                  {/* 块以前是纯 div —— 48 个块一个都点不动。
                      现在点一下：先定这一讲（pick_lesson），再带科目进课堂。 */}
                  {(day.blocks || []).map((b, i) => (
                    <div key={i} className={'blk-mn blk-clk ' + (b.cls || '')}
                      role="button" tabIndex={0}
                      title={`${b.subject_name} · ${b.chapter} · ${b.title}　点击进这一讲`}
                      onClick={() => openBlock(b)}
                      onKeyDown={(e) => { if (e.key === 'Enter') openBlock(b) }}>
                      <b style={{ color: colOf(b.subject) }}>
                        {(b.subject_name || '').slice(0, 3)}{b.part ? ' · 接上' : ''}
                      </b>
                      <span>{b.chapter || b.title}</span>
                      <em>{Math.round(b.minutes)}′{b.start ? ' · ' + b.start : ''}</em>
                    </div>
                  ))}
                  {rest >= 15 ? (
                    <div className="blk-mn void"><span>剩余 {Math.round(rest)} 分留白 —— 排不进就不硬塞</span></div>
                  ) : null}
                </div>
              )
            })}
          </div>

          <div className="wksum-mn">
            <div className="ws-l">
              <b>本周合计 {weekMinutes} 分钟</b>
              <span>{bySub.length
                ? bySub.map((s) => `${s.name} ${Math.round(s.minutes)}`).join(' · ')
                : '这一周没有排到任何讲次'}</span>
            </div>
            <div className="ws-bar">
              {/* 分段条的百分比必须用「这几段自己的和」当分母。
                  以前用 d.total_minutes（每天×7 的远景值，21300），
                  但 bySub 只累加讲次块里的分钟数，两者不是一回事 ——
                  结果五段加起来才 4.9%，全挤在左边一小撮。 */}
              {bySub.map((s) => (
                <i key={s.cls}
                  style={{ width: (barSum ? (s.minutes / barSum) * 100 : 0) + '%', background: colOf(s.cls) }} />
              ))}
            </div>
            <div className="ws-r">超时不会崩 —— 今天没学完的明天自动往后挪</div>
          </div>

          {!!cutSample.length ? (
            <>
              <Sect title={`砍掉的 ${cutTotal} 讲 · 每条都写清为什么`} right="按分值切额度，额度外的从尾部砍" />
              <div className="cuts-mn">
                {cutSample.map((c) => (
                  <div key={c.id} className="cut-mn" style={{ borderLeftColor: colOf(c.cls) }}>
                    <span className="sub" style={{ color: colOf(c.cls) }}>{c.subject}</span>
                    <b>{c.title}</b>
                    <span className="why">{c.why}</span>
                    <em>{c.minutes} 分钟 · {c.id}</em>
                  </div>
                ))}
              </div>
              <div className="note-mn bare">
                这里只列出前 {cutSample.length} 条 —— 砍掉的 {cutTotal} 讲每一条都带这一句 why，
                由 plan_budget 现算，改天数或每天时长就变。
              </div>
            </>
          ) : (
            <div className="note-mn">这个时长下没有砍掉任何讲次 —— 全部吃得下，覆盖率 100%。</div>
          )}
        </>
      ) : null}

      {!noBasis && !days.length ? (
        <div className="empty-mn"><b>正在排…</b>七天排程来自 plan_week，取不到就是没排出来。</div>
      ) : null}

      <div className="note-mn">
        额度 = 该科分值 ÷ 总分 × 每天分钟数 × 剩余天数，按分值权重切，不按「哪科课多」切。
        <b>「砍」不是删掉</b>：它仍在课程库里，只是这个时长下吃不完，排在额度之外的讲次会写明为什么。
        每天时长那格改完按重排，整张表当场重算 —— 数字都能从 plan_budget 一条 curl 打回来。
      </div>
    </>
  )
}
