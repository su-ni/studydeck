// 画布导出的纯函数：只吃树，不摸 DOM（下载那一步在 Canvas.tsx 里）。
// 规矩：这里一个网络请求都不发，一个 React 都不引 —— 纯字符串进、纯字符串出，
// 导出结果跟屏幕上看到的一致，且绝不 import 回 Canvas（会成环）。

export type XNode = { id: string; text: string; note?: string; col?: string; children?: XNode[] }

/** 深度优先遍历（和 Canvas.tsx 里 walkAll 同一口径：先自己，再按顺序下钻）。 */
export function xWalk(
  n: XNode | null,
  fn: (x: XNode, parent: XNode | null, depth: number) => void,
  parent: XNode | null = null,
  depth = 0,
) {
  if (!n) return
  fn(n, parent, depth)
  ;(n.children || []).forEach((c) => xWalk(c, fn, n, depth + 1))
}

export function xCount(root: XNode | null) {
  let n = 0
  xWalk(root, () => { n++ })
  return n
}

function escXml(s: string) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' } as Record<string, string>
  )[c] || c)
}

/** 文件名：去掉路径分隔符与 Windows 不允许的字符，空标题落到「未命名画布」。 */
export function safeName(t: string) {
  const s = String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  return (s || '未命名画布').slice(0, 60)
}

// ---- 1. OPML（大纲软件通用格式；层级、备注、颜色都能带走） ----
export function toOpml(root: XNode | null, title: string): string {
  if (!root) return ''
  const date = new Date().toLocaleString('zh-CN', { hour12: false })
  const one = (n: XNode): string => {
    // _note 是 OmniOutliner / 幕布 认的私有属性；note 属性是 OPML 半通用的写法 —— 两个都写。
    const attrs = [
      `text="${escXml(n.text || '')}"`,
      n.note ? `_note="${escXml(n.note)}"` : '',
      n.note ? `note="${escXml(n.note)}"` : '',
      n.col ? `color="${escXml(n.col)}"` : '',
    ].filter(Boolean).join(' ')
    const kids = (n.children || [])
    if (!kids.length) return `<outline ${attrs}/>`
    return `<outline ${attrs}>\n${kids.map(one).join('\n')}\n</outline>`
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escXml(title || '未命名画布')}</title>`,
    `    <dateCreated>${escXml(date)}</dateCreated>`,
    '  </head>',
    '  <body>',
    one(root),
    '  </body>',
    '</opml>',
  ].join('\n')
}

// ---- 2. 纯文本缩进（粘贴到任何地方都不会变形） ----
export function toIndentText(root: XNode | null): string {
  if (!root) return ''
  const L: string[] = []
  xWalk(root, (n, _p, d) => {
    L.push('  '.repeat(d) + (n.text || '（空）'))
    if (n.note) (n.note || '').split('\n').forEach((line) => L.push('  '.repeat(d + 1) + '| ' + line))
  })
  return L.join('\n')
}

// ---- 3. JSON：id / 颜色 / 备注 / 子节点全保留，能原样再导回来 ----
export function toJson(root: XNode | null, title: string): string {
  if (!root) return ''
  return JSON.stringify(
    { format: 'studydeck.canvas', version: 1, title: title || '未命名画布', exported: new Date().toISOString(), tree: root },
    null, 2,
  )
}

/** 从导出的 JSON 里认回一棵树（结构不对就返回 null，绝不硬套）。 */
export function fromJson(text: string): XNode | null {
  try {
    const d: any = JSON.parse(text)
    const t = d && (d.tree || d)
    if (!t || typeof t !== 'object' || typeof t.text !== 'string') return null
    const clean = (n: any): XNode => ({
      id: String(n.id || ''),
      text: String(n.text ?? ''),
      note: n.note ? String(n.note) : undefined,
      col: n.col ? String(n.col) : undefined,
      children: Array.isArray(n.children) ? n.children.map(clean) : [],
    })
    return clean(t)
  } catch { return null }
}

// ---- 4. Markdown（顶栏原来的导出口径，搬过来一处维护） ----
export function toMarkdown(root: XNode | null): string {
  if (!root) return ''
  const L: string[] = []
  xWalk(root, (n, _p, depth) => {
    const head = depth === 0 ? '# ' : depth === 1 ? '## ' : '  '.repeat(Math.max(0, depth - 2)) + '- '
    L.push(head + (n.text || ''))
    if (n.note) L.push('  ' + n.note.split('\n').join('\n  '))
  })
  return L.join('\n')
}

// ---- 5. 预览树里那句备注 → 一行摘要（搜索列表用，别把整段塞进一行） ----
export function brief(s: string, max = 40) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

// ---- 6. 在任何文本里标出搜索命中（返回三截，交给 React 渲染，不用 innerHTML） ----
export function markParts(text: string, q: string): { pre: string; hit: string; post: string } | null {
  const t = String(text || '')
  const needle = String(q || '').trim()
  if (!needle) return null
  const i = t.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return null
  return { pre: t.slice(0, i), hit: t.slice(i, i + needle.length), post: t.slice(i + needle.length) }
}
