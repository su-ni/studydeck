/* 构建前先把 web/app-dist 整个删掉。

   为什么非删不可：vite 的 emptyOutDir 只在 outDir 落在 vite root 之内时才敢动手，
   而这个项目的 outDir 是 ../web/app-dist（在 app/ 之外），所以那一步实际被跳过了。
   结果是每发一次版，带旧 hash 的 index-XXXX.js 就多留一份 —— 谁都不会去看
   assets 目录，直到某天有人打开一个「已经改过的」页面，跑的还是旧代码。

   ⚠️ 这里**不能**直接用 fs.rmSync(dir, {recursive:true})：实测（node v24.12.0，
   本机 Windows）对项目内的 web/ 目录它返回成功、目录却还在，readdir 照样能读到
   子文件；换成系统临时目录就正常。既然它会无声地不干活，就不给它机会 ——
   自己从上往下走一遍，每删一级都回头确认，删不掉就明说并退出，绝不假装清过。

   删的是构建产物，不是源码；路径锁死在这一处，别在别处再复制一份。 */
import { readdirSync, unlinkSync, rmdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../../web/app-dist')

if (!existsSync(out)) {
  console.log('没有 ' + out + '，不用清')
  process.exit(0)
}

/* 深度优先：先删文件，再删空的子目录，最后删根。
   遇到删不掉的直接抛 —— 带着旧包发版比构建失败更糟，因为它看起来是成功的。 */
function wipe(dir) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      wipe(p)
      rmdirSync(p)
      if (existsSync(p)) throw new Error('目录删不掉：' + p)
    } else {
      unlinkSync(p)
      if (existsSync(p)) throw new Error('文件删不掉：' + p)
    }
  }
}

try {
  wipe(out)
  rmdirSync(out)
} catch (e) {
  console.error('清空 ' + out + ' 失败：' + (e && e.message ? e.message : e))
  console.error('旧包还留在那儿。手动删掉这个目录再构建，别带着旧文件发版。')
  process.exit(1)
}

if (existsSync(out)) {
  console.error('清空后目录还在：' + out + ' —— 见本脚本开头的说明，手动删。')
  process.exit(1)
}
console.log('已清空 ' + basename(out) + '（' + out + '）')
