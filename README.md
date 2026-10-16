# LLM for Zotero Translator

Zotero 7+ 插件，**llm-for-zotero** 的伴生插件：在 PDF 阅读器工具栏注入「翻译 MinerU」按钮，
一键将当前 PDF 对应的 MinerU 解析 Markdown（`V:\Zotero\llm-for-zotero-mineru\<attachmentId>\full.md`）
翻译为简体中文，输出 `<标题>.zh.md` 到同一目录。

> **改名说明**：本插件原名 *MinerU Markdown Translator*（ID `mineru-markdown-translator@cszr`）。
> 现改名为 **LLM for Zotero Translator**，ID 为 `llm-for-zotero-translator@cszr`。
> 因为插件 ID 变了，Zotero 会把它当成新插件：请先卸载旧版，再安装本版。
> 旧版遗留的偏好（`extensions.mineru-markdown-translator.*`）仍会被兜底读取，配置不会丢。

## 安装

1. 打开 Zotero → 工具 → 插件（Tools → Plugins / Add-ons）
2. 把 `llm-for-zotero-translator.xpi` 拖进窗口，或点齿轮图标 → Install Add-on From File
3. 重启 Zotero

## 更新

仓库：<https://github.com/Vithrive/llm-for-zotero-translator>

`manifest.json` 里的 `update_url` 指向本仓库 tag 为 `release` 的 Release 中的 `update.json`。
发布新版本的步骤：

```powershell
pwsh -File tools/build-xpi.ps1          # 生成 llm-for-zotero-translator.xpi 与 update.json
```

然后把这两个文件上传到 GitHub Releases（tag 用 `release`，即覆盖同一个 Release）。
Zotero 会在「工具 → 插件」里自动检查并提示更新。

## 使用

1. 先用 llm-for-zotero 插件解析过 PDF（`V:\Zotero\llm-for-zotero-mineru\<attachmentId>\full.md` 存在）
2. 在 Zotero 里打开该 PDF → 阅读器工具栏右侧出现「翻译 MinerU」按钮
   （按钮插在 Zotero 官方为插件预留的 `.custom-sections` 容器里，即工具栏右侧按钮组的
   最左侧，紧邻「外观/查找/上下文面板」按钮，位置由工具栏自身布局决定，不随窗口缩放偏移）
3. 点击按钮，按钮上会显示翻译进度（段数 / 章节）
4. 完成后在该目录生成 `<标题>.zh.md`，已有译文时默认跳过（不覆盖）

也可以在文献列表右键菜单选「翻译 MinerU Markdown 为中文」，或 工具菜单 → 翻译选中条目的 MinerU Markdown。

### 工具栏按钮实现说明

Zotero 阅读器 UI 在 iframe 内，插件不能直接改它的 DOM。正确做法是用
`Zotero.Reader.registerEventListener("renderToolbar", handler, pluginID)`：阅读器每次
挂载工具栏时都会派发该事件，回调收到 `{ reader, doc, params, append }`，在回调里
**同步**调用 `append(element)`，元素才会被放进工具栏右侧的 `.custom-sections` 里。

早期版本在阅读器文档里按一串选择器（`#toolbarViewerRight`、`header`、`.toolbar` …）
找一个容器再 `appendChild`，选错容器时就只能退回 `position: fixed; right: 88px` 的
浮动定位——这就是按钮看起来「没固定在工具栏右侧」的原因。0.2.0 起只认官方容器，
不再使用任何绝对/固定定位。

## 翻译规则（移植自 translate_zotero_markdown.py 的 remote_deepseek 档）

- 模型：默认 `deepseek-v4-flash`（DeepSeek），可在设置面板里换服务商与模型
- 只翻译英文段落（拉丁字母数 ≥ 中文字符数 × 2 才视为英文块）
- 用占位符保护以下内容不参与翻译：行内/块级公式（`$...$`、`$$...$$`、LaTeX 环境）、
  代码块、行内代码、图片引用、HTML 表格/图片/figure、Markdown 表格
- 跳过 References / Bibliography 章节
- 每个翻译段失败自动降级为 `[引擎翻译问题]` 占位，不中断整篇
- 输出文件名取自 full.md 首个一级标题

## 设置面板（编辑 → 设置 → LLM for Zotero Translator）

插件在 Zotero 的「编辑 → 设置」里注册了一个面板，用来管理翻译所用的 AI 服务商与模型：

| 控件 | 作用 |
|---|---|
| **AI 服务商** | 下拉选择。列表与 **llm-for-zotero 插件的「AI 服务商」一致**：DeepSeek / OpenAI / Gemini / Anthropic / MiniMax / GLM / Grok / Qwen / Kimi / Xiaomi MiMo / SiliconFlow / OpenCode Zen / Ollama（本地）/ Local（OpenAI 兼容），另加一个「自定义」 |
| **接口地址** | 该服务商的 OpenAI 兼容基址，切换服务商时自动填入；也可手改成任意地址（例如自建网关、反向代理） |
| **模型** | 可直接输入任意模型名；点「刷新模型列表」会请求 `{接口地址}/models`，把该服务商当前可用的模型填进候选 |
| **API Key** | 翻译用的密钥，写入 `extensions.llm-for-zotero-translator.apiKey`（Zotero 偏好为明文存储） |
| **MinerU 根目录** | MinerU 解析结果根目录 |
| **覆盖已存在的 .zh.md** / **跳过 References** | 翻译行为开关 |

关于协议：llm-for-zotero 对各服务商默认走各自的「原生」协议（Anthropic Messages / Gemini native /
Responses API），而本插件只需要一次纯文本补全，因此统一走 **OpenAI 兼容的 `/chat/completions`**，
接口地址取的是同一家服务商在 llm-for-zotero 路径清单里列出的兼容基址。这样两边选到的服务商名称与
模型完全对得上，只是底层端点不同。`thinking:{type:"disabled"}` 这类参数只会发给声明支持的
服务商（DeepSeek / GLM），不会发给 OpenAI 等不接受该参数的服务商。

其余参数（超时、重试、分段长度、max_tokens 等）仍在配置编辑器里调整。

## 配置（配置编辑器）

在 Zotero → 编辑 → 首选项 → 高级 → 配置编辑器（Config Editor）里可覆盖以下偏好
（均以 `extensions.llm-for-zotero-translator.` 为前缀；设置面板里的选项就是前几项）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | （空） | **必须自己设置**（本地服务商除外）：API Key |
| `provider` | `deepseek` | 服务商 id，见上表 |
| `baseUrl` | （空） | 留空则用所选服务商的默认接口地址；填了就优先用填的 |
| `model` | `deepseek-v4-flash` | 模型名 |
| `mineruRoot` | `V:\Zotero\llm-for-zotero-mineru` | MinerU 缓存根目录 |
| `maxSegmentChars` | `28000` | 单段最大字符数 |
| `timeout` | `180000` | 请求超时（毫秒） |
| `retryCount` | `3` | 单段重试次数 |
| `overwrite` | `false` | 已存在 .zh.md 时是否重翻 |
| `skipReferences` | `true` | 跳过参考文献章节 |
| `maxTokens` | `12000` | 单次请求 max_tokens |
| `thinkingDisabled` | `true` | 对支持的服务商关闭思维链输出 |

设置方式（配置编辑器里新建「字符串」项）：

```
extensions.llm-for-zotero-translator.apiKey   =  sk-xxxxxxxx
```

旧版前缀 `extensions.mineru-markdown-translator.*` 仍会被读取：新前缀未设置时自动回退到旧前缀。

## 文件结构

```
llm-for-zotero-translator/
├── addon/                          # 插件源文件（改动后重新打包即可）
│   ├── manifest.json
│   ├── bootstrap.js
│   └── chrome/content/
│       ├── preferences.xhtml       # 「编辑 → 设置」面板（XUL 片段 + html: 控件）
│       ├── icons/icon.png
│       └── scripts/
│           └── llm-for-zotero-translator.js
├── tools/
│   ├── build-xpi.ps1               # 打 .xpi + 生成 update.json
│   ├── test-reader-button.js       # 离线验证按钮挂载位置
│   └── test-preferences.js         # 离线验证设置面板与服务商选择逻辑
├── llm-for-zotero-translator.xpi   # 可直接安装的插件包
└── README.md
```

## 打包

```powershell
pwsh -File tools/build-xpi.ps1
```

要求：zip 格式、manifest.json 必须在压缩包根目录（不要出现 `addon/` 这一层）。
脚本用 `System.IO.Compression` 按 `addon/` 的相对路径写入条目并固定时间戳，
同时按 `manifest.json` 里的 `id`/`version`/`homepage_url` 生成 `update.json`。

## 自检

```powershell
node tools/test-reader-button.js   # 工具栏按钮挂载/清理
node tools/test-preferences.js     # 设置面板、服务商切换、请求 URL/头/体
```

`test-reader-button.js` 用最小 DOM 桩复刻 `.toolbar > .end > .custom-sections > .section` 结构和
`renderToolbar` 事件派发，检查按钮是否落在官方右侧容器、是否残留 `position: fixed`、
重复渲染是否会产生重复按钮、卸载是否清理干净。

`test-preferences.js` 用最小 DOM + `Zotero.Prefs` + `fetch` 桩，检查面板注册、面板初始值、
切换服务商后接口地址与模型是否同步、模型列表刷新、以及服务商选择对实际请求
（`{接口地址}/chat/completions`、`Authorization`、`thinking` 参数）的影响。

两个脚本都不需要启动 Zotero。
