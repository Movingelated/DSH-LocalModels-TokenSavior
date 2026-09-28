#!/usr/bin/env node
/**
 * 本地模型选型尺 —— 让任何一台机器上的使用者/AI 自己量出"该填什么参数"。
 *
 * 为什么存在：README 里不该写死某个模型名。吞吐、显存、上下文、能不能调工具，
 * 全都随机器而变。这个脚本只做一件事：把"本机的真实情况"量出来，并给出可直接粘贴
 * 的路由 YAML。判据（怎么选）在 README.md §2.1。
 *
 * 用法：
 *   node bench.mjs                  列出本机可用于子代理的模型 + 各维度事实（不测速，秒回）
 *   node bench.mjs <模型id>         实测该模型：工具调用 / 吞吐 / 显存，并打印路由 YAML
 *   node bench.mjs <模型id> --json  同上，输出 JSON（便于程序或 AI 解析）
 *
 * 只读：只调用 Ollama 的 /api/*，不拉取、不删除、不改任何配置文件。
 */
import fs from 'node:fs';

const HOST = (() => {
  const raw = String(process.env.OLLAMA_HOST || '').trim();
  const s = raw ? (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`) : 'http://127.0.0.1:11434';
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.hostname}:${u.port || '11434'}`;
  } catch {
    return 'http://127.0.0.1:11434';
  }
})();

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const modelArg = args.find((a) => !a.startsWith('--')) ?? '';
const say = (...parts) => { if (!asJson) console.log(...parts); };

async function api(path, body, timeoutMs = 300000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}${path}`, body === undefined
      ? { signal: ctrl.signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 读一个模型的事实：能力、上下文、参数量、是否有内置人设。 */
async function factsOf(id) {
  const info = await api('/api/show', { model: id }).catch((e) => ({ __error: String(e?.message ?? e) }));
  if (info.__error) return { id, error: info.__error };
  const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
  const arch = info.model_info?.['general.architecture'];
  return {
    id,
    tools: caps.includes('tools'),
    vision: caps.includes('vision'),
    thinking: caps.includes('thinking'),
    persona: Boolean(String(info.system ?? '').trim()),
    params: info.details?.parameter_size ?? '',
    quant: info.details?.quantization_level ?? '',
    family: info.details?.family ?? '',
    context: arch ? (info.model_info?.[`${arch}.context_length`] ?? null) : null,
  };
}

/** 看当前驻留情况（判断吃不吃得到 GPU）。 */
async function residency() {
  const ps = await api('/api/ps').catch(() => null);
  const rows = Array.isArray(ps?.models) ? ps.models : [];
  return rows.map((m) => ({
    id: m.name,
    sizeGb: m.size ? +(m.size / 1024 ** 3).toFixed(2) : null,
    vramGb: m.size_vram ? +(m.size_vram / 1024 ** 3).toFixed(2) : null,
    gpuPercent: m.size ? Math.round(((m.size_vram ?? 0) / m.size) * 100) : null,
    context: m.context_length ?? null,
  }));
}

/** 打印可直接粘贴的路由片段。 */
function routeYaml(f) {
  const ctx = f.context ? Math.min(f.context, 32768) : 32768;
  return [
    '      ollama-local:',
    '        displayName: Ollama 本地（文字）',
    '        api: openai-completions',
    `        baseURL: ${HOST}/v1`,
    '        apiKeyEnv: OLLAMA_API_KEY',
    '        reasoning: off              # 若本机模型关不掉思考，见 README §7 第 5 条',
    '        timeoutMs: 300000',
    `        defaultContextWindow: ${ctx}`,
    '        defaultMaxTokens: 8192',
    '        defaultInput: [text]        # 显式声明，防把图片误发给纯文本模型',
    '        models:',
    `          - id: "${f.id}"`,
    `            name: ${f.id}`,
    `            contextWindow: ${ctx}${f.context && f.context > ctx ? `   # 该模型原生支持 ${f.context}` : ''}`,
    '            maxTokens: 4096',
    '            input: [text]',
  ].join('\n');
}

async function main() {
  const ver = await api('/api/version', undefined, 5000).catch(() => null);
  if (!ver) {
    console.error(`❌ 连不上 Ollama（${HOST}）。先确认它已启动；自定义端口请设 OLLAMA_HOST。`);
    process.exit(1);
  }
  const tags = await api('/api/tags').catch(() => ({ models: [] }));
  const list = Array.isArray(tags.models) ? tags.models : [];
  const usable = [];
  for (const m of list) usable.push({ ...(await factsOf(m.name)), gb: m.size ? +(m.size / 1024 ** 3).toFixed(2) : null });

  if (!modelArg) {
    if (asJson) return console.log(JSON.stringify({ host: HOST, version: ver.version, models: usable, running: await residency() }, null, 2));
    say(`Ollama ${ver.version} @ ${HOST} —— 本机 ${usable.length} 个模型\n`);
    say('可作子代理（必须支持工具调用）：');
    for (const f of usable.filter((f) => f.tools)) {
      say(`  ✓ ${f.id}  (${[f.gb ? f.gb + 'GB' : '', f.params, f.quant, f.context ? 'ctx ' + f.context : ''].filter(Boolean).join(' · ')})` +
        `${f.persona ? '  ⚠ 带内置人设，建议避免' : ''}${f.vision ? '  👁 视觉' : ''}`);
    }
    const bad = usable.filter((f) => !f.tools);
    if (bad.length) say(`\n不可作子代理（${bad.length} 个，多数因不支持 tools）：${bad.map((f) => f.id).join(', ')}`);
    const running = await residency();
    if (running.length) {
      say('\n当前驻留（判断吃不吃到 GPU）：');
      for (const r of running) say(`  ${r.id}  ${r.sizeGb}GB 中 ${r.vramGb}GB 在显存 → ${r.gpuPercent}% GPU  ctx ${r.context}`);
      say('  ⚠ 不是 100% 就要换更小/更低量化的模型，否则 CPU 参与推理会慢一个数量级');
    }
    say('\n下一步：node bench.mjs <上面任一 id>   → 实测吞吐 + 工具调用 + 打印可直接粘贴的路由 YAML');
    say('判据（怎么挑）见 README.md §2.1。');
    return;
  }

  const f = usable.find((m) => m.id === modelArg);
  if (!f) {
    console.error(`❌ 本机没有模型 "${modelArg}"。现有：\n  ${usable.map((m) => m.id).join('\n  ')}`);
    process.exit(2);
  }

  // 1) 快速工具调用实测：给一个最小工具，看它会不会真的调用
  const toolCall = await api('/api/chat', {
    model: f.id,
    stream: false,
    think: false,
    options: { num_predict: 128 },
    messages: [{ role: 'user', content: '现在几点？必须调用 get_time 工具来获取，不要凭猜测回答。' }],
    tools: [{
      type: 'function',
      function: { name: 'get_time', description: '返回当前时间', parameters: { type: 'object', properties: {}, required: [] } },
    }],
  }, 300000).catch((e) => ({ __error: String(e?.message ?? e) }));

  // 2) 吞吐实测：让它真的生成一段，用 eval_count/eval_duration 算 tok/s
  const gen = await api('/api/chat', {
    model: f.id,
    stream: false,
    think: false,
    options: { num_predict: 200 },
    messages: [{ role: 'user', content: '用中文写一段约 200 字的自我介绍，直接写正文。' }],
  }, 300000).catch((e) => ({ __error: String(e?.message ?? e) }));

  const tokPerSec = gen.eval_count && gen.eval_duration ? +(gen.eval_count / (gen.eval_duration / 1e9)).toFixed(1) : null;
  const firstMs = gen.load_duration != null && gen.total_duration != null
    ? Math.round((gen.load_duration + (gen.prompt_eval_duration ?? 0)) / 1e6)
    : null;
  const calledTool = Array.isArray(toolCall.message?.tool_calls) && toolCall.message.tool_calls.length > 0;
  const leakedThinking = Boolean(toolCall.message?.thinking || gen.message?.thinking);
  const running = (await residency()).find((r) => r.id === f.id || r.id.startsWith(f.id));

  const verdict = {
    模型: f.id,
    体积GB: f.gb,
    参数量: f.params,
    量化: f.quant,
    支持工具: f.tools,
    实测会调用工具: calledTool,
    带内置人设: f.persona,
    原生上下文: f.context,
    '吞吐tok/s': tokPerSec,
    首字延迟ms: firstMs,
    显存驻留: running ? `${running.gpuPercent}% GPU (${running.vramGb}/${running.sizeGb} GB)` : '(未驻留或已卸载)',
    思考泄漏到回答: leakedThinking,
  };

  if (asJson) return console.log(JSON.stringify({ facts: f, verdict, routeYaml: routeYaml(f) }, null, 2));

  say(`=== ${f.id} 实测 ===`);
  for (const [k, v] of Object.entries(verdict)) say(`  ${k}: ${v}`);
  say('');
  const warn = [];
  if (!f.tools) warn.push('❌ 不支持工具调用 —— 不能作为子代理');
  else if (!calledTool) warn.push('⚠ 声明支持 tools，但实测没调用工具 —— 换一个模型或换更明确的 prompt 再试');
  if (f.persona) warn.push('⚠ 带内置人设，可能把角色扮演带进任务');
  if (running && running.gpuPercent !== null && running.gpuPercent < 100) warn.push(`⚠ 只有 ${running.gpuPercent}% 在显存，CPU 参与会显著变慢`);
  if (tokPerSec !== null && tokPerSec < 30) warn.push(`⚠ 吞吐仅 ${tokPerSec} tok/s，长任务会很久（稠密大模型常见）`);
  if (leakedThinking) warn.push('⚠ 思考内容出现在 message.thinking（不污染 content，但额外吃 token）');
  say(warn.length ? warn.join('\n') : '✅ 各项正常，可以写进路由。');
  say('\n--- 可直接粘贴进 profile 的 cordis.patch.yml（替换 providers: 下对应键；详见 README §2.2）---');
  say(routeYaml(f));
  say('\n记得：模型 id 必须写进路由的 models: 才能被委派（否则报 UNKNOWN_MODEL）。');
  say(`另需在 <DSH_HOME>/.credentials.yaml 的 refs 下加占位凭据：OLLAMA_API_KEY: ollama-local-no-key-required`);
  if (fs.existsSync) { /* 保持脚本零副作用：仅示范，不写盘 */ }
}

main().catch((e) => {
  console.error('bench.mjs 失败：', String(e?.message ?? e));
  process.exit(1);
});
