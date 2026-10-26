/* 画布的树操作纯函数库。
 * 抽出来的理由：Canvas.tsx 已经一千二百多行，树操作散在组件里，
 * 右键菜单、大纲视图、导出、批量操作各抄一份「找父 / 删一支 / 换爹」，
 * 改一处漏三处。这里收口成无副作用的函数，组件只负责把结果交给 push()。
 *
 * 铁律：**一律不改入参**。撤销栈存的是 JSON 快照，谁原地改了树，
 * 撤销回去也是被改过的样子。
 */

import type { NodeType } from './blocks'

export type TNode = {
  id: string
  text: string
  note?: string
  col?: string
  /** 这块内容该怎么画。空着不慌 —— typeOf() 能按正文重新认出来，
      所以老数据、MD 导入、OPML 同步进来一律不用补字段。 */
  type?: NodeType
  children?: TNode[]
}

let seq = 0
export const nid = () => 'n' + Date.now().toString(36) + (seq++).toString(36)

export function newTree(text = '未命名画布'): TNode {
  return { id: nid(), text, col: '', children: [{ id: nid(), text: '第一个分支', col: '', children: [] }] }
}

/** 深拷贝。树上没有函数/Date，JSON 够用。 */
export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

export function walkAll(
  n: TNode,
  fn: (x: TNode, parent: TNode | null, depth: number) => void,
  parent: TNode | null = null,
  depth = 0,
): void {
  fn(n, parent, depth)
  for (const c of n.children || []) walkAll(c, fn, n, depth + 1)
}

export function findNode(root: TNode, id: string): TNode | null {
  if (root.id === id) return root
  for (const c of root.children || []) {
    const r = findNode(c, id)
    if (r) return r
  }
  return null
}

export function findParent(root: TNode, id: string): TNode | null {
  for (const c of root.children || []) {
    if (c.id === id) return root
    const r = findParent(c, id)
    if (r) return r
  }
  return null
}

/** 根到该节点的路径（含首尾）。找不到给 []。 */
export function pathTo(root: TNode, id: string): TNode[] {
  if (root.id === id) return [root]
  for (const c of root.children || []) {
    const p = pathTo(c, id)
    if (p.length) return [root, ...p]
  }
  return []
}

export function countNodes(root: TNode): number {
  let n = 0
  walkAll(root, () => { n++ })
  return n
}

export function depthOf(root: TNode, id: string): number {
  return Math.max(0, pathTo(root, id).length - 1)
}

/** 子树所有 id（含自己）。 */
export function idsIn(n: TNode): string[] {
  const out: string[] = []
  walkAll(n, (x) => { out.push(x.id) })
  return out
}

/** 把 node 挂到 parentId 的第 index 位。 */
export function attach(root: TNode, node: TNode, parentId: string, index = -1): TNode {
  const t = clone(root)
  const p = findNode(t, parentId)
  if (!p) return t
  p.children = p.children || []
  if (index < 0 || index > p.children.length) p.children.push(node)
  else p.children.splice(index, 0, node)
  return t
}

/** 摘掉一个节点（连带整棵子树）。根节点摘不掉。 */
export function detach(root: TNode, id: string): TNode {
  const t = clone(root)
  if (t.id === id) return t
  const p = findParent(t, id)
  if (p) p.children = (p.children || []).filter((c) => c.id !== id)
  return t
}

/** 批量摘除：祖先也在名单里就只摘祖先。根节点永远剔除。 */
export function detachMany(root: TNode, ids: string[]): TNode {
  const gone = new Set(ids.filter((x) => x !== root.id))
  if (!gone.size) return root
  const under = (id: string): boolean => {
    let p = findParent(root, id)
    while (p) { if (gone.has(p.id)) return true; p = findParent(root, p.id) }
    return false
  }
  let t: TNode = root
  for (const id of [...gone].filter((id) => !under(id))) t = detach(t, id)
  return t
}

/** 换父节点。不许挂进自己的子树，根节点不许挪。 */
export function reparent(root: TNode, id: string, newParentId: string, index = -1): TNode {
  if (id === root.id) return root
  const sub = findNode(root, id)
  if (!sub) return root
  if (idsIn(sub).includes(newParentId)) return root
  const node = clone(sub)
  return attach(detach(root, id), node, newParentId, index)
}

/** 同一父节点下挪一位。到头就不动。 */
export function moveWithin(root: TNode, id: string, dir: -1 | 1): TNode {
  const p = findParent(root, id)
  if (!p) return root
  const arr0 = p.children || []
  const i = arr0.findIndex((c) => c.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= arr0.length) return root
  const t = clone(root)
  const arr = findParent(t, id)!.children!
  const [x] = arr.splice(i, 1)
  arr.splice(j, 0, x)
  return t
}

/** 只留这一支：删光兄弟，父节点保留。 */
export function keepOnly(root: TNode, id: string): TNode {
  const p = findParent(root, id)
  if (!p) return root
  return detachMany(root, (p.children || []).filter((c) => c.id !== id).map((c) => c.id))
}

/** 复制子树并全部重发 id（粘贴用）。 */
export function withFreshIds(n: TNode): TNode {
  const c = clone(n)
  walkAll(c, (x) => { x.id = nid() })
  return c
}

/** 全折叠 / 全展开。 */
export function foldAll(root: TNode, on: boolean): Record<string, 1> {
  const out: Record<string, 1> = {}
  if (!on) return out
  walkAll(root, (x) => { if ((x.children || []).length) out[x.id] = 1 })
  return out
}

/** 按文本估节点宽度：中文 14px、其余 8px，留 40px 内边距，夹在 [190,360]。 */
export function estWidth(text: string): number {
  let px = 0
  for (const ch of String(text || '')) px += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 14 : 8
  return Math.max(190, Math.min(360, px + 40))
}

/** 大纲里点一行 → 需要展开的祖先 id 列表（好让它在画布上真的可见）。 */
export function ancestorsOf(root: TNode, id: string): string[] {
  return pathTo(root, id).slice(0, -1).map((x) => x.id)
}
