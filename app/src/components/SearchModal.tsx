import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { callTool } from '../lib/api'

/* Ctrl+F 唤起的搜索弹窗。
   它做两件事，且只有这两件：
     1) 居中浮在当前页面上方，不换页 —— 你正在看视频/背单词，按下 Ctrl+F
        只是想问一句，页面不该当场被换掉。
     2) 回车之后**先放回搜索的那一刻**：盒子平移形变到顶栏那只搜索框的位置，
        动画走完才真正切到搜索页。少了这段中间动作，画面会「啪」地一下重排，
        人看不出刚才那个框去哪了。

   动画怎么做：不用 FLIP 库。量的方法是 mount 后读一次目标位置（顶栏那个框的
   getBoundingClientRect），把 CSS 变量写进节点，然后让它从「居中」过渡到
   「目标的 left/top/width」。目标框是 Shell 里的 .srchbox，全局唯一。 */

type Rect = { x: number; y: number; w: number }

/* 动画时长ikit取motion.css的档位（--t4 320ms 是「整块内容进场」那一档）。
   这里不用 var() 是为了能精确 await —— CSS 变量读出来是字符串，不好算。 */
const FLY_MS = 320

export function SearchModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (q: string) => void
}) {
  const boxRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [v, setV] = useState('')
  /* phase: in = 居中显示；fly = 正在飞向顶栏；gone = 飞完（此时交给父级切页）。 */
  const [phase, setPhase] = useState<'in' | 'fly'>('in')
  const [to, setTo] = useState<Rect | null>(null)
  const timer = useRef<number | null>(null)

  /* ---------- 实时搜索 ----------
     边打边出结果，不用等回车。回车只是「把它交给搜索页」的意思，
     不是「开始搜索」的意思 —— 用户说的是「回车之前它也需要先搜索」。

     三道实用的闸，缺一个都会出问题：
     1) 防抖 220ms：每敲一个字就发一次请求，中文输入法下会在拼写阶段
        连续触发好几轮（内容还不完整），既费算力又闪。
     2) 序号比对：先发的请求可能后回，用 seq 只认最新那一次，
        否则「打一半的结果」会盖掉「打完的结果」。
     3) 空词直接清空，不发请求。 */
  const [hits, setHits] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const word = v.trim()
    if (!word) {
      seq.current++            // 让在途请求作废
      setHits([]); setBusy(false)
      return
    }
    const my = ++seq.current
    setBusy(true)
    const t = window.setTimeout(() => {
      callTool<any>('search_global', { q: word, limit: 6 })
        .then((r) => {
          if (my !== seq.current) return       // 过期结果丢弃
          const d = r?.data || {}
          const flat: any[] = []
          for (const g of d.groups || []) for (const it of g.items || []) flat.push(it)
          setHits(flat.slice(0, 8))
        })
        .catch(() => { if (my === seq.current) setHits([]) })
        .finally(() => { if (my === seq.current) setBusy(false) })
    }, 220)
    return () => window.clearTimeout(t)
  }, [v])

  useEffect(() => {
    inputRef.current?.focus()
    return () => { if (timer.current) window.clearTimeout(timer.current) }
  }, [])

  /* Esc 关：不改字、不跳页。点遮罩同理。
     为什么不在 Esc 时清空：清掉用户刚打的一半等于惩罚误触。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const flyThen = (fn: () => void) => {
    /* 量目标：顶栏那只搜索框。它可能被 CSS 隐藏了（画布页没有顶栏搜索框），
       那种情况下不过渡，直接切页 —— 没有目的地就别假装飞过去。 */
    const target = document.querySelector('.top .srchbox') as HTMLElement | null
    const self = boxRef.current
    if (!target || !self) { fn(); return }
    const tr = target.getBoundingClientRect()
    const sr = self.getBoundingClientRect()
    /* 位移要算「盒子中心 → 目标中心」，不是「左上角 → 左上角」。
       为什么：飞行途中同时改了 width（560 → 420），盒子是从**中心**缩的，
       如果按左上角算 delta，缩窄的那一半会额外把盒子往右推 ——
       实测中心从 828 漂到 896，落点整整偏右 68px。
       按中心对齐，宽度变化就不参与位置计算了：
         dx = 目标中心 - 自身中心
       左边界的变化由 width 过渡自己完成。 */
    const dx = (tr.left + tr.width / 2) - (sr.left + sr.width / 2)
    const dy = (tr.top + tr.height / 2) - (sr.top + sr.height / 2)
    setTo({ x: dx, y: dy, w: tr.width })
    setPhase('fly')
    timer.current = window.setTimeout(fn, FLY_MS)
  }

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const w = v.trim()
    if (!w) { inputRef.current?.focus(); return }
    flyThen(() => onSubmit(w))
  }

  const flying = phase === 'fly'

  return (
    <div className={'smask' + (flying ? ' fly' : '')} onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <div className="swrap">
        <form
          ref={boxRef}
          className={'sbox' + (flying ? ' flying' : '')}
          onSubmit={submit}
          style={flying && to
            ? { transform: 'translate(' + to.x + 'px,' + to.y + 'px)', width: to.w + 'px' }
            : undefined}
        >
          <Icon n="search" size={16} />
          <input
            ref={inputRef}
            value={v}
            placeholder="搜课件、题、考点、设置、文件里的字…"
            aria-label="全局搜索"
            onChange={(e) => setV(e.target.value)}
          />
          {v ? (
            <button type="button" className="sbox-x" aria-label="清空" onClick={() => { setV(''); inputRef.current?.focus() }}>
              <Icon n="x" size={13} />
            </button>
          ) : null}
          <span className="sbox-hint">回车进搜索页</span>
        </form>

        {/* ---------- 实时结果 ----------
            回车之前就能看见搜到了什么。飞行时整块一起淡出，
            不然它会跟着盒子一起飞、缩成一条。 */}
        {v.trim() && !flying ? (
          <div className="sres">
            {busy && !hits.length ? <div className="sres-empty">搜着…</div> : null}
            {!busy && !hits.length ? <div className="sres-empty">没搜到，回车进搜索页看完整结果</div> : null}
            {hits.map((h, i) => (
              <button key={i} className="sres-item"
                onMouseDown={(e) => { e.preventDefault(); flyThen(() => onSubmit(v.trim())) }}>
                <span className="sres-kind">{h.kind}</span>
                <span className="sres-t">{h.title || '（无标题）'}</span>
                {h.score != null ? <span className="sres-sc">{h.score.toFixed(2)}</span> : null}
              </button>
            ))}
            {hits.length ? (
              <div className="sres-foot">共 {hits.length} 条预览 · 回车看全部</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
