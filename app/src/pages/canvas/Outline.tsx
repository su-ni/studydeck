import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { markParts, xWalk, type XNode } from './exporters'

/* 左栏第二个 tab：大纲。
   为什么要有：导图适合「想」，大纲适合「读」和「找」——
   一张 80 个节点的图铺开后要眯着眼睛找，大纲一行一条，扫一遍就定位。
   它不重复画布的编辑能力（不改字、不加节点），只管三件事：
   看层级、跳过去、挪层级（← → 两个按钮，等价于「拖着改父节点」）。 */

export type OutlineProps = {
  tree: XNode | null
  sel: string | null
  fold: Record<string, 1>
  onPick: (id: string) => void
  onToggleFold: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  find?: string
}

type Row = { n: XNode; depth: number; parent: string | null; hasKids: number; hidden: boolean }

export function Outline({ tree, sel, fold, onPick, onToggleFold, onMove, find }: OutlineProps) {
  /* 折叠「继承」父级：父收起时子孙也不摆出来，但不改 fold 本身 ——
     否则展开父节点时会把下面所有枝全炸开，跟画布里的行为对不上。 */
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    let cut = -1
    xWalk(tree, (n, p, d) => {
      const parentId = p ? p.id : null
      const hidden = cut >= 0 && d > cut
      if (!hidden && fold[n.id] && d > 0) cut = d
      if (hidden) return
      out.push({ n, depth: d, parent: parentId, hasKids: (n.children || []).length, hidden: false })
    })
    return out
  }, [tree, fold])

  const kidsOf = (id: string) => rows.filter((r) => r.parent === id).length
  const total = rows.length
  const [onlyHit, setOnlyHit] = useState(false)
  const q = (find || '').trim().toLowerCase()
  const shown = onlyHit && q
    ? rows.filter((r) => (r.n.text || '').toLowerCase().includes(q) || (r.n.note || '').toLowerCase().includes(q))
    : rows

  if (!tree) {
    return (
      <div className="cvoutline">
        <div className="cvside-empty">
          <Icon n="node" size={22} />
          <b>还没有画布</b>
          <span>先在上面新建一张，或者打开一张已有的</span>
        </div>
      </div>
    )
  }

  return (
    <div className="cvoutline">
      <div className="cvoutline-hd">
        <span>{total} 行</span>
        {Object.keys(fold).length ? <em>{Object.keys(fold).length} 处折叠</em> : null}
        {q ? (
          <button className={'cvmini' + (onlyHit ? ' on' : '')} onClick={() => setOnlyHit((v) => !v)}
            title="只列搜到的行（不改变画布本身）">只列命中</button>
        ) : null}
      </div>
      <div className="cvoutline-list">
        {shown.map((r) => {
          const isSel = r.n.id === sel
          const closed = !!fold[r.n.id] && r.depth > 0
          const mark = markParts(r.n.text || '', find || '')
          return (
            <div
              key={r.n.id || r.depth + String(r.n.text)}
              className={'cvoline' + (isSel ? ' on' : '') + (r.depth === 0 ? ' root' : '')}
              style={{ paddingLeft: 6 + r.depth * 14 }}
              role="button"
              tabIndex={0}
              onClick={() => onPick(r.n.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onPick(r.n.id) }}
              title={r.n.note ? r.n.text + '\n\n' + r.n.note : r.n.text}
            >
              <button
                className={'cvtwist' + (r.hasKids ? '' : ' none') + (closed ? ' closed' : '')}
                onClick={(e) => { e.stopPropagation(); if (r.hasKids) onToggleFold(r.n.id) }}
                tabIndex={-1}
                title={r.hasKids ? (closed ? '展开这一支' : '收起这一支') : '没有子节点'}
              >
                <Icon n="chev" size={11} />
              </button>
              <span className="cvodot" style={r.n.col ? { background: r.n.col, borderColor: r.n.col } : undefined} />
              <span className="cvotx">
                {mark
                  ? <>{mark.pre}<mark>{mark.hit}</mark>{mark.post}</>
                  : (r.n.text || '（空）')}
              </span>
              {r.n.note ? <Icon n="md" size={11} /> : null}
              {closed ? <b className="cvokid">+{kidsOf(r.n.id)}</b> : null}
              <span className="cvoact">
                <button className="cvmini" tabIndex={-1} title="升一级（挂到爷爷下面）"
                  disabled={r.depth === 0} onClick={(e) => { e.stopPropagation(); onMove(r.n.id, -1) }}>←</button>
                <button className="cvmini" tabIndex={-1} title="降一级（挂到上一个兄弟下面）"
                  disabled={r.depth === 0} onClick={(e) => { e.stopPropagation(); onMove(r.n.id, 1) }}>→</button>
              </span>
            </div>
          )
        })}
        {!shown.length ? <div className="cvside-empty"><b>没有命中的行</b><span>关掉「只列命中」看全部</span></div> : null}
      </div>
    </div>
  )
}
