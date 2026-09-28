/**
 * 本地 Ollama 模型 —— 宿主半身
 *
 * 三条设计约束，全部来自真实事故，不要改回去：
 *
 *  1. 模块加载期零副作用：不写文件、不注册工具、不打日志 —— 全部逻辑在 apply() 内。
 *  2. 工具集合恒定：工具只在 apply() 时注册一次，之后不因配置变化而增删。
 *     工具表一变，整条 prompt 前缀的缓存就作废；几十万 token 的会话要重新 prefill，
 *     表现就是"发一句话卡住好几分钟"（实测：166 秒零 token）。
 *  3. 开关与模型走 Config 的 volatile 字段：设置页直接可写、写进 profile patch、
 *     即时生效、无需重启 —— 也因此不再需要任何"在对话里说一句"的写入通道。
 *
 * 提供两个工具：
 *  - ollama_local_models：只读查询本机 Ollama 状态与可用模型（随时可查）
 *  - subagent_local：把一个只读采集任务委派给本地模型执行（开关在调用时判定）
 *
 * 完整说明书见同目录 README.md（用法 / 前置条件 / 验收纪律 / 排错表 / 维护铁律）——
 * 它是写给"下一台机器上的 AI"看的，别删；工具输出里会带上它的绝对路径。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 本插件目录与说明书路径。
 *
 * 为什么要算出来：这份 README.md 是插件的"自带说明书"（用法 / 前置条件 / 验收纪律），
 * 换一台机器、换一个 AI 时，它必须能被**不靠历史对话**地找到。所以把绝对路径塞进
 * 工具的输出与描述里，任何读到的人都能直接 read 它。
 */
const PLUGIN_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return ''
  }
})()
const README_PATH = PLUGIN_DIR ? path.join(PLUGIN_DIR, 'README.md') : 'README.md'

/**
 * 委派给本地模型时禁掉的工具：写/执行类 + 再派活类。
 *
 * 目的：让"只读采集工人"这个承诺由**机制**保证，而不是只靠 prompt 的自觉。
 * 实测过一次没加过滤的委派：子代理拿到 32 个工具，其中含 write / edit / pwsh / plugin_manager。
 *
 * ⚠ 语义陷阱：`tools.restrict()` 对名单里**任何未注册的名字**都会直接抛错，
 *   allow 与 deny 一视同仁（dsh-tools：`names unknown global tool "x"; known global tools: ...`）。
 *   所以本名单是"尽力而为"——缺名字的部署会在 startChild() 里退化为不过滤，而不是让委派整个失败。
 */
const READONLY_DENY = [
  'write',
  'edit',
  'pwsh',
  'job_kill',
  'plugin_manager',
  'subagent',
  'subagent_fork',
  'subagent_local',
  'workflow',
]

/**
 * 带只读过滤地起子代理 —— 名单里在本部署**不可 restrict** 的名字逐个剔除后重试；
 * 全部被剔除时退化为"不过滤"，并且**把结果如实告诉调用方**（不再静默降级）。
 *
 * 为什么要逐个剔除：`tools.restrict()` 只认"继承来的全局工具名"
 * （dsh-tools: view(scope).restrictableNames），名单里只要有一个不在该集合里，整条调用就抛错；
 * 一次剔除一批，才能保住其余防护。
 * 为什么不能静默：真机实测过一次静默降级 —— 子代理照样拿到 32 个工具，而调用方毫不知情。
 */
async function startChild(subagents, ctx, spec) {
  let deny = [...READONLY_DENY]
  const dropped = []
  for (;;) {
    if (deny.length === 0) {
      return { run: await subagents.start('spawn', spec), note: readonlyNote(dropped, true) }
    }
    try {
      const run = await subagents.start('spawn', { ...spec, toolFilter: { deny } })
      return { run, note: dropped.length > 0 ? readonlyNote(dropped, false) : undefined }
    } catch (e) {
      const message = String(e?.message ?? '')
      if (!/unknown global tool/i.test(message)) throw e
      // 报错形如：tools.restrict() names unknown global tool "x", "y"; known global tools: a, b, ...
      // 只有"未知"的名字带引号，所以引号里的就是本轮要剔掉的。
      const unknown = [...message.matchAll(/"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((n) => deny.includes(n))
      if (unknown.length === 0) throw e
      deny = deny.filter((n) => !unknown.includes(n))
      dropped.push(...unknown)
      ctx.logger?.warn?.(
        `[local-ollama] 这些工具名在本部署不可 restrict，已从只读名单剔除后重试：${unknown.join(', ')}`,
      )
    }
  }
}

/** 只读过滤没能完全生效时，附在结果末尾的说明。 */
function readonlyNote(dropped, all) {
  return all
    ? '⚠ 只读过滤未生效：本部署拒绝了整份 deny 名单，子代理拿到的是全部工具，只读性仅由任务约束保证。'
    : `⚠ 只读过滤未完全生效：${dropped.join(', ')} 在本部署不可 restrict、已从名单剔除，子代理仍可使用这几个工具。`
}

/**
 * 载入 schemastery —— Config schema 唯一需要的东西。
 *
 * 为什么不是 `import z from '@deepseek-ai/schemastery'`：
 * 本插件以 link: 方式装进 profile，模块的真实路径在工作区里，Node 的 ESM 会从真实
 * 路径向上找 node_modules，永远找不到 profile 的依赖树（实测 ERR_MODULE_NOT_FOUND，
 * 上一次装载失败正是它）。这里改用 createRequire，以「dsh 安装目录 / profile 目录」
 * 为基准做一次 CJS 解析：同步、不联网、不落盘；解析不到就降级为"无 Config"
 * （面板会如实说明原因），而不是让整个插件装载失败。
 */
function loadSchemastery() {
  const bases = []
  const entry = String(process.argv[1] ?? '')
  const at = entry.lastIndexOf('node_modules')
  if (at > 0) bases.push(path.join(entry.slice(0, at + 'node_modules'.length), 'index.js'))
  const profileDir = String(process.env.DSH_PROFILE_DIR ?? '').trim()
  if (profileDir) bases.push(path.join(profileDir, 'index.js'))
  for (const base of bases) {
    try {
      const z = createRequire(base)('@deepseek-ai/schemastery')
      if (z && typeof z.object === 'function') return z
    } catch {
      /* 换下一个基准 */
    }
  }
  return null
}

const z = loadSchemastery()

export const name = 'local-ollama-models'

/** 依赖：工具注册表；子代理注册表为可选（缺失时委派会给出明确错误）。 */
export const inject = ['tools']

/**
 * 配置 schema。
 *
 * volatile 是"设置页可写"的唯一凭据：DSH 只把 volatile 字段投影成可编辑表单，
 * 非 volatile 字段既不出现在表单里，也会被写入接口拒绝。这既是开关能点的原因，
 * 也是"改完立即生效、不用重启"的原因 —— 值存在 profile patch 里，每次读取都是最新值。
 */
export const Config = z
  ? z.object({
      enabled: z.boolean().default(false).volatile(),
      model: z.string().default('').volatile(),
      baseURL: z.string().default('').volatile(),
      toolName: z.string().default('subagent_local'),
      provider: z.string().default('ollama-local'),
    })
  : undefined

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 11434

/** volatile 字段拿到的是"活引用"（.get()）；普通字段就是普通值。 */
function deref(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** 解析端点：显式配置 > OLLAMA_HOST 环境变量 > 默认。 */
export function resolveBaseURL(configured) {
  const raw = String(configured || '').trim() || String(process.env.OLLAMA_HOST || '').trim()
  if (!raw) return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  const s = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.hostname}:${u.port || String(DEFAULT_PORT)}`
  } catch {
    return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  }
}

/** 带超时的 JSON 请求。 */
async function reqJSON(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测 Ollama：版本、可达性、模型清单与"能否作子代理"判定。
 * 判定要点：必须支持工具调用（tools）—— 不支持工具调用的模型读了文件也回不来结论。
 */
export async function probe(baseURL) {
  const out = { reachable: false, baseURL, version: null, error: null, models: [] }
  try {
    const ver = await reqJSON(`${baseURL}/api/version`, {}, 4000)
    out.version = ver?.version ?? null
    out.reachable = true
  } catch (e) {
    out.error = e?.name === 'AbortError' ? '连接超时（4 秒）' : String(e?.message ?? e)
    return out
  }

  let list = []
  try {
    const tags = await reqJSON(`${baseURL}/api/tags`, {}, 8000)
    list = Array.isArray(tags?.models) ? tags.models : []
  } catch (e) {
    out.error = `模型列表读取失败: ${String(e?.message ?? e)}`
    return out
  }

  for (const m of list) {
    const row = {
      id: m.name,
      gb: m.size ? +(m.size / 1024 ** 3).toFixed(2) : null,
      params: m.details?.parameter_size ?? '',
      quant: m.details?.quantization_level ?? '',
      family: m.details?.family ?? '',
      supportsTools: false,
      hasPersona: false,
      maxContext: null,
      usable: false,
      note: '',
    }
    try {
      const info = await reqJSON(
        `${baseURL}/api/show`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.name }),
        },
        8000,
      )
      const caps = Array.isArray(info?.capabilities) ? info.capabilities : []
      row.supportsTools = caps.includes('tools')
      row.hasPersona = Boolean(String(info?.system ?? '').trim())
      const arch = info?.model_info?.['general.architecture']
      row.maxContext = arch ? (info?.model_info?.[`${arch}.context_length`] ?? null) : null
      row.usable = row.supportsTools
      row.note = row.supportsTools
        ? (row.hasPersona ? '支持工具调用，但带内置人设，建议避免' : '可用')
        : '不支持工具调用（tools），不能作为本地子代理'
    } catch (e) {
      row.note = `能力探测失败: ${String(e?.message ?? e)}`
    }
    out.models.push(row)
  }
  return out
}

/** 从子代理结果里取出模型可见文本。 */
function resultText(result) {
  const blocks = Array.isArray(result?.output) ? result.output : []
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (text) return text
  if (result?.structured !== undefined) return JSON.stringify(result.structured)
  if (result?.diagnostic) return `本地子代理未产出文本。诊断：${result.diagnostic}`
  return '本地子代理未产出任何内容。'
}

/** 把探测结果压成给模型看的紧凑文本。 */
function renderStatus(s) {
  const lines = []
  lines.push(`端点: ${s.baseURL}`)
  if (!s.reachable) {
    lines.push('状态: 无法连接 ❌')
    lines.push(`错误: ${s.error ?? '未知'}`)
    lines.push('提示: 请确认 Ollama 已启动；若用了自定义端口，请在「设置 → 本地模型」里改端点。')
    return lines.join('\n')
  }
  lines.push(`状态: 已连接 ✅  版本: ${s.version ?? '未知'}`)
  const usable = s.models.filter((m) => m.usable)
  lines.push(`模型总数: ${s.models.length}   可作子代理: ${usable.length}`)
  if (usable.length === 0) {
    lines.push('')
    lines.push('❗ 没有任何模型支持工具调用，无法作为本地子代理。')
    lines.push('请二选一：① 自行下载，例如 `ollama pull qwen3:30b-a3b`；② 让我代劳拉取。')
    return lines.join('\n')
  }
  lines.push('')
  lines.push('可用作子代理的模型:')
  for (const m of usable) {
    const meta = [m.gb ? `${m.gb}GB` : '', m.params, m.quant, m.maxContext ? `ctx ${m.maxContext}` : '']
      .filter(Boolean)
      .join(' · ')
    lines.push(`  ✓ ${m.id}  (${meta})${m.hasPersona ? '  ⚠ 带内置人设' : ''}`)
  }
  const unusable = s.models.filter((m) => !m.usable)
  if (unusable.length) {
    lines.push('')
    lines.push(`其余 ${unusable.length} 个模型不可用（多数因不支持工具调用）。`)
  }
  return lines.join('\n')
}

/**
 * 委派前置自检：provider 路由是否已注册、目标模型是否在该路由的模型目录里。
 *
 * 为什么需要：面板与 `ollama_local_models` 列的是 Ollama 里的**全部**模型，而 pi-ai 只认
 * 路由 `models:` 里声明过的 id —— 未声明的会以 `UNKNOWN_MODEL` 抛出，那句话对使用者毫无指引。
 * 自检只做"确定能报错的事"：任何一步拿不到答案就放行，绝不用自检把本来可用的配置挡在门外。
 */
async function checkRoute(llm, provider, model) {
  if (!llm || typeof llm.listProviders !== 'function') return { ok: true }
  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch {
    return { ok: true }
  }
  const ids = providers.map((p) => p?.id).filter(Boolean)
  if (!ids.includes(provider)) return { ok: false, reason: 'provider-missing', providers: ids }
  let catalog = []
  try {
    catalog = (await llm.listModels?.(provider)) ?? []
  } catch {
    return { ok: true }
  }
  const models = catalog.map((m) => m?.id).filter(Boolean)
  if (models.length > 0 && !models.includes(model)) {
    return { ok: false, reason: 'model-not-declared', models }
  }
  return { ok: true }
}

export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}

  /**
   * 每次调用都重新取值。volatile 引用由 loader 原地更新，
   * 所以设置页一保存，这里立刻就是新值 —— 不重挂插件、不重启进程。
   */
  const live = () => ({
    enabled: deref(config.enabled) === true,
    model: String(deref(config.model) ?? '').trim(),
    baseURL: String(deref(config.baseURL) ?? '').trim(),
    toolName: String(deref(config.toolName) ?? '').trim() || 'subagent_local',
    provider: String(deref(config.provider) ?? '').trim() || 'ollama-local',
  })

  const snap = live()
  const toolName = snap.toolName
  ctx.logger?.info?.(
    `[local-ollama] 载入：enabled=${snap.enabled} model="${snap.model || '(未设置)'}" ` +
      `端点=${resolveBaseURL(snap.baseURL)}${Config ? '' : ' ⚠ 未能载入 Config schema，设置页将不可写'}`,
  )

  // ── 工具 1：状态查询（只读，无副作用）──────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'ollama_local_models',
      description:
        '查询本机 Ollama 的状态、版本与模型清单，并标出哪些模型可以担任本地子代理（必须支持工具调用）。' +
        '在把任务委派给本地模型之前，可用它确认环境是否就绪。只读，不会启动或下载任何模型。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
      },
      execute: async () => {
        const body = renderStatus(await probe(resolveBaseURL(live().baseURL)))
        return `${body}\n\n用法 / 前置条件 / 验收纪律见：${README_PATH}`
      },
    }),
  )

  // ── 工具 2：委派 ──────────────────────────────────────────────
  // 无条件注册，一切判定推迟到调用时：
  //  · 注册时判断 enabled 会踩"本插件激活早于 patch 覆盖生效"的时序坑（实测踩过）
  //  · 按开关增删工具会让工具表抖动，进而废掉 prompt 前缀缓存
  // 调用时判定完全免疫：关着就给一条明确的错误，而不是工具静默消失。
  const subagentsOf = () => ctx.get('subagents')

  ctx.effect(() =>
    ctx.tools.register({
      name: toolName,
      description:
        `把一个只读的信息采集任务交给本地 Ollama 模型执行，不消耗云端 token。` +
        '适用：读大文件后只回结论、扫日志找关键行、统计计数、图片转文字。' +
        '不适用：写文件、改代码、架构判断、产出最终交付文案。' +
        '本地模型在独立上下文里工作，看不到本对话，因此 prompt 必须自包含；只有它的结论会回到这里。' +
        '派活前建议先读插件 README.md 的「最优使用法」与「验收纪律」（路径见 ollama_local_models 的输出）。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              '自包含的任务描述：要读的文件绝对路径、要提取什么、期望的输出格式。本地模型看不到本对话，必须写全。',
          },
          model: {
            type: 'string',
            description: '可选：改用其他本地模型执行。可先用 ollama_local_models 查看候选。',
          },
          label: { type: 'string', description: '可选短标签，用于在会话里显示这次委派。' },
        },
        required: ['prompt'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
      },
      execute: async (args, exec) => {
        // 开关与模型都在调用时读运行期配置（设置页改完立刻生效）
        const now = live()
        if (!now.enabled) {
          throw new Error('本地模型委派当前处于关闭状态。打开「设置 → 本地模型」里的开关即可启用。')
        }
        const prompt = String(args?.prompt ?? '').trim()
        if (!prompt) throw new Error('prompt 不能为空')
        const model = String(args?.model ?? '').trim() || now.model
        if (!model) {
          throw new Error(
            '尚未指定本地模型。请在「设置 → 本地模型」里选一个，或在本工具调用里传 model 参数。',
          )
        }
        const subagents = subagentsOf()
        if (!subagents) throw new Error('subagents 服务不可用，无法委派')

        // 前置自检：把 UNKNOWN_MODEL / 路由缺失这类"看不懂的报错"提前变成可执行的指引
        const check = await checkRoute(ctx.get('llm'), now.provider, model)
        if (check.ok === false && check.reason === 'provider-missing') {
          throw new Error(
            `provider 路由 "${now.provider}" 未注册：这台机器还没有声明 Ollama 路由。` +
              `请按插件 README.md §2.2 在 profile 的 cordis.patch.yml 里加上 llm-pi-ai 的 providers 配置，然后重启 DSH。` +
              `（当前已注册的路由：${check.providers.join(', ') || '无'}｜说明书：${README_PATH}）`,
          )
        }
        if (check.ok === false && check.reason === 'model-not-declared') {
          throw new Error(
            `模型 "${model}" 没有写进 provider "${now.provider}" 的 models 列表，调用会以 UNKNOWN_MODEL 失败。` +
              `可改用已声明的：${check.models.join(', ')}；` +
              `或把 "${model}" 补进该路由的 models:（见 README.md §2.3）后重启 DSH。`,
          )
        }

        const started = await startChild(subagents, ctx, {
          label: typeof args?.label === 'string' && args.label ? args.label : '本地模型',
          prompt: [{ type: 'text', text: prompt }],
          parent: exec.agent,
          signal: exec.signal,
          agentOptions: { provider: now.provider, model },
        })
        const run = started.run
        // 只读保证的三层（从强到弱）：
        //  ① toolFilter deny 掉写/执行/再派活类工具（见 READONLY_DENY；不可用的名字逐个剔除并如实告知）
        //  ② 任务本身是采集类 prompt，验收在调用方做
        //  ③ 子代理看不到本对话，独立上下文
        // 刻意不用 maxDepth: 0 —— 那表示"禁止任何委派"，会把子代理卡在启动前（实测踩过）。
        try {
          const body = resultText(await run.result)
          return started.note ? `${body}\n\n${started.note}` : body
        } finally {
          try {
            await run.dispose?.()
          } catch {
            /* 释放失败不影响结果 */
          }
        }
      },
    }),
  )

  ctx.logger?.info?.(`[local-ollama] 已注册委派工具 ${toolName}（开关在调用时判定）`)
}
