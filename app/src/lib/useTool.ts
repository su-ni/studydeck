import { useCallback, useEffect, useRef, useState } from 'react'
import { callTool, type ToolRes } from './api'

// 一个「调一次工具，把结果放进 state」的最小封装。
// 不自己吞错：err 会原样交给界面去显示（项目铁律 —— 不许静默失败）。
export function useTool<T = any>(name: string | null, args?: Record<string, any>, opts?: { write?: boolean; skip?: boolean }) {
  const [data, setData] = useState<T | null>(null)
  const [res, setRes] = useState<ToolRes | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const key = JSON.stringify(args ?? {})

  /* 参数按 key 走，不按对象走：调用方每次渲染都会新建 args / opts 字面量，
     直接进依赖数组会让请求每秒重发一轮，而且后发的结果把先发的顶掉 ——
     表现就是「一直在出题，题一直不出来」。 */
  const argsRef = useRef(args)
  argsRef.current = args
  const write = !!opts?.write
  const skip = !!opts?.skip

  const run = useCallback(async (overrideArgs?: Record<string, any>) => {
    if (!name) return
    const my = ++seq.current
    setLoading(true)
    const r = await callTool<T>(name, overrideArgs ?? argsRef.current, { write })
    if (my !== seq.current) return // 过期结果丢弃（页面被 paint 重绘时旧请求会晚回来）
    setRes(r)
    setData(r.ok ? (r.data as T) : null)
    setLoading(false)
    return r
  }, [name, key, write])

  useEffect(() => {
    if (skip || !name) return
    run()
    return () => { seq.current++ }
  }, [run, skip, name])

  return { data, res, loading, run, err: res && !res.ok ? (res.error || '失败') : null }
}

// 需要手动触发的（点按钮才调），不给自动跑。
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = useCallback(async (name: string, args?: Record<string, any>, o?: { confirm?: boolean; write?: boolean }) => {
    setBusy(true); setErr(null)
    const r = await callTool(name, args, o)
    setBusy(false)
    if (!r.ok) { setErr(r.error || '失败'); return null }
    return r
  }, [])
  return { busy, err, run, clearErr: () => setErr(null) }
}
