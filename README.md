# dsh-werewolf — DeepSeek Harness 的「狼人杀模式」

[![CI](https://github.com/XFF-ayaka/dsh-werewolf/actions/workflows/ci.yml/badge.svg)](https://github.com/XFF-ayaka/dsh-werewolf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E6%8F%92%E4%BB%B6-blue.svg)](https://deepseek-harness.github.io/deepseek-harness/)

给 DSH 定制的一个插件 + 一个同名 DSH 模式：**让 AI 自动分裂成 1 位裁判 + N 位玩家，自己开一局狼人杀**，
裁判与玩家都是**真实子智能体**（独立会话、独立上下文、独立人格，工具被屏蔽），
所有播报与发言**实时输出到用户当前的对话框**，结束后还能**导出 Markdown 对局记录**。

> 🎲 一局 12 人标准局的实测片段（含悍跳、警长竞选、女巫毒口、狼队遗言互泼、最后狼自曝）：
> `【5号·玩家发言】我是预言家，昨夜验7号，查杀，铁狼……`
> `【7号·玩家发言】我是预言家，5号是悍跳狼，我昨晚验的就是他，查杀……`
> `【裁判】5号 当选警长（7号3票、3号2票）。警长票权 1.5，决定白天发言方向，最后发言归票。`

DSH 的「模式」= **Agent Preset**。本仓库包含两部分：

| 部分 | 作用 | 位置 |
| --- | --- | --- |
| **插件**（全局装载） | 提供 `werewolf_*` 工具、`/werewolf` 命令、系统提示词段；任何模式下都能开一局 | `<profile>\plugins\dsh-werewolf\` |
| **模式**「狼人杀模式」 | 一个 Agent Preset：狼人杀主持人 persona + 与「标准模式」相同的工具集 | `tools/preset-werewolf.yml` → 追加到 `<profile>\cordis.patch.yml` |

```
你：/werewolf 12        （或直接说「玩一局狼人杀」）
        ↓
【裁判】欢迎来到 12 人标准局（4 狼 / 预言家·女巫·猎人·白痴 / 4 民，屠边）。共 12 位玩家入座，本局有警长竞选……
【裁判·身份表（上帝视角，仅你可见）】1号 狼人｜2号 预言家｜……
【裁判】天黑请闭眼。狼人请睁眼，统一意见后刀人……
【裁判】天亮了。昨晚 5号 出局。
【裁判】现在进行警长竞选（上警）。上警的玩家请发表竞选发言，警下玩家投票选出警长。
【3号】上警。
【裁判】3号 当选警长（7号3票、3号2票）。警长票权 1.5，决定白天发言方向，最后发言归票。
【5号·遗言】我是预言家，昨晚验的是 9号，查杀……
【3号·玩家发言】我是3号。刚才5号的遗言信息量很大，我盘一下……
【7号·玩家发言】3号发言在替4号开脱，我认为他狼面偏大……
【裁判】投票结果：4号7票、9号2票，4号被放逐出局。
……
【裁判·终局】游戏结束，好人阵营获胜。……（点评）
```

## 1. 需求对照

| 你的要求 | 实现方式 |
| --- | --- |
| 给 DSH 定制一个狼人杀模式 | 一个真实的 DSH 宿主插件（cordis plugin），不是提示词模板 |
| AI 自动分裂成好几个 AI | 每次发言 = 一个独立的 `spawn` 子智能体会话（独立上下文/人格），一轮一个 AI |
| 一位裁判 + 若干位玩家 | 裁判 AI（只播报公开事实）+ N 位玩家 AI（工具被完全屏蔽，只会说话） |
| 裁判随机给玩家身份 | `assignRoles()` 用 Fisher–Yates 随机发牌，规则对齐网易官方标准局 |
| 讨论阶段每人听取别人的对话再发言 | 每位玩家发言前，提示词里带着**全部公开信息**（前面所有人的发言）+ 自己的私有信息 |
| 已出局者不再发言 | 引擎按存活名单推进；白痴翻牌后仍可发言但失去投票权 |
| 发言文字输出到用户对话框 | 每段发言/播报都作为一条 `assistant/message` 追加进用户所在会话，即时上屏 |
| 加入警长竞选 | 上警 → 竞选发言 → 警下投票 → 平票 PK 重投；1.5 票、决定发言方向、最后归票、警徽移交或撕徽 |
| 输出为 Markdown 文档 | 终局自动导出 + `werewolf_export` 手动导出：身份表、投票表、全部发言、夜间行动明细 |
| 做成一个 DSH 模式 | Agent Preset「狼人杀模式」（`tools/preset-werewolf.yml` + `tools/apply-preset.mjs`） |

## 2. 安装

插件 = 一个 npm 包形状的 bundle + 一行 profile 补丁。零运行时依赖（只用 `node:` 内置模块），
**拷到任何一台装了 DSH 的机器都能跑**（Windows / macOS / Linux）。

### 方式 0：一条命令（推荐，跨平台）

把仓库下载/克隆到任意目录，然后：

```bash
node tools/install.mjs --preset          # 装插件 + 「狼人杀模式」，默认 profile = desktop
node tools/install.mjs --profile web     # 指定 profile
node tools/install.mjs --dsh-home /path/to/dsh-home   # 指定 DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
node tools/install.mjs --dry-run         # 只打印将要做的改动
node tools/install.mjs --bump            # 升级：同步代码并把缓存版本 ?v=N 加一
```

它会自动完成三件事，**不用手改任何 YAML**：

1. 把 `lib/ tools/ test/ examples/` 等复制到 `<profile>/plugins/dsh-werewolf/`
   （必须放进 profile：DSH 的 HMR 只监听 profile 目录内的模块）；
2. 往 `<profile>/cordis.patch.yml` 写入插件行，模块 URL **按平台自动生成**
   —— Windows 用 `file:///C:/…`（Node 的 ESM loader 不接受裸盘符路径），macOS/Linux 用绝对路径；
3. 加 `--preset` 时顺便装「狼人杀模式」Agent Preset。

幂等：重复执行不会重复插入；升级用 `--bump`（改完记得在插件管理器里把
`include:werewolf` 停用再启用一次——DSH 的 ESM 模块按 URL 缓存，只有换 URL 才会换新代码）。

装完：重启 DSH（或触碰一次 `cordis.patch.yml` 触发热重载）→ 用 `/werewolf` 开局；
模式要刷新浏览器（F5）才会出现在「设置 → Agent 预设 → 自定义」。

### 方式 A：手动挂载（不想跑脚本时）

1. 把本目录放到任意位置，例如 `<你的目录>/dsh-werewolf`。
2. **把插件复制进 profile**（重要：HMR 只监听 profile 目录内的模块，放外面改了不会热重载）：

   ```powershell
   .\sync.ps1          # Windows 专用；其他平台手动复制 lib/ tools/ test/ 到 <profile>\plugins\dsh-werewolf\
   ```

3. 在 `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: werewolf
         name: 'file:///C:/Users/<你>/.dsh/profiles/desktop/plugins/dsh-werewolf/lib/index.js'
         config:
           seats: 12          # 默认人数
           godView: true      # 是否在对话里公布上帝视角身份表
           reasoningEffort: low
           turnTimeoutMs: 120000
   ```

   > Windows 下 `import()` 不接受裸盘符路径，绝对路径必须是 `file:///C:/...` 形式；
   > 也可以用相对 profile 的路径，如 `./plugins/dsh-werewolf/lib/index.js`。

4. 保存后插件会被实时装载（无需重启 DSH）。若发现改动没生效，用插件管理器把该 entry
   停用再启用一次即可强制重新挂载：

   ```
   plugin_manager set_plugin target=include:werewolf enabled=false
   plugin_manager set_plugin target=include:werewolf enabled=true
   ```

### 方式 B：作为 profile bundle 安装（发布到 npm / GitHub 之后）

发布后（见 [PUBLISH.md](PUBLISH.md)），别人可以走 DSH 自带的包管理路径：

```bash
# 命令行（dsh CLI 可用时）
dsh plugin --profile desktop add dsh-werewolf                      # 从 npm
dsh plugin --profile desktop add github:XFF-ayaka/dsh-werewolf     # 从 GitHub（需要该机装了 git）
dsh plugin --profile desktop add /path/to/dsh-werewolf             # 从本地目录

# 或者干脆用 GUI：设置 → 插件 → 安装，填入 dsh-werewolf 或 github:XFF-ayaka/dsh-werewolf
```

包内的 `cordis.patch.yml`（`dsh.bundle.patch`）会自动插入插件行，不需要手动改 YAML。
本地目录/离线安装等价写法是把它写进 profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-werewolf": "link:<你的目录>/dsh-werewolf" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-werewolf"] } }
}
```

然后在 profile 目录执行 pnpm install（DSH 自带 pnpm：
`node <DSH 安装目录>/resources/runtime/pnpm/dist/pnpm.mjs install`）。

> ⚠️ `github:` 安装需要目标机器装了 git（`git ls-remote` 会被 pnpm 调用）；
> 没有任何构建脚本，所以不需要 `allowBuilds`。

### 方式 C：安装「狼人杀模式」（Agent Preset）

DSH 的「模式」就是一个 Agent Preset：profile 补丁里一行 `@deepseek-ai/dsh-agent-preset`，
其 `config.plugins` 描述该模式的能力组合。本仓库把它做成脚本：

```powershell
node tools\apply-preset.mjs            # 装到 desktop profile（幂等）
node tools\apply-preset.mjs web        # 指定 profile
node tools\apply-preset.mjs desktop --remove   # 卸载
```

装完 **刷新浏览器（F5）**，然后到「设置 → Agent 预设 → 自定义」就能看到「狼人杀模式」，
新任务的选择器里也能选它。

> 为什么刷新？Host 侧会热重载，但客户端只在「重连 / 设置文档更新」时重读模式列表，
> 没有变更推送。另外**当前已开的会话无法切换模式**（`select` 只在首轮前允许），
> 要体验模式请开一个新任务。
>
> 设计取舍：狼人杀的 4 个工具来自**全局**的插件行，所以任何模式（含本模式）都能开一局，
> 你正在用的会话也不会因为切模式而丢能力；「狼人杀模式」的差异在于**主持人 persona**
> 与描述。若想让狼人杀只在模式内存在，可把全局 `werewolf` 行 `disabled: true`，
> 再把 `tools/preset-werewolf.yml` 里加一行指向插件文件的 `werewolf` 子行
> （子行会被前缀成 `preset-werewolf:werewolf`，与全局行 id 不冲突）。

## 3. 使用

### 工具（Agent 可直接调用）

| 工具 | 作用 |
| --- | --- |
| `werewolf_start(seats?, godView?)` | 开一局。`seats` 可选 6/8/9/10/11/12，省略用配置默认值 |
| `werewolf_status()` | 查看天数、阶段、存活/出局名单、上帝视角身份表、最近播报 |
| `werewolf_stop()` | 立刻结束本局并中断所有子智能体（已产生的记录仍可导出） |
| `werewolf_export(path?)` | 把当前/刚结束的一局导出为 **Markdown 文档**；`path` 可给目录或 `.md` 路径 |
| `werewolf_say(text)` | 以「观众」身份插一句话，会进入后续所有 AI 的公开信息 |

### Markdown 对局记录

**每局结束后会自动导出**，也可以随时手动再导一次：

```
werewolf_export                                  # → <会话工作目录>/werewolf-logs/狼人杀-20261001-2015-12人局.md
werewolf_export(path: "docs/复盘.md")            # 指定文件名
werewolf_export(path: "D:/狼人杀记录")            # 指定目录
```

默认目录可用 `config.exportDir` 改、用 `config.autoExport: false` 关掉自动导出。
导出的文档结构（见 [examples/sample-report.md](examples/sample-report.md)）：

1. **概要表**：板子、结果、天数、警长、起止时间、对局 ID
2. **身份表**：座位 / 身份 / 阵营 / 结局（含出局死因）
3. **放逐投票表**：每天每轮的票型与结果（含 PK 重投，警长按 1.5 票计）
4. **对局时间线**：按「第 N 天 · 阶段」分节，收录全部裁判播报、竞选发言、玩家发言、遗言、PK 发言
5. **夜间行动明细**（上帝视角）：每晚的守卫目标 / 狼刀 / 女巫用药 / 实际出局，以及预言家查验流水

### 斜杠命令

```
/werewolf        # 默认人数开局
/werewolf 8      # 指定 8 人局
```

命令**不经过模型**，由插件直接执行并返回结果卡片。

### 自然语言

插件会把自己注入系统提示词，所以直接说「玩一局狼人杀」「来局 12 人标准局」，
当前会话的 Agent 就会调用 `werewolf_start`。

## 4. 板子与规则

| 人数 | 配置 | 胜负 |
| --- | --- | --- |
| 6 | 2 狼 + 预言家·女巫 + 2 民 | 屠城 |
| 8 | 3 狼 + 预言家·女巫·猎人 + 2 民 | 屠城 |
| 9 | 3 狼 + 预言家·女巫·猎人 + 3 民 | 屠城 |
| 10 | 3 狼 + 预言家·女巫·猎人 + 4 民 | 屠边 |
| 11 | 3 狼 + 预言家·女巫·猎人·守卫 + 4 民 | 屠边 |
| **12（标准局）** | **4 狼 + 预言家·女巫·猎人·白痴 + 4 民** | **屠边（含警长竞选）** |
| 12.5 | 3 狼 + 预言家·女巫·猎人·守卫 + 4 民 | 屠边 |

也可以传自定义板子：`{wolves, gods, villagers, win}`。

已实现的规则细节：

- **夜晚结算顺序**：守卫 → 狼人 → 预言家 → 女巫；天亮统一结算。
- **女巫**：解药/毒药各一瓶，同一晚只能开一瓶；默认「仅首夜可自救」；毒药不可被守护挡下。
- **守卫**：可自守；不可连续两晚守同一人；同守同救默认「奶死」。
- **猎人**：被狼刀或被投票放逐可开枪，**被毒死不能开枪**（可配置）。
- **白痴**：被投票放逐时翻牌免死，之后可继续发言但失去投票权。
- **遗言**：默认只有首夜死者有遗言；被放逐者必留遗言。
- **投票**：平票 → PK 发言 → 只可在平票者之间重投 → 再平票则本轮无人出局。
- **警长竞选**（第 1 天公布死讯之后）：
  - **上警**：每位存活玩家表态是否上警；**无人上警**则本局无警长，**仅 1 人上警**则自动当选。
  - **竞选发言**：上警玩家依次发表竞选发言。
  - **警下投票**：只有**不上警**的玩家投票；平票 → 平票者 PK 发言 → 警下重投 → **再平票则本局无警长**。
  - **警长特权**：放逐投票**票权 1.5**；白天由警长决定**从左边还是右边开始发言**，且警长**最后发言归票**。
  - **警徽移交**：警长出局（被刀/被票/被毒）时，由警长 AI 决定把警徽交给某个存活玩家，或**撕掉警徽**（本局此后无警长）。
  - 默认 **9 人及以上开启**（`sheriff: true|false` 可强制开关）。
- **信息隔离**：狼刀目标、查验结果、用药、身份表都只写进对应 AI 的私有提示词；
  公开播报由裁判 AI 生成，裁判只知道「必须如实播报的事实」，不知道隐藏信息。

可配置项（写进 `cordis.patch.yml` 的 `config`）：

```yaml
seats: 12                     # 默认人数
godView: true                 # 普通用户是否看到身份表
sheriff: auto                 # 警长竞选：auto（>=9 人开启）| true | false
reasoningEffort: low          # 子智能体的思考强度（off/low/high/max）
turnTimeoutMs: 120000         # 单个 AI 一轮的超时（毫秒）
winCondition: side            # side=屠边, eliminate=屠城
witchSelfSave: first-night    # never | first-night | always
guardSelfGuard: true
sameGuardSameSaveDies: true   # 同守同救是否死亡
hunterShootWhenPoisoned: false
firstNightLastWordsOnly: true
maxDays: 30                   # 安全阀
promptOrder: 60               # 系统提示词段顺序
```

## 5. 架构

```
lib/index.js        插件入口：系统提示词段 + 4 个工具 + /werewolf 命令
lib/engine.js       对局状态机：setup → night → dawn → (警长竞选) → speech → vote 循环 → 终局
lib/rules.js        纯函数规则层：板子、发牌、夜晚结算、投票统计（含 1.5 票权重）、胜负判定
lib/prompts.js      提示词工厂：身份设定、私有信息块、各阶段指令、裁判播报指令
lib/table.js        子智能体牌桌：ctx.subagents.start('spawn') 跑一轮，session.append 上屏
lib/report.js       Markdown 报告生成器（纯函数，可脱离 DSH 单测）
tools/preset-werewolf.yml  「狼人杀模式」Agent Preset 声明（由官方 standard preset 生成）
tools/build-preset.mjs     从官方 standard.patch.yml 重新生成上面的声明
tools/apply-preset.mjs     把该声明幂等安装进 / 卸载出 profile 补丁
tools/install.mjs          一条命令装到任意 DSH profile（跨平台、幂等，--bump 升级）
tools/set-identity.mjs     fork 后一键改署名（package.json / LICENSE / README badge）
test/dry-run.mjs    离线自测：脚本化 ask/emit 跑完整局 + Markdown 落盘校验，0 次 LLM 请求
examples/sample-report.md  真实对局导出的 Markdown 样例（也可 npm run sample 离线重生成）
.github/workflows/ci.yml   CI：ubuntu + windows × node 22/24，跑全板子回归
PUBLISH.md          发布到 GitHub / npm 的清单与命令
```

数据流：

```
引擎要一段发言
  → table.run(label, briefing + 本轮指令)      // 新一轮独立子智能体，工具屏蔽
  → ctx.subagents.start('spawn', {prompt, parent, toolFilter:{allow:[]}})
  → run.result → 该 AI 这一轮的文本
  → 引擎解析【投票】/【狼刀】/【查验】/【女巫】等标记，推进状态
  → table.emit(text) → session.append('assistant/message', …, {surfaceOp:'append'})
  → 立刻出现在用户对话框
```

## 6. 开发

```powershell
node test/dry-run.mjs          # 6/8/9/12 人各 5 局，纯逻辑自测（无需 DSH、不发 LLM 请求）
node test/dry-run.mjs 12 20    # 12 人标准局跑 20 局
.\sync.ps1                     # 把 lib/test/README 同步进 profile（源码改完必须同步才生效）
```

**更新流程（已实测）**

1. 改工作区里的源码。
2. `.\sync.ps1` 同步到 `<profile>\plugins\dsh-werewolf`。
3. 把 `cordis.patch.yml` 里该行 `name` 末尾的 `?v=N` 加一（`?v=3` → `?v=4`）。
4. 用插件管理器把 `include:werewolf` **停用再启用**（或保存 YAML 后等一次整体重载）。

为什么必须这么做（三条实测结论）：

1. **ESM 按 URL 缓存模块**：对同一个 URL 做停用/启用，拿到的仍是内存里的旧模块，
   改文件内容不会生效——必须改变 URL。
2. **只改 `name` 不会自动重挂载**：loader 按行 `id` 做差异，只认「新条目」。
   改完路径要配一次停用/启用。
3. **HMR 只管 profile 目录内的模块**（profile 之外的模块被判定为 external，永不热重载），
   所以源码放工作区没问题，但**必须同步一份进 profile**。

另外，`lib/*.js` 之间用的是**带版本查询的动态导入**：入口 URL 上的 `?v=N` 会透传给
`engine.js`/`prompts.js`/`rules.js`/`table.js`。否则只有入口换新、子模块仍命中旧缓存。
判断当前跑的是哪份代码：看系统提示词段尾部的构建标记（`lib/index.js` 里的 `BUILD`），
或调用 `werewolf_status` 看输出里的「插件构建」。

**踩过的坑**

- 可继续子智能体（`subagents.startContinuable`）空闲后会被管理器 dispose，
  `ctx.agents.get(childId)` 随即返回 `undefined`，第二轮 `sendMessage` 就失败
  （表现为「子智能体 … 未就绪」）。→ 改成一次性 `subagents.start()`，
  `run.result` 直接给出该轮发言，简单且稳定。玩家身份连续性由提示词承载
  （每轮都带上真实身份 + 私有信息 + 全部公开发言）。
- `toolFilter: { allow: [] }` 会把子智能体可见的工具清空（`restrict()` 的语义是
  allow-list），玩家因此**只会说话**，不会去翻文件、跑命令。
- Windows 上 ESM `import()` 不接受 `E:\...` 裸路径，必须写成 `file:///E:/...`。
- `session.append('assistant/message', …, {surfaceOp:'append'})` 是让文本**上屏**的关键；
  `surfaceOp` 对消息类事件是必填的。插件自己写 assistant 消息在**没有加载
  `dsh-session/invariant`** 的组合里是合法的（本机 desktop profile 未加载它）。

## 7. 已知限制与兼容性

- 人越多越慢：警长竞选 + 每轮发言都是一次子智能体运行。6 人局一局约 3~5 分钟，12 人局 10~20 分钟。
- 警长竞选默认 9 人及以上才开；6/8 人局可用 `sheriff: true` 强制开启（但小局上警意义不大）。
- 警徽流（预言家约定的警徽移交顺序）由玩家 AI 自行在发言里约定，引擎只负责「谁持有警徽」。
- 玩家 AI 的推理质量取决于所用模型；默认用 `reasoningEffort: low` 换速度。
- 发言是「一轮一个 AI」，不做跨轮长期记忆（由提示词里的完整公开发言补偿）。

**可移植性**

| 项目 | 情况 |
| --- | --- |
| 运行时依赖 | **零**（只用 `node:` 内置模块），不需要 `npm install` |
| 平台 | Windows / macOS / Linux 均可；差异只在安装：`tools/install.mjs` 跨平台，`sync.ps1` 仅 Windows |
| Node | `^22.19.0 || >=24.0.0`（与 DSH 要求一致） |
| DSH 版本 | 在 **0.2.0-rc.2** 上开发并实测。插件本体用的是稳定 API（`tools` / `systemPrompt` / `subagents` / `commands` / `agents`） |

**唯一的版本敏感点是「狼人杀模式」preset**：`tools/preset-werewolf.yml` 的插件列表是从
0.2.0-rc.2 的官方 `standard` preset 复制来的。DSH 大版本升级后若个别模块改名，
该模式会显示「加载失败」（**插件本体不受影响，照样能开一局**）。此时可以：

1. 从新版 DSH 的 `resources/app.asar` 中取出 `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`；
2. `node tools/build-preset.mjs <取出的 standard.patch.yml> tools/preset-werewolf.yml` 重新生成；
3. `node tools/install.mjs --preset`（先 `node tools/apply-preset.mjs --remove` 移除旧的）。

## 8. 贡献与发布

- 改动请先跑 `npm test`（等价于 `node test/dry-run.mjs`，含 Markdown 落盘校验），
  CI 会额外跑 12 人局 30 局压力回归。
- 改了 `lib/*.js` 记得按第 6 节的更新流程同步 + 重挂载，并把 `BUILD` 标记加一。
- 发布到 GitHub / npm 的完整清单与命令见 [PUBLISH.md](PUBLISH.md)。
- 版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 9. License

[MIT](LICENSE)

