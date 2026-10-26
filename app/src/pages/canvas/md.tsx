/* 备注的 Markdown —— 只做一个够用的子集，不引第三方库。
 *
 * 为什么自己写：备注框的 placeholder 一直写着「支持 Markdown」，但节点上显示的是
 * 纯文本，用户看到 `**重点**` 原样露出来。要么把这句话删掉，要么真渲染。选后者。
 *
 * 支持：标题（#~###）、无序/有序列表、行内 `code`、**粗体**、*斜体*、段落换行。
 * 不支持：表格、图片、引用块、嵌套列表 —— 备注是随手写的旁注，不是文档。
 * 也不做 HTML 直通（dangerouslySetInnerHTML 就不用了），全部走 React 元素。
 */

import type { ReactNode } from 'react'

/** 行内：`code` / **粗** / *斜*。顺序要紧：先切 code，免得 code 里的星号被当强调。 */
function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const tok = m[0]
    const k = `${key}-${i++}`
    if (tok.startsWith('`')) out.push(<code key={k} className="md-c">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<b key={k}>{tok.slice(2, -2)}</b>)
    else out.push(<i key={k}>{tok.slice(1, -1)}</i>)
    last = m.index + tok.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let list: string[] = []
  let ordered = false

  const flush = () => {
    if (!list.length) return
    const items = list.map((t, i) => <li key={i}>{inline(t, `li${blocks.length}-${i}`)}</li>)
    blocks.push(ordered
      ? <ol key={`b${blocks.length}`} className="md-list">{items}</ol>
      : <ul key={`b${blocks.length}`} className="md-list">{items}</ul>)
    list = []
  }

  lines.forEach((raw, n) => {
    const line = raw.trimEnd()
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)

    if (ul) { if (ordered) flush(); ordered = false; list.push(ul[1]); return }
    if (ol) { if (!ordered) flush(); ordered = true; list.push(ol[1]); return }
    flush()

    if (h) {
      // 备注里的一级标题不该大过节点标题，所以整体压小、只靠字重和颜色分层
      const lv = Math.min(3, h[1].length)
      blocks.push(<div key={`b${n}`} className={'md-h' + lv}>{inline(h[2], `h${n}`)}</div>)
      return
    }
    if (!line.trim()) { blocks.push(<div key={`b${n}`} className="md-gap" />); return }
    blocks.push(<p key={`b${n}`} className="md-p">{inline(line, `p${n}`)}</p>)
  })
  flush()
  return <>{blocks}</>
}
