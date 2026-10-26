// SVG → 位图 → base64。画布截图走这条：后端只吃 base64 PNG。

export function blobToB64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result || '')
      // data:image/png;base64,xxxxx —— 后端只要逗号后面那截
      res(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = () => rej(new Error('读不出来'))
    fr.readAsDataURL(b)
  })
}

export type Rastered = { blob: Blob; w: number; h: number }

/** 把 SVG 字符串画成 2 倍图。SVG 里绝不能用 foreignObject —— 会污染 canvas，toBlob 直接抛错。 */
export function rasterSvg(svg: string, scale = 2): Promise<Rastered | null> {
  return new Promise((res) => {
    const img = new Image()
    img.onload = () => {
      const w = img.width || 900, h = img.height || 600
      const cv = document.createElement('canvas')
      cv.width = Math.round(w * scale); cv.height = Math.round(h * scale)
      const cx = cv.getContext('2d')
      if (!cx) { res(null); return }
      cx.setTransform(scale, 0, 0, scale, 0, 0)
      cx.drawImage(img, 0, 0)
      cv.toBlob((b) => res(b ? { blob: b, w: cv.width, h: cv.height } : null), 'image/png')
    }
    img.onerror = () => res(null)
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  })
}
