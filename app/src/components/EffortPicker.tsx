import { useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { Icon } from './Icon'

/* 回答要多细（low / medium / high）。
 *
 * 为什么不叫「思考强度」：实测这一家上游的 reasoning_effort 字段对思考量没有可辨影响
 * （low 6326 字 vs high 6311 字，区间重叠），真正改变回答的是提示词档位 ——
 * low 只给结论（实测 146 字），high 先逐条分析（实测 879 字）。
 * 所以按钮上写「简要 / 标准 / 详细」，跟它实际干的事对得上。
 */

type Lv = { k: string; why: string; on: boolean }

const SHORT: Record<string, string> = { low: '简要', medium: '标准', high: '详细' }

export function EffortPicker({ disabled }: { disabled?: boolean }) {
  const [cur, setCur] = useState('medium')
  const [levels, setLevels] = useState<Lv[]>([])
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  async function load() {
    const r = await callTool<{ current: string; levels: Lv[]; note?: string }>('agent_effort', {})
    if (r.ok && r.data) {
      setCur(r.data.current || 'medium')
      setLevels(r.data.levels || [])
      setNote(r.data.note || '')
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function pick(k: string) {
    if (k === cur || disabled) return
    setCur(k)
    const r = await callTool<{ ok: boolean; current: string }>(
      'agent_effort', { level: k }, { write: true })
    if (r.ok && r.data) setCur(r.data.current)
  }

  const why = levels.find((x) => x.k === cur)?.why || ''

  return (
    <div className="eff" ref={boxRef}>
      {['low', 'medium', 'high'].map((k) => (
        <button
          key={k}
          className={'eff-b' + (k === cur ? ' on' : '')}
          onClick={() => pick(k)}
          disabled={disabled}
          title={levels.find((x) => x.k === k)?.why || ''}
        >
          {SHORT[k]}
        </button>
      ))}
      <button
        className="eff-q"
        onClick={() => setOpen((v) => !v)}
        title={'回答要多细：' + (why || cur)}
        style={{
          width: 20, height: 22, border: 'none', background: 'none',
          color: 'var(--tx3)', cursor: 'pointer', fontSize: 12, padding: 0,
        }}
      >
        ?
      </button>
      {open && (
        <div className="eff-tip">
          <b>回答要多细</b>
          {levels.map((x) => (
            <div key={x.k} style={{ marginTop: 4 }}>
              <span style={{ color: x.on ? 'var(--act)' : 'var(--tx)' }}>
                {SHORT[x.k] || x.k}
              </span>
              {' — '}
              {x.why}
            </div>
          ))}
          {note && <em>{note}</em>}
        </div>
      )}
    </div>
  )
}
