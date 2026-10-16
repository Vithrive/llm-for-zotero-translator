// LLM for Zotero Translator（llm-for-zotero 伴生插件：把 MinerU 解析出的 Markdown 译成简体中文）
// 在 Zotero PDF 阅读器中注入“翻译 MinerU”按钮：
// 定位当前 PDF 附件对应的 V:\Zotero\llm-for-zotero-mineru\<attachmentId>\full.md，
// 用 DeepSeek（deepseek-v4-flash，OpenAI 兼容接口）把英文段落翻译为简体中文，
// 输出 <标题>.zh.md 到同一目录。公式/代码/图片/表格用占位符保护，不参与翻译。

var LlmForZoteroTranslator = (() => {
  "use strict";

  const PLUGIN_NAME = "LLM for Zotero Translator";
  const PREF_BRANCH = "extensions.llm-for-zotero-translator.";
  // 旧插件名（MinerU Markdown Translator）下的偏好分支：仅作兜底读取，
  // 保证改名后旧版本已配置的 API Key / 路径等设置不会丢失。
  const LEGACY_PREF_BRANCH = "extensions.mineru-markdown-translator.";
  const READER_BUTTON_ID = "llm-for-zotero-translator-reader-button";
  const READER_STYLE_ID = "llm-for-zotero-translator-reader-style";
  const ITEM_MENU_ID = "llm-for-zotero-translator-item-menu";
  const TOOLS_MENU_ID = "llm-for-zotero-translator-tools-menu";
  const BUTTON_LABEL = "翻译 MinerU";
  const PLUGIN_ID = "llm-for-zotero-translator@cszr";
  const RENDER_TOOLBAR_PROBE_TIMEOUT = 25000;

  // 内置配置（对应 translate_zotero_markdown.py 的 remote_deepseek 档，
  // 可在 Zotero 偏好设置 extensions.llm-for-zotero-translator.* 中覆盖）
  const DEFAULTS = {
    mineruRoot: "V:\\Zotero\\llm-for-zotero-mineru", // parser_root
    // 安全：不再内置 API Key。首次使用请到 Zotero → 编辑 → 首选项 → 高级 → 配置编辑器设置
    // extensions.llm-for-zotero-translator.apiKey，否则点击翻译会提示缺少 API Key。
    apiKey: "", // remote_deepseek.api_key
    baseUrl: "https://api.deepseek.com", // remote_deepseek.base_url
    model: "deepseek-v4-flash", // remote_deepseek.model
    maxSegmentChars: 28000, // remote_deepseek.max_segment_chars
    timeout: 180000, // remote_deepseek.timeout = 180s
    retryCount: 3, // remote_deepseek.retry_count
    overwrite: false, // 已存在 .zh.md 时是否重翻
    skipReferences: true, // 跳过 References 章节
    thinkingDisabled: true, // extra_body.thinking.type = "disabled"
    maxTokens: 12000, // extra_body.max_tokens
  };

  const state = {
    windows: new Map(),
    intervalID: null,
    busyKeys: new Set(),
  };

  // ---------------------------------------------------------------------------
  // 日志 / 提示 / 偏好
  // ---------------------------------------------------------------------------

  function log(message, error) {
    if (error) {
      Zotero.debug("[LLM for Zotero Translator] " + message + " :: " + error);
      return;
    }
    Zotero.debug("[LLM for Zotero Translator] " + message);
  }

  function notify(title, lines) {
    const messages = Array.isArray(lines) ? lines : [lines];
    try {
      const progress = new Zotero.ProgressWindow();
      progress.changeHeadline(title);
      for (const line of messages) {
        progress.addDescription(String(line));
      }
      progress.show();
      progress.startCloseTimer(6000);
      return;
    } catch (error) {
      log("ProgressWindow 不可用", error);
    }
    try {
      Zotero.alert(null, title, messages.join("\n"));
    } catch (error) {
      log("Zotero.alert 不可用", error);
    }
  }

  function getPref(name, fallbackValue) {
    // 先读新分支；读不到再回退到旧分支（LEGACY_PREF_BRANCH），避免改名丢配置。
    for (const branch of [PREF_BRANCH, LEGACY_PREF_BRANCH]) {
      try {
        const value = Zotero.Prefs.get(branch + name, true);
        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      } catch (_error) {}
    }
    return fallbackValue;
  }

  function getConfig() {
    return {
      mineruRoot: String(getPref("mineruRoot", DEFAULTS.mineruRoot)),
      apiKey: String(getPref("apiKey", DEFAULTS.apiKey)),
      baseUrl: String(getPref("baseUrl", DEFAULTS.baseUrl)).replace(/\/+$/, ""),
      model: String(getPref("model", DEFAULTS.model)),
      maxSegmentChars: Number(getPref("maxSegmentChars", DEFAULTS.maxSegmentChars)) || DEFAULTS.maxSegmentChars,
      timeout: Number(getPref("timeout", DEFAULTS.timeout)) || DEFAULTS.timeout,
      retryCount: Number(getPref("retryCount", DEFAULTS.retryCount)) || DEFAULTS.retryCount,
      overwrite: !!getPref("overwrite", DEFAULTS.overwrite),
      skipReferences: !!getPref("skipReferences", DEFAULTS.skipReferences),
      thinkingDisabled: !!getPref("thinkingDisabled", DEFAULTS.thinkingDisabled),
      maxTokens: Number(getPref("maxTokens", DEFAULTS.maxTokens)) || DEFAULTS.maxTokens,
    };
  }

  // ---------------------------------------------------------------------------
  // 文件系统
  // ---------------------------------------------------------------------------

  function joinPath(basePath, childName) {
    return String(basePath || "").replace(/[\\/]+$/, "") + "\\" + String(childName || "");
  }

  async function readTextFile(path) {
    return String(await Zotero.File.getContentsAsync(path));
  }

  async function writeTextFile(path, text) {
    await Zotero.File.putContentsAsync(path, text);
  }

  // ---------------------------------------------------------------------------
  // 翻译核心：占位符保护 + 分块（移植自 translate_zotero_markdown.py）
  // ---------------------------------------------------------------------------

  const CODE_BLOCK_RE = /```[\s\S]*?```/g;
  const INLINE_CODE_RE = /`[^`\n]+`/g;
  const BLOCK_MATH_RE = /\$\$[\s\S]*?\$\$/g;
  const INLINE_MATH_RE = /\$[^\$\n][^\n]*?\$|\$[^\$\n]\$/g;
  const LATEX_ENV_RE = /\\begin\{(?:equation\*?|align\*?|aligned|gather\*?|multline\*?|cases|array|matrix|bmatrix|pmatrix|vmatrix|Vmatrix|smallmatrix)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|aligned|gather\*?|multline\*?|cases|array|matrix|bmatrix|pmatrix|vmatrix|Vmatrix|smallmatrix)\}/g;
  const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
  const HTML_FIGURE_RE = /<figure\b[^>]*?>[\s\S]*?<\/figure>/gi;
  const HTML_TABLE_RE = /<table\b[^>]*?>[\s\S]*?<\/table>/gi;
  const HTML_IMAGE_RE = /<img\b[^>]*?>/gi;
  const MD_TABLE_RE = /^(?:\|.*\|[ \t]*\r?\n?){2,}/gm;
  const PLACEHOLDER_RE = /__(?:CODE|INLINECODE|BLOCKMATH|MATHENV|MATH|IMAGE|HTMLIMAGE|FIGURE|TABLE)_\d{4}__/;

  function replaceWithPlaceholders(content, pattern, bucket, prefix) {
    let index = 0;
    return String(content).replace(pattern, (match) => {
      const key = "__" + prefix + "_" + String(index).padStart(4, "0") + "__";
      bucket[key] = match;
      index += 1;
      return key;
    });
  }

  function protectSpecialContent(content) {
    const bucket = {};
    let text = String(content || "");
    text = replaceWithPlaceholders(text, CODE_BLOCK_RE, bucket, "CODE");
    text = replaceWithPlaceholders(text, INLINE_CODE_RE, bucket, "INLINECODE");
    text = replaceWithPlaceholders(text, BLOCK_MATH_RE, bucket, "BLOCKMATH");
    text = replaceWithPlaceholders(text, INLINE_MATH_RE, bucket, "MATH");
    text = replaceWithPlaceholders(text, LATEX_ENV_RE, bucket, "MATHENV");
    text = replaceWithPlaceholders(text, HTML_FIGURE_RE, bucket, "FIGURE");
    text = replaceWithPlaceholders(text, HTML_TABLE_RE, bucket, "TABLE");
    text = replaceWithPlaceholders(text, MD_TABLE_RE, bucket, "TABLE");
    text = replaceWithPlaceholders(text, IMAGE_RE, bucket, "IMAGE");
    text = replaceWithPlaceholders(text, HTML_IMAGE_RE, bucket, "HTMLIMAGE");
    return { text, bucket };
  }

  function restoreSpecialContent(content, bucket) {
    let restored = String(content || "");
    // 让模型拼接到文字两侧的块级占位符单独成行
    const blockKeys = Object.keys(bucket).filter((key) => {
      const value = bucket[key];
      return /^(?:__BLOCKMATH_|__TABLE_|__FIGURE_|__HTMLIMAGE_)/.test(key) || String(value).trim().startsWith("$$");
    });
    if (blockKeys.length) {
      const pattern = "(?:" + blockKeys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
      restored = restored.replace(new RegExp("([^\\r\\n])(" + pattern + ")", "g"), "$1\n$2");
      restored = restored.replace(new RegExp("(" + pattern + ")([^\\r\\n])", "g"), "$1\n$2");
    }
    for (const [key, value] of Object.entries(bucket)) {
      restored = restored.split(key).join(value);
    }
    return restored;
  }

  function isEnglish(text) {
    const sample = String(text || "").trim();
    if (!sample) {
      return false;
    }
    const chinese = (sample.match(/[一-鿿]/g) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    return latin > 0 && latin >= chinese * 2;
  }

  function splitTextForTranslation(text, maxChars) {
    if (text.length <= maxChars) {
      return [text];
    }
    const chunks = [];
    let current = "";
    for (const line of text.split(/(?<=\n)/)) {
      if (line.length > maxChars) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        for (let i = 0; i < line.length; i += maxChars) {
          chunks.push(line.slice(i, i + maxChars));
        }
        continue;
      }
      if (current && current.length + line.length > maxChars) {
        chunks.push(current);
        current = line;
      } else {
        current += line;
      }
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  }

  function splitMarkdownTextBlocks(part, maxChars) {
    const blocks = [];
    let currentLines = [];
    const flush = () => {
      if (!currentLines.length) {
        return;
      }
      const text = currentLines.join("");
      for (const chunk of splitTextForTranslation(text, maxChars)) {
        blocks.push({ kind: "text", content: chunk, role: "body" });
      }
      currentLines = [];
    };

    for (const line of part.split(/(?<=\n)/)) {
      if (/^\s{0,3}#{1,6}\s+/.test(line)) {
        flush();
        blocks.push({ kind: "text", content: line, role: "heading" });
        continue;
      }
      if (/^\s*__BLOCKMATH_\d{4}__\s*$/.test(line)) {
        flush();
        blocks.push({ kind: "blockmath", content: line, role: "body" });
        continue;
      }
      currentLines.push(line);
    }
    flush();
    if (!blocks.length && part) {
      for (const chunk of splitTextForTranslation(part, maxChars)) {
        blocks.push({ kind: "text", content: chunk, role: "body" });
      }
    }
    return blocks;
  }

  const FILLER_ONLY_RE = new RegExp(
    "^(?:__(?:CODE|INLINECODE|BLOCKMATH|MATHENV|MATH|IMAGE|HTMLIMAGE|FIGURE|TABLE)_\\d{4}__" +
    "|[#>*\\-+0-9.\\[\\](){}\n:;,!?\"'\\u201C\\u201D\\u3001\\u3002\\uFF0C\\uFF1B\\uFF1A\\uFF01\\uFF1F]|\\s)+$"
  );

  function shouldTranslateBlock(text) {
    const stripped = String(text || "").trim();
    if (!stripped) {
      return false;
    }
    if (FILLER_ONLY_RE.test(stripped)) {
      return false;
    }
    if (PLACEHOLDER_RE.test(stripped)) {
      const visible = stripped.replace(new RegExp(PLACEHOLDER_RE.source, "g"), "");
      if (!visible.trim()) {
        return false;
      }
    }
    if (/^\[[0-9]+\]\s+/.test(stripped)) {
      return false;
    }
    return isEnglish(stripped);
  }

  function splitBlocksByParagraph(content, maxChars) {
    const blocks = [];
    for (const part of String(content).split(/(\n\s*\n)/)) {
      if (!part) {
        continue;
      }
      if (/^\n\s*\n$/.test(part)) {
        blocks.push({ kind: "passthrough", content: part, role: "separator" });
        continue;
      }
      for (const block of splitMarkdownTextBlocks(part, maxChars)) {
        if (block.kind === "blockmath") {
          blocks.push({ kind: "passthrough", content: block.content, role: "body" });
          continue;
        }
        blocks.push({
          kind: shouldTranslateBlock(block.content) ? "translate" : "passthrough",
          content: block.content,
          role: block.role || "body",
        });
      }
    }
    return blocks;
  }

  const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;

  function splitSections(content) {
    const matches = [];
    let match;
    HEADING_RE.lastIndex = 0;
    while ((match = HEADING_RE.exec(content)) !== null) {
      matches.push({ index: match.index, level: match[1].length, heading: match[2].trim() });
    }
    if (!matches.length) {
      return [{ heading: "Document", content }];
    }
    const sections = [];
    if (matches[0].index > 0) {
      const preface = content.slice(0, matches[0].index);
      if (preface.trim()) {
        sections.push({ heading: "Front Matter", content: preface });
      }
    }
    const stack = [];
    for (let i = 0; i < matches.length; i += 1) {
      const item = matches[i];
      while (stack.length >= item.level) {
        stack.pop();
      }
      stack.push(item.heading);
      const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
      sections.push({
        heading: stack.join(" > "),
        content: content.slice(item.index, end),
      });
    }
    return sections;
  }

  function isReferenceSection(section) {
    const text = String(section.heading || "").trim().toLowerCase();
    if (!text) {
      return false;
    }
    const lastPart = text.split(">").pop().trim().replace(/^[0-9.\s]+/, "");
    return lastPart === "references" || lastPart === "reference" || lastPart === "bibliography";
  }

  function enforceHeadingLineBreaks(text) {
    if (!text || text.indexOf("#") === -1) {
      return text;
    }
    let normalized = String(text).replace(/(?<!\n)(\s*)(#{1,6}\s+)/g, "\n$2");
    normalized = normalized.replace(/(^|\n)(#{1,6}\s+[^\n]+)(?!\n)/g, "$1$2\n");
    return normalized;
  }

  function normalizeBlockBoundary(text, role, prevText, prevRole) {
    let normalized = enforceHeadingLineBreaks(text || "");
    if (!normalized) {
      return normalized;
    }
    if (role === "heading" && prevText && !/\r?\n$/.test(prevText)) {
      normalized = "\n" + normalized.replace(/^[\r\n]+/, "");
    }
    if (prevRole === "heading" && prevText && !/\r?\n$/.test(prevText) && !/^[\r\n]/.test(normalized)) {
      normalized = "\n" + normalized;
    }
    return normalized;
  }

  function stripThinkingOutput(text) {
    return String(text || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .trim();
  }

  const TRANSLATION_ERROR_MARKER = "[引擎翻译问题]";

  function buildFailedTranslationText(text) {
    const stripped = String(text || "").trim();
    if (!stripped) {
      return TRANSLATION_ERROR_MARKER;
    }
    const heading = stripped.match(/^(#{1,6}\s+)(.*)$/);
    if (heading) {
      return heading[1] + TRANSLATION_ERROR_MARKER;
    }
    const list = String(text).match(/^(\s*[-*+]\s+)/);
    if (list) {
      return list[1] + TRANSLATION_ERROR_MARKER;
    }
    const ordered = String(text).match(/^(\s*\d+[.)]\s+)/);
    if (ordered) {
      return ordered[1] + TRANSLATION_ERROR_MARKER;
    }
    return TRANSLATION_ERROR_MARKER;
  }

  // ---------------------------------------------------------------------------
  // DeepSeek API（OpenAI 兼容 /chat/completions）
  // ---------------------------------------------------------------------------

  function fetchWithTimeout(url, options, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("请求超时（" + Math.round(timeoutMs / 1000) + "s）：" + url));
      }, timeoutMs);
      fetch(url, options).then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function maskApiKey(apiKey) {
    const key = String(apiKey || "");
    if (key.length <= 10) {
      return key.slice(0, 2) + "***";
    }
    return key.slice(0, 6) + "***" + key.slice(-4);
  }

  async function requestChatCompletion(messages, config) {
    const url = config.baseUrl + "/chat/completions";
    const body = {
      model: config.model,
      temperature: 0.1,
      messages,
      stream: false,
      max_tokens: config.maxTokens,
    };
    if (config.thinkingDisabled) {
      body.thinking = { type: "disabled" };
    }

    let lastError = null;
    for (let attempt = 0; attempt < config.retryCount; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: "Bearer " + config.apiKey,
            },
            body: JSON.stringify(body),
          },
          config.timeout,
        );

        const rawText = await response.text();
        if (!response.ok) {
          let detail = rawText || "";
          try {
            const payload = JSON.parse(rawText);
            detail = payload.error?.message || payload.message || rawText;
          } catch (_error) {}
          throw new Error(
            "HTTP " + response.status + ": " + detail +
              "\nModel: " + config.model +
              "\nAPI Key: " + maskApiKey(config.apiKey),
          );
        }

        let payload;
        try {
          payload = JSON.parse(rawText);
        } catch (_error) {
          throw new Error("响应不是合法 JSON：" + rawText.slice(0, 200));
        }
        const message = payload.choices?.[0]?.message;
        let content = message?.content;
        if (Array.isArray(content)) {
          content = content
            .map((item) => (typeof item === "string" ? item : item?.text || ""))
            .join("");
        }
        const text = stripThinkingOutput(String(content || ""));
        if (!text) {
          throw new Error("空响应：" + rawText.slice(0, 300));
        }
        return text;
      } catch (error) {
        lastError = error;
        log("翻译请求失败（第 " + (attempt + 1) + " 次）", error);
      }
    }
    throw lastError || new Error("翻译请求失败");
  }

  const SYSTEM_PROMPT =
    "翻译英文 markdown 为简体中文，只输出最终译文。禁止解释、分析、推理、思维过程和<think>内容。";

  function buildTranslationPrompt(text) {
    return (
      "翻译如下英文 markdown 为简体中文。" +
      "只输出最终译文，不要解释，不要展示思维过程，不要输出任何分析、推理、<think>或<thinking>内容，" +
      "并保持 markdown 结构与占位符不变：\n\n" +
      text
    );
  }

  async function translateSegment(text, config, cache) {
    if (cache.has(text)) {
      return cache.get(text);
    }
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildTranslationPrompt(text) },
    ];
    let translated = null;
    try {
      translated = await requestChatCompletion(messages, config);
    } catch (error) {
      log("分段翻译失败，使用占位译文", error);
      translated = buildFailedTranslationText(text);
    }
    if (!translated || !translated.trim()) {
      translated = buildFailedTranslationText(text);
    }
    cache.set(text, translated);
    return translated;
  }

  // ---------------------------------------------------------------------------
  // 整篇翻译编排
  // ---------------------------------------------------------------------------

  function extractTitle(content) {
    const match = String(content).match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : "Untitled_Paper";
  }

  function sanitizeFilename(title) {
    const sanitized = String(title)
      .replace(new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]+', "g"), "_")
      .trim();
    return sanitized.slice(0, 150) || "Untitled_Paper";
  }

  async function translateMarkdown(content, config, onProgress) {
    if (!isEnglish(content)) {
      return { text: content, translatedSegments: 0, skipped: true };
    }
    const { text: protectedText, bucket } = protectSpecialContent(content);
    const sections = splitSections(protectedText);
    const cache = new Map();
    const outputParts = [];
    let translatedSegments = 0;
    let lastRole = null;

    for (let s = 0; s < sections.length; s += 1) {
      const section = sections[s];
      let sectionOutput;
      if (config.skipReferences && isReferenceSection(section)) {
        sectionOutput = section.content;
      } else {
        const blocks = splitBlocksByParagraph(section.content, config.maxSegmentChars);
        const parts = [];
        let prevText = "";
        let prevRole = null;
        for (const block of blocks) {
          let out;
          if (block.kind === "translate") {
            out = await translateSegment(block.content, config, cache);
            translatedSegments += 1;
            if (onProgress) {
              onProgress(translatedSegments, s + 1, sections.length);
            }
          } else {
            out = block.content;
          }
          out = normalizeBlockBoundary(out, block.role, prevText, prevRole);
          parts.push(out);
          prevText = out;
          prevRole = block.role;
        }
        sectionOutput = parts.join("");
      }
      outputParts.push(restoreSpecialContent(sectionOutput, bucket));
      lastRole = null;
    }
    return { text: outputParts.join(""), translatedSegments, skipped: false };
  }

  // ---------------------------------------------------------------------------
  // Zotero 条目 / 阅读器集成
  // ---------------------------------------------------------------------------

  function isPDFAttachment(item) {
    if (!item) {
      return false;
    }
    try {
      if (typeof item.isPDFAttachment === "function" && item.isPDFAttachment()) {
        return true;
      }
    } catch (_error) {}
    const contentType = String(item.attachmentContentType || "").toLowerCase();
    const filename = String(item.attachmentFilename || "").toLowerCase();
    return contentType === "application/pdf" || filename.endsWith(".pdf");
  }

  async function getPDFAttachmentsFromItem(item) {
    if (!item) {
      return [];
    }
    if (typeof item.isAttachment === "function" && item.isAttachment()) {
      return isPDFAttachment(item) ? [item] : [];
    }
    if (!(typeof item.isRegularItem === "function" && item.isRegularItem())) {
      return [];
    }
    const attachmentIDs = typeof item.getAttachments === "function" ? item.getAttachments() : [];
    if (!attachmentIDs.length) {
      return [];
    }
    const attachments = await Zotero.Items.getAsync(attachmentIDs);
    return attachments.filter((attachment) => isPDFAttachment(attachment));
  }

  async function getReaderItem(reader) {
    if (!reader) {
      return null;
    }
    if (reader.item) {
      return reader.item;
    }
    if (reader._item) {
      return reader._item;
    }
    if (reader._itemID) {
      try {
        return await Zotero.Items.getAsync(reader._itemID);
      } catch (error) {
        log("读取阅读器条目失败", error);
      }
    }
    return null;
  }

  async function translateAttachment(attachment, config, onProgress) {
    const workdir = joinPath(config.mineruRoot, String(attachment.id));
    const mdPath = joinPath(workdir, "full.md");
    log("检查 MinerU 文件: " + mdPath + " (附件ID=" + attachment.id + ")");
    if (!fileExists(mdPath)) {
      throw new Error(
        "未找到 MinerU 解析文件：\n" + mdPath +
        "\n请确认：1) llm-for-zotero 已解析过该 PDF；2) 缓存目录名就是附件ID " + attachment.id + "。"
      );
    }
    const content = await readTextFile(mdPath);
    if (!isEnglish(content)) {
      return { status: "skipped", reason: "内容不是英文", dir: workdir };
    }
    const title = extractTitle(content);
    const outputPath = joinPath(workdir, sanitizeFilename(title) + ".zh.md");
    if (!config.overwrite && fileExists(outputPath)) {
      return { status: "exists", reason: "译文已存在", output: outputPath, dir: workdir };
    }

    await writeTextFile(outputPath, ""); // 先建空文件，异常时也能看到进度
    const result = await translateMarkdown(content, config, onProgress);
    await writeTextFile(outputPath, result.text);
    return {
      status: "done",
      title,
      output: outputPath,
      dir: workdir,
      translatedSegments: result.translatedSegments,
    };
  }

  // 用 nsIFile 同步检测文件是否存在（与参考插件 llm-for-zotero-sync 一致，最可靠）
  function fileExists(path) {
    try {
      const file = Components.classes["@mozilla.org/file/local;1"].createInstance(
        Components.interfaces.nsIFile,
      );
      file.initWithPath(String(path));
      return file.exists() && file.isFile();
    } catch (error) {
      log("fileExists 检测失败: " + path, error);
      return false;
    }
  }

  async function runTranslation(item, button) {
    const config = getConfig();
    if (!config.apiKey) {
      notify("MinerU 翻译", "缺少 API Key，请设置偏好 " + PREF_BRANCH + "apiKey");
      return null;
    }

    const attachments = await getPDFAttachmentsFromItem(item);
    if (!attachments.length) {
      notify("MinerU 翻译", "当前条目没有 PDF 附件。");
      return null;
    }

    const results = [];
    for (const attachment of attachments) {
      const busyKey = String(attachment.id);
      if (state.busyKeys.has(busyKey)) {
        continue;
      }
      state.busyKeys.add(busyKey);
      setButtonState(button, true, "翻译中...");
      try {
        const result = await translateAttachment(attachment, config, (segments, section, totalSections) => {
          setButtonState(button, true, "翻译中 " + segments + " 段 (" + section + "/" + totalSections + ")");
        });
        results.push(result);
      } catch (error) {
        notify("MinerU 翻译失败", error.message || String(error));
        log("翻译失败", error);
      } finally {
        state.busyKeys.delete(busyKey);
        setButtonState(button, false);
      }
    }

    if (results.length) {
      const lines = results.map((result) => {
        if (result.status === "done") {
          return (result.title || "附件 " + result.dir) + "：已生成译文（" + result.translatedSegments + " 段）";
        }
        return (result.title || "附件 " + result.dir) + "：" + (result.reason || result.status);
      });
      notify("MinerU 翻译完成", lines);
    }
    return results;
  }

  async function translateFromReader(reader, button) {
    const item = await getReaderItem(reader);
    if (!item) {
      notify("MinerU 翻译", "无法识别当前阅读器对应的条目。");
      return null;
    }
    return runTranslation(item, button);
  }

  // ---------------------------------------------------------------------------
  // 阅读器按钮注入与菜单
  // ---------------------------------------------------------------------------

  // 进度文案尽量短：工具栏右侧空间有限，按钮不能无限变宽
  function setButtonState(button, busy, label) {
    if (!button) {
      return;
    }
    button.disabled = !!busy;
    button.textContent = label || BUTTON_LABEL;
    button.title = busy
      ? "MinerU 翻译进行中：" + (label || BUTTON_LABEL)
      : "翻译当前 PDF 对应的 MinerU Markdown 为简体中文";
  }

  function ensureReaderStyle(doc) {
    if (doc.getElementById(READER_STYLE_ID)) {
      return;
    }
    const style = doc.createElement("style");
    style.id = READER_STYLE_ID;
    // 按钮本身不再做绝对/固定定位。Zotero 工具栏右侧分组 .end（justify-content:flex-end）
    // 自带右对齐与末尾内边距，插进它里面的 .custom-sections 容器后，位置由工具栏布局决定，
    // 因此不会随窗口宽度、侧边栏开合或按钮文案变化而偏移。
    style.textContent = [
      "#" + READER_BUTTON_ID + " {",
      "  width: auto;",
      "  min-width: 0;",
      "  max-width: 150px;",
      "  height: 28px;",
      "  margin: 0;",
      "  padding: 0 10px;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "  font: inherit;",
      "  cursor: pointer;",
      "  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.15));",
      "  border-radius: 5px;",
      "  background-color: var(--material-background, #fff);",
      "  color: inherit;",
      "}",
      "#" + READER_BUTTON_ID + ":hover {",
      "  background-color: var(--fill-quinary, rgba(0, 0, 0, 0.05));",
      "}",
      "#" + READER_BUTTON_ID + ":active {",
      "  background-color: var(--fill-quarternary, rgba(0, 0, 0, 0.1));",
      "}",
      "#" + READER_BUTTON_ID + "[disabled] {",
      "  opacity: 0.6;",
      "  cursor: default;",
      "}",
    ].join("\n");
    doc.head.appendChild(style);
  }

  function getReaderDocument(reader) {
    const candidates = [
      reader?._iframeWindow?.document,
      reader?._iframe?.contentDocument,
      reader?._iframe?.contentWindow?.document,
      reader?.iframe?.contentDocument,
      reader?.iframe?.contentWindow?.document,
      reader?._window?.document,
      reader?.window?.document,
    ];
    return candidates.find((doc) => doc?.body && doc?.head) || null;
  }

  // Zotero 阅读器工具栏（React）右侧分组的真实结构：
  //   .toolbar > .end > .custom-sections > .section*  ->  之后才是 Zotero 自带按钮
  // React 组件 CustomSections 在挂载时会派发 "customEvent"（detail.type = "renderToolbar"），
  // 外部插件通过 Zotero.Reader.registerEventListener("renderToolbar", …) 拿到
  // { reader, doc, params, append }，其中 append 只能在该事件回调里同步调用，
  // 它会把节点放进 .custom-sections —— 这条路是 Zotero 官方给插件预留的工具栏位置。
  function getCustomSectionsContainer(doc) {
    return doc.querySelector(".toolbar .end .custom-sections") || null;
  }

  function createReaderButton(doc, reader) {
    const button = doc.createElement("button");
    button.id = READER_BUTTON_ID;
    button.type = "button";
    button.textContent = BUTTON_LABEL;
    button.title = "翻译当前 PDF 对应的 MinerU Markdown 为简体中文";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await translateFromReader(reader, button);
      } catch (error) {
        log("阅读器翻译失败", error);
      }
    });
    return button;
  }

  // 挂到指定文档（阅读器内部文档）的工具栏右侧；只在确认存在官方
  // .custom-sections 时才插入，避免落到错误容器里造成“位置偏移”
  function injectIntoDocument(doc, reader) {
    if (!doc || !doc.querySelector) {
      return false;
    }
    ensureReaderStyle(doc);
    if (doc.getElementById(READER_BUTTON_ID)) {
      return true;
    }
    const container = getCustomSectionsContainer(doc);
    if (!container) {
      return false;
    }
    // 与 renderToolbar 事件路径保持同一结构：.custom-sections > .section > button
    const section = doc.createElement("div");
    section.className = "section";
    section.appendChild(createReaderButton(doc, reader));
    container.insertBefore(section, container.firstChild);
    return true;
  }

  function injectReaderButton(reader) {
    const doc = getReaderDocument(reader);
    if (!doc) {
      return false;
    }
    return injectIntoDocument(doc, reader);
  }

  // 阅读器刚打开时工具栏可能还没渲染，短轮询等它出现（不占全局定时器）
  function waitAndInject(reader, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || RENDER_TOOLBAR_PROBE_TIMEOUT);
    const attempt = () => {
      if (injectReaderButton(reader)) {
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(attempt, 300);
      }
    };
    attempt();
  }

  // "renderToolbar" 事件的 doc 即阅读器内部文档，append 直接写入 .custom-sections
  function onRenderToolbar(event) {
    try {
      const { reader, doc, append } = event || {};
      if (!doc || typeof append !== "function" || doc.getElementById(READER_BUTTON_ID)) {
        return;
      }
      ensureReaderStyle(doc);
      // 与 Zotero 自带的自定义按钮保持一致：外面再包一层 .section
      const section = doc.createElement("div");
      section.className = "section";
      section.appendChild(createReaderButton(doc, reader));
      append(section);
    } catch (error) {
      log("处理 renderToolbar 事件失败", error);
    }
  }

  function getReaderInstances() {
    try {
      if (typeof Zotero.Reader?.getInstances === "function") {
        return Zotero.Reader.getInstances();
      }
    } catch (error) {
      log("获取 Reader 实例失败", error);
    }
    if (Array.isArray(Zotero.Reader?._readers)) {
      return Zotero.Reader._readers;
    }
    return [];
  }

  // 轮询只用于兜底：插件在阅读器已经打开之后才启动，
  // 或 React 重新挂载工具栏时，事件已经错过了。
  // 工具栏还没渲染的阅读器交给 onRenderToolbar / waitAndInject。
  function scanReaders() {
    for (const reader of getReaderInstances()) {
      try {
        injectReaderButton(reader);
      } catch (error) {
        log("注入阅读器按钮失败", error);
      }
    }
  }

  function selectedItemsContainPDF(window) {
    try {
      const items = window.ZoteroPane?.getSelectedItems() || [];
      return items.some((item) => {
        if (!item) {
          return false;
        }
        if (typeof item.isAttachment === "function" && item.isAttachment()) {
          return isPDFAttachment(item);
        }
        if (typeof item.isRegularItem === "function" && item.isRegularItem()) {
          const attachmentIDs = typeof item.getAttachments === "function" ? item.getAttachments() : [];
          return attachmentIDs.length > 0;
        }
        return false;
      });
    } catch (error) {
      return false;
    }
  }

  async function translateSelectedItems(window) {
    const items = window.ZoteroPane?.getSelectedItems() || [];
    if (!items.length) {
      throw new Error("请先选中一个 PDF 条目或其父条目。");
    }
    for (const item of items) {
      try {
        await runTranslation(item, null);
      } catch (error) {
        log("翻译选中条目失败", error);
      }
    }
  }

  function registerWindowMenus(window) {
    const document = window.document;
    const itemMenu = document.querySelector("#zotero-itemmenu");
    if (itemMenu && !document.getElementById(ITEM_MENU_ID)) {
      const menuItem = document.createXULElement("menuitem");
      menuItem.id = ITEM_MENU_ID;
      menuItem.setAttribute("label", "翻译 MinerU Markdown 为中文");
      menuItem.addEventListener("command", async () => {
        try {
          await translateSelectedItems(window);
        } catch (error) {
          notify("MinerU 翻译失败", error.message || String(error));
        }
      });
      itemMenu.appendChild(menuItem);

      const onPopupShowing = () => {
        menuItem.hidden = !selectedItemsContainPDF(window);
      };
      itemMenu.addEventListener("popupshowing", onPopupShowing);
      state.windows.get(window)?.cleanup.push(() => {
        itemMenu.removeEventListener("popupshowing", onPopupShowing);
      });
    }

    const toolsPopup = document.querySelector("#menu_ToolsPopup");
    if (toolsPopup && !document.getElementById(TOOLS_MENU_ID)) {
      const menuItem = document.createXULElement("menuitem");
      menuItem.id = TOOLS_MENU_ID;
      menuItem.setAttribute("label", "翻译选中条目的 MinerU Markdown");
      menuItem.addEventListener("command", async () => {
        try {
          await translateSelectedItems(window);
        } catch (error) {
          notify("MinerU 翻译失败", error.message || String(error));
        }
      });
      toolsPopup.appendChild(menuItem);
    }
  }

  // 注册阅读器工具栏渲染回调：阅读器（含新开的标签页）每次挂载工具栏
  // 都会派发 renderToolbar，这里把按钮插进工具栏右侧的 .custom-sections
  function registerReaderToolbarButton() {
    if (!Zotero.Reader || typeof Zotero.Reader.registerEventListener !== "function") {
      log("Zotero.Reader.registerEventListener 不可用，无法注册工具栏按钮");
      return;
    }
    Zotero.Reader.registerEventListener("renderToolbar", onRenderToolbar, PLUGIN_ID);
    // 插件启动时可能已有打开的阅读器（它们的 renderToolbar 已经派发过了）
    for (const reader of getReaderInstances()) {
      waitAndInject(reader, 5000);
    }
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async function onStartup() {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
    registerReaderToolbarButton();
    if (!state.intervalID) {
      state.intervalID = setInterval(() => {
        scanReaders();
      }, 1500);
    }
    scanReaders();
  }

  async function onMainWindowLoad(window) {
    if (!state.windows.has(window)) {
      state.windows.set(window, { cleanup: [] });
    }
    registerWindowMenus(window);
    window.setTimeout(() => {
      scanReaders();
    }, 1200);
  }

  function onMainWindowUnload(window) {
    const data = state.windows.get(window);
    if (!data) {
      return;
    }
    for (const fn of data.cleanup) {
      try {
        fn();
      } catch (error) {
        log("窗口清理失败", error);
      }
    }
    state.windows.delete(window);
  }

  function onShutdown() {
    if (state.intervalID) {
      clearInterval(state.intervalID);
      state.intervalID = null;
    }
    try {
      Zotero.Reader?.unregisterEventListener?.("renderToolbar", onRenderToolbar);
    } catch (error) {
      log("注销 renderToolbar 监听失败", error);
    }
    for (const [window] of state.windows) {
      onMainWindowUnload(window);
    }
    state.windows.clear();
    for (const reader of getReaderInstances()) {
      const doc = getReaderDocument(reader);
      doc?.getElementById(READER_BUTTON_ID)?.remove();
      doc?.getElementById(READER_STYLE_ID)?.remove();
    }
  }

  return {
    hooks: {
      onStartup,
      onMainWindowLoad,
      onMainWindowUnload,
      onShutdown,
    },
  };
})();
