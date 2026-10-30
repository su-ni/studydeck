import { useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { Icon } from '../components/Icon'

/* 全局搜索页。
   它自己不搜 —— 输入在顶栏那个框里，回车才进来（跳转发生在 App/Shell，
   这一页只负责把 q 拿去问后端，然后画结果）。

   为什么一个 URL 参数而不是组件间传 state：Ctrl+F 从任何地方唤起、顶栏框
   在任何页面，刷新、前进后退都要能回到同一个结果集。放进 hash 里，
   地址栏就是唯一真源。

   画布页例外：那一页按 Ctrl+F 只搜节点（App 派发 cv:find 给画布自己的框），
   本页的全局结果不该在那时候出现。所以 run() 里有一道闸 —— 地址栏停在
   #canvas 时空出结果区，也不自动跳；只有用户主动点某条结果的「前往」才跳。 */

export type Hit = {
  kind: string
  title: string
  snippet?: string
  where?: string
  score?: number
  goto?: { type: string; page?: string; source?: string; ref?: string; path?: string }
}
type Group = { name: string; items: Hit[] }

function qFromHash(): string {
  const h = (location.hash || '').replace('#', '')
  const i = h.indexOf('?')
  if (i < 0) return ''
  const qs = new URLSearchParams(h.slice(i + 1))
  return (qs.get('q') || '').trim()
}

/* 地址栏里「当前是第几页」那一段（#search?q=x 取 search，#canvas 取 canvas）。
   和 App 的 initPage 一个切法：先去 #，再切掉 ? 后面的查询串。 */
function pageSeg(): string {
  return (location.hash || '').replace('#', '').split('?')[0]
}

/* 每类结果的去处不同， Manhattan 这里统一翻译成「点一下干什么」。
   goto.type 是后端给的，它决定这一条能不能点：
   - page：直接切页
   - kb：  跳练习/课堂这一类的承载页（语义命中的原文定位还没有专用页，落到练习）
   - file：文件暂时跳不了 Viewer，所以这一组整体不可点 —— 宁可显示「暂不可点」，
           也不给一个点了没反应的链接。 */
/* 每类一个色 + 一个图标：类别不只靠文字标签区分。
   颜色沿用全站语义色（琥珀=可去的入口、绿=学习内容、灰=文件/其它），
   再加一层形状线索 —— 色盲用户和快速扫视都靠得住。 */
const KIND_TONE: Record<string, string> = {
  '页面': 'a', '能力': 'a',
  '考点': 'g', '题目': 'g', '真题': 'g', '语法题': 'g', '单词': 'g',
  '语义': 'g', '讲次': 'g', '笔记': 'g', '画布': 'g',
  '会话': 'p', '文件': 'd',
}
const KIND_ICON: Record<string, string> = {
  '页面': 'courses', '能力': 'agent',
  '考点': 'practice', '题目': 'practice', '真题': 'exam', '语法题': 'practice',
  '单词': 'vocab', '语义': 'search', '讲次': 'classroom',
  '笔记': 'writing', '画布': 'canvas',
  '会话': 'agent', '文件': 'img',
}

function place(h: Hit): { label: string; page?: string } {
  const t = h.goto?.type
  if (t === 'page') return { label: '前往', page: h.goto?.page }
  if (t === 'kb') return { label: '去练习', page: 'practice' }
  return { label: '暂不可点' }
}

export function Search({ base, go, initial }: { base: any; go: (p: any, o?: any) => void; initial?: string }) {
  /* initial 是 Ctrl+F 弹窗带过来的「刚才那一句」，优先于地址栏。
     为什么不全读 hash：从顶栏输入框回车来的路径已经把 q 写进了 hash，
     而弹窗路径没有（它不该改地址，否则等于换页）—— 两个来源得兼顾。 */
  const [q, setQ] = useState<string>(() => (initial || '').trim() || qFromHash())
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [total, setTotal] = useState(0)
  /* 分组折叠：结果多的时候（五路并排常常几十条）能先把不关心的那一路收起来。
     默认全展开 —— 折叠是省事的手段，不是藏东西的借口。 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /* 左栏筛选：点一个类别就只看那一路。'all' = 不筛。
     为什么要它：五路并排时「去哪儿」和「文件里出现过」混在一起，
     想只看题得自己往下翻 —— 有筛选就不用翻了。 */
  const [onlyKind, setOnlyKind] = useState<string>('all')
  /* 最近搜索：搜索页是独立一页、左右两侧是空的 —— 右边那栏就用来装
     这些「不用搜也知道会有用」的东西（最近搜过什么、这五路各有多少家底）。 */
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sd.recent.search') || '[]') } catch { return [] }
  })
  /* 注意：本页**没有**输入框，所以不再需要 inputRef / autoFocus。
     搜索框只有顶栏那一只（Shell 在搜索页把它挪到正中），
     本页只负责「拿 q 去问后端、把结果画出来」。 */

  /* 画布页是「只搜节点」的那一档：那一页按 Ctrl+F 唤的是画布自己的搜节点框，
     搜的也只该是节点。本页是全局搜索（页面/能力/题考点词/语义/文件/AI 会话
     一路并排），在画布页当前的时候不该出这些结果 —— 出了就是「按 Ctrl+F
     想找节点，却先看到一堆题和文件」。

     所以这里只看「现在地址栏是哪一页」这一条真源，不猜、也不靠父级传参：
     万一本页在 page 仍是 canvas 时被渲染出来（直接改 hash、或者哪天有人
     把它挂到了别处），它自己也不该画结果。
     跳转更不会自动发生：只有用户主动点了下面某一条非节点结果的「前往」
     才走（那个 onClick 里调 go），本页不替他决定离开画布。 */
  const run = (s: string) => {
    const word = (s || '').trim()
    setQ(word)
    if (!word || pageSeg() === 'canvas') { setGroups([]); setTotal(0); return }
    setLoading(true); setErr(null)
    setOnlyKind('all')
    callTool<any>('search_global', { q: word, limit: 10 })
      .then((r) => {
        if (!r.ok) { setErr(r.error || '没搜成'); setGroups([]); return }
        const d = r.data || {}
        setGroups(d.groups || [])
        setErrors(d.errors || {})
        setTotal(d.total || 0)
        // 记一笔「最近搜过」：右边那栏就是靠它撑起来的，
        // 也是「下次想再查一次同一个词」时不用重打一遍。
        if (word) {
          setRecent((prev) => {
            const next = [word, ...prev.filter((x) => x !== word)].slice(0, 8)
            try { localStorage.setItem('sd.recent.search', JSON.stringify(next)) } catch { /* 隐私模式写不了不影响用 */ }
            return next
          })
        }
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }

  /* 首次载入就搜一次。三个来源都要覆盖，且**只搜一次**：
       - initial：Ctrl+F 弹窗刚 submit 过来的词（App 保证它最新）
       - hash：  从顶栏框回车、刷新、后退、改地址
     run 的调用刻意放在 mount 当下而不是靠 hashchange —— 从别的页切过来时，
     App 那句写 hash 的 effect 与本页 mount 谁先谁后并不保证，
     而 q 此刻已经确定（initial 优先、否则读地址栏），直接读最稳。 */
  useEffect(() => {
    const w = (initial || '').trim() || qFromHash()
    if (w) run(w)
    /* 只在挂载时跑一次：后续变化由下面的 hashchange 监听接管。
       run 每次都会新建闭包，放进依赖数组会导致重复搜索。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /* 地址栏变了就跟着换（比如再从顶栏搜一次别的词）。 */
  /* hash 变了要重新判一次页：从画布页切进来（#canvas → #search?q=x）时，
     之前那次可能被上面的 canvas 闸挡掉了，结果区是空的 —— 不补这一次，
     表现就是「跳到搜索页了但一个结果都没有」，得手动改个词才出。 */
  useEffect(() => {
    const onHash = () => { const h = qFromHash(); if (h !== q || pageSeg() !== 'canvas') run(h) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [q])

  const empty = !loading && !err && q && total === 0

  /* 五路各自多少条 —— 左栏筛选要显示数字，右栏「家底」也要。
     从 groups 直接算，不额外问后端。 */
  const counts: Record<string, number> = {}
  let allCount = 0
  for (const g of groups) {
    for (const it of g.items) {
      counts[it.kind] = (counts[it.kind] || 0) + 1
      allCount++
    }
  }
  const shown = onlyKind === 'all'
    ? groups
    : groups
      .map((g) => ({ name: g.name, items: g.items.filter((it) => it.kind === onlyKind) }))
      .filter((g) => g.items.length > 0)

  return (
    <div className="spg">
      {/* ---------- 搜索头 ----------
          跟 Ctrl+F 弹窗的落点同一条中轴线：从弹窗飞过来位置连续。
          宽度跟着内容区走（不缩成一条窄栏）—— 这是「搜索页只有一页」，
          两边留白就是浪费。 */}
      {/* 这里**没有**第二个搜索框。
          搜索页的框就是顶栏那只（Shell 在本页把它挪到正中间），
          全站任何时刻只有一个输入框 —— 之前这一页自己又画了一只，
          加上 Ctrl+F 弹窗那只，同屏出现三个，用户分不清在往哪打字。 */}
      <div className="sp-head">
        <div className="sp-meta">
          {loading ? '搜索中…'
            : err ? <span className="bad">{err}</span>
              : q ? <>「{q}」共 <b>{total}</b> 条结果{onlyKind !== 'all' ? '（正在只看「' + onlyKind + '」）' : ''}</>
                : '输入关键词，回车搜索'}
        </div>
      </div>

      {Object.keys(errors).length ? (
        <div className="sp-warn">
          {Object.entries(errors).map(([k, v]) => <div key={k}>{k}：{v}</div>)}
        </div>
      ) : null}

      {/* ---------- 三栏：筛选 / 结果 / 上下文 ----------
          为什么是三栏而不是一条居中窄栏：搜索页是全站唯一一个「整页只为搜索存在」
          的页面，两侧空着就是把屏幕浪费掉。左栏放「按类别筛」，右栏放
          「最近搜过」和「这一路有多少家底」—— 两者都是搜索结果之外、
          但用户真会用到的东西，正好把宽度填满。 */}
      <div className="sp-cols">
        {/* 左：类别筛选 */}
        <aside className="sp-side sp-left">
          <div className="sp-sideHd">按类别看</div>
          <button className={'sp-facet' + (onlyKind === 'all' ? ' on' : '')}
            onClick={() => setOnlyKind('all')}>
            <span>全部</span><b>{allCount}</b>
          </button>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
            const tone = KIND_TONE[k] || 'd'
            return (
              <button key={k} className={'sp-facet' + (onlyKind === k ? ' on' : '')}
                onClick={() => setOnlyKind(onlyKind === k ? 'all' : k)}>
                <span className={'sp-dot t-' + tone} />
                <span>{k}</span><b>{n}</b>
              </button>
            )
          })}
          {!groups.length ? <div className="sp-sideEmpty">搜一次就有分类了</div> : null}
        </aside>

        {/* 中：结果 */}
        <div className="sp-main">
          {empty ? (
            <div className="sp-empty">
              <Icon n="search" size={26} />
              <div>没找到「{q}」相关的内容</div>
              <div className="sub">换个说法，或者去助手里让它联网找一次</div>
            </div>
          ) : null}

          {!groups.length && !empty && !loading ? (
            <div className="sp-intro">
              <div className="t">从这里开始</div>
              <div className="d">题库、考点卡、真题原文、讲次、笔记、画布、本机文件、AI 会话，一次全搜。</div>
              <div className="tips">
                {['虚拟语气', '绝对引用', '矛盾的普遍性', '第一台计算机'].map((x) => (
                  <button key={x} className="sp-tip" onClick={() => { location.hash = 'search?q=' + encodeURIComponent(x) }}>{x}</button>
                ))}
              </div>
            </div>
          ) : null}

          {shown.map((g) => {
            const open = !collapsed[g.name]
            return (
              <section key={g.name} className={'sp-grp' + (open ? '' : ' shut')}>
                <button className="sp-gh" aria-expanded={open}
                  onClick={() => setCollapsed((m) => ({ ...m, [g.name]: open }))}>
                  <Icon n="chev" size={13} />
                  <b>{g.name}</b>
                  <span>{g.items.length}</span>
                </button>
                {open ? (
                  <div className="sp-items">
                    {g.items.map((h, i) => {
                      const p = place(h)
                      const tone = KIND_TONE[h.kind] || 'd'
                      return (
                        <article key={i} className={'sp-item' + (p.page ? '' : ' dead')}>
                          <span className={'sp-badge t-' + tone}>
                            <Icon n={(KIND_ICON[h.kind] || 'search') as any} size={14} />
                          </span>
                          <div className="sp-body">
                            <div className="sp-t">{h.title || '（无标题）'}</div>
                            {h.snippet ? <div className="sp-s">{h.snippet}</div> : null}
                            <div className="sp-f">
                              <span className={'sp-kind t-' + tone}>{h.kind}</span>
                              {h.where ? <span className="sp-from">{h.where}</span> : null}
                              {h.score != null ? <span className="sp-sc">相似度 {h.score.toFixed(2)}</span> : null}
                            </div>
                          </div>
                          {p.page
                            ? <button className="sp-go" onClick={() => go(p.page as any)}>{p.label}</button>
                            : <button className="sp-go ghost" disabled>{p.label}</button>}
                        </article>
                      )
                    })}
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>

        {/* 右：最近搜过 + 数据家底 */}
        <aside className="sp-side sp-right">
          <div className="sp-sideHd">最近搜过</div>
          {recent.length ? recent.map((x) => (
            <button key={x} className={'sp-recent' + (x === q ? ' on' : '')}
              onClick={() => { location.hash = 'search?q=' + encodeURIComponent(x) }}>
              <Icon n="clock" size={12} /><span>{x}</span>
            </button>
          )) : <div className="sp-sideEmpty">还没有搜索记录</div>}
          {recent.length ? (
            <button className="sp-clear" onClick={() => {
              setRecent([])
              try { localStorage.removeItem('sd.recent.search') } catch { /* 写不了就算了 */ }
            }}>清空记录</button>
          ) : null}

          <div className="sp-sideHd" style={{ marginTop: 18 }}>这次搜到了什么</div>
          <div className="sp-stat"><span>命中条目</span><b>{allCount}</b></div>
          <div className="sp-stat"><span>分成几组</span><b>{groups.length}</b></div>
          <div className="sp-stat"><span>类别数</span><b>{Object.keys(counts).length}</b></div>
          {Object.keys(errors).length ? (
            <div className="sp-stat bad"><span>没查成的路</span><b>{Object.keys(errors).length}</b></div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}