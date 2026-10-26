import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'

/* ══════════════════════════════════════════════════════════════
   画布右键菜单
   设计口径跟主流思维导图软件对等：
     - 节点上右键 → 单节点菜单（改字 / 加子 / 加同级 / 排序 / 上色 / 折叠 / 复制粘贴 / 只留这枝 / 删）
     - 选中多个时右键 → 批量菜单（批量上色 / 批量折叠 / 批量删除 / 取消选择）
     - 空白处右键 → 画布级菜单（新建 / 粘贴 / 适应窗口 / 全展开 / 全折叠）
   三条硬规矩：
     1) 这个组件只负责「画菜单 + 收键」，所有树操作都通过 props 回调转给 Canvas ——
        撤销栈、防抖落库、选中态只有一个来源，不能在这儿另开一套。
     2) 位置的算法跟菜单内容无关地先跑一遍：屏幕右下角右键时向左上翻，
        翻完还越界就贴边（clamp），永远不出视口。
     3) Esc / 点空白 / 滚动（wheel、以及任何祖先容器被滚动）都关。
   ══════════════════════════════════════════════════════════════ */

export type MenuKind = 'node' | 'multi' | 'pane'
export type MenuState = { x: number; y: number; kind: MenuKind }

/* 8 色 + 清空。前 7 个是项目既有的 PALETTE（检查器色板同一套），
   第 8 个补一个偏冷的蓝紫，凑满「八色」（task 要求 8 色 + 清除）。
   注意：色板里不放空串 —— 空串单独做成「清除颜色」那一项，否则同一个
   行为会出现两个入口，用户不知道该点哪个。 */
export const MENU_COLORS: { v: string; name: string }[] = [
  { v: '#FF6B1F', name: '橙' },
  { v: '#FFB020', name: '琥珀' },
  { v: '#5FCB8A', name: '绿' },
  { v: '#7FB0F0', name: '蓝' },
  { v: '#B48BFF', name: '紫' },
  { v: '#FF6B4A', name: '红' },
  { v: '#8FD3C7', name: '青' },
  { v: '#E0B84A', name: '金' },
]

/* ── 剪贴板 ─────────────────────────────────────────────────────
   放 window 上，不放模块变量：模块变量在同一个包内确实共享，
   但页面被卸载重挂（切学科、HMR、路由重建）时模块状态谁保不准；
   window 上这一份跨原型/跨画布也能粘，符合「跨画布也能用」的要求。
   键名带版本号，将来形状变了不会读到老树。 */
const CLIP_KEY = '__sdCvClip_v1'
type Clip = { text: string; col?: string; note?: string; children?: Clip[] } | null

export function getClip(): Clip {
  try {
    const raw = (window as any)[CLIP_KEY]
    if (!raw || typeof raw !== 'object') return null
    return raw as Clip
  } catch { return null }
}
export function setClip(v: Clip) {
  try { (window as any)[CLIP_KEY] = v } catch { /* 隐私模式禁写：粘不了就粘不了，不弹窗骂人 */ }
}
export function hasClip(): boolean { return !!getClip() }

/* 深拷贝一棵子树并重发 id。id 生成器由调用方传进来（Canvas 里那个 nid），
   保证全站只有一套 id 规则。 */
export function cloneWithNewIds(n: any, nid: () => string): any {
  if (!n || typeof n !== 'object') return null
  return {
    id: nid(),
    text: String(n.text ?? ''),
    note: n.note ? String(n.note) : undefined,
    col: n.col ? String(n.col) : '',
    children: (Array.isArray(n.children) ? n.children : []).map((c: any) => cloneWithNewIds(c, nid)).filter(Boolean),
  }
}

/* ── 单项 ── */
type Item = {
  key: string
  label?: string
  hint?: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  sep?: boolean
  sw?: string          // 色块
  run?: () => void
  sub?: Item[]         // 子菜单
  keep?: boolean       // 执行后不关菜单（如展开颜色的子菜单）
}

function MenuRow({ it, onDone, openUp }: { it: Item; onDone: () => void; openUp: boolean }) {
  const [sub, setSub] = useState(false)
  const [flip, setFlip] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const subRef = useRef<HTMLDivElement | null>(null)

  // 子菜单默认往右开；右边放不下就翻到左侧（贴着本项的右边缘向左展开）。
  useLayoutEffect(() => {
    if (!sub || !subRef.current || !rowRef.current) return
    const r = rowRef.current.getBoundingClientRect()
    const s = subRef.current.getBoundingClientRect()
    setFlip(r.right + s.width > window.innerWidth - 8)
  }, [sub])

  if (it.sep) return <div className="cvmenu-sep" />

  const click = () => {
    if (it.disabled) return
    if (it.sub) { setSub((v) => !v); return }
    it.run?.()
    if (!it.keep) onDone()
  }

  return (
    <div className="cvmenu-rowwrap" ref={rowRef}
      onMouseEnter={() => { if (it.sub) setSub(true) }}
      onMouseLeave={() => { if (it.sub) setSub(false) }}>
      <button className={'cvmenu-row' + (it.danger ? ' danger' : '') + (it.disabled ? ' dis' : '')}
        type="button" disabled={it.disabled} onClick={click}>
        <span className="mi">
          {it.sw != null
            ? <i className="cvmenu-swd" style={{ background: it.sw, borderColor: it.sw }} />
            : it.icon ? <Icon n={it.icon} size={13} /> : <i className="cvmenu-dot" />}
        </span>
        <span className="ml">{it.label}</span>
        {it.hint ? <span className="mh">{it.hint}</span> : null}
        {it.sub ? <span className={'msub' + (openUp ? ' up' : '')}><Icon n="chev" size={11} /></span> : null}
      </button>
      {it.sub && sub ? (
        <div className={'cvmenu cvmenu-sub' + (flip ? ' flip' : '')} ref={subRef} role="menu">
          {it.sub.map((s) => <MenuRow key={s.key} it={s} onDone={onDone} openUp={openUp} />)}
        </div>
      ) : null}
    </div>
  )
}

export function ContextMenu({ menu, onClose, build }: {
  menu: MenuState
  onClose: () => void
  /** 菜单内容由 Canvas 决定 —— 它才知道当前的树、选中、折叠态。 */
  build: (m: MenuState) => Item[]
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [at, setAt] = useState({ x: menu.x, y: menu.y })
  const [openUp, setOpenUp] = useState(false)
  const items = useMemo(() => build(menu), [menu, build])

  /* 量完再摆：先按鼠标位置摆，量出实际尺寸后如果右侧/下方放不下就翻到另一侧，
     最后再 clamp 一次贴边。两步都要做 —— 只翻不 clamp 时，
     菜单比视口还高（小窗口 + 长菜单）还是会溢出。 */
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    const vw = window.innerWidth, vh = window.innerHeight
    let x = menu.x, y = menu.y
    if (x + w > vw - 6) x = Math.max(6, menu.x - w)
    if (y + h > vh - 6) y = Math.max(6, vh - h - 6)
    x = Math.min(Math.max(6, x), Math.max(6, vw - w - 6))
    y = Math.min(Math.max(6, y), Math.max(6, vh - h - 6))
    setAt({ x, y })
    setOpenUp(menu.y + h > vh - 6)
  }, [menu])

  // Esc 关 / 滚动关 / 视口变化关（位置是按旧尺寸算的，变了就得重来，不如关掉）
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const wheel = () => onClose()
    const resize = () => onClose()
    window.addEventListener('keydown', key, true)
    window.addEventListener('wheel', wheel, { capture: true, passive: true })
    window.addEventListener('resize', resize)
    // 画布会在自己的滚动容器里滚（capture 抓得到），但外层的 .content 也可能滚
    window.addEventListener('scroll', wheel, { capture: true, passive: true })
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('wheel', wheel, { capture: true } as any)
      window.removeEventListener('resize', resize)
      window.removeEventListener('scroll', wheel, { capture: true } as any)
    }
  }, [onClose])

  /* 挂到 body 上：菜单是 fixed 定位，挂在 ReactFlow 里会被它的 transform
     和 overflow 裁掉（右下角那半截永远点不到）。 */
  return createPortal(
    <div className="cvmenu-mask" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div className={'cvmenu' + ' k-' + menu.kind} ref={boxRef} role="menu"
        style={{ left: at.x, top: at.y }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}>
        {items.map((it) => <MenuRow key={it.key} it={it} onDone={onClose} openUp={openUp} />)}
      </div>
    </div>,
    document.body,
  )
}
