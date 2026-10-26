import type { ReactNode, CSSProperties } from 'react'
import { Icon, type IconName } from './Icon'

/* 九页共用的小件。规则写在 ui.css 里，这里只做封装。
   凡是「一行一件事」都走 Item；凡是「一堆数字」都走 Lead/Stat；
   不许再出现一页十几个带边框的卡片 —— 那是仪表盘，不是给人读的界面。 */

export function Page({ children, wide, full }: { children: ReactNode; wide?: boolean; full?: boolean }) {
  return <div className={'u-page' + (full ? ' full' : wide ? ' wide' : '')}>{children}</div>
}

export function Stat({ k, v, unit, dim, sub }: { k: string; v: ReactNode; unit?: ReactNode; dim?: boolean; sub?: string }) {
  return (
    <div className="u-stat">
      <div className={'n' + (dim ? ' dim' : '')}>{v}{unit != null ? <small>{unit}</small> : null}</div>
      <div className="k">{k}</div>
      {sub ? <div className="u-sub">{sub}</div> : null}
    </div>
  )
}

export function Lead({ children }: { children: ReactNode }) {
  return <div className="u-lead">{children}</div>
}

export function Group({
  title, note, children, right,
}: { title: string; note?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="u-group">
      <div className="u-group-hd">
        <b>{title}</b>
        {note != null ? <span className="n">{note}</span> : null}
        {right ? <span className="sp">{right}</span> : null}
      </div>
      {children}
    </div>
  )
}

export function Item({
  title, sub, num, numSub, thumb, on, onClick, tail, meter, chip,
}: {
  title: ReactNode
  sub?: ReactNode
  num?: ReactNode
  numSub?: ReactNode
  thumb?: ReactNode
  on?: boolean
  onClick?: () => void
  tail?: ReactNode
  meter?: number
  chip?: ReactNode
}) {
  return (
    <div className={'u-item' + (on ? ' on' : '') + (onClick ? ' click' : '')} onClick={onClick}>
      {thumb != null ? <div className="u-thumb">{thumb}</div> : null}
      <div className="u-main">
        <div className="u-t">{title}</div>
        {sub != null ? <div className="u-s">{sub}</div> : null}
        {meter != null ? (
          <div className="u-meter" style={{ marginTop: 7, width: '100%' }}>
            <i style={{ width: Math.max(0, Math.min(100, meter)) + '%' }} />
          </div>
        ) : null}
      </div>
      {chip ? <div className="u-tail">{chip}</div> : null}
      {num != null ? (
        <div className="u-num">{num}{numSub != null ? <small>{numSub}</small> : null}</div>
      ) : null}
      {tail ? <div className="u-tail">{tail}</div> : null}
    </div>
  )
}

export function Btn({
  children, onClick, go, ghost, sm, disabled, icon, style,
}: {
  children: ReactNode
  onClick?: () => void
  go?: boolean
  ghost?: boolean
  sm?: boolean
  disabled?: boolean
  icon?: IconName
  style?: CSSProperties
}) {
  return (
    <button className={'u-btn' + (go ? ' go' : '') + (ghost ? ' ghost' : '') + (sm ? ' sm' : '')}
      disabled={disabled} onClick={onClick} style={style}>
      {icon ? <Icon n={icon} size={sm ? 12 : 13} /> : null}
      {children}
    </button>
  )
}

export function Chip({ children, c }: { children: ReactNode; c?: 'a' | 'g' | 'r' | 'w' | 'line' }) {
  return <span className={'u-chip' + (c ? ' ' + c : '')}>{children}</span>
}

export function Meter({ pct, g, dim }: { pct: number; g?: boolean; dim?: boolean }) {
  return (
    <div className={'u-meter' + (g ? ' g' : '') + (dim ? ' dim' : '')}>
      <i style={{ width: Math.max(0, Math.min(100, pct)) + '%' }} />
    </div>
  )
}

export function MeterRow({ pct, value, g }: { pct: number; value: ReactNode; g?: boolean }) {
  return (
    <div className="u-meter-row">
      <Meter pct={pct} g={g} />
      <span style={{ fontSize: 12, color: 'var(--tx3)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{value}</span>
    </div>
  )
}

export function Hint({ children }: { children: ReactNode }) {
  return <div className="u-hint">{children}</div>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="u-empty">
      <b>{title}</b>
      {children}
    </div>
  )
}

export function Bar({ children }: { children: ReactNode }) {
  return <div className="u-bar">{children}</div>
}

/* ============================================================
   v2 返工件 —— 用户看过第一版后判「比原来更丑」，原因不是少了件，
   是「分区不靠卡片」执行过了头：满屏 1px 线，眼睛没有落点。
   所以补回三种容器，但每页限额用：
     Stats  顶部数字，2~4 张，最多 4 张
     Panel  一块内容一张卡，一页最多 3~4 张
     TwoCol 只在真有两件事要并排时
   其余仍然走 Group/Item（行列表），不为「好看」把一页拆成十五张卡。
   ============================================================ */

export function Stats({ children }: { children: ReactNode }) {
  return <div className="u-stats">{children}</div>
}

export function SCard({
  k, v, unit, dim, sub, meter,
}: { k: string; v: ReactNode; unit?: ReactNode; dim?: boolean; sub?: ReactNode; meter?: number }) {
  return (
    <div className="u-scard">
      <div className="k">{k}</div>
      <div className={'v' + (dim ? ' dim' : '')}>{v}{unit != null ? <small>{unit}</small> : null}</div>
      {sub != null ? <div className="s">{sub}</div> : null}
      {meter != null ? <div className="u-meter"><i style={{ width: Math.max(0, Math.min(100, meter)) + '%' }} /></div> : null}
    </div>
  )
}

export function Panel({
  title, note, children, right, className, style,
}: { title?: string; note?: ReactNode; children: ReactNode; right?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={'u-panel' + (className ? ' ' + className : '')} style={style}>
      {title ? (
        <div className="u-panel-hd">
          <b>{title}</b>
          {note != null ? <span className="n">{note}</span> : null}
          {right ? <span className="sp">{right}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}

export function TwoCol({ children }: { children: ReactNode }) {
  return <div className="u-2col">{children}</div>
}
