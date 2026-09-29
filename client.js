/**
 * 本地 Ollama 模型 —— 客户端半身（「设置 → 本地模型」独立栏目）
 *
 * 血的教训（上次把整个前端搞崩的原因）：
 *   React Hook 绝不能出现在 factory(require) 的执行路径上，只能在组件渲染时调用。
 * 本文件据此设计，并叠了四层保险：
 *   ① factory 体内零副作用、零 Hook
 *   ② require('react') 做防御性取值
 *   ③ 组件被 ErrorBoundary 包裹 —— 渲染异常只显示降级提示，不扩散
 *   ④ 所有异步调用 try/catch，失败只显示错误文本
 *
 * 写入通道：本插件的宿主行声明了 volatile Config 字段，因此 DSH 的 settings 服务会
 * 把它暴露成命名空间 `local-ollama-models`，面板可以直接读写 —— 保存即生效、无需重启。
 * 命名空间缺失时面板会给出诊断，而不是假装能点。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-local-ollama-models',
  factory(require) {
    let React;
    try {
      React = require('react');
    } catch {
      React = null;
    }
    if (!React || typeof React.createElement !== 'function') {
      // React 不可用时静默退出，不注册任何内容，绝不抛错
      return { inject: [], apply() {} };
    }
    const h = React.createElement;

    /** 本插件在 profile patch 里的行 id，也是 settings 命名空间。 */
    const NS = 'local-ollama-models';
    const DEFAULT_BASE = 'http://127.0.0.1:11434';

    // 只用主题 token：浅色/深色都由主题决定，不硬编码颜色
    const C = {
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      card: 'var(--dsw-alias-bg-layer-1)',
      field: 'var(--dsw-alias-bg-layer-2)',
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.6, color: C.text },
      card: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', background: C.card },
      row: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' },
      title: { fontWeight: 600, marginBottom: 2 },
      hint: { color: C.muted, fontSize: 12 },
      meta: { color: C.muted, fontSize: 11, marginTop: 2 },
      kvRow: { display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 },
      kv: { display: 'flex', gap: 6, alignItems: 'baseline' },
      k: { color: C.muted, fontSize: 12 },
      v: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      list: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, maxHeight: 360, overflowY: 'auto' },
      item: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 6, background: C.field },
      sel: { borderColor: C.accent, boxShadow: `0 0 0 1px ${C.accent} inset` },
      ok: { color: C.ok, fontSize: 11, marginTop: 2 },
      bad: { color: C.err, fontSize: 11, marginTop: 2 },
      alert: { border: `1px solid ${C.err}`, borderRadius: 6, padding: '9px 11px', color: C.err, fontSize: 12, background: C.card },
      note: { border: `1px solid ${C.borderStrong}`, borderRadius: 6, padding: '9px 11px', fontSize: 12, background: C.card },
      good: { border: `1px solid ${C.ok}`, borderRadius: 6, padding: '9px 11px', fontSize: 12, background: C.card },
      bt: { border: `1px solid ${C.borderStrong}`, borderRadius: 6, padding: '5px 12px', cursor: 'pointer', background: C.card, color: C.text, fontSize: 12 },
      btOn: { borderColor: C.accent, color: C.accent },
      btOff: { opacity: 0.55, cursor: 'not-allowed' },
      code: { fontFamily: 'ui-monospace, monospace', fontSize: 11, background: C.field, padding: '1px 5px', borderRadius: 4 },
      input: {
        width: '100%', marginTop: 6, padding: '6px 9px', borderRadius: 6,
        border: `1px solid ${C.borderStrong}`, background: C.field, color: C.text,
        fontFamily: 'ui-monospace, monospace', fontSize: 12,
      },
    };

    const mb = (n) => (n ? `${(n / 1024 ** 2).toFixed(0)} MB` : '');

    /** 与宿主侧 resolveBaseURL 保持一致的端点归一化。 */
    function endpointOf(configured) {
      const raw = String(configured || '').trim();
      if (!raw) return DEFAULT_BASE;
      const s = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      try {
        const u = new URL(s);
        return `${u.protocol}//${u.hostname}:${u.port || '11434'}`;
      } catch {
        return DEFAULT_BASE;
      }
    }

    async function jget(url, ms = 5000) {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      try {
        const r = await fetch(url, { signal: c.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally { clearTimeout(t); }
    }
    async function jpost(url, body, ms = 8000) {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: c.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally { clearTimeout(t); }
    }

    /** 探测 Ollama 并判定每个模型能否作为本地子代理。 */
    async function probe(baseURL) {
      const out = { reachable: false, baseURL, version: null, error: null, models: [] };
      try {
        const v = await jget(`${baseURL}/api/version`, 4000);
        out.version = v?.version ?? null;
        out.reachable = true;
      } catch (e) {
        out.error = e?.name === 'AbortError' ? '连接超时（4 秒）' : String(e?.message ?? e);
        return out;
      }
      try {
        const tags = await jget(`${baseURL}/api/tags`, 8000);
        const list = Array.isArray(tags?.models) ? tags.models : [];
        for (const m of list) {
          const row = {
            id: m.name, bytes: m.size ?? 0,
            params: m.details?.parameter_size ?? '',
            quant: m.details?.quantization_level ?? '',
            family: m.details?.family ?? '',
            tools: false, persona: false, ctx: null, note: '',
          };
          try {
            const info = await jpost(`${baseURL}/api/show`, { model: m.name });
            const caps = Array.isArray(info?.capabilities) ? info.capabilities : [];
            row.tools = caps.includes('tools');
            row.persona = Boolean(String(info?.system ?? '').trim());
            const arch = info?.model_info?.['general.architecture'];
            row.ctx = arch ? (info?.model_info?.[`${arch}.context_length`] ?? null) : null;
            row.note = row.tools ? (row.persona ? '支持工具调用，但带内置人设' : '可用') : '不支持工具调用（tools）';
          } catch (e) {
            row.note = `能力探测失败: ${String(e?.message ?? e)}`;
          }
          out.models.push(row);
        }
      } catch (e) {
        out.error = `模型列表读取失败: ${String(e?.message ?? e)}`;
      }
      return out;
    }

    /** 错误边界：任何子组件渲染异常都在此止住，只显示降级提示。 */
    class Boundary extends React.Component {
      constructor(p) {
        super(p);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err: String(err?.message ?? err) };
      }
      render() {
        if (this.state.err) {
          return h('div', { style: S.alert },
            '本地模型设置栏目渲染失败（已隔离，不影响其他界面）：',
            h('div', { style: { marginTop: 4, fontFamily: 'ui-monospace, monospace', fontSize: 11 } }, this.state.err));
        }
        return this.props.children;
      }
    }

    function Panel(props) {
      const [cfg, setCfg] = React.useState(null);
      const [rev, setRev] = React.useState(undefined);
      const [nsFound, setNsFound] = React.useState(null); // null=读取中 true=可写 false=不可写
      const [nsNames, setNsNames] = React.useState('');
      const [probeRes, setProbeRes] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');
      const [saved, setSaved] = React.useState(false);
      const ctxRef = React.useRef(null);

      // 从 props 取到设置页上下文（由注册处传入），不在 factory 里做任何事
      React.useEffect(() => {
        ctxRef.current = props?.ctx ?? null;
      }, [props]);

      const savedTimer = React.useRef(null);
      React.useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
      const flashSaved = React.useCallback(() => {
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2500);
      }, []);

      const endpoint = endpointOf(cfg?.baseURL);
      const writable = nsFound === true;

      /** 读取本插件的配置命名空间（DSH 只暴露有 volatile Config 字段的行）。 */
      const loadCfg = React.useCallback(async () => {
        const ctx = ctxRef.current;
        let settings;
        try {
          settings = ctx?.remote?.settings;
        } catch (e) {
          setNsFound(false);
          setNsNames(`访问 remote.settings 失败：${String(e?.message ?? e)}`);
          return null;
        }
        if (!settings?.describe) {
          setNsFound(false);
          setNsNames('remote.settings.describe 不可用');
          return null;
        }
        // 注意：`remote.settings` 的方法返回的是「信封」—— { ok: true, value } 或 { ok: false, error }。
        // 当裸对象读会永远读到 undefined（官方 ui-settings 也是 `response.ok ? response.value` 这么取的）。
        // 这里同时兼容信封与裸对象两种形态，API 形态变化时不会静默变成"零命名空间"。
        const res = await settings.describe();
        const view = res?.ok === true ? res.value : (res?.ok === undefined ? res : null);
        if (!view || !Array.isArray(view.namespaces)) {
          setNsFound(false);
          setNsNames(`settings.describe 未返回命名空间列表：${String(res?.error?.message ?? res?.error ?? '空响应')}`);
          setCfg({});
          setRev(undefined);
          return null;
        }
        const rows = view.namespaces;
        setNsNames(rows.map((n) => n.ns).join('、'));
        const ns = rows.find((n) => n.ns === NS);
        if (!ns) {
          setNsFound(false);
          setCfg({});
          setRev(undefined);
          return null;
        }
        setNsFound(true);
        const value = ns.value && typeof ns.value === 'object' ? ns.value : {};
        setCfg(value);
        setRev(ns.revision);
        return value;
      }, []);

      const loadProbe = React.useCallback(async (url) => {
        setProbeRes(await probe(url));
      }, []);

      /** 重新检测：先刷新配置（端点可能改了），再按配置的端点探测。 */
      const refresh = React.useCallback(async () => {
        setBusy(true); setErr('');
        try {
          const value = await loadCfg();
          await loadProbe(endpointOf(value?.baseURL));
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [loadCfg, loadProbe]);

      /** 写入一个配置字段：走 DSH 的 settings 通道，存进 profile patch，即时生效。 */
      const write = React.useCallback(async (field, value) => {
        const ctx = ctxRef.current;
        setBusy(true); setErr('');
        try {
          if (!ctx?.remote?.settings?.mutate) throw new Error('settings 远程命名空间不可用（缺少 remote.settings 注入）');
          if (!writable) throw new Error('本插件未出现在 settings 命名空间中');
          // 同样是信封：失败时 { ok:false, error:{ code, message } }；裸对象视为成功
          const res = await ctx.remote.settings.mutate(NS, [{ op: 'set', path: [field], value }], rev);
          if (res && res.ok === false) {
            const err = res.error ?? {};
            const code = String(err.code ?? '');
            const msg = String(err.message ?? err ?? '未知错误');
            // 别人也改过配置 → 版本号对不上：重新读一次，让用户再点一下即可
            if (/conflict/i.test(code) || /changed since it was read/i.test(msg)) {
              try { await loadCfg(); } catch { /* 读失败就只报错 */ }
              setErr('配置刚被别处改过，已重新载入最新值 —— 请再点一次。');
              return;
            }
            throw new Error(code ? `${msg}（${code}）` : msg);
          }
          if (res == null) throw new Error('settings.mutate 没有返回结果');
          await loadCfg();
          flashSaved();
        } catch (e) {
          const msg = String(e?.message ?? e);
          // 别人也改过配置 → 版本号对不上：重新读一次，让用户再点一下即可
          if (/changed since it was read/i.test(msg)) {
            try { await loadCfg(); } catch { /* 读失败就只报错 */ }
            setErr('配置刚被别处改过，已重新载入最新值 —— 请再点一次。');
          } else {
            setErr(`写入失败：${msg}`);
          }
        } finally {
          setBusy(false);
        }
      }, [loadCfg, flashSaved, rev, writable]);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          // 两件事彼此独立：配置读取失败不应连累状态探测（上次就是被连累成"无法连接"）
          let value = null;
          try {
            value = await loadCfg();
          } catch (e) {
            if (alive) setErr(`读取配置失败：${String(e?.message ?? e)}`);
          }
          try {
            await loadProbe(endpointOf(value?.baseURL));
          } catch (e) {
            if (alive) setErr(`探测 Ollama 失败：${String(e?.message ?? e)}`);
          }
        })();
        return () => { alive = false; };
      }, [loadCfg, loadProbe]);

      const enabled = cfg?.enabled === true;
      const selected = String(cfg?.model ?? '');
      const models = probeRes?.models ?? [];
      const usable = models.filter((m) => m.tools);
      const reachable = probeRes?.reachable === true;

      const out = [];

      // ── 总开关 ──
      out.push(h('div', { key: 'sw', style: S.card },
        h('div', { style: S.row },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: S.title }, '启用本地模型子代理'),
            h('div', { style: S.hint },
              '开启后，我会拿到一个委派工具，可把「读大文件、扫日志、图片转文字」这类只读采集任务交给本地 Ollama 模型执行——' +
              '本地模型在独立上下文里干活，只有结论回到对话，因此不消耗云端 token。'),
          ),
          h('button', {
            style: { ...S.bt, ...(enabled ? S.btOn : {}), ...(busy || !writable ? S.btOff : {}) },
            disabled: busy || !writable,
            onClick: () => write('enabled', !enabled),
          }, busy ? '…' : enabled ? '已开启 · 点击关闭' : '已关闭 · 点击开启'),
        ),
      ));

      // ── 调用模式（v1.7.0）──
      const MODE_ROWS = [
        { key: 'max-save', name: 'a 极致省 token', hint: '最慢：素材上限 200k、>40 行强制分批、逐类穷尽 → 召回最高，我几乎不用补核' },
        { key: 'balanced', name: 'b 均衡（默认）', hint: '上限 60k、>120 行才分批、最多 12 行' },
        { key: 'fast', name: 'c 快跑', hint: '最快：上限 15k、从不分批、只列主要类别 —— 召回较低，需要我补核' },
      ];
      const curMode = String(cfg?.mode ?? 'balanced');
      out.push(h('div', { key: 'mode', style: S.card },
        h('div', { style: S.title }, '调用模式（默认提示词模板）'),
        h('div', { style: S.hint },
          '调用方可以按次指定 a/b/c 覆盖；这里设的是**没指定时**的默认。三种模式的差别主要是本地时间与召回率 —— ' +
          '云端省下的 token 都差不多（素材都不进主上下文），但 a 召回高、c 需要我回头补核。'),
        h('div', { style: S.list },
          MODE_ROWS.map((m) => h('label', {
            key: m.key,
            style: { ...S.item, ...(curMode === m.key ? S.sel : {}), cursor: writable ? 'pointer' : 'default' },
          },
            h('input', {
              type: 'radio',
              name: 'local-ollama-mode',
              checked: curMode === m.key,
              disabled: busy || !writable,
              onChange: () => write('mode', m.key),
              style: { marginTop: 3 },
            }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: curMode === m.key ? 600 : 400 } }, m.name),
              h('div', { style: S.meta }, m.hint),
            ),
          )),
        ),
      ));

      // ── 可写性说明 ──
      if (nsFound === false) {
        out.push(h('div', { key: 'nosw', style: S.alert },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '本面板暂时写不了配置'),
          h('div', null,
            '原因：settings 服务里没有 ', h('span', { style: S.code }, NS), ' 这个命名空间 —— ' +
            '通常是宿主侧没有声明 Config schema（或 DSH 还没重启加载新版本）。'),
          h('div', { style: { marginTop: 6, color: C.muted, fontSize: 11, wordBreak: 'break-all' } },
            `当前 settings 暴露的命名空间：${nsNames || '（无）'}`),
          h('div', { style: { marginTop: 6 } },
            '临时办法：直接编辑 profile 的 ',
            h('span', { style: S.code }, 'cordis.patch.yml'),
            ' 里 ', h('span', { style: S.code }, 'local-ollama-models'), ' 这一行的 enabled / model，然后重启 DSH。'),
        ));
      } else if (nsFound === true) {
        out.push(h('div', { key: 'yes', style: S.good },
          '本面板可直接读写配置：点上方按钮开关，点下面任意模型条目即切换默认模型。' +
          (saved ? '　✅ 已保存，立即生效。' : '')));
      }

      // ── 连接状态 ──
      out.push(h('div', { key: 'st', style: S.card },
        h('div', { style: S.row },
          h('div', { style: S.title }, 'Ollama 连接状态'),
          h('button', { style: { ...S.bt, ...(busy ? S.btOff : {}) }, disabled: busy, onClick: refresh },
            busy ? '检测中…' : '重新检测'),
        ),
        h('div', { style: S.kvRow },
          h('div', { style: S.kv }, h('span', { style: S.k }, '连通性'),
            h('span', { style: { ...S.v, color: reachable ? C.ok : C.err, fontWeight: 600 } },
              reachable ? '已连接' : '无法连接')),
          h('div', { style: S.kv }, h('span', { style: S.k }, '版本'),
            h('span', { style: { ...S.v, color: reachable ? C.text : C.err } }, probeRes?.version ?? '—')),
          h('div', { style: S.kv }, h('span', { style: S.k }, '端点'), h('span', { style: S.v }, endpoint)),
          h('div', { style: S.kv }, h('span', { style: S.k }, '模型总数'), h('span', { style: S.v }, String(models.length))),
          h('div', { style: S.kv }, h('span', { style: S.k }, '可作子代理'),
            h('span', { style: { ...S.v, color: usable.length ? C.ok : C.err, fontWeight: 600 } }, String(usable.length))),
        ),
        !reachable && probeRes?.error
          ? h('div', { style: { ...S.alert, marginTop: 10 } },
              `无法连接 Ollama：${probeRes.error}　请确认 Ollama 已启动；若使用自定义端口，请在下方端点框中填写。`)
          : null,
      ));

      // ── 无可用模型 ──
      if (reachable && usable.length === 0) {
        out.push(h('div', { key: 'none', style: S.alert },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '没有可用作子代理的模型'),
          h('div', null, '本地子代理要求模型支持工具调用（tools），当前没有任何模型通过该检查。'),
          h('div', { style: { marginTop: 4 } },
            '请二选一：① 自行下载，例如在终端执行 ',
            h('span', { style: S.code }, 'ollama pull qwen3:30b-a3b'),
            '；② 让我代劳——在对话里说「帮我拉取 qwen3:30b-a3b」。'),
        ));
      }

      // ── 模型选择 ──
      if (reachable) {
        out.push(h('div', { key: 'list', style: S.card },
          h('div', { style: S.title }, '选择本地模型'),
          h('div', { style: S.hint },
            '只有支持工具调用的模型可选。带内置人设的模型建议避免——它们可能把角色扮演带进任务。' +
            (writable ? '' : '（当前不可写：请先解决上面的命名空间问题）')),
          h('div', { style: S.meta },
            '⚠ 本表列出的是 Ollama 里的全部模型；能被委派的只有已写进 DSH 路由（llm-pi-ai → provider.models）的 id，' +
            '未写入的会在调用时报 UNKNOWN_MODEL。补声明的方法见插件目录的 README.md §2.3。'),
          h('div', { style: S.list },
            models.length === 0
              ? h('div', { style: S.hint }, '（无模型）')
              : models.map((m) => {
                  const isSel = m.id === selected;
                  return h('div', { key: m.id, style: { ...S.item, ...(isSel ? S.sel : {}) } },
                    h('input', {
                      type: 'radio',
                      name: 'local-ollama-model',
                      checked: isSel,
                      disabled: !m.tools || busy || !writable,
                      onChange: () => write('model', m.id),
                      style: { marginTop: 3 },
                    }),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', { style: { fontWeight: isSel ? 600 : 400, wordBreak: 'break-all' } }, m.id),
                      h('div', { style: S.meta },
                        [m.params, m.quant, m.family, mb(m.bytes), m.ctx ? `ctx ${m.ctx}` : ''].filter(Boolean).join(' · ')),
                      h('div', { style: m.tools ? S.ok : S.bad },
                        m.tools ? (m.persona ? `⚠ ${m.note}` : `✓ ${m.note}`) : `✗ ${m.note}`),
                    ),
                  );
                }),
          ),
        ));
      }

      // ── 端点 ──
      out.push(h('div', { key: 'ep', style: S.card },
        h('div', { style: S.title }, 'Ollama 端点'),
        h('div', { style: S.hint }, '留空表示自动：先读 OLLAMA_HOST 环境变量，再退回 127.0.0.1:11434。改完离开输入框即保存。'),
        h('input', {
          key: `ep-${String(cfg?.baseURL ?? '')}`, // 配置变了就重挂，保证输入框显示的是真值
          type: 'text',
          defaultValue: String(cfg?.baseURL ?? ''),
          placeholder: DEFAULT_BASE,
          disabled: busy || !writable,
          onBlur: (e) => { if (e.target.value !== String(cfg?.baseURL ?? '')) write('baseURL', e.target.value); },
          style: { ...S.input, ...(busy || !writable ? S.btOff : {}) },
        }),
      ));

      if (err) out.push(h('div', { key: 'err', style: S.alert }, err));

      out.push(h('div', { key: 'foot', style: S.hint },
        '说明：本栏目由插件 local-ollama-models v1.8.0 提供。完整说明书（用法 / 前置条件 / 验收纪律 / 排错）' +
        '在插件目录的 README.md；在「插件」页停用该 bundle 也能关闭全部功能。'));

      return h('div', { style: S.wrap }, out);
    }

    return {
      // 注意：`remote` 是按需代理，访问未声明的命名空间会直接抛错
      // ——必须像官方插件那样逐个显式声明（见 ui-settings-models 的 inject）。
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'local-ollama', order: 60, label: () => '本地模型' },
              function LocalOllamaSection() {
                return h(Boundary, null, h(Panel, { ctx }));
              },
            ),
          );
        } catch {
          /* 注册失败不抛错，避免影响设置页 */
        }
      },
    };
  },
});
