/* 画布节点本体：中心主题 / 一级分支 / 二级往下，三种造型。
 *
 * 从 Canvas.tsx 拆出来的理由：Canvas.tsx 已经一千九百行，节点里现在要放
 * 折行文本、层级造型、折叠钮、备注角标、原地编辑器、悬停工具条、四个连线点。
 * 塞回去就是又一个八百行文件。
 *
 * 三条约定：
 * 1) 宽度高度一律由 autolayout 算好、ReactFlow 写在行内，这里**不许再写死尺寸**。
 *    以前 .cvnode 里那条 max-width:190px 就是把长标题截成 190 宽的元凶。
 * 2) 文字**不许省略号**。导图就是用来看字的，藏字等于没用。
 * 3) 连线点：**根节点左右各给一个 source**（id 分别是 s-l / s-r）。
 *    根节点没有 side —— 它两边都要长。只给一个源点的话，向左那一半分支的线
 *    会从根的右腰出发、绕一大圈甩到左边去，屏幕上就是一条横穿整块画布的直线。
 *    这一条踩过，注释留在这儿防复发。
 */

import { Handle, Position, type NodeProps } from 'reactflow'
import { styleOf } from './autolayout'
import { typeOf, type NodeType } from './blocks'
import { NodeBlock } from './BlockView'
import { NodeEditor, NodeTools, NoteBadge, NoteFloat } from './NodeEditor'

export type MindData = {
  text: string
  note?: string
  col: string
  depth: number
  fold?: boolean
  kids?: number
  /** 整张画布选了几个。>1 时本节点那条工具条要让位给跟手的那条。 */
  multi?: number
  isRoot?: boolean
  busy?: boolean
  editing?: boolean
  noteEditing?: boolean
  /** 这一支朝哪边长：1 右、-1 左。连线点据此选边。 */
  side?: 1 | -1
  /** 这块内容的类型。不传也可以 —— 会按正文重新认。 */
  type?: NodeType
  /** 图片块用的预览基址（/noteimg/<来源>?p=相对路径）。本机画布不用传。 */
  imgBase?: string
  /** 展开着的浮层。同一时刻只许开一个，所以由 Canvas 持着传下来。 */
  pop?: 'color' | null
  onAddChild?: (id: string) => void
  onAddSibling?: (id: string) => void
  onToggleFold?: (id: string) => void
  onColor?: (id: string) => void
  onPickColor?: (id: string, col: string) => void
  onClosePop?: () => void
  onDelete?: (id: string) => void
  onNote?: (id: string) => void
  onCommit?: (id: string, text: string) => void
  onCancel?: () => void
  onSaveNote?: (id: string, note: string) => void
  onCloseNote?: () => void
}

export function MindNode({ id, data, selected }: NodeProps<MindData>) {
  const d = data
  const depth = d.depth
  const st = styleOf(depth)
  const side = d.side ?? 1
  const isRoot = depth === 0
  /* 这块内容该怎么画。type 是提示，不是权威 —— 没写就按正文重新认，
     认不出来当文字。autolayout.boxOf 用的是同一套判断，所以盒子对得上。 */
  const ty: NodeType = d.type || typeOf({ type: d.type, text: d.text })
  const cls = [
    'cvnode', 'd' + Math.min(3, depth),
    side === -1 ? 'lk-left' : '',
    selected ? 'sel' : '',
    d.fold ? 'fold' : '',
    d.busy ? 'editing' : '',
    d.note ? 'hasnote' : '',
  ].filter(Boolean).join(' ')

  // 四级不同造型：中心实心琥珀、一级描边稍亮、二级正常、三级更淡。
  // 只走 CSS 变量，不写死颜色 —— 浅色画布（.cvdark.paper）下也成立。
  const rootStyle = isRoot
    ? { background: 'var(--cvroot)', borderColor: 'var(--cvroot)', color: 'var(--cvroottx)' }
    : {}
  const custom = d.col ? { borderColor: d.col } : {}
  const textColor = d.col && depth > 0 ? { color: d.col } : {}

  return (
    <div className={cls}
      style={{
        ...rootStyle, ...custom,
        padding: `${st.padY}px ${st.padX}px`,
        borderRadius: isRoot ? 16 : Math.max(7, 12 - depth * 2),
        fontSize: st.fs,
        lineHeight: st.lh,
        // 一级分支左边一条 3px 的标题色条，像导图的主枝
        ...(depth === 1 && d.col ? { borderLeft: `3px solid ${d.col}` } : {}),
      }}>
      {/* 入边：左支从右边进、右支从左边进。
          根节点不需要入边，但 Handle 还是给一个 —— 缺了 ReactFlow 会报警告。 */}
      <Handle type="target" position={side === -1 ? Position.Right : Position.Left} className="cvhandle" id="t" />

      <span className={'tx blk-' + ty + (d.text && d.text.trim() ? '' : ' empty')} style={textColor}>
        {/* 内容一律走 NodeBlock 分派：文字以外的代码块 / 表格 / 待办 / 提示 / 公式
            各有自己的排法。代号 ty 进 class，样式在 app.css 的「节点块」段。 */}
        <NodeBlock text={d.text || ''} ty={ty} st={st} imgBase={d.imgBase} />
      </span>
      <NoteBadge note={d.note} />
      {/* 折叠钮：显示被收起来的子孙**总数**，不只是直接孩子 ——
          「+3」看不出底下到底藏了多少，人会以为只藏了三个。 */}
      {/* 折叠后这颗「+N」必须自己能点开。
          它长得就像个按钮，人肯定会去点 —— 点了没反应正是用户那句
          「点了也没什么用」的来源。这里给它补上点击、键盘和 hover 态。 */}
      {d.fold ? (
        <span className="foldb" role="button" tabIndex={0}
          title={`已折叠 ${d.kids ?? 0} 个下级节点 · 点一下展开`}
          onClick={(e) => { e.stopPropagation(); d.onToggleFold?.(id) }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); d.onToggleFold?.(id) } }}>
          +{d.kids ?? 0}
        </span>
      ) : null}
      {d.busy ? null : (
        <NodeTools id={id} multi={(d.multi ?? 0) > 1} isRoot={!!d.isRoot} folded={!!d.fold} kids={d.kids ?? 0}
          col={d.col} pop={d.pop ?? null}
          onAddChild={(x) => d.onAddChild?.(x)} onAddSibling={(x) => d.onAddSibling?.(x)}
          onToggleFold={(x) => d.onToggleFold?.(x)} onColor={(x) => d.onColor?.(x)}
          onPickColor={(x, c) => d.onPickColor?.(x, c)} onClosePop={() => d.onClosePop?.()}
          onDelete={(x) => d.onDelete?.(x)} onNote={(x) => d.onNote?.(x)} />
      )}

      {/* 出边：普通节点只朝自己那一侧开一个口；根节点左右各一个。
          两个 Handle 都叫 's' 会冲突，所以按边分 id，Canvas 里按子节点
          在左还是在右挑一个连出去。竖树/放射用底部那个。 */}
      {/* ⚠ 这三个 Handle 必须**平铺**成 .cvnode 的直接子元素。
          reactflow v11 是靠 Children 逐层找 <Handle> 来登记连线点的，
          包一层 Fragment（isRoot ? <>…</> : …）它就不认了 —— 表现是节点上
          只剩 2 个点、左支没有源点，线从右腰甩到左边去横穿整块画布。
          所以宁可多给两个用不上的，也不做条件包裹。 */}
      <Handle type="source" position={side === -1 ? Position.Left : Position.Right} className="cvhandle" id="s" />
      <Handle type="source" position={Position.Right} className="cvhandle cvh-extra" id="s-r" />
      <Handle type="source" position={Position.Left} className="cvhandle cvh-extra" id="s-l" />
      <Handle type="source" position={Position.Bottom} className="cvhandle cvh-extra" id="s-b" />

      {/* 原地编辑器：双击进入，Enter 存 / Esc 弃。绝对定位挂在节点上，不参与布局。 */}
      {d.busy ? (
        <NodeEditor text={d.text} depth={d.depth} hasNote={!!d.note}
          onCommit={(v) => d.onCommit?.(id, v)} onCancel={() => d.onCancel?.()} />
      ) : null}
      {/* 备注浮条：挂在节点下方，不跑右栏 —— 双击节点时视线就在这儿。 */}
      {d.noteEditing ? (
        <NoteFloat note={d.note} onSave={(v) => d.onSaveNote?.(id, v)} onClose={() => d.onCloseNote?.()} />
      ) : null}
    </div>
  )
}
