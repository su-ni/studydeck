import { useEffect, useRef, useState } from 'react'

/* 权限档：写盘这件事要不要人点一下。
 *
 * 这是人按的开关，不是模型能调的 —— 它没有对应的工具，只走 /api/perm。
 * 三档对应市面 agent 软件的通用做法：
 *   只看不改  写操作全挡
 *   先问我    写操作弹确认卡（默认）
 *   完全信任  直接落盘，事后在轨迹里留痕
 */

type M = { id: string; why: string }

const SHORT: Record<string, string> = {
  readonly: '只看不改',
  ask: '先问我',
  auto: '完全信任',
}

export function PermPicker({ disabled }: { disabled?: boolean }) {
  const [mode, setMode] = useState('ask')
  const [modes, setModes] = useState<M[]>([])
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  async function load() {
    try {
      const r = await fetch('/api/perm').then((x) => x.json())
      if (r && r.ok) { setMode(r.mode); setModes(r.modes || []) }
    } catch { /* 服务没起就不画 */ }
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
    if (disabled) return
    setErr('')
    try {
      const r = await fetch('/api/perm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: k }),
      }).then((x) => x.json())
      if (r.ok) setMode(r.mode)
      else setErr(r.error || '没换成')
    } catch (e) { setErr(String(e)) }
  }

  const why = modes.find((x) => x.id === mode)?.why || ''

  return (
    <div className="eff" ref={boxRef}>
      <button
        className={'eff-b perm-b' + (mode === 'auto' ? ' on warn' : mode === 'readonly' ? ' on dim' : '')}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={'它能改本机吗：' + (why || mode)}
      >
        {SHORT[mode] || mode}
      </button>
      {open && (
        <div className="eff-tip perm-tip">
          <b>它能改本机吗</b>
          {modes.map((m) => (
            <button
              key={m.id}
              className={'perm-o' + (m.id === mode ? ' on' : '')}
              onClick={() => pick(m.id)}
            >
              <i>{SHORT[m.id] || m.id}</i>
              <em>{m.why}</em>
            </button>
          ))}
          {err && <div className="perm-err">{err}</div>}
          <div className="perm-foot">这个开关只有你能按，助手自己改不了。</div>
        </div>
      )}
    </div>
  )
}
