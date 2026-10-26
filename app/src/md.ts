/* 聊天里的 Markdown 渲染：只做聊天用得到的那几种。

   为什么不引 marked/dompurify：这一页只显示本机模型吐的字，
   用得上的语法就那么几样（分点 / 粗体 / 行内码 / 代码块 / 标题 / 引用 / 链接 / 表格），
   自己写一百来行就能覆盖，还不用给客户端多加两个包的体积。

   安全口径（跟 canvas.js 里那套一致）：**先整段转义，再往里插自己的标签**。
   转义在前面，模型的任何字都不可能变成真标签；后面加的标签全是这段代码自己写的，
   唯一能被外部控制的地方是链接的 href —— 所以链接只允许 http/https/# 开头。 */

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/* ---------------- 代码块高亮（够看就行，不引 prism） ----------------

   聊天里出现的代码 90% 是「这个字段长这样」「这段配置这样写」，读者只需要
   一眼分清 关键字 / 字符串 / 注释 / 数字。所以不追求语法树，只做这四类着色。
   做法：先在**未转义**的原文上把字符串和注释换成占位符（否则里面的关键字会被
   误着色、里面的引号会打乱正则），转义之后再加关键字和数字的 span，最后还原。 */

const KW = new Set(('if else elif for while return function def class import from const let var ' +
  'new try catch finally throw switch case default break continue in of is not and or ' +
  'None True False null true false undefined void int float double char bool string long short ' +
  'struct enum typedef static public private protected async await yield lambda with as self this ' +
  'package interface extends implements include printf main cout cin using namespace template ' +
  'typename do goto extern volatile unsigned signed sizeof print range len dict list set tuple ' +
  'SELECT FROM WHERE INSERT UPDATE DELETE JOIN ON GROUP ORDER BY LIMIT CREATE TABLE').split(' '))

const HASH_COMMENT = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|ini|conf|r|rb|perl|pl)$/

function hl(code: string, lang: string): string {
  if (!lang) return esc(code)
  const marks: string[] = []
  const hold = (s: string, cls: string) => {
    marks.push('<span class="tok-' + cls + '">' + esc(s) + '</span>')
    return '\u0001' + (marks.length - 1) + '\u0001'
  }
  let t = code
  if (HASH_COMMENT.test(lang)) {
    t = t.replace(/#[^\n]*/g, (m) => hold(m, 'cm'))
  } else {
    t = t.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => hold(m, 'cm'))
  }
  t = t.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => hold(m, 'st'))
  t = esc(t)
  t = t.replace(/\b([A-Za-z_]\w*)\b/g, (m) => (KW.has(m) ? '<span class="tok-kw">' + m + '</span>' : m))
  t = t.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-nu">$1</span>')
  return t.replace(/\u0001(\d+)\u0001/g, (_m, i) => marks[+i])
}

/* ```html 块不是拿来读的，是拿来「跑」的：模型可以自己画一张卡片、一个对比表、
   一台小计算器塞进来给人看 —— 这才是「内嵌网页」该有的用法。
   沙箱只放 allow-scripts，**不放 allow-same-origin**：里面碰不到本页的
   localStorage、登录态和 DOM，最多自己算自己的。
   另外注入一段量高度的脚本，让它自己把真实高度报给外层，不然固定 320px
   要么留白要么截断。 */
const FIT = '<script>(function(){function h(){try{parent.postMessage({sdFrameH:document.documentElement.scrollHeight},\'*\')}catch(e){}}' +
  'addEventListener("load",h);setTimeout(h,60);setTimeout(h,400);' +
  'try{new MutationObserver(h).observe(document.documentElement,{subtree:true,childList:true,attributes:true})}catch(e){}})();<\/script>'

export function mdHtmlFrame(code: string): string {
  return '<div class="mhtml"><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" ' +
    'srcdoc="' + esc(FIT + code) + '"></iframe></div>'
}

function inline(s: string) {
  // 行内码先占位，免得里面的 * _ 被当成强调
  const codes: string[] = []
  let t = s.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c)
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  t = t.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+|#[^\s)]*)\)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => '<code>' + codes[+i] + '</code>')
  return t
}

export function md(src: string): string {
  const lines = String(src || '').split('\n')
  const out: string[] = []
  let i = 0
  let inUl = false
  let inOl = false
  let inQuote = false

  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false }
    if (inOl) { out.push('</ol>'); inOl = false }
  }
  const closeQuote = () => {
    if (inQuote) { out.push('</blockquote>'); inQuote = false }
  }
  const closeAll = () => { closeList(); closeQuote() }

  while (i < lines.length) {
    const raw = lines[i]
    const ln = raw.trimEnd()

    // 代码围栏
    if (/^\s*```/.test(ln)) {
      closeAll()
      const lang = ln.replace(/^\s*```/, '').trim().toLowerCase()
      const raw: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { raw.push(lines[i]); i++ }
      i++ // 吃掉收尾那行 ```
      const code = raw.join('\n')
      if (lang === 'html' || lang === 'htm') {
        out.push(mdHtmlFrame(code))
        continue
      }
      out.push('<pre class="mpre"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') +
        '><code>' + hl(code, lang) + '</code></pre>')
      continue
    }

    if (!ln.trim()) { closeAll(); i++; continue }

    // 分隔线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(ln)) { closeAll(); out.push('<hr/>'); i++; continue }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(ln)
    if (h) {
      closeAll()
      const lv = Math.min(h[1].length + 2, 5)   // # → h3，## → h4，聊天里别用太大
      out.push('<h' + lv + '>' + inline(esc(h[2])) + '</h' + lv + '>')
      i++
      continue
    }

    // 引用
    const q = /^>\s?(.*)$/.exec(ln)
    if (q) {
      closeList()
      if (!inQuote) { out.push('<blockquote>'); inQuote = true }
      out.push('<p>' + inline(esc(q[1])) + '</p>')
      i++
      continue
    }
    closeQuote()

    // 无序列表
    const ul = /^\s*[-*+]\s+(.*)$/.exec(ln)
    if (ul) {
      if (inOl) closeList()
      if (!inUl) { out.push('<ul>'); inUl = true }
      out.push('<li>' + inline(esc(ul[1])) + '</li>')
      i++
      continue
    }

    // 有序列表
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(ln)
    if (ol) {
      if (inUl) closeList()
      if (!inOl) { out.push('<ol>'); inOl = true }
      out.push('<li>' + inline(esc(ol[1])) + '</li>')
      i++
      continue
    }

    // 表格：| a | b |  + 分隔行
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeAll()
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(ln)
      i += 2
      const body: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i++ }
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + inline(esc(c)) + '</th>').join('') +
        '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(esc(c)) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>')
      continue
    }

    closeList()
    out.push('<p>' + inline(esc(ln)) + '</p>')
    i++
  }
  closeAll()
  /* 不能 join('\n') —— .cbub 是 white-space:pre-wrap，标签之间那个换行会被
     当成真文本渲染成一条 25px 的空行，于是「列表项 25 高、间距 52」这种
     看着像排版失控的怪相。结构已经由标签表达，块之间不留字符。 */
  return out.join('')
}
