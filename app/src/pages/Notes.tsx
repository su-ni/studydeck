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

/* 「2026-10-30」→「今天 / 昨天 / 10 月 30 日」。
   分组抬头是给人扫的，一眼要看出「这是多久以前的」——
   一串 ISO 日期得先在脑子里算一遍才知道是不是昨天。 */
function dayTitle(iso: string): string {
  const s = String(iso || '')
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s || '日期未记'
  const d = new Date(s + 'T00:00:00')
  if (isNaN(d.getTime())) return s
  const today = new Date()
  const at = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((at(today) - at(d)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff > 1 && diff < 7) return diff + ' 天前'
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
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
      {/* 顶部一条：左边「我在看哪一门」，中间数字，右边动作。
          以前是「下拉 + 一行小字 + 刷新 + 去课堂」四样平铺，字号和长相都差不多，
          「刷新」和「去课堂记一条」并排还都长得能点 —— 一个次要动作和一个主行动抢位置。
          现在：筛选用胶囊分段（跟画布库同一套语言），数字单独一截，动作分主次。 */}
      <div className="nts-bar">
        {scope === 'all' ? (
          <div className="nts-seg" role="group" aria-label="按课程筛选笔记">
            <button className={'nts-pick' + (pick === 'all' ? ' on' : '')} onClick={() => setPick('all')}>
              全部<b>{items.length}</b>
            </button>
            {bySubject.map((x) => (
              <button key={x.id} className={'nts-pick' + (pick === x.id ? ' on' : '')}
                onClick={() => setPick(x.id)} title={'只看「' + x.name + '」的笔记'}>
                <span className="dot" aria-hidden="true" style={{ background: clsColor(x.id) }} />
                {/* 科目名太长（「计算机基础与程序设计」十一个字）会把这一条撑满半屏，
                    分段控件就失去「一眼扫过」的意义。这里截到 6 个字，全名放 title。 */}
                {(x.name.length > 6 ? x.name.slice(0, 6) : x.name)}<b>{x.n}</b>
              </button>
            ))}
          </div>
        ) : (
          <span className="nts-ctx">
            <span className="dot" aria-hidden="true"
              style={{ background: clsColor(cur?.cls || cur?.accent || cur?.id) }} />
            {cur?.name || '还没选课'}
          </span>
        )}
        {/* 数字这截只在「课程内」模式有用（全局模式的条数已经在分段控件上了，
            再写一遍就是同一个数出现两次）。 */}
        {scope === 'course' ? <span className="nts-n">{sub}</span> : null}
        <div className="sp" />
        {/* 刷新改成图标键：它是一个「再读一次」的补充动作，不该跟主行动同样大。 */}
        <button className="nts-btn icon" onClick={() => run()} disabled={loading}
          title={loading ? '正在读…' : '重新读一遍'} aria-label="刷新">
          <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden
            style={loading ? { animation: 'spin 1s linear infinite' } : undefined}>
            <path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9" /><path d="M14.8 3.4v3.4h-3.4" />
          </svg>
        </button>
        <button className="nts-btn on" onClick={() => go('classroom', { sid: want === 'all' ? sid : want })}>
          去课堂记一条
        </button>
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
          {/* 分组抬头：课程内模式是章节，全局模式是日期。
              日期给一个人话写法（今天 / 昨天 / 10 月 30 日）——
              一屏就这一天时，「2026-10-30」那串数字看着像编号。 */}
          <Sect
            title={scope === 'course' ? key : dayTitle(key)}
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
