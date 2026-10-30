import { useMemo, useState } from 'react'
import type { Base } from '../lib/api'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import { Sect, clsColor } from '../components/V6'
import { Sel } from '../components/Sel'

/* 笔记页：两个入口共用一套渲染 ——
     · 顶栏「笔记」进来 = 这门课的笔记（跟着课程走，按章节分组）
     · 左侧图标进来   = 全部课的笔记（不跟课程，按时间倒序 + 课程筛选）

   为什么是两套口径：学到某一讲顺手记的东西，是「这一讲的」；翻旧账时想的是
   「我哪个月记过什么」。同一批数据，两种读法，硬塞进一个列表里两边都不好用。

   数据本身挂在讲次上（store.notes，一讲一条），所以每一条都能点回那一讲 ——
   记的时候在哪，看的时候回到哪。 */

type Note = {
  lesson_id: string
  text: string
  pos_sec?: number
  updated_ts?: string
  subject?: string
  subject_name?: string
  lesson_title?: string
  chapter?: string
}

type Res = {
  items: Note[]
  total: number
  by_subject?: { id: string; name: string; n: number }[]
  dropped?: number
}

/* 时间戳落成「10-24 21:03」。后端存的是本地时间字符串，不做时区换算。 */
function when(ts?: string): string {
  const s = String(ts || '')
  if (s.length >= 16) return s.slice(5, 16).replace('T', ' ')
  return s || '时间未记'
}

function dayOf(ts?: string): string {
  const s = String(ts || '')
  return s.length >= 10 ? s.slice(0, 10) : '日期未记'
}

/* 进度点：笔记记在第几分钟。没记时间点就不显示，不写「第 0 秒」。 */
function posText(sec?: number): string {
  const n = Math.round(Number(sec) || 0)
  if (n < 5) return ''
  const m = Math.floor(n / 60)
  const r = n % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

export function Notes({ base, sid, scope, go }: {
  base: Base
  sid: string
  scope: 'course' | 'all'
  go: (p: any, o?: { sid?: string }) => void
}) {
  const subs: any[] = (base as any).subjects ?? []
  const cur = subs.find((s) => s.id === sid) || subs[0]
  /* 全局模式下的课程筛选。默认「全部课」—— 这一页进来的目的就是翻旧账。 */
  const [pick, setPick] = useState<string>('all')

  const want = scope === 'course' ? (sid || 'all') : pick
  const { data, loading, err, run } = useTool<Res>('lesson_notes', { subject: want })
  const items: Note[] = data?.items ?? []
  const bySubject = data?.by_subject ?? []

  /* 课程内：按章节归位（同一章的笔记挨在一起，跟课程主页的章节顺序一致）。
     全局：按天归位（昨天记的和上个月记的，不该混成一锅）。 */
  const groups = useMemo(() => {
    const m = new Map<string, Note[]>()
    for (const n of items) {
      const k = scope === 'course' ? (n.chapter || '未分章') : dayOf(n.updated_ts)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(n)
    }
    return Array.from(m.entries())
  }, [items, scope])

  async function open(n: Note) {
    /* 进课堂前先把这一讲设成「当前讲次」，否则课堂会按自己的断点跳到别的讲上 ——
       点了笔记却进了另一讲，是这个项目里出现过好几次的那类错位。 */
    await callTool('pick_lesson', { lesson_id: n.lesson_id }, { write: true })
    go('classroom', { sid: n.subject || sid })
  }

  const title = scope === 'course'
    ? `${cur?.name || '这门课'} · 笔记`
    : '全部笔记'
  const sub = scope === 'course'
    ? (loading ? '正在读…' : `${items.length} 条 · 按章归位`)
    : (loading ? '正在读…' : `${items.length} 条 · ${bySubject.length} 门课`)

  return (
    <>
      {/* 全局模式的筛选行：课程 + 计数。课程内模式不给筛选 ——
          这一页就是「这门课」，再给个课程下拉等于让人在这儿又换一次课，
          而换课只该在顶栏发生一次。 */}
      <div className="nts-bar">
        {scope === 'all' ? (
          <Sel value={pick} onChange={setPick} ariaLabel="按课程筛选笔记"
            className="nts-sel"
            options={[{ value: 'all', label: '全部课程' }].concat(
              subs.map((s: any) => ({
                value: s.id,
                label: s.name,
                note: (bySubject.find((x) => x.id === s.id)?.n ?? 0) + ' 条',
              })))} />
        ) : (
          <span className="nts-ctx">
            <span className="dot" aria-hidden="true"
              style={{ background: clsColor(cur?.cls || cur?.accent || cur?.id) }} />
            {cur?.name || '还没选课'}
          </span>
        )}
        <span className="nts-n">{sub}</span>
        <div className="sp" />
        <button className="nts-btn" onClick={() => run()}>{loading ? '读取中…' : '刷新'}</button>
        {items.length ? (
          <button className="nts-btn on" onClick={() => go('classroom', { sid: want === 'all' ? sid : want })}>
            去课堂记一条
          </button>
        ) : null}
      </div>

      {err ? (
        <div className="empty-mn">
          <b>没读出来</b>
          {err}
        </div>
      ) : null}

      {!err && !loading && !items.length ? (
        /* 空态铺满整行：左边一句话说清「笔记挂在哪」，右边就是那唯一该点的按钮。
           以前是 620px 的虚线小盒子配一整片黑，看着像页面没画完。 */
        <div className="nts-empty">
          <div className="tx">
            <b>{scope === 'course' ? '这门课还没记过笔记' : '还没有任何笔记'}</b>
            <p>{scope === 'course'
              ? '笔记跟着讲次走 —— 在课堂右栏记一条，它就归到那一讲下面。'
              : '五门课的笔记都汇总到这里，按时间倒序排。'}</p>
          </div>
          <div className="act">
            <button className="nts-btn on" onClick={() => go('classroom', { sid: want === 'all' ? sid : want })}>
              去课堂记一条
            </button>
          </div>
        </div>
      ) : null}

      {groups.map(([key, list]) => (
        <div key={key} className="nts-grp">
          <Sect
            title={scope === 'course' ? key : key}
            right={`${list.length} 条`}
          />
          {list.map((n) => {
            const col = clsColor(n.subject || n.subject_name || '')
            return (
              <button key={n.lesson_id} className="nts-item" onClick={() => open(n)}
                title={`进第这一讲：${n.lesson_title || n.lesson_id}`}>
                <div className="hd">
                  <span className="dot" aria-hidden="true" style={{ background: col }} />
                  <b>{n.lesson_title || n.lesson_id}</b>
                  {posText(n.pos_sec) ? <span className="pos">{posText(n.pos_sec)}</span> : null}
                  <span className="sp" />
                  {/* 全局列表要标出「这是哪门课」——不然五门课混在一起读不出上下文 */}
                  {scope === 'all' ? <span className="sub">{n.subject_name || n.subject}</span> : null}
                  <span className="ts">{when(n.updated_ts)}</span>
                </div>
                <div className="tx">{n.text || '（空笔记）'}</div>
              </button>
            )
          })}
        </div>
      ))}

      {!!(data?.dropped) ? (
        <div className="note-mn">
          有 {data!.dropped} 条笔记找不到对应的讲次（那一讲可能已经被删了），没有显示出来。
        </div>
      ) : null}
    </>
  )
}
