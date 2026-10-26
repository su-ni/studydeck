import { useEffect, useRef, useState } from 'react'
import type { ReactNode, ReactElement } from 'react'
import { Icon, type IconName } from './Icon'

/* =========================================================================
   v6 构件（依据 docs/design-v6.html）
   只做壳：页面把数字传进来，这里负责让它们排成设计稿那个样子。
   数字一律外部给 —— 这里不查数据、不算派生值。
   ========================================================================= */

/* -------------------------------------------------- 标签 10px + 字距 */
export function Kick({ children, cls }: { children: ReactNode; cls?: string }) {
  return <span className={'kick' + (cls ? ' ' + cls : '')}>{children}</span>
}

/* -------------------------------------------------- 分区标题：一条线 + 右注 */
export function Sect({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="sect-mn">
      <h3>{title}</h3>
      <div className="ln" />
      {right ? <span className="rt">{right}</span> : null}
    </div>
  )
}

/* -------------------------------------------------- 结论条：左 3px 竖线 + 右上 tag */
export function Verdict({ tone, tag, title, desc }: {
  tone?: 'warn' | 'good' | 'bad'
  tag?: ReactNode
  title: ReactNode
  desc?: ReactNode
}) {
  const t = tone === 'good' ? ' good' : tone === 'bad' ? ' bad' : ''
  return (
    <div className={'verdict-mn' + t}>
      {tag ? <span className="tag">{tag}</span> : null}
      <b>{title}</b>
      {desc ? <p>{desc}</p> : null}
    </div>
  )
}

/* -------------------------------------------------- 深色小卡 */
export function Card({ title, note, children, style }: {
  title: ReactNode; note?: ReactNode; children?: ReactNode; style?: React.CSSProperties
}) {
  return (
    <div className="blkcard-mn" style={style}>
      <div className="hd"><b>{title}</b>{note ? <span>{note}</span> : null}</div>
      {children}
    </div>
  )
}

/* -------------------------------------------------- 一行：78px 标签 + 进度条 + 64px 右值 */
export function Li({ label, pct, color, value }: {
  label?: ReactNode; pct?: number; color?: string; value?: ReactNode
}) {
  return (
    <div className="li-mn">
      <span className="lb">{label}</span>
      {/* 进度条这里用 .tr-mn：.tr 是 app.css 里画布/练习页的老类名，
          和 v6 的同名规则叠在一起时 flex 会被后来者覆盖，整行会被撑歪。 */}
      <div className="tr-mn"><i style={{ width: Math.max(0, Math.min(100, pct ?? 0)) + '%', background: color || 'var(--act)' }} /></div>
      <span className="vv">{value}</span>
    </div>
  )
}

/* -------------------------------------------------- 卡片里的小数字 */
export function Mini({ k, v, unit, dim }: { k: ReactNode; v: ReactNode; unit?: ReactNode; dim?: boolean }) {
  return (
    <div className="m">
      <div className="k">{k}</div>
      <div className="v" style={dim ? { color: 'var(--tx3)' } : undefined}>{v}{unit ? <small>{unit}</small> : null}</div>
    </div>
  )
}

/* -------------------------------------------------- 纸：一页唯一一块亮面 */
export function Paper({ kick, chips, children, cls }: {
  kick: ReactNode; chips?: ReactNode; children?: ReactNode; cls?: string
}) {
  return (
    <div className={'paper-mn' + (cls ? ' ' + cls : '')}>
      <div className="ph">
        <span className="kick">{kick}</span>
        {chips ? <div className="sp">{chips}</div> : null}
      </div>
      {/* 纸的身体：撑满纸剩下的高度，页脚才有地方沉到底 */}
      <div className="paperbody-mn">{children}</div>
    </div>
  )
}

/* -------------------------------------------------- 讲解四段里的窄标题行 */
export function ExPart({ ix, children }: { ix: ReactNode; children?: ReactNode }) {
  return (
    <div className="expart-mn">
      <div className="ix">{ix}</div>
      <div className="tx">{children}</div>
    </div>
  )
}

/* -------------------------------------------------- 引用块：琥珀左竖线 + 出处 */
export function Quote({ tone, children, from }: { tone?: 'bad'; children?: ReactNode; from?: ReactNode }) {
  return (
    <div className={'quote-mn' + (tone === 'bad' ? ' bad' : '')}>
    {children}
    {from ? <div className="from">{from}</div> : null}
    </div>
  )
}

/* -------------------------------------------------- 右窄栏卡片 */
export function Sc({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="sc-mn">
      <div className="h">{title}</div>
      {children}
    </div>
  )
}

/* -------------------------------------------------- 窄栏一行：左标签右值 */
export function Row({ k, v }: { k: ReactNode; v?: ReactNode }) {
  return (
    <div className="row-mn"><span>{k}</span><b>{v}</b></div>
  )
}

/* -------------------------------------------------- 窄栏进度条 */
export function Bar({ label, value, pct, color }: {
  label: ReactNode; value?: ReactNode; pct?: number; color?: string
}) {
  return (
    <div className="bar-mn">
      <div className="lb"><span>{label}</span><b>{value}</b></div>
      <div className="tr-mn"><i style={{ width: Math.max(0, Math.min(100, pct ?? 0)) + '%', background: color || 'var(--act)' }} /></div>
    </div>
  )
}

/* -------------------------------------------------- 科目色（只给身份，不给判分）
 *
 * 两套词都得认：
 *   · subjects.json 里写的是颜色词（coral / teal / violet / blue / amber）——
 *     这是 datahub.cls_of() 真正吐出来的东西；
 *   · 前端老代码里用的是学科缩写（cs / en / math / pol）。
 * 只认后者的话，服务端回 coral 就一路掉到 --line2 灰条 —— 五门课全长一个样。
 * 值一律指向 v6 的科目色变量，不在这里写死色号（改色只改 theme.css 一处）。
 */
export function clsColor(cls: string): string {
  const C: Record<string, string> = {
    // 学科缩写
    cs: 'var(--cs)', en: 'var(--en)', ma: 'var(--math)', math: 'var(--math)',
    po: 'var(--pol)', pol: 'var(--pol)', politics: 'var(--pol)', english: 'var(--en)',
    // subjects.json 的颜色词
    coral: 'var(--cs)',      // 计算机 —— 橙红
    teal: 'var(--en)',       // 英语 —— 青
    blue: 'var(--math)',     // 高数 —— 蓝
    amber: 'var(--pol)',     // 政治 —— 琥珀
    violet: 'var(--tx3)',    // C 语言不计分，灰条排最后
    // 兜底
    clang: 'var(--tx3)', vo: 'var(--line2)', sh: 'var(--line2)',
  }
  return C[cls] || 'var(--line2)'
}

/* -------------------------------------------------- 空状态：说清为什么空 */
export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-mn"><b>{title}</b>{children}</div>
  )
}

/* -------------------------------------------------- KPI 一格
   给 to（页面 id）就整格可点：数字看完了，下一步是去那页干活 ——
   少一次「先认出来这是哪个数、再自己去导航找」。
   凑不出真的落脚点就别装成能点的样子（禁死按钮），不给 to 就是普通格子。 */
const PAGE_CN: Record<string, string> = {
  today: '今日', classroom: '课堂', courses: '课程库', schedule: '计划', vocab: '背单词',
  practice: '练习', exam: '考场', stats: '统计', writing: '作文', agent: '助手', canvas: '画布',
}

export function Kpi({ to, children }: { to?: string; children: ReactNode }) {
  if (!to || !PAGE_CN[to]) return <div>{children}</div>
  return (
    <button className="kjump-mn" title={'去看「' + PAGE_CN[to] + '」'}
      onClick={() => { location.hash = to }}>
      {children}
      <span className="karr" aria-hidden="true">›</span>
    </button>
  )
}

/* -------------------------------------------------- 纸上的按钮 */
export function PBtn({ children, ghost, disabled, busy, onClick, style, title }: {
  children: ReactNode; ghost?: boolean; disabled?: boolean; busy?: boolean
  onClick?: () => void; style?: React.CSSProperties; title?: string
}) {
  // busy 是「点完了、在等回话」，不是 disabled 的意思。只变灰会让人以为点空了，
  // 所以给一条来回扫的琥珀光（见 motion.css 的 .pbtn-mn.busy）。
  return (
    <button className={'pbtn-mn' + (ghost ? ' ghost' : '') + (busy ? ' busy' : '')}
      disabled={disabled} onClick={onClick} style={style} title={title}>
    {children}
    </button>
  )
}

/* -------------------------------------------------- 小 chip（题源行用） */
export function SChip({ on, color, title, note, onClick }: {
  on?: boolean; color?: string; title: ReactNode; note?: ReactNode; onClick?: () => void
}) {
  return (
    <button className={'schip-mn' + (on ? ' on' : '')} onClick={onClick}>
      {color ? <span className="dot" style={{ background: color }} /> : null}
      <b>{title}</b>
      {note ? <i>{note}</i> : null}
    </button>
  )
}

/* -------------------------------------------------- 顶栏 pill */
export function Pill({ act, children }: { act?: boolean; children: ReactNode }) {
  return <span className={'pill' + (act ? ' act' : '')}>{children}</span>
}

/* -------------------------------------------------- 加载中：骨架 + 一条扫光
   原来全站的「正在读…」都是一行灰字，什么也没发生的样子，分不清是在读还是卡住。
   这里给三种形状：数字格（KPI）、纸（练习/考场/作文）、行（列表）。
   骨架的尺寸照真内容的尺寸画 —— 换上来的时候不会跳一下。 */
export function Skel({ kind = 'row', n = 3 }: { kind?: 'kpi' | 'paper' | 'row' | 'card' | 'text'; n?: number }) {
  if (kind === 'kpi') {
    return (
      <div className="kpi-mn">
        {Array.from({ length: n }).map((_, i) => (
          <div key={i}>
            <div className="skel-mn k" />
            <div className="skel-mn v" />
            <div className="skel-mn s" />
          </div>
        ))}
      </div>
    )
  }
  if (kind === 'paper') {
    return (
      <div className="paper-mn skel-paper-mn">
        <div className="skel-mn" style={{ width: '22%', height: 11 }} />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skel-mn" style={{ width: i % 2 ? '86%' : '100%', height: 15, marginTop: 14 }} />
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 18 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skel-mn" style={{ height: 38 }} />
          ))}
        </div>
      </div>
    )
  }
  if (kind === 'card') {
    return (
      <div className="card">
        <div className="skel-mn" style={{ width: '34%', height: 12 }} />
        {Array.from({ length: n }).map((_, i) => (
          <div key={i} className="skel-mn" style={{ width: i % 2 ? '72%' : '96%', height: 11, marginTop: 11 }} />
        ))}
      </div>
    )
  }
  if (kind === 'text') {
    return (
      <>
        {Array.from({ length: n }).map((_, i) => (
          <div key={i} className="skel-mn" style={{ width: i === n - 1 ? '58%' : '100%', height: 11, marginTop: i ? 9 : 0 }} />
        ))}
      </>
    )
  }
  return (
    <div>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0' }}>
          <div className="skel-mn" style={{ width: 78, height: 10 }} />
          <div className="skel-mn" style={{ flex: 1, height: 4 }} />
          <div className="skel-mn" style={{ width: 46, height: 10 }} />
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------- 收起也要有动画
   React 卸载节点的那一瞬间过渡播不出来，所以「收起」必须拆成两步：
   先挂 .closing 让它播完，再真正从 DOM 里拿走。
   没这一层的话，展开有动画、收起就是硬切 —— 看着像闪一下。 */
export function Collapse({ open, children, ms = 190 }: {
  open: boolean; children: ReactNode; ms?: number
}) {
  const [shown, setShown] = useState(open)
  const [closing, setClosing] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (t.current) { clearTimeout(t.current); t.current = null }
    if (open) {
      setShown(true)
      setClosing(false)
      return
    }
    if (!shown) return
    setClosing(true)
    t.current = setTimeout(() => { setShown(false); setClosing(false) }, ms)
    return () => { if (t.current) clearTimeout(t.current) }
  }, [open, ms, shown])

  if (!shown) return null
  return <div className={closing ? 'closing' : undefined}>{children}</div>
}
