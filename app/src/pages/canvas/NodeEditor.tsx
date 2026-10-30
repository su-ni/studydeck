import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { MENU_COLORS } from './ContextMenu'
import { Markdown } from './md'

/* ── 画布节点的「原地编辑」与「悬停工具条」 ─────────────────────────────
   以前双击节点弹的是 window.prompt：字一长就看不清、没法换行、还没法边看边改。
   这里换成真的 textarea，位置就在节点上。

   几条硬约束（改之前先读）：
   1) 尺寸必须和节点一致。ReactFlow 给节点的 width 是写死的 190（Canvas.tsx 里
      nodes 的 useMemo），所以编辑器盒子不能在「编辑中」变宽 —— 一变宽就把连线和
      布局的锚点都带偏。做法是：textarea 用 position:absolute 撑满节点盒，
      但整体只允许往上长（有备注角标时让它避让），不往右长。
   2) 正在编辑的节点要锁定 190 宽。宽度靠 ch 估出来，估出来的是「内容需要多宽」，
      而 ReactFlow 的框是固定的 190；两者不一致就会出现文字跑到框外面。
      所以编辑中一律按 190 算（isEditing 分支）。
   3) 键盘归属要抢在 Canvas 的全局 window keydown 之前：那个监听器碰到
      input/textarea 会 return，但它看的是事件冒泡到 window 时的 target ——
      我们是真 textarea，所以它自己就放行了。这里只需要 stopPropagation
      处理 Esc（免得画布顺手把选中清掉）。
   4) 这里不碰树、不碰撤销栈：所有写操作都通过 onEdit/onAddChild/… 回调，
      Canvas 那边统一走 edit(id, patch) / push(next)，撤销栈不会被绕过。 */

// 与 .cvnode 的字号/行高对齐（app.css: .cvnode 13px，.cvnode.d0 14.5px）
export function nodeFont(depth: number) {
  return depth <= 0 ? 14.5 : 13
}
const LINE = 1.3
const PAD_X = 12
const MINW = 190
const MAXW = 360
const H = 46

/* 宽度自适应：把最长那一行按字宽估出来。
   CJK 按 1em、其余按 0.56em —— 不引第三方库，估宽差一点也只是换行位置差一点，
   反正外层由 CSS 的 max-width 兜住。 */
export function measureW(text: string, depth = 1) {
  const fs = nodeFont(depth)
  const lines = String(text || '').split('\n')
  let w = 0
  for (const line of lines) {
    let px = 0
    for (const ch of line) {
      const c = ch.codePointAt(0) || 0
      // 全角 / 中文 / 全角标点按一个字号宽，其余按 0.56
      px += c > 0x2e80 ? fs : fs * 0.56
    }
    w = Math.max(w, px)
  }
  return Math.min(MAXW, Math.max(MINW, Math.round(w + PAD_X * 2)))
}

export type NodeEditorProps = {
  text: string
  depth: number
  hasNote: boolean
  onCommit: (text: string) => void
  onCancel: () => void
}

/* 原地编辑器。挂载即聚焦并全选（双击的语义是「改这句话」），
   Enter 提交并退出、Shift+Enter 换行、Esc 放弃、失焦提交。
   失焦提交 + Esc 放弃会打架：Esc 时 textarea 会先 blur 再 keydown，
   所以用 done 这个 ref 把「已经结束过」记住，避免放弃之后又被失焦存一遍。 */
export function NodeEditor({ text, depth, hasNote, onCommit, onCancel, onLive }: NodeEditorProps & { onLive?: (v: string) => void }) {
  const [v, setV] = useState(text)
  const ta = useRef<HTMLTextAreaElement | null>(null)
  const done = useRef(false)
  /* 边打字边落库。
     以前只有 Enter / 失焦 / Ctrl+Enter 才提交 —— 于是「自动保存」在这个框里
     根本不存在：写一半切走或崩一下，字就没了，顶栏还一直显示「已存本机」，
     等于在骗人。这里每敲一下就把最新值往上抛，由画布那边的 900ms 防抖接住写盘。
     注意区分两个动作：onLive 是「同步显示中的值」，onCommit 是「结束编辑」,
     只有后者会关掉编辑框、动撤销栈。 */
  const live = useRef(onLive)
  live.current = onLive
  const tRef = useRef<number>(0)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.focus()
    el.select()
    // 光标放到末尾更符合「接着写」的直觉；全选留给用户直接覆盖
    autoGrow(el)
    return () => clearTimeout(tRef.current)
  }, [])

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    const h = Math.max(H - 16, Math.min(240, el.scrollHeight))
    el.style.height = Math.round(h) + 'px'
  }

  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onCommit(v)
    else onCancel()
  }

  const top = hasNote ? -34 : -8
  return (
    <div className="cvedit" data-node-edit="1" style={{ top, width: MINW }} data-depth={depth}>
      <textarea
        ref={ta}
        className="cvedit-ta"
        value={v}
        spellCheck={false}
        style={{ fontSize: nodeFont(depth), lineHeight: LINE }}
        onChange={(e) => {
          const nv = e.target.value
          setV(nv); autoGrow(e.target)
          // 防抖 400ms：比画布写盘那道 900ms 短，让它先落到 tree 上，再由画布存盘
          clearTimeout(tRef.current)
          tRef.current = window.setTimeout(() => live.current?.(nv), 400)
        }}
        onKeyDown={(e) => {
          // 画布自己有一堆全局快捷键（Enter 加同级、Tab 加子节点、Esc 清选择），
          // 编辑时必须先吃掉，否则打字就是在建节点。
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); finish(false); return }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); return }
          // Shift+Enter 要换行：这里**不能** preventDefault —— 按下的默认行为才是插入换行，
          // 拦掉它这个键就等于没按（实测多行代码块 / 表格全被挤成一行，根因就在这一句）。
          if (e.key === 'Enter' && e.shiftKey) return
        }}
        onBlur={() => finish(true)}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder="写点什么"
      />
      <div className="cvedit-hint">
        <span>Enter 保存 · Shift+Enter 换行 · Esc 放弃</span>
      </div>
    </div>
  )
}

export type NodeToolsProps = {
  id: string
  isRoot: boolean
  folded: boolean
  kids: number
  col?: string
  /** 当前展开的浮层。同一时刻只许开一个，所以「开哪个」由画布持着传下来。 */
  pop?: 'color' | null
  onAddChild: (id: string) => void
  onAddSibling: (id: string) => void
  onToggleFold: (id: string) => void
  onColor: (id: string) => void
  onPickColor: (id: string, col: string) => void
  onClosePop: () => void
  onDelete: (id: string) => void
  onNote: (id: string) => void
}

/* ── 跟手的浮动工具条 ─────────────────────────────────────────────────
   多选时**不能**每个节点底下挂一条：三个节点就是三条一模一样的工具条，
   挂着的东西（加子节点/加同级）还没有唯一对象 —— 点了不知道往哪儿加。
   XMind 的做法是「跟着鼠标走一条」，所以这里做一条跟手的工具条：
   pointermove 捕获阶段读坐标，贴在指针右下 16/18px，边界内自动翻转。

   三条硬约束：
   1) 鼠标移到工具条自己上面时**不许再跟** —— 否则它追着指针跑，永远点不到。
      用 contains(e.target) 判掉。
   2) 节点上那条工具条在多选时必须让位（NodeTools 收到 multi 就整体不渲染）。
   3) 位置用的坐标是「相对舞台」，所以 host 必须是 .cvstage（它会跟着画布
      缩放/平移一起动，不能拿 clientX 直接往 fixed 上贴）。 */
export function FloatTools({ ids, hostRef, col, onAddChild, onAddSibling, onToggleFold,
  onColor, onPickColor, onClosePop, onDelete, onNote, pop }: {
  ids: string[]
  hostRef: React.RefObject<HTMLElement | null>
  col?: string
  pop?: 'color' | null
  onAddChild: () => void
  onAddSibling: () => void
  onToggleFold: () => void
  onColor: () => void
  onPickColor: (c: string) => void
  onClosePop: () => void
  onDelete: () => void
  onNote: () => void
}) {
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const many = ids.length > 1

  /* 一上来就得有位置：多选往往停在框选那一下，手再没动过 ——
     只靠 pointermove 给坐标的话，工具条要到下一次动鼠标才出现，
     人会以为「点了没反应」。所以先兜一个「选中那一堆的右下角」。
     坐标系一律相对 host（.cvstage）：跟着画布缩放/平移走，别拿 clientX 直接贴。 */
  const anchor = () => {
    const host = hostRef.current
    if (!host) return null
    const hr = host.getBoundingClientRect()
    let maxX = 0, maxY = 0, seen = 0
    ids.forEach((id) => {
      const el = host.querySelector(`[data-id="${id}"]`) as HTMLElement | null
      if (!el) return
      const r = el.getBoundingClientRect()
      maxX = Math.max(maxX, r.right - hr.left)
      maxY = Math.max(maxY, r.bottom - hr.top)
      seen++
    })
    if (!seen) return null
    return { x: Math.min(hr.width - 8, maxX + 8), y: Math.max(8, Math.min(hr.height - 40, maxY + 10)) }
  }

  useEffect(() => {
    if (!ids.length) { setPt(null); return }
    const a = anchor()
    if (a) setPt(a)
    const move = (e: PointerEvent) => {
      // 指针已经在工具条上了就别再跟，不然按钮永远追不上鼠标
      if (box.current && box.current.contains(e.target as Node)) return
      const host = hostRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      let x = e.clientX - r.left + 16
      let y = e.clientY - r.top + 18
      const bw = box.current?.offsetWidth || 190
      const bh = box.current?.offsetHeight || 30
      if (x + bw > r.width - 8) x = Math.max(8, e.clientX - r.left - bw - 16)
      if (y + bh > r.height - 8) y = Math.max(8, e.clientY - r.top - bh - 18)
      setPt({ x, y })
    }
    // 捕获阶段：节点上 stopPropagation 的那些鼠标事件（拖拽用）挡不住它
    window.addEventListener('pointermove', move, true)
    return () => window.removeEventListener('pointermove', move, true)
  }, [ids.join('|'), hostRef]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ids.length || !pt) return null
  const stop = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault() }
  return (
    <div className="cvntool float" ref={box} style={{ left: pt.x, top: pt.y }}
      onMouseDown={stop} onClick={stop} onDoubleClick={stop} onWheel={(e) => e.stopPropagation()}>
      {many ? <span className="cvntool-n">{ids.length}</span> : null}
      {/* 多选时「加子节点 / 加同级」没有唯一对象：选了 5 个往哪儿加？
          这两个按钮这时候是骗人的，所以直接不摆。 */}
      {many ? null : <button title="加子节点（Tab）" onClick={onAddChild}><Icon n="plus" size={14} /></button>}
      {many ? null : <button title="加同级（Enter）" onClick={onAddSibling}><Icon n="node" size={14} /></button>}
      <button title={many ? '批量折叠' : '折叠分支'} onClick={onToggleFold}><Icon n="chev" size={14} /></button>
      {many ? null : <button title="备注" onClick={onNote}><Icon n="md" size={14} /></button>}
      <span className="cvntool-wrap">
        <button className={'tool-color' + (pop === 'color' ? ' on' : '')} title="上色" onClick={onColor}>
          <Icon n="tag" size={14} />
          {col ? <i className="cvntool-dot" style={{ background: col }} /> : null}
        </button>
        {pop === 'color' ? (
          <ColorPop cur={col} onPick={(c) => onPickColor(c)} onClose={onClosePop} />
        ) : null}
      </span>
      <button className="danger" title="删除（Del）" onClick={onDelete}><Icon n="trash" size={14} /></button>
      <span className="cvdiv" />
      <button title="取消选择（Esc）" onClick={() => ids.length && onClosePop()}>
        <Icon n="x" size={14} />
      </button>
    </div>
  )
}

/* 上色小色板：一行色块 + 清除。色值直接读 MENU_COLORS —— 和右键菜单同一份来源，
   不在节点里另开一份色表（同一动作两套色板，改一处忘一处）。
   Esc / 点外面 / 选完就关。点外面用 window 的捕获阶段 pointerdown 判：
   浮层是被「上色」按钮那一次 click 打开的，同一个事件冒泡到 window 会立刻把它关掉，
   所以监听延后一帧再挂。 */
export function ColorPop({ cur, onPick, onClose }: {
  cur?: string
  onPick: (col: string) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose() }
    }
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0)
    window.addEventListener('keydown', key, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])

  return (
    <div className="cvcolorpop" ref={box}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {MENU_COLORS.map((c) => (
        <button key={c.v} title={c.name} className={'cvcolorpop-sw' + (cur === c.v ? ' on' : '')}
          style={{ background: c.v }} onClick={() => { onPick(c.v); onClose() }} />
      ))}
      <span className="cvcolorpop-div" />
      <button title="清除颜色" className={'cvcolorpop-sw none' + (!cur ? ' on' : '')}
        onClick={() => { onPick(''); onClose() }}><Icon n="x" size={11} /></button>
    </div>
  )
}

/* 悬停工具条：绝对定位在节点下方，只在 hover 或选中时出现（CSS 控制显隐，
   不用 JS 存 hover 态 —— 每个节点一份 state 会在拖拽时疯狂重渲染）。

   ⚠ 多选时**整条不渲染**（multi=true）：五个节点底下挂五条一模一样的工具条
   是错的，而且「加子节点」这时候没有唯一对象 —— 点了不知道往哪儿加。
   多选改由 FloatTools 那条跟手的来管，位置在鼠标上。 */
export function NodeTools({ multi, ...p }: NodeToolsProps & { multi?: boolean }) {
  const { id, isRoot, folded, kids, col, pop } = p
  const stop = (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault() }
  if (multi) return null
  return (
    <div className="cvntool" onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
      <button title="加子节点（Tab）" onClick={() => p.onAddChild(id)}><Icon n="plus" size={14} /></button>
      <button title="加同级（Enter）" disabled={isRoot} onClick={() => p.onAddSibling(id)}><Icon n="node" size={14} /></button>
      <button className={kids ? '' : 'dim'} title={kids ? (folded ? '展开分支' : '折叠分支') : '还没有子节点'} disabled={!kids}
        onClick={() => p.onToggleFold(id)}><Icon n={folded ? 'down' : 'chev'} size={14} /></button>
      <button title="备注" onClick={() => p.onNote(id)}><Icon n="md" size={14} /></button>
      <span className="cvntool-wrap">
        <button className={'tool-color' + (pop === 'color' ? ' on' : '')} title="上色" onClick={() => p.onColor(id)}>
          <Icon n="tag" size={14} />
          {col ? <i className="cvntool-dot" style={{ background: col }} /> : null}
        </button>
        {pop === 'color' ? (
          <ColorPop cur={col} onPick={(c) => p.onPickColor(id, c)} onClose={p.onClosePop} />
        ) : null}
      </span>
      <button className="danger" title="删除（Del）" disabled={isRoot} onClick={() => p.onDelete(id)}><Icon n="trash" size={14} /></button>
    </div>
  )
}

/* 备注角标：有 note 的节点在右上角挂一个小角，悬停出气泡。
   气泡用 CSS 的 ::after 太窄（多行备注放不下），这里直接渲染一个 div，
   默认 display:none，hover/focus 时显示 —— 不占 ReactFlow 的布局。 */
export function NoteBadge({ note }: { note?: string }) {
  if (!note || !note.trim()) return null
  const body = String(note).trim()
  return (
    <span className="cvnotebadge" tabIndex={0}>
      <Icon n="md" size={11} />
      <span className="cvnotebadge-pop" role="tooltip"><Markdown text={body} /></span>
    </span>
  )
}

/* 空节点的统一占位（任务要求：空内容视为「（空节点）」，保存但显示占位） */
export const EMPTY_TEXT = '（空节点）'
export function shownText(t?: string) {
  const s = String(t ?? '')
  return s.trim() ? s : EMPTY_TEXT
}

/* 备注的浮动编辑条：挂在节点下方，不挂右栏。
   双击/悬停时视线就在节点上，跑到右栏改备注是断的 —— 所以就地开一条。
   Ctrl/Cmd+Enter 保存，Esc 收起。失焦不自动提交：备注比标题长，误点一下
   就存会很难受，所以只认显式保存。 */
export function NoteFloat({ note, onSave, onClose, nodeId }: {
  note?: string; onSave: (v: string) => void; onClose: () => void; nodeId?: string
}) {
  const [v, setV] = useState(note || '')
  const ta = useRef<HTMLTextAreaElement | null>(null)
  const done = useRef(false)
  /* 挂左边还是右边：默认右边，右边放不下就翻到左边。
     判定用自己这个浮层在视口里的矩形 —— 不去算 ReactFlow 的变换矩阵，
     那个会跟着缩放/平移变，越算越容易错。
     ⚠ 为什么不再挂节点正下方：那儿是 NodeTools（悬停工具条）的位置，
     浮层一出来就被那排按钮盖住，人看不见自己正在写的备注。 */
  const [side, setSide] = useState<'r' | 'l'>('r')
  const box = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => { ta.current?.focus() }, [])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // 右边越界就翻左边；左边也放不下就维持右边（至少不会跑到屏幕外看不见）
    if (r.right > window.innerWidth - 8 && r.left - r.width - 20 > 8) setSide('l')
  }, [])

  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onSave(v)
    else onClose()
  }

  return (
    <div className={'cvnotefloat side-' + side} ref={box}
      /* data-note-for：画布页靠它 getBoundingClientRect() 测量浮层矩形，
         好让被挡住的节点避让（见 Canvas.tsx 的避让逻辑）。必须有、且是节点 id。 */
      data-note-float="1" data-note-for={nodeId || ''}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <textarea ref={ta} className="cvedit-ta" rows={3} value={v} spellCheck={false}
        placeholder="这个节点的备注（支持 Markdown）"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); finish(false) }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true) }
        }} />
      <div className="cvedit-hint">
        <button className="cvedit-ok" onClick={() => finish(true)}><Icon n="check" size={12} />保存</button>
        <button className="cvedit-no" onClick={() => finish(false)}><Icon n="x" size={12} />收起</button>
        <span>Ctrl+Enter 快存</span>
      </div>
    </div>
  )
}

/* 右栏检查器里的备注入口：保留（两条路都能进），但它不再自己持有一份
   textarea —— 点一下直接把节点下方的浮动条打开，避免两处同时编辑同一条备注。 */
export function NoteEntry({ note, onOpen }: { note?: string; onOpen: () => void }) {
  return (
    <div className="cvinsp-bt">
      <span className="cvedit-cur">{note ? brief(note, 40) : '还没有备注'}</span>
      <button onClick={onOpen}><Icon n="md" size={14} />{note ? '改备注' : '加备注'}</button>
    </div>
  )
}

function brief(s: string, n: number) {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}
