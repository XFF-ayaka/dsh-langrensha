# 发布到 GitHub / npm

本仓库已经**准备好了所有发布所需文件**（LICENSE、.gitignore、CI、CHANGELOG、package.json 元数据），
署名信息也已写好：**GitHub `XFF-ayaka` / 署名 `Floyd`**。

> fork 或改名后请重跑一次署名工具（它会改 `package.json` / `LICENSE` / `README.md` badge）：
> ```powershell
> node tools/set-identity.mjs --user <你的 GitHub 用户名> --name <署名>
> ```

## 发布前自检

```powershell
# 1) 全板子回归（含 Markdown 落盘校验）
node test/dry-run.mjs

# 2) 插件入口能正常载入
node -e "import('./lib/index.js').then(m => console.log(m.name, m.inject))"

# 3) 确认没有机器相关的绝对路径混进来
Select-String -Path (Get-ChildItem -Recurse -File | Where-Object FullName -notmatch 'node_modules') `
  -Pattern 'C:\\Users\\[A-Za-z]|E:\\DSHofficial' -ErrorAction SilentlyContinue
```

## 方式 A：网页上传（不想装 git 时）

1. GitHub 新建**空仓库** `dsh-werewolf`（不要勾 Add README / .gitignore / license）。
2. 仓库页 → **Add file → Upload files**。
3. 打开本目录，**Ctrl+A 全选里面的内容**（不是拖本目录本身），拖进上传框。
4. 确认 **22 个文件**、目录层级完整（`lib/`、`tools/`、`test/`、`examples/`、`.github/workflows/`）。
5. Commit message 建议：`feat: DSH 狼人杀模式 v1.1.0（警长竞选 + Markdown 导出 + Agent 预设）`。

> ⚠️ 拖本目录本身会多套一层；`.github/workflows/ci.yml` 是唯一一个藏在带点目录里的文件，漏了 CI 就不会跑。
> 若浏览器把目录拍平，就按目录分批上传（先 `lib` 再 `tools`…），每次一次 commit。

## 方式 B：命令行（需要 git）

> ⚠️ 部分机器上没装 git（`git --version` 报 `CommandNotFoundException`）。
> 先装 [Git for Windows](https://git-scm.com/download/win)（或 `winget install --id Git.Git -e`），
> 重开终端后再执行。

```powershell
cd <仓库目录>\dsh-werewolf

git init
git branch -M main

# 提交前看一眼会提交哪些文件（node_modules / werewolf-logs 已被 .gitignore 排除）
git add .
git status --short

git commit -m "feat: DSH 狼人杀模式 v1.1.0（警长竞选 + Markdown 导出 + Agent 预设）"

# 先在 GitHub 网页上新建空仓库（不要勾选 README/.gitignore/License），然后：
git remote add origin https://github.com/XFF-ayaka/dsh-werewolf.git
git push -u origin main
```

## （可选）发布到 npm

插件本身零依赖、纯 ESM、`files` 白名单已配好：

```powershell
npm login
npm publish --access public     # package.json 里 publishConfig.access 已是 public
```

发布后别人就能用 `dsh plugin --profile <profile> add dsh-werewolf` 安装。

## 发布前自检清单

- [x] `node test/dry-run.mjs` 全绿（CI 会自动再跑一遍，含 12 人局 30 局压力回归）
- [x] `node -e "import('./lib/index.js').then(m=>console.log(m.name, m.inject))"` 不报错
- [x] 署名已写入：`XFF-ayaka` / `Floyd`（`node tools/set-identity.mjs` 可重跑）
- [x] 没有 `C:\Users\...` / `E:\...` 之类的本机路径
- [x] 只提交 22 个源文件（无 `node_modules`、无 `.dsh` profile、无导出的对局记录）
- [ ] 上传后到 **Actions** 标签页确认 CI 跑起来了
- [ ] 在仓库 **About → Topics** 填关键词
- [ ] （可选）录一段演示 GIF 放进 `docs/`，并在 README 里引用

## 给使用者的两条安装路径（README 已写明）

```powershell
# A. 插件（必装）：同步到 profile + 在 cordis.patch.yml 加一行
.\sync.ps1
# 然后把 README「方式 A」里那段 insert 粘到 <DSH_HOME>\profiles\<profile>\cordis.patch.yml

# B. 模式（可选）：装 Agent Preset
node tools\apply-preset.mjs
# 刷新浏览器（F5）→ 设置 → Agent 预设 → 自定义 → 狼人杀模式
```
