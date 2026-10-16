// 离线验证「翻译 MinerU」按钮的挂载位置（不需要启动 Zotero）
// 运行：node tools/test-reader-button.js
//
// 用最小 DOM/Reader 桩复刻 Zotero 阅读器工具栏结构：
//   .toolbar > .end > .custom-sections > .section > button(...)
// 以及 Zotero.Reader.registerEventListener("renderToolbar", …) 的派发行为。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'addon', 'chrome', 'content', 'scripts', 'llm-for-zotero-translator.js');
let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || extra === undefined ? '' : '  -> ' + extra));
}

// ---------------------------------------------------------------- 最小 DOM
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = { setProperty() {} };
    this.textContent = '';
    this.listeners = new Map();
    this.className = '';
    this.classList = {
      add: (...cs) => {
        this.className = [this.className, ...cs].filter(Boolean).join(' ');
      },
      remove: (...cs) => {
        this.className = this.className
          .split(/\s+/)
          .filter((c) => c && !cs.includes(c))
          .join(' ');
      },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  get id() {
    return this.attributes.get('id') || '';
  }
  set id(v) {
    this.attributes.set('id', v);
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
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
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get firstChild() {
    return this.children[0] || null;
  }
  replaceChildren(...nodes) {
    for (const c of this.children.slice()) c.parentNode = null;
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
  matches(sel) {
    return sel.startsWith('.') && this.classList.contains(sel.slice(1));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    // 只支持 ".a .b" 形式的 class 后代选择器
    const parts = String(sel).trim().split(/\s+/).map((p) => p.replace(/^\./, ''));
    const out = [];
    const visit = (node, idx) => {
      for (const child of node.children) {
        if (child.classList.contains(parts[idx])) {
          if (idx === parts.length - 1) out.push(child);
          else visit(child, idx + 1);
        } else {
          visit(child, idx);
        }
      }
    };
    visit(this, 0);
    return out;
  }
}

function makeReaderDocument(withToolbar) {
  const doc = new El('#document', null);
  doc.ownerDocument = doc;
  const head = new El('head', doc);
  const body = new El('body', doc);
  doc.appendChild(head);
  doc.appendChild(body);
  doc.head = head;
  doc.body = body;
  doc.createElement = (tag) => new El(tag, doc);
  doc.getElementById = (id) => {
    let found = null;
    const visit = (n) => {
      if (found) return;
      if (n.attributes.get('id') === id) found = n;
      for (const c of n.children) visit(c);
    };
    visit(doc);
    return found;
  };
  if (withToolbar) {
    const toolbar = new El('div', doc);
    toolbar.className = 'toolbar';
    const end = new El('div', doc);
    end.className = 'end';
    const sections = new El('div', doc);
    sections.className = 'custom-sections';
    end.appendChild(sections);
    const appearance = new El('button', doc);
    appearance.className = 'toolbar-button';
    appearance.id = 'appearance';
    end.appendChild(appearance);
    toolbar.appendChild(end);
    body.appendChild(toolbar);
    doc.builtinToolbarNodes = { toolbar, end, sections, appearance };
  }
  return doc;
}

// ---------------------------------------------------------------- Zotero 桩
function makeContext(readerDoc, reader) {
  const listeners = [];
  const customSections = readerDoc && readerDoc.querySelectorAll('.toolbar .end .custom-sections')[0];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Components: { classes: {}, interfaces: {} },
    Zotero: {
      debug: () => {},
      initializationPromise: Promise.resolve(),
      unlockPromise: Promise.resolve(),
      uiReadyPromise: Promise.resolve(),
      Prefs: { get: () => undefined },
      ProgressWindow: function () {
        this.changeHeadline = () => {};
        this.addDescription = () => {};
        this.show = () => {};
        this.startCloseTimer = () => {};
      },
      alert: () => {},
      File: { getContentsAsync: async () => '', putContentsAsync: async () => {} },
      Items: { getAsync: async () => [] },
      Reader: {
        _readers: [reader],
        registerEventListener(type, handler, pluginID) {
          listeners.push({ type, handler, pluginID });
        },
        unregisterEventListener(type, handler) {
          const i = listeners.findIndex((l) => l.type === type && l.handler === handler);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  const dispatchers = {
    fireRenderToolbar() {
      // 复刻 Zotero CustomSections：把 append 收到的节点塞进 .custom-sections
      const append = (...nodes) => {
        for (const n of nodes) customSections.appendChild(n);
      };
      for (const l of listeners.filter((l) => l.type === 'renderToolbar')) {
        l.handler({ reader, doc: readerDoc, params: {}, append });
      }
    },
    // 模拟 React 重新挂载工具栏：清空 .custom-sections 后再派发一次事件
    remountToolbar() {
      customSections.replaceChildren();
      dispatchers.fireRenderToolbar();
    },
    listeners,
  };
  return { sandbox, dispatchers };
}

function loadPlugin(sandbox) {
  const code = fs.readFileSync(SCRIPT, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: path.basename(SCRIPT) });
  return sandbox.LlmForZoteroTranslator;
}

// ---------------------------------------------------------------- 用例
(async () => {
  // 用例 1：renderToolbar 事件 -> 按钮落在官方右侧容器里
  {
    const readerDoc = makeReaderDocument(true);
    const reader = { _iframeWindow: { document: readerDoc } };
    const { sandbox, dispatchers } = makeContext(readerDoc, reader);
    const plugin = loadPlugin(sandbox);
    await plugin.hooks.onStartup();

    check('注册了 renderToolbar 监听（pluginID 正确）',
      dispatchers.listeners.length === 1 &&
      dispatchers.listeners[0].type === 'renderToolbar' &&
      dispatchers.listeners[0].pluginID === 'llm-for-zotero-translator@cszr',
      JSON.stringify(dispatchers.listeners.map((l) => [l.type, l.pluginID])));

    dispatchers.fireRenderToolbar();
    const btn = readerDoc.getElementById('llm-for-zotero-translator-reader-button');
    check('renderToolbar 后按钮已挂载', !!btn);
    const sections = readerDoc.builtinToolbarNodes.sections;
    check('按钮位于 .toolbar .end .custom-sections > .section 内',
      !!btn && btn.parentNode && btn.parentNode.classList.contains('section') &&
      btn.parentNode.parentNode === sections,
      btn && btn.parentNode && btn.parentNode.className);
    check('按钮在工具栏右侧分组 .end 里（与 Zotero 自带按钮同组）',
      readerDoc.builtinToolbarNodes.end.querySelectorAll('.section').some((s) => s.children.includes(btn)));
    check('插在自带按钮之前，没有被挤到工具栏外', sections.children[0] === btn.parentNode);
    check('按钮文案正确', btn && btn.textContent === '翻译 MinerU', btn && btn.textContent);
    check('注入了阅读器样式，且不含任何 fixed/absolute 定位',
      !!readerDoc.getElementById('llm-for-zotero-translator-reader-style') &&
      !/position\s*:\s*(fixed|absolute)/.test(
        readerDoc.getElementById('llm-for-zotero-translator-reader-style').textContent));
    check('重复派发事件不会产生第二个按钮',
      (dispatchers.fireRenderToolbar(), readerDoc.querySelectorAll('.section').length === 1));
    check('按钮宽度受控（工具栏空间有限，带省略号）', (() => {
      const css = readerDoc.getElementById('llm-for-zotero-translator-reader-style').textContent;
      return /max-width:\s*150px/.test(css) && /text-overflow:\s*ellipsis/.test(css) &&
        /white-space:\s*nowrap/.test(css);
    })());

    // 关键回归：React 重新挂载工具栏会清空 .custom-sections，按钮必须自动补回来
    dispatchers.remountToolbar();
    const after = readerDoc.getElementById('llm-for-zotero-translator-reader-button');
    check('工具栏重新挂载后按钮自动补回（不会消失）',
      !!after && !!after.parentNode && after.parentNode.classList.contains('section') &&
      after.parentNode.parentNode === sections && sections.children.length === 1,
      after ? 'sections.children=' + sections.children.length : 'button missing');

    const clickHandlers = after.listeners.get('click') || [];
    check('按钮注册了点击回调', clickHandlers.length === 1, String(clickHandlers.length));
    for (const fn of clickHandlers) {
      await fn({ preventDefault() {}, stopPropagation() {} });
    }
    check('点击回调可执行', true);

    plugin.hooks.onShutdown();
    check('卸载后按钮与样式被清理',
      !readerDoc.getElementById('llm-for-zotero-translator-reader-button') &&
      !readerDoc.getElementById('llm-for-zotero-translator-reader-style'));
    check('卸载后监听被注销', dispatchers.listeners.length === 0);
  }

  // 用例 2：轮询兜底——工具栏已渲染但事件错过时也能挂上
  {
    const readerDoc = makeReaderDocument(true);
    const reader = { _iframeWindow: { document: readerDoc } };
    const { sandbox } = makeContext(readerDoc, reader);
    const plugin = loadPlugin(sandbox);
    await plugin.hooks.onStartup();
    const btn = readerDoc.getElementById('llm-for-zotero-translator-reader-button');
    check('轮询兜底：按钮挂进 .custom-sections > .section',
      !!btn && !!btn.parentNode && btn.parentNode.classList.contains('section') &&
      btn.parentNode.parentNode === readerDoc.builtinToolbarNodes.sections);
    plugin.hooks.onShutdown();
  }

  // 用例 3：工具栏还没渲染时绝不乱挂（旧版会退回 body + position:fixed）
  {
    const readerDoc = makeReaderDocument(false);
    const reader = { _iframeWindow: { document: readerDoc } };
    const { sandbox } = makeContext(readerDoc, reader);
    const plugin = loadPlugin(sandbox);
    await plugin.hooks.onStartup();
    check('找不到官方容器时不挂到 body（避免位置偏移）',
      !readerDoc.getElementById('llm-for-zotero-translator-reader-button') &&
      readerDoc.body.children.every((c) => !(c.id === 'llm-for-zotero-translator-reader-button')));
    plugin.hooks.onShutdown();
  }

  // 用例 4：生命周期钩子完整
  {
    const readerDoc = makeReaderDocument(true);
    const reader = { _iframeWindow: { document: readerDoc } };
    const { sandbox } = makeContext(readerDoc, reader);
    const plugin = loadPlugin(sandbox);
    check('暴露的生命周期钩子完整',
      ['onStartup', 'onMainWindowLoad', 'onMainWindowUnload', 'onShutdown'].every((k) => typeof plugin.hooks[k] === 'function'));
  }

  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})();
