import { useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { useTool } from '../lib/useTool'
import { Icon } from './Icon'

/* B 站账号：官方扫码登录。

   为什么是扫码而不是「读浏览器 cookie」：Chrome / Edge / Firefox 各存各的，
   浏览器开着的时候 Cookies 库还被独占锁 —— 读不到，读到了也过期。
   扫码是唯一不受环境影响的那条路。

   为什么要在界面上：没登录只能到 480P（免登录档），登录后才有 1080P。
   这件事以前只能靠助手一句话「帮我登录 B 站」，人不知道它到底做没做。
   现在是一行状态 + 一个按钮：QR 码画出来、每 2 秒问一次结果、成了就写本机。

   两处共用：课程主页侧栏（画质那一行）、课堂播放器工具栏。 */

type St = {
  logged_in: boolean; expires_in_days?: number | null; note?: string
  uname?: string; face?: string; level?: number; mid?: number
}
type Me = { ok: boolean; logged_in: boolean; uname?: string; face?: string; mid?: number; level?: number }
type Qr = { url: string; qrcode_key: string; svg?: string | null; expires_in?: number }

export function BiliLogin({ label = true, compact = false }: { label?: boolean; compact?: boolean }) {
  /* 一个工具就够：昵称头像跟着登录态一起回来（以前分两个请求，
     中间那一瞬是「已登录 · 没有昵称」，看着像没登上）。 */
  const st = useTool<St>('bili_login_state')
  const [open, setOpen] = useState(false)
  const [qr, setQr] = useState<Qr | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [armedOut, setArmedOut] = useState(false)
  const [done, setDone] = useState(false)
  const alive = useRef(true)

  const on = !!st.data?.logged_in
  const days = st.data?.expires_in_days

  async function getQr() {
    setBusy(true)
    setMsg('在取二维码…')
    const r = await callTool<Qr>('bili_login_qr', {})
    setBusy(false)
    if (!alive.current) return
    if (r.ok && r.data?.url) {
      setQr(r.data)
      setMsg('用手机 B 站扫这个码，扫完在手机上点「确认登录」')
    } else {
      setQr(null)
      setMsg(r.error || r.data?.error || '没取到二维码')
    }
  }

  function close() {
    setOpen(false)
    setQr(null)
    setMsg(null)
    setDone(false)
  }

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 打开就取一张。二维码本身 180 秒过期，过期了要人点一下重取 —— 不静默换码，
  // 否则人扫了半天，扫的是一张已经换掉的图。
  useEffect(() => {
    if (open && !qr && !done) getQr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 每 2.2 秒问一次。轮询而不是等回调：官方就是这么设计的（poll 接口带状态码）。
  useEffect(() => {
    if (!open || !qr?.qrcode_key) return
    let dead = false
    const iv = setInterval(async () => {
      const r = await callTool('bili_login_poll', { qrcode_key: qr.qrcode_key })
      if (dead || !alive.current) return
      if (r.ok) {
        setDone(true)
        setQr(null)
        setMsg(r.data?.say || '登录成功，现在能看 1080P 了')
        st.run()
        setTimeout(() => { if (!dead) close() }, 1600)
        return
      }
      const code = r.data?.code
      if (code === 86038) { setQr(null); setMsg('二维码过期了 —— 点下面「重新取一张」') }
      else if (code === 86090) setMsg('扫上了，在手机上点「确认登录」')
      else if (code === 86101) setMsg('还没扫到 —— 手机 B 站右上角扫一扫')
      else setMsg(r.data?.state || r.error || '还没成')
    }, 2200)
    return () => { dead = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, qr?.qrcode_key])

  async function logout() {
    if (!armedOut) { setArmedOut(true); return }
    const r = await callTool('bili_logout', {})
    setArmedOut(false)
    setMsg(r.ok ? '已退出，回到 480P' : (r.error || '没退成'))
    st.run()
  }

  return (
    <>
      {compact ? (
        /* 课堂工具栏上只留一颗「还没登录」的按钮：那里是干活的地方，
           不该出现「480P · 未登录」这种状态行 —— 状态在课程主页侧栏看。 */
        on ? null : (
          <button className="pbtn-mn ghost" onClick={() => setOpen(true)}
            title="扫一下，之后所有 B 站课都能到 1080P">
            <Icon n="sound" size={14} />登录 B 站 · 1080P
          </button>
        )
      ) : (
        /* 两行：上面是谁（头像 + 昵称），下面是什么档（1080P · 剩几天）。
           一行塞「B 站账号」+ 昵称 + 天数 + 退出按钮，在 288px 的侧栏里必然挤成竖排 ——
           踩过，截图里「B 站账号」被压成四个字一行一行往下掉。 */
        <div className="blrow">
          {on && st.data?.face ? <img className="av" src={st.data.face} alt="" referrerPolicy="no-referrer" /> : null}
          <div className="who">
            <b>{on ? (st.data?.uname || '已登录') : '没登录'}</b>
            <i>
              {on
                ? '1080P' + (st.data?.level ? ' · Lv' + st.data.level : '') + (days != null ? ' · 剩 ' + days + ' 天' : '')
                : '最高 480P · 扫码解锁 1080P'}
            </i>
          </div>
          {on ? (
            <button className="pbtn-mn ghost" onClick={logout}>
              {armedOut ? '再点一次' : '退出'}
            </button>
          ) : (
            <button className="pbtn-mn" onClick={() => setOpen(true)}>扫码登录</button>
          )}
        </div>
      )}

      {open ? (
        <div className="blqr-scrim" onClick={close}>
          <div className="blqr" role="dialog" aria-label="B 站扫码登录" onClick={(e) => e.stopPropagation()}>
            <div className="blqr-hd">
              <b>{done ? '登录成功' : 'B 站扫码登录'}</b>
              <button className="pbtn-mn icon" aria-label="关闭" onClick={close}>
                <Icon n="x" size={16} />
              </button>
            </div>
            <p className="blqr-sub">
              {done ? '凭证存在本机，现在能看 1080P。' : '手机 B 站 → 右上角扫一扫。凭证只存本机，不上传。'}
            </p>
            {!done ? (
              <div className="blqr-img">
                {qr?.svg
                  ? <img src={qr.svg} alt="B 站登录二维码" width={196} height={196} />
                  : <span className="blqr-wait">{busy ? '取二维码…' : '没有二维码'}</span>}
              </div>
            ) : (
              <div className="blqr-ok"><Icon n="check" size={30} /></div>
            )}
            <div className="blqr-msg">{msg}</div>
            <div className="blqr-ft">
              {!done ? (
                <button className="pbtn-mn ghost" onClick={getQr} disabled={busy}>重新取一张</button>
              ) : null}
              {qr?.url ? (
                <a className="blqr-link" href={qr.url} target="_blank" rel="noreferrer">在浏览器里打开</a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
