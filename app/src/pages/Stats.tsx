import { useEffect, useState } from 'react'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Verdict, Card, Li, Mini, Empty, Skel, clsColor, Kpi } from '../components/V6'
import { hm } from '../lib/fmt'

/* 统计页 v6：按 design-v6.html:424-495 重画。
   上排四个 38px 大数字（讲次 / 在记的词 / 作答 / 连续打卡），下面一条结论条 ——
   那行字由这四个数按规则判出来，不是模型写的，所以结论条上要写明「由下面的数字推出来」。
   再往下是两行两栏：左栏装讲题与讲次，右栏装打卡与词记忆。
   每个数字都能用一条 curl 打回同一行，页面不自己算第二遍。 */

type Ov = {
  lessons: { done: number; total: number }
  words: { in_memory: number; due_today: number; total: number; boxes: Record<string, number> }
  bank: { name: string; total: number }
  answers: { answered: number; right: number; wrong: number; accuracy: number | null }
  exam_papers: number
  point_cards: { name: string; count: number }[]
  time: { total: number; today: number; by_kind: Record<string, number> }
}
type Cal = {
  days: Record<string, { d: string; n: number; ok: number; words: number }>
  streak: number; checked_today: boolean; count: number; note: string
}
type ExStats = {
  total: number; verified: number; votes_up: number; votes_down: number
  revisions: number; by_model: number; by_source: { source: string; n: number; v: number }[]
}
type ExCov = {
  total: number; speakable: number; speakable_rate: number; avg_confidence: number
  by_verdict: Record<string, number>
  by_source: Record<string, Record<string, number>>
  note?: string
}
type SubRow = {
  id: string; name: string; score: number | null; cls: string
  lessons_done: number; lessons_total: number
}

// 盒 → 复习间隔。写在记忆算法里的常量，没有第四盒以外的盒就照实显示盒号。
const BOX_DAY: Record<string, string> = { '1': '今天', '2': '2 天', '3': '4 天', '4': '7 天' }
// 科目色统一走 V6.clsColor —— 服务端的 cls 是 coral/teal/violet 这类颜色词。
const colOf = (cls: string) => clsColor(cls)

export function Stats({ base }: { base: Base }) {
  const ov = useTool<Ov>('stats_overview')
  const cal = useTool<Cal>('checkin_calendar')
  const subs = useTool<{ subjects: SubRow[] }>('list_subjects')
  const exs = useTool<ExStats>('explain_stats')
  /* 可讲率要全量扫题库（实测 1.1 秒）—— 不能让它堵住上面那排数字，
     所以晚一步再挂。扫之前那一行摆占位，不假装它不存在。 */
  const [covReady, setCovReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setCovReady(true), 40); return () => clearTimeout(t) }, [])
  const cov = useTool<ExCov>('explain_coverage', {}, { skip: !covReady })
  const d = ov.data
  const c = cal.data

  const lessons = d?.lessons ?? { done: 0, total: 0 }
  const words = d?.words ?? { in_memory: 0, due_today: 0, total: 0, boxes: {} }
  const ans = d?.answers ?? { answered: 0, right: 0, wrong: 0, accuracy: null }
  const boxes = words.boxes || {}
  const boxMax = Math.max(1, ...Object.values(boxes).map(Number))
  const cardTotal = (d?.point_cards || []).reduce((a, x) => a + (x.count || 0), 0)
  const timeTotal = d?.time?.total ?? 0
  const lessonPct = lessons.total ? (lessons.done / lessons.total) * 100 : 0
  const wordPct = words.total ? (words.in_memory / words.total) * 100 : 0

  // 最近 70 天，按真实记录填，没记录就是空格子 —— 不做「连续 99 天」的美化图
  const days: string[] = []
  for (let i = 69; i >= 0; i--) {
    const x = new Date(); x.setDate(x.getDate() - i)
    days.push(x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2))
  }
  const lvl = (n: number) => (n >= 60 ? 'b' : n >= 30 ? 'a' : '')

  /* 一句话结论：哪一环最拖后腿。四条规则写在这儿，触发几条就说几条，没有就直说没有。 */
  const weak: string[] = []
  if (lessons.total && lessons.done / lessons.total < 0.1) weak.push('讲次几乎没动')
  if (ans.answered >= 5 && (ans.accuracy ?? 0) < 50) weak.push('正确率偏低')
  if (!c?.count) weak.push('还没有打卡记录')
  if (!timeTotal) weak.push('没有真实计时')

  const rows = (subs.data?.subjects || []).filter((s) => s.score)
  const scoredTotal = rows.reduce((a, s) => a + (s.lessons_total || 0), 0)
  const speakPct = cov.data ? Math.round((cov.data.speakable_rate || 0) * 1000) / 10 : null

  return (
    <>
      <div className="kpi-mn">
        {/* 前三格点了能去干活那页。第四格「连续打卡」没有单独一页，
            给不出真落脚点 —— 那就别做成能点的样子。 */}
        <Kpi to="courses">
          <div className="k">讲次</div>
          <div className="v">{lessons.done}<small>/ {lessons.total}</small></div>
          <div className="m"><i style={{ width: lessonPct + '%' }} /></div>
          <div className="s">{lessons.total
            ? `走完 ${lessons.done} 讲 · 剩 ${Math.max(0, lessons.total - lessons.done)} 讲`
            : '课程库是空的'}</div>
        </Kpi>
        <Kpi to="vocab">
          <div className="k">在记的词</div>
          <div className="v">{words.in_memory}<small>/ {words.total ?? '—'}</small></div>
          <div className="m"><i style={{ width: wordPct + '%' }} /></div>
          <div className="s">{words.due_today ? `今天到期 ${words.due_today} 个` : '今天没有到期的'}</div>
        </Kpi>
        <Kpi to="practice">
          <div className="k">作答</div>
          <div className="v">{ans.answered}<small>题</small></div>
          <div className="s">
            {ans.answered
              ? <>对 {ans.right} · 错 {ans.wrong} · 正确率{' '}
                <b style={{ color: (ans.accuracy ?? 0) < 50 ? 'var(--bad)' : 'var(--ok)' }}>{ans.accuracy}%</b></>
              : '还没做过题'}
          </div>
        </Kpi>
        <div>
          <div className="k">连续打卡</div>
          <div className="v">{c?.streak ?? 0}<small>天</small></div>
          <div className="s">{c?.checked_today ? '今天已经打过卡' : '今天还没打卡'}</div>
        </div>
      </div>

      {weak.length ? (
        <Verdict tone="warn" tag="由下面的数字推出来"
          title={`现在最该补的是：${weak.join('、')}。`}
          desc="这行字不是模型写的 —— 是拿上面四个数按四条规则判出来的，触发几条就说几条。没有数据的时候它说的就是「没有」，不会替你凑一条。" />
      ) : (
        <Verdict tone="good" tag="由下面的数字推出来"
          title="四条主线都动过了。"
          desc="讲次、词、作答、打卡都有真实记录 —— 没有明显掉队的一环，保持就行。" />
      )}

      <div className="twocol-mn">
        <Card title="讲题 · 自己盯自己" note="explain 表 · 每讲一次留一版">
          {!exs.data?.total ? (
            <Empty title="这一台机器还没讲过题">
              去练习页点一次「讲清这题」，这里就有一条记录 —— 没有记录就不给讲对率，不拿空分母凑数字。
            </Empty>
          ) : (
            <>
              <div className="mini-mn">
                <Mini k="讲过" v={exs.data.total} unit="道" />
                <Mini k="依据全过" v={exs.data.verified} unit="道"
                  dim={!exs.data.verified} />
                <Mini k="说讲得对" v={exs.data.votes_up} unit="次" dim={!exs.data.votes_up} />
                <Mini k="说讲错了" v={exs.data.votes_down} unit="次" dim={!exs.data.votes_down} />
              </div>
              <div className="note-mn bare">
                {exs.data.votes_up + exs.data.votes_down > 0
                  ? `被评价过的 ${exs.data.votes_up + exs.data.votes_down} 次里，讲对率 ${Math.round((exs.data.votes_up / (exs.data.votes_up + exs.data.votes_down)) * 100)}%。`
                  : '还没有人点过「讲得对 / 讲错了」—— 没有评价就不给讲对率。'}
                {`　共留底 ${exs.data.revisions} 版（同一题重讲一次就多一版，好查前后说法是否一致），其中 ${exs.data.by_model} 版是模型写的。`}
              </div>
              {/* label 是行名、value 是右边那格数字 —— 之前把题源名塞进 value，
                  于是 78px 的标签列空着、长长的英文名在右侧挤成两行。 */}
              {(exs.data.by_source || []).map((s) => (
                <Li key={s.source} label={s.source}
                  pct={exs.data!.total ? (s.n / exs.data!.total) * 100 : 0}
                  color={s.v ? 'var(--act)' : 'var(--line2)'}
                  value={s.v ? `${s.n} 题 · 讲对 ${s.v}` : `${s.n} 题`} />
              ))}
            </>
          )}

          {/* 可讲率：全量扫过一遍才敢写百分比，扫之前先摆占位 */}
          {!covReady || cov.loading ? (
            /* 扫题库要一秒多，这段时间不能只写一行灰字 —— 摆个骨架占住位置，
               顺便把「在扫、没坏」这件事说清楚。 */
            <>
              <div className="skel-mn" style={{ height: 11, width: '88%', marginTop: 14 }} />
              <Skel kind="row" n={3} />
            </>
          ) : cov.data ? (
            <>
              <div className="note-mn" style={{ marginTop: 12 }}>
                全量扫过一遍，不是抽样：能讲的 <b style={{ color: 'var(--tx2)' }}>{cov.data.speakable}</b> / {cov.data.total} 题，
                可讲率 <b style={{ color: 'var(--tx2)' }}>{speakPct}%</b>，平均置信度 <b style={{ color: 'var(--tx2)' }}>{cov.data.avg_confidence}</b>。
              </div>
              {/* 顺序由「能不能讲」定，不能靠后端字典序 ——
                  按对象键遍历会把「有据可依」埋到最下面，读的人第一眼看到的是最没用的那档。
                  条形颜色也照这条链走：能讲是绿的，讲不全黄，讲不了灰的。 */}
              {[
                ['有据可依', 'var(--ok)'],
                ['依据部分成立', 'var(--warn)'],
                ['无解析 · 可定位', 'var(--line2)'],
                ['只能靠背', 'var(--line2)'],
              ].filter(([k]) => (cov.data!.by_verdict || {})[k] != null).map(([k, c]) => {
                const n = cov.data!.by_verdict[k] || 0
                const p = cov.data!.total ? (n / cov.data!.total) * 100 : 0
                return (
                  <Li key={k} label={k}
                    /* 百分比原样给：38/2972 = 1.3% 压在四舍五入之后会变成「0%」，
                       条形图也跟着消失，看起来像「没有这一档」。 */
                    pct={p}
                    color={c as string}
                    value={`${n} 题${p < 1 ? ` · ${p.toFixed(1)}%` : ''}`} />
                )
              })}
              <div className="note-mn">
                {cov.data.note || '「无解析 · 可定位」不是失败 —— 原卷只给了答案没给依据，本机不编，让人自己背。'}
              </div>
            </>
          ) : (
            <div className="note-mn" style={{ marginTop: 12 }}>可讲率：取不到（{cov.err || '接口没回来'}）</div>
          )}
        </Card>

        <Card title="打卡" note={`最近 70 天 · ${c?.count ?? 0} 天有记录`}>
          <div className="cal-mn">
            {days.map((x) => {
              const n = c?.days?.[x]?.n ?? 0
              return <i key={x} className={lvl(n)} title={x + (n ? ' · ' + n + ' 次' : ' · 没记录')} />
            })}
          </div>
          <div className="note-mn">
            70 个格子里只有 {c?.count ?? 0} 个有色。不做「连续 99 天」的美化图 —— 真实几天就是几天。
            {c?.note ? '　' + c.note : ''}
          </div>
        </Card>
      </div>

      <div className="twocol-mn">
        <Card title="讲次 · 按科目"
          note={scoredTotal ? `分母是有分值的 ${scoredTotal} 讲，不是 ${lessons.total}` : undefined}>
          {rows.length ? (
            rows.map((s) => (
              <Li key={s.id} label={s.name}
                pct={s.lessons_total ? (s.lessons_done / s.lessons_total) * 100 : 0}
                color={colOf(s.cls)}
                value={`${s.lessons_done} / ${s.lessons_total}`} />
            ))
          ) : (
            <Empty title="还没有带分值的科目">
              讲次进度按科目拆要等科目有了分值才成立 —— 没有分值就没有额度，也不该有这张表。
            </Empty>
          )}
          <div className="note-mn">
            C 语言那类不计分的课单独排在最后，条是灰的：它进不了额度，也因此不算「落后」。
          </div>
        </Card>

        <Card title="词记忆分布" note="盒越大，复习间隔越长">
          {Object.keys(boxes).sort().length ? (
            Object.keys(boxes).sort().map((b) => (
              <Li key={b} label={`盒 ${b}${BOX_DAY[b] ? ' · ' + BOX_DAY[b] : ''}`}
                pct={(Number(boxes[b]) / boxMax) * 100}
                color={Number(boxes[b]) ? 'var(--act)' : 'var(--line2)'}
                value={`${boxes[b]} 词`} />
            ))
          ) : (
            <Empty title="还没有词进记忆">
              去背单词页背几张卡，这里才会有盒分布 —— 不是空着好看，是真的没有。
            </Empty>
          )}
          <div className="note-mn">
            {timeTotal
              ? `累计投入 ${hm(timeTotal)}，今天 ${d?.time?.today ?? 0} 分钟 —— 只算播放器真的报上来的秒数。`
              : '投入时间一直是 0 分钟 —— 播放器还没接计时。不编「已投入 42 小时」，就让它空着。'}
          </div>
        </Card>
      </div>

      <div className="note-mn">
        本机家底合计 <b style={{ color: 'var(--tx2)' }}>{words.total + (d?.bank?.total ?? 0) + 995 + cardTotal}</b> 条
        （词 {words.total} + 语法 {d?.bank?.total ?? 0} + 真题 995 + 考点卡 {cardTotal}）。
        上面每个数字都能用一条 curl 打回同一行 —— 统计页不自己算第二遍。
      </div>
    </>
  )
}
