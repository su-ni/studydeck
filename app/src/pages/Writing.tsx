import { useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Sect, Card, Li, Paper, PBtn, SChip, Empty, Mini } from '../components/V6'

/* 作文页 v6：研修台设计稿只画了五页，作文没画 —— 这一页按同一套规矩排。
   用户提过两件事，都写在这里，别再犯：
     1. 题目按钮（邀请信 / 议论文 / 通知 …）贴着上边 —— 因为那一行没有外边距，
        现在是 .pickrow-mn：上面留 16、下面留 12，而且只占一行、横着滚。
     2. 纸右边空一大块 —— 那是照抄「主栏 + 258px 窄栏」的结果，可作文的输入框是横着长的，
        窄栏只会逼着人往左缩。现在纸吃满整个宽度，批改结果接在纸下面。
   批改分两层：本机先数能数的（词数 / 要点关键词 / 格式），语言和文采才交给模型。
   模型没接上时，本机部分照样给，模型那部分如实写「没判」—— 不拿 0 分冒充。 */

type Topic = {
  id: string; year: string; kind: string; max_score: number; min_words: number
  prompt: string; points: string[]; vocab: [string, string][]; answered: number
}
type Mine = {
  id: number; ts: string; pid: string; kind: string; essay: string
  local_json: any; model_json: any; model: string; score: number | null
}
type Grade = {
  words: number; words_ok: boolean; points_total: number; points_hit: number; points_unknown: string[]
  lines: number; fmt_ok: boolean; fmt_note: string; model: string; score: number | null
  dims: Record<string, number>; level: string; errors: string[]; advice: string[]; sample: string
}

const DIM_CN: Record<string, string> = { language: '语言', content: '内容', structure: '结构', grammar: '语法' }

export function Writing({ base }: { base: Base }) {
  const tp = useTool<{ count: number; papers: Topic[] }>('writing_list')
  const mine = useTool<{ count: number; items: Mine[]; stats: any }>('writing_mine')
  const [pid, setPid] = useState<string | null>(null)
  const [essay, setEssay] = useState('')
  const [g, setG] = useState<Grade | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const list = tp.data?.papers ?? []
  const topic = list.find((t) => t.id === pid) ?? list[0]
  const past = (mine.data?.items || []).filter((m) => m.pid === topic?.id)
  const cur: Mine | undefined = past[0]
  const body = essay || cur?.essay || ''
  const show: any = g ?? cur?.model_json ?? null
  const local: any = cur?.local_json ?? null
  const words = body.trim() ? body.trim().split(/\s+/).length : 0
  const allMine = mine.data?.items || []
  const scored = allMine.map((m) => m.score).filter((n): n is number => typeof n === 'number')
  const best = scored.length ? Math.max(...scored) : null
  const need = topic?.min_words ?? 0

  async function grade() {
    if (!topic || !body.trim()) return
    setBusy(true); setErr(null); setG(null)
    const r = await callTool('writing_grade', { pid: topic.id, essay: body, save: true }, { write: true })
    setBusy(false)
    if (r.ok) { setG(r.data as Grade); mine.run() }
    else setErr(r.error || '没判出来')
  }

  const dims = show?.dims ? Object.keys(show.dims) : []
  const sc = show?.score ?? null
  const max = topic?.max_score ?? 15

  return (
    <>
      <div className="kpi-mn">
        <div>
          <div className="k">本机题目</div>
          <div className="v">{list.length}<small>道</small></div>
          <div className="s">{list.length ? '来自 workbench/data 的写作题' : '还没有写作题'}</div>
        </div>
        <div>
          <div className="k">写过的稿</div>
          <div className="v">{allMine.length}<small>篇</small></div>
          <div className="s">{allMine.length ? '存在本机，可回看' : '还没动笔'}</div>
        </div>
        <div>
          <div className="k">最高一次</div>
          <div className="v" style={best == null ? { color: 'var(--tx3)' } : undefined}>
            {best != null ? best : '—'}<small>分</small>
          </div>
          <div className="s">{scored.length ? `${scored.length} 篇有分` : '没批过不给分'}</div>
        </div>
        <div>
          <div className="k">这一篇</div>
          <div className="v">{words}<small>词</small></div>
          <div className="m"><i style={{ width: (need ? Math.min(100, (words / need) * 100) : 0) + '%' }} /></div>
          <div className="s">{need ? `要求不少于 ${need} 词` : '没有词数要求'}</div>
        </div>
      </div>

      {!list.length ? (
        <Empty title="本机没有写作题">
          写作题来自 workbench/data 里的写作题库 —— 没有题就没得写，不摆空输入框。
        </Empty>
      ) : (
        <>
          {/* 题目选择器：一行横滚，只露年份。上下都留出距离 ——
              之前贴着上边，是因为这一行没有 margin，别删。 */}
          {list.length > 1 ? (
            <div className="srcbar-mn yrbar-mn pickrow-mn">
              {list.map((t) => (
                <SChip key={t.id} on={topic?.id === t.id} title={t.kind}
                  note={t.year}
                  onClick={() => { setPid(t.id); setG(null); setEssay('') }} />
              ))}
            </div>
          ) : null}

          {/* -------- 纸：题目 + 写作框，吃满整宽 -------- */}
          <div className="wgrid-mn">
            <Paper kick={`${topic?.year ?? '—'} · ${topic?.kind ?? '—'}`}
              chips={<>
                <span className="pchip-mn">{topic?.max_score ?? '—'} 分</span>
                <span className="pchip-mn">不少于 {topic?.min_words ?? '—'} 词</span>
                <span className="pchip-mn">{past.length ? `写过 ${past.length} 稿` : '第一次写'}</span>
              </>}>
              <div className="stem-mn">{topic?.prompt}</div>

              {!!topic?.points?.length ? (
                <div className="expart-mn">
                  <div className="ix">要点</div>
                  <div className="tx">{topic.points.join('　·　')}</div>
                </div>
              ) : null}

              {!!topic?.vocab?.length ? (
                <div className="expart-mn">
                  <div className="ix">可用</div>
                  <div className="tx">
                    {topic.vocab.map((v, i) => (
                      <span key={i}><b style={{ color: 'var(--ptx)' }}>{v[0]}</b> {v[1]}{i < topic.vocab!.length - 1 ? '　' : ''}</span>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* rows 写 14 的话，空稿一进来就占掉半张纸，人得往下滚才找得到「批改」。
                  rows 只当兜底，真实高度交给 CSS 的 min/max-height。 */}
              <textarea className="wedit" rows={8} value={body}
                placeholder="用英文写这篇，写完点下面批改"
                onChange={(e) => setEssay(e.target.value)} />

              <div className="paperfoot-mn">
                <PBtn busy={busy} disabled={busy || !words} onClick={grade}>
                  {busy ? '批改中…' : '批改（本机先数，能数的先算）'}
                </PBtn>
                <span className="rt">
                  {words} 词{need ? ` / 要求 ${need}` : ''}
                </span>
              </div>
              {err ? <div className="tx" style={{ marginTop: 8, color: '#A6371A' }}>{err}</div> : null}
            </Paper>
          </div>

          {/* -------- 批改结果：接在纸下面，不再是右边那条空栏 -------- */}
          <Sect title="批改结果" right={show?.model ? '模型 ' + show.model : (cur?.model === 'local' ? '只跑了本机部分' : '还没批')} />
          <div className="twocol-mn half">
            <Card title="这次判到了什么" note={show ? undefined : '写完点批改，这里才有东西'}>
              <div className="mini-mn" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
                <Mini k="分数" v={sc != null ? sc : '—'} unit={sc != null ? ` / ${max}` : undefined} dim={sc == null} />
                <Mini k="词数" v={show?.words ?? local?.words ?? words} unit="词" />
                <Mini k="要点" v={show?.points_hit ?? local?.points_hit ?? 0}
                  unit={`/ ${show?.points_total ?? local?.points_total ?? (topic?.points?.length ?? 0)}`}
                  dim={!(show?.points_hit ?? local?.points_hit)} />
                <Mini k="格式" v={(show?.fmt_ok ?? local?.fmt_ok) ? '齐全' : '缺'} dim={!(show?.fmt_ok ?? local?.fmt_ok)} />
              </div>

              {dims.length ? dims.map((k) => (
                <Li key={k} label={DIM_CN[k] || k} pct={((show.dims[k] ?? 0) / 5) * 100}
                  color="var(--act)" value={`${show.dims[k]} / 5`} />
              )) : (
                <div className="note-mn bare">
                  语言与文采这一版没判 —— 模型没接上，或这次只跑了本机部分。点「批改」会走模型重判。
                </div>
              )}

              {!!(show?.points_unknown || local?.points_unknown || []).length ? (
                <div className="note-mn bare">
                  机器不敢算的：{(show?.points_unknown || local?.points_unknown).join('；')} —— 标成待人工看。
                </div>
              ) : null}
              {show?.fmt_note || local?.fmt_note ? (
                <div className="note-mn bare">{show?.fmt_note || local?.fmt_note}</div>
              ) : null}
            </Card>

            <Card title="这一稿写过几次" note={past.length ? `${past.length} 稿` : '还没交过'}>
              {past.length ? past.slice(0, 6).map((m) => (
                <div key={m.id} className="li-mn wide">
                  <span className="lb">{String(m.ts || '').slice(0, 16).replace('T', ' ')}　{m.score != null ? m.score + ' 分' : '没判'}</span>
                </div>
              )) : <div className="note-mn bare">还没有稿 —— 写一篇点批改，这里会留一版。</div>}
              <div className="note-mn bare">
                每次批改留一稿，回看的是当时那一版，不是改完的最新版。
              </div>
            </Card>
          </div>

          {!!(show?.advice?.length || show?.errors?.length) ? (
            <>
              <Sect title="挑出来的错与建议" right={`${(show?.errors || []).length} 处 · ${(show?.advice || []).length} 条`} />
              <div className="twocol-mn half">
                <Card title="挑出来的错" note={`${(show?.errors || []).length} 处`}>
                  {(show?.errors || []).length
                    ? (show.errors).map((a: string, i: number) => (
                      <div key={i} className="li-mn wide"><span className="lb">{a}</span></div>
                    ))
                    : <div className="note-mn bare">这次没挑出错 —— 不代表没有，是本机的规则没命中。</div>}
                </Card>
                <Card title="建议" note={`${(show?.advice || []).length} 条`}>
                  {(show?.advice || []).length
                    ? (show.advice).map((a: string, i: number) => (
                      <div key={i} className="li-mn wide"><span className="lb">{a}</span></div>
                    ))
                    : <div className="note-mn bare">模型没给建议。</div>}
                </Card>
              </div>
            </>
          ) : null}

          {show?.sample ? (
            <>
              <Sect title="范文" right="模型写的，仅供参考" />
              <Paper kick="参考范文" chips={<span className="pchip-mn">别背它，看它的结构</span>}>
                <div className="stem-mn" style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{show.sample}</div>
              </Paper>
            </>
          ) : null}

          <div className="note-mn">
            批改分两层：<b>本机能数的</b>（词数、要点关键词、格式）永远先算，<b>语言与文采</b>才交给模型。
            模型没接上时，本机部分照样给，模型那部分如实写「没判」—— 不拿 0 分冒充。
          </div>
        </>
      )}
    </>
  )
}
