import { useEffect, useMemo, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { Icon } from './Icon'

type M = { id: string; name?: string; ctx?: number; function?: string }
type Prov = {
  provider: string
  name: string
  configured: boolean
  usable: boolean
  why?: string
  account?: string
  expires_text?: string
  model?: string
  selected?: boolean
}
type Pay = { current: string; current_name: string; model: string; providers: Prov[] }

type Group = { provider: string; name: string; account?: string; cur: string; models: M[] | null; err: string; note?: string }

/**
 * 模型选择器 —— 一个列表打通所有平台，点哪个模型就用哪个。
 *
 * 我先前做错了两件事，用户逐条指出来了：
 *   ① 只列「当前这一家平台」的模型，想用别家得先按另一个独立按钮切平台；
 *   ② 顶栏还挂着个平台徽标，等于把「换平台」和「换模型」拆成两处。
 * 实际这些 agent 软件都是**一个列表打通所有平台**：按平台分组，组头写平台名，
 * 组内是那家真能用的模型，点哪个就直接切过去（provider + model 一起写）。
 *
 * 所以这里：打开时并行问每一家的目录（ai_models 不编模型名，列不出来就说明原因），
 * 按平台分组渲染，点任意一个就 ai_use({provider, model})。
 */
export function ModelPicker() {
  const [p, setP] = useState<Pay | null>(null)
  const [gs, setGs] = useState<Group[] | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const inp = useRef<HTMLInputElement>(null)

  const loadProv = () => callTool('ai_providers').then((r) => { if (r.ok) setP(r.data as any) })

  // 并行问每一家的模型目录。哪家不可用就不问（问了也是空，还白等一次网络）。
  function loadAll() {
    setGs(null)
    callTool('ai_providers').then((r) => {
      const d: any = r.data || {}
      const provs: Prov[] = d.providers || []
      setP(d)
      const usable = provs.filter((x) => x.usable)
      if (!usable.length) { setGs([]); return }
      setGs(usable.map((x) => ({ provider: x.provider, name: x.name, account: x.account, cur: x.model || '', models: null, err: '', note: '' })))
      usable.forEach((x) => {
        callTool('ai_models', { provider: x.provider }).then((rr) => {
          const dd: any = rr.data || {}
          const list: M[] = dd.models || []
          setGs((prev) => (prev || []).map((g) => g.provider !== x.provider ? g
            : { ...g, models: list, cur: dd.current || g.cur, note: dd.note || '', err: list.length ? '' : (dd.error || dd.note || rr.error || '这家列不出模型') }))
        })
      })
    })
  }

  useEffect(() => { loadProv() }, [])
  useEffect(() => { if (open) { loadAll(); setTimeout(() => inp.current?.focus(), 30) } }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])

  const cur = (p?.providers || []).find((x) => x.provider === p?.current)
  const usable = !!(cur && cur.usable)
  const label = !p ? '读模型…' : !cur ? '没接模型' : usable ? (p?.model || '未选模型') : '模型不可用'

  // 搜索时跨平台一起筛，只保留命中的组
  const view = useMemo(() => {
    const all = gs || []
    const k = q.trim().toLowerCase()
    if (!k) return all
    return all.map((g) => ({
      ...g,
      models: (g.models || []).filter((m) => (m.id + ' ' + (m.name || '') + ' ' + g.name).toLowerCase().includes(k)),
    })).filter((g) => (g.models || []).length > 0)
  }, [gs, q])

  async function pick(prov: string, m: M) {
    setBusy(prov + '|' + m.id)
    /* function 必须跟模型一起存：Trae 同一个模型名配错 function 就只回空流
       （实测 deepseek-v4.1-flash 只认 solo_work_remote）。目录里每个模型都带着
       自己那个 function，选的时候顺手写进去，人不用知道有这回事。 */
    const r = await callTool('ai_use', { provider: prov, model: m.id, function: m.function, ctx: m.ctx }, { write: true })
    setBusy('')
    if (!r.ok) { loadAll(); return }
    setOpen(false)
    setQ('')
    loadProv()
    try { window.dispatchEvent(new Event('sd:model')) } catch {}
  }

  const total = (gs || []).reduce((n, g) => n + (g.models || []).length, 0)

  return (
    <div className="mp" ref={box}>
      <button className={'mp-btn' + (usable ? '' : ' off')} onClick={() => setOpen((v) => !v)}
        title={usable ? `${cur?.name || ''} · ${label} —— 点一下换模型` : (cur?.why || '这家没登录，模型用不了')}
        disabled={!p}>
        <span className="mp-dot" />
        <span className="mp-name">{label}</span>
        <Icon n="chev" size={12} />
      </button>

      {open && (
        <div className="mp-pop" role="dialog">
          <div className="mp-hd">
            <div className="mp-hd-t">
              <b>用哪个模型</b>
              {/* 目录会变（平台上下架模型），给一个显式重拉入口 —— 不用等它自己失效才发现 */}
              <button className="mp-rf" onClick={loadAll} disabled={gs === null}
                title="重新问各家的目录，看现在真有哪些模型">
                <Icon n="refresh" size={12} {...(gs === null ? { className: 'spin' } : {})} />
                {gs === null ? '读目录…' : '重新拉取'}
              </button>
            </div>
            <span>{gs === null ? '正在问各家目录…' : `${(gs || []).length} 个平台 · 共 ${total} 个模型，点哪个用哪个`}</span>
          </div>
          <div className="mp-sch">
            <Icon n="search" size={14} />
            <input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜模型或平台，例如 deepseek / glm / doubao" />
            {q ? <button className="mp-x" aria-label="清掉" onClick={() => setQ('')}>×</button> : null}
          </div>

          <div className="mp-list">
            {gs === null && <div className="mp-empty">正在问各家目录…</div>}
            {gs !== null && !gs.length && (
              <div className="mp-empty">
                一家都没配。
                {/* 以前这里只有一行字让人「去设置」，却没有按钮 —— 没配过的人
                    在模型面板里根本走不到设置。 */}
                <button className="mp-go"
                  onClick={() => { setOpen(false); location.hash = 'agent' }}>
                  去设置里填 API / 登录
                </button>
              </div>
            )}
            {gs !== null && !!gs.length && !view.length && <div className="mp-empty">{q ? `没搜到「${q}」` : '这些平台一个模型都没列出来'}</div>}
            {view.map((g) => (
              <div className="mp-grp" key={g.provider}>
                <div className="mp-gh">
                  <b>{g.name}</b>
                  {g.account ? <span className="mp-ga">{g.account}</span> : null}
                  <span className="mp-gn">{g.models === null ? '读…' : (g.models.length || 0) + ' 个'}</span>
                </div>
                {g.models === null && <div className="mp-empty sm">正在问 {g.name} 的目录…</div>}
                {g.note ? <div className="mp-empty sm" style={{ color: 'var(--ok, #4a8)' }}>{g.note}</div> : null}
                {g.models !== null && !g.models.length && <div className="mp-empty sm">{g.err || '这家列不出模型'}</div>}
                {(g.models || []).map((m) => {
                  const on = !!p && p.current === g.provider && m.id === (g.cur || p.model)
                  return (
                    <button key={g.provider + '|' + m.id} className={'mp-it' + (on ? ' on' : '')}
                      onClick={() => pick(g.provider, m)} disabled={!!busy || on}>
                      <span className="mp-it-n">{m.name || m.id}</span>
                      <span className="mp-it-m">{m.id}</span>
                      {m.ctx ? <span className="mp-it-c">{(m.ctx / 1000).toFixed(0)}k</span> : null}
                      {on ? <span className="mp-it-on">在用</span> : busy === g.provider + '|' + m.id ? <span className="mp-it-on">切换中…</span> : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="mp-ft">点哪个模型就用哪个，平台跟着一起切。讲题、作文批改、接手规划都用这个。</div>
        </div>
      )}
    </div>
  )
}
