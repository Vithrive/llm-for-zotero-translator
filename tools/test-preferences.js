// 离线验证「编辑 → 设置」偏好面板与 AI 服务商选择逻辑（不需要启动 Zotero）
// 运行：node tools/test-preferences.js
//
// 覆盖：面板注册、面板初始化、切换服务商、模型/密钥写回、模型列表刷新、
//       以及服务商选择如何影响实际翻译请求（URL / 请求头 / 请求体）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'addon', 'chrome', 'content', 'scripts', 'llm-for-zotero-translator.js');
const PANE_XHTML = path.join(__dirname, '..', 'addon', 'chrome', 'content', 'preferences.xhtml');
const PLUGIN_ID = 'llm-for-zotero-translator@cszr';
const PREF_BRANCH = 'extensions.llm-for-zotero-translator.';

// 面板控件 id：既要与主脚本 PANE_FIELD 一致，也必须真实存在于 preferences.xhtml
const FIELD_IDS = {
  provider: 'lft-provider',
  providerHint: 'lft-provider-hint',
  baseUrl: 'lft-api-base',
  model: 'lft-model',
  modelList: 'lft-model-list',
  refreshModels: 'lft-refresh-models',
  modelStatus: 'lft-model-status',
  apiKey: 'lft-api-key',
  apiKeyHint: 'lft-api-key-hint',
  mineruRoot: 'lft-mineru-root',
  overwrite: 'lft-overwrite',
  skipReferences: 'lft-skip-references',
};

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || extra === undefined ? '' : '  -> ' + extra));
}

// ---------------------------------------------------------------- 最小 DOM
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.className = '';
    this.style = { setProperty() {} };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'value') this.value = String(v);
  }
  getAttribute(k) {
    return this.attributes.get(k);
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type) {
    for (const fn of (this.listeners.get(type) || []).slice()) {
      fn({ type, target: this, preventDefault() {}, stopPropagation() {} });
    }
  }
  get options() {
    return this.children;
  }
}

function makeDocument(ids) {
  const doc = { nodes: new Map() };
  doc.createElementNS = (_ns, tag) => new El(doc, tag);
  doc.getElementById = (id) => {
    if (!ids.includes(id)) return null;
    if (!doc.nodes.has(id)) doc.nodes.set(id, new El(doc, 'div'));
    return doc.nodes.get(id);
  };
  return doc;
}

// ---------------------------------------------------------------- Zotero / fetch 桩
function makeContext({ doc, prefs, fetchImpl }) {
  const registered = [];
  const store = prefs || new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch 未被桩替换'))),
    AbortController: globalThis.AbortController,
    Components: { classes: {}, interfaces: {} },
    Zotero: {
      debug: () => {},
      initializationPromise: Promise.resolve(),
      unlockPromise: Promise.resolve(),
      uiReadyPromise: Promise.resolve(),
      Prefs: {
        get: (name) => store.get(name),
        set: (name, value) => {
          store.set(name, value);
        },
      },
      ProgressWindow: function () {
        this.changeHeadline = () => {};
        this.addDescription = () => {};
        this.show = () => {};
        this.startCloseTimer = () => {};
      },
      alert: () => {},
      File: { getContentsAsync: async () => '', putContentsAsync: async () => {} },
      Items: { getAsync: async () => [] },
      Reader: { _readers: [], registerEventListener() {}, unregisterEventListener() {} },
      PreferencePanes: {
        register(options) {
          registered.push(options);
          return Promise.resolve(options.id);
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, registered, store };
}

function loadPlugin(sandbox) {
  const code = fs.readFileSync(SCRIPT, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: path.basename(SCRIPT) });
  return sandbox.LlmForZoteroTranslator;
}

function captureFetch(response) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(payload) };
}

// ---------------------------------------------------------------- 用例
(async () => {
  const paneSource = fs.readFileSync(PANE_XHTML, 'utf8');

  // 用例 1：面板注册 + 面板文件与代码里的控件 id 对齐
  {
    const doc = makeDocument(Object.values(FIELD_IDS));
    const { sandbox, registered } = makeContext({ doc, prefs: new Map() });
    const plugin = loadPlugin(sandbox);
    await plugin.hooks.onStartup();

    check('启动时注册了设置面板', registered.length === 1, 'registered=' + registered.length);
    const pane = registered[0] || {};
    check('面板 pluginID 正确', pane.pluginID === PLUGIN_ID, pane.pluginID);
    check('面板 id 正确', pane.id === 'llm-for-zotero-translator-prefpane', pane.id);
    check('面板 src 指向 chrome:// 的 preferences.xhtml',
      String(pane.src || '') === 'chrome://llm-for-zotero-translator/content/preferences.xhtml', pane.src);
    check('面板标题为插件名', pane.label === 'LLM for Zotero Translator', pane.label);
    check('面板提供了帮助链接', String(pane.helpURL || '').includes('llm-for-zotero-translator'), pane.helpURL);

    const missing = Object.values(FIELD_IDS).filter((id) => !paneSource.includes('id="' + id + '"'));
    check('preferences.xhtml 含全部控件 id', missing.length === 0, 'missing=' + missing.join(','));
    check('preferences.xhtml 的 onload 调用了 hooks.onPrefsLoad',
      /onload="[^"]*hooks\.onPrefsLoad\(/.test(paneSource));
    check('主脚本 PANE_FIELD 与测试期望一致',
      JSON.stringify(Object.values(plugin._internal.PANE_FIELD).sort()) ===
        JSON.stringify(Object.values(FIELD_IDS).sort()));

    plugin.hooks.onShutdown();
  }

  // 用例 2：服务商清单与 llm-for-zotero 的「AI 服务商」一致
  {
    const ids = pluginIds(loadPluginWithEmptyPrefs());
    const expected = ['openai', 'gemini', 'anthropic', 'minimax', 'glm', 'deepseek', 'grok', 'qwen',
      'kimi', 'mimo', 'siliconflow', 'opencode', 'ollama', 'local_openai'];
    const missing = expected.filter((id) => !ids.includes(id));
    check('服务商清单覆盖 llm-for-zotero 的全部预设', missing.length === 0, 'missing=' + missing.join(','));
    check('服务商数量合理（含自定义）', ids.length === expected.length + 1, String(ids.length));
    check('本地服务商无需 API Key',
      pluginPreset('ollama', loadPluginWithEmptyPrefs()).requiresApiKey === false &&
      pluginPreset('deepseek', loadPluginWithEmptyPrefs()).requiresApiKey !== false);
  }

  // 用例 3：面板初始化读取偏好设置
  {
    const prefs = new Map([
      [PREF_BRANCH + 'provider', 'glm'],
      [PREF_BRANCH + 'baseUrl', 'https://example.com/v1'],
      [PREF_BRANCH + 'model', 'my-model'],
      [PREF_BRANCH + 'apiKey', 'sk-test'],
      [PREF_BRANCH + 'mineruRoot', 'D:\\MinerU'],
      [PREF_BRANCH + 'overwrite', true],
      [PREF_BRANCH + 'skipReferences', false],
    ]);
    const doc = makeDocument(Object.values(FIELD_IDS));
    const { sandbox } = makeContext({ doc, prefs });
    const plugin = loadPlugin(sandbox);
    plugin.hooks.onPrefsLoad({ document: doc });

    const provider = doc.getElementById(FIELD_IDS.provider);
    check('服务商下拉已填充', provider.options.length === 15, String(provider.options.length));
    check('服务商下拉当前值来自偏好', provider.value === 'glm', provider.value);
    check('接口地址回填偏好值', doc.getElementById(FIELD_IDS.baseUrl).value === 'https://example.com/v1',
      doc.getElementById(FIELD_IDS.baseUrl).value);
    check('模型回填偏好值', doc.getElementById(FIELD_IDS.model).value === 'my-model');
    check('API Key 回填（密码框）', doc.getElementById(FIELD_IDS.apiKey).value === 'sk-test');
    check('MinerU 根目录回填', doc.getElementById(FIELD_IDS.mineruRoot).value === 'D:\\MinerU');
    check('覆盖勾选框回填', doc.getElementById(FIELD_IDS.overwrite).checked === true);
    check('跳过文献勾选框回填', doc.getElementById(FIELD_IDS.skipReferences).checked === false);
    check('模型候选来自当前服务商（GLM）', doc.getElementById(FIELD_IDS.modelList).children.length === 3);
    check('服务商提示含请求地址', /\/chat\/completions/.test(doc.getElementById(FIELD_IDS.providerHint).textContent));
  }

  // 用例 4：新用户默认值 = DeepSeek 兼容地址
  {
    const doc = makeDocument(Object.values(FIELD_IDS));
    const { sandbox } = makeContext({ doc, prefs: new Map() });
    const plugin = loadPlugin(sandbox);
    plugin.hooks.onPrefsLoad({ document: doc });
    check('新用户默认服务商 deepseek', doc.getElementById(FIELD_IDS.provider).value === 'deepseek');
    check('新用户接口地址默认 DeepSeek',
      doc.getElementById(FIELD_IDS.baseUrl).value === 'https://api.deepseek.com',
      doc.getElementById(FIELD_IDS.baseUrl).value);
  }

  // 用例 5：切换服务商 → 接口地址/模型/候选/偏好同步更新
  {
    const prefs = new Map();
    const doc = makeDocument(Object.values(FIELD_IDS));
    const { sandbox } = makeContext({ doc, prefs });
    const plugin = loadPlugin(sandbox);
    plugin.hooks.onPrefsLoad({ document: doc });

    const provider = doc.getElementById(FIELD_IDS.provider);
    provider.value = 'qwen';
    provider.dispatch('change');
    check('切换后偏好 provider=qwen', prefs.get(PREF_BRANCH + 'provider') === 'qwen', prefs.get(PREF_BRANCH + 'provider'));
    check('切换后接口地址写入偏好',
      prefs.get(PREF_BRANCH + 'baseUrl') === 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      prefs.get(PREF_BRANCH + 'baseUrl'));
    check('切换后接口地址同步到输入框',
      doc.getElementById(FIELD_IDS.baseUrl).value === 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    check('切换后模型取该服务商首选', prefs.get(PREF_BRANCH + 'model') === 'qwen3-max', prefs.get(PREF_BRANCH + 'model'));
    check('切换后模型候选已替换', doc.getElementById(FIELD_IDS.modelList).children.length === 3);

    provider.value = 'custom';
    provider.dispatch('change');
    check('切到自定义时接口地址清空', prefs.get(PREF_BRANCH + 'baseUrl') === '');
    check('自定义模式保留已有模型', prefs.get(PREF_BRANCH + 'model') === 'qwen3-max');

    provider.value = 'ollama';
    provider.dispatch('change');
    check('本地服务商提示无需 API Key',
      /不需要 API Key/.test(doc.getElementById(FIELD_IDS.apiKeyHint).textContent),
      doc.getElementById(FIELD_IDS.apiKeyHint).textContent);
  }

  // 用例 6：手改模型 / 密钥 / 勾选 → 写回偏好
  {
    const prefs = new Map();
    const doc = makeDocument(Object.values(FIELD_IDS));
    const { sandbox } = makeContext({ doc, prefs });
    const plugin = loadPlugin(sandbox);
    plugin.hooks.onPrefsLoad({ document: doc });

    const model = doc.getElementById(FIELD_IDS.model);
    model.value = 'my-custom-model';
    model.dispatch('change');
    check('自定义模型写回偏好', prefs.get(PREF_BRANCH + 'model') === 'my-custom-model');

    const apiKey = doc.getElementById(FIELD_IDS.apiKey);
    apiKey.value = 'sk-abc';
    apiKey.dispatch('change');
    check('API Key 写回偏好', prefs.get(PREF_BRANCH + 'apiKey') === 'sk-abc');

    const base = doc.getElementById(FIELD_IDS.baseUrl);
    base.value = 'http://127.0.0.1:8000/v1/';
    base.dispatch('change');
    check('手改接口地址写回偏好', prefs.get(PREF_BRANCH + 'baseUrl') === 'http://127.0.0.1:8000/v1/');

    const overwrite = doc.getElementById(FIELD_IDS.overwrite);
    overwrite.checked = true;
    overwrite.dispatch('change');
    check('覆盖选项写回偏好', prefs.get(PREF_BRANCH + 'overwrite') === true);

    const skip = doc.getElementById(FIELD_IDS.skipReferences);
    skip.checked = false;
    skip.dispatch('change');
    check('跳过文献选项写回偏好', prefs.get(PREF_BRANCH + 'skipReferences') === false);
  }

  // 用例 7：刷新模型列表（成功）
  {
    const prefs = new Map([[PREF_BRANCH + 'provider', 'deepseek'], [PREF_BRANCH + 'apiKey', 'sk-abc']]);
    const doc = makeDocument(Object.values(FIELD_IDS));
    const fetchImpl = captureFetch(jsonResponse({ data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 'm-c' }] }));
    const { sandbox } = makeContext({ doc, prefs, fetchImpl });
    const plugin = loadPlugin(sandbox);
    plugin.hooks.onPrefsLoad({ document: doc });

    doc.getElementById(FIELD_IDS.refreshModels).dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = fetchImpl.calls[0] || {};
    check('刷新请求打到 {接口地址}/models',
      call.url === 'https://api.deepseek.com/models', String(call.url));
    check('刷新请求带 Bearer 认证',
      call.options && call.options.headers && call.options.headers.Authorization === 'Bearer sk-abc');
    check('模型候选已按服务商返回填充',
      doc.getElementById(FIELD_IDS.modelList).children.map((o) => o.value).join(',') === 'm-a,m-b,m-c',
      doc.getElementById(FIELD_IDS.modelList).children.map((o) => o.value).join(','));
    check('状态提示已获取模型数量',
      /已获取 3 个模型/.test(doc.getElementById(FIELD_IDS.modelStatus).textContent),
      doc.getElementById(FIELD_IDS.modelStatus).textContent);
  }

  // 用例 8：刷新失败（HTTP 500）不抛异常，状态里给出原因
  {
    const prefs = new Map([[PREF_BRANCH + 'provider', 'deepseek']]);
    const doc = makeDocument(Object.values(FIELD_IDS));
    const fetchImpl = captureFetch({ ok: false, status: 500, text: async () => 'boom' });
    const { sandbox } = makeContext({ doc, prefs, fetchImpl });
    const plugin = loadPlugin(sandbox);
    plugin.hooks.onPrefsLoad({ document: doc });

    doc.getElementById(FIELD_IDS.refreshModels).dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('刷新失败时状态里显示 HTTP 500',
      /HTTP 500/.test(doc.getElementById(FIELD_IDS.modelStatus).textContent),
      doc.getElementById(FIELD_IDS.modelStatus).textContent);
  }

  // 用例 9：服务商选择影响实际翻译请求（URL / 头 / 体）
  {
    // DeepSeek：带 thinking 参数 + Bearer
    {
      const prefs = new Map([[PREF_BRANCH + 'provider', 'deepseek'], [PREF_BRANCH + 'apiKey', 'sk-ds'],
        [PREF_BRANCH + 'model', 'deepseek-v4-flash']]);
      const fetchImpl = captureFetch(jsonResponse({ choices: [{ message: { content: '译文' } }] }));
      const { sandbox } = makeContext({ doc: makeDocument(Object.values(FIELD_IDS)), prefs, fetchImpl });
      const plugin = loadPlugin(sandbox);
      const config = plugin._internal.getConfig();
      check('DeepSeek 配置解析正确',
        config.baseUrl === 'https://api.deepseek.com' && config.usesThinkingParam === true &&
        config.requiresApiKey === true, JSON.stringify(config.baseUrl));
      const text = await plugin._internal.requestChatCompletion(
        [{ role: 'user', content: 'hi' }], config);
      const call = fetchImpl.calls[0];
      const body = JSON.parse(call.options.body);
      check('DeepSeek 请求 URL 正确', call.url === 'https://api.deepseek.com/chat/completions', call.url);
      check('DeepSeek 请求带 thinking:disabled', body.thinking && body.thinking.type === 'disabled');
      check('DeepSeek 请求带 Authorization',
        call.options.headers.Authorization === 'Bearer sk-ds');
      check('响应解析出译文', text === '译文', text);
    }

    // OpenAI：不带 thinking 参数
    {
      const prefs = new Map([[PREF_BRANCH + 'provider', 'openai'], [PREF_BRANCH + 'apiKey', 'sk-oai'],
        [PREF_BRANCH + 'model', 'gpt-4o-mini']]);
      const fetchImpl = captureFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
      const { sandbox } = makeContext({ doc: makeDocument(Object.values(FIELD_IDS)), prefs, fetchImpl });
      const plugin = loadPlugin(sandbox);
      const config = plugin._internal.getConfig();
      check('OpenAI 配置解析正确',
        config.baseUrl === 'https://api.openai.com/v1' && config.usesThinkingParam === false);
      await plugin._internal.requestChatCompletion([{ role: 'user', content: 'hi' }], config);
      const body = JSON.parse(fetchImpl.calls[0].options.body);
      check('OpenAI 请求不带 thinking（避免不支持的参数）', body.thinking === undefined);
      check('OpenAI 请求 URL 正确',
        fetchImpl.calls[0].url === 'https://api.openai.com/v1/chat/completions',
        fetchImpl.calls[0].url);
    }

    // 本地 Ollama：无 API Key 时不发 Authorization
    {
      const prefs = new Map([[PREF_BRANCH + 'provider', 'ollama'], [PREF_BRANCH + 'model', 'qwen3']]);
      const fetchImpl = captureFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
      const { sandbox } = makeContext({ doc: makeDocument(Object.values(FIELD_IDS)), prefs, fetchImpl });
      const plugin = loadPlugin(sandbox);
      const config = plugin._internal.getConfig();
      check('Ollama 默认地址为本地 v1 兼容口', config.baseUrl === 'http://localhost:11434/v1', config.baseUrl);
      await plugin._internal.requestChatCompletion([{ role: 'user', content: 'hi' }], config);
      check('Ollama 请求不带 Authorization',
        fetchImpl.calls[0].options.headers.Authorization === undefined);
    }

    // 用户自定义接口地址优先于预设
    {
      const prefs = new Map([[PREF_BRANCH + 'provider', 'custom'],
        [PREF_BRANCH + 'baseUrl', 'http://127.0.0.1:9999/v1']]);
      const { sandbox } = makeContext({ doc: makeDocument(Object.values(FIELD_IDS)), prefs });
      const plugin = loadPlugin(sandbox);
      check('自定义接口地址优先', plugin._internal.getConfig().baseUrl === 'http://127.0.0.1:9999/v1',
        plugin._internal.getConfig().baseUrl);
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);

  // ---- 小工具 ----
  function loadPluginWithEmptyPrefs() {
    const { sandbox } = makeContext({ doc: makeDocument(Object.values(FIELD_IDS)), prefs: new Map() });
    return loadPlugin(sandbox);
  }
  function pluginIds(plugin) {
    return plugin._internal.PROVIDER_PRESETS.map((preset) => preset.id);
  }
  function pluginPreset(id, plugin) {
    return plugin._internal.getProviderPreset(id);
  }
})();
