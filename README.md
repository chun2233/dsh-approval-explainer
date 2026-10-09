# dsh-approval-explainer

**审批风险解读** — 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的审批弹窗，变成一个不懂英文也能看懂的对话框。

> **English summary.** A host-side plugin for DeepSeek Harness that makes tool-approval dialogs readable to non-technical, non-English-speaking users. Before the dialog reaches the browser it rewrites the reason into Simplified Chinese: what the AI is about to do, where it will do it, and the consequences of allowing versus denying. A built-in rule table answers instantly and offline; an optional model call adds one extra sentence under a hard 1500 ms cap, so the dialog is never slowed down. The English original is always kept verbatim. It never answers an approval — it only changes what the user reads.

> [!WARNING]
> **状态：v0.2.0，尚未经过实机验证。**
>
> 本插件的代码**从未被执行过**。函数、正则、文案与排版是逐条人工推演的，`test/selftest.mjs` 的断言也从未跑通——编写它的环境没有可用的 shell。
>
> 可能存在的具体故障：导入期报错会让插件装载失败、弹窗保持原样（不会更糟，但功能不生效）；运行期异常被顶层 try/catch 兜住并记日志，审批**不会**被阻断；规则可能误判或漏判，「在哪里」可能抽错对象。
>
> **在你亲自跑通 `node test/selftest.mjs` 并触发一次真实审批之前，请不要依赖它做安全判断。** 发现问题请提 issue 并附上自检输出。

Agent 请求审批时，弹窗里通常只有一句英文，比如：

```
escalate sandbox to danger-full-access: the build needs to write outside the project
```

装上本插件后，同一处会变成：

```
**【这条审批是什么意思】危险 · 权限升级**

**AI 将**　把操作权限从"仅限当前工作区"提到"可访问整台电脑"。
**在哪里**　整台电脑（工作区之外）

**同意**　这次操作不再受工作区限制，可读写任意文件、执行任意程序。
**拒绝**　权限不变，操作要么在工作区内完成，要么直接失败。这是最安全的默认值。

【英文原文】
escalate sandbox to danger-full-access: the build needs to write outside the project
```

**英文原文永远逐字保留。** 让人同意自己看不懂的东西是安全缺陷，不是功能——中文解读是**附加**的，从不替换原文。

## 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [配置](#配置)
- [验证](#验证)
- [它是怎么做到的](#它是怎么做到的)
- [风险等级与规则](#风险等级与规则)
- [「在哪里」这一行是怎么来的](#在哪里这一行是怎么来的)
- [与其他插件的关系](#与其他插件的关系)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [许可](#许可)

## 它做什么

| | |
|---|---|
| **风险等级** | 六级：危险 / 高 / 中 / 低 / 只读 / 无法判断，风险词直接在首行标题里 |
| **AI 将** | 一句话说明 AI 具体要做什么，取自命中的规则 |
| **在哪里** | 从 reason 文本抽出被操作的对象（路径、URL 域名、容器名、PID、`origin/main`）；抽不到就给范围短语或「范围不明」，**绝不编造路径** |
| **同意 vs 拒绝** | 分别列出两种选择的后果，这是小白最需要、也最难自己推断的部分 |
| **一行一件事** | 每条信息独立成段，段与段之间空一行，不会看串 |
| **秒出结果** | 本地正则表判定，不联网、不调用模型 |
| **可选模型补充** | 开启后额外补一句大白话，**1500ms 硬上限**，超时或失败静默回退 |
| **原文保留** | 英文原句逐字附在末尾，命令本身不翻译 |

## 安装

插件**零运行时依赖**，只有几个文件，不需要构建。

### 方式一：手工挂载

1. 把整个 `dsh-approval-explainer` 目录放进 profile 的 `plugins/` 下：

   ```
   ~/.dsh/profiles/<profile>/plugins/dsh-approval-explainer/
   ```

    `<profile>` 按你的客户端取 `desktop`（桌面客户端 / EAC）或 `web`（命令行网页版）。

2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-approval-explainer
         name: './plugins/dsh-approval-explainer/lib/index.js'
         config:
           enabled: true
           displayMode: auto
           modelLayer: true
           modelTimeoutMs: 1500
   ```

   `name` 是相对于该 patch 文件本身的路径。

3. desktop profile 的 `patchReload` 是 `live`，保存后热加载；`web` profile 需要重启 DSH。

### 方式二：`dsh plugin add`

```sh
npx -y @deepseek-ai/dsh plugin --profile desktop add "<本目录绝对路径>"
```

这种方式按 `package.json` 里的 `dsh.bundle.patch` 处理，patch 条目的 `name` 用裸包名 `dsh-approval-explainer`。

### 安装后自检

```sh
cd ~/.dsh/profiles/<profile>
node plugins/dsh-approval-explainer/test/verify-install.mjs
```

检查入口能否导入、导出是否符合 loader 约定、规则兜底是否成立、`@deepseek-ai/dsh-llm` 是否可达、patch 条目是否存在。

## 配置

全部可选，代码里每一项都有兜底默认值。写在 patch 条目的 `config:` 下。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时插件完全不改动任何文本。 |
| `displayMode` | `'auto'` | `'auto'`：只写 `displayReason.zh`，**英文 `reason` 一个字节都不动**。<br>`'wrap'`：把解读写进 `reason`（弹窗必定渲染），英文原文仍附在末尾。<br>`'both'`：两者都写。 |
| `modelLayer` | `true` | 是否额外让模型补一句通俗解释。 |
| `modelTimeoutMs` | `1500` | 模型调用的硬上限。审批是阻塞交互，用户正盯着弹窗，所以这个值刻意远低于辅助调用常见的 120s。`0` 表示完全关闭模型层。 |
| `provider` / `model` | `''` | 留空时自动沿用你当前的默认模型（`ctx.agentDefaultModel.currentSelection()`）。 |
| `maxReasonChars` | `800` | 英文原文的截断上限，防止弹窗被超长文本撑爆。 |
| `cacheSize` | `200` | 缓存多少条已生成的解读，重复措辞不再重复请求模型。 |

**先用默认的 `displayMode: auto`。** 如果弹窗没有变化，说明该 GUI 构建没有渲染 `displayReason`，改成 `'wrap'` 即可——见下面的 A/B 验证。

## 验证

### 1. 本地规则自检（离线、不联网、不调模型）

```sh
node test/selftest.mjs
node test/selftest.mjs --print   # 顺便把渲染出的中文打出来看
```

自检直接跑**发布出去的那几个模块**（`lib/rules.mjs`、`lib/targets.mjs`、`lib/compose.mjs`），不是副本。断言里包含这几条硬约束：

- 英文原文必须逐字出现在输出里；
- 风险等级必须在首行标题里；
- 必须有 `AI 将` 与 `在哪里` 两行，且 `同意` / `拒绝` 各占一行；
- **每两行之间必须隔一个空行**（一行一件事）；
- reason 里写明的路径必须出现在「在哪里」行；没写路径时**不得**出现任何像路径的东西；
- 已删除的旧段（`风险等级`、`这一级意味着`）不得回来；
- 整段解读不超过 12 行。

### 2. A/B 验证 `displayReason` 是否被渲染

这是唯一一处依赖 GUI 构建行为的假设，所以给出明确的验证步骤：

1. 保持 `displayMode: auto`，把 `modelLayer` 设为 `false`（排除模型干扰）。
2. 触发一次审批，看弹窗是否出现中文。
3. **出现了** → 保持 `auto`。英文 `reason` 全程未被修改，这是最干净的状态。
4. **没出现** → 把 `displayMode` 改成 `'wrap'`，再触发一次。

### 3. 真实审批冒烟测试

用一条你确定安全的命令触发审批即可（例如让它读一个工作区外的只读文件）。确认三件事：中文解读出现、英文原文仍在、同意/拒绝的行为与插件无关。

## 它是怎么做到的

- Node 半边以 `ctx.on('approval/request', ..., true)`（prepend）挂在审批瀑布上，**抢在官方答案器之前**改写文本，所以弹窗原生渲染中文，React 重渲染也还原不了。
- 改的是**展示用**文本：默认路径只写 `displayReason.zh`，英文 `reason` 保持字节级不变；审批审计事件在瀑布之前就已落盘，会话日志里保留的始终是原始英文。
- 浏览器半边**没有代码**。早先同类实现试过 DOM 改写，被 React 重渲染打败后废弃；本项目从一开始就不走那条路，因此不需要打包任何前端产物。

## 风险等级与规则

规则表在 [`lib/rules.mjs`](lib/rules.mjs)。等级取所有命中项中**最严重**的一项。

| 等级 | 命中内容（部分） |
|---|---|
| **危险** | `rm -rf` / `rm -fr`、`Remove-Item -Recurse -Force`、`del /f /s /q`、`format` / `mkfs` / `diskpart` / `dd of=/dev/…`、`git push --force`、`git reset --hard`、提权到 `danger-full-access`、写 `C:\Windows` 或 `/etc/passwd` 或注册表 |
| **高** | 读 `.env` / `.ssh/` / `id_rsa` / `.aws/credentials`、`git clean -fdx`、`chmod -R`、`npm publish`、`npm i -g`、写入工作区之外 |
| **中** | `npm/pnpm install`、`curl … \| bash`、`curl` / `gh` / `git clone` / `ssh`、`kill` / `taskkill`、`git commit/add/push`、`docker rm` |
| **低** | 在工作区内改文件、被权限规则挡住的尝试（`access denied`、`denied under … mode`、`EPERM`） |
| **只读** | `read` / `glob` / `grep` / `lsp` 等只读工具，且没有命中任何写入类规则 |
| **无法判断** | 什么都没命中。**这是刻意设计的兜底** |

### 两条刻意的设计选择

**1. 兜底是「无法判断」，不是「安全」。** 把危险命令标成安全是这插件唯一能真正伤害用户的失败方式。所以没识别出来时，它明说无法判断，让用户自己看英文原句，而不是给一个虚假的安心。

**2. `--force-with-lease` 不算危险。** 它会在远程被改动时拒绝覆盖，是强制推送的**安全**做法。把它标红会训练用户忽略红色标签。它仍会被报告为"写入 Git 仓库"（中），不会被藏起来。

## 「在哪里」这一行是怎么来的

这是本插件最容易被误解的一行，所以把边界说清楚。

### 可用的输入只有 reason 文本

`ApprovalRequestEvent` 只携带 `agent / toolName / callId / reason / displayReason / signal` —— **没有工具参数**，DSH 也没有公开的会话读取服务可以按 `callId` 回查。所以「在哪里」只能从 reason 文本里正则抽取（这也正是 DSH 会把命令行写进 reason 的原因）。抽取逻辑在 [`lib/targets.mjs`](lib/targets.mjs)。

### 能被抽出来的

| 形态 | 例 |
|---|---|
| 绝对路径 | `/tmp/build`、`C:\Users\me\a.txt`、`$HOME/app` |
| 相对文件引用 | `.env`、`lib/index.js` |
| URL | `https://example.com`（**只保留域名**） |
| Git 远端 | `origin/main` |
| 容器 | `docker rm api` → `api` |
| 进程 | `taskkill /PID 1234` → `PID 1234` |

### 三条刻意的取舍

**1. 抽不到就给范围，不猜。** 例如权限升级会显示 `整台电脑（工作区之外）`，什么规则都没命中时显示 `范围不明，详见下方英文原句`。**编造一个像模像样的路径比留空更危险** —— 用户会对着错误的对象做决定，而且还很有信心。

**2. URL 的参数被丢掉。** 安装类命令的 URL 经常带 token，把完整链接打到弹窗上等于把密钥摊在屏幕上。只显示域名，因为域名才是用户真正被要求信任的东西。

**3. 只从命中规则的内容里抽。** 只读工具和未识别的操作不会抽路径——那两种情况下我们对目标一无所知，宁可说不知道。

## 与其他插件的关系

列表里已有 [`xiyuepcl/dsh-approval-translator`](https://github.com/xiyuepcl/dsh-approval-translator)，它把审批说明**翻译**成中文。本插件回答的是另一个问题：

| | dsh-approval-translator | 本插件 |
|---|---|---|
| 解决的问题 | 「这句英文什么意思」 | 「这条操作有多大风险、我该不该同意」 |
| 风险等级 | ✗ | ✓ 六级 |
| 同意 vs 拒绝的后果 | ✗ | ✓ 分别说明 |
| 是否需要模型 | 必须（每条约 1 秒 + token） | 不必须：本地规则秒出，模型只补充一句话 |
| 离线可用 | ✗ | ✓ |
| 决策速度 | 等模型返回 | 立即（模型层 1500ms 硬上限） |

两者可以同时安装，互不冲突。

## 常见问题

**弹窗没变化？**
改 `displayMode: 'wrap'`。默认的 `auto` 依赖 GUI 渲染 `displayReason` 字段，部分构建可能不渲染。

**「在哪里」为什么写的是「范围不明」？**
因为那条 reason 里确实没有写位置，而插件宁可说不知道也不猜。见[上一节](#在哪里这一行是怎么来的)。

**会不会拖慢审批？**
不会。本地规则是同步的；模型层有 1500ms 硬上限，超时或失败一律静默回退到本地结果，并记一条日志。`modelTimeoutMs: 0` 可以彻底关掉模型层。

**会不会替我点「同意」？**
不会。监听器永远 `return next()`，从不返回 `ApprovalOutcome`，因此不可能允许、拒绝或代答任何审批。它只改用户读到的文字。

**能不能只翻译、不要风险解读？**
不能，本插件的重点就是风险解读。纯翻译请用 [`dsh-approval-translator`](https://github.com/xiyuepcl/dsh-approval-translator)。

**只看得懂英文，能关掉吗？**
`enabled: false` 即完全停用。

**怎么彻底卸载？**
删掉 patch 里那一整个 `- insert:` 块即可。`displayMode: auto` 下英文 `reason` 从未被修改，卸载后弹窗立即恢复原始英文，无需清理任何残留。

## 已知限制

- **这是模式匹配，不是安全审查。** 它会漏报。这正是兜底等级为「无法判断」而非「安全」的原因。
- **不渲染 `displayReason` 的 GUI 构建需要 `displayMode: 'wrap'`。** 见上面 A/B 验证。
- **「在哪里」只能从 reason 文本抽。** 审批事件不携带工具参数，抽不到时只能给范围短语或「范围不明」。
- **没有客户端半边。** 插件只改文本，不添加折叠面板等富 UI。
- **模型层依赖 `@deepseek-ai/dsh-llm` 的私有导出**（`BlockAssembler` / `createUserMessage` / `deepFreeze`）。它是随 harness 走的内部接口，版本升级可能失效——因此该层整体可选，任何失败都静默回退到本地规则，绝不影响审批。
- **弹窗文案目前只有简体中文。** 目标语言写死在代码里；要支持其他语言需要改 `lib/compose.mjs` 与 `lib/rules.mjs`。
- **不做自动审批。** 维护时请保持这一点。

## 许可

[MIT](LICENSE)

---

本插件不构成安全审查，也不对审批决策负责——它只负责把英文讲成人话。批准或拒绝之前，请仍然以弹窗里的英文原文为准。
