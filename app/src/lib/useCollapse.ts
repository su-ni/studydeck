import { useEffect, useRef, useState } from 'react'

/* 收起动画：React 卸载节点的那一瞬间，过渡是没机会播的。
 * 所以「收起」要拆成两步 —— 先给节点挂 .closing 让它播完 190ms，
 * 再把这个节点从状态里删掉。直接删 = 硬切，这就是原来「展开有动画、
 * 收起没有」的成因。
 *
 * 用法：
 *   const { open, shown, close } = useCollapse(!!doc)
 *   {shown ? <div className={open ? '' : 'closing'}>…</div> : null}
 * 收起时调 close() 而不是直接把状态置空。
 */
export function useCollapse(want: boolean, ms = 190) {
  const [shown, setShown] = useState(want)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (want) { setShown(true); return }
    // 想关：交给动画播完再真删
    if (!shown) return
    timer.current = setTimeout(() => setShown(false), ms)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [want, ms, shown])

  return { open: want && shown, shown }
}
