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
import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import { createHash } from 'node:crypto'

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
 * 校准标识文件（v1.10.0）：由"跑过四步校准"的 AI 自己写入（流程见 README §5.7），插件**只读 + 校验**。
 * 可用环境变量覆盖路径（测试用；也方便把标识放到别处）。
 */
export const CALIBRATION_PATH =
  String(process.env.DSH_LOCAL_OLLAMA_CALIBRATION ?? '').trim() ||
  (PLUGIN_DIR ? path.join(PLUGIN_DIR, 'calibration.json') : 'calibration.json')
const CALIBRATION_SCHEMA = 2

/**
 * 本机指纹 —— **只用于提示"这份档案来自另一台机器"，不作为失效条件**。
 * 为什么不做成失效条件：档案里记的是**模型**的参数（上下文容量、一口多少行），
 * 那是模型的属性、不是机器的属性；同名同 digest 的模型换台机器跑，参数依然成立，
 * 强制重跑只会白花 5-8 分钟（跟"换模型要校准、换回来直接用"是同一个道理）。
 */
export const MACHINE_HASH = (() => {  try {
    const raw = `${os.hostname?.() ?? ''}|${os.platform?.() ?? ''}|${os.arch?.() ?? ''}|${process.env.COMPUTERNAME ?? ''}|${process.env.USERNAME ?? ''}`
    return createHash('sha256').update(raw).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
})()

/**
 * 轻量取某模型的 digest（+ Ollama 版本），带 60 秒缓存。
 * 为什么不用 probe()：那会为**每个**模型各打一次 /api/show，24 个模型就是 1 秒多 —— 委派路径上太贵。
 */
let digestCache = { at: 0, baseURL: '', version: null, models: {} }
async function digestOf(baseURL, modelId) {
  const now = Date.now()
  if (digestCache.baseURL !== baseURL || now - digestCache.at > 60000) {
    const models = {}
    let version = null
    try {
      const tags = await reqJSON(`${baseURL}/api/tags`, {}, 5000)
      for (const m of Array.isArray(tags?.models) ? tags.models : []) models[m.name] = m.digest ?? null
    } catch {
      /* 拿不到就返回空，由调用方按"未知"处理 */
    }
    try {
      version = (await reqJSON(`${baseURL}/api/version`, {}, 3000))?.version ?? null
    } catch {
      /* 版本拿不到不影响 digest 判断 */
    }
    digestCache = { at: now, baseURL, version, models }
  }
  const id = String(modelId ?? '').trim()
  const digest = digestCache.models[id] ?? digestCache.models[`${id}:latest`] ?? null
  return { digest, ollamaVersion: digestCache.version }
}

/**
 * 读并校验校准标识 —— **标识是 AI 的自述，不是证明**，所以插件只读它、校验它。
 *
 * v1.10.1 起是**多档案**：同一台机器可以给每个模型各存一份，键 = `${provider}::${model}`。
 * 于是"换模型要重校准、换回来直接用"成立：A 校准过 → 切 B 要校准 → **切回 A 直接用旧档案**。
 * 返回 { state, profile?, keys?, reason? }
 *   · 文件不在 → missing；JSON 坏 / schema 不识 → invalid
 *   · **本模型**没有档案 → missing（reason 说明本机已有几份别的档案）
 *   · 有档案但 contextWindow 与当前声明不一致 → stale（**只废掉这一份**）
 */
export async function readCalibration(expected = {}) {
  let raw = ''
  try {
    raw = await readFile(CALIBRATION_PATH, 'utf8')
  } catch {
    return { state: 'missing', reason: '插件目录里还没有 calibration.json' }
  }
  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    return { state: 'invalid', reason: 'JSON 解析失败' }
  }
  if (!data || typeof data !== 'object') return { state: 'invalid', reason: '顶层不是对象' }

  // schema 1（v1.10.0 的单档案格式）兼容读：把那条包成一份档案
  let profiles = null
  if (data.schema === CALIBRATION_SCHEMA) {
    profiles = data.profiles && typeof data.profiles === 'object' ? data.profiles : {}
  } else if (data.schema === 1 && data.model) {
    profiles = { [`${data.provider ?? ''}::${data.model}`]: data }
  } else {
    return {
      state: 'invalid',
      reason: `schema=${String(data.schema)}（期望 ${CALIBRATION_SCHEMA}；1 是旧版单档案格式）`,
    }
  }

  const keys = Object.keys(profiles)
  const expModel = String(expected.model ?? '').trim()
  const expProvider = String(expected.provider ?? '').trim()
  if (!expModel) return { state: 'missing', keys, reason: '当前没有配置模型，无法查档案' }

  const key = `${expProvider}::${expModel}`
  let profile = profiles[key]
  if (!profile) {
    // 容错：档案可能是别的路由（或旧版没写 provider）写的 —— 按模型 id 兜底找一次
    const hit = Object.entries(profiles).find(([k]) => k.endsWith(`::${expModel}`))
    profile = hit?.[1]
  }
  if (!profile || typeof profile !== 'object') {
    return {
      state: 'missing',
      keys,
      reason: keys.length
        ? `本机已有 ${keys.length} 个模型的档案，但没有 "${key}"`
        : `本机还没有任何模型的档案（缺 "${key}"）`,
    }
  }
  const expCtx = Number(expected.contextWindow)
  const gotCtx = Number(profile.capacity?.contextWindow)
  if (Number.isFinite(expCtx) && expCtx > 0 && Number.isFinite(gotCtx) && gotCtx !== expCtx) {
    return {
      state: 'stale',
      profile,
      keys,
      reason: `"${key}" 的档案记的是上下文 ${gotCtx}，当前声明 ${expCtx} → 只废掉这一份`,
    }
  }

  // ── 值域校验：手写/伪造的离谱数字直接判 invalid（"看起来合理"的伪造只能靠抽样复核，见 README §5.7）──
  const cLines = Number(profile.capacity?.chunkLines)
  const cChars = Number(profile.capacity?.maxChars)
  const cRows = Number(profile.capacity?.maxRows)
  if (!Number.isFinite(cLines) || cLines < 0 || cLines > 500) {
    return { state: 'invalid', profile, keys, reason: `chunkLines=${String(profile.capacity?.chunkLines)} 越界（允许 0~500）` }
  }
  if (!Number.isFinite(cChars) || cChars < 5000 || cChars > 400000) {
    return { state: 'invalid', profile, keys, reason: `maxChars=${String(profile.capacity?.maxChars)} 越界（允许 5000~400000）` }
  }
  if (!Number.isFinite(cRows) || cRows < 1 || cRows > 30) {
    return { state: 'invalid', profile, keys, reason: `maxRows=${String(profile.capacity?.maxRows)} 越界（允许 1~30）` }
  }

  // ── 同名不同内容：digest 是模型文件的指纹，比"模型名字照应"可靠得多 ──
  const warns = []
  const expDigest = String(expected.modelDigest ?? '').trim().toLowerCase()
  const gotDigest = String(profile.env?.modelDigest ?? '').trim().toLowerCase()
  if (expDigest && gotDigest && expDigest !== gotDigest) {
    return {
      state: 'stale',
      profile,
      keys,
      reason: `"${key}" 档案里的 digest ${gotDigest.slice(0, 12)}… ≠ 本机 ${expDigest.slice(0, 12)}…（**同名不同内容**）`,
    }
  }
  if (expDigest && !gotDigest) {
    warns.push('档案没记 modelDigest，无法确认"同名同内容"（建议重校一次或补上 digest）')
  }
  const expVer = String(expected.ollamaVersion ?? '').trim()
  const gotVer = String(profile.env?.ollamaVersion ?? '').trim()
  if (expVer && gotVer && expVer !== gotVer) {
    warns.push(`Ollama 版本变了（档案 ${gotVer} → 本机 ${expVer}），引擎行为可能有别`)
  }
  const gotMachine = String(profile.env?.machineHash ?? '').trim()
  if (MACHINE_HASH && gotMachine && gotMachine !== MACHINE_HASH) {
    warns.push('这份档案来自**另一台机器**（digest 一致 → 参数仍然适用；建议做一次抽样复核，别直接盲信）')
  }
  return { state: 'calibrated', profile, keys, warn: warns.length ? warns.join('；') : undefined }
}

/** 读模型声明的上下文窗口（拿不到就返回 null —— 不猜）。 */
async function modelContextWindow(llm, provider, model) {
  try {
    const info = await llm?.resolveModelInfo?.(provider, model)
    const n = Number(info?.context?.contextWindow)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** 给 AI 抄的校准文件模板（放在 ollama_local_models 的输出里，省得它猜格式）。 */
function calibrationTemplate() {
  return JSON.stringify(
    {
      schema: CALIBRATION_SCHEMA,
      profiles: {
        '<provider>::<模型 id>': {
          calibratedAt: '<ISO 时间>',
          calibratedBy: '<DSH 会话 / 模型>',
          env: {
            endpoint: '<端点>',
            ollamaVersion: '<版本>',
            gpu: '<显卡>',
            vramGB: 0,
            machineHash: MACHINE_HASH,
            modelDigest: '<该模型的 digest，见 ollama_local_models 输出；用于识别"同名不同内容">',
          },
          capacity: { contextWindow: 32768, maxChars: 60000, chunkLines: 40, maxRows: 12 },
          evidence: {
            throughputTokPerSec: 0,
            appetiteProbe: [
              { lines: 30, recall: 0 },
              { lines: 60, recall: 0 },
              { lines: 120, recall: 0 },
            ],
            kinds: { classify: 'untested', qa: 'untested', extract: 'untested', summary: 'untested', code: 'untested' },
          },
          notes: '',
        },
      },
    },
    null,
    2,
  )
}

/** 校准状态段落（**免费通道**：改这里不砸 prompt 前缀缓存）。 */
export function renderCalibration(cal, ctxWindow = null) {
  const keys = Array.isArray(cal.keys) ? cal.keys : []
  if (cal.state === 'calibrated') {
    const c = cal.profile?.capacity ?? {}
    return (
      `[校准] ✅ **本模型**已有档案（${cal.profile?.calibratedAt ?? '时间未知'}）\n` +
      `  容量：上下文 ${c.contextWindow ?? '?'} / 素材上限 ${c.maxChars ?? '?'} 字符 / 一口 ${c.chunkLines ?? '?'} 行 / 输出 ${c.maxRows ?? '?'} 行\n` +
      `  本机档案（${keys.length}）：${keys.join('、')}\n` +
      (cal.warn ? `  ⚠️ ${cal.warn}\n` : '') +
      '  这些值会作为**默认参数**生效（调用时显式传参仍可覆盖）。'
    )
  }
  const why =
    cal.state === 'missing'
      ? '⚠️ 本模型还没有档案'
      : cal.state === 'stale'
        ? `⚠️ 本模型的档案已过期（${cal.reason}）`
        : `⚠️ 标识不可用（${cal.reason}）`
  const suggestion =
    ctxWindow && ctxWindow > 8192
      ? `\n  （已读到本机声明上下文 ${ctxWindow} token → 素材上限建议 ≈ ${Math.round(((ctxWindow - 8192) * 2.4) / 1000)}k 字符）`
      : ''
  return (
    `[校准] ${why} —— 当前按**保守默认**运行（素材上限 60000 字符；一口行数取当前模式的阈值 40~120 行）。\n` +
    `  本机已有档案：${keys.length ? keys.join('、') : '（无）'}\n` +
    `  建议给**当前模型**做一次「四步容量校准」（步骤见 README §5.7），然后把这一条档案写进：\n  ${CALIBRATION_PATH}\n` +
    '  ⚠️ 写入时**先读再合并**：只新增/更新本模型那一条，**不要覆盖其它模型的档案**（换了模型再换回来就不用重跑）。\n' +
    '  模板（照抄改值；模型或上下文一变只需重校这一个模型）：\n' +
    calibrationTemplate()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n') +
    suggestion
  )
}

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
async function startChild(subagents, ctx, spec, extraDeny = []) {
  let deny = [...READONLY_DENY, ...extraDeny]
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

/** 把一个只含 `*` / `?` 的文件名 glob 编译成正则（零依赖）。 */
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.')}$`)
}

/**
 * 宿主侧预取素材（v1.5.0）—— 本插件最重要的一次"防呆"。
 *
 * 为什么必须由宿主来取：弱模型自己调 grep 时会**静默篡改 pattern**。实测铁证：
 * 我们给它 `\[(WARN|ERROR)`，它自作主张补成 `\[(WARN|ERROR)\]`；而日志里的告警标记是
 * `[WARN ]`（WARN 后面有空格），于是 **22/34 行被无声滤掉** —— 它对着剩下的 12 行认真归类，
 * 还自信地报 TOTAL=12：行号真、原文真、格式规整，**唯一的破绽是最大的一整类凭空消失**。
 * 换成由宿主取素材：素材 100% 正确、不经过主上下文、也不依赖弱模型的工具调用参数。
 *
 * @returns 命中行文本（每行带 `文件名:行号  ` 前缀）与计数，供调用方核对。
 */
export async function collectMaterial(spec) {
  const out = { text: '', files: 0, lines: 0, chars: 0, scanned: 0, truncated: false, notes: [] }
  const root = String(spec?.path ?? '').trim()
  if (!root) throw new Error('collect.path 不能为空：给文件的绝对路径，或给目录并配 include')
  const maxChars = Number.isFinite(spec?.maxChars) && spec.maxChars > 0 ? Math.min(spec.maxChars, 400000) : 60000

  let pattern = null
  const rawPattern = String(spec?.pattern ?? '').trim()
  if (rawPattern) {
    try {
      pattern = new RegExp(rawPattern)
    } catch (e) {
      throw new Error(`collect.pattern 不是合法正则：${String(e?.message ?? e)}`)
    }
  }

  const st = await stat(root).catch(() => null)
  if (!st) throw new Error(`collect.path 不存在：${root}`)
  let files = []
  if (st.isDirectory()) {
    const include = String(spec?.include ?? '*').trim() || '*'
    const re = globToRegExp(include)
    const entries = await readdir(root, { withFileTypes: true })
    files = entries
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => path.join(root, e.name))
      .sort()
    if (files.length === 0) throw new Error(`collect.include="${include}" 在 ${root} 下没有匹配到任何文件`)
  } else {
    files = [root]
  }

  const parts = []
  for (const f of files) {
    let text = ''
    try {
      text = await readFile(f, 'utf8')
    } catch (e) {
      out.notes.push(`读取失败 ${path.basename(f)}：${String(e?.message ?? e)}`)
      continue
    }
    out.files++
    const lines = text.split(/\r?\n/)
    out.scanned += lines.length
    const base = path.basename(f)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      if (pattern && !pattern.test(line)) continue
      const row = `${base}:${i + 1}  ${line}`
      if (out.chars + row.length + 1 > maxChars) {
        out.truncated = true
        break
      }
      parts.push(row)
      out.chars += row.length + 1
      out.lines++
    }
    if (out.truncated) break
  }
  out.text = parts.join('\n')
  return out
}

/**
 * 构建"合并各分片结论"的 prompt（v1.6.0 起；v1.8.0 起按任务类型分化）。
 * 分片结论都很小，所以合并这一步几乎不吃上下文。
 */
function buildMergePrompt(kindKey, parts, ran, total) {
  const kind = KINDS[kindKey] ?? KINDS.classify
  const body = parts.map((p, i) => `--- 分片 ${i + 1} ---\n${p.text}`).join('\n')
  return (
    `你是本地只读采集工人。下面是同一批素材被切成 ${total} 片后、各自的处理结果` +
    `${total > ran ? `（本次只跑了前 ${ran} 片）` : ''}。\n` +
    kind.merge +
    '\n\n' +
    body
  )
}

/** 单次上下文预算（字符）。禁止分片的类型超过它就必须报错，而不是悄悄截断。 */
const CONTEXT_BUDGET = 60000

/**
 * 三种调用模式（v1.7.0）—— 把"公式化的提示词"内置进插件，调用方只填任务本身。
 *
 * 设计依据（README §9.1 的对照实验）：本地模型的可靠性受**素材规模**影响最大
 * （33 行 100% / 115 行 59%），而云端省下的 token mainly 由"素材不进主上下文"决定 ——
 * 所以三个模式的差别主要是**本地时间与召回率**；c 因为可靠性低、调用方多半要补核，
 * 实际省得反而更少（这就是"省得有限"的机制）。
 */
const MODES = {
  'max-save': {
    label: 'a 极致省 token（最慢）',
    maxChars: 200000,
    chunkLines: 40,
    maxRows: 15,
    brief: '按根因归类去重；同一类合并为一行、次数相加、保留一条代表原文与一处出处',
    extra: [
      '**逐类穷尽**：素材里出现的每一类都必须列出，哪怕只有 1 条；不得为凑数而合并或省略。',
      '先机械清点素材总条数，再归类；TOTAL 必须等于清点结果。',
    ],
  },
  balanced: {
    label: 'b 均衡',
    maxChars: 60000,
    chunkLines: 120,
    maxRows: 12,
    brief: '按根因归类去重；同一类合并为一行、次数相加、保留一条代表原文与一处出处',
    extra: [],
  },
  fast: {
    label: 'c 快跑（省得有限）',
    maxChars: 15000,
    chunkLines: 0,
    maxRows: 8,
    brief: '只列主要类别，小类别（≤2 条）可并入「其他」；不要逐条穷举',
    extra: ['本模式追求速度，召回率较低：调用方需要自行补核。'],
  },
}

/** 把调用方/配置给的模式名归一化：接受 a/b/c 与 max-save/balanced/fast。 */
function normalizeMode(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'a' || s === 'max-save' || s === 'maxsave' || s === 'max') return 'max-save'
  if (s === 'b' || s === 'balanced' || s === 'balance') return 'balanced'
  if (s === 'c' || s === 'fast' || s === 'quick') return 'fast'
  return null
}

/**
 * 任务类型（v1.8.0）—— 每种类型自带三件套：**素材策略 + 输出契约 + 验收动作**。
 *
 * 为什么要它（README §9.2 的问答实验）：三个模式只调"喂多少"，但不同任务对素材的
 * **使用方式**根本不同 —— 问答一旦分片，就等于让它在残缺材料里找答案（实测）；
 * 代码勘查则相反：必须让它自己 read/grep 去探索。输出契约更是各不相同
 * （分类要表格、问答要"答案+行号"、抽取要 JSON、摘要要实体）。把它们做成可插拔的类型，
 * 插件才谈得上泛用；而**每种类型都带一条验收动作**，是"没有尺子就不许加类型"的纪律。
 */
const KINDS = {
  classify: {
    label: 'classify 分类 / 计数（默认）',
    noChunk: false,
    minChars: 0,
    allowFetch: false,
    rules: (m) => [
      '只基于素材作答：不要自己去读文件或检索（取数工具已被禁用）。',
      `归类要求：${m.brief}。`,
      ...m.extra,
      '输出格式（严格照此，不要开场白、不要解释、不要建议、不要结语）：\n' +
        '分类 | 次数 | 代表原文(最多80字) | 出处(文件名:行号)\n' +
        `（按次数从多到少排序，最多 ${m.maxRows} 行）\nTOTAL=<你归类覆盖的素材条数>`,
    ],
    merge:
      '请把它们**合并去重成一张最终表**：同一根因合并为一行、次数相加、保留一个代表原文与出处；不要新增分片里没有的类别；' +
      '**次数只汇总各片报出的数字，不要重新估算、也不要重复计数**。\n' +
      '输出格式（严格照此，不要开场白、不要解释、不要建议）：\n' +
      '分类 | 次数 | 代表原文(最多80字) | 出处(文件名:行号)\n（按次数从多到少排序）\nTOTAL=<次数合计>',
    chunkHint: '请只归类这一片，不要推测其它片的内容。',
    verify: '先 grep 复核总数与各类计数，再抽查 2~3 条出处行号 —— **计数一向不可信**（README §6）',
  },
  qa: {
    label: 'qa 大文档问答（不分片）',
    noChunk: true,
    minChars: 100000,
    allowFetch: false,
    rules: () => [
      '只基于素材作答：不要自己去读文件或检索（取数工具已被禁用）。',
      '**逐题作答，不得跳题**：答不出的题也必须写出题号，并明确写「素材里没有」—— 不要猜测、不要编造、不要用常识补全。',
      '每题都必须给出处行号（形如 `文件:行号`）；直接引用原文时保留原文，其余用自己的话概括。',
      '输出格式（严格照此，不要开场白、不要解释、不要建议）：\n' +
        'Q<编号> | **用与提问相同的语言**写的答案（直接引用原文除外） | 出处(文件:行号)\n' +
        '最后单独一行 ANSWERED=<你回答的题数>/<总题数>\n' +
        '（提醒：答案那一列必须用提问的语言写 —— 不要因为素材是英文就用英文作答。这条要求单列一条时无效，实测过。）',
    ],
    merge: '（qa 类型禁止分片，不会走到合并这一步）',
    chunkHint: '',
    verify:
      '抽查 2~3 个行号是否指向真实内容；ANSWERED 的分母必须等于题数 —— **不足就是漏答**，' +
      '而"答薄"比"答错"更难发现（README §9.2）',
  },
  extract: {
    label: 'extract 结构化抽取（JSON）',
    noChunk: false,
    minChars: 0,
    allowFetch: false,
    rules: () => [
      '只基于素材作答：不要自己去读文件或检索（取数工具已被禁用）。',
      '按任务里给出的**字段清单**逐条抽取，组成对象数组。字段值：**能从行内文字推断的就写简短概括**，' +
        '只有完全无法判断时才写 `null` —— 不要编造，但也不要因为过度保守而漏填（实测过：33 行里 20 行空着，' +
        '其中有一行原文明写着"浏览器打不开"）。',
      '每个对象必须带 `_src` 字段，值为出处（`文件:行号`）。',
      '**输出严格 JSON**（一个数组；不要 markdown 代码块、不要解释、不要前后缀）。',
      '输出格式：\n[{"<字段1>": ..., "<字段2>": ..., "_src": "文件:行号"}]\n最后单独一行 COUNT=<你抽出的对象数>',
    ],
    merge:
      '请把它们**合并成一个 JSON 数组**：直接拼接各片的数组元素、保持字段一致、不要新增或改写字段、不要把同一对象算两遍。\n' +
      '输出格式（严格照此）：\n[ {...}, {...} ]\n最后单独一行 COUNT=<数组元素总数>',
    chunkHint: '只抽取这一片里出现的对象，不要推测其它片的内容。',
    verify: '先 JSON.parse（解析失败就是废结果）；抽查 2~3 条 `_src` 行号；COUNT 必须等于数组长度',
  },
  summary: {
    label: 'summary 摘要 / 提炼',
    noChunk: false,
    minChars: 0,
    allowFetch: false,
    rules: () => [
      '只基于素材作答：不要自己去读文件或检索（取数工具已被禁用）。',
      '提炼要点，**保留关键实体**（文件名、版本号、数字、配置项、结论）—— 不要写"文档介绍了……"这类空话。',
      '按重要性排序，每条不超过两行，每条都要带出处行号。',
      '输出格式（严格照此，不要开场白、不要解释、不要建议）：\n- <要点> | 出处(文件:行号)\nKEY=<关键实体/数字，用「、」分隔>\nPOINTS=<要点条数>',
    ],
    merge:
      '请把它们**合并去重成一份要点清单**：同义要点合并、按重要性排序、每条保留最具体的那一版（带数字/结论的）。\n' +
      '输出格式（严格照此）：\n- <要点> | 出处(文件:行号)\nKEY=<关键实体/数字>\nPOINTS=<要点条数>',
    chunkHint: '只提炼这一片的要点，不要总结其它片。',
    verify: '抽 2~3 条要点回查行号；KEY 里的数字/实体要在素材里 grep 得到 —— 摘要最容易"顺手编数字"',
  },
  code: {
    label: 'code 代码只读勘查（允许它自己检索）',
    noChunk: true,
    minChars: 0,
    allowFetch: true,
    rules: () => [
      '你是**只读**代码勘查员：可以用 `read` / `grep` / `glob` 在任务指定的目录里自己检索（写文件、执行命令类工具已被禁用）。',
      '逐条列出任务要求的项目，每条给出 `文件:行号`；**只报你实际看到的内容**，不要推测、不要补全。',
      '不要提改进建议、不要评价代码质量、不要贴大段源码（除非任务明确要求）。',
      '输出格式（严格照此，不要开场白、不要解释、不要建议）：\n项目 | 说明(最多80字) | 出处(文件:行号)\n最后单独一行 ITEMS=<条数>',
    ],
    merge: '（code 类型禁止分片，不会走到合并这一步）',
    chunkHint: '',
    verify: '逐条用 grep 回查；ITEMS 必须等于行数 —— 这类清单最容易**漏项**，而漏了比错了更难发现',
  },
}

const KIND_ALIASES = {
  分类: 'classify',
  计数: 'classify',
  count: 'classify',
  counting: 'classify',
  问答: 'qa',
  question: 'qa',
  'q&a': 'qa',
  抽取: 'extract',
  extraction: 'extract',
  json: 'extract',
  摘要: 'summary',
  summarize: 'summary',
  提炼: 'summary',
  代码: 'code',
  codereview: 'code',
  'code-review': 'code',
}

/** 把调用方给的任务类型归一化；不认识就返回 null（由调用方决定报错还是回退）。 */
function normalizeKind(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  if (KINDS[s]) return s
  return KIND_ALIASES[s] ?? null
}

/** 按 (任务类型, 模式) 把"任务一句话"套成完整提示词：角色 + 铁律 + 输出契约。 */
export function buildPromptFor(kindKey, modeKey, task, opts = {}) {
  const kind = KINDS[kindKey] ?? KINDS.classify
  const mode = { ...(MODES[modeKey] ?? MODES.balanced), ...(opts.tuned ?? {}) }
  const withMaterial = opts.withMaterial !== false
  const head =
    `你是本地只读采集工人（任务类型：${kind.label}）。任务：${String(task ?? '').trim()}\n` +
    '你看不到任何对话上下文。' +
    (withMaterial
      ? '素材由宿主侧预取，附在本消息末尾（每行带 `文件名:行号  ` 前缀）。\n\n'
      : '没有预置素材 —— 按下面的规则自己去检索，只回结论。\n\n')
  return head + kind.rules(mode).map((r, i) => `${i + 1}. ${r}`).join('\n') + '\n'
}

/**
 * 写进**系统提示词**的委派政策段落 —— 本插件最重要的一次"行为修正"。
 *
 * 为什么需要它：工具描述只说"我能做什么"，不会在具体情境里主动冒出来。
 * 实测：插件上线后本会话 250 次工具调用里，本插件共 6 次，**全部是用户点名要求演示的，自发调用 0 次**。
 * 所以必须把"什么时候该委派"写成一条常驻规则，放进每一次请求都看得见的系统提示词。
 *
 * ⚠ 文本刻意保持**静态**（不含 enabled/model 等状态）：系统提示词在最前面，文本一变整条
 *   prompt 前缀缓存作废，几十万 token 的会话要重新 prefill（实测踩过 166 秒零 token）。
 *   功能关闭时也不改文本 —— 靠最后一句"报已关闭就自己读"降级。
 */
const DELEGATION_POLICY =
  '[本地模型子代理] 本机装了 local-ollama-models 插件（工具 subagent_local）：把**需要读懂内容**的活交给本机 Ollama 模型，' +
  '在独立上下文里执行、只回结论 —— 那部分 token 不花钱，原文也不进主上下文。\n' +
  '先问一句"这件事要不要用脑子"：\n' +
  '· **只需要确定性抽取**（路径 / ID / 时间 / 版本号等 grep、正则、pwsh 就能拿准的）→ **自己抽，不要派**；' +
  '抽出来之后"怎么归类、怎么解释"这部分才值得派（机械的交给 shell，语义的交给它）。\n' +
  '· **需要语义理解**（归因、语义归类、摘要、问答、翻译、看图）→ **优先派**，别把原文读进主上下文。\n' +
  '规模只决定"值不值得"：单个文件 > 30 KB、或要扫 ≥ 3 个文件/日志时，派它能省下可观的上下文。\n' +
  '素材 > 32K token（≈100 KB）时**必须**先收窄：最有效的做法是先用 grep / pwsh 把大素材**去重归一化**成小文件再交给它' +
  '（实测 1.7 MB → 84 行），或者让 collect.pattern 只取匹配行 —— 本地模型只有 32K 上下文，整份塞进去会被截成残料。\n' +
  '**换机器/换模型后首次使用前**：先按插件 README §5.7 跑一遍「四步容量校准」（读上下文窗口 / 量吞吐 / 三点测"一口多少行" / 测哪几种 kind 可用），' +
  '把结果写进插件目录的 calibration.json（**先读再合并**，只动本模型那一条）；' +
  '**若该文件里已有本模型的档案且上下文未变，直接用里面的参数、不要重复校准** —— ' +
  '同机换模型只需给新模型校准，**换回来直接用旧档案**（ollama_local_models 的输出会显示本模型的档案状态）。\n' +
  '派法：subagent_local({ kind, task, collect })，collect 给绝对路径；拿回结论后按插件 README §6 复核' +
  '（**分类与行号可信，计数必须自己数**）。若手上没有 subagent_local 工具、或它报"已关闭"，就照常自己读文件，忽略本节。'

/** 触发"读大文件"提示的阈值（字符数）。 */
const BIG_READ_CHARS = 30000

/** 读进主上下文的大文件提示：在**花掉钱的当场**提醒下次可以委派。 */
function bigReadNudge(chars) {
  const kb = Math.round(chars / 1024)
  const kTok = Math.round(chars / 3.2 / 1000)
  return (
    '\n——\n' +
    `⚠ 采集提示：上面这份内容约 ${kb} KB（≈${kTok}k token）已进入主上下文，之后每一轮都要为它付费。\n` +
    '下次遇到**需要读懂内容**的活（语义归类、问答、摘要、翻译），可先调 subagent_local 交给本机 Ollama 模型 —— 那部分 token 零成本；' +
    '而**纯正则/路径抽取**用 grep、pwsh 更快更准，不必派。' +
    '（collect 可让宿主代取素材；拿回结论按插件 README §6 复核）'
  )
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
      mode: z.string().default('balanced').volatile(),
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
      digest: m.digest ?? null,
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
    mode: String(deref(config.mode) ?? '').trim() || 'balanced',
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
        const now = live()
        const probeRes = await probe(resolveBaseURL(now.baseURL))
        const body = renderStatus(probeRes)
        // 版本戳 + **代码指纹**：指纹 = 读自身源码算 sha256 前 8 位（懒算一次）。
        // 用途：回答"宿主现在跑的到底是哪一版代码" —— 改完代码不用猜有没有生效
        //（实测本插件的宿主模块**会被热更新**：改完 index.js + 再动一次 profile patch 就能生效）。
        if (codeFingerprint === null) {
          try {
            const src = await readFile(fileURLToPath(import.meta.url), 'utf8')
            codeFingerprint = createHash('sha256').update(src).digest('hex').slice(0, 8)
          } catch {
            codeFingerprint = 'unknown'
          }
        }
        const pkgVersion = await readFile(path.join(PLUGIN_DIR, 'package.json'), 'utf8')
          .then((t) => JSON.parse(t)?.version ?? '未知')
          .catch(() => '未知')
        const hit = (probeRes.models ?? []).find((m) => m.id === now.model || m.id === `${now.model}:latest`)
        const ctxWindow = now.model ? await modelContextWindow(ctx.get('llm'), now.provider, now.model) : null
        const cal = await readCalibration({
          provider: now.provider,
          model: now.model,
          contextWindow: ctxWindow,
          modelDigest: hit?.digest ?? null,
          ollamaVersion: probeRes.version ?? null,
        })
        return [
          `[版本] v${pkgVersion} ｜ 代码指纹 ${codeFingerprint}（改完代码看这里有没有变 → 判断宿主是否已重新加载）`,
          body,
          renderCalibration(cal, ctxWindow),
          `用法 / 前置条件 / 验收纪律见：${README_PATH}`,
        ]
          .filter(Boolean)
          .join('\n\n')
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
        '触发条件（命中任一就该用本工具，而不是自己 read）：单个文件 > 30 KB、要扫 ≥3 个文件/日志、' +
        '或任务本质是计数 / 去重 / 字段抽取 / 找关键行 / 图片转文字。' +
        '用法与验收纪律见插件 README.md（路径见 ollama_local_models 的输出）。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              '（高级用法，一般不必给）完整的提示词原文；给了它就**不再套用模式模板**。' +
              '常规做法是 task + mode —— 角色、铁律、输出格式、HITS/TOTAL 对账都由插件套好。',
          },
          model: {
            type: 'string',
            description: '可选：改用其他本地模型执行。可先用 ollama_local_models 查看候选。',
          },
          label: { type: 'string', description: '可选短标签，用于在会话里显示这次委派。' },
          collect: {
            type: 'object',
            description:
              '**强烈建议**：让宿主侧代为预取素材（读文件 + 正则过滤），直接拼进子代理的 prompt。' +
              '用它可避免弱模型自己调 grep 时**静默篡改正则**、导致素材整类缺失（实测 22/34 行被无声滤掉）。' +
              '给了它，子代理的 grep/glob 会被自动禁用，素材不进主上下文。',
            properties: {
              path: { type: 'string', description: '文件的绝对路径，或一个目录（配 include）' },
              include: { type: 'string', description: 'path 是目录时用的文件名 glob，如 "launcher*.log"；默认 *' },
              pattern: {
                type: 'string',
                description: '只保留匹配该正则的行（JS 正则；建议用最简形式，如 WARN|ERROR）；省略则取全部非空行',
              },
              maxChars: { type: 'number', description: '素材字符上限，默认 60000；超出则截断并在结果里标注' },
              chunkLines: {
                type: 'number',
                description:
                  '素材行数超过该值时**自动分批**：宿主切成每片 ≤N 行，逐片归类后再合并（省略则按 mode 的阈值；显式 0 = 不分批）。',
              },
            },
          },
          task: {
            type: 'string',
            description:
              '**推荐用法**：只写任务本身（一句话：要什么 + 对象 + 字段/口径），插件按 kind + mode 套上公式化提示词' +
              '（角色 / 铁律 / 素材策略 / 输出契约 / 验收提示）。与 prompt 二选一；同时给时以 prompt 为准。',
          },
          kind: {
            type: 'string',
            description:
              '**任务类型**（省略 = classify）。每种类型自带素材策略 + 输出契约 + 验收动作：' +
              '**classify** 分类/计数（表格 + TOTAL）；' +
              '**qa** 大文档问答（逐题 + 必给出处行号 + 「不知道就说没有」，**禁止分片**，素材超 60k 字符会报错）；' +
              '**extract** 结构化抽取（严格 JSON 数组 + 每个对象带 `_src` 出处）；' +
              '**summary** 摘要/提炼（要点 + 出处 + KEY 实体）；' +
              '**code** 代码只读勘查（**允许它自己 read/grep 探索**，逐条给 `文件:行号`）。',
          },
          mode: {
            type: 'string',
            description:
              '调用模式（省略则用「设置 → 本地模型」里的默认）：' +
              '**a / max-save** = 极致省 token 但最慢（素材上限 200k、>40 行强制分批、逐类穷尽、最多 15 行）；' +
              '**b / balanced** = 均衡（默认；上限 60k、>120 行才分批、最多 12 行）；' +
              '**c / fast** = 快跑（上限 15k、从不分批、只列主要类别、最多 8 行；省得有限且需自行补核）。',
          },
        },
        required: [],
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
        // 模式（v1.7.0）：调用方给的 mode 优先，否则用设置里的默认
        const modeKey = normalizeMode(args?.mode) ?? normalizeMode(now.mode) ?? 'balanced'
        const mode = MODES[modeKey]
        // 有效模型：调用方传的 model 优先（v1.11.2 修正 —— 档案校验必须按**有效模型**，
        // 不能按配置模型，否则用 model 参数换模型时会拿上一个模型的档案与参数去跑）
        const model = String(args?.model ?? '').trim() || now.model
        if (!model) {
          throw new Error('尚未指定本地模型。请在「设置 → 本地模型」里选一个，或在本工具调用里传 model 参数。')
        }
        // 校准标识（v1.10.0）：有效则覆盖三个"机器相关"默认值 —— 素材上限 / 一口行数 / 输出行数
        const ctxWindow = await modelContextWindow(ctx.get('llm'), now.provider, model)
        const dig = await digestOf(resolveBaseURL(now.baseURL), model).catch(() => null)
        const cal = await readCalibration({
          provider: now.provider,
          model,
          contextWindow: ctxWindow,
          modelDigest: dig?.digest ?? null,
          ollamaVersion: dig?.ollamaVersion ?? null,
        })
        const tuned =
          cal.state === 'calibrated'
            ? {
                maxChars:
                  Number(cal.profile.capacity?.maxChars) > 0 ? Number(cal.profile.capacity.maxChars) : mode.maxChars,
                chunkLines:
                  Number(cal.profile.capacity?.chunkLines) >= 0
                    ? Number(cal.profile.capacity.chunkLines)
                    : mode.chunkLines,
                maxRows: Number(cal.profile.capacity?.maxRows) > 0 ? Number(cal.profile.capacity.maxRows) : mode.maxRows,
              }
            : { maxChars: mode.maxChars, chunkLines: mode.chunkLines, maxRows: mode.maxRows }
        const capacityNote =
          cal.state === 'calibrated'
            ? `[容量] 已校准（模型 ${model}）：上限 ${tuned.maxChars} 字符 / 一口 ${tuned.chunkLines || '不分批'} 行 / 输出 ${tuned.maxRows} 行` +
              (cal.warn ? `\n[容量提示] ${cal.warn}` : '')
            : `[容量] ${
                cal.state === 'missing'
                  ? `本模型未校准（${cal.reason}）`
                  : cal.state === 'stale'
                    ? `本模型档案已过期（${cal.reason}）`
                    : `标识不可用（${cal.reason}）`
              } → 按保守默认（上限 ${tuned.maxChars} 字符 / 一口 ${tuned.chunkLines} 行）；建议先跑 README §5.7 的四步校准`
        // 任务类型（v1.8.0）：不认识的名字直接报错，不悄悄回退成 classify
        const kindRaw = String(args?.kind ?? '').trim()
        if (kindRaw && !normalizeKind(kindRaw)) {
          throw new Error(
            `不认识的任务类型 "${kindRaw}"。可用：${Object.keys(KINDS).join(' / ')}` +
              '（也接受中文别名：分类 / 问答 / 抽取 / 摘要 / 代码）',
          )
        }
        const kindKey = normalizeKind(kindRaw) ?? 'classify'
        const kind = KINDS[kindKey]
        // 公式化提示词：给 task 就由插件套模板；给 prompt 则原样使用（高级用法）
        const manualPrompt = String(args?.prompt ?? '').trim()
        const taskText = String(args?.task ?? '').trim()
        const prompt =
          manualPrompt ||
          (taskText
            ? buildPromptFor(kindKey, modeKey, taskText, { withMaterial: Boolean(args?.collect), tuned })
            : '')
        if (!prompt) {
          throw new Error(
            `要么给 task（推荐：一句话任务，插件按 kind + mode 套公式），要么给完整的 prompt。` +
              `当前：${kind.label} / ${mode.label}`,
          )
        }
        const verifyNote = `[验收建议] ${kind.verify}`
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

        // 起一次子代理并取回文本结论（分批模式会复用多次）
        const baseLabel = typeof args?.label === 'string' && args.label ? args.label : '本地模型'
        const runOnce = async (text, label, extraDeny = []) => {
          const started = await startChild(
            subagents,
            ctx,
            {
              label,
              prompt: [{ type: 'text', text }],
              parent: exec.agent,
              signal: exec.signal,
              agentOptions: { provider: now.provider, model },
            },
            extraDeny,
          )
          try {
            return { text: resultText(await started.run.result), note: started.note }
          } finally {
            try {
              await started.run.dispose?.()
            } catch {
              /* 释放失败不影响结果 */
            }
          }
        }

        /**
         * 分批：每片 ≤chunkLines 行且 ≤8000 字符，最多 8 片；逐片归类后跑一次合并。
         * 为什么要分批：实测同一模型同一任务，**33 行 → 100% 覆盖，115 行 → 59%** ——
         * 它只会抓大类别，≤3 条的小类别会被丢掉。小口喂是唯一的解（见 README §9.1）。
         */
        const runChunked = async (rows, chunkLines) => {
          const chunks = []
          let cur = []
          let curChars = 0
          for (const r of rows) {
            if (cur.length > 0 && (cur.length >= chunkLines || curChars + r.length > 8000)) {
              chunks.push(cur)
              cur = []
              curChars = 0
            }
            cur.push(r)
            curChars += r.length + 1
          }
          if (cur.length) chunks.push(cur)

          const MAX_CHUNKS = 8
          const used = chunks.slice(0, MAX_CHUNKS)
          const t0 = Date.now()
          const partials = []
          for (let i = 0; i < used.length; i++) {
            const head =
              `\n\n=== 素材第 ${i + 1}/${used.length} 片（本片 ${used[i].length} 行；整批 ${rows.length} 行 / 共 ${chunks.length} 片）===\n`
            const tail =
              '\n=== 本片素材结束 ===\n以上是**本片**的全部素材；' +
              (kind.chunkHint || '请只处理这一片，不要推测其它片的内容。')
            try {
              const out = await runOnce(`${prompt}${head}${used[i].join('\n')}${tail}`, `${baseLabel}-片${i + 1}`, extraDeny)
              partials.push({ ok: true, text: out.text, note: out.note })
            } catch (e) {
              partials.push({ ok: false, text: `（第 ${i + 1} 片失败：${String(e?.message ?? e)}）` })
            }
          }

          const okParts = partials.filter((p) => p.ok)
          let merged = ''
          let mergeNote = ''
          if (okParts.length === 0) {
            merged = '所有分片都失败了，没有拿到任何结论。'
          } else if (okParts.length === 1) {
            merged = okParts[0].text
            mergeNote = '（只有一片成功，未做合并）'
          } else {
            try {
              const out = await runOnce(
                buildMergePrompt(kindKey, okParts, used.length, chunks.length),
                `${baseLabel}-合并`,
                extraDeny,
              )
              merged = out.text
              mergeNote = out.note
            } catch (e) {
              merged = okParts.map((p, i) => `--- 片${i + 1} ---\n${p.text}`).join('\n')
              mergeNote = `⚠ 合并失败（${String(e?.message ?? e)}），以上为各片原文拼接，请自行去重`
            }
          }

          const failed = partials.filter((p) => !p.ok).length
          const notes = [
            materialNote,
            `[分批委派] ${used.length} 片 × ≤${chunkLines} 行` +
              `${chunks.length > used.length ? `（素材共 ${chunks.length} 片，为控时只跑前 ${MAX_CHUNKS} 片）` : ''}` +
              ` → ${used.length} 次分片归类 + ${okParts.length > 1 ? 1 : 0} 次合并，共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒` +
              `${failed ? `；⚠ ${failed} 片失败` : ''}`,
            mergeNote,
            ...partials.map((p) => p.note).filter(Boolean),
            verifyNote,
            capacityNote,
          ].filter(Boolean)
          return `${merged}\n\n${[...new Set(notes)].join('\n')}`
        }

        // 素材由宿主代取（v1.5.0）；过大自动分批 + 合并（v1.6.0）；阈值按 mode 取默认（v1.7.0）；类型优先（v1.8.0）
        let material = ''
        let materialNote = ''
        let extraDeny = []
        if (args?.collect && typeof args.collect === 'object') {
          const spec = { ...args.collect }
          const maxChars = Math.max(tuned.maxChars, kind.minChars)
          if (spec.maxChars === undefined) spec.maxChars = maxChars
          const c = await collectMaterial(spec)
          // 禁止分片的类型（qa / code）：素材超单次预算就报错，绝不悄悄截断或分片
          if (kind.noChunk && c.text.length > CONTEXT_BUDGET) {
            throw new Error(
              `${kind.label} 禁止分片：本次素材 ${c.text.length} 字符，超过单次上下文预算 ${CONTEXT_BUDGET} 字符。` +
                '强行分片就等于让它在残缺材料里找答案（实测过的失败模式）。请二选一：' +
                '① 用 collect.pattern / include 把素材缩到与问题相关的范围；' +
                '② 改用 kind=classify 或 summary（这两种支持分片）。',
            )
          }
          materialNote =
            `[任务类型] ${kind.label}\n` +
            `[模式] ${mode.label}（素材上限 ${maxChars} / 分批阈值 ${
              kind.noChunk ? '禁用（类型要求）' : tuned.chunkLines || '关闭'
            }）\n` +
            `[宿主预取素材] ${c.files} 个文件 / ${c.lines} 行 / ${c.chars} 字符${c.truncated ? '（已按上限截断）' : ''}` +
            (c.notes.length ? `；${c.notes.join('；')}` : '')
          extraDeny = kind.allowFetch ? [] : ['grep', 'glob']
          const rows = c.text ? c.text.split('\n') : []
          const chunkLines = kind.noChunk
            ? 0
            : args.collect.chunkLines === undefined
              ? tuned.chunkLines
              : Number.isFinite(args.collect.chunkLines) && args.collect.chunkLines > 0
                ? Math.min(Math.floor(args.collect.chunkLines), 500)
                : 0
          if (chunkLines > 0 && rows.length > chunkLines) {
            return await runChunked(rows, chunkLines)
          }
          material =
            `\n\n=== 素材（宿主侧已预取：${c.files} 个文件 / 命中 ${c.lines} 行 / ${c.chars} 字符` +
            `${c.truncated ? '，⚠ 已按上限截断' : ''}；共扫描 ${c.scanned} 行）===\n` +
            c.text +
            '\n=== 素材结束 ===\n' +
            (kind.allowFetch
              ? '以上是宿主预取的素材；如不够用，你可以用 read / grep 自己去取（这几个工具没有被禁用）。'
              : '以上**就是本任务的全部素材**，请只基于它作答；不要自己去读文件或检索（取数工具已禁用）。')
        }
        const childPrompt = material ? `${prompt}${material}` : prompt

        // 只读保证的三层（从强到弱）：
        //  ① toolFilter deny 掉写/执行/再派活类工具（见 READONLY_DENY；不可用的名字逐个剔除并如实告知）
        //  ② 任务本身是采集类 prompt，验收在调用方做
        //  ③ 子代理看不到本对话，独立上下文
        // 刻意不用 maxDepth: 0 —— 那表示"禁止任何委派"，会把子代理卡在启动前（实测踩过）。
        const tSingle = Date.now()
        const out = await runOnce(childPrompt, baseLabel, extraDeny)
        const timingNote = `[耗时] ${((Date.now() - tSingle) / 1000).toFixed(1)} 秒（1 次本地推理）`
        const notes = [materialNote, capacityNote, out.note, verifyNote, timingNote].filter(Boolean).join('\n')
        return notes ? `${out.text}\n\n${notes}` : out.text
      },
    }),
  )

  // ── 主动性机制一：把"什么时候该委派"写进系统提示词 ────────────────
  // systemPrompt 服务可能比本插件晚就绪（roleplay 插件踩过同一个坑），所以带定时重试。
  let policyDisposer = null
  let policyTimer = null
  const tryRegisterPolicy = () => {
    if (policyDisposer) return true
    const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (!prompt || typeof prompt.section !== 'function') return false
    policyDisposer = prompt.section({ name: 'local-ollama-delegation', order: 2850, text: DELEGATION_POLICY })
    ctx.logger?.info?.('[local-ollama] 已注册系统提示词段落 local-ollama-delegation（委派政策）')
    return true
  }
  if (!tryRegisterPolicy()) {
    let tries = 0
    policyTimer = setInterval(() => {
      if (tryRegisterPolicy() || ++tries > 40) {
        clearInterval(policyTimer)
        policyTimer = null
      }
    }, 1500)
    if (typeof policyTimer?.unref === 'function') policyTimer.unref()
  }
  ctx.effect(() => () => {
    if (policyTimer) clearInterval(policyTimer)
    try {
      policyDisposer?.()
    } catch {
      /* 释放失败不影响卸载 */
    }
  })

  // ── 主动性机制二：读了大文件就当场提醒（花掉钱的那一刻）──────────
  // 用 tools/post-execute 给结果**追加**一个文本块：accept 决策只替换 content，
  // 原来的 value/meta 都被保留（dsh-tools 的 postExecute 实现），因此界面卡片不受影响。
  // 每个 agent 只提醒一次，避免变成噪音。
  const nudgedAgents = new Set()
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      if (!live().enabled) return downstream
      if (!downstream || downstream.kind !== 'accept') return downstream
      if (exec?.name !== 'read') return downstream
      const blocks = Array.isArray(downstream.content)
        ? downstream.content
        : Array.isArray(result?.content)
          ? result.content
          : []
      const chars = blocks.reduce(
        (n, b) => n + (b && b.type === 'text' && typeof b.text === 'string' ? b.text.length : 0),
        0,
      )
      if (chars < BIG_READ_CHARS) return downstream
      const key = String(exec?.agent?.id ?? 'anon')
      if (nudgedAgents.has(key)) return downstream
      if (nudgedAgents.size > 200) nudgedAgents.clear()
      nudgedAgents.add(key)
      return { ...downstream, content: [...blocks, { type: 'text', text: bigReadNudge(chars) }] }
    } catch {
      return downstream // 提示本身绝不能影响工具结果
    }
  })

  ctx.logger?.info?.(`[local-ollama] 已注册委派工具 ${toolName}（开关在调用时判定）`)
}
