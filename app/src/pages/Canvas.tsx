import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, Handle, MiniMap, Position, useEdgesState, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from 'reactflow'
import 'reactflow/dist/style.css'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import { rasterSvg, blobToB64 } from '../lib/raster'
import { xmindStatus, xmindLogin, xmindCode, xmindLogout, type XmStatus } from '../lib/xmind'
import { Sec } from '../components/Shell'
import { Icon } from '../components/Icon'
import { clsColor } from '../components/V6'
import { Outline } from './canvas/Outline'
import {
  brief, markParts, safeName, toIndentText, toJson, toMarkdown, toOpml, xCount,
} from './canvas/exporters'
/* FloatTools 不再从这里引：多选只剩底部那一条批量条（见下面 2085 行附近的说明）。
   组件本身留在 NodeEditor 里，NodeTools 跟它共用那套样式。 */
import { NodeEditor, NodeTools, NoteBadge, NoteFloat, NoteEntry, shownText } from './canvas/NodeEditor'
import { MindNode as MindNodeView, type MindData } from './canvas/MindNode'
import { NODE_TYPES as BLOCK_TYPES, typeOf, type NodeType } from './canvas/blocks'
import { buildSvg as svgOf } from './canvas/svgout'
import { autoLayout, edgeTypeOf, LAYOUT_CN, LAYOUTS, LS_LAYOUT, LS_MINIMAP, lsFlag, lsPick, lsSetFlag, subtreeIds, type LayoutMode } from './canvas/autolayout'
import type { Base } from '../lib/api'
import { ContextMenu, MENU_COLORS, cloneWithNewIds, getClip, setClip, type MenuState } from './canvas/ContextMenu'
/* 缩略图 vs 原图：卡片一律走 thumbUrl（后端现生成 WebP 并缓存），
   灯箱一律走 fullUrl。两个函数放在 lib/herd 里跟截图库共用同一套地址规则 ——
   别在这个文件里再拼一遍 '/shots/' + file，拼错一处就又是一次全量原图。 */
import { thumbUrl, thumbFallback, fullUrl } from '../lib/herd'
import { ShapeThumb } from './canvas/ShapeThumb'

// 画布：导图存本机（canvas_maps 表），可拉 XMind / Obsidian 等来源。
// 保持深色专业风 —— 主界面变浅了，画布不跟着变（用户 2026-10-21 定的）。

export type TNode = { id: string; text: string; note?: string; col?: string; type?: NodeType; children?: TNode[] }
type MapRow = { id: string; lesson_id: string; lesson_ids?: string[]; title: string; src: string; src_id: string | null; updated_ts: string; age: string; shape?: any; nodes?: number | null
  /* 后端补的讲次人话标题：[{id, title, chapter, n}]。分组抬头显示「第 5 讲 · 进制转换」用它，
     拿不到就退回 lesson_id —— 不编标题。 */
  lesson_titles?: { id: string; title?: string; chapter?: string; n?: number }[] }
type Src = { id: string; name: string; kind: string; how: string; ready: boolean; connected: boolean; state: string; hint?: { field?: string; label?: string; eg?: string; help?: string } }
/* 某个来源里的一条可导入笔记。id 是相对路径/云端 id（服务端刻意不给绝对路径），
   bytes/mtime 用来在界面上说清「这一条多大、什么时候改的」，不编、不估算。 */
type SrcItem = { id: string; title?: string; bytes?: number; mtime?: number; size?: number; updated?: string }

/* 素材库的四类来源（开发文档 2.5）。截图库不再只装截帧，
   所以卡上必须写清这张是从哪儿来的 —— 否则看不出「这是我截的」还是「这是导出的画布」。 */
const ORIGIN_CN: Record<string, string> = {
  frame: '截帧', canvas: '画布导出', upload: '上传', file: '外部文件',
}
/* 一张画布算哪一科：先看挂的讲次（cs-3 → cs），没挂就看不出，返回空串。
   不猜、不按标题猜 —— 猜错比空着更糟。 */
function mSubj(m: any): string {
  const lid = (m?.lesson_ids || [])[0] || m?.lesson_id || ''
  return String(lid).split('-')[0] || ''
}

/* 秒 → 12:34。截帧卡左下角那个时间要用，跟课堂页同一个口径。 */
function clock(sec: number) {
  const t = Math.max(0, Math.round(sec))
  const m = Math.floor(t / 60), s = t % 60
  return m + ':' + (s < 10 ? '0' + s : s)
}

const PALETTE = ['', '#FF6B1F', '#FFB020', '#5FCB8A', '#7FB0F0', '#B48BFF', '#FF6B4A', '#8FD3C7']
const SRCNAME: Record<string, string> = {
  local: '本地', xmind: 'XMind', markdown: 'Markdown', obsidian: 'Obsidian', notion: 'Notion',
  joplin: 'Joplin', logseq: 'Logseq', yuque: '语雀', wolai: '我来', opml: 'OPML',
}

/* 文件型笔记来源（server/notesrc.py 的 FILE_SRCS）。挂在这类来源上的画布，
   插图必须落进笔记旁的 assets/（哈希查重），md 写相对引用 ——
   回写时原样带走，Obsidian 那边照样打得开。其余来源一律本机素材路。 */
const FILE_SRC_SET = new Set(['obsidian', 'logseq', 'markdown', 'opml'])

const GAP_X = 210, H = 46, GAP_Y = 16
const SUBJNAME: Record<string, string> = {
  english: '英语', math: '高数', cs: '计算机', politics: '政治', clang: 'C 语言', free: '未分科',
}
let seq = 0
const nid = () => 'n' + Date.now().toString(36) + (seq++).toString(36)

function newTree(t = '未命名画布'): TNode {
  return { id: nid(), text: t, col: '', children: [{ id: nid(), text: '第一个分支', col: '', children: [] }] }
}

/* 布局算法全在 canvas/autolayout.ts：横树 / 竖树 / 放射都从那儿来。
   这里只剩一个「带上当前模式」的薄壳，免得下面二十处调用点全要改。
   pos 覆盖优先写在 autolayout 里 —— 拖过的节点换布局也不归位。 */
function layout(root: TNode, md: LayoutMode, fold: Record<string, 1>, pos: Record<string, { x: number; y: number }>) {
  return autoLayout(md, root, fold, pos)
}

function walkAll(n: TNode, fn: (x: TNode, parent: TNode | null, depth: number) => void, parent: TNode | null = null, depth = 0) {
  if (!n) return                       // 预览树还没回来时是 null，不能直接摸 .children
  fn(n, parent, depth)
  ;(n.children || []).forEach((c) => walkAll(c, fn, n, depth + 1))
}
function findNode(root: TNode, id: string): TNode | null {
  let hit: TNode | null = null
  walkAll(root, (x) => { if (x.id === id) hit = x })
  return hit
}
function findParent(root: TNode, id: string): TNode | null {
  let hit: TNode | null = null
  walkAll(root, (x, p) => { if (x.id === id) hit = p })
  return hit
}
function countNodes(root: TNode) { let n = 0; walkAll(root, () => n++); return n }

function esc(s: string) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)) }
// 极简 Markdown：先转义再替换，绝不塞未转义的 HTML
function mdHtml(s: string) {
  return esc(s || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .split('\n').map((l) => (/^\s*[-*+]\s+/.test(l) ? '<li>' + l.replace(/^\s*[-*+]\s+/, '') + '</li>' : '<p>' + l + '</p>')).join('')
}

// ---- 自定义节点 ----


/* 版面按钮的图标：三种布局各画一个示意图。用内联 svg 而不是 Icon ——
   Icon 里没有「布局」这一类，往那套通用图标里塞三个只在这里用的形状不划算。 */
function LayoutGlyph({ mode }: { mode: LayoutMode }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className="cvglyph">
      {mode === 'mind' ? (
        <g {...p}>
          <path d="M5 8 H8 M8 4.5 V11.5 M8 4.5 H11 M8 11.5 H11" />
          <rect x="2" y="6.4" width="3" height="3.2" rx=".9" />
          <rect x="11" y="2.9" width="3" height="3.2" rx=".9" />
          <rect x="11" y="9.9" width="3" height="3.2" rx=".9" />
        </g>
      ) : mode === 'treeV' ? (
        <g {...p}>
          <path d="M8 5 V8 M4.5 8 H11.5 M4.5 8 V11 M11.5 8 V11" />
          <rect x="6.4" y="2" width="3.2" height="3" rx=".9" />
          <rect x="2.9" y="11" width="3.2" height="3" rx=".9" />
          <rect x="9.9" y="11" width="3.2" height="3" rx=".9" />
        </g>
      ) : (
        <g {...p}>
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="2.6" r="1.2" />
          <circle cx="13.4" cy="8" r="1.2" />
          <circle cx="8" cy="13.4" r="1.2" />
          <path d="M8 6.5 V3.8 M9.5 8 H12.2 M8 9.5 V12.2" />
        </g>
      )}
    </svg>
  )
}

const NODE_TYPES = { mind: MindNodeView }

/* ── 导图连线 ──────────────────────────────────────────────────────
   为什么要自己画：React Flow 内置的 'default' 边只认「右出左进」，
   左支（向左长的那些）的线会从源节点的右腰出发、绕一大圈才回到目标节点的右腰，
   看起来像横穿节点的一条横杠 —— 试过 targetHandle/sourceHandle 也不行，
   它算贝塞尔的锚点方向是写死的。

   这里按 side 自己算控制点：
   - 右支：源右腰 → 目标左腰，控制点各自水平外推半个间距
   - 左支：源左腰 → 目标右腰，方向整个镜像
   - 竖直布局：源下沿 → 目标上沿，控制点垂直外推
   这样两种方向的弧线是对称的，也才像导图的主枝。 */
function MindEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd }: any) {
  /* 方向只看 sourcePosition —— 它是「这条边从哪个口出去」，最可靠。
     targetPosition 也要看，但只用来区分竖树（bottom）。 */
  const horiz = sourcePosition === 'left' || sourcePosition === 'right'
  let d: string
  if (sourcePosition === 'bottom') {
    // 竖树 / 放射：从父的下沿垂下去，再进子的上沿
    const dy = Math.abs(targetY - sourceY)
    const my = sourceY + Math.max(16, dy * 0.5)
    d = `M${sourceX},${sourceY} C${sourceX},${my} ${targetX},${my} ${targetX},${targetY}`
  } else if (sourcePosition === 'left') {
    // 左支：从父的左腰往左伸，再水平拐进子的右腰
    const dx = Math.abs(sourceX - targetX)
    const mx = sourceX - Math.max(22, dx * 0.5)
    d = `M${sourceX},${sourceY} C${mx},${sourceY} ${mx},${targetY} ${targetX},${targetY}`
  } else if (horiz) {
    // 右支：镜像
    const dx = Math.abs(targetX - sourceX)
    const mx = sourceX + Math.max(22, dx * 0.5)
    d = `M${sourceX},${sourceY} C${mx},${sourceY} ${mx},${targetY} ${targetX},${targetY}`
  } else {
    // 兜底：直线（放射布局里会走到这儿）
    d = `M${sourceX},${sourceY} L${targetX},${targetY}`
  }
  return <path id={id} className="react-flow__edge-path" d={d} style={style} markerEnd={markerEnd} fill="none" />
}
const EDGE_TYPES = { mind: MindEdge }

/* 弹层外壳：三个弹层共用一套（标题 + 可滚内容 + 底部操作条），
   避免每个弹层各写一份 padding 和关闭按钮，间距一定不齐。 */
function Modal({ title, sub, onClose, foot, children, wide }: {
  title: string; sub?: string; onClose: () => void; foot?: React.ReactNode; children: React.ReactNode; wide?: boolean
}) {
  return (
    <div className="mdl" onClick={onClose}>
      <div className={'mdl-box' + (wide ? ' wide' : '')} onClick={(e) => e.stopPropagation()}>
        <header className="mdl-hd">
          <div className="mdl-tt">
            <b>{title}</b>
            {sub ? <span>{sub}</span> : null}
          </div>
          <button className="mdl-x" title="关掉" onClick={onClose}><Icon n="x" size={16} /></button>
        </header>
        <div className="mdl-bd">{children}</div>
        {foot ? <footer className="mdl-ft">{foot}</footer> : null}
      </div>
    </div>
  )
}

/* 画布卡片的缩略图 —— 画成一张真的小思维导图，不是一列带点的文字。
   原来那样（一行一个分支、左边一个点）在卡上根本看不出结构：
   一屏六张卡，六列小字，谁是谁的子节点全靠缩进猜。
   现在按导图的画法来：主题居中，一级分支左右分开，曲线接过去，
   层级靠字色深浅分。数据还是后端那棵 shape（t 文字 / c 子 / col 色），不编。 */
/* Markdown 预览树：把后端 note_from_md 返回的真树画出来（不是前端自己猜层级） */
function TreePreview({ node, d = 0 }: { node: any; d?: number }) {
  if (!node) return null
  const kids = (node.children || []) as any[]
  return (
    <div className={'tp-n d' + Math.min(d, 4)}>
      <span className="tp-t" title={String(node.text || '')}>{node.text || '（空）'}</span>
      {kids.map((c) => <TreePreview key={c.id} node={c} d={d + 1} />)}
    </div>
  )
}

export function Canvas({ base, openReq, topHost }: {
  base: Base; onHome?: () => void
  /* 从课堂页带进来的「打开哪张 / 给哪一讲新建」。nonce 换一次触发一次，
     所以同一张图连点两下也会重新打开（否则 effect 依赖不变，界面不动）。 */
  openReq?: { mapId?: string; lessonId?: string; nonce: number } | null
  topHost?: (n: React.ReactNode) => void
}) {
  const cur = useTool<{ lesson: { id: string; title: string } }>('get_current_lesson', {})
  /* 讲次有两个来源：本机当前进度（get_current_lesson），或者从课堂页带进来的那一讲。
     后者优先 —— 用户在课堂右栏点「新建本讲笔记」，要的就是那一讲，
     不能因为 get_current_lesson 还停在上一讲就把图画到别处去。
     空串表示没被指定，回落到本机进度。 */
  const [lidOv, setLidOv] = useState('')
  const lid = lidOv || cur.data?.lesson?.id
  const list = useTool<{ maps: MapRow[]; count: number }>('note_list', { limit: 100 })
  const srcs = useTool<{ sources: Src[]; count: number }>('note_sources')

  const [mapId, setMapId] = useState<string | null>(null)
  const [title, setTitle] = useState('未命名画布')
  const [src, setSrc] = useState('local')
  const [tree, setTree] = useState<TNode | null>(null)
  /* 选中是「一个集合」，不是「一个 id」——
     和所有画图软件一样：点一个选一个，按住 Shift/Ctrl 点加选，空白处框选，
     右键和 Del 都要能吃掉整批。sel 仍保留成「主选」，因为检查器只展一个。 */
  /* 选中 = 一个主选 + 一个集合。集合是唯一真相，ReactFlow 那边只负责把 selected 画出来；
     反过来读它的 selected 会被回灌冲掉（已踩两次）。 */
  const [sel, setSel0] = useState<string | null>(null)
  const [selSet, setSelSet] = useState<string[]>([])
  /* 选中的同步副本：右键那一刻要先「选中被点的节点」，而 setSel 是异步的 ——
     菜单如果等到下一帧再读 selSet，会读到旧的集合（右键空白偏一点就变成单选）。
     这份 ref 只做只读快照，写还是只走 setSel。 */
  const selectionRef = useRef<{ sel: string | null; set: string[] }>({ sel: null, set: [] })
  const setSel = useCallback((id: string | null, add = false) => {
    setSel0(id)
    setSelSet((prev) => {
      const next = !id ? [] : (!add ? [id] : (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      selectionRef.current = { sel: id, set: next }
      return next
    })
  }, [])
  /* 整批替换：框选和「全选」这两个动作给的是**一整个集合**，不是「加一个」。
     原来只有 setSel(一个 id, 加/不加) 这一个口子，框选完 24 个节点以后
     selSet 还是空的 —— 底部批量条永远不出现，Del 也只删得掉最后一次点中的那个。
     这就是「多选操作逻辑不对」的根子：框选只画了 ReactFlow 自己的 selected，
     没进到我们这套「唯一真相」里。 */
  /* 框选刚刚结束。为的是吃掉松手那一下补发的 onNodeClick（见下面 onSelectionEnd）。
     用 ref 不用 state：它只在同一次交互里活一瞬，进 state 反而会多渲染一帧。 */
  const boxEndRef = useRef(false)
  /* 框选进行中。ReactFlow 的 onSelectionStart/End 给的就是这两个时机。
     为什么要有它：框选**过程中** selSet 还是空的（要等松手才收进来），
     但那时屏幕上已经被框住的节点全亮着选中态、并且各挂一条工具条。
     光靠 selSet 判断「多选」在拖动期间永远是假，所以单独立一个 boxing。 */
  const [boxing, setBoxing] = useState(false)
  /* 框选过程中实时累积「被扫到的节点 id」。
     只写 ref、不 setState —— 每帧 setState 会让 nodes 重建再回灌 ReactFlow，
     就是注释里那个 React #185 的自激环。松手时才一次性交给 setSelMany。 */
  const boxAcc = useRef<string[]>([])
  const boxingRef = useRef(false)
  boxingRef.current = boxing

  const setSelMany = useCallback((ids: string[]) => {
    const next = ids.slice()
    setSel0(next[next.length - 1] || null)
    selectionRef.current = { sel: next[next.length - 1] || null, set: next }
    setSelSet(next)
  }, [])
  const [fold, setFold] = useState<Record<string, 1>>({})
  /* 正在原地编辑的节点。null = 没有编辑。
     带 mode 是因为「改标题」和「改备注」共用一个编辑态：同一时刻只能开一个，
     两个字段各存一套的话会互相打架（标题开着、备注也开着，Esc 该关哪个说不清）。
     放在 Canvas 而不是 MindNode 里：节点每帧都会被重建，节点内 state 保不住。 */
  const [editing, setEditing] = useState<{ id: string; mode: 'text' | 'note' } | null>(null)
  /* 展开着的节点浮层（现在只有色板）。同样只许开一个，所以由这里持着 ——
     存进每个节点自己的 state 的话，拖拽时每个节点各开一个，关都关不掉。 */
  const [pop, setPop] = useState<{ id: string; kind: 'color' } | null>(null)
  /* 批量条上的色板浮层开关（选中多个时那一整条）。 */
  const [bulkPop, setBulkPop] = useState(false)
  /* 底部快捷键提示是否还露着。默认露，进编辑视图 6 秒后自动收。
     它是「第一次用」的说明，不是常驻 UI —— 一直挂着只会挡画布。
     收起后把鼠标移上去还能再叫出来（onMouseEnter），不设手动关闭按钮：
     加个 × 等于为一个提示条再做一个状态管理，不值。 */
  const [hintOn, setHintOn] = useState(true)
  const hintT = useRef<number>(0)
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({})
  /* 版面模式：横树 / 竖树 / 放射。跟着画布存本机（sd.cv.layout），
     下次打开还是上次选的那个 —— 布局偏好是「我的习惯」，不是这张图的属性。 */
  const [mdMode, setMdMode] = useState<LayoutMode>(() => lsPick<LayoutMode>(LS_LAYOUT, LAYOUTS, 'mind'))
  /* 迷你地图默认关：画布已经有一整条缩放工具条，再加一张缩略图纯添乱。
     想开的人自己开，开关记在本机（sd.cv.minimap）。 */
  const [miniMap, setMiniMap] = useState(() => lsFlag(LS_MINIMAP, false))
  const [dirty, setDirty] = useState(false)
  const [hist, setHist] = useState<string[]>([])
  const [hi, setHi] = useState(-1)
  /* 撤销栈的 ref 镜像。scheduleSave 的回调是 900ms 后才跑的，闭包里抓到的
     hist/hi 是「排这一次防抖时」的旧值 —— 两次改动挨得近时，第二次会把第一次
     刚入栈的那一版又盖掉，于是 Ctrl+Z 只退一跳甚至看着没反应。所有读写都走 ref。 */
  const histRef = useRef<string[]>([])
  const hiRef = useRef(-1)
  const [find, setFind] = useState('')
  /* 搜索框：原来是左栏里一块常驻区域，占着侧栏本来就不多的高度。
     现在改成 Ctrl+F 呼出的浮条 —— 不用的时候一条都不占。 */
  const [findOpen, setFindOpen] = useState(false)
  /* 绑定讲次面板。画布挂在哪几讲以前只能在新建时定死，之后改不了 ——
     这条口子补上：选完直接调 note_rebind（只改绑定关系，不动树）。 */
  const [bindOpen, setBindOpen] = useState(false)
  const [bindIds, setBindIds] = useState<string[]>([])
  const [bindBusy, setBindBusy] = useState(false)
  const [bindQ, setBindQ] = useState('')
  /* 保存绑定：调 note_rebind（只改绑定关系）。失败了如实说，不假装成功。 */
  const saveBind = useCallback(async () => {
    if (!mapId) { setToast('这张画布还没存过，先随便改一下让它落库'); return }
    setBindBusy(true)
    try {
      const r = await callTool<any>('note_rebind', { map_id: mapId, lesson_ids: bindIds }, { write: true })
      if (!r.ok) { setToast('绑定没改成：' + (r.error || '未知原因')); return }
      const unk = (r.data && r.data.unknown) || []
      if (unk.length) {
        setToast('有 ' + unk.length + ' 个讲次本机找不到，没绑上去：' + unk.slice(0, 3).join('、'))
      } else {
        setToast(bindIds.length ? ('已挂到 ' + bindIds.length + ' 讲') : '已解绑全部讲次')
      }
      setBindOpen(false)
      list.run()
    } finally { setBindBusy(false) }
  }, [mapId, bindIds, list])
  /* 讲次清单：面板打开时才向 list_lessons 要。
     ⚠ 不能读 base.subjects[].lessons —— 为了首屏体积，那一坨已经从 /api/base 里摘掉了，
     现在那里只有 dur_total。拿它遍历必然得到空数组（这就是第一版面板空着的原因）。
     按科目逐个取，取回来按 subject 归好；拿不到就如实空着，不编讲次。 */
  const [allLessons, setAllLessons] = useState<{ id: string; title: string; subject: string }[]>([])
  const [bindLoading, setBindLoading] = useState(false)
  useEffect(() => {
    if (!bindOpen || allLessons.length) return
    let cancelled = false
    setBindLoading(true)
    ;(async () => {
      const out: { id: string; title: string; subject: string }[] = []
      for (const sj of (base as any).subjects || []) {
        const r = await callTool<any>('list_lessons', { subject: sj.id })
        if (cancelled) return
        for (const g of (r?.data?.groups || [])) {
          for (const l of (g.lessons || [])) {
            out.push({ id: String(l.id), title: String(l.title || l.id), subject: String(sj.id) })
          }
        }
      }
      if (!cancelled) setAllLessons(out)
    })().finally(() => { if (!cancelled) setBindLoading(false) })
    return () => { cancelled = true }
  }, [bindOpen, allLessons.length, base])
  const findRef = useRef<HTMLInputElement | null>(null)
  const [hits, setHits] = useState<string[]>([])
  const [hitIx, setHitIx] = useState(0)
  const [showSrc, setShowSrc] = useState(false)
  const [mdText, setMdText] = useState('')
  const [showMd, setShowMd] = useState(false)
  const [mdPrev, setMdPrev] = useState<any>(null)   // 导入 MD 的实时预览树
  const [showGal, setShowGal] = useState(false)
  /* ── task-4 加的四件状态 ──
     leftTab：左栏两个 tab（画布列表 / 大纲），大纲不占舞台。
     showExp：顶栏「导出」的小面板，导出方式从 2 个长到 6 个，再摆一排按钮就挤爆 top 了。
     showKeys：快捷键表。12 条摆不下在底部的提示行里。
     crossShot：跨画布搜索的结果（按需才扫，最多 20 张，扫的时候给「还在扫」）。 */
  const [leftTab, setLeftTab] = useState<'maps' | 'outline'>('maps')
  /* 左栏「我的画布」列什么（用户 m07515 原话：「我本来就是想要看见本节课或者本课程的缩略图，
     但是你却给我显示了全部的」）。默认只看本讲 —— 画布是一节课的笔记层，
     左栏就该是这一讲的几张，不是全库。切到「本科」看同一门课的，切到「全部」才铺开。
     就地筛，不重新请求：maps 里已经带了 lesson_ids / lesson_id，切一下是纯计算。 */
  const [lvFilter, setLvFilter] = useState<'lesson' | 'subject' | 'all'>('lesson')
  const [showExp, setShowExp] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const [xmap, setXmap] = useState(false)
  const [xres, setXres] = useState<{ id: string; title: string; rows: { map: string; title: string; text: string; note?: string }[]; done: number; total: number } | null>(null)
  const [xbusy, setXbusy] = useState(false)
  // 视图二选一：库（一排缩略图，默认）/ 编辑（导图）。
  // 以前进页面就直接铺开一张空画布，人不知道该点哪；先给一排「看得出是什么」的卡片。
  const [view, setView] = useState<'gallery' | 'edit'>('gallery')
  // 库视图里两个 tab：画布 / 图库（开发文档 3.2 的顶栏就是这个结构）。
  // 图库 = 截图素材库，和画布共用「一排缩略图」的读法，不再是个弹窗。
  const [tab, setTab] = useState<'map' | 'shot'>('map')
  const [galAll, setGalAll] = useState(true)   // 库里默认不按学科筛，看不见别的科的画布就容易以为丢了
  const [q, setQ] = useState('')                // 图库搜索词
  const [originF, setOriginF] = useState('')    // 图库按来源筛（frame / canvas / upload / file）
  const [sortBy, setSortBy] = useState<'recent' | 'nodes'>('recent')
  const [galIdx, setGalIdx] = useState(0)   // 叠层大图翻开的是第几张
  /* 图库列表。画布 tab 也要读：顶栏上「图库 N」这个数得是真的，
     等点开才去数就来不及给数了。q / origin 变了重取（key 跟着变）。 */
  const galList = useTool<{ shots: any[]; count: number; total: number; tags: string[] }>(
    'shot_list', { limit: 120, q: q || undefined, origin: originF || undefined })

  const [shotBusy, setShotBusy] = useState(false)
  /* 缩略图上那枚删除键的两步确认：存的是「已经点过一次的那张 id」。
     写盘类操作一律两步（全站规矩），而且这里删的只是库里那条记录。 */
  const [delArm, setDelArm] = useState<string | null>(null)
  /* 画布卡上的删除键也走两步确认。跟截图那枚分开存 ——
     同一个 id 在两边都可能出现（画布 id 和截图 id 格式像），混用会互相上膛。 */
  const [delMapArm, setDelMapArm] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  /* 顶栏 toast。msg 原来只渲染在「来源」那个 Modal 里 —— 点截图其实存成功了，
     提示却藏在没打开的弹窗里，用户看到的就是「点了没反应」。
     toast 是同一个 msg，只是给了一个总能看见的落点。 */
  const [toast, setToast] = useState<string | null>(null)
  const toastT = useRef<number | null>(null)
  function say(t: string) {
    setMsg(t); setToast(t)
    if (toastT.current) window.clearTimeout(toastT.current)
    toastT.current = window.setTimeout(() => setToast(null), 3400)
  }
  const [isFull, setIsFull] = useState(false)
  const rfRef = useRef<ReactFlowInstance | null>(null)
  /* 舞台 DOM：跟手工具条的坐标基准必须是它 —— .cvstage 会跟着画布缩放/平移一起动，
     拿 clientX 直接往 fixed 上贴的话一缩放就偏。 */
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  function toggleFull() {
    const el = wrapRef.current
    if (!document.fullscreenElement) { el?.requestFullscreen?.(); setIsFull(true) }
    else { document.exitFullscreen?.(); setIsFull(false) }
  }
  useEffect(() => {
    const onCh = () => setIsFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onCh)
    return () => document.removeEventListener('fullscreenchange', onCh)
  }, [])
  const saveT = useRef<any>(null)
  const pre = useRef<string | null>(null)

  // 当前学科：画布自己知道讲次，讲次 id 的 prefix 就是学科（english-69 → english）
  function curSubject(): string {
    const s = String(lid || '').split('-')[0]
    return s || 'free'
  }

  // 截图库：只按当前学科拉。学科来自画布挂的讲次，讲次是异步来的，
  // 所以这里自己管一次请求，不走 useTool —— 用 useTool 会因为 args 变化重复拉两次。
  const [gal, setGal] = useState<{ shots: any[]; count: number; tags: string[] }>({ shots: [], count: 0, tags: [] })
  const loadGal = useCallback(async (subj?: string) => {
    const r = await callTool('shot_list', { subject: subj ?? curSubject(), limit: 120 })
    const d: any = r.data || {}
    setGal({ shots: d.shots || [], count: d.count ?? 0, tags: d.tags || [] })
  }, [lid]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadGal() }, [loadGal])

  /* 画布卡上直接删。两步确认，第二次才真发 note_del（PERM_CONFIRM）。
     跟截图那张不同：画布没有盘上的副本，删了就真没了 —— 所以 title 里不写「还能再导回来」。 */
  const delMap = useCallback(async (m: any) => {
    if (delMapArm !== m.id) { setDelMapArm(m.id); return }
    setDelMapArm(null)
    const r = await callTool('note_del', { map_id: m.id }, { confirm: true, write: true })
    if (!r.ok) { say('删不掉：' + (r.error || '未知原因')); return }
    say('已删掉「' + (m.title || '未命名') + '」')
    if (mapId === m.id) { setMapId(null); setTree(null); setView('gallery') }
    list.run()
  }, [delMapArm, list, mapId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 素材库缩略图上直接删。两步确认，第二次才真发 shot_del。
     删的是「库里这条记录」，盘上 data/shots/ 的图不动 —— 摘错了还能再导回来，
     这句话写进 title 里，免得人以为点了就把文件销毁了。
     失败要说出来：不写 toast 的话，用户点两下没反应会以为按钮坏了（跟截图那次同因）。 */
  const delShot = useCallback(async (x: any) => {
    if (delArm !== x.id) { setDelArm(x.id); return }
    setDelArm(null)
    const r = await callTool('shot_del', { id: x.id }, { write: true })
    if (!r.ok) { say('删不掉：' + (r.error || '未知原因')); return }
    say('已从素材库摘掉「' + (x.title || '未命名') + '」· 盘上的图还在')
    /* 图库墙上的卡片读的是 galList.data（useTool 那一份），不是 loadGal 写进 gal 的那份 ——
       只刷 loadGal 的话，库里已经 3 张、屏幕上还挂着 4 张，人会以为没删掉。
       两个都要刷：gal 管顶栏上那个数，galList 管墙上的格子。 */
    loadGal()
    galList.run()
    if (showGal) setShowGal(false)
    list.run()
  }, [delArm, loadGal, showGal, list, galList]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- XMind：OAuth 链路，状态与动作都走 /api/xmind/* ----
  const [xmSt, setXmSt] = useState<XmStatus | null>(null)
  const [xmBusy, setXmBusy] = useState(false)
  const [xmUrl, setXmUrl] = useState<string | null>(null)
  const [xmMsg, setXmMsg] = useState<string | null>(null)
  const [xmCode2, setXmCode2] = useState('')
  const [xmMaps, setXmMaps] = useState<{ id: string; title?: string; name?: string }[]>([])

  const loadXm = useCallback(async () => {
    const st = await xmindStatus()
    setXmSt(st)
    if (st?.connected) {
      const r = await callTool('xmind_list_maps')
      setXmMaps((r.data as any)?.maps || (r.data as any)?.mindmaps || [])
    } else setXmMaps([])
  }, [])

  useEffect(() => { if (showSrc) loadXm() }, [showSrc, loadXm])

  /* ---- 已连的来源：挑入口一项 → 直接转成画布（回答「手写笔记能同步过来吗」）----
     以前来源面板只有「填路径 / 填 token」，填完了也拿不到东西，人会以为接了个假的。
     现在每张能用的卡都有「挑一条」：note_src_list 列条目 → note_src_pull(save:true) 落成本机画布。
     不认识的来源（local / xmind）服务端自己会挡回来，前端不替它找借口。 */
  const [pickSrc, setPickSrc] = useState<string | null>(null)
  const [pickItems, setPickItems] = useState<SrcItem[]>([])
  const [pickBusy, setPickBusy] = useState(false)

  async function openPick(id: string) {
    if (pickSrc === id) { setPickSrc(null); return }
    setPickSrc(id); setPickItems([]); setPickBusy(true)
    const r = await callTool('note_src_list', { src: id })
    setPickBusy(false)
    const d: any = r.data || {}
    setPickItems(Array.isArray(d.items) ? d.items : (Array.isArray(d.files) ? d.files : []))
    if (!r.ok) setMsg((d.error || r.error || '没列出来') as string)
    else if (!((d.items || d.files) || []).length) setMsg('这个来源里还没有能拉的东西')
  }
  async function pullItem(it: SrcItem) {
    if (!pickSrc) return
    setPickBusy(true)
    /* title 要自己带上：不给的话 md_tree 会把一级标题以外的文本当根节点名，
       拉进来全叫「导入的导图」，五张同名的卡根本分不清谁是谁。 */
    const r = await callTool('note_src_pull',
      { src: pickSrc, item: it.id, title: it.title || it.id, save: true, lesson_id: lid || null },
      { write: true })
    setPickBusy(false)
    const d: any = r.data || {}
    if (!r.ok) { setMsg('没拉进来：' + (d.error || r.error || '未知原因')); return }
    setMsg(`已把「${d.title || it.title || it.id}」转成画布`)
    setPickSrc(null); list.run()
  }
  function bytesOf(n?: number) {
    if (n == null) return ''
    return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
  }
  // 打字时让后端按同一套规则解析，前端不自己猜层级 —— 预览必须等于导入结果
  useEffect(() => {
    if (!showMd) return
    const t = (mdText || '').trim()
    if (!t) { setMdPrev(null); return }
    const id = setTimeout(async () => {
      const r = await callTool('note_from_md', { text: mdText, title: '预览' })
      setMdPrev(r.ok ? ((r.data as any)?.tree ?? null) : null)
    }, 420)
    return () => clearTimeout(id)
  }, [mdText, showMd])


  // 拉一张云端导图 → 存成本机画布
  async function pullXm() {
    if (!xmMaps.length) { setXmMsg('云端还没有导图：先在 XMind 里建一张再拉'); return }
    const pick = window.prompt(
      '云端有这些导图，把编号填进来：\n' + xmMaps.map((m, i) => `${i + 1}. ${m.title || m.name || m.id}`).join('\n'),
      '1')
    if (pick == null) return
    const m = xmMaps[Number(pick) - 1]
    if (!m) { setXmMsg('编号不在列表里'); return }
    setXmBusy(true)
    const r = await callTool('note_pull_xmind', { map_id: m.id, lesson_id: lid || null }, { write: true })
    setXmBusy(false)
    const d: any = r.data || {}
    if (!r.ok) { setXmMsg('没拉下来：' + (r.error || d.error || '未知原因')); return }
    setXmMsg(`已拉「${d.title || m.title || m.id}」${d.nodes ?? ''} 个节点，存成本机画布`)
    list.run()
  }

  // 把本机这张画布推成云端导图
  async function pushXm() {
    if (!mapId) { setXmMsg('这张画布还没存过，先等它存一次再推'); return }
    setXmBusy(true)
    const r = await callTool('note_push_xmind', { lesson_id: lid || null, src, src_id: null, title }, { write: true })
    setXmBusy(false)
    const d: any = r.data || {}
    if (!r.ok) { setXmMsg('没推上去：' + (r.error || d.error || '未知原因')); return }
    setXmMsg('已推给 XMind（' + (d.tool || '') + '）')
  }

  /* 打开一张已存过的画布。
     ⚠ 必须按 id（note_open），不能按 (讲次, 来源, 来源id) 三元组（note_load）：
     三元组拼出来的 id 是「一讲一张」的年代留下的 —— 同一讲下只要有两张 local 画布，
     note_load 永远返回拼 id 那一张，于是点 B 卡打开的是 A 的内容：
     标题换成了 B（它是从卡片上取的），里面画的却还是 A 的节点树。
     实测就是「点『探针临时画布』，标题对了，节点全是『函数的单调性』的」。
     顺手也修掉了「整库导入回来的画布点不开」—— 那种 id 带文件指纹，三元组拼不出来。 */
  const openMap = useCallback(async (m: MapRow) => {
    const r = await callTool('note_open', { map_id: m.id })
    const d: any = r.data || {}
    if (!r.ok || !d.map) {
      /* 打不开就说打不开。以前这里会兜一棵 newTree(m.title) 的空树 ——
         人看到的是「打开了一张空画布」，会以为是自己的内容丢了。 */
      setMsg('打不开「' + (m.title || '未命名') + '」：' + (r.error || '本机没有这张画布'))
      return
    }
    const t: TNode = d.tree && d.tree.id ? d.tree : newTree(d.map.title || m.title)
    setMapId(d.map.id); setTitle(d.map.title || '未命名画布'); setSrc(d.map.src || 'local')
    setLidOv((d.map.lesson_ids || [])[0] || d.map.lesson_id || '')
    // 把这张画布当前的绑定读进面板，打开就是它现在的状态（不是空的）
    setBindIds((d.map.lesson_ids && d.map.lesson_ids.length)
      ? d.map.lesson_ids.map(String)
      : (d.map.lesson_id ? [String(d.map.lesson_id)] : []))
    setTree(t)
    setSel(null); setFold({}); setPos({}); setDirty(false)
    commit([JSON.stringify(t)], 0); pre.current = null
    setView('edit')
  }, [])

  // 打开一张空白新画布（还没落库，第一次改动才写）
  function newMap() {
    const t = newTree()
    setMapId(null); setTitle('未命名画布'); setSrc('local'); setTree(t)
    setSel(t.children![0].id); setFold({}); setPos({}); setDirty(true)
    commit([JSON.stringify(t)], 0); pre.current = JSON.stringify(t)
    setView('edit')
  }

  // 以前进来就自动把第一张塞进编辑器，于是「库」永远看不见 —— 现在留在库视图，
  // 点哪张才进哪张（openMap 自己会切 view）。
  useEffect(() => {
    if (view === 'edit' && !tree && list.data?.maps?.length) openMap(list.data.maps[0])
  }, [list.data, tree, openMap, view])

  /* 从课堂页带着意图进来（右栏笔记卡 / 「新建本讲笔记」）。
     mapId：按 id 直取（note_open）。不能用 note_load —— 那条路要 (讲次, 来源, 来源 id)
     三元组，而库里真实的 id 是拼出来的，前端拼不出来。
     lessonId：不落库、不假造一张空图，只把挂载讲次定下来，然后开一张新的空白画布；
     真正的 note_save 由用户第一次改动触发（跟平时新建一张的行为一致）。 */
  const openReqRef = useRef<number>(0)
  /* 提示条自动收起：进了编辑视图就起个 6 秒的钟，到点收掉。
     每次切进编辑视图重来一次（人在这一页待久了再看也还是能 hover 叫出来）。 */
  useEffect(() => {
    if (view !== 'edit') return
    setHintOn(true)
    clearTimeout(hintT.current)
    hintT.current = window.setTimeout(() => setHintOn(false), 6000)
    return () => clearTimeout(hintT.current)
  }, [view])

  /* Ctrl/Cmd+F：在这一页是「搜节点」，不跳全局搜索。
     全局那边（App.tsx）遇到画布页只派发 'cv:find' 事件，这里接住。 */
  useEffect(() => {
    if (view !== 'edit') return
    const onFind = () => {
      setFindOpen(true)
      window.setTimeout(() => findRef.current?.focus(), 30)
      window.setTimeout(() => findRef.current?.select(), 40)
    }
    window.addEventListener('cv:find', onFind)
    return () => window.removeEventListener('cv:find', onFind)
  }, [view])

  useEffect(() => {
    if (!openReq || openReq.nonce === openReqRef.current) return
    openReqRef.current = openReq.nonce
    if (openReq.lessonId) {
      /* setLidOv 之后 lid 要下一次渲染才生效，而 newMap 只是把空树塞进编辑器、
         不写库 —— 真正的 note_save 在用户第一次改动时（900ms 防抖）才发，
         那会儿 lid 早就换过来了。所以这里不用把讲次往里传。 */
      setLidOv(openReq.lessonId)
      newMap()
      return
    }
    if (!openReq.mapId) return
    ;(async () => {
      const r = await callTool('note_open', { map_id: openReq.mapId })
      const d: any = r.data || {}
      if (!r.ok || !d.map) { setMsg('打不开那张画布：' + (r.error || '本机没有')); return }
      const t: TNode = d.tree && d.tree.id ? d.tree : newTree(d.map.title || '未命名画布')
      setMapId(d.map.id); setTitle(d.map.title || '未命名画布'); setSrc(d.map.src || 'local')
      setLidOv((d.map.lesson_ids || [])[0] || d.map.lesson_id || '')
      setTree(t); setSel(null); setFold({}); setPos({}); setDirty(false)
      commit([JSON.stringify(t)], 0); pre.current = null
      setView('edit')
    })()
  }, [openReq]) // eslint-disable-line react-hooks/exhaustive-deps

  // 保存（900ms 防抖）：真改动才入撤销栈，避免每敲一个字就是一格
  const scheduleSave = useCallback((t: TNode) => {
    clearTimeout(saveT.current)
    // 真改动才入撤销栈（避免每敲一个字一格）
    saveT.current = setTimeout(async () => {
      if (pre.current !== null && pre.current !== JSON.stringify(t)) {
        /* 这里进来的 pre.current 是「这次改动**之前**的树」，所以它才是要入栈的那一版。
           以前把 stack.push 放在 slice 之后、把 pre.current 重置放在 push 之前，
           两次改动挨得近时（900ms 防抖窗口内）第二版就被当成「没变」跳过，
           撤销栈里只剩最后一跳 —— 按 Ctrl+Z 看着像没反应。 */
        const stack = histRef.current.slice(0, hiRef.current + 1)
        stack.push(pre.current)
        if (stack.length > 60) stack.shift()
        commit(stack, stack.length - 1)
      }
      pre.current = null
      /* 保存必须带上「我在存哪一张」。
         不带 map_id 时服务端按 (讲次, 来源, 来源id) 三元组重新拼一个 id ——
         同一讲下只要有两张画布，拼出来的永远是其中一张，于是「打开 B、改一下」
         会把内容写进 A，A 的内容被整个盖掉。
         这个坑是真踩过的：一张 49 节点的用户画布被一次探针改成了 59 节点。
         只要手上已经有 mapId（openMap / note_open 都会设），就必须按 id 存。 */
      const saveArgs: Record<string, any> = { lesson_id: lid, title, tree: t, src }
      if (mapId) saveArgs.map_id = mapId
      const r = await callTool('note_save', saveArgs, { write: true })
      const d: any = r.data || {}
      if (d.map?.id) setMapId(d.map.id)
      setDirty(false)
      list.run()
    }, 900)
  }, [hist, hi, lid, title, src, list, mapId]) // eslint-disable-line react-hooks/exhaustive-deps

  const push = useCallback((next: TNode) => {
    if (pre.current === null) pre.current = JSON.stringify(tree)
    setTree(next); setDirty(true); scheduleSave(next)
  }, [tree, scheduleSave]) // eslint-disable-line react-hooks/exhaustive-deps

  const edit = useCallback((id: string, patch: Partial<TNode>) => {
    if (!tree) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const n = findNode(t, id); if (!n) return
    Object.assign(n, patch)
    push(t)
  }, [tree, push])

  /* 换节点的「块类型」。改的是提示字段，**不动 text** —— 正文永远是唯一真相，
     type 只是「这块该怎么画」。所有导出（md/opml/json）读的都是 text，
     所以换个类型不会影响同步出去给别的软件的内容。 */
  const setType = useCallback((id: string, ty: NodeType) => {
    edit(id, { type: ty })
    setMenu(null)
  }, [edit])

  const addChild = useCallback((id: string) => {
    if (!tree) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const n = findNode(t, id); if (!n) return
    n.children = n.children || []
    const kid: TNode = { id: nid(), text: '新分支', col: '', children: [] }
    n.children.push(kid); setFold((f) => { const x = { ...f }; delete x[id]; return x })
    push(t); setSel(kid.id)
  }, [tree, push])

  /* 带正文建子节点 —— 插图用（开发文档 6.1）。跟 addChild 同一套动作，
     只是文本由调用方给：插图进去的就是一整个 `![说明](路径)` 节点。 */
  const addChildText = useCallback((id: string, text: string) => {
    if (!tree || !text) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const n = findNode(t, id); if (!n) return
    n.children = n.children || []
    const kid: TNode = { id: nid(), text, col: '', children: [] }
    n.children.push(kid); setFold((f) => { const x = { ...f }; delete x[id]; return x })
    push(t); setSel(kid.id)
  }, [tree, push])

  /* ── 图片进画布 ──────────────────────────────────────────────
     两条例矩（开发文档 6.1）：
     - 画布挂在文件型笔记上 → 图必须先落进笔记旁 assets/（note_asset_put，
       哈希查重），md 里写相对引用 assets/<哈希>.<扩展名>。/shots/ 直链
       写回 Obsidian 就是死链，这条路绝不走。
     - 本机画布 → 素材库的图直接写 /shots/ 直链；上传的新图落 data/assets/。
     插的位置：选中节点的下一个孩子；没选中就挂到根上。 */
  async function insertImage(x: { title?: string; url?: string; data?: string }) {
    const host = sel || tree?.id
    if (!host) { say('画布还没建好'); return }
    try {
      let text = ''
      if (FILE_SRC_SET.has(src)) {
        let dataUrl = x.data
        if (!dataUrl && x.url) {
          const r = await fetch(x.url)
          if (!r.ok) { say('图取不回来：' + r.status); return }
          const b = await r.blob()
          dataUrl = await new Promise<string>((res) => {
            const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b)
          })
        }
        if (!dataUrl) { say('没有图可插'); return }
        const res = await callTool('note_asset_put', { map_id: mapId || undefined, data: dataUrl }, { write: true })
        const d: any = res.data || {}
        if (!res.ok || !d.ok) { say('图没落盘：' + (d.error || res.error || '未知原因')); return }
        text = '![' + (x.title || '图片') + '](' + d.rel + ')'
        say(d.existed ? '这张图早就在 assets/ 里了，直接引用，没重复存' : '图已写进笔记旁 assets/，回写时跟着走')
      } else {
        if (x.url && !x.data) {
          text = '![' + (x.title || '图片') + '](' + x.url + ')'
        } else {
          if (!x.data) { say('没有图可插'); return }
          const res = await callTool('note_asset_put', { data: x.data }, { write: true })
          const d: any = res.data || {}
          if (!res.ok || !d.ok) { say('图没落盘：' + (d.error || res.error || '未知原因')); return }
          text = '![' + (x.title || '图片') + '](' + d.url + ')'
        }
        say('已插进画布')
      }
      addChildText(host, text)
      setShowGal(false)
    } catch (e: any) {
      say('插图失败：' + (e?.message || e))
    }
  }

  async function uploadImage(f: File) {
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(String(fr.result))
      fr.onerror = () => rej(new Error('读不出这个文件'))
      fr.readAsDataURL(f)
    })
    await insertImage({ title: f.name.replace(/\.[a-z0-9]+$/i, ''), data: dataUrl })
  }

  const addSibling = useCallback((id: string) => {
    if (!tree) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const p = findParent(t, id); if (!p) return
    const kid: TNode = { id: nid(), text: '新分支', col: '', children: [] }
    p.children = p.children || []
    p.children.splice(p.children.findIndex((c) => c.id === id) + 1, 0, kid)
    push(t); setSel(kid.id)
  }, [tree, push])

  const del = useCallback((id: string) => {
    if (!tree) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const p = findParent(t, id); if (!p) return
    p.children = (p.children || []).filter((c) => c.id !== id)
    push(t); setSel(p.id)
  }, [tree, push])

  /* 原地编辑提交：空内容照样保存，但存成空串（显示层统一给「（空节点）」占位）。
     走 edit → push，撤销栈照旧能退回来。 */
  const commitText = useCallback((id: string, text: string) => {
    setEditing(null)
    const n = tree ? findNode(tree, id) : null
    if (!n) return
    const v = String(text ?? '').replace(/\n+$/, '')
    if (v === (n.text || '')) return          // 没改就不进撤销栈
    edit(id, { text: v })
  }, [tree, edit])
  const cancelEdit = useCallback(() => setEditing(null), [])

  /* 备注保存：和标题一条路，走 edit → push。空串直接存空串（等价于删备注），
     显示层看 note 有没有 trim 过的内容来决定要不要挂角标。 */
  const saveNote = useCallback((id: string, note: string) => {
    setEditing(null)
    const n = tree ? findNode(tree, id) : null
    if (!n) return
    const v = String(note ?? '').replace(/\n+$/, '')
    if (v === (n.note || '')) return
    edit(id, { note: v })
  }, [tree, edit])

  /* 工具条的折叠开关：折叠表在 Canvas 这边，节点里读不到，所以包一层。 */
  const toggleFold = useCallback((id: string) => {
    setFold((f) => { const x = { ...f }; if (x[id]) delete x[id]; else x[id] = 1; return x })
  }, [])

  /* 换版面：只改模式，不动 pos —— 拖过的节点留在原地，这是「我的图我说了算」。
     想让它们归位是「整理」的事，两件事别混成一个按钮。 */
  const pickLayout = useCallback((m: LayoutMode) => {
    setMdMode(m)
    try { localStorage.setItem(LS_LAYOUT, m) } catch { /* 存不进去也不影响这次切换 */ }
    // 布局一变，视口里原来的取景框就没意义了：等节点重建完再重新框一次。
    window.setTimeout(() => rfRef.current?.fitView({ padding: 0.18, duration: 320 }), 60)
  }, [])

  /* 整理：清掉手动位置，回到纯自动布局。
     清完立刻 fitView —— 放射布局是从原点长出去的，不重新取景会跑到窗口外。
     pos 不进撤销栈（它本来就只是「视觉微调」，不写进树，也不存盘）。 */
  const tidy = useCallback(() => {
    setPos({})
    window.setTimeout(() => rfRef.current?.fitView({ padding: 0.18, duration: 320 }), 60)
  }, [])

  /* 迷你地图开关：状态在这里，偏好存本机。存不进去（隐私模式）也照开不误 ——
     这个开关只影响眼前这一屏，不存也没啥可惜的。 */
  const toggleMiniMap = useCallback(() => {
    setMiniMap((v) => { lsSetFlag(LS_MINIMAP, !v); return !v })
  }, [])

  /* 批量上色：工具条和右键菜单都走这里。col 空串 = 清掉颜色。
     以前这里是 window.prompt 问色值 —— 右键菜单早换成色板了，节点工具条还弹系统框，
     同一个动作两套交互太割裂，所以改成直接收一个颜色参数，由调用方给（色板值）。 */
  const setColFor = useCallback((ids: string[], col: string) => {
    if (!tree || !ids.length) return
    const v = String(col ?? '').trim()
    const t: TNode = JSON.parse(JSON.stringify(tree))
    let hit = false
    for (const id of ids) {
      const nd = findNode(t, id)
      if (!nd) continue
      if ((nd.col || '') === v) continue
      nd.col = v
      hit = true
    }
    if (!hit) return                       // 颜色没变就不进撤销栈
    push(t)
  }, [tree, push])

  const delMany = useCallback((ids: string[]) => {
    if (!tree || !ids.length) return
    const gone = new Set(ids.filter((x) => x !== tree.id))
    const inside = (id: string, acc: Set<string>): boolean => {
      let p = findParent(tree, id)
      while (p) { if (acc.has(p.id)) return true; p = findParent(tree, p.id) }
      return false
    }
    // 子孙已经在待删集合里的，单独摘一次是多余的（父被删时自然消失）
    const roots = [...gone].filter((id) => !inside(id, gone))
    const t: TNode = JSON.parse(JSON.stringify(tree))
    for (const id of roots) {
      const p = findParent(t, id); if (!p) continue
      p.children = (p.children || []).filter((c) => c.id !== id)
    }
    push(t)
    const first = roots[0] ? findParent(tree, roots[0]) : null
    setSel0(first && !gone.has(first.id) ? first.id : t.id)
  }, [tree, push])

  /* ── 右键菜单 + 节点级操作（task-1） ──────────────────────────────
     菜单内容在 Canvas 这边生成：只有它知道当前的树、选中集合和折叠态。
     ContextMenu 组件只管画和收键，所有改树动作走 push（撤销栈 + 900ms 落库）。 */
  const [menu, setMenu] = useState<MenuState | null>(null)

  /* 同级排序：在父的 children 里跟相邻兄弟 swap。
     按数组顺序换一格，不跳折叠的 —— 折叠只影响「看不看得见」，
     不影响「在文件里是第几个」；跳着换会让点一次上移跨过一串节点。 */
  const moveSib = useCallback((id: string, d: -1 | 1) => {
    if (!tree) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const p = findParent(t, id); if (!p) return
    const kids = p.children || []
    const i = kids.findIndex((c) => c.id === id); if (i < 0) return
    const j = i + d
    if (j < 0 || j >= kids.length) return
    const tmp = kids[i]; kids[i] = kids[j]; kids[j] = tmp
    push(t); setSel(id)
  }, [tree, push])

  /* 「只留这一支」：把它的所有兄弟摘掉，自己连同子孙原样留着。
     根节点没有兄弟，也不许把自己摘掉 —— 菜单里那一项直接禁用。 */
  const onlyBranch = useCallback((id: string) => {
    if (!tree || id === tree.id) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const p = findParent(t, id); if (!p) return
    const kept = (p.children || []).filter((c) => c.id === id)
    if (!kept.length || kept.length === (p.children || []).length) return
    p.children = kept
    push(t); setSel(id)
  }, [tree, push])

  const copyNode = useCallback((id: string) => {
    if (!tree) return
    const n = findNode(tree, id); if (!n) return
    const strip = (x: TNode): any => ({
      text: x.text, col: x.col || '', note: x.note,
      children: (x.children || []).map(strip),
    })
    setClip(strip(n))
  }, [tree])

  /* 粘贴：深拷贝 + 重发整棵子树的 id。给了 target 就当它的子节点，
     没给（空白处右键）就挂到根上。 */
  const pasteNode = useCallback((targetId?: string | null) => {
    if (!tree) return
    const clip = getClip()
    if (!clip) { say('剪贴板是空的：先在节点上「复制节点」'); return }
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const host = findNode(t, targetId && targetId !== t.id ? targetId : t.id) || t
    const kid = cloneWithNewIds(clip, nid) as TNode
    if (!kid) return
    host.children = host.children || []
    host.children.push(kid)
    if (targetId && targetId !== t.id) setFold((f) => { const x = { ...f }; delete x[targetId]; return x })
    push(t); setSel(kid.id)
    setMsg('已粘贴到「' + (host.text || '根节点').slice(0, 12) + '」下面')
  }, [tree, push])

  /* 批量折叠：全折或全展。批量里只要有一个还开着，就是「折叠」。 */
  const foldMany = useCallback((ids: string[], mode: 'fold' | 'open') => {
    setFold((f) => {
      const x = { ...f }
      for (const id of ids) {
        const n = tree ? findNode(tree, id) : null
        if (!n || !(n.children || []).length) continue    // 没子节点的折不了
        if (mode === 'fold') x[id] = 1; else delete x[id]
      }
      return x
    })
  }, [tree])
  const foldAll = useCallback((mode: 'fold' | 'open') => {
    if (!tree) return
    if (mode === 'open') { setFold({}); return }
    const x: Record<string, 1> = {}
    walkAll(tree, (n, _p, depth) => { if (depth > 0 && (n.children || []).length) x[n.id] = 1 })
    setFold(x)
  }, [tree])

  /* 按固定颜色值染一批（不走 setColFor 那个 prompt —— 菜单里已经选了色） */
  const paint = useCallback((ids: string[], col: string) => {
    if (!tree || !ids.length) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    for (const id of ids) { const nd = findNode(t, id); if (nd) nd.col = col }
    push(t)
  }, [tree, push])

  /* commit 是撤销栈的唯一写入口：state 与 ref 一次写完，绝不允许谁绕过它 setHi，
     否则防抖回调里的 ref 和屏幕上的按钮状态会各说各话（按钮亮着、点了没反应）。 */
  const commit = useCallback((stack: string[], at: number) => {
    histRef.current = stack; hiRef.current = at
    setHist(stack); setHi(at)
  }, [])

  const undo = useCallback(() => {
    const h = histRef.current, at = hiRef.current
    if (at <= 0) return
    const t: TNode = JSON.parse(h[at - 1])
    /* pre.current 必须设成「撤销后这一版」，不能置 null。
       置 null 只挡住「下一次改动入栈」，但 scheduleSave 里那次 note_save 照旧跑；
       等它回来 list.run() 刷新，编辑器如果跟着重挂，栈就被重置成一跳 ——
       表现是「连按两次撤销，第二次才是真退」。这里把它钉成当前版本，
       于是「没改动」判断成立，既不写盘也不会把栈冲掉。 */
    pre.current = h[at - 1]
    setTree(t); commit(h, at - 1); setDirty(false)
    callTool('note_save', { lesson_id: lid, title, tree: t, src }, { write: true }).then(() => list.run())
  }, [lid, title, src, list])
  const redo = useCallback(() => {
    const h = histRef.current, at = hiRef.current
    if (at >= h.length - 1) return
    const t: TNode = JSON.parse(h[at + 1])
    pre.current = h[at + 1]
    setTree(t); commit(h, at + 1); setDirty(false)
    callTool('note_save', { lesson_id: lid, title, tree: t, src }, { write: true }).then(() => list.run())
  }, [lid, title, src, list])

  // ---- 派生节点与连线 ----
  /* laid 里每个节点带自己的宽度（按文字估的，190~360）和盒子高度。
     换布局只改坐标；拖过的节点因为 pos 覆盖优先，压根不动。 */
  const laid = useMemo(() => (tree ? layout(tree, mdMode, fold, pos) : []), [tree, mdMode, fold, pos])
  /* 备注浮层展开时，被它盖住的节点要**让开**。
     浮层现在挂在节点侧面，但画布上节点密的时候仍会压到邻居 —— 压住了就等于
     遮住了别人正在对着看的内容。这里的做法是：测出浮层在屏幕上的矩形，
     凡是跟它相交的节点，整支往上/下推开够用的距离；浮层收起后偏移清零，
     节点自己滑回原位（动画由 .react-flow__node 的 transition 给出）。
     偏移只加在渲染坐标上，不写进 tree、不进撤销栈 —— 它不是内容改动。 */
  /* 备注浮层一开一关，避让就得重算一次。用计数而不是直接用 editing 对象：
     editing 是个新对象，每次渲染都不同，会带着 useMemo 每帧重算；
     计数只在「备注编辑态真的开了/关了」时 +1，其余时候稳定。 */
  const [noteTick, setNoteTick] = useState(0)
  const prevNoteEdit = useRef<string>('')
  const nowNoteEdit = editing?.mode === 'note' ? (editing.id || '') : ''
  if (nowNoteEdit !== prevNoteEdit.current) {
    prevNoteEdit.current = nowNoteEdit
    setNoteTick((n) => n + 1)
  }

  const [dodge, setDodge] = useState<Record<string, number>>({})
  const dodgeFor = useMemo(() => {
    const out: Record<string, number> = {}
    if (!laid.length) return out
    const el = document.querySelector('[data-note-for]:not([data-note-for=""])') as HTMLElement | null
    if (!el) return out
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return out
    for (const p of laid) {
      const ne = document.querySelector('.react-flow__node[data-id="' + CSS.escape(p.id) + '"]') as HTMLElement | null
      if (!ne) continue
      const b = ne.getBoundingClientRect()
      const hit = b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom
      if (!hit) continue
      // 往上推还是往下推：看节点在浮层的哪一半，就近让开，位移最小
      const up = (b.top + b.height / 2) < (r.top + r.height / 2)
      out[p.id] = up ? -(r.bottom - b.top + 12) : (r.bottom - b.top + 12)
    }
    return out
  }, [laid, noteTick])
  useMemo(() => {
    setDodge((prev) => {
      const a = JSON.stringify(prev), b = JSON.stringify(dodgeFor)
      return a === b ? prev : dodgeFor
    })
  }, [dodgeFor])
  /* 图片块的预览基址：文件型来源的画布借 /noteimg/<来源> 读原文件（引用式）；
     本机画布的图都在 /shots /assets 下，绝对路径，用不着它。 */
  const imgBase = FILE_SRC_SET.has(src) ? '/noteimg/' + src : ''
  const boxes = useMemo(() => {
    const m: Record<string, { w: number; h: number }> = {}
    laid.forEach((p) => { m[p.id] = { w: p.w, h: p.h } })
    return m
  }, [laid])
  const nodes: Node[] = useMemo(() => {
    if (!tree) return []
    const byId: Record<string, TNode> = {}
    walkAll(tree, (x) => { byId[x.id] = x })
    return laid.map((p) => {
      const n = byId[p.id]
      const kids = (n.children || []).length
      /* 避让偏移：有就加上，没有就是 0。
         它只改渲染坐标，不写 tree、不进撤销栈 —— 节点让开不是内容改动，
         进了栈的话「撤销」会把节点挪回去，人以为自己的编辑被吞了。 */
      const dy = dodge[p.id] || 0
      return {
        id: p.id, type: 'mind', position: { x: p.x, y: p.y + dy },
        /* 尺寸：只给 width/height 让 ReactFlow 知道首帧参考值，**不写 style**。
           写 style 会把外层 wrapper 钉死，而内层 .cvnode 是按内容自适应的 ——
           两套宽度一冲突，ReactFlow 算多选包围盒时就偏，框会框不住节点。
           让它自己量，量出来多少就是多少，包围盒和可见范围永远一致。 */
        width: p.w, height: p.h,
        selected: selSet.includes(p.id),
        data: {
          text: n.text, note: n.note, col: n.col || '', depth: p.depth, fold: !!fold[p.id] && p.depth > 0, kids,
          /* side 必须传下去：MindNode 靠它决定入边/出边开在哪一侧。
             不传的话左支节点的 Handle 全在右边，线就会从右腰出发绕一大圈回来。 */
          side: p.side,
          isRoot: p.depth === 0,
          /* 整张画布选了几个：>1 时节点自己那条工具条要让位给跟手那条。 */
          multi: selSet.length,
          /* type 要传下去：代码块/表格/公式的排法跟纯文字不一样。
             没存 type 的老画布也不会错 —— MindNode 会按正文重新认一次。 */
          type: n.type || typeOf(n),
          imgBase,
          busy: !!editing && editing.id === p.id && editing.mode === 'text',
          noteEditing: !!editing && editing.id === p.id && editing.mode === 'note',
          pop: pop && pop.id === p.id ? pop.kind : null,
          onAddChild: addChild, onAddSibling: addSibling, onToggleFold: toggleFold,
          onColor: (id: string) => setPop((c) => (c && c.id === id ? null : { id, kind: 'color' })),
          onPickColor: (id: string, col: string) => setColFor([id], col),
          onClosePop: () => setPop(null),
          onDelete: (id: string) => delMany([id]),
          onNote: (id: string) => setEditing({ id, mode: 'note' }),
          onCommit: commitText, onCancel: cancelEdit,
          /* 打字中：只把值写进 tree，不结束编辑、不关编辑框。
             这样画布那道 900ms 防抖的自动保存才真的会跑 —— 否则写一半切走就没了。 */
          onLiveText: (id: string, v: string) => {
            const t = treeRef.current
            if (!t) return
            const nd = findNode(t, id)
            if (!nd || nd.text === v) return
            const nt: TNode = JSON.parse(JSON.stringify(t))
            const nx = findNode(nt, id)
            if (nx) nx.text = v
            push(nt)
          },
          onSaveNote: saveNote, onCloseNote: () => setEditing(null),
        } as MindData,
        draggable: true,
      } as Node
    })
  }, [laid, tree, fold, selSet, editing, pop, addChild, addSibling, toggleFold, setColFor, delMany, commitText, cancelEdit, saveNote, imgBase, dodge])
  const edges: Edge[] = useMemo(() => {
    if (!tree) return []
    const out: Edge[] = []
    const visible = new Set(laid.map((l) => l.id))
    const depthOf: Record<string, number> = {}
    const sideOf: Record<string, 1 | -1> = {}
    laid.forEach((l) => { depthOf[l.id] = l.depth; sideOf[l.id] = l.side })
    const type = 'mind'
    walkAll(tree, (n) => {
      if (!visible.has(n.id)) return
      if (fold[n.id]) return
      ;(n.children || []).forEach((c) => {
        if (!visible.has(c.id)) return
        /* 连线宽度随层级变：从中心主题出去的主枝最粗，往下越来越细。
           全篇 1px 灰线的时候整张图是「蛛网」，看不出哪儿是主干。
           ReactFlow 的默认边样式写在 style 里最稳 —— 改 CSS 里那条
           .react-flow__edge-path 会被它的行内样式盖掉。 */
        const dp = depthOf[n.id] ?? 1
        const w = dp === 0 ? 3 : dp === 1 ? 1.8 : 1.2
        const col = dp === 0 ? 'rgba(255,176,32,.45)' : dp === 1 ? 'var(--line2)' : 'rgba(61,55,44,.75)'
        /* 必须显式点明两个 Handle 的 id：节点上有 t/s 两个，不写的话
           ReactFlow 会自己挑一个，左支的线就从右腰出去、横穿整块节点。
           sideOf 记的是子节点朝哪边长，跟 MindNode 里选 Handle 用的是同一份数据。 */
        const kidSide = sideOf[c.id] ?? 1
        const isRootSrc = (depthOf[n.id] ?? 1) === 0
        /* 根节点左右各一个源点，按子节点在哪边挑；别的节点只有一个。
           竖树/放射走底部那个 —— 否则线从腰上出去，看着像横插一杠。 */
        const sh = isRootSrc
          ? (kidSide === -1 ? 's-l' : 's-r')
          : (mdMode === 'mind' ? 's' : 's-b')
        out.push({
          id: n.id + '>' + c.id, source: n.id, target: c.id, type, animated: false,
          sourceHandle: sh, targetHandle: 't',
          style: { stroke: col, strokeWidth: w },
        })
      })
    })
    return out
  }, [tree, laid, fold, mdMode])

  // ReactFlow 必须走它自己的状态：直接传受控数组时它量不到节点尺寸，连线画不出来
  const [rfNodes, setRfNodes, rfOnNodesChange] = useNodesState([] as Node[])
  const [rfEdges, setRfEdges] = useEdgesState([] as Edge[])
  /* ── 回灌 ReactFlow 的两个口子，防 #185 的闸门就在这里 ──────────────
     症状：点开一张画布整个页面白掉，控制台 React #185（Maximum update
     depth exceeded）。成因不是「谁 setState 传了函数」，而是这几条同时成立：
       1) nodes 每次都新建对象 → 触发下面的 setRfNodes；
       2) setRfNodes 更新 ReactFlow 自己的 store → 它内部 sync 一次 → 再渲染一次；
       3) 渲染期又在算 count / selNode 这类普通变量，并塞进 node.data 的闭包里
          —— 每次都是新函数；editing / pop 一变，nodes 必然重建。
     结果就是「进入编辑视图的那一帧又触发回灌」的自激。
     闸门做法：用内容签名去重。签名没变就压根不 setState，循环断在第一步。
     （别改成「给 ReactFlow 传受控数组」—— 那样它量不到节点尺寸，连线画不出来。） */
  /* 签名里必须带上「这个节点是不是正在编辑」 —— 否则双击后 nodes 重建了、
     签名却一个字符没变，闸门把这次回灌挡掉，ReactFlow 手上还是旧的 data，
     textarea 永远不出现。（坑找了很久：editing 明明 setState 了，DOM 里
     节点的 class 还是原来那份。）多选条 / pop 同理，一并进签名。 */
  const rfSig = useMemo(() => nodes.map((x) => x.id + ':' + (x.selected ? 1 : 0) + ':' +
    (x.position?.x ?? 0) + ',' + (x.position?.y ?? 0) + ':' + (x.width ?? 0) + 'x' + (x.height ?? 0) + ':' +

    /* type 必须进签名：不进的话点「换类型」之后 nodes 重建、签名没变，
       闸门把这次回灌挡掉，节点还画成原来那一型（跟之前 editing 那个坑同源）。 */
    (x.data?.type || '') + ':' +
    (x.data?.busy ? 'e' : '') + (x.data?.noteEditing ? 'n' : '') + (x.data?.pop || '') + ':' + (x.data?.multi ?? 0))
    .join('|'), [nodes])
  useEffect(() => { setRfNodes(nodes) }, [rfSig]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRfEdges(edges) }, [edges]) // eslint-disable-line react-hooks/exhaustive-deps



  /* 菜单里执行的动作与「当前树/选中」都是渲染期最新的一份，
     但菜单是从 portal 里点出来的，回调可能在下一帧才跑 ——
     用 ref 取最新版，避免闭包里读到上一次的 tree 或空集合。 */
  const menuRef = useRef<MenuState | null>(null); menuRef.current = menu
  const setMenuRef = useRef(setMenu); setMenuRef.current = setMenu
  const moveRef = useRef(moveSib); moveRef.current = moveSib
  const onlyRef = useRef(onlyBranch); onlyRef.current = onlyBranch
  const pasteRef = useRef(pasteNode); pasteRef.current = pasteNode
  const copyRef = useRef(copyNode); copyRef.current = copyNode
  const paintRef = useRef(paint); paintRef.current = paint
  const foldManyRef = useRef(foldMany); foldManyRef.current = foldMany
  const foldAllRef = useRef(foldAll); foldAllRef.current = foldAll
  const setSelRef = useRef(setSel); setSelRef.current = setSel
  const setSelManyRef = useRef(setSelMany); setSelManyRef.current = setSelMany
  const delManyRef = useRef(delMany); delManyRef.current = delMany
  const addChildRef = useRef(addChild); addChildRef.current = addChild
  const closeMenu = useCallback(() => { setMenu(null) }, [])

  /* ── 右键：节点 / 多选 / 空白 三条路 ─────────────────────────────
     千万别给 ReactFlow 挂 onSelectionChange 把这些回写进去 —— 那是 React #185
     （Maximum update depth exceeded）的来源。这里只挂 contextmenu，只写不回读。 */
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    e.stopPropagation()
    const cur = selectionRef.current
    const inSet = cur.set.includes(node.id)
    // 右键点在已选的集合里 → 保留整批（批量菜单）；点在集合外 → 改成只选它
    if (!inSet) setSel(node.id)
    const multi = inSet && cur.set.length > 1
    setMenu({ x: e.clientX, y: e.clientY, kind: multi ? 'multi' : 'node' })
  }, [setSel])

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault()
    const me = e as React.MouseEvent
    setMenu({ x: me.clientX, y: me.clientY, kind: 'pane' })
  }, [])

  /* build 用 useCallback 包住：ContextMenu 里拿它当 useMemo 的依赖，
     每次渲染给一个新函数等于每帧重建整张菜单。 */
  const buildMenu = useCallback((m: MenuState): any[] => {
    const t = treeRef.current
    if (m.kind === 'pane') {
      return [
        { key: 'new', label: '新建节点', hint: 'Tab', icon: 'plus', run: () => {
          const id = t?.id
          if (id) addRef.current.child(id)
        } },
        { key: 'paste', label: '粘贴到根节点', hint: 'Ctrl+V', icon: 'node', run: () => pasteRef.current(null) },
        { key: 's1', sep: true },
        { key: 'fit', label: '适应窗口', icon: 'fit', run: () => rfRef.current?.fitView({ padding: 0.18, duration: 240 }) },
        { key: 'open', label: '全部展开', icon: 'down', run: () => foldAllRef.current('open') },
        { key: 'fold', label: '全部折叠', icon: 'chev', run: () => foldAllRef.current('fold') },
      ]
    }
    const ids = selectionRef.current.set
    const one = ids.length === 1 ? ids[0] : (selectionRef.current.sel || '')
    if (m.kind === 'multi') {
      return [
        { key: 'h', label: `已选 ${ids.length} 个节点`, disabled: true },
        { key: 's0', sep: true },
        { key: 'color', label: '批量上色', icon: 'tag', sub: MENU_COLORS.map((c) => ({
          key: 'c' + c.v, label: c.name, sw: c.v, run: () => paintRef.current(ids, c.v),
        })).concat([{ key: 'c0', label: '清除颜色', sw: '', run: () => paintRef.current(ids, '') } as any]) },
        { key: 'fold', label: '批量折叠', icon: 'chev', run: () => foldManyRef.current(ids, 'fold') },
        { key: 'open', label: '批量展开', icon: 'down', run: () => foldManyRef.current(ids, 'open') },
        { key: 's1', sep: true },
        { key: 'cancel', label: '取消选择', icon: 'x', run: () => setSelRef.current(null) },
        { key: 'del', label: `删除这 ${ids.length} 个`, hint: 'Del', icon: 'trash', danger: true,
          run: () => delManyRef.current(ids) },
      ]
    }
    if (!one || !t) return [{ key: 'none', label: '这张画布还是空的', disabled: true }]
    const nd = findNode(t, one)
    const isRoot = !!t && one === t.id
    const kids = (nd?.children || []).length
    const folded = !!fold[one]
    return [
      { key: 'text', label: '改字', hint: '双击', icon: 'writing', run: () => {
        // 走原地编辑器，不再弹 prompt（task-2）
        setSel(one)
        setEditing({ id: one, mode: 'text' })
      } },
      { key: 's1', sep: true },
      { key: 'child', label: '加子节点', hint: 'Tab', icon: 'plus', run: () => addRef.current.child(one) },
      { key: 'sib', label: '加同级', hint: 'Enter', icon: 'node', disabled: isRoot, run: () => addRef.current.sib(one) },
      { key: 's2', sep: true },
      { key: 'up', label: '上移', icon: 'down', disabled: isRoot, run: () => moveRef.current(one, -1) },
      { key: 'dn', label: '下移', icon: 'down', disabled: isRoot, run: () => moveRef.current(one, 1) },
      { key: 's3', sep: true },
      { key: 'color', label: '上色', icon: 'tag', sub: MENU_COLORS.map((c) => ({
        key: 'c' + c.v, label: c.name, sw: c.v, run: () => paintRef.current([one], c.v),
      })).concat([{ key: 'c0', label: '清除颜色', sw: '', run: () => paintRef.current([one], '') } as any]) },
      { key: 'fold', label: folded ? '展开子级' : '折叠子级', icon: folded ? 'down' : 'chev',
        disabled: !kids, run: () => foldManyRef.current([one], folded ? 'open' : 'fold') },
      { key: 's4', sep: true },
      { key: 'type', label: '换类型', icon: 'gal',
        hint: BLOCK_TYPES.find((t) => t.v === typeOf(nd || {}))?.name || '文字',
        sub: BLOCK_TYPES.map((t) => ({
          key: 't' + t.v, label: t.name, hint: t.hint, icon: t.icon,
          run: () => setTypeRef.current(one, t.v),
        })) },
      { key: 'copy', label: '复制节点', hint: 'Ctrl+C', icon: 'md', run: () => copyRef.current(one) },
      { key: 'paste', label: '粘贴为子节点', hint: 'Ctrl+V', icon: 'node', run: () => pasteRef.current(one) },
      { key: 'only', label: '只留这一支', icon: 'star', disabled: isRoot, run: () => onlyRef.current(one) },
      { key: 's5', sep: true },
      { key: 'del', label: '删除节点', hint: 'Del', icon: 'trash', danger: true, disabled: isRoot,
        run: () => delManyRef.current([one]) },
    ]
  }, [tree, fold, editing, setSel])

  /* ── 拖节点：整棵子树一起走 ───────────────────────────────────────
     以前 onNodeDragStop 只落被拖那一个的坐标，子孙留在原地 —— 父节点走了，
     子节点没走，连线从父节点拉到天边，看着就像「拖了没用」。
     做法：**起点快照 + delta**，不累加。dragStart 时把「被拖节点 + 它的全部后代」
     的坐标存进 dragRef；drag 每帧按同一个 delta 重算；dragStop 时一次性写回 pos。
     参考 brainstorming-vue/useCanvasInteraction.ts:171-191 的做法（它默认不动子树，
     但 delta 那段是对的）；我们要带子树，是因为 XMind 拖父主题就是整支走。 */
  const dragRef = useRef<{ ids: string[]; from: Record<string, { x: number; y: number }>; sx: number; sy: number } | null>(null)

  const onNodeDragStart = useCallback((_: any, node: Node) => {
    const host = tree ? findNode(tree, node.id) : null
    const ids = [node.id, ...(host ? subtreeIds(host) : [])]
    const from: Record<string, { x: number; y: number }> = {}
    laid.forEach((p) => { if (ids.includes(p.id)) from[p.id] = { x: p.x, y: p.y } })
    const ev = window.event as MouseEvent | undefined
    dragRef.current = { ids, from, sx: ev?.clientX ?? 0, sy: ev?.clientY ?? 0 }
  }, [tree, laid]) // eslint-disable-line react-hooks/exhaustive-deps

  const onNodeDrag = useCallback((_: any, node: Node) => {
    const st = dragRef.current
    if (!st) return
    const ev = window.event as MouseEvent | undefined
    if (!ev) return
    const zoom = rfRef.current?.getZoom() || 1
    const dx = (ev.clientX - st.sx) / zoom
    const dy = (ev.clientY - st.sy) / zoom
    setRfNodes((ns: Node[]) => ns.map((n: Node) => {
      const base = st.from[n.id]
      return base ? { ...n, position: { x: base.x + dx, y: base.y + dy } } : n
    }))
  }, [])

  const onNodeDragStop = useCallback((_: any, node: Node) => {
    const st = dragRef.current
    if (!st) { setPos((p) => ({ ...p, [node.id]: { x: node.position.x, y: node.position.y } })); return }
    const ev = window.event as MouseEvent | undefined
    const zoom = rfRef.current?.getZoom() || 1
    const dx = ev ? (ev.clientX - st.sx) / zoom : 0
    const dy = ev ? (ev.clientY - st.sy) / zoom : 0
    const next: Record<string, { x: number; y: number }> = {}
    st.ids.forEach((id) => {
      const base = st.from[id]
      if (base) next[id] = { x: base.x + dx, y: base.y + dy }
    })
    dragRef.current = null
    if (!Object.keys(next).length) return
    setPos((p) => ({ ...p, ...next }))
  }, [])

  /* ── 跨画布搜索 ───────────────────────────────────────────────
     现有的 find 只搜「手上这张树」，而人忘事的时候通常连在哪张画布都想不起来。
     所以这里按 note_list 给的 maps 逐张 note_load 去翻。
     两条硬约束：① 最多扫 20 张（工具调用是真后端，不设上限等于把页面打死）；
     ② 每张之间让出 90ms 并把进度写进 xres.done，界面上要看得出「还在扫」。 */
  useEffect(() => {
    if (!xmap || !find.trim()) { setXres(null); return }
    const q = find.trim().toLowerCase()
    const list20 = (list.data?.maps || []).slice(0, 20)
    if (!list20.length) { setXres({ id: '', title: '', rows: [], done: 0, total: 0 }); return }
    let alive = true
    setXbusy(true)
    setXres({ id: '', title: '', rows: [], done: 0, total: list20.length })
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    ;(async () => {
      const rows: { map: string; title: string; text: string; note?: string }[] = []
      for (let i = 0; i < list20.length; i++) {
        const m = list20[i]
        if (!alive) return
        if (rows.length < 80) {
          const r = await callTool('note_load', { lesson_id: m.lesson_id, src: m.src, src_id: m.src_id })
          const t: any = (r.data as any)?.tree
          const hitTitle = String(m.title || '').toLowerCase().includes(q)
          walkAll(t, (nd) => {
            if (rows.length >= 80) return
            const inText = (nd.text || '').toLowerCase().includes(q)
            if (inText || (nd.note || '').toLowerCase().includes(q) || (hitTitle && nd.id === t.id)) {
              rows.push({ map: m.id, title: m.title || '未命名', text: nd.text || '（空）', note: nd.note })
            }
          })
        }
        if (!alive) return
        setXres({ id: '', title: '', rows: [...rows], done: i + 1, total: list20.length })
        await sleep(90)
      }
      if (alive) setXbusy(false)
    })()
    return () => { alive = false }
  }, [xmap, find, list.data])

  // ---- 搜索 ----
  useEffect(() => {
    if (!tree || !find.trim()) { setHits([]); return }
    const q = find.trim().toLowerCase()
    const out: string[] = []
    walkAll(tree, (n) => { if ((n.text || '').toLowerCase().includes(q) || (n.note || '').toLowerCase().includes(q)) out.push(n.id) })
    setHits(out); setHitIx(0)
  }, [find, tree])

  // ---- Markdown 导入导出 ----
  async function importMd() {
    if (!mdText.trim()) return
    const r = await callTool('note_from_md', { text: mdText, title })
    const d: any = r.data || {}
    if (d.tree) { const t = d.tree; setTree(t); setDirty(true); commit([JSON.stringify(t)], 0); push(t) }
    setShowMd(false); setMdText('')
  }
  function exportMd(): string { return toMarkdown(tree) }

  /* 大纲里的 ← → ：改层级。
     ← 升一级 = 挂到爷爷节点下面（接在爸爸后面）；→ 降一级 = 挂到上一个兄弟下面。
     两种都做不到时什么都不改 —— 尤其不能把根节点挪走。 */
  const moveLevel = useCallback((id: string, dir: -1 | 1) => {
    if (!tree || id === tree.id) return
    const t: TNode = JSON.parse(JSON.stringify(tree))
    const p = findParent(t, id)
    if (!p) return
    const me = (p.children || []).find((c) => c.id === id)
    if (!me) return
    if (dir < 0) {
      const gp = findParent(t, p.id)
      if (!gp) return                        // 爸爸就是根，没地方挂
      p.children = (p.children || []).filter((c) => c.id !== id)
      gp.children = gp.children || []
      gp.children.splice(gp.children.findIndex((c) => c.id === p.id) + 1, 0, me)
    } else {
      const sibs = p.children || []
      const ix = sibs.findIndex((c) => c.id === id)
      const prev = sibs[ix - 1]
      if (!prev) return                      // 没有上一个兄弟，没法降级
      p.children = sibs.filter((c) => c.id !== id)
      prev.children = prev.children || []
      prev.children.push(me)
      setFold((f) => { const x = { ...f }; delete x[prev.id]; return x })
    }
    push(t); setSel(id)
  }, [tree, push, setSel])

  // 大纲点一行 / 搜到一条：选中 + 居中（画布上 node id 与树 id 是同一个）
  const focusNode = useCallback((id: string) => {
    setSel(id)
    const p = pos[id] || laid.find((l) => l.id === id)
    if (p) rfRef.current?.setCenter(p.x + 95, p.y + H / 2, { zoom: Math.max(1, zoom), duration: 280 })
  }, [laid, pos, setSel, zoom])

  /* 跨画布搜索点一条：先开那张画布，再让它的树挂上去。
     居中要等 ReactFlow 把新节点量出来之后才准 —— 这里等一小会儿再 center，
     否则会拿上一张画布的坐标系去居中，看起来像「跳错了地方」。 */
  const jumpTo = useCallback(async (m: MapRow, nodeId: string, hint?: string) => {
    if (m.id !== mapId) await openMap(m)
    if (nodeId) {
      setFold((f) => { const x = { ...f }; delete x[nodeId]; return x })
      setSel(nodeId)
      setTimeout(() => {
        const p = pos[nodeId] || laid.find((l) => l.id === nodeId)
        if (p) rfRef.current?.setCenter(p.x + 95, p.y + H / 2, { zoom: 1, duration: 280 })
      }, 260)
    } else if (hint) {
      // 跨画布结果只带文本：在树上把同名节点找回来再居中（找不到就只选中第一处）
      setTimeout(() => {
        const tr = treeRef.current
        if (!tr) return
        let got = ''
        walkAll(tr, (nd) => { if (!got && (nd.text || '') === hint) got = nd.id })
        const all: string[] = []
        walkAll(tr, (nd) => { if (!got && (nd.text || '').toLowerCase().includes(hint.toLowerCase())) all.push(nd.id) })
        const target = got || all[0]
        if (target) {
          setSel(target)
          const l = laid.find((x) => x.id === target)
          if (l) rfRef.current?.setCenter(l.x + 95, l.y + H / 2, { zoom: 1, duration: 280 })
        }
      }, 300)
    }
  }, [mapId, openMap, setSel, pos, laid])

  /* 六种导出走同一个下载口：TextEncoder 出字节，别再让中文字符串直接进 Blob ——
     那样每种格式都要自己声明 charset 才不乱码。 */
  function saveFile(name: string, content: string, mime: string) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([new TextEncoder().encode(content)], { type: mime }))
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }
  async function exportPng() {
    const svg = buildSvg()
    if (!svg) { say('画布是空的，没什么可导出'); return }
    const r = await rasterSvg(svg, 2)
    if (!r) { setMsg('PNG 没画出来'); return }
    const url = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = url; a.download = safeName(title) + '.png'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    setMsg('已导出 ' + r.w + '×' + r.h + ' 的 PNG')
  }
  function runExport(k: string) {
    setShowExp(false)
    const nm = safeName(title)
    if (k === 'md') saveFile(nm + '.md', exportMd(), 'text/markdown;charset=utf-8')
    else if (k === 'opml') saveFile(nm + '.opml', toOpml(tree, title), 'text/x-opml;charset=utf-8')
    else if (k === 'txt') saveFile(nm + '.txt', toIndentText(tree), 'text/plain;charset=utf-8')
    else if (k === 'json') saveFile(nm + '.json', toJson(tree, title), 'application/json;charset=utf-8')
    else if (k === 'svg') saveFile(nm + '.svg', buildSvg(), 'image/svg+xml;charset=utf-8')
    else if (k === 'png') exportPng()
  }
  function download(name: string, text: string, mime = 'text/plain;charset=utf-8') {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: mime }))
    a.download = name; a.click(); URL.revokeObjectURL(a.href)
  }
  // 画布的完整 SVG。导出和截图共用同一份 —— 两条路出来的图必须长得一样。
  // 只用 rect / text / path，绝不用 foreignObject：那个会污染 canvas，toBlob 直接抛错。
  /* 导出与截图共用一份实现（canvas/svgout.ts）。
     以前这里自带一套画法，屏幕改了导出没跟上 —— 收藏出来的图和眼前看到的不是一个东西。 */
  function buildSvg(): string {
    if (!tree) return ''
    return svgOf(laid, tree, mdMode, fold, String(title || ''))
  }

  // 把这张导图拍成 PNG 存进截图库（按学科分）。盘上的图由 /shots/ 代理出去。
  async function shotNow() {
    if (shotBusy) return
    const svg = buildSvg()
    if (!svg) { say('画布是空的，没什么可截'); return }
    setShotBusy(true)
    try {
      const r = await rasterSvg(svg, 2)
      if (!r) { say('截图失败：图没画出来'); return }
      const b64 = await blobToB64(r.blob)
      const res = await callTool('shot_save', {
        data: b64, subject: curSubject(), lesson_id: lid || null,
        title: String(title || '未命名画布').slice(0, 40), w: r.w, h: r.h, tag: 'canvas',
      }, { write: true })
      const d: any = res.data || {}
      if (!res.ok) { say('存失败：' + (res.error || d.error || '未知原因')); return }
      say('已存进「' + SUBJNAME[curSubject()] + '」 · 现在有 ' + (d.count ?? 0) + ' 张')
      // 存完顺手把顶栏切到「图库」—— 刚拍的那张就在最前面，人马上能核对。
      // 左栏的 leftTab 是「画布列表 / 大纲」，跟图库不是一回事，别混。
      setTab('shot')
      loadGal()
    } finally {
      setShotBusy(false)
    }
  }

  const selNode = tree && sel ? findNode(tree, sel) : null
  const n = tree ? countNodes(tree) : 0
  const count = selSet.length || (sel ? 1 : 0)

  /* 顶栏归壳：这一页不放自己的工具栏，一行都不放。
     原来「身份行 + 动作行」占 98px，把舞台压到只剩 654px；现在整条工具条
     并进研学台那条 56px 的 top，舞台拿回 100px。
     画布是唯一一个「满屏都在用」的页，所以这里宁可少一个标题也把空间让出来。 */
  const maps = list.data?.maps || []
  // 左栏列表的行：本讲 → 本科 → 全部。就在现有的 maps 上筛，不额外请求。
  const allMaps: MapRow[] = list.data?.maps || []
  /* 左栏列表：本讲 → 本科 → 全部。
     ⚠ 「本讲」这一档必须**永远包含当前正在编辑的那张**，哪怕它挂的讲次跟当前讲不同。
     以前只按 lid 相等筛，于是打开一张挂在别的讲上的画布后，左栏里根本看不到它 ——
     用户的话是「当前画布它不算画布是吗」。现在先按讲次筛，再把当前那张并进来。 */
  const lvRows = (() => {
    const base = lvFilter === 'lesson'
      ? allMaps.filter((m) => String((m.lesson_ids && m.lesson_ids[0]) || m.lesson_id || '') === String(lid || ''))
      : lvFilter === 'subject'
        ? allMaps.filter((m) => mSubj(m) === curSubject())
        : allMaps
    const curRow = mapId ? allMaps.find((m) => m.id === mapId) : null
    if (curRow && !base.some((m) => m.id === curRow.id)) return [curRow, ...base]
    return base
  })()

  const shotsAll = galList.data?.shots || []

  const editBar = (
    <>
      <input className="cvt" value={title} placeholder="给这张画布起个名字"
        onChange={(e) => { setTitle(e.target.value); setDirty(true); if (tree) scheduleSave(tree) }} />
      <span className={'cvst' + (dirty ? ' wait' : ' ok')}>{dirty ? '还没存' : '已存本机'}</span>
      <span className="cvnum">{n} 个节点</span>
      {/* 挂在哪几讲：以前**只能建的时候定**，之后再也改不了（用户原话：
          「讲次绑定的画布没有办法更改绑定的讲次」）。这里给一颗按钮开面板，
          改完直接调 note_rebind —— 只改绑定关系，不动树，也不进撤销栈。 */}
      <button className={"cvbtn" + (bindOpen ? " on" : "")} title="这张画布挂在哪几讲"
        onClick={() => setBindOpen((v) => !v)}>
        <Icon n="courses" size={14} />
        <em>{bindIds.length ? "挂 " + bindIds.length + " 讲" : "没挂讲次"}</em>
      </button>
      <span className="cvdiv" />
      <button className="cvbtn" title="回到画布库" onClick={() => setView('gallery')}><Icon n="chev" size={14} /><em>全部画布</em></button>
      {/* 版面：三种自动布局 + 整理。这一组挨着「全部画布」放 ——
          它们都是「这张图长什么样」的开关，跟左边的增删改不搅在一起。
          选中态靠 .on 描一圈琥珀边（CSS 在 app.css 的 .cvlayer 段）。 */}
      <div className="cvlayer" role="group" aria-label="版面">
        {LAYOUTS.map((m) => (
          <button key={m} className={'cvbtn' + (mdMode === m ? ' on' : '')}
            title={`版面改成${LAYOUT_CN[m]}（拖过的节点不归位）`}
            aria-pressed={mdMode === m} onClick={() => pickLayout(m)}>
            <LayoutGlyph mode={m} /><em>{LAYOUT_CN[m]}</em>
          </button>
        ))}
        <button className="cvbtn" title="整理：把手动拖过的节点全收回去，回到纯自动布局"
          disabled={!Object.keys(pos).length} onClick={tidy}><Icon n="fit" size={14} /><em>整理</em></button>
      </div>
      <span className="cvdiv" />
      <button className="cvbtn" title="撤销（Ctrl+Z）" disabled={hi <= 0} onClick={undo}><Icon n="undo" size={14} /><em>撤销</em></button>
      <button className="cvbtn" title="重做（Ctrl+Shift+Z）" disabled={hi >= hist.length - 1} onClick={redo}><Icon n="redo" size={14} /><em>重做</em></button>
      <span className="cvdiv" />
      <button className="cvbtn" title="加子节点" disabled={!sel} onClick={() => sel && addChild(sel)}><Icon n="plus" size={14} /><em>子节点</em></button>
      <button className="cvbtn" title="加同级" disabled={!sel || sel === tree?.id} onClick={() => sel && addSibling(sel)}><Icon n="node" size={14} /><em>同级</em></button>
      <button className="cvbtn" title="删除节点" disabled={!sel || sel === tree?.id} onClick={() => sel && del(sel)}><Icon n="trash" size={14} /><em>删除</em></button>
      <span className="cvdiv" />
      <button className="cvbtn" title="导入 Markdown" onClick={() => setShowMd(true)}><Icon n="md" size={14} /><em>导入 MD</em></button>
      <span className="cvmore">
        <button className={'cvbtn' + (showExp ? ' on' : '')} title="导出成文件（6 种格式）" onClick={() => setShowExp((v) => !v)}>
          <Icon n="dl" size={14} /><em>导出</em><Icon n="down" size={11} />
        </button>
      </span>
      {showExp ? (
          <div className="cvexport" onMouseLeave={() => setShowExp(false)}>
            {([
              ['md', 'Markdown', '.md', '标题做主干，列表做分支，备注跟着走'],
              ['opml', 'OPML', '.opml', 'XMind / 幕布 / 大纲软件都能读'],
              ['txt', '纯文本缩进', '.txt', '粘到哪儿都不变形'],
              ['json', 'JSON', '.json', '原样带走，能再导回来'],
              ['svg', 'SVG 矢量图', '.svg', '缩到多大都不糊'],
              ['png', 'PNG 图片', '.png', '2 倍图，直接发给同学'],
            ] as const).map(([k, nm, ext, desc]) => (
              <button key={k} className="cvexp-row" onClick={() => runExport(k)}>
                <b>{nm}<em>{ext}</em></b>
                <span>{desc}</span>
              </button>
            ))}
          </div>
      ) : null}
      <button className={'cvbtn' + (showKeys ? ' on' : '')} title="快捷键（?）" onClick={() => setShowKeys(true)}><em>?</em></button>
      <span className="cvdiv" />
      <button className="cvbtn" title="把这张导图拍下来存进本学科截图库" disabled={shotBusy} onClick={shotNow}>
        <Icon n="cam" size={14} /><em>{shotBusy ? '存中…' : '截图'}</em>
      </button>
      <button className="cvbtn" title="本学科的素材库" onClick={() => { setShowGal(true); loadGal() }}>
        <Icon n="gal" size={14} /><em>素材</em><b className="cvcnt">{galList.data?.total ?? gal.shots.length}</b>
      </button>
      <button className="cvbtn" title="笔记来源" onClick={() => setShowSrc((v) => !v)}><Icon n="cloud" size={14} /><em>来源</em></button>
      <button className="cvbtn" title="全屏（Esc 退出）" onClick={toggleFull}>
        <Icon n={isFull ? 'minus' : 'fit'} size={14} /><em>{isFull ? '退出全屏' : '全屏'}</em>
      </button>
    </>
  )
  /* 库顶栏。原来是一条平铺的按钮带：两个 tab、五个筛选/排序、一个新建，
     十颗控件同样的长相、同样的字号，只有颜色淡浓之分 —— 眼睛要在里面现找。
     现在按「看什么 / 怎么筛 / 动手」分三段，中间用 .cvbar-sp 撑开：
       · 左：画布 / 图库（带数字，一眼知道有多少）
       · 中：过滤 + 排序（只在当前 tab 有意义的那几颗）
       · 右：新建（这一页唯一的主行动，单独站一边，用实心琥珀） */
  const galleryBar = (
    <>
      <div className="cvbar-seg" role="tablist" aria-label="看什么">
        <button className={'cvseg-t' + (tab === 'map' ? ' on' : '')} role="tab" aria-selected={tab === 'map'}
          onClick={() => setTab('map')}>画布<b>{maps.length}</b></button>
        <button className={'cvseg-t' + (tab === 'shot' ? ' on' : '')} role="tab" aria-selected={tab === 'shot'}
          onClick={() => setTab('shot')}>图库<b>{galList.data?.total ?? shotsAll.length}</b></button>
      </div>
      <span className="cvbar-sp" />
      {tab === 'map' ? (
        <>
          <div className="cvbar-group" role="group" aria-label="范围">
            <button className={'cvpick' + (galAll ? ' on' : '')} onClick={() => setGalAll(true)}>全部</button>
            <button className={'cvpick' + (galAll ? '' : ' on')} onClick={() => setGalAll(false)}>
              {SUBJNAME[curSubject()] || curSubject()}
            </button>
          </div>
          <div className="cvbar-group" role="group" aria-label="排序">
            <button className={'cvpick' + (sortBy === 'recent' ? ' on' : '')} onClick={() => setSortBy('recent')}
              title="按最后修改时间排">最近</button>
            <button className={'cvpick' + (sortBy === 'nodes' ? ' on' : '')} onClick={() => setSortBy('nodes')}
              title="按节点多少排">节点多</button>
          </div>
          <button className="cvmk" onClick={newMap}><Icon n="plus" size={14} />新建画布</button>
        </>
      ) : (
        <>
          <div className="cvbar-group" role="group" aria-label="来源">
            {(['', 'frame', 'canvas', 'upload', 'file'] as const).map((o) => (
              <button key={o || 'all'} className={'cvpick' + (originF === o ? ' on' : '')} onClick={() => setOriginF(o)}>
                {o ? (ORIGIN_CN[o] || o) : '全部'}
              </button>
            ))}
          </div>
          <input className="cvfind-inp" value={q} placeholder="搜标题 / 讲次…" onChange={(e) => setQ(e.target.value)} />
        </>
      )}
    </>
  )
  const inEdit = view === 'edit' && !!tree
  /* 库视图和编辑视图给壳的工具条不一样：一个是「筛」，一个是「改」。
     这里必须 resolve 成字符串再比 —— editBar/galleryBar 是每次渲染新建的 JSX 树，
     拿它当依赖等于每次都变；只写 useEffect 不写依赖更糟：每渲染一次就 setState
     一遍壳，壳再把我渲染一遍 → React #185「Maximum update depth exceeded」。 */
  const barSig = useMemo(() => {
    if (!inEdit) {
      return ['g', title, tab, galAll ? 1 : 0, q, sortBy, Math.round(galList.data?.total ?? 0), maps.length].join('|') + '|lv' + lvFilter + ':' + lvRows.length
    }
    /* task-4：导出的开关、快捷键面板、左栏 tab 都是「画在壳里的」状态 ——
       不拼进 barSig，壳就永远重渲染不到它们（这个坑踩过一次：按了没反应）。 */
    return ['e', title, dirty ? 1 : 0, n, sel || '', hi, hist.length, isFull ? 1 : 0,
      shotBusy ? 1 : 0, Math.round(galList.data?.total ?? gal.shots.length), showSrc ? 1 : 0,
      tree ? countNodes(tree) : 0, JSON.stringify(pos),
      showExp ? 1 : 0, showKeys ? 1 : 0, leftTab, xmap ? 1 : 0,
      /* task-3：版面模式、迷你地图开关、以及「拖过几个节点」（决定「整理」能不能按）。
         这三个必须进签名，否则按了没反应 —— 工具条是画在壳里的，壳不知道就不会重画。 */
      mdMode, miniMap ? 1 : 0, Object.keys(pos).length].join('|')
  }, [inEdit, title, tab, galAll, q, sortBy, galList.data, maps.length, dirty, n, sel, hi, hist.length, isFull, shotBusy, gal, showSrc, tree, pos, showExp, showKeys, leftTab, xmap, mdMode, miniMap, lvFilter, lvRows.length])
  useEffect(() => {
    if (!topHost) return
    topHost(
      <div className="cvtopbar">
        <span className="cvhost-t">{inEdit ? '画布' : '笔记画布'}</span>
        <span className="cvdiv" />
        {inEdit ? editBar : galleryBar}
      </div>,
    )
  }, [barSig])  // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 键盘：以前底部那行提示是纯装饰（"Del 删除"根本没监听），现在真接上。
     两个原则：
     1) 在输入框里打字时一律不抢键（标题框、搜索框、节点内的 input）。
     2) 焦点在 ReactFlow 上时它自己有快捷键，但删除/多选它不管，这部分由我们兜。 */
  const treeRef = useRef<TNode | null>(null)
  treeRef.current = tree
  const selRef = useRef<{ sel: string | null; set: string[] }>({ sel: null, set: [] })
  selRef.current = { sel, set: selSet }
  const foldRef = useRef(fold); foldRef.current = fold
  const editRef = useRef(edit); editRef.current = edit
  const delRef = useRef(delMany); delRef.current = delMany
  const addRef = useRef({ child: addChild, sib: addSibling })
  addRef.current = { child: addChild, sib: addSibling }
  /* 菜单是从 portal 里点出来的，回调可能下一帧才跑 —— 同样用 ref 取最新版。 */
  const setTypeRef = useRef(setType); setTypeRef.current = setType
  const undoRef = useRef({ undo, redo })
  undoRef.current = { undo, redo }
  const posRef = useRef<Record<string, { x: number; y: number }>>({})
  posRef.current = pos
  const keysRef = useRef(showKeys); keysRef.current = showKeys

  useEffect(() => {
    if (view !== 'edit') return
    const typing = (el: EventTarget | null) => {
      const t = el as HTMLElement | null
      if (!t) return false
      const tag = (t.tagName || '').toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable
    }
    const k = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      const t = treeRef.current
      if (!t) return
      const { sel: one, set: many } = selRef.current
      const ids = many.length ? many : (one ? [one] : [])
      // 根节点删不掉（删了整张画布就没了内容），但别连累兄弟 —— 批里剔掉它继续删
      const batch = ids.filter((x) => x !== t.id)
      const mod = e.ctrlKey || e.metaKey

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!batch.length) return
        e.preventDefault()
        delRef.current(batch)
        return
      }
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) undoRef.current.redo(); else undoRef.current.undo()
        return
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        /* 全选 = 除根以外的全部（根删不掉，选进去只会让批量条上那个数字虚高）。
           必须走 setSelMany 写进 selSet：以前这里只 setRfNodes 改了 ReactFlow 的
           selected，我们的「唯一真相」还是空的 —— 全选之后批量条照样不出现。 */
        const all: string[] = []
        walkAll(t, (nd) => { if (nd.id !== t.id) all.push(nd.id) })
        setSelManyRef.current(all)
        return
      }
      /* ? 打开快捷键表。别只看 e.key === '?' —— 有些键盘布局 shift+/ 给的就是 '/'，
         两个都认，但不碰带 Ctrl 的组合（那是浏览器自己的键）。 */
      if ((e.key === '?' || (e.shiftKey && e.key === '/')) && !mod) {
        e.preventDefault()
        setShowKeys((v) => !v)
        return
      }
      if (e.key === 'Escape') {
        // 菜单开着时 Esc 只关菜单（菜单自己也挂了一份 capture 监听，这里兜一层）
        if (menuRef.current) { setMenuRef.current(null); return }
        if (keysRef.current) { setShowKeys(false); return }
        setSel(null); return
      }
      // Ctrl+C / Ctrl+V：复制节点 / 粘贴为子节点。没有选中就不接手，
      // 免得把用户在别处复制的东西吃掉（浏览器默认行为照旧）。
      if (mod && (e.key === 'c' || e.key === 'C') && batch.length === 1) {
        e.preventDefault(); copyRef.current(batch[0]); return
      }
      if (mod && (e.key === 'v' || e.key === 'V') && one) {
        e.preventDefault(); pasteRef.current(one); return
      }
      if (e.key === 'Tab' && one) {
        e.preventDefault()
        addRef.current.child(one)
        return
      }
      if (e.key === 'Enter' && one) {
        e.preventDefault()
        addRef.current.sib(one)
        return
      }
      // 方向键：在可见兄弟之间挪选择（折叠的不算，免得"跳到看不见的地方"）
      const ARROW: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 }
      const dir = ARROW[e.key]
      if (dir && batch.length === 1) {
        e.preventDefault()
        const p = findParent(t, batch[0])
        if (!p) return
        const vis = (p.children || []).filter((c) => !foldRef.current[p.id])
        if (!vis.length) return
        const i = vis.findIndex((c) => c.id === batch[0])
        const nx = vis[Math.min(vis.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))]
        if (nx) {
          setSel0(nx.id)
          setRfNodes((ns) => ns.map((x: any) => ({ ...x, selected: x.id === nx.id })))
        }
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [view])

  // ── 视图一：库（默认）。两个 tab（画布 / 图库），一排缩略图，点哪张进哪张。
  // 结构照 docs/画布与课堂-开发文档.md 3.2 —— 学科 chip 行 + 搜索 + 排序，卡上带节点数。
  const shown = galAll ? maps : maps.filter((m) => mSubj(m) === curSubject())
  const sorted = sortBy === 'nodes'
    ? [...shown].sort((a, b) => (b.nodes ?? -1) - (a.nodes ?? -1))
    : shown   // recent 就是服务端给的 updated_ts DESC，不在前端再排一遍
  /* 画布按「科目（课程）」分组 —— 用户的原话：一个大组，大组里面才是每门课的画布。
     以前是一整片网格，六张卡散着摆，谁属于哪门课只靠卡底一枚小标签，
     等于让人自己找。现在先给组标题（科目名 + 张数 + 进度条），组内再排卡。
     组序跟导航里「学」那一路一致（base.subjects 的顺序），没挂科目的排最后。 */
  /* 图库分组：**科目 → 讲次** 两层，不是一个笼统的「计算机 3 张」。
     以前只按科目分一层，一门课十几张画布全摊在一起，找「第 3 讲那张」得一张张看标题。
     现在科目下面再按讲次分：没挂讲次的单独一档（那是真没归位，不是猜的）。
     讲次名用后端给的 lesson_titles（人话标题），拿不到就退回 lesson_id —— 不编。 */
  const groups = (() => {
    const order: string[] = []
    for (const sj of base.subjects || []) order.push(sj.id)
    for (const m of sorted) { const k = mSubj(m); if (!order.includes(k)) order.push(k) }
    const bySubj = new Map<string, MapRow[]>()
    for (const k of order) bySubj.set(k, [])
    for (const m of sorted) bySubj.get(mSubj(m))!.push(m)
    return [...bySubj.entries()]
      .filter(([, arr]) => arr.length > 0)
      .map(([k, arr]) => {
        // 科目内再按讲次分。顺序按讲次在第几讲排（lect 越靠前越上面）。
        const byLes = new Map<string, { key: string; title: string; n: number | null; rows: MapRow[] }>()
        for (const m of arr) {
          const ids = (m.lesson_ids && m.lesson_ids.length) ? m.lesson_ids : (m.lesson_id ? [m.lesson_id] : [])
          if (!ids.length) {
            const g = byLes.get('') || { key: '', title: '没挂讲次', n: null, rows: [] }
            g.rows.push(m); byLes.set('', g)
            continue
          }
          for (const lid of ids) {
            const lt = (m.lesson_titles || []).find((x: any) => x && x.id === lid)
            const g = byLes.get(lid) || {
              key: lid,
              title: (lt && lt.title) || lid,
              n: lt && typeof lt.n === 'number' ? lt.n : null,
              rows: [],
            }
            // 同一张画布挂多讲时会在多个讲次下出现 —— 这是对的，它确实属于那几讲
            if (!g.rows.some((r) => r.id === m.id)) g.rows.push(m)
            byLes.set(lid, g)
          }
        }
        const lesions = [...byLes.values()].sort((a, b) => {
          if (a.n == null && b.n == null) return a.key.localeCompare(b.key)
          if (a.n == null) return 1
          if (b.n == null) return -1
          return a.n - b.n
        })
        return { id: k, name: SUBJNAME[k] || (k ? k : '没挂科目'), lesions, rows: arr }
      })
  })()

  const shotShown = shotsAll

  /* 叠层大图：库视图和编辑视图**都要**能弹。
     以前只挂库视图那一个 return，编辑视图里点「素材」永远只有数字在跳、
     浮层不出来 —— 死状态比死按钮更气人。抽成一份，两个 return 各挂一次。 */
  const galLb = showGal ? (
    <Lightbox
      items={galList.data?.shots || []}
      index={galIdx}
      onIndex={setGalIdx}
      onClose={() => { setShowGal(false); loadGal() }}
      onRename={async (id, cur) => {
        const v = window.prompt('改个名字', cur || '')
        if (v == null) return
        await callTool('shot_rename', { id, title: v }, { write: true }); loadGal()
      }}
      onDel={async (id) => {
        if (!window.confirm('从素材库里摘掉这一条？盘上的图不会被删。')) return
        await callTool('shot_del', { id }, { write: true })
        setGalIdx((i) => Math.max(0, i - 1)); loadGal()
      }}
      onToCanvas={async (x) => {
        /* 这里是「把这张图插进导图节点」，不是列表缩略图 —— 节点里那张图
           会被放大看（导出 PNG/SVG 时更是要拿高清）。所以用**原图地址**，
           跟灯箱同理：列表用缩略图，真正看到图的地方用原图。 */
        await insertImage({ title: x.title, url: x.url || fullUrl(x.file) })
      }}
      onUpload={uploadImage}
    />
  ) : null

  if (view === 'gallery' || !tree) {
    return (
      <>
      <div className="cvwrap cvdark inline cvgall">
        {/* toast 在这里也要有一份 —— 图库视图是另一个 return，编辑视图那份挂不到这儿。
            实测：在图库里点删，库里真删掉了（shot_del 200），但屏幕上干净得像什么都没发生，
            人只会以为按钮坏了。 */}
        {toast ? (
          <div className="cvtoast" role="status" onClick={() => setToast(null)}>{toast}</div>
        ) : null}
        {/* 顶栏已经在壳里了（cvtopbar），这里不再重复一行「画布 / 图库」——
            否则同一个切换会出现两遍。 */}
        <div className="cvgalbody">
          {tab === 'map' ? (
            list.loading && !maps.length ? (
              <div className="cvgalgrid">
                {[0, 1, 2, 3].map((i) => <div className="gcard skel" key={i}><span className="gthumb" /><span className="gmeta" /></div>)}
              </div>
            ) : !sorted.length ? (
              <div className="cvgalempty">
                <b>{maps.length ? '这一科还没有画布' : '本机还没有画布'}</b>
                <span>{maps.length ? '切到「全部」看看，或者新建一张。' : '画布是一节课的笔记层 —— 一个分支写一个知识点，够用就行。'}</span>
                <button className="pbtn-mn" onClick={newMap}><Icon n="plus" size={14} />新建一张画布</button>
              </div>
            ) : (
              <>
                {groups.map((g) => (
                  <section className="gsec" key={g.id || '_none'}>
                    {/* 科目抬头：科目名 + 总张数。下面再按讲次分小节。 */}
                    <div className="gsec-hd">
                      <span className="gsec-c" style={{ background: clsColor(g.id) }} />
                      <b>{g.name}</b>
                      <span className="gsec-n">{g.rows.length} 张</span>
                      <span className="gsec-ln" />
                      <button className="pbtn-mn ghost gsec-add" onClick={newMap}
                        title={'在「' + g.name + '」下新建一张'}>
                        <Icon n="plus" size={12} />新建
                      </button>
                    </div>
                    {g.lesions.map((L) => (
                    <div className="gles" key={g.id + '|/' + (L.key || '_none')}>
                      {/* 讲次小节抬头：第 N 讲 · 标题。
                          没挂讲次的收起尾单独一档，灰一点 —— 那是真没归位，不是猜的。 */}
                      <div className={"gles-hd" + (L.key ? '' : ' none')}>
                        {L.n != null ? <em>第 {L.n} 讲</em> : null}
                        <span>{L.title}</span>
                        <i>{L.rows.length}</i>
                        <span className="gsec-ln" />
                      </div>
                    <div className="cvgalgrid">
                      {g.rows.map((m) => (
                        <div className={'gcardwrap' + (delMapArm === m.id ? ' arming' : '')} key={m.id}>
                          {/* data-mapid：卡片自己的身份。以前一张卡在 DOM 上认不出是哪张图 ——
                              标题可能重名（「函数的单调性」就有两张），节点数会变，
                              自动化测试只能靠「看起来像」去猜，猜错就点错图。
                              给个稳定属性之后，深链和测试都能精确命中。 */}
                          <button className={'gcard' + (m.id === mapId ? ' on' : '')} data-mapid={m.id}
                            onClick={() => openMap(m)} title={m.title || '未命名'}>
                            {/* viewBox 必须跟 CSS 里的实际高度对上：ShapeThumb 默认 H=118，
                                容器放高之后 preserveAspectRatio 会按 300:118 等比缩放，
                                上下各留一条黑边、内容反而变小 —— 看着像缩略图坏掉了。
                                这里显式给 W/H，让 viewBox 就是它真实占据的那块。
                                改缩略图高度时，这三个数字（CSS 的 .gthumb height、
                                .sthumb.mind height、这里的 H）必须一起改。 */}
                            <span className="gthumb"><ShapeThumb shape={m.shape} W={340} H={189} /></span>
                            {/* 信息分左右两栏：左边标题、右边节点数/时间，标签再单独一行。
                                以前是一整列竖着堆在左侧，右边空一大片 —— 卡看着又窄又散。
                                左右都有内容之后，视觉重心才落在卡中央。 */}
                            <span className="gmeta">
                              <span className="gmeta-top">
                                <b>{m.title || '未命名'}</b>
                                <span className="gsrc">
                                  {m.nodes != null ? m.nodes + ' 个节点 · ' : ''}{m.age}
                                </span>
                              </span>
                              <span className="gtags">
                                <span className="gtag">{SRCNAME[m.src] || m.src}</span>
                                {(m.lesson_ids || []).length
                                  ? <span className="gtag">挂 {(m.lesson_ids || []).length} 讲</span>
                                  : <span className="gtag off">没挂讲次</span>}
                              </span>
                            </span>
                          </button>
                          {/* 画布卡也能删。跟截图卡同一套两步确认 ——
                              第一下变红问「再点一次」，第二下才真发 note_del。 */}
                          <button className="mapdel" aria-label="删掉这张画布"
                            title={delMapArm === m.id ? '再点一次就删掉' : '删掉这张画布'}
                            onClick={(e) => { e.stopPropagation(); delMap(m) }}>
                            {delMapArm === m.id ? <span>再点一次</span> : <Icon n="trash" size={13} />}
                          </button>
                        </div>
                      ))}
                    </div>
                    </div>
                    ))}
                  </section>
                ))}
              </>
            )
          ) : !shotShown.length ? (
            <div className="cvgalempty">
              <b>{q || originF ? '这个条件下没有图' : '素材库还是空的'}</b>
              <span>
                {q || originF
                  ? '换个来源或者清掉搜索词试试。'
                  : '课堂里按 S 截一帧、画布上点「存进截图库」，图就会落到这一栏 —— 三种来源（截帧 / 画布导出 / 上传）按 origin 分档。'}
              </span>
            </div>
          ) : (
            <div className="shotwall">
              {shotShown.map((x: any) => (
                /* 卡上直接给一枚删除键。以前只有点开叠层大图、在右边按钮排里找「删掉」，
                   用户压根不知道那儿有 —— 缩略图上看不见就等于没有。
                   两步确认：第一次点亮成「再点一次」，第二次才真删（跟全站写盘类按钮同规矩）。 */
                <div className={'shotwrap' + (delArm === x.id ? ' arming' : '')} key={x.id}>
                  <button className="shotcard" title={x.title || ''}
                    onClick={() => { setGalIdx(shotShown.findIndex((y: any) => y.id === x.id)); setShowGal(true) }}>
                    {/* 卡上这张是**缩略图**（480 宽 WebP），不是原图。
                        图库一屏 58 张，原图合计 2.7 MB；缩略图约 0.8 MB，省七成多。
                        而且卡片本身只有 200 多像素宽 —— 发原图过去，浏览器还要
                        再缩一次再扔掉，纯白下载。
                        要看原图就点开（灯箱里那张仍是 /shots/ 原图，见下面 Lightbox）。 */}
                    <span className="sw">
                      <img src={thumbUrl(x.file)} alt={x.title || ''} loading="lazy"
                        onError={(e) => thumbFallback(e, x.file)} />
                      {x.pos_sec != null ? <em>{clock(x.pos_sec)}</em> : null}
                    </span>
                    <span className="sm">
                      <b>{x.title || '未命名'}</b>
                      <span>{ORIGIN_CN[x.origin] || x.origin || x.tag || '—'} · {x.age || ''}</span>
                    </span>
                  </button>
                  <button className="shotdel" aria-label="从素材库删掉这一张"
                    title={delArm === x.id ? '再点一次就删掉（盘上的图不会被删）' : '从素材库删掉这一张'}
                    onClick={(e) => { e.stopPropagation(); delShot(x) }}>
                    {delArm === x.id ? <span>再点一次</span> : <Icon n="trash" size={13} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* 叠层大图两个视图共用（见下面 galLb） */}
      {galLb}
      </>
    )
  }

  return (
    <div className="cvwrap cvdark inline" ref={wrapRef}>
      {/* 顶栏的活全搬到研学台那条 top 里去了（见 CanvasTopbar）：
          画布自己的工具栏原来占 98px，一行身份 + 一行动作，把舞台往下压到 154px。
          现在工具在壳里，这里只剩左中右三栏，高度链一路撑满。 */}
      {/* toast：截图 / 导入 / 导出这类「做完了」的回执。顶栏折行之后按钮在第二行，
          提示贴在舞台左上角，眼睛不用来回找。 */}
      {toast ? (
        <div className="cvtoast" role="status" onClick={() => setToast(null)}>{toast}</div>
      ) : null}
      <div className="cvmain">
        {/* ── 左栏：画布 ── */}
        <aside className="cvleft">
          {/* 左栏两个 tab：画布列表 / 大纲。大纲是 task-4 加的 ——
              图适合想，大纲适合读和找；它只是列表的一种读法，不占舞台，
              所以放在左栏而不是 .cvstage（那是 ReactFlow 的地盘）。 */}
          <div className="cvltabs">
            <button className={'cvltab' + (leftTab === 'maps' ? ' on' : '')} onClick={() => setLeftTab('maps')}>
              我的画布 <b>{lvRows.length}</b>
            </button>
            <button className={'cvltab' + (leftTab === 'outline' ? ' on' : '')} onClick={() => setLeftTab('outline')}>
              大纲 <b>{n}</b>
            </button>
          </div>
          {leftTab === 'maps' ? (
            <>
              {/* 三档筛选。默认「本讲」—— 画布是这一节课的笔记层，
                  左栏先给这一讲的那几张；想看同一门课别的讲次再切「本科」。 */}
              <div className="cvseg">
                <button className={'cvseg-b' + (lvFilter === 'lesson' ? ' on' : '')} onClick={() => setLvFilter('lesson')}>
                  本讲
                </button>
                <button className={'cvseg-b' + (lvFilter === 'subject' ? ' on' : '')} onClick={() => setLvFilter('subject')}>
                  本科
                </button>
                <button className={'cvseg-b' + (lvFilter === 'all' ? ' on' : '')} onClick={() => setLvFilter('all')}>
                  全部
                </button>
              </div>
              <button className="cvnew" onClick={newMap}>
                <Icon n="plus" size={16} />
                <span>新建一张画布</span>
              </button>
              <div className="cvlist">
                {lvRows.map((m) => (
                  <button key={m.id} className={'cvmap' + (m.id === mapId ? ' on' : '')} onClick={() => openMap(m)} title={m.title || '未命名'}>
                    <ShapeThumb shape={m.shape} />
                    <span className="cvmap-tx">
                      <b>{m.title || '未命名'}</b>
                      <em>{SRCNAME[m.src] || m.src} · {m.age}</em>
                    </span>
                  </button>
                ))}
                {!lvRows.length ? (
                  <div className="cvside-empty">
                    {lvFilter === 'lesson'
                      ? '这一讲还没有画布 —— 点上面「新建一张画布」，它会挂在这一讲上。'
                      : lvFilter === 'subject'
                        ? '这门课还没有别的画布。'
                        : '还没有画布'}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <Outline tree={tree} sel={sel} fold={fold} find={find}
              onPick={focusNode} onMove={moveLevel}
              onToggleFold={(id) => setFold((f) => { const x = { ...f }; if (x[id]) delete x[id]; else x[id] = 1; return x })} />
          )}
          {/* 搜索不再占左栏：那一栏本来就窄，再塞一块常驻搜索区，大纲就被压得只剩几行。
              现在整块搬到 Ctrl+F 呼出的浮条里（见下面 .cvfindbar），不用时一条都不占。 */}
        </aside>

        {/* ── 舞台 ──
            中键：Chrome 默认把中键当「自动滚动」开关 —— 一按就出四向箭头，滚的是
            整个页面（连左侧栏一起动），跟画布没关系。用户说的「能把整个框架移动出去、
            左侧栏也跟着动」就是它。正解是在按下阶段 preventDefault 取消自动滚动，
            平移本身交给 ReactFlow 的 panOnDrag=[1,2]。auxclick 也要拦：有些环境下
            中键会触发「后台打开 / 粘贴」。 */}
        <div className={"cvstage" + (mdMode === 'mind' ? '' : ' cvlayer-vert') + (boxing || selSet.length > 1 ? ' bulk-sel' : '') + (Object.keys(dodge).length ? ' dodging' : '')} ref={stageRef}
          onMouseDownCapture={(e) => { if (e.button === 1) e.preventDefault() }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation() } }}
        >
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
            onInit={(inst) => { rfRef.current = inst }}
            onMove={(_, vp) => setZoom(vp?.zoom ?? 1)}
            onNodesChange={rfOnNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            /* Shift/Ctrl 点选：React Flow 的 multiSelectionKeyCode 只管键盘，
               鼠标事件里带没带修饰键它不看 —— 加减选由 setSel(id, add) 自己算，
               nodes 再按 selSet 把 selected 画出来。 */
            onNodeClick={(e, node) => {
              /* 框选松手那一下补发的单击不算数 —— 它属于框选，不属于「点这个节点」。
                 不拦的话整批会被它冲成一个，等于白框。 */
              if (boxEndRef.current) { boxEndRef.current = false; return }
              /* Shift / Ctrl 点选加一个进去。这里读 selSet 而不是 selectionRef：
                 框选刚结束时 selSet 是整批，补一个 Shift 点击要加在这一批上。 */
              const add = !!(e.shiftKey || e.ctrlKey || e.metaKey)
              if (add) {
                const cur = selectionRef.current.set
                const next = cur.includes(node.id) ? cur.filter((x) => x !== node.id) : [...cur, node.id]
                setSelMany(next)
                return
              }
              setSel(node.id)
            }}
            onPaneClick={() => { setSel(null); if (menuRef.current) setMenuRef.current(null) }}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            onMoveStart={() => { if (menuRef.current) setMenuRef.current(null) }}
            /* 双击 = 原地改字（原来是 window.prompt，字一长就看不清）。
               编辑态挂在 Canvas 的 editing 上，节点自己渲染 textarea。 */
            onNodeDoubleClick={(_, node) => {
              // 已经有别的编辑在开着就先关掉（只许开一个），再开这个
              setSel(node.id)
              setEditing((cur) => (cur && cur.id === node.id && cur.mode === 'text' ? cur : { id: node.id, mode: 'text' }))
            }}
            /* 多选三件套：拖空白处框选、按住 Shift 拖也能框、节点跟着选中态高亮。
               注意别再挂 onSelectionChange 回写 selSet —— React Flow 自己管 selected，
               我们一边读一边写，它的 store 就会在同一个提交里反复 forceStoreRerender，
               表现是 React #185（无限更新）。选中状态只有一个来源：rfNodes。 */
            /* 框选：只认「拖空白处」，按住修饰键时一律不下手 ——
               否则 Shift+点节点会被它判成一次 0 面积的框选，加选永远加不上。 */
            selectionOnDrag
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            /* 框选结束那一下，把 ReactFlow 自己选中的那批**收进**我们的 selSet。
               这一条以前是缺的，所以拖出一个框、屏幕上 24 个节点都亮着，
               底部批量条却不见、按 Del 也删不掉 —— 因为 selSet 还是空的。
               为什么挂在 onSelectionEnd 而不是 onSelectionChange：
               后者在拖动过程中每一帧都触发，而它一 setState 就会让 nodes 重建、
               再回灌 ReactFlow 的 store，正是注释里那个 React #185 的自激环。
               onSelectionEnd 只在松手时响一次，只写不回读，环起不来。 */
            onSelectionStart={() => { setBoxing(true); boxAcc.current = [] }}
            /* 框选过程中每帧把当前选中的收进 ref（只读 DOM 状态，不 setState），
               同时把用户正在画的这个框的矩形记下来 —— 松手后要照原样留住它。 */
            onSelectionChange={({ nodes: selNodes }: any) => {
              if (!boxingRef.current) return
              boxAcc.current = (selNodes || []).map((n: any) => n.id)
            }}
            onSelectionEnd={() => {
              setBoxing(false)
              /* 用拖动过程中累积的那份，不再读 ReactFlow 的 selected。
                 因为 onSelectionEnd 触发时，ReactFlow 的 store 里 selected 可能已经
                 被它自己清掉或只剩一个 —— 实测读到的是「1 个」，框了 7 个也只剩 1 个。
                 累积集合在 onSelectionChange 里填（那个每帧都触发，但这里只往 ref 里塞，
                 不 setState，所以不会引起 React #185 的回灌环）。 */
              const picked = boxAcc.current.slice()
              boxAcc.current = []
              if (!picked.length) return
              /* 松手后 ReactFlow 还会补一次 onNodeClick（鼠标正落在某个节点上），
                 而 onNodeClick 里的 setSel(一个 id) 会把刚框出来的整批冲掉 ——
                 框了 24 个、松手只剩 1 个，人看就是「框选被强制结束了」。
                 所以框选一结束就立个标记，让紧接着那次单击作废。 */
              boxEndRef.current = true
              setSelMany(picked)
            }}
            panOnDrag={[1, 2]}
            fitView fitViewOptions={{ padding: 0.18 }}
            minZoom={0.25} maxZoom={2.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#22262D" gap={22} size={1.4} />
            {/* 迷你地图默认关：画布已经有一整条缩放工具条，再加一张缩略图纯添乱。
                开关存本机（sd.cv.minimap），下次打开还是上次选的。
                pannable/zoomable 都给上 —— 开了就当它是快捷导航。 */}
            {miniMap ? (
              <MiniMap pannable zoomable nodeStrokeWidth={2}
                className="cvmm"
                maskColor="rgba(9,8,6,.72)"
                nodeColor={(n: any) => (n?.data?.isRoot ? 'var(--act)' : '#3A332A')}
                nodeStrokeColor={(n: any) => (n?.data?.isRoot ? 'var(--act2)' : '#4A4234')}
                style={{ width: 168, height: 112, background: 'var(--card)' }} />
            ) : null}
            <div className="cvzoom">
              <button title="缩小" onClick={() => rfRef.current?.zoomOut({ duration: 160 })}>
                <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden><path d="M4 9 H14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
              <span className="pct">{Math.round(zoom * 100)}%</span>
              <button title="放大" onClick={() => rfRef.current?.zoomIn({ duration: 160 })}>
                <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden><path d="M9 4 V14 M4 9 H14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
              <span className="cvdiv" />
              {/* 100%：把缩放拨回 1 倍。点按钮不比滚轮快，但「我就要看原始大小」
                  的时候没个确切的入口很难受 —— 百分比那个数字本身就是按钮。 */}
              <button title="缩放到 100%" onClick={() => rfRef.current?.zoomTo(1, { duration: 180 })}>
                <Icon n="search" size={14} />
              </button>
              <button title="铺满窗口" onClick={() => rfRef.current?.fitView({ padding: 0.18, duration: 240 })}>
                <Icon n="fit" size={14} />
              </button>
              <span className="cvdiv" />
              <button className={'cvmapbtn' + (miniMap ? ' on' : '')} title={miniMap ? '关掉迷你地图' : '开一张迷你地图'} aria-pressed={miniMap} onClick={() => toggleMiniMap()}>
                <Icon n="node" size={14} />
              </button>
            </div>
            <Controls showInteractive={false} className="cvctrl" />
          </ReactFlow>


          {/* 多选时**只有一条**工具条：贴底那条批量条。
              以前这里还有一条「跟着鼠标走」的 FloatTools，两条同时在屏上：
              跟手那条会压住节点、挡着字，而且它的按钮（折叠/上色/删除）
              跟底部批量条是同一批动作 —— 同一个动作两个入口、两种位置，
              用户原话就是「多选到底该点哪个」。现在把跟手那条收掉：
              框选完手一松，鼠标就在框的右下角，而底部那条本来就是常驻且不挡内容的。
              （FloatTools 组件本身留着，NodeEditor 里还有单节点那条在用同一套样式。） */}
          {count > 1 ? (
            <div className="cvselbar bulk">
              <span className="cvtxt">已选 {count} 个节点</span>
              <span className="cvdiv" />
              <button className={bulkPop ? 'on' : ''} title="给这 N 个节点上同一种颜色"
                onClick={() => setBulkPop((v) => !v)}><Icon n="tag" size={14} />上色</button>
              {bulkPop ? (
                <span className="cvbulkpop">
                  {MENU_COLORS.map((c) => (
                    <button key={c.v} title={c.name} className="cvsw" style={{ background: c.v, borderColor: c.v }}
                      onClick={() => { setColFor(selSet, c.v); setBulkPop(false) }} />
                  ))}
                  <button title="清除颜色" className="cvsw" style={{ background: 'transparent' }}
                    onClick={() => { setColFor(selSet, ''); setBulkPop(false) }}><Icon n="x" size={10} /></button>
                </span>
              ) : null}
              {/* 折叠 / 展开整批：多选之后最常见的第二个动作是「把这些支收起来」。
                  以前只有跟手那条上有，收掉它之后必须挪到这儿，否则那个功能就丢了。 */}
              <button title="把这些节点下的分支收起来"
                onClick={() => foldMany(selSet, 'fold')}><Icon n="chev" size={14} />收起</button>
              <button title="把这些节点下的分支展开"
                onClick={() => foldMany(selSet, 'open')}><Icon n="down" size={14} />展开</button>
              <span className="cvdiv" />
              <button className="danger" title="删掉选中的这些（Del）"
                onClick={() => delMany(selSet)}><Icon n="trash" size={14} />删掉这 {count} 个</button>
              <button title="取消选择（Esc）" onClick={() => setSel(null)}><Icon n="x" size={14} />取消</button>
            </div>
          ) : selNode ? (
            <div className="cvselbar">
              <span className="cvtxt" title={selNode.text}>{selNode.text || '（空节点）'}</span>
              <span className="cvdiv" />
              <button onClick={() => addChild(selNode.id)}><Icon n="plus" size={14} />子节点</button>
              <button disabled={selNode.id === tree.id} onClick={() => addSibling(selNode.id)}><Icon n="node" size={14} />同级</button>
              <button disabled={selNode.id === tree.id || tree.id === selNode.id} onClick={() => delMany([selNode.id])}><Icon n="trash" size={14} />删除</button>
            </div>
          ) : (
            /* 这行提示原来**一直**挂在画布底部。它是给第一次用的人看的，
               用熟了就是一块常驻横幅，还正好压在画布底部那一条上。
               现在：进编辑视图 6 秒后自己收起；想再看就把鼠标移上去（hover 复现）。
               收起/展开走 .cvhint 的 CSS 过渡，不做常亮呼吸。 */
            <div className={"cvhint" + (hintOn ? "" : " gone")} onMouseEnter={() => setHintOn(true)}>
              双击改字 · Tab 加子节点 · Enter 加同级 · Del 删除 · Shift 点选多个 · 拖空白框选
            </div>
          )}

          {/* ── 绑定讲次面板 ──
              以前画布挂在哪几讲只能建的时候定，之后再也改不了。
              这里给一个可搜索的多选清单：按科目分组、勾选即改，
              点「保存」才发 note_rebind（只改绑定关系，不动树、不进撤销栈）。 */}
          {bindOpen ? (
            <div className="cvbindbar" onKeyDown={(e) => { if (e.key === 'Escape') setBindOpen(false) }}>
              <div className="cvfindrow">
                <Icon n="courses" size={14} />
                <input value={bindQ} placeholder="搜讲次标题 / 科目" onChange={(e) => setBindQ(e.target.value)} />
                <button className="cvfindx" title="关闭" aria-label="关闭" onClick={() => setBindOpen(false)}>
                  <Icon n="x" size={13} />
                </button>
              </div>
              <div className="cvbindlist">
                {(() => {
                  const kw = bindQ.trim().toLowerCase()
                  const rows = allLessons.filter((l) => !kw
                    || l.title.toLowerCase().indexOf(kw) >= 0
                    || (SUBJNAME[l.subject] || l.subject).toLowerCase().indexOf(kw) >= 0)
                  if (bindLoading && !allLessons.length) return <div className="cvhits none">正在读讲次…</div>
                  if (!rows.length) return <div className="cvhits none">没有匹配的讲次</div>
                  const groups2 = new Map<string, typeof rows>()
                  for (const r of rows) {
                    const arr = groups2.get(r.subject) || []
                    arr.push(r); groups2.set(r.subject, arr)
                  }
                  return [...groups2.entries()].map(([sid, list]) => (
                    <div className="cvbindgrp" key={sid}>
                      <div className="cvbindhd">
                        <span className="gsec-c" style={{ background: clsColor(sid) }} />
                        {SUBJNAME[sid] || sid}
                        <i>{list.length}</i>
                      </div>
                      {list.slice(0, 200).map((l) => {
                        const on = bindIds.indexOf(l.id) >= 0
                        return (
                          <button key={l.id} className={"cvbindrow" + (on ? " on" : "")}
                            onClick={() => setBindIds((p) => on ? p.filter((x) => x !== l.id) : [...p, l.id])}>
                            <span className={"cvbindbox" + (on ? " on" : "")}>{on ? <Icon n="check" size={10} /> : null}</span>
                            <span className="cvbindtx">{l.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  ))
                })()}
              </div>
              <div className="cvbindfoot">
                <span className="muted">{bindIds.length ? "挂 " + bindIds.length + " 讲" : "没挂讲次"}</span>
                <span className="sp" />
                <button className="cvmini" onClick={() => setBindIds([])}>全部解绑</button>
                <button className="cvmk" disabled={bindBusy} onClick={saveBind}>
                  {bindBusy ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ) : null}

          {/* ── Ctrl+F 呼出的搜索条 ──
              原来这块常驻左栏：那一栏本来就窄（大纲要占一大半），再塞搜索区，
              大纲只剩三行。现在浮在舞台右上角，不用时一条都不占。
              跨画布那档要按 note_list 逐张翻，默认关着，勾上才扫，最多 20 张。 */}
          {findOpen ? (
            <div className="cvfindbar" onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); setFindOpen(false); setFind('') }
              if (e.key === 'Enter' && hits.length) {
                setHitIx((i) => (i + 1) % hits.length)
                focusNode(hits[(hitIx + 1) % hits.length])
              }
            }}>
              <div className="cvfindrow">
                <Icon n="search" size={14} />
                <input ref={findRef} value={find} placeholder="搜节点文字或备注"
                  onChange={(e) => setFind(e.target.value)} />
                <label className="cvxlab" title="按 note_list 逐张翻，最多 20 张">
                  <input type="checkbox" checked={xmap} onChange={(e) => setXmap(e.target.checked)} />
                  <span>跨画布</span>
                </label>
                {hits.length ? (
                  <button className="cvmini" title="下一个（Enter）"
                    onClick={() => { setHitIx((i) => (i + 1) % hits.length); focusNode(hits[(hitIx + 1) % hits.length]) }}>
                    {hitIx + 1}/{hits.length} 下一个
                  </button>
                ) : null}
                <button className="cvfindx" title="关闭（Esc）" aria-label="关闭搜索"
                  onClick={() => { setFindOpen(false); setFind('') }}>
                  <Icon n="x" size={13} />
                </button>
              </div>
              {xmap ? (
                <div className="cvhits">
                  <span>
                    {xbusy
                      ? `还在扫… ${xres?.done ?? 0}/${xres?.total ?? 0} 张`
                      : `扫了 ${xres?.total ?? 0} 张 · 命中 ${xres?.rows.length ?? 0} 条`}
                  </span>
                </div>
              ) : find.trim() && !hits.length ? <div className="cvhits none">没找到</div> : null}
              {find.trim() ? (
                xmap ? (
                  xres?.rows.length ? (
                    <div className="cvsr">
                      {xres.rows.slice(0, 20).map((r, i) => {
                        const m = maps.find((x) => x.id === r.map)
                        const mk = markParts(r.text, find)
                        return (
                          <button key={i} className="cvsr-row"
                            onClick={() => { if (m) jumpTo(m, '', r.text) }}
                            title={r.note || r.text}>
                            <b>{r.title}</b>
                            <span>{mk ? <>{mk.pre}<mark>{mk.hit}</mark>{mk.post}</> : r.text}</span>
                            {r.note ? <em>{brief(r.note, 32)}</em> : null}
                          </button>
                        )
                      })}
                      {xres.rows.length > 20 ? <div className="cvhits none">只列前 20 条，缩小搜索词再试</div> : null}
                    </div>
                  ) : xbusy ? null : <div className="cvhits none">所有画布里都没找到</div>
                ) : hits.length ? (
                  <div className="cvsr">
                    {hits.slice(0, 20).map((id) => {
                      const nx = findNode(tree, id)
                      if (!nx) return null
                      const mk = markParts(nx.text || '', find) || markParts(nx.note || '', find)
                      const isNote = !markParts(nx.text || '', find)
                      return (
                        <button key={id} className={'cvsr-row' + (id === sel ? ' on' : '')}
                          onClick={() => { setHitIx(hits.indexOf(id)); focusNode(id) }}>
                          <span>{mk ? <>{mk.pre}<mark>{mk.hit}</mark>{mk.post}</> : (nx.text || '（空）')}</span>
                          {isNote ? <em>备注里命中</em> : (nx.note ? <em>{brief(nx.note, 32)}</em> : null)}
                        </button>
                      )
                    })}
                    {hits.length > 20 ? <div className="cvhits none">命中 {hits.length} 条，只列前 20</div> : null}
                  </div>
                ) : null
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ── 右栏：检查器 ──
            没选中任何节点时**整条收起**：一个空面板常驻右侧，白白吃掉约 260px 画布宽度，
            而它的内容（节点文字/备注/颜色/结构）在没有选中时全是空的，点了也没用。
            选中一个或一批就滑出来，取消选择再滑回去。过渡交给 CSS。 */}
        <aside className={"cvright" + (count > 0 ? "" : " shut")} aria-hidden={count === 0}>
          <div className="cvph">
            <b>检查器</b>
            {/* 多选时检查器里那块「节点文字 / 备注」编辑的是主选那一个 ——
                标题里必须说清是哪一个，否则人以为自己在批量改文字。 */}
            <span>
              {count > 1 ? <>已选 <b>{count}</b> 个 · 下面只改「{selNode?.text?.slice(0, 12) || '—'}」</>
                : count === 1 ? '已选 1 个' : '没选节点'}
            </span>
          </div>
          {selNode ? (
            <div className="cvinsp">
              <section>
                <label>节点文字</label>
                <textarea className="inp" rows={2} value={selNode.text}
                  onChange={(e) => edit(selNode.id, { text: e.target.value })} />
              </section>
              <section>
                <label>备注 <em>支持 Markdown</em></label>
                <textarea className="inp" rows={4} value={selNode.note || ''}
                  onChange={(e) => edit(selNode.id, { note: e.target.value })} />
                {selNode.note ? <div className="cvmd" dangerouslySetInnerHTML={{ __html: mdHtml(selNode.note) }} /> : null}
              </section>
              <section>
                <label>颜色</label>
                <div className="cvswatch">
                  {PALETTE.map((c, i) => (
                    <button key={i} className={'cvsw' + (selNode.col === c ? ' on' : '')}
                      style={{ background: c || 'var(--cvnode)', borderColor: c || 'var(--cvline)' }}
                      title={c || '默认'} onClick={() => edit(selNode.id, { col: c })} />
                  ))}
                </div>
              </section>
              <section>
                <label>结构</label>
                <div className="cvinsp-bt">
                  <button onClick={() => addChild(selNode.id)}><Icon n="plus" size={14} />加子节点</button>
                  <button disabled={selNode.id === tree.id} onClick={() => addSibling(selNode.id)}>加同级</button>
                  <button disabled={selNode.id === tree.id} onClick={() => del(selNode.id)}><Icon n="trash" size={14} />删掉</button>
                </div>
              </section>
              <section>
                <label>原位编辑</label>
                <div className="cvinsp-bt">
                  <button onClick={() => setEditing({ id: selNode.id, mode: 'text' })}><Icon n="writing" size={14} />原地改字</button>
                  <button disabled={!(selNode.children || []).length} onClick={() => toggleFold(selNode.id)}>
                    {fold[selNode.id] ? <Icon n="down" size={14} /> : <Icon n="chev" size={14} />}
                    {fold[selNode.id] ? '展开分支' : '折叠分支'}
                  </button>
                </div>
              </section>
              {/* 备注：右栏这个入口保留，但点下去是把节点下方的浮条打开 ——
                  两处各持一份 textarea 会同时改同一条备注，很容易互相覆盖。 */}
              <section>
                <label>备注（行内）</label>
                <NoteEntry note={selNode.note} onOpen={() => setEditing({ id: selNode.id, mode: 'note' })} />
              </section>
            </div>
          ) : (
            <div className="cvside-empty">
              <Icon n="node" size={22} />
              <b>点一个节点</b>
              <span>就能改它的字、备注、颜色，也能在这儿加子节点</span>
            </div>
          )}
        </aside>
      </div>

      {menu ? <ContextMenu menu={menu} onClose={closeMenu} build={buildMenu} /> : null}

      {showSrc ? (
        <Modal
          title="笔记来源"
          sub="连上哪个，就能把那个软件里的笔记拉成导图"
          onClose={() => setShowSrc(false)}
          foot={<>
            <span className="muted">{(srcs.data?.sources || []).length} 个来源 · 拉进来的图存在本机，不会回写你没点同意的地方</span>
            <button className="btn" onClick={() => setShowSrc(false)}>关闭</button>
          </>}
        >
          <div className="srcgrid">
            {/* XMind 走 OAuth，单独一张卡 */}
            <div className={'srccard xm' + (xmSt?.connected ? ' on' : '')}>
              <span className="src-ava" style={{ background: 'linear-gradient(135deg,#FFB020,#FF8A45)', color: '#1A1000' }}>X</span>
              <div className="src-main">
                <div className="src-name">
                  <b>XMind</b>
                  <span className={'srcdot ' + (xmSt?.connected ? 'ok' : 'wait')} />
                  <em>{xmSt?.connected ? '已连上' : '没连上'}</em>
                </div>
                <div className="src-desc">
                  {xmSt?.connected
                    ? `云端导图 · 登录态 ${xmSt.expires_in ? Math.round(xmSt.expires_in / 60) + ' 分钟后过期' : '有效'} · 可拉可推`
                    : (xmSt?.reason || '要在浏览器里登录一次并点同意')}
                </div>
                {!xmSt?.connected ? (
                  <div className="src-form">
                    <input className="inp" value={xmCode2} placeholder="授权完把浏览器地址栏那串回调 URL 粘这儿"
                      onChange={(e) => setXmCode2(e.target.value)} />
                  </div>
                ) : null}
              </div>
              <div className="src-acts">
                {xmSt?.connected ? (
                  <>
                    <button className="btn sm" disabled={xmBusy} onClick={pullXm}><Icon n="cloud" size={14} />拉导图</button>
                    <button className="btn sm" disabled={xmBusy} onClick={pushXm}><Icon n="cloud" size={14} />推上去</button>
                    <button className="btn sm" onClick={async () => { await xmindLogout(); loadXm() }}>断开</button>
                  </>
                ) : (
                  <>
                    <button className="btn sm act" disabled={xmBusy} onClick={async () => {
                      setXmBusy(true)
                      const r = await xmindLogin()
                      setXmBusy(false)
                      if (r.url) { setXmUrl(r.url); window.open(r.url, '_blank') }
                      else setMsg('开登录失败：' + (r.error || '未知原因'))
                    }}>登录 XMind</button>
                    <button className="btn sm" disabled={!xmCode2.trim() || xmBusy} onClick={async () => {
                      setXmBusy(true)
                      const r = await xmindCode(xmCode2.trim())
                      setXmBusy(false)
                      setMsg(r.ok ? '已连上 XMind' : ('没连上：' + (r.error || '未知原因')))
                      if (r.ok) { setXmCode2(''); loadXm() }
                    }}>用这个连上</button>
                  </>
                )}
              </div>
            </div>

            {/* 其余九个来源：每张卡左头像、中间名字+状态+说明、右动作 */}
            {(srcs.data?.sources || []).filter((x) => x.id !== 'xmind').map((x: any) => {
              const tone = x.connected ? 'ok' : (x.ready ? 'wait' : 'off')
              return (
                <div className={'srccard' + (x.connected ? ' on' : '')} key={x.id}>
                  <span className="src-ava">{String(x.name || x.id).slice(0, 1)}</span>
                  <div className="src-main">
                    <div className="src-name">
                      <b>{x.name}</b>
                      <span className={'srcdot ' + tone} />
                      <em>{x.connected ? '能用' : x.ready ? '待接' : '不可用'}</em>
                    </div>
                    <div className="src-desc">
                      {x.id === 'local' ? '本机自带，导图存在 SQLite 里' : (x.state || '')}
                    </div>
                  </div>
                  <div className="src-acts">
                    <span className="tagg">{x.how || x.kind || ''}</span>
                    {/* 能用的才给「挑一条」：没连上的点了必然报错，不如不给（Agent.tsx 同款判据） */}
                    {x.connected && x.id !== 'local' ? (
                      <button className="btn sm" disabled={pickBusy}
                        onClick={() => openPick(x.id)}>
                        <Icon n="down" size={13} />{pickSrc === x.id ? '收起' : '挑一条'}
                      </button>
                    ) : null}
                  </div>
                  {pickSrc === x.id ? (
                    <div className="src-pick">
                      <div className="src-pick-hd">
                        <b>{x.name} 里的笔记</b>
                        <em>{pickBusy ? '正在列…' : pickItems.length + ' 条'}</em>
                      </div>
                      {pickItems.length ? (
                        <div className="src-pick-list">
                          {pickItems.map((it) => (
                            <button className="src-pick-row" key={it.id} disabled={pickBusy}
                              title={it.id}
                              onClick={() => pullItem(it)}>
                              <b>{it.title || it.id}</b>
                              <span>{bytesOf(it.bytes || it.size)}</span>
                              <em>转成画布</em>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="src-pick-empty">
                          {pickBusy ? '正在去那个文件夹里数…' : '没读到条目：路径里可能没有 md / opml 文件，或者这个来源的读法还没接好。'}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
          {xmUrl ? <div className="mdl-note">授权页已在新标签打开：{xmUrl}</div> : null}
          {msg ? <div className="mdl-note">{msg}</div> : null}
        </Modal>
      ) : null}

      {showExp ? <div className="cvesc" onClick={() => setShowExp(false)} /> : null}
      {/* 编辑视图也要能弹素材库大图 —— 编辑里点「素材」选图插进画布就是在这儿 */}
      {galLb}
      {showKeys ? (
        <div className="cvkeys" role="dialog" aria-modal="true" onClick={() => setShowKeys(false)}>
          <div className="cvkeys-box" onClick={(e) => e.stopPropagation()}>
            <header>
              <b>画布快捷键</b>
              <span>在输入框里打字时不抢键</span>
              <button className="mdl-x" onClick={() => setShowKeys(false)} title="关掉（Esc）"><Icon n="x" size={16} /></button>
            </header>
            <div className="cvkeys-grid">
              {([
                ['双击节点', '改这个节点的字'],
                ['Tab', '加一个子节点'],
                ['Enter', '加一个同级节点'],
                ['Del / Backspace', '删掉选中的节点（根节点删不掉）'],
                ['Ctrl + Z', '撤销'],
                ['Ctrl + Shift + Z', '重做'],
                ['Ctrl + A', '全选'],
                ['Shift / Ctrl 点', '加选、取消这一个'],
                ['拖空白处', '框选一批'],
                ['方向键 ↑ ↓', '在兄弟节点之间挪选择'],
                ['Esc', '取消选择 / 关掉弹层'],
                ['?', '打开这张表'],
              ] as const).map(([k, d]) => (
                <div className="cvkeys-row" key={k}>
                  <kbd>{k}</kbd>
                  <span>{d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showMd ? (
        <Modal
          wide
          title="导入 Markdown"
          sub="一级标题做主干，列表做分支 · 右边是它会变成的样子"
          onClose={() => setShowMd(false)}
          foot={<>
            <span className="muted">{mdPrev ? `会变成 ${countNodes(mdPrev)} 个节点` : '还没写内容'}</span>
            <button className="btn" onClick={() => setShowMd(false)}>取消</button>
            <button className="btn act" disabled={!mdText.trim()} onClick={importMd}>导入成导图</button>
          </>}
        >
          <div className="mdsplit">
            <div className="mdpane">
              <div className="mdpane-hd"><b>粘贴 Markdown</b><span className="n">{mdText.split('\n').length} 行</span></div>
              <textarea className="mdta" value={mdText} spellCheck={false}
                placeholder={'# 第二章 句子成分\n## 主语\n- 名词\n- 代词\n## 谓语\n- 动词'}
                onChange={(e) => setMdText(e.target.value)} />
            </div>
            <div className="mdpane prev">
              <div className="mdpane-hd"><b>会变成</b><span className="n">{countNodes(mdPrev)} 个节点</span></div>
              <div className="mdprev">
                {mdPrev ? <TreePreview node={mdPrev} /> : <div className="mdl-empty">左边写点什么，这里就会长出树来</div>}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

    </div>
  )
}

/* ── 叠层大图：素材库那张图摊开看 ──────────────────────────────
   开发文档 3.3 要求「点开能看大图、能改标题、能删、能回填到画布」。
   它没有做成弹窗，是因为弹窗会把下面那排卡盖掉 —— 翻上一张/下一张
   要看得见你在整墙里的哪个位置，所以做成压在全屏上的叠层。
   键盘：← → 翻页，Esc 关。 */
function Lightbox({ items, index, onIndex, onClose, onRename, onDel, onToCanvas, onUpload }: {
  items: any[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  onRename: (id: string, cur: string) => void
  onDel: (id: string) => void
  onToCanvas: (x: any) => void
  onUpload?: (f: File) => void
}) {
  const x = items[Math.min(Math.max(0, index), items.length - 1)]
  const go = (d: number) => {
    if (!items.length) return
    onIndex((index + d + items.length) % items.length)
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  if (!x) return null
  return (
    <div className="lbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lbox-in" onClick={(e) => e.stopPropagation()}>
        <div className="lb-stage">
          {/* 灯箱这里**必须是原图**。
              缩略图只有 480 宽，截帧上的板书字在灯箱里会被放大成一团糊 ——
              点开就是为了看清字的，给它一张缩过的图等于白点。
              所以规则只有一条：列表/卡片用缩略图，点开用原图。
              （x.url 是服务端给的原图地址；没有就自己拼 /shots/。） */}
          <img src={x.url || fullUrl(x.file)} alt={x.title || ''} />
          {items.length > 1 ? (
            <>
              <button className="lb-nav prev" onClick={() => go(-1)} title="上一张"><Icon n="chev" size={18} /></button>
              <button className="lb-nav next" onClick={() => go(1)} title="下一张"><Icon n="chev" size={18} /></button>
              <span className="lb-pos">{index + 1} / {items.length}</span>
            </>
          ) : null}
        </div>
        <aside className="lb-side">
          <div className="lb-hd">
            <b>{x.title || '未命名'}</b>
            <button className="lb-x" onClick={onClose} title="关闭（Esc）"><Icon n="x" size={16} /></button>
          </div>
          <div className="lb-rows">
            <div><span>来源</span><em>{ORIGIN_CN[x.origin] || x.origin || '—'}</em></div>
            <div><span>讲次</span><em>{x.lesson_title || '没挂讲次'}</em></div>
            {x.pos_sec != null ? <div><span>片内位置</span><em>{clock(x.pos_sec)}</em></div> : null}
            <div><span>存于</span><em>{x.age || '—'}</em></div>
            <div><span>文件</span><em className="mono">{x.file || '—'}</em></div>
          </div>
          <div className="lb-bt">
            <button className="pbtn-mn" title="作为图片节点挂到选中的节点下" onClick={() => onToCanvas(x)}>插进画布</button>
            {onUpload ? (
              <label className="pbtn-mn ghost" title="选一张本机图片，按同样的规矩插进画布">
                <Icon n="img" size={14} />本机图
                <input type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0]
                    if (f) onUpload(f)
                    e.currentTarget.value = ''
                  }} />
              </label>
            ) : null}
            <button className="pbtn-mn ghost" onClick={() => onRename(x.id, x.title)}>改名</button>
            <a className="pbtn-mn ghost" href={x.url} download>下载</a>
            <button className="pbtn-mn ghost danger" onClick={() => onDel(x.id)}>
              <Icon n="trash" size={14} />删掉
            </button>
          </div>
          <p className="lb-note">删的只是库里这条记录，盘上 data/shots/ 的图还在 —— 摘错了还能再导回来。</p>
        </aside>
      </div>
    </div>
  )
}
