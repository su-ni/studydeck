import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import type { Base } from '../lib/api'
import { useTool } from '../lib/useTool'
import { Icon } from '../components/Icon'
import { Sel } from '../components/Sel'
import { Empty, Skel } from '../components/V6'
import { delShots, tagShots, thumbFallback, thumbUrl, fullUrl } from '../lib/herd'

/* 截图库：所有截过的帧都在这一页。

   以前只有两个地方能看到图：课堂右栏（只有本讲那 24 张）和画布里的一个小抽屉。
   人在课堂截了 200 张，想回头找「上次那张进制表」——没地方找。
   这一页就是那个地方：按科目 + 讲次筛、按关键词搜、点开是大图（能左右翻、能存、能删）。

   缩略图点开不是「新开一个标签页」：那样想看下一张得关掉、回来、再点 —— 翻十张
   就是十次来回。这里开的是灯箱：左右箭头 / ← → 键一直翻，Esc 关。

   多选（2026-10-30 加）：一次清掉二十张废帧、给一批图打同一个标签 —— 单张单张点
   删除，点二十次要四十下（还是两步确认）。所以这一页的选择是「勾选模式」：
   点「选择」进多选，卡片整体可点，Shift 连选一段，顶部条上一次性办完。
   为什么不常驻勾选框：平时看图的动作远多于整理，常驻的方框会让每张图都像表单。 */

type Shot = {
  id: string; subject?: string; lesson_id?: string; lesson_title?: string
  title?: string; file: string; w?: number; h?: number; bytes?: number
  pos_sec?: number | null; tag?: string; origin?: string; age?: string; ts?: string
  tags?: string[]
}
type Les = { lesson_id: string; n: number; title: string }
type TagN = { tag: string; n: number }

const ORIGINS = [
  { value: '', label: '全部来源' },
  { value: 'frame', label: '视频截帧' },
  { value: 'canvas', label: '画布导出' },
  { value: 'upload', label: '上传' },
  { value: 'note', label: '笔记里的图' },
]

function clock(sec?: number | null) {
  if (sec == null) return ''
  const m = Math.floor(sec / 60), s = Math.round(sec % 60)
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

export function Shots({ base }: { base: Base }) {
  const subs: any[] = (base as any)?.subjects ?? []
  const [subject, setSubject] = useState('')
  const [lesson, setLesson] = useState('')
  const [origin, setOrigin] = useState('')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [box, setBox] = useState<number | null>(null)

  /* 多选：picking=true 时卡片整体可点，点一下就是勾 / 取消。
     sel 存 id 不是下标 —— 筛条件一变，下标全部错位，勾着的会变成别的图。 */
  const [picking, setPicking] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [bulkArm, setBulkArm] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [tagIn, setTagIn] = useState('')
  const [busy, setBusy] = useState(false)

  const args = useMemo(() => ({
    subject: subject || undefined,
    lesson_id: lesson || undefined,
    origin: origin || undefined,
    q: q.trim() || undefined,
    limit: 300,
  }), [subject, lesson, origin, q])
  const ls = useTool<{ shots: Shot[]; count: number; total: number; lessons?: Les[]; tags?: TagN[] }>('shot_list', args)
  const shots = ls.data?.shots || []
  const lessonList = ls.data?.lessons || []
  const tagList = ls.data?.tags || []

  /* 换科目就把讲次筛掉 —— 留着上一门的 lesson_id，结果必然是空的，
     而人会以为「这一门一张都没有」。 */
  useEffect(() => { setLesson('') }, [subject])

  /* 列表换了就把已选里已经不存在的 id 清掉。
     不清的后果：勾了 5 张，换个科目，工具栏还写着「已选 5 张」，点删除时
     那 5 个 id 有一半属于别的科目 —— 人会以为删的是眼前这几张。 */
  useEffect(() => {
    setSel((s) => {
      if (!s.size) return s
      const live = new Set(shots.map((x) => x.id))
      let dirty = false
      const next = new Set<string>()
      s.forEach((id) => { if (live.has(id)) next.add(id); else dirty = true })
      return dirty ? next : s
    })
  }, [shots])

  const cur = box != null ? shots[box] : null
  const strip = useRef<HTMLDivElement>(null)
  /* 胶片条跟着当前张滚 —— 翻到第 20 张时缩略图还在最左边，等于没跟着走。 */
  useEffect(() => {
    if (box == null) return
    const el = strip.current?.children[box] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [box])

  useEffect(() => {
    if (box == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setBox(null); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setBox((i) => (i == null ? i : Math.max(0, i - 1))) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setBox((i) => (i == null ? i : Math.min(shots.length - 1, i + 1))) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [box, shots.length])

  /* 选择态里的键盘：Esc 退出选择。图库最常干的就是「勾一批、删掉、退出」，
     手回到 Esc 是本能，留在选择态里不动会让人以为删完还在编辑。 */
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !box) { setPicking(false); setSel(new Set()); setBulkArm(false); setTagOpen(false) }
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); setSel(new Set(shots.map((s) => s.id)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking, box, shots])

  function toggle(s: Shot, e?: React.MouseEvent) {
    const id = s.id
    /* Shift 连选：从上次点的那张到这张，中间全勾上（再按住 Shift 点同一段就是取消）。
       整理截图一屏二十张，一张张点二十下不如点两下。 */
    if (e?.shiftKey && anchor && anchor !== id) {
      const a = shots.findIndex((x) => x.id === anchor)
      const b = shots.findIndex((x) => x.id === id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const on = !sel.has(id)
        setSel((prev) => {
          const next = new Set(prev)
          for (let i = lo; i <= hi; i++) { on ? next.add(shots[i].id) : next.delete(shots[i].id) }
          return next
        })
        setAnchor(id)
        return
      }
    }
    setAnchor(id)
    setSel((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearSel() { setSel(new Set()); setBulkArm(false); setTagOpen(false); setAnchor(null) }

  async function del(s: Shot) {
    if (armed !== s.id) { setArmed(s.id); return }
    const r = await callTool('shot_del', { id: s.id })
    setArmed(null)
    setMsg(r.ok ? '已从库里摘掉这一条（盘上的图还在）' : (r.error || '没删掉'))
    if (r.ok) {
      // 删掉的正好是正在看的那张：退到前一张，别把灯箱关掉让人重新找
      if (cur && cur.id === s.id) setBox((i) => (i == null ? null : Math.max(0, i - 1)))
      ls.run()
    }
  }

  /* 批量删。两步确认跟单张一样，但第一下之后按钮写的是「再点一次删掉 N 张」——
     数字必须进按钮里。只写「确认」的话，人不知道这一下会删几张。 */
  const delMany = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    setBusy(true)
    try {
      const r = await delShots(ids)
      setBulkArm(false)
      if (!r.ok && !r.n) { setMsg(r.error || '一张都没删掉'); return }
      setMsg(r.fail
        ? '删掉 ' + r.n + ' 张，' + r.fail + ' 张没删掉' + (r.error ? '（' + r.error + '）' : '')
        : '已从库里摘掉 ' + r.n + ' 张（盘上的图还在）')
      setSel(new Set())
      setBox((i) => (i == null ? null : Math.max(0, i - 1)))
      ls.run()
    } finally { setBusy(false) }
  }, [ls])

  async function applyTag() {
    const t = tagIn.trim()
    if (!t) { setMsg('先写一个标签'); return }
    const picked = shots.filter((s) => sel.has(s.id))
    if (!picked.length) { setMsg('没勾任何一张'); return }
    setBusy(true)
    try {
      const r = await tagShots(picked, [t], [])
      setMsg(r.fail
        ? '标了 ' + r.n + ' 张，' + r.fail + ' 张没标上' + (r.error ? '（' + r.error + '）' : '')
        : '给 ' + r.n + ' 张打了标签「' + t + '」')
      setTagIn(''); setTagOpen(false)
      ls.run()
    } finally { setBusy(false) }
  }

  const selCount = sel.size
  const allOn = shots.length > 0 && shots.every((s) => sel.has(s.id))

  return (
    <section className="shots">
      <div className="shots-filter">
        <Sel ariaLabel="科目" value={subject} onChange={setSubject} style={{ width: 132 }}
          options={[{ value: '', label: '全部科目' },
          ...subs.map((s) => ({ value: s.id, label: s.name }))]} />
        <Sel ariaLabel="讲次" value={lesson} onChange={setLesson} style={{ width: 208 }}
          options={[{ value: '', label: '全部讲次' },
          ...lessonList.map((l) => ({ value: l.lesson_id, label: l.title + '（' + l.n + '）' }))]} />
        <Sel ariaLabel="来源" value={origin} onChange={setOrigin} style={{ width: 126 }} options={ORIGINS} />
        <input className="inp-mn" style={{ flex: 1, minWidth: 140 }} placeholder="搜标题 / 讲次名，例如「进制」"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={'pbtn-mn ghost' + (picking ? ' on' : '')}
          onClick={() => { if (picking) { setPicking(false); clearSel() } else setPicking(true) }}
          title={picking ? '退出多选（Esc）' : '进入多选：勾几张一起删 / 一起打标签'}>
          <Icon n="sel" size={13} />{picking ? '退出多选' : '多选'}
        </button>
        <span className="shots-n">
          {ls.data ? shots.length + ' 张' + (shots.length < (ls.data.total || 0) ? ' / 共 ' + ls.data.total : '') : '—'}
        </span>
      </div>

      {/* 选择条：只在多选态出现，并且跟着滚动吸顶 ——
          一屏二十张，滚到底部才想起来「我勾了哪些」就得再滚回去看。 */}
      {picking ? (
        <div className="shots-bar">
          <span className="n"><b>{selCount}</b> 张已选</span>
          <button className="pbtn-mn ghost" onClick={() => setSel(allOn ? new Set() : new Set(shots.map((s) => s.id)))}
            title="全选 / 全不选（Ctrl+A）">{allOn ? '全不选' : '全选'}</button>
          <button className="pbtn-mn ghost" disabled={!selCount}
            onClick={() => setSel((prev) => {
              const next = new Set<string>()
              shots.forEach((s) => { if (!prev.has(s.id)) next.add(s.id) })
              return next
            })}>反选</button>
          <button className="pbtn-mn ghost" disabled={!selCount} onClick={clearSel}>清空</button>
          <span className="sp" />
          <button className="pbtn-mn ghost" disabled={!selCount}
            onClick={() => { setBulkArm(false); setTagOpen((v) => !v) }}
            title="给勾上的这些打同一个标签">
            <Icon n="tag" size={13} />打标签
          </button>
          <button className={'pbtn-mn danger' + (bulkArm ? ' on' : '')} disabled={!selCount || busy}
            onClick={() => { if (!bulkArm) { setBulkArm(true); return } delMany([...sel]) }}
            title="从库里摘掉勾上的这些（盘上的图不删）">
            <Icon n="trash" size={13} />{busy ? '删中…' : bulkArm ? '再点一次删掉 ' + selCount + ' 张' : '删掉'}
          </button>
        </div>
      ) : null}

      {picking && tagOpen ? (
        <div className="shots-tagbox">
          <input className="inp-mn" autoFocus placeholder="标签名，例如「易错」「进制」"
            value={tagIn} onChange={(e) => setTagIn(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyTag(); if (e.key === 'Escape') setTagOpen(false) }} />
          <button className="pbtn-mn" disabled={busy || !tagIn.trim()} onClick={applyTag}>
            {busy ? '写入中…' : '给 ' + selCount + ' 张打上'}
          </button>
          {tagList.length ? (
            <span className="hint">已有的：
              {tagList.slice(0, 8).map((t) => (
                <button key={t.tag} className="tagchip-mn" onClick={() => setTagIn(t.tag)}>{t.tag} · {t.n}</button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {msg ? <div className="shots-msg">{msg}</div> : null}

      {ls.loading && !shots.length ? (
        <Skel kind="card" n={4} />
      ) : shots.length ? (
        /* 主动加载的那批走 eager：缩略图有 onError 兜底，兜底就是再发一次原图请求 ——
           屏外的几十张图各失败一次、再各重发一次，首屏等于白跑两轮。
           屏外的仍是 loading="lazy"，滚到才发。 */
        <div className={'shots-grid' + (picking ? ' picking' : '')}>
          {shots.map((s, i) => {
            const sub = subs.find((x) => x.id === s.subject)
            const on = sel.has(s.id)
            return (
              <div className={'shot-c' + (on ? ' on' : '')} key={s.id}>
                <button className="shot-img"
                  onClick={(e) => {
                    /* 多选态点图 = 勾上；看图要点标题那行或双击。
                       不然「想勾这张」和「想看这张」抢同一个点击，两个都别扭。 */
                    if (picking) { toggle(s, e); return }
                    setBox(i)
                  }}
                  onDoubleClick={() => { if (picking) setBox(i) }}
                  title={picking ? '点一下勾上这张（Shift 连选）' : '点开看大图（← → 翻，Esc 关）'}>
                  <img src={thumbUrl(s.file)} alt={s.title || ''} loading="lazy"
                    onError={(e) => thumbFallback(e, s.file)} />
                  {s.pos_sec != null ? <span className="t">{clock(s.pos_sec)}</span> : null}
                  {picking ? (
                    <span className={'shot-chk' + (on ? ' on' : '')} aria-hidden="true">
                      {on ? <Icon n="check" size={12} /> : null}
                    </span>
                  ) : null}
                  {(s.tags || []).length ? (
                    <span className="shot-tags">{(s.tags || []).slice(0, 3).map((t) => <i key={t}>{t}</i>)}</span>
                  ) : null}
                </button>
                <div className="shot-b">
                  <b title={s.title || ''}
                    onClick={() => { if (picking) toggle(s); else setBox(i) }}>{s.title || '没写标题'}</b>
                  <i>
                    {sub?.name || s.subject || '—'}
                    {s.lesson_title ? ' · ' + s.lesson_title : ''}
                  </i>
                  <span className="shot-foot">
                    <em>{s.age || (s.ts || '').slice(0, 16)}</em>
                    <button className={'shot-del' + (armed === s.id ? ' on' : '')}
                      onClick={() => del(s)} title="从库里摘掉（盘上的图不删）">
                      {armed === s.id ? '再点一次' : <Icon n="trash" size={13} />}
                    </button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <Empty title={q || subject || lesson || origin ? '这个条件下没有截图' : '还没有截图'}>
          课堂里按 S（或点「截这一帧」）存下来的每一帧都会进这里；
          画布导出的图、从别处上传的图也在。
        </Empty>
      )}

      {/* 灯箱：整屏用一个东西看图，而不是弹一张小卡片。
          顶部是「这是什么」，中间是图，底部是胶片条 —— 想在 26 张里挑一张，
          拖缩略图比按二十次箭头快。 */}
      {cur ? (
        <div className="lbox" onClick={() => setBox(null)} role="dialog" aria-label="看图">
          <div className="lbox-top" onClick={(e) => e.stopPropagation()}>
            <div className="t">
              <b>{cur.title || '没写标题'}</b>
              <span>
                {(box! + 1) + ' / ' + shots.length}
                {cur.lesson_title ? '　·　' + cur.lesson_title : ''}
                {cur.pos_sec != null ? '　·　' + clock(cur.pos_sec) : ''}
                {cur.w && cur.h ? '　·　' + cur.w + '×' + cur.h : ''}
              </span>
            </div>
            <div className="a">
              <button className={'pbtn-mn ghost' + (sel.has(cur.id) ? ' on' : '')}
                onClick={() => toggle(cur)} title="把这一张加入/移出已选">
                <Icon n="sel" size={13} />{sel.has(cur.id) ? '已勾选' : '勾选'}
              </button>
              <a className="pbtn-mn ghost" href={fullUrl(cur.file)} download={cur.title || cur.file}>
                <Icon n="img" size={14} />存下来
              </a>
              <button className={'pbtn-mn ghost' + (armed === cur.id ? ' danger' : '')}
                onClick={() => del(cur)}>
                {armed === cur.id ? '再点一次确认删' : '从库里删'}
              </button>
              <button className="pbtn-mn icon" aria-label="关闭" onClick={() => setBox(null)}>
                <Icon n="x" size={16} />
              </button>
            </div>
          </div>

          <div className="lbox-body" onClick={(e) => e.stopPropagation()}>
            <button className="lbox-nav l" aria-label="上一张" disabled={box === 0}
              onClick={() => setBox((i) => Math.max(0, (i || 0) - 1))}>
              <Icon n="chev" size={22} />
            </button>
            <img src={fullUrl(cur.file)} alt={cur.title || ''} />
            <button className="lbox-nav r" aria-label="下一张" disabled={box === shots.length - 1}
              onClick={() => setBox((i) => Math.min(shots.length - 1, (i || 0) + 1))}>
              <Icon n="chev" size={22} />
            </button>
          </div>

          <div className="lbox-strip" ref={strip} onClick={(e) => e.stopPropagation()}>
            {shots.map((s2, i) => (
              <button key={s2.id} className={i === box ? 'on' : ''} onClick={() => setBox(i)}
                title={s2.title || ''}>
                <img src={thumbUrl(s2.file, 320)} alt="" loading="lazy"
                  onError={(e) => thumbFallback(e, s2.file)} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
