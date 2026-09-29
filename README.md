---
doc: usage-declaration
plugin: "@local/dsh-local-ollama-models"
version: 1.6.0
audience: AI agent（人类也可直接阅读）
purpose: 让任何一台刚装上本插件的机器上的 AI，无需历史对话即可正确启用、使用并验收本插件
host-tools: [ollama_local_models, subagent_local]
settings-section: 设置 → 本地模型
config-namespace: local-ollama-models
hard-requirements:
  - 本机 Ollama 可访问（默认 http://127.0.0.1:11434）
  - llm-pi-ai 中存在一条 provider 路由（默认名 ollama-local）—— 见 §2.2
  - 要委派的模型 id 必须写在该路由的 models: 列表里 —— 见 §2.3
integrity: 本文件与 package.json 的 version 应当一致；不一致说明插件被改过，优先信任代码
---

# 本地模型子代理 · 使用声明

> **DSH (DeepSeek Harness) plugin** — delegate *read-only collection tasks* (scan logs, extract fields,
> count, dedupe, read a large file and return only the conclusion) to a **local Ollama model**:
> zero cloud token cost, zero API keys. Ships a Settings panel, a model-selection ruler (`bench.mjs`),
> and this AI-readable usage declaration. Requires DSH + Ollama ≥ 0.3 + one declared `llm-pi-ai` provider route.
> Full details below (Chinese; the plugin's UI text is Chinese as well).

> 这份文件是插件的**自带说明书**。它假设读者（AI 或人）此前对这台机器、这个插件一无所知，
> 因此把"怎么开、怎么用、怎么验收、怎么排错"全部写死在这里，不依赖任何历史对话。

## 装它（第一次来的人看这里）

这是一个 **DSH profile bundle**（不是独立程序）。两种装法，任选其一：

**A. 从 GitHub 直接装**（推荐，跟着仓库更新）

在 DSH 里让 AI 执行：`plugin_manager` → `action: install_bundle` → `target: "github:Movingelated/dsh-local-ollama-models"`。

**B. 克隆后按路径装**

```bash
git clone https://github.com/Movingelated/dsh-local-ollama-models.git
```

然后 `install_bundle` 的 `target` 填**克隆到的绝对路径**。

装完**重启 DSH** —— 宿主插件是模块代码，DSH 不做热替换（这条是实测结论）。重启后打开「设置 → 本地模型」。

> ⚠ **光装插件不够**：委派还需要一条 provider 路由。**没有 §2.2 那条路由，任何委派都会失败。**
> 建议顺序：装插件 → 重启 → 按 §2.1 量本机模型 → 按 §2.2 声明路由与凭据占位 → 再重启 → 用面板开关。

## 0. 给 AI 的 60 秒速览

- **我拿到什么**：两个工具 —— `ollama_local_models`（只读查状态）、`subagent_local`（把只读采集任务派给本机 Ollama 模型，零云端 token）。
- **第一步永远先调** `ollama_local_models`：它同时告诉你 Ollama 是否活着、有哪些模型可用、以及本 README 的绝对路径。
- **模型名与参数一律以本机实测为准**：本文档里出现的任何模型名、吞吐、上下文、显存数字都只是**样本**，不是推荐值。
  换一台机器，就照 §2.1 用 `bench.mjs` 重新量一遍，再决定往路由里写什么。
- **派活公式**：`subagent_local({ prompt })`，prompt 必须**自包含**（绝对路径 + 要提取什么 + 输出格式），因为子代理看不到对话。
- **三条铁律**：
  1. **只派读多写少的活**（采日志、计数去重、字段抽取、模式匹配、图转文）；代码、架构、措辞交付别派。
  2. **它的数字不可信**：分类与定位基本可信，**计数必须自己机械复核**（一条 grep 的事）。
  3. **大语料先切块**：路由上下文默认 32K token，超了直接报错。
- **省钱的原理**：不是本地模型算得快，而是**主上下文不必吞下原文**。原文只进本地，回来的是结论。
- **改配置不用重启**：`enabled` / `model` / `baseURL` 是 volatile 字段，在「设置 → 本地模型」点一下即生效。
- **改代码要重启**：宿主插件是 ESM 模块，DSH 不会热替换模块代码。

## 1. 它是什么，不是什么

**是**：一台"零成本的只读采集工人"。它把一段自包含的采集任务交给本机 Ollama 模型，在**独立上下文**里执行，
只把结论拿回主对话。子代理自己会调 `read` / `grep` 等只读工具去读文件、翻日志。

**不是**：
- 不是省钱魔法 —— 本地模型烧的 token **比云端更多**（Ollama 没有提示缓存），它省的是**主上下文**，也就是钱。
- 不是万能工人 —— 它判断力弱：**归类可以，计数不准**，架构与质量类结论不可用。
- 不是写手 —— 不要让它产出最终交付文本或改代码。

## 2. 前置条件（换新机器只需照做这四步）

### 2.1 Ollama、模型与选型（**本文件不指定推荐模型**）

```bash
ollama --version                      # 需要 0.3 以上（/v1 兼容层 + tools 能力）
curl -s http://127.0.0.1:11434/api/version
ollama pull <模型>                    # 装哪个由下面的判据决定，别照抄本文档
```

本机一个模型都没有时，先随便拉一个**支持工具调用**的当起点（例如 `qwen3:30b-a3b`，约 17 GB），
再用下面的尺子实测决定要不要换 —— 起点不等于推荐。

**选型判据（六条，逐条量，别抄参数）**

| # | 判据 | 怎么得到 |
|---|---|---|
| 1 | 必须支持工具调用（`tools`） | `node bench.mjs` 直接把不支持的排除掉 |
| 2 | 别挑带内置人设的 | 同上，输出里带 ⚠ 的排除（人设会污染任务） |
| 3 | 装得进显存（要 100% GPU） | `node bench.mjs <id>` 的「显存驻留」；不是 100% 就换更小或更低量化 |
| 4 | 吞吐够用 | 同上「吞吐tok/s」；长任务低于 ~50 会很难受 |
| 5 | 上下文 ≥ 你要喂的素材 | 同上「原生上下文」；路由里的 `contextWindow` 填 `min(原生, 所需)`，保守可先填 32768 |
| 6 | 实测**真的会**调工具 | 同上「实测会调用工具」必须是 `true`（有的模型声明支持却调不出来） |

```bash
node bench.mjs                   # 第一步：列出本机可用模型 + 各自的事实（秒回，不测速）
node bench.mjs <模型id>           # 第二步：实测它（工具调用/吞吐/显存），并打印可直接粘贴的路由 YAML
node bench.mjs <模型id> --json    # 给程序或 AI 解析用
```

> 三条命令**只读**：只调 Ollama 的 `/api/*`，不拉取、不删除、不改配置。
> 它输出的 YAML **已经把本机实测值填好了** —— 抄它，别抄本文档。

### 2.2 在 profile 里声明 provider 路由

本插件不自带路由：它委派时必须有一个已注册的 provider 路由。**没有这一步，任何委派都会失败。**
把下面这段加到 profile 的 `cordis.patch.yml`（顶层数组里），路由名保持 `ollama-local`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ollama-local:
        displayName: Ollama 本地（文字）
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        apiKeyEnv: OLLAMA_API_KEY
        reasoning: off              # 开思考会吃光 token 预算且 content 恒空
        timeoutMs: 300000
        defaultContextWindow: 32768
        defaultMaxTokens: 8192
        defaultInput: [text]        # 显式声明，防止把图片误发给纯文本模型
        models:
          - id: "<本机实测选定的模型 id>"      # ← 用 bench.mjs 生成这一段，别照抄本文档
            name: <显示名，随便取>
            contextWindow: 32768               # 建议值；bench.mjs 会按该模型的原生上下文给出
            maxTokens: 4096
            input: [text]
```

**凭据占位符**：Ollama 的 `/v1` 不校验 key，但 pi-ai 必须有非空凭据。在 `<DSH_HOME>/.credentials.yaml`
的 refs 下加一条占位值即可（按请求解析，免重启）：

```yaml
OLLAMA_API_KEY: ollama-local-no-key-required
```

### 2.3 模型必须写进路由（最容易踩的坑）

- 设置面板列出的是 **Ollama 里的全部模型**；能被委派的只有**路由 `models:` 列表里声明过的那些**。
- 选到未声明的模型 → 调用以 `UNKNOWN_MODEL` 失败（`pi-ai provider "X" has no configured model "Y"`）。
- 本插件会在委派前自查并给出可执行的报错（列出该路由已声明的模型 id），但**补声明要人工做**：
  在 §2.2 的 `models:` 下加一条，然后重启 DSH。

### 2.4 自检清单

```bash
ollama ps                                   # 看模型是否 100% GPU 驻留
```
```
cordis_inspect_query host / Config / listConfigs  {name: "@local/dsh-local-ollama-models"}
  → status 应为 "schema"（为 "absent" 说明 Config 没加载，设置页将不可写）
cordis_inspect_query host / Tool / listTools
  → 应能看到 ollama_local_models 与 subagent_local
cordis_inspect_query client / Slots / listSubTree {root: "settings.section"}
  → occupants 里应有 id "local-ollama"
```

## 3. 开启与配置

**方式一（推荐，人人可用）**：设置 → **本地模型** →
- 「启用本地模型子代理」按钮：开 / 关
- 模型列表：点任意条目切换默认模型
- 端点框：改完失焦即保存（留空 = 先读 `OLLAMA_HOST`，再退回 `127.0.0.1:11434`）

**方式二（无界面时）**：直接改 profile 的 `cordis.patch.yml`：

```yaml
- id: local-ollama-models
  config:
    enabled: true            # 开关
    model: <本机实测选定的模型 id>   # 默认模型（必须已写进路由 models:，见 §2.3）
    baseURL: ""              # 端点覆盖
    toolName: subagent_local # 工具名（非 volatile，界面改不到）
    provider: ollama-local   # 路由名（非 volatile，需与 §2.2 一致）
  disabled: false
```

**生效语义**：`enabled` / `model` / `baseURL` 是 **volatile** 字段 —— 写进 profile patch，
**即时生效、无需重启、不重挂插件**。其余字段改了要重启。

**关闭**：把开关关掉，或在「插件」页停用本 bundle（停用会让两个工具一起从工具表消失）。

**历史包袱**：1.2.0 之前用过 `<DSH_HOME>/local-ollama-models.json` 存状态，现已废弃、不再读取，可以删。

## 4. 工具契约

### `ollama_local_models()`
- 入参：无。只读，无副作用，不启动也不下载任何模型。
- 返回：端点 / 连通性 / 版本 / 模型总数 / 可作子代理数 / 可用模型清单（带体积、量化、上下文、人设警告）+ 本 README 路径。
- 用于：委派前的环境确认；以及"这台机器上到底有什么模型"。

### `subagent_local({ prompt, model?, label?, collect? })`
- `prompt`（必填）：自包含任务描述。**必须**含要提取什么、期望输出格式。
- `model`（可选）：覆盖默认模型，须在 §2.3 的已声明列表内。
- `label`（可选）：会话里显示的短标签。
- **`collect`（可选，v1.5.0 起强烈建议；v1.6.0 起支持自动分批）**：让**宿主侧**代取素材，直接把命中行拼进子代理的 prompt。
  `{ path, include?, pattern?, maxChars?, chunkLines? }` —— `path` 是文件或目录，`include` 是目录下的文件名 glob（如 `launcher*.log`），
  `pattern` 是 JS 正则会只保留匹配行（建议最简形式 `WARN|ERROR`），`maxChars` 默认 60000 超则截断，
  `chunkLines`（默认 0 = 不分批）超过该行数就**自动切片 → 逐片归类 → 合并**（每片 ≤N 行且 ≤8000 字符，最多 8 片）。
  用了它：**素材 100% 正确、不占主上下文、子代理的 `grep`/`glob` 会被自动禁用**（它就是靠这两个工具静默改坏过素材）。
  结果末尾会回 `[宿主预取素材] N 个文件 / M 行 / K 字符` 与 `[分批委派] X 片 × ≤N 行 → … 共 T 秒`，供调用方核对。
  ⚠ 为什么值得分批：实测同一模型 **33 行 → 100% 覆盖，115 行 → 59%**（详见 §9.1）。
- 返回：本地模型产出的**文本结论**（不是原始文件内容）。
- 错误语义（都会抛错，不会静默失败）：
  | 报错关键字 | 含义 | 处置 |
  |---|---|---|
  | `关闭状态` | 开关是关的 | 打开「设置 → 本地模型」的开关 |
  | `尚未指定本地模型` | 没配 model | 面板选一个，或传 `model` |
  | `provider 路由 ... 未注册` | 缺 §2.2 的路由 | 补路由后重启 |
  | `没有写进 provider ... 的 models 列表` | 缺 §2.3 的声明 | 补声明后重启 |
  | `subagents 服务不可用` | 宿主组合异常 | 检查 dsh-base 是否完整 |
- 子代理视角：**看不到本对话**，独立上下文，跑在配置的 provider 路由上，**零云端 token**。
- **只读是机制保证的**：委派时用 `toolFilter.deny` 摘掉 `write` / `edit` / `pwsh` / `job_kill` / `plugin_manager`
  以及再派活类（`subagent` / `subagent_fork` / `subagent_local` / `workflow`）。
  ⚠ 但 `tools.restrict()` 只认"继承来的**可 restrict** 全局工具名"（`dsh-tools`: `view(scope).restrictableNames`），
  名单里只要有一个不在该集合里，**整条调用就抛错**。所以插件是"尽力而为"：把报错点名的名字逐个剔除后重试，
  保住其余防护；整份名单都被拒时才退化为不过滤。
  **并且它一定会告诉你结果** —— 过滤没能完全生效时，委派结果末尾会附一句
  `⚠ 只读过滤未完全生效：<被剔除的名字>` 或 `⚠ 只读过滤未生效：…`。
  想自行核对权威证据：跑一次委派，再看那个子代理会话的 `request/header.tools` 里有没有 `write`。
- **本机实测（一次真实委派，权威证据取自子代理会话的 `request/header.tools`）**：
  工具数 **32 → 24**；被摘掉的是 `write` / `edit` / `pwsh` / `job_kill` / `plugin_manager` /
  `subagent_fork` / `subagent_local` / `workflow`；**唯一摘不掉的是 `subagent`** —— 它落在子代理 scope
  自己的那一层，而 `view()` 里"自己层"的工具只算 known、不算 restrictable，属于 `tools.restrict()` 的固有限制。
  想彻底封死"子代理再派活"，可考虑给 `agentOptions` 配 `maxDepth`（本插件**未启用**，未验证；注意 `maxDepth: 0`
  会让子代理卡在启动前）。在这一天到来之前，这句 `⚠` 就是它诚实的自我声明。

## 5. 最优使用法

### 5.1 该派 / 不该派

| ✅ 适合 | ❌ 不适合 |
|---|---|
| 大日志/大源码的定向信息采集（只回"带行号的关键点"） | 最终代码、架构判断 |
| 计数、去重、字段抽取、格式转换 | 中文措辞与质量类交付 |
| "哪些文件里出现了 X" 的大范围模式匹配 | 安全、权限、删除类操作 |
| 图片/截图转文字 | 任何需要它回头重读原文才能验收的任务 |

判据一句话：**输出能被机械验收（grep / 数字 / schema）→ 派；需要"信它的判断"→ 别派。**

### 5.2 prompt 模板（v1.5.0 起：**素材交给宿主取**）

**首选做法：用 `collect` 参数，不要让本地模型自己去 grep。**

```jsonc
// subagent_local({ prompt, collect })
{
  "prompt": "把素材里的「告警与报错」按根本原因归类去重。\n输出格式：分类 | 次数 | 代表原文(≤80字) | 出处\n最后单独一行输出 TOTAL=<覆盖条数>。不要开场白、解释、建议。",
  "collect": { "path": "D:\\logs", "include": "app*.log", "pattern": "WARN|ERROR", "maxChars": 60000 }
}
```

prompt 里**不用再写路径**（素材已附在 prompt 末尾），只写"要什么 / 怎么归类 / 输出格式"。

**万不得已要它自己取素材时，两条死规矩**：

1. **检索式必须是最简形式**（如 `WARN|ERROR`）——给它带括号或转义的正则，它一定会"优化"它。
2. **强制自报口径**：要求它先输出 `HITS=<工具返回的条数>`，最后输出 `TOTAL=<覆盖条数>`，两个数必须相等。
3. **一口别超过约 40 行**：同一批素材行数越多，它越容易只抓大类别、丢掉只有 1~3 条的小类别。
   实测同一模型同一任务：**33 行 → 100% 覆盖**（6/6 根因）；**115 行 → 59%**（4/6 根因，丢的全是 ≤3 条的小类）。
   对策（v1.6.0 起**首选自动**）：给 `collect` 加 `chunkLines: 40` —— 宿主自动切片、逐片归类、再合并，
   每一口都是"小而完整"的料；**先去重再喂**同样有效（本例 6 份日志是同一份的累积快照，只取最新那份即从 115 行降到 33 行）。
   对照数据见 §9.1。

经验：
- **一次只派一个任务**；任务边界越窄，本地模型越不容易跑偏。
- 让它**只输出表格/清单**，别要散文 —— 散文既贵又难验收。

### 5.3 模型常驻

切换模型要重新加载（5～30 秒，显存大的要更久）。**锁定一个主力模型长期用**，别一次任务换一个。
`ollama ps` 可以看到驻留情况（默认闲置 5 分钟后卸载）。

### 5.4 让它"在该用的时候被用上"（主动性机制）

**问题**：工具描述只会说"我能做什么"，不会在具体情境里主动冒出来。上线首日实测：某会话 250 次工具调用中，
本插件仅 6 次，**全部是用户点名要求演示的，自发调用 0 次**。工具没问题 —— 是**触发条件没写进模型看得见的地方**。

**两个机制（v1.4.0 起）**：

| 机制 | 位置 | 作用 |
|---|---|---|
| 系统提示词段落 `local-ollama-delegation`（order 2850，紧跟 TOOL_SUBAGENT） | 每一次请求的系统提示词 | 写死"命中任一条件就优先委派"：① 单文件 > 30 KB；② 要扫 ≥3 个文件/日志；③ 计数/去重/字段抽取/找关键行/图转文字 |
| 大文件当场提示（`tools/post-execute`） | 读进主上下文的 `read` 结果末尾 | 在**花掉钱的那一刻**提醒："这份内容 ≈N k token 已进主上下文，下次这类活可交给 subagent_local"。每个会话只提醒一次 |

**怎么验证生效**：重启 DSH 后给一个"读大文件 / 扫一批日志"的任务，看是否先调 `subagent_local`；
或让它读一份 > 30 KB 的文件，结果末尾应出现 `⚠ 采集提示`。

**怎么调**：阈值与文案都在 `index.js` —— `BIG_READ_CHARS`（默认 30000 字符）、`DELEGATION_POLICY`。
⚠ 政策文本**必须保持静态**（见 §10 第 7 条）。

## 6. 验收纪律（本节最重要）

**本地模型的"分类"和"定位"基本可信，"计数"和"统计值"不可信。** 样本数据（某 30B 级模型的一次真实委派；换模型后偏差幅度会变，但"数字必须复核"这条纪律不变）：

| 维度 | 结果 |
|---|---|
| 分类是否真实存在 | 7/7 命中 ✅ |
| 行号是否指向真实内容 | 7/7 命中 ✅ |
| 文件名 | 5/7 正确，2 条张冠李戴（行号却对）⚠ |
| 计数 | 4/7 偏差 2～3 倍（报"34 次"实际 17 次；报"6 次"实际 18 次）⚠⚠ |

因此验收动作固定为三条：
1. **先对账再信数**：让它回报 `HITS`（取到多少行）/ `TOTAL`（覆盖多少行），两者不等就有缺口；
   再用你自己的 grep 核一遍总量。
2. **数字自己数一遍**：`Select-String -Path <files> -Pattern <关键词> | Measure-Object`（或 grep -c）。成本几秒。
3. **抽查 2～3 条引用**：打开它给的行号，确认内容对得上；行号对不上就整份打回。

⚠ **口径也要对齐**：大小写、编码、是否把续行算作命中，都会改变计数。实测我自己的 PowerShell 计数
（`Select-String` 默认大小写不敏感）把一条 JSON 续行 `[Error: ...` 也算成命中，比真实标记多 1 条 ——
差点把一次"33/33 全召回"判成 97%。**数错的不只是本地模型，验收工具链也会。**

## 7. 已知限制

| # | 限制 | 说明与对策 |
|---|---|---|
| 1 | **上下文 32K** | 路由声明 32768，超了直接报错。大文件必须分块/先 grep 收敛 |
| 2 | **Ollama 无提示缓存** | 本地 token 只会更多不会更少；省钱来自零边际成本 |
| 3 | **模型 id 必须已声明** | 见 §2.3，`UNKNOWN_MODEL` |
| 4 | **凭据不能省** | 见 §2.2，删了会报 `No API key for provider` |
| 5 | **思考模式默认关** | 路由里 `reasoning: off`；开了会吃光预算且 content 恒空 |
| 6 | **去审查底模** | 名字带 `heretic` 的模型是被去审查版本。缓解：只给只读工具、任务本身无争议、输出过 schema 校验 |
| 7 | **写权限靠 deny 名单** | 默认 deny 掉写/执行/再派活类工具；不可 restrict 的名字会被逐个剔除、并在结果里如实告知（见 §4），全部被拒时只读只靠任务约束 |
| 8 | **改宿主代码要重启** | 模块代码不热替换（loader 不做 import 缓存击穿） |
| 9 | **弱模型会篡改工具参数** | 实测：给它 `\[(WARN\|ERROR)`，它自作主张补成 `\[(WARN\|ERROR)\]`，**22/34 行被静默滤掉**，而输出行号真、原文真、格式规整，唯一破绽是最大的一整类凭空消失。对策：用 `collect` 让宿主取素材（§5.2），或给最简正则 + 强制自报 HITS/TOTAL |

## 8. 故障排查

| 症状 | 根因 | 处置 |
|---|---|---|
| 设置页开关点不动 / 红框说"写不了配置" | 宿主行没有 Config schema，或命名空间没暴露 | 确认 §2.4 里 status 为 `schema`；仍不行则重启 DSH |
| 面板说"当前 settings 暴露的命名空间：（无）" | 客户端误读 `remote.settings` 的返回信封（应为 `res.ok ? res.value : res.error`） | 属插件 bug，按此修 client.js |
| 面板"无法连接 / 0 个模型" | Ollama 没起、端口不对、或浏览器跨域 | 起 Ollama；改端点；确认 `OLLAMA_ORIGINS` 允许页面来源 |
| 委派报 `UNKNOWN_MODEL` | 模型没写进路由 | 见 §2.3 |
| 委派报 `No API key` | 缺凭据占位符 | 见 §2.2 |
| 委派很慢（>30s） | 模型冷加载 / 语料太大 | 预热一次；切块；锁定常驻模型 |
| 会话"卡死"几分钟 | 工具表变化导致 prompt 前缀缓存失效，几十万 token 重新 prefill | 别急着按停止（provider 默认 5 分钟空闲超时会自动重试）；长期对策：别在会话中途增删工具 |

## 9. 实测样本（**一台具体机器**的数字，只示范方法，切勿照抄）

> 下表来自一台 24 GB 显存的机器，**不是推荐清单**。换机器后"装不装得下、快不快"都会变。
> 量你自己的：`node bench.mjs`（清单）→ `node bench.mjs <id>`（实测 + 打印路由 YAML）。判据见 §2.1。

### 9.1 对照实验：素材"怎么喂"决定召回率（同一模型、同一任务）

任务：把 6 份启动器日志里的告警按根因归类。裁判：宿主侧机械分组（大小写敏感、按消息去重，见 §6 口径提醒）。

| 组 | 素材 | 取材方式 | 子代理工具调用 | 覆盖 / 总量 | 召回 |
|---|---|---|---|---|---|
| A 基线 | 115 行（6 份快照） | 它自己 grep（**检索式被它改坏**） | 1 次，只拿到 12 行 | 46 / 115 | **40%** |
| B | 33 行（单文件） | 它自己 grep（同样被改坏） | 1 次，只拿到 12 行 | 12 / 33 | **35%** |
| C | 33 行 | 它自己 grep（改坏）+ 强制先清点 | 1 次，只拿到 12 行 | 12 / 33 | **35%** |
| D | 33 行 | 它自己 grep（**检索式换成最简形式**） | 1 次，拿到 33 行 | 33 / 33 | **100%** |
| **E** | **115 行（6 文件）** | **宿主 `collect` 代取（100% 正确）** | **0 次**（素材内联） | 68 / 115 | **59%** |

三条结论：

1. **取材错 = 灾难**：A/B/C 三组全都漏掉最大的一类（`node.exe`，26 条），因为它的 grep 把 `[WARN ]`
   （WARN 后带空格）整类滤掉了 —— 而输出**行号真、原文真、格式规整**，看起来毫无破绽。
2. **取材对了，还有规模门槛**：E 组素材 100% 正确、`node.exe` 找回来了（25/26），但 115 行一口吃下只剩 59%，
   丢的全是 ≤3 条的小类。**同一模型：33 行 100% vs 115 行 59%** —— 小模型的"胃口"是真有上限的。
3. **E 组另一个收获**：零工具调用 → 彻底免疫"篡改检索式"这个失败模式；耗时 56.9 秒，
   本地 token 18,991（零成本），主上下文只增加它那 4 行结论。

| 模型类型 | 体积 | 吞吐 | 工具调用 | 结论 |
|---|---|---|---|---|
| MoE 30B 级 / Q4（每 token 只激活 ~3B） | ~17 GB | ~230 tok/s | ✅ | 本样本里最快；思考关不掉，但不污染 content |
| MoE 35B 级 / Q4_K_S | ~18.5 GB | ~200 tok/s | ✅ | 可关思考 |
| 稠密 27B / Q4（带视觉） | ~16 GB | 快 | ❌ | 视觉专用，走 `ollama-vision` 路由 |
| 推理型（reasoning）14B / Q4 | ~8 GB | ~88 tok/s | ✅ | 能当备胎，质量一般 |
| 推理型 32B / Q4 | ~18.5 GB | **~15 tok/s** | ❌ | 不可用：关思考必空输出，且稠密大模型慢一个数量级 |
| 推理型 70B、以及同尺寸的 Q8 量化 | 35–40 GB | — | — | ❌ 装不进本样本那台 24 GB 显存的机器 |

**一次真实委派的账本**（一批 82.1 KB 的日志，997 行 / 118 条告警）：

| 指标 | 数值 |
|---|---|
| 子代理动作 | 1 次 grep + 2 步 LLM，**64 秒**，100% GPU |
| 本地 token | 输入 22,262 + 输出 8,062（**零成本**） |
| 云端 token | **0** |
| 回到主上下文 | **692 字符**（vs 原文 82.1 KB，压缩 ≈147×） |

## 10. 维护铁律（要改这个插件之前必读）

1. **工具集合恒定**：只在 `apply()` 里注册一次，不因配置变化增删。工具表一变，整条 prompt 前缀缓存作废，
   几十万 token 的会话要重新 prefill，用户会看到"发一句话卡住几分钟"（实测 166 秒零 token）。
2. **配置走 volatile**：只有 `Schema.volatile()` 字段才会出现在设置表单并被写入接口接受；
   改完即时生效、不重挂插件。非 volatile 字段只在 patch 里改。
3. **零裸 import**：插件以 `link:` 安装，模块真实路径在工作区，Node 从真实路径向上找不到 profile 的依赖树
   （实测 `ERR_MODULE_NOT_FOUND`）。需要 schemastery 时用 `createRequire` 以 dsh 安装目录 / profile 目录为基准解析。
4. **前端护栏**：React Hook 只能在组件函数体内（在 `factory` 里调用组件会让整棵前端树崩掉）；
   面板要包 ErrorBoundary；`remote` 的命名空间必须逐个显式 `inject`。
5. **异步流程不许在模块加载期跑**：加载期零副作用，全部进 `apply()`。
6. **toolFilter 名单要跟着部署走**：`tools.restrict()` 只认"可 restrict 的继承全局工具名"，名单里有一个不在就整条抛错
   （allow 与 deny 一样）。`startChild()` 已把这一步包成"按报错点名逐个剔除 → 重试 → 结果里如实告知"，
   改名单时**务必保留这条自适应路径**，否则换台机器就可能静默失去防护（真机踩过一次静默降级）。

7. **政策段落文本保持静态**：`DELEGATION_POLICY` 里不要塞 enabled/model 这类会变的状态 —— 它位于系统提示词最前端，
   文本一变整条 prompt 前缀缓存作废，长会话要重新 prefill（实测踩过 166 秒零 token）。要降级就用文案里的"报已关闭就自己读"。
8. **主动性靠"看得见的触发条件"，不靠工具描述**：光有工具不给触发规则，实测自发调用率是 0（见 §5.4）。
   想让它被用上，就把"什么时候用"写进系统提示词或工具结果，而不是写进 README 等模型来读。
9. **取材不交给弱模型**：凡是"它自己选参数"的环节（正则式、路径、扫描范围）都是**静默失败**的来源 ——
   错误不会写在输出里，只会让某一整类凭空消失，而报告看起来毫无破绽。要么给死参数，要么由宿主代劳（`collect`）。
10. **验证自己的工具链**：判分用的 grep/PowerShell 也要声明口径（大小写、编码、续行），否则你会拿被污染的
   分母去评判别人（实测差点把 100% 判成 97%）。
11. **弱模型的"胃口"有上限，而且只能靠分批解决**：同一模型同一任务 33 行 100% / 115 行 59%（§9.1）——
   提高 prompt 质量、强制先清点，都**没能**改善（B/C 组实测无效）。`collect.chunkLines` 就是为这条存在的：
   切片 → 逐片归类 → 合并，全程在宿主侧，主上下文不受影响（E 组：零工具调用、只回结论）。

## 11. 文件清单

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半身：两个工具 + Config schema + 前置自检 |
| `client.js` | 客户端半身：「设置 → 本地模型」面板（开关 / 模型选择 / 端点 / 连接状态） |
| `cordis.patch.yml` | bundle 行声明（插入 `local-ollama-models` 这一行） |
| `README.md` | 本文件（使用声明；模型与参数一律"自己量"，见 §2.1） |
| `bench.mjs` | 选型尺：列本机模型 / 实测吞吐与工具调用 / 打印可直接粘贴的路由 YAML（只读） |
| `package.json` | 包信息；`dsh.bundle.patch` 与 `dsh.client` 声明 |
