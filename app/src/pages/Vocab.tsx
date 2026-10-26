import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import { Icon } from '../components/Icon'
import { Skel, Empty, PBtn } from '../components/V6'
import { Sel } from '../components/Sel'
import type { Base } from '../lib/api'

// 背单词：照「不背单词」的操作方式做，不自己发明流程。
//
//   一屏一词（学习）
//     ├ 词形大字 + 音标 + 发音（进词自动播一次，播不出来不吭声；手动点播失败才说话）
//     ├ 原声例句：一条一条摆出来，带真人音频和配图，点一下就播 —— 这是这个词的主场
//     ├ 例句中文默认折叠：先让人从英文猜，猜完再看中文
//     ├ 真卷里的句子：这个词在历年真题阅读原文里出现过的地方（来源照写）
//     └ 底部三档：不认识 / 模糊 / 认识
//   判完才摊开释义（柯林斯式分条 + 词根词缀 + 固定搭配 + 派生词 + 配图），读完点「下一个」
//
//   一组学完 → 听音拼写：播发音，一个字母一格拼出来。只拼「模糊 / 不认识」的词，
//   全认识就跳过并说明。没有发音的机器改成「看中文默写」，不假装是听写。
//
//   复习：今天到期的词，先只给词形，想完点「看答案」才翻释义，翻完再判三档。
//
// 五条硬规矩（改之前先看这里）：
//   1. 提问物与答案物不许同屏 —— 要你拼英文，屏幕上就不许有英文原型；
//      还没判的词，左栏不许露中文。
//   2. 看答案不等于答对 —— 主动点「看答案」一律记「不会」，不进 right。
//   3. 释义是判完的奖励，不是题面 —— 判之前只给例句，不给释义。
//   4. 每一屏都有回程票 —— 「结束这一组」「去清今天的复习」永远在。
//   5. 缺的东西要说出来 —— 没音频就写明「改成看中文默写」，不假装是听写。

type W = { no: number; w: string; ph?: string; pos?: string; cn?: string; mem?: { box: number; due: string; seen: number } }
type RevW = { w: string; box: number; due: string; seen: number; right: number; wrong: number; ph?: string; pos?: string; cn?: string }
// 词书：课程自带的那本，和 AI 从百词斩拉进来的那几本。keys 是这本书的组，界面按组翻。
type LibBook = { id: string; origin: 'course' | 'pulled'; name: string; count: number; groups: number; keys: string[]; first_key: string }

const POS_RE = /^[a-zA-Z]+\.\s*/
function bareCn(c?: string) {
  return String(c || '').replace(/^[;；,，、\s]+/, '')
    .split(/[;；,，、]/).map((x) => x.replace(POS_RE, '').trim())
    .filter((x) => x)[0] || ''
}

// 挖空：保留首尾，中间挖掉。只在没有发音、退化成「看中文默写」时给个提示用。
function maskOf(w: string) {
  const s = String(w || '').toLowerCase().replace(/[^a-z]/g, '')
  if (!s) return ''
  if (s.length <= 3) return s[0] + '_'.repeat(s.length - 1)
  const keep = Math.max(1, Math.round(s.length * 0.3))
  return s.slice(0, keep) + '_'.repeat(s.length - keep - 1) + s.slice(-1)
}

type Example = { en?: string; cn?: string; sentence?: string; trans?: string; img?: string; img_local?: string; audio?: string }
type Detail = {
  available?: boolean; word?: string; image?: string; image_kind?: string; image_note?: string
  phonetic?: string; phonetic_us?: string; phonetic_uk?: string
  senses?: { pos?: string; cn?: string; en?: string }[]
  examples?: Example[]
  etyma?: string | { text?: string }[]; short_phrase?: string; word_variants?: string
  audio?: string | null; audio_uk?: string | null; audio_us?: string | null
  reason?: string; error?: string
}
type ExamSent = { t?: string; src?: string; kind?: string }

type Phase = 'learn' | 'spell' | 'review' | 'end'
// 0 = 不认识  1 = 认识  2 = 模糊
type Mark = 0 | 1 | 2

const GROUP_CAP = 20 // 一组最多先学 20 个，跟「不背单词」的一组体量对齐

export function Vocab({ base: _base }: { base: Base }) {
  const [key, setKey] = useState<string | null>(null)
  const rev = useTool<{ count: number; due_today: number; words: RevW[]; intervals: number[] }>('review_today', { limit: 200 })
  const rvg = useTool<{ key: string | null; lesson_id?: string; why?: string }>('resolve_vocab_group', {})
  const groupKey = key ?? rvg.data?.key ?? null
  const grp = useTool<{ key: string; count: number; words: W[] }>('list_word_group', groupKey ? { key: groupKey } : {}, { skip: !groupKey })
  const goal = useTool<{ goal: number; done: number; left: number; has_book?: boolean; note?: string }>('word_goal', {})
  // 词书切换：AI 拉进来的词书不在这里给个入口，就等于「拉进来了但翻不开」
  const lib = useTool<{ books: LibBook[]; count: number; pulled: number; note?: string }>('vocab_library', {})
  const books = lib.data?.books ?? []
  const curBook = useMemo(
    () => books.find((b) => (b.keys || []).includes(groupKey || '')) ?? books[0],
    [books, groupKey],
  )
  const curKeys = curBook?.keys ?? []
  const words = useMemo(() => grp.data?.words ?? [], [grp.data])

  // 一组：先挑「没背过」的，最多 20 个；都背过了就整组重过一遍，并如实标出来。
  const learnQueue = useMemo(() => {
    const fresh = words.filter((w) => !w.mem || !w.mem.seen)
    const pick = fresh.length ? fresh : words
    return pick.slice(0, GROUP_CAP)
  }, [words])
  const relearn = useMemo(() => words.length > 0 && words.every((w) => w.mem && w.mem.seen), [words])

  const [phase, setPhase] = useState<Phase>('learn')
  const [li, setLi] = useState(0)
  const [marked, setMarked] = useState<Record<string, Mark>>({})
  const [revealed, setRevealed] = useState(false)
  const [rightN, setRightN] = useState(0)
  const [wrongN, setWrongN] = useState(0)
  const [fb, setFb] = useState<{ ok: boolean; t: string; r?: string } | null>(null)
  const [starred, setStarred] = useState<Record<string, 1>>({})
  const [cnOpen, setCnOpen] = useState<Record<string, 1>>({})

  const [det, setDet] = useState<Detail | null>(null)
  const [exam, setExam] = useState<{ sentences?: ExamSent[]; note?: string } | null>(null)

  const [spq, setSpq] = useState<number[]>([])
  const [spi, setSpi] = useState(0)
  const [spDone, setSpDone] = useState<Record<string, 'ok' | 'no'>>({})
  const [spReveal, setSpReveal] = useState(false)

  const [revIx, setRevIx] = useState(0)
  const [revFlip, setRevFlip] = useState(false)

  const audioEl = useRef<HTMLAudioElement | null>(null)
  const detT = useRef<any>(null)
  const revealRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const fitEl = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const box = el.parentElement?.clientWidth || 0
    if (!box) return
    el.style.fontSize = '100px'
    const need = el.scrollWidth
    if (!need) return
    el.style.fontSize = Math.max(34, Math.min(60, Math.floor((100 * box) / need))) + 'px'
  }, [])

  // 换组：一切归零
  useEffect(() => {
    if (!learnQueue.length) return
    setPhase('learn'); setLi(0); setMarked({}); setRevealed(false)
    setRightN(0); setWrongN(0); setFb(null); setCnOpen({})
    setSpq([]); setSpi(0); setSpDone({}); setSpReveal(false)
    setRevIx(0); setRevFlip(false)
  }, [learnQueue])

  const cur = learnQueue[li]
  const revWords = rev.data?.words ?? []
  const rw = revWords[revIx]
  const spWord = spq.length ? learnQueue[spq[spi]] : undefined
  const curW = phase === 'review' ? (rw?.w || '') : phase === 'spell' ? (spWord?.w || '') : (cur?.w || '')

  // 词条 + 真卷句子跟着当前词走
  useEffect(() => {
    if (!curW) { setDet(null); setExam(null); return }
    setDet(null); setExam(null)
    clearTimeout(detT.current)
    detT.current = setTimeout(async () => {
      const [d, s] = await Promise.all([
        callTool<Detail>('fetch_word_detail', { word: curW }),
        callTool<{ sentences?: ExamSent[]; note?: string }>('word_sentences', { word: curW, limit: 3 }),
      ])
      setDet(d.ok ? d.data : null)
      setExam(s.ok ? s.data : null)
    }, 200)
    return () => clearTimeout(detT.current)
  }, [curW])

  useEffect(() => () => { clearTimeout(detT.current); audioEl.current?.pause() }, [])

  // 发音：词条里 audio / audio_uk / audio_us 任一有就播。silent=true 时失败不吭声（自动播放被拦是浏览器的事）
  const speak = useCallback((url?: string | null, silent?: boolean) => {
    if (!url) {
      if (!silent) setFb({ ok: false, t: '这个词没拿到发音', r: '词条里的音频地址是空的，我不假装播过' })
      return
    }
    try {
      if (!audioEl.current) audioEl.current = new Audio()
      const a = audioEl.current
      a.pause(); a.src = url; a.currentTime = 0
      a.play().catch(() => {
        if (!silent) setFb({ ok: false, t: '音频没能播出来', r: '地址有，但这台机器播不动（可能没联网）' })
      })
    } catch {
      if (!silent) setFb({ ok: false, t: '音频没能播出来', r: '浏览器不给播' })
    }
  }, [])

  const wordAudio = det?.audio || det?.audio_uk || det?.audio_us || ''
  const phonetic = det?.phonetic || det?.phonetic_uk || cur?.ph || rw?.ph || ''

  // 进词自动播一次（浏览器拦了就拦了，不报错）
  useEffect(() => {
    if (phase !== 'learn' && phase !== 'review') return
    if (!wordAudio) return
    speak(wordAudio, true)
  }, [wordAudio, curW, phase, speak])

  const grade = useCallback(async (w: string, ok: boolean, m: string, fuzzy = 0) => {
    await callTool('grade_word', { word: w, mode: m, right: ok, fuzzy }, { write: true })
  }, [])

  // ---- 学习：三档判定 ----
  function judgeLearn(v: Mark) {
    if (!cur || marked[cur.w] !== undefined) return
    setMarked((m) => ({ ...m, [cur.w]: v }))
    setRevealed(true)
    if (v === 1) { setRightN((n) => n + 1); grade(cur.w, true, 'learn_ok') }
    else if (v === 2) { grade(cur.w, false, 'learn_fuzzy', 1) }
    else { setWrongN((n) => n + 1); grade(cur.w, false, 'learn_no') }
    clearTimeout(detT.current)
    // 判完把释义顶上来（释义在滚动区最上面），别让人自己找
    setTimeout(() => { const b = bodyRef.current; if (b) b.scrollTo({ top: 0, behavior: 'smooth' }) }, 60)
  }
  function nextLearn() {
    setFb(null); setRevealed(false)
    if (li + 1 >= learnQueue.length) { toSpell(); return }
    setLi(li + 1)
  }
  // 学完一组 → 听音拼写（只拼模糊 + 不认识）
  function toSpell() {
    const q: number[] = []
    learnQueue.forEach((w, i) => { const v = marked[w.w]; if (v === 0 || v === 2) q.push(i) })
    if (!q.length) {
      setPhase('end')
      setFb({ ok: true, t: '这一组全认识，不用拼了', r: '一个「模糊 / 不认识」都没有，拼写测试空着也是空着' })
      return
    }
    setSpq(q); setSpi(0); setSpDone({}); setSpReveal(false); setPhase('spell'); setFb(null)
  }

  // ---- 拼写 ----
  function spellDone(ok: boolean, revealedAnswer?: boolean) {
    if (!spWord) return
    grade(spWord.w, ok, 'dictation')
    setSpDone((d) => ({ ...d, [spWord.w]: ok ? 'ok' : 'no' }))
    if (ok) setRightN((n) => n + 1); else setWrongN((n) => n + 1)
    setFb(ok
      ? { ok: true, t: '拼对了 · ' + spWord.w }
      : revealedAnswer
        ? { ok: false, t: '看答案记「不会」 · ' + spWord.w, r: '照着抄不叫会，自己拼出来才算' }
        : { ok: false, t: '正确答案 ' + spWord.w, r: '这个词明天会回来' })
    setSpReveal(!ok)
    setTimeout(() => {
      setSpReveal(false); setFb(null)
      if (spi + 1 >= spq.length) { setPhase('end'); return }
      setSpi(spi + 1)
    }, ok ? 900 : 1900)
  }

  // ---- 复习 ----
  function revJudge(g: 'ok' | 'fuzzy' | 'no') {
    if (!rw) return
    if (!revFlip) { setRevFlip(true); return }
    grade(rw.w, g === 'ok', 'rev_' + g, g === 'fuzzy' ? 1 : 0)
    if (g === 'ok') setRightN((n) => n + 1); else setWrongN((n) => n + 1)
    const next = revIx + 1
    setRevFlip(false)
    if (next >= revWords.length) {
      setPhase('learn'); setRevIx(0); rev.run()
      setFb({ ok: true, t: '今天到期的词清完了', r: '回到这一组继续学新的' })
    } else setRevIx(next)
  }

  async function star(w: string) {
    if (!w) return
    const r = await callTool('star_word', { word: w })
    if (r.ok) setStarred((s) => ({ ...s, [w]: s[w] ? (0 as any) : 1 }))
  }

  // 键盘：学习屏 1/2/3 判三档，空格或回车下一个
  useEffect(() => {
    if (phase !== 'learn') return
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!revealed) {
        if (e.key === '1') { e.preventDefault(); judgeLearn(0) }
        if (e.key === '2') { e.preventDefault(); judgeLearn(2) }
        if (e.key === '3') { e.preventDefault(); judgeLearn(1) }
      } else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); nextLearn() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  if (!groupKey && rvg.loading) return <div style={{ padding: 24 }}><Skel kind="text" n={3} /></div>
  /* 空状态也要给下一步。原来这里是一行灰字，人看完不知道该点哪儿 ——
     现在留一枚按钮跳回「今天该学的那一组」，真走不动才说打算不出来。 */
  if (!groupKey) {
    return (
      <Empty title="没找到词组">
        {rvg.data?.why ? <>{rvg.data.why} · </> : null}
        上面的词组列表里换一组试试；不知道该学什么就回今日那一页，它会按数据告诉你要不要背词。
        <div style={{ marginTop: 10 }}>
          <PBtn onClick={() => { location.hash = 'today' }}>回今日看看该学什么</PBtn>
        </div>
      </Empty>
    )
  }
  if (!grp.data && grp.loading) return <div style={{ padding: 24 }}><Skel kind="text" n={3} /></div>

  const prog = phase === 'review' ? (revIx + 1) / Math.max(1, revWords.length)
    : phase === 'spell' ? (spi + 1) / Math.max(1, spq.length)
      : (li + 1) / Math.max(1, learnQueue.length)
  const phaseName = phase === 'learn' ? '学习 · 一屏一词'
    : phase === 'spell' ? '听音拼写'
      : phase === 'review' ? '复习 · 今天到期' : '成绩单'
  const donutPct = rightN + wrongN > 0 ? Math.round((rightN / (rightN + wrongN)) * 100) : 0
  const CIRC = 276

  // 左栏：跟着当前阶段换队列；还没判的词不许露中文（那一栏就是答案本身）
  // 左栏的中文就是答案：复习没翻之前不给、学习没判之前不给；拼写阶段中文是题面，照给
  const rail: { w: string; cn?: string; on: boolean; st: string }[] = phase === 'review'
    ? revWords.map((r, i) => ({ w: r.w, cn: revFlip ? r.cn : undefined, on: i === revIx, st: '' }))
    : (phase === 'spell' ? spq.map((i) => learnQueue[i]) : learnQueue).map((w, i) => {
      const v = marked[w.w]
      const at = phase === 'spell' ? spq.indexOf(learnQueue.indexOf(w)) : i
      return {
        w: w.w,
        cn: phase === 'spell' || v !== undefined ? w.cn : undefined,
        on: phase === 'spell' ? spq[spi] === learnQueue.indexOf(w) : i === li,
        st: v === 1 ? 'ok' : v === 0 || v === 2 ? 'no' : '',
        _at: at,
      } as any
    })

  const mk = cur ? marked[cur.w] : undefined
  const spAudio = spWord ? (det?.audio || det?.audio_uk || det?.audio_us || '') : ''
  const etymaText = (() => {
    const e = det?.etyma
    if (typeof e === 'string') return e
    if (Array.isArray(e)) return (e[0] as any)?.text || ''
    return ''
  })()

  return (
    <div className="vx">
      <aside className="vx-q">
        <div className="vx-q-hd">
          <b>{phase === 'review' ? '待复习' : phase === 'spell' ? '要拼的词' : '这一组'}</b>
          <span className="n">{rail.length} 词</span>
        </div>
        <div className="vx-q-body">
          {rail.map((r, i) => (
            <button key={r.w + i} className={'vx-w' + (r.on ? ' on' : '') + (r.st ? ' ' + r.st : '')}
              onClick={() => {
                if (phase === 'review') { setRevIx(i); setRevFlip(false); return }
                if (phase === 'spell') { const at = spq.indexOf(learnQueue.findIndex((x) => x.w === r.w)); if (at >= 0) { setSpi(at); setSpReveal(false); setFb(null) } return }
                if (phase === 'learn') { setLi(i); setRevealed(marked[r.w] !== undefined); setFb(null) }
              }}>
              <i className="dot" />
              {/* 拼写阶段左栏不能把要拼的词摆出来 —— 那就是答案本身。判过的才放行。 */}
              <span className="w">{phase === 'spell' && !spDone[r.w] ? maskOf(r.w) : r.w}</span>
              <span className="cn">{phase === 'spell' || marked[r.w] !== undefined || phase === 'review' ? bareCn(r.cn) : ''}</span>
            </button>
          ))}
        </div>
        {phase === 'learn' && learnQueue.length < words.length ? (
          <div className="vx-note" style={{ padding: '8px 14px 12px' }}>
            这一组共 {words.length} 个，先学 {learnQueue.length} 个。
          </div>
        ) : null}
      </aside>

      <main className="vx-main">
        {/* 词书 / 组：拉进来的词书必须有入口，不然就是「拉进来了但翻不开」。
            选词书 → 跳到这本第 1 组；选组 → 直接切这一组（换组一切归零）。 */}
        {books.length > 1 ? (
          <div className="vx-book">
            <Sel className="vx-sel" value={curBook?.id || ''}
              ariaLabel="选词书"
              onChange={(v) => {
                const b = books.find((x) => x.id === v)
                if (b && b.first_key) setKey(b.first_key)
              }}
              options={books.map((b) => ({
                value: b.id,
                label: b.name,
                note: `${b.count} 词 · ${b.origin === 'pulled' ? '拉进来的' : '课程配套'}`,
              }))} />
            {curKeys.length > 1 ? (
              <Sel className="vx-sel group" value={curKeys.includes(groupKey || '') ? (groupKey as string) : ''}
                ariaLabel="选组"
                onChange={(v) => { if (v) setKey(v) }}
                options={curKeys.map((k) => ({ value: k, label: k.replace('|', ' · ') }))} />
            ) : null}
            <span className="vx-book-n">{curBook ? `共 ${curBook.groups} 组` : ''}</span>
          </div>
        ) : null}
        <div className="vx-bar">
          <span className="vx-tag">{phaseName}</span>
          <div className="vx-prog"><i style={{ width: Math.min(100, prog * 100) + '%' }} /></div>
          <div className="vx-bar-r">
            <button className="vx-ic" title="播放发音" onClick={() => speak(phase === 'spell' ? spAudio : wordAudio)}><Icon n="sound" size={16} /></button>
            <button className={'vx-ic' + (starred[curW] ? ' on' : '')} title="收藏" onClick={() => star(curW)}><Icon n="star" size={15} /></button>
            {phase !== 'end' ? <button className="vx-btn" onClick={() => setPhase('end')}>结束这一组</button> : null}
          </div>
        </div>

        <div className="vx-stage">
          {phase === 'end' ? (
            <EndCard marked={marked} spDone={spDone} due={rev.data?.due_today ?? 0} words={words.length}
              onLearnAgain={() => { setLi(0); setRevealed(false); setMarked({}); setRightN(0); setWrongN(0); setPhase('learn') }}
              onSpell={() => { const q: number[] = []; learnQueue.forEach((w, i) => { const v = marked[w.w]; if (v === 0 || v === 2) q.push(i) }); if (!q.length) { setFb({ ok: false, t: '没有要拼的词', r: '这一组全认识，拼写测试是空的' }); return } setSpq(q); setSpi(0); setSpDone({}); setPhase('spell') }}
              onReview={() => { setPhase('review'); setRevIx(0); setRevFlip(false) }}
              onNext={() => { setMarked({}); setLi(0); setRevealed(false); setRightN(0); setWrongN(0); setPhase('learn'); grp.run() }}
            />
          ) : phase === 'review' ? (
            <div className="vx-card vx-learn vx-auto" key="review">
              {rw ? (
                <>
                  <div className="vx-learn-body" ref={bodyRef}>
                    <div className="vx-bigword" ref={fitEl}>{rw.w}</div>
                    <div className="vx-lw-hd">
                      <button className="vx-lw-spk" onClick={() => speak(wordAudio)} title="播这个词的发音"><Icon n="sound" size={14} /></button>
                      <span className="vx-lw-ph">{rw.ph || phonetic || '音标没取到'}</span>
                    </div>
                    <div className="vx-lw-rule" />
                    {revFlip ? (
                      <div className="vx-mean" ref={revealRef}>
                        <div className="vx-mrow big"><i>{rw.pos || ''}</i><span>{rw.cn || ''}</span></div>
                        {det?.image ? <img className="vx-mean-pic" src={det.image} alt="" /> : null}
                      </div>
                    ) : (
                      <div className="vx-note">先自己想意思 —— 想完再翻。翻开不算答对，判分在翻完之后。</div>
                    )}
                  </div>
                  <div className="vx-learn-foot">
                    {!revFlip ? (
                      <button className="vx-btn act wide" onClick={() => setRevFlip(true)}>看答案</button>
                    ) : (
                      <>
                        <div className="vx-ask">刚才想起来了吗</div>
                        <div className="vx-judge">
                          <button className="vx-jb no" onClick={() => revJudge('no')}><b>不认识</b><u>1</u></button>
                          <button className="vx-jb mid" onClick={() => revJudge('fuzzy')}><b>模糊</b><u>2</u></button>
                          <button className="vx-jb ok" onClick={() => revJudge('ok')}><b>认识</b><u>3</u></button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : <div className="vx-note">今天没有到期的词。</div>}
            </div>
          ) : phase === 'spell' ? (
            <div className="vx-card vx-learn vx-auto" key="spell">
              {spWord ? (
                <>
                  <div className="vx-learn-body vx-spell" ref={bodyRef}>
                  <div className="vx-spell-hd">
                    {spAudio
                      ? <><button className="spk" onClick={() => speak(spAudio)}><Icon n="sound" size={20} /></button>
                        <span>听发音，把这个词拼出来</span></>
                      : <span className="vx-muted">这台机器没拿到发音 —— 改成看中文默写（{maskOf(spWord.w)}）</span>}
                  </div>
                  <div className="vx-prompt">{bareCn(spWord.cn)}</div>
                  <FillRow
                    key={spWord.w}
                    target={spWord.w}
                    disabled={spReveal}
                    onDone={spellDone}
                    hint={spReveal ? '正确答案 ' + spWord.w : undefined}
                  />
                  </div>
                </>
              ) : <div className="vx-note">拼写队列是空的。</div>}
            </div>
          ) : (
            <div className="vx-card vx-learn vx-fill" key="learn">
              {cur ? (
                <>
                  <div className="vx-learn-body" ref={bodyRef}>
                  <div className="vx-bigword" ref={fitEl}>{cur.w}</div>
                  <div className="vx-lw-hd">
                    <button className="vx-lw-spk" onClick={() => speak(wordAudio)} title="播这个词的发音"><Icon n="sound" size={14} /></button>
                    <span className="vx-lw-ph">{phonetic || '音标没取到'}</span>
                    {det?.phonetic_us && det.phonetic_us !== phonetic ? <em className="vx-lw-us">{det.phonetic_us}</em> : null}
                  </div>
                  <div className="vx-lw-rule" />

                  {/* 原声例句：这个词的主场。中文默认折叠，先让人从英文猜 */}
                  <div className="vx-sents">
                    {(det?.examples || []).slice(0, 2).map((x, i) => {
                      const en = x.en || x.sentence || ''
                      const cn = x.cn || x.trans || ''
                      const opened = !!cnOpen[cur.w + '#' + i]
                      return (
                        <div className={'vx-sent' + (x.img_local ? ' has-pic' : '')} key={i}>
                          <div className="vx-sent-txt">
                            <div className="vx-sent-hd">
                              {x.audio
                                ? <button className="vx-sent-play" onClick={() => speak(x.audio, true)} title="播这一句的原声"><Icon n="play" size={13} /></button>
                                : <span className="vx-sent-nosnd" title="这条例句没有音频">·</span>}
                              <span className="vx-sent-en">{en}</span>
                            </div>
                            {cn ? (opened
                              ? <div className="vx-sent-cn">{cn}</div>
                              : <button className="vx-sent-cnbtn" onClick={() => setCnOpen((o) => ({ ...o, [cur.w + '#' + i]: 1 }))}>看中文</button>) : null}
                          </div>
                          {x.img_local ? <img className="vx-sent-pic" src={x.img_local} alt="" /> : null}
                        </div>
                      )
                    })}
                    {det && !(det.examples || []).length && det.available !== false ? (
                      <div className="vx-note">这个词条没有例句。</div>
                    ) : null}
                    {det?.available === false ? (
                      <div className="vx-note">百词斩词条没取到：{det.reason || det.error || '没这个词条'}</div>
                    ) : null}
                  </div>

                  {/* 真卷里的句子：判完才摆。判分前它只占高度，把正文顶出滚动条 */}
                  {revealed && exam?.sentences?.length ? (
                    <div className="vx-exam">
                      <div className="vx-exam-h">真卷里的句子</div>
                      {exam.sentences.slice(0, 2).map((s, i) => (
                        <div className="vx-exam-s" key={i}>
                          <em>{s.t}</em>
                          <span>{s.src}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* 判完才摊开释义：释义属于「答案」，所以它进滚动区，不占底部判分区 */}
                  {revealed ? (
                    <div className="vx-mean" ref={revealRef}>
                      <div className="vx-mean-grid">
                        <div className="vx-mean-l">
                          <div className="vx-mrow big"><i>{cur.pos || ''}</i><span>{cur.cn || ''}</span></div>
                          {(det?.senses || []).filter((x) => x.cn || x.en).slice(0, 4).map((x, i) => (
                            <div className="vx-mrow" key={i}><i>{x.pos || ''}</i><span>{x.cn || x.en}</span></div>
                          ))}
                          {etymaText ? <div className="vx-mrow"><i>根</i><span>{etymaText}</span></div> : null}
                          {det?.short_phrase ? <div className="vx-mrow"><i>搭</i><span>{det.short_phrase}</span></div> : null}
                          {det?.word_variants ? <div className="vx-mrow"><i>变</i><span>{det.word_variants}</span></div> : null}
                        </div>
                        {det?.image ? (
                          <img className="vx-mean-pic" src={det.image} alt={cur.w + ' 配图'} />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  </div>

                  <div className="vx-learn-foot">
                  {!revealed ? (
                    <>
                      <div className="vx-ask">这个词认识吗 · 判完才摊开释义</div>
                      <div className="vx-judge">
                        <button className="vx-jb no" onClick={() => judgeLearn(0)}><b>不认识</b><u>1</u></button>
                        <button className="vx-jb mid" onClick={() => judgeLearn(2)}><b>模糊</b><u>2</u></button>
                        <button className="vx-jb ok" onClick={() => judgeLearn(1)}><b>认识</b><u>3</u></button>
                      </div>
                    </>
                  ) : (
                    <div className="vx-mean-acts">
                      <button className="vx-next" onClick={nextLearn}>
                        {li + 1 >= learnQueue.length ? '学完了，去拼写' : '下一个'} →
                      </button>
                      <span className="vx-note" style={{ margin: 0 }}>空格 / 回车也可以</span>
                    </div>
                  )}
                  </div>
                </>
              ) : <div className="vx-note">这一组没有词。</div>}
            </div>
          )}
          {fb ? <div className={'vx-fb ' + (fb.ok ? 'ok' : 'bad')}><b>{fb.t}</b>{fb.r ? <span>{fb.r}</span> : null}</div> : null}
        </div>

        {/* 回程票：每一屏都摆着 */}
        <div className="vx-rail">
          {phase !== 'learn' ? (
            <button className="vx-btn act" onClick={() => { setPhase('learn'); setRevealed(mk !== undefined); setFb(null) }}>
              回到这一组继续学
            </button>
          ) : null}
          {(rev.data?.due_today ?? 0) > 0 && phase !== 'review' ? (
            <button className="vx-btn" onClick={() => { setPhase('review'); setRevIx(0); setRevFlip(false); setFb(null) }}>
              去清今天的复习（{rev.data?.due_today}）
            </button>
          ) : null}
        </div>
      </main>

      <aside className="vx-side">
        <div className="vx-side-hd"><b>本次战绩</b><span className="n">SM-2</span></div>
        <div className="vx-ring">
          <svg width="104" height="104" viewBox="0 0 104 104">
            <circle cx="52" cy="52" r="44" stroke="var(--card2)" strokeWidth="9" fill="none" />
            <circle cx="52" cy="52" r="44" stroke="var(--act)" strokeWidth="9" fill="none"
              strokeDasharray={CIRC} strokeDashoffset={CIRC - (CIRC * donutPct) / 100} strokeLinecap="round" />
          </svg>
          <div className="c"><div className="v">{rightN + wrongN ? donutPct + '%' : '—'}</div><div className="k">正确率</div></div>
        </div>
        <div className="kv">
          <div className="kvb a"><div className="k">认识</div><div className="v">{rightN}</div></div>
          <div className="kvb b"><div className="k">不认识</div><div className="v">{wrongN}</div></div>
        </div>
        <div className="kv">
          <div className="kvb"><div className="k">这一组</div><div className="v">{learnQueue.length}</div></div>
          <div className="kvb"><div className="k">待复习</div><div className="v">{rev.data?.due_today ?? 0}</div></div>
        </div>
        {goal.data ? (
          <div className="vx-goal">
            <div className="r1"><b>{goal.data.done}</b><span>/ {goal.data.goal} 词</span></div>
            <div className="bar"><i style={{ width: Math.min(100, (goal.data.done / Math.max(1, goal.data.goal)) * 100) + '%' }} /></div>
            <div className="k">今日词量 · 来自本机作答记录</div>
          </div>
        ) : null}
        {relearn ? <div className="vx-note">这一组的词都背过了，这次是重过一遍。</div> : null}
      </aside>
    </div>
  )
}

// 一个字母一格：格子数 = 词长，自动跳下一格，退格回上一格，回车判分。
function FillRow({ target, disabled, onDone, hint }: {
  target: string; disabled?: boolean
  onDone: (ok: boolean, revealed?: boolean) => void; hint?: string
}) {
  const word = String(target || '').toLowerCase().replace(/[^a-z]/g, '')
  const [vals, setVals] = useState<string[]>(() => word.split('').map(() => ''))
  const boxes = useRef<(HTMLInputElement | null)[]>([])
  const [mark, setMark] = useState<Record<number, 'ok' | 'bad'>>({})
  useEffect(() => { setVals(word.split('').map(() => '')); setMark({}) }, [word])

  function setAt(i: number, v: string) {
    if (disabled) return
    const c = v.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(-1)
    setVals((a) => { const b = a.slice(); b[i] = c; return b })
    if (c && i + 1 < word.length) boxes.current[i + 1]?.focus()
  }
  function judge() {
    if (disabled) return
    const got = vals.join('')
    const m: Record<number, 'ok' | 'bad'> = {}
    word.split('').forEach((c, i) => { m[i] = vals[i] === c ? 'ok' : 'bad' })
    setMark(m)
    setTimeout(() => onDone(got === word, false), 600)
  }
  function keyAt(i: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !vals[i] && i > 0) boxes.current[i - 1]?.focus()
    if (e.key === 'ArrowLeft') boxes.current[i - 1]?.focus()
    if (e.key === 'ArrowRight') boxes.current[i + 1]?.focus()
    if (e.key === 'Enter') judge()
  }
  return (
    <div className="vx-spell-box">
      <div className="vx-cells">
        {word.split('').map((_c, i) => (
          <input key={i} ref={(el) => { boxes.current[i] = el }}
            className={'vx-cell' + (mark[i] ? ' ' + mark[i] : '')}
            value={vals[i]} maxLength={1} disabled={disabled}
            onChange={(e) => setAt(i, e.target.value)} onKeyDown={(e) => keyAt(i, e)} />
        ))}
      </div>
      {hint ? <div className="vx-hint">{hint}</div> : null}
      <div className="vx-hint"><kbd>←</kbd><kbd>→</kbd> 换格 · <kbd>退格</kbd> 回上一格 · <kbd>回车</kbd> 对答案</div>
      <div className="vx-fill-acts">
        <button className="vx-btn act" disabled={disabled} onClick={judge}>对答案</button>
        {/* 看答案 = 记不会。照着抄不叫会，所以这一下写进库里是 right=false */}
        <button className="vx-btn" disabled={disabled} onClick={() => {
          setVals(word.split('')); setMark({}); setTimeout(() => onDone(false, true), 400)
        }}>想不起来，看答案（记不会）</button>
      </div>
    </div>
  )
}

function EndCard({ marked, spDone, due, words, onLearnAgain, onSpell, onReview, onNext }: {
  marked: Record<string, Mark>; spDone: Record<string, 'ok' | 'no'>; due: number; words: number
  onLearnAgain: () => void; onSpell: () => void; onReview: () => void; onNext: () => void
}) {
  const vals = Object.values(marked)
  const nK = vals.filter((v) => v === 1).length
  const nF = vals.filter((v) => v === 2).length
  const nN = vals.filter((v) => v === 0).length
  const nAll = nK + nF + nN
  const sp = Object.values(spDone)
  const spOk = sp.filter((v) => v === 'ok').length
  return (
    <div className="vx-card vx-auto vx-endcard">
      <div className="vx-learn-body">
        <div className="vx-end-hd">
          <div className="vx-end-t">这一组过完了</div>
          <div className="vx-end-s">判了 {nAll} 个 · 认识 {nK} · 模糊 {nF} · 不认识 {nN}{sp.length ? ' · 拼对 ' + spOk + '/' + sp.length : ''}</div>
        </div>
        <div className="vx-end-grid">
          <div className="kvb a"><div className="k">认识</div><div className="v">{nK}</div></div>
          <div className="kvb"><div className="k">模糊</div><div className="v">{nF}</div></div>
          <div className="kvb b"><div className="k">不认识</div><div className="v">{nN}</div></div>
        </div>
        <p className="vx-note">
          {nF + nN > 0
            ? '模糊 ' + nF + ' + 不认识 ' + nN + ' = ' + (nF + nN) + ' 个，明天会回来；想现在拼就点下面。'
            : '这一组全认识，明天复习时还会再见一次。'}
        </p>
      </div>
      <div className="vx-learn-foot vx-end-acts">
        <button className="vx-btn" onClick={onLearnAgain}>再过一遍（{nAll}）</button>
        {nF + nN > 0 ? <button className="vx-btn" onClick={onSpell}>听音拼写（{nF + nN}）</button> : null}
        {due > 0 ? <button className="vx-btn" onClick={onReview}>去清今天的复习（{due}）</button> : null}
        <button className="vx-btn act" onClick={onNext}>下一组</button>
      </div>
    </div>
  )
}
