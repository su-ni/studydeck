import { callTool } from '../lib/api'
import type { Base } from '../lib/api'
import { useTool } from '../lib/useTool'
import { clsColor } from '../components/V6'

/* 课程主页（docs/style-A-dark.html 定稿）：
   进去先看「这门课长什么样」——多少讲、多少小时、学到哪、这一讲接着看什么、
   哪几章、有哪些题源；右栏是家底、走完多少、缺什么。
   题目和播放都不在这一页：这一页只回答「我现在在哪、下一步点哪儿」。

   以前没有这一层：课程库点卡片直接进课堂，人一进去就被丢进播放器，
   不知道自己学到第几章、这门课一共有多少、还剩多少。 */

type Chap = { chapter: string; lessons: any[] }
type Les = { groups: Chap[]; lessons_total: number; lessons_done: number; name?: string }
type SrcRow = { id: string; name: string; total: number; judge: string; kind?: string }
type Cur = {
  lesson?: { id: string; title: string; chapter?: string; dur?: number; local?: string }
  subject?: any
  pos_sec?: number
  lessons_done?: number
  lessons_total?: number
}

const H2 = 3600

/* 章节顺序：库里 lessons 的排列不保证从第一章到最后一章（「其他」「未分组」还常在最前）。
   这里按章名的中文数字排，「其他」这类排到最后 —— 章节表看着乱，等于没有目录。 */
const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
function chapNo(s: string): number {
  const m = /^第([零一二三四五六七八九十]+)章/.exec(s || '')
  if (!m) return 9999
  const t = m[1]
  if (t === '十') return 10
  if (t.length === 1) return CN[t] ?? 9999
  if (t[0] === '十') return 10 + (CN[t[1]] ?? 0)
  if (t[1] === '十') return (CN[t[0]] ?? 0) * 10 + (t[2] ? (CN[t[2]] ?? 0) : 0)
  return 9999
}

function clock(sec?: number) {
  if (!sec || sec < 1) return '00:00'
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

export function CourseHome({ base, sid, onGo }: {
  base: Base
  sid: string
  onGo: (p: any, o?: { sid?: string }) => void
}) {
  const subs: any[] = (base as any).subjects ?? []
  const sub = subs.find((s) => s.id === sid) || subs[0]
  const realId = sub?.id || sid

  const les = useTool<Les>('list_lessons', { subject: realId }, { skip: !realId })
  const srcs = useTool<{ sources: SrcRow[] }>('list_item_sources', { subject: realId }, { skip: !realId })
  const cur = useTool<Cur>('get_current_lesson', { subject: realId }, { skip: !realId })
  const lid = cur.data?.lesson?.id
  const cont = useTool<{ covers?: { name: string; n: number }[] }>(
    'list_lesson_content', { lesson_id: lid }, { skip: !lid })

  const groups: Chap[] = (les.data?.groups || []).slice().sort(
    (a, b) => chapNo(a.chapter) - chapNo(b.chapter))
  const total = les.data?.lessons_total ?? sub?.lessons_total ?? 0
  const done = les.data?.lessons_done ?? sub?.lessons_done ?? 0
  const allLessons = groups.reduce<any[]>((a, g) => a.concat(g.lessons || []), [])
  const totalSec = allLessons.reduce((a, l) => a + (l.dur || 0), 0)
  const hours = totalSec / H2
  const pct = total ? (done / total) * 100 : 0

  /* 可播：本地 mp4 的讲 + B 站课的分集。没有 bvid 也没有 local 的，就是没源。 */
  const localN = allLessons.filter((l) => l.local).length
  const playable = (sub?.bvid ? total : localN)
  const noSrc = total - playable

  /* 剩余时长 → 还要几天（按每天 2 小时算，写在界面上，不是拍脑袋的「进度良好」） */
  const leftSec = allLessons.filter((l) => !l.done).reduce((a, l) => a + (l.dur || 0), 0)
  const days = leftSec > 0 ? Math.ceil(leftSec / (2 * H2)) : 0

  const curLesson = cur.data?.lesson
  const curChap = groups.find((g) => (g.lessons || []).some((l) => l.id === curLesson?.id))
  const covers = cont.data?.covers || []
  const srcAll = srcs.data?.sources || []
  const srcTotal = srcAll.reduce((a, s) => a + (s.total || 0), 0)

  /* 缺什么：只列真能核对的缺口。没有就不编一条凑数。 */
  const miss: string[] = []
  if (!srcAll.length) miss.push('这一科还没有题源 —— 练习页刷不到它')
  if (noSrc > 0) miss.push(noSrc + ' 讲没有可播的源（既不是 B 站课，也没有本地 mp4）')
  if (total && !done) miss.push('一讲都还没开始')
  if (!total) miss.push('这门课还没有讲次 —— 让助手去 B 站找一门')

  /* 章节点进去：先定那一章的第一讲，再进课堂 —— 不让课堂猜。 */
  async function openChap(c: Chap) {
    const first = (c.lessons || []).find((l) => !l.done) || (c.lessons || [])[0]
    if (first?.id) await callTool('pick_lesson', { lesson_id: first.id }, { write: true })
    onGo('classroom', { sid: realId })
  }

  const nm = sub?.name || '这门课'
  const cut = nm.indexOf('与')
  const nmA = cut > 0 ? nm.slice(0, cut) : nm
  const nmB = cut > 0 ? nm.slice(cut) : ''
  const score = sub?.score || 0

  return (
    <section className="chome">
      <header className="chome-head">
        <div className="chome-headmain">
        <div className="kick">{score >= 200 ? '专业综合课' : '公共课'} · {score ? score + ' 分' : '不计分'}</div>
        <h1>{nmA}{nmB ? <em>{nmB}</em> : null}</h1>
        <div className="facts">
          <div className="d"><b>{total}</b>讲</div><span className="sep" />
          <div className="d"><b>{hours ? hours.toFixed(1) : '—'}</b>小时</div><span className="sep" />
          <div className="d"><b>{done}</b>讲已学</div><span className="sep" />
          <div className="d"><b>{pct ? (pct < 1 ? pct.toFixed(1) : Math.round(pct)) : 0}</b>%</div>
        </div>
        </div>
        {/* 这门课的五个视图（照 style-C-cover.html 的分段胶囊）：
            课程主页 / 课堂 / 课表 / 背单词 / 练习。
            它跟左栏目的相同，但它是「从这门课出发」的入口 —— 看完总览直接进下一步，
            不用把视线挪回左边再找一次。左栏仍是全局导航，两处不互为替代。 */}
        <div className="chome-tabs" role="tablist" aria-label="这门课的视图">
          <button role="tab" aria-selected="true" className="on">课程主页</button>
          <button role="tab" aria-selected="false" onClick={() => onGo('classroom', { sid: realId })}>
            课堂{curLesson ? <em>本讲</em> : null}
          </button>
          <button role="tab" aria-selected="false" onClick={() => onGo('schedule', { sid: realId })}>课表</button>
          <button role="tab" aria-selected="false" onClick={() => onGo('vocab', { sid: realId })}>背单词</button>
          <button role="tab" aria-selected="false" onClick={() => onGo('practice', { sid: realId })}>
            练习{srcTotal ? <em>{srcTotal}</em> : null}
          </button>
        </div>
      </header>

      <div className="chome-body">
        <div className="chome-main">
          {curLesson ? (
            <div className="chome-hero">
              <div className="k">接着学</div>
              <h2>{curLesson.title}</h2>
              <div className="meta">
                <span>{curLesson.chapter || '未分组'} · {(curChap?.lessons || []).length} 讲</span>
                <span>{curLesson.dur ? Math.round(curLesson.dur / 60) + ' 分钟' : '时长未记'}</span>
                <span>上次看到 {clock(cur.data?.pos_sec)}</span>
              </div>
              <div className="ft">
                <button className="cbtn" onClick={() => onGo('classroom', { sid: realId })}>继续看 →</button>
                <button className="cbtn gh" onClick={() => onGo('classroom', { sid: realId })}>看讲次目录</button>
                <span className="rt">本讲 {covers.length ? covers.length + ' 个考点' : '没有对应考点'}</span>
              </div>
            </div>
          ) : (
            <div className="chome-hero empty">
              <div className="k">还没有断点</div>
              <h2>{total ? '从第一章第一讲开始' : '这门课还没有讲次'}</h2>
              <div className="meta"><span>{total ? total + ' 讲等着' : '让助手去 B 站找一门，或去设置里手动导'}</span></div>
              <div className="ft">
                {total ? <button className="cbtn" onClick={() => openChap(groups[0])}>从第一讲开始 →</button> : null}
                <button className="cbtn gh" onClick={() => onGo('classroom', { sid: realId })}>去课堂</button>
              </div>
            </div>
          )}

          <div className="chome-sec">
            <h3>{groups.length} 章</h3>
            <span>{total} 讲 · {hours ? hours.toFixed(1) : '—'} 小时</span>
          </div>
          {groups.length ? (
            <div className="chome-chs">
              {groups.map((g) => {
                const ls = g.lessons || []
                const dn = ls.filter((l) => l.done).length
                const mins = Math.round(ls.reduce((a, l) => a + (l.dur || 0), 0) / 60)
                const p = ls.length ? (dn / ls.length) * 100 : 0
                const on = (g.lessons || []).some((l) => l.id === curLesson?.id)
                return (
                  <button key={g.chapter} className={'chome-cr' + (on ? ' on' : '')} onClick={() => openChap(g)}
                    title={'进这一章：' + g.chapter}>
                    <span className="ix">{g.chapter}</span>
                    <span className="b"><i style={{ width: p + '%' }} /></span>
                    <span className="n">{dn}/{ls.length}</span>
                    <span className="t">{mins ? mins + ' 分' : '—'}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="chome-none">这门课还没有讲次目录。可以在课堂页跟助手说「我想学 XXX」，它会找到整门课并落进本机。</div>
          )}

          <div className="chome-sec">
            <h3>题源</h3>
            <span>{srcAll.length} 个 · {srcTotal} 题</span>
          </div>
          {srcAll.length ? (
            <div className="chome-src">
              {srcAll.map((s) => (
                <button key={s.id} className="chome-sr" onClick={() => onGo('practice', { sid: realId })}>
                  <span className="dot" style={{ background: clsColor(sub?.cls || sub?.accent || realId) }} />
                  <span className="nm">{s.name}</span>
                  <span className="n">{s.total} 题 · {s.kind === 'blank' ? '填空' : s.kind === 'short' ? '简答' : '单选'}</span>
                  <span className="go">去练 →</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="chome-none">这一科还没有题源。可以让助手去拉一份，或者在练习页按「按这一科出 3 题」生成。</div>
          )}
        </div>

        <aside className="chome-side">
          <div className="pan">
            <h4>家底</h4>
            <div className="rw big"><span>分值</span><b>{score ? score + ' / 500' : '不计分'}</b></div>
            <div className="rw"><span>讲次</span><b>{total}</b></div>
            <div className="rw"><span>总时长</span><b>{hours ? hours.toFixed(1) + ' 小时' : '—'}</b></div>
            <div className="rw"><span>可播</span><b>{playable} / {total}</b></div>
          </div>

          <div className="pan">
            <h4>走完多少</h4>
            <div className="ring">
              <div className="t">
                <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
                  <circle cx="38" cy="38" r="32" fill="none" stroke="var(--line)" strokeWidth="5.5" />
                  <circle cx="38" cy="38" r="32" fill="none" stroke="var(--act)" strokeWidth="5.5"
                    strokeLinecap="round" strokeDasharray="201.1"
                    strokeDashoffset={201.1 - (201.1 * Math.max(0, Math.min(100, pct))) / 100} />
                </svg>
                {pct ? (pct < 1 ? pct.toFixed(1) : Math.round(pct)) : 0}%
              </div>
              <div className="lg">
                <b>{done} / {total} 讲</b>
                <i>{done >= total && total ? '这一门走完了' : (days ? '剩下的按每天 2 小时\n还要 ' + days + ' 天' : '还没有可播的讲次')}</i>
              </div>
            </div>
          </div>

          <div className={'miss' + (miss.length ? '' : ' none')}>
            <h4>{miss.length ? '缺什么' : '没发现缺口'}</h4>
            {miss.length
              ? miss.map((m) => <li key={m}>{m}</li>)
              : <li>题源、讲次、播放源都在</li>}
          </div>
        </aside>
      </div>
    </section>
  )
}
