/**
 * 把仓库里的署名占位符替换成你的信息（fork / 首发都能用）。
 *
 *   node tools/set-identity.mjs --user XFF-ayaka --name Floyd
 *   node tools/set-identity.mjs --user XFF-ayaka --name "Floyd" --year 2026
 *
 * 会改三个地方：
 *   - package.json  的 repository / homepage / bugs 里的 <your-name>，以及 author
 *   - LICENSE       的版权行
 *   - README.md     的 CI badge 链接里的 <your-name>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 读取 `--key value` 形式的参数。 */
function arg(key) {
  const index = argv.indexOf(`--${key}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const user = arg('user')
const name = arg('name')
const year = arg('year') ?? String(new Date().getFullYear())

if (user === undefined || name === undefined) {
  console.error('用法：node tools/set-identity.mjs --user <github 用户名> --name <署名> [--year 2026]')
  process.exit(2)
}

// --- package.json：走 JSON 解析，避免手写字符串替换出错
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.author = name
pkg.repository = { type: 'git', url: `git+https://github.com/${user}/dsh-werewolf.git` }
pkg.homepage = `https://github.com/${user}/dsh-werewolf#readme`
pkg.bugs = { url: `https://github.com/${user}/dsh-werewolf/issues` }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

// --- LICENSE：改写版权行
const licensePath = join(root, 'LICENSE')
const license = readFileSync(licensePath, 'utf8').replace(/^Copyright \(c\) \d{4} .*$/m, `Copyright (c) ${year} ${name}`)
writeFileSync(licensePath, license, 'utf8')

// --- README.md：替换 badge 链接里的占位符
const readmePath = join(root, 'README.md')
const readme = readFileSync(readmePath, 'utf8').split('<your-name>').join(user)
writeFileSync(readmePath, readme, 'utf8')

console.log('已写入署名信息：')
console.log('  GitHub 用户名 :', user)
console.log('  署名          :', name, `（${year}）`)
console.log('  package.json  : author / repository / homepage / bugs 已更新')
console.log('  LICENSE       : 版权行已更新')
console.log('  README.md     : CI badge 链接已更新')
