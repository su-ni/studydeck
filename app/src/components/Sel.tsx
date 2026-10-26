import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'

/* 全站下拉：点开是自绘弹层，不再用操作系统画的那个原生列表。
   原生 <select> 展开后的 option 行距、高亮、圆角 CSS 都管不着，
   深色界面上就是一团黑（用户截图骂过的那个）。
   触发器沿用旧 select.inp-mn 的外观，弹层跟页面同一个色板。 */

export type SelOpt = {
  value: string
  label: ReactNode
  note?: ReactNode
  disabled?: boolean
}

const CHECK = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 6.4 4.8 9 10 3.2" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function Sel({ value, onChange, options, ariaLabel, style, className }: {
  value: string
  onChange: (v: string) => void
  options: SelOpt[]
  ariaLabel?: string
  style?: CSSProperties
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; w: number } | null>(null)

  const cur = options.find((o) => o.value === value)

  function place() {
    const b = btnRef.current
    if (!b) return
    const r = b.getBoundingClientRect()
    const popH = Math.min(options.length * 34 + 10, 320)
    const below = window.innerHeight - r.bottom
    const popW = Math.max(r.width, 132)
    setRect({
      // 按钮贴着右缘时弹层别伸出屏幕
      left: Math.max(8, Math.min(r.left, window.innerWidth - popW - 8)),
      top: below < popH + 8 ? Math.max(8, r.top - popH - 6) : r.bottom + 6,
      w: r.width,
    })
  }

  function toggle() {
    if (open) { setOpen(false); return }
    place()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const off = () => setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', off)
    window.addEventListener('scroll', off, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', off)
      window.removeEventListener('scroll', off, true)
    }
  }, [open])

  if (!options.length) return null

  return (
    <>
      <button ref={btnRef} type="button"
        className={'csel' + (open ? ' open' : '') + (className ? ' ' + className : '')}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        style={style} onClick={toggle}>
        <span className="t">{cur ? cur.label : '—'}</span>
        <i className="arw" aria-hidden="true" />
      </button>
      {open && rect ? createPortal(
        <div ref={popRef} className="csel-pop" role="listbox" aria-label={ariaLabel}
          style={{ left: rect.left, top: rect.top, minWidth: Math.max(rect.w, 132) }}>
          {options.map((o) => {
            const on = o.value === value
            return (
              <button key={o.value} type="button" role="option" aria-selected={on}
                disabled={o.disabled}
                className={'csel-opt' + (on ? ' on' : '') + (o.disabled ? ' dis' : '')}
                title={typeof o.label === 'string' ? o.label : undefined}
                onClick={() => { if (o.disabled) return; if (!on) onChange(o.value); setOpen(false) }}>
                <span className="ck">{on ? CHECK : null}</span>
                <span className="lb">{o.label}</span>
                {o.note != null && o.note !== '' ? <span className="nt">{o.note}</span> : null}
              </button>
            )
          })}
        </div>,
        document.body
      ) : null}
    </>
  )
}
