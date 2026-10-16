var chromeHandle;

function install() {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "llm-for-zotero-translator", rootURI + "chrome/content/"],
  ]);

  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/scripts/llm-for-zotero-translator.js",
    ctx,
  );

  if (ctx.LlmForZoteroTranslator) {
    Zotero.LlmForZoteroTranslator = ctx.LlmForZoteroTranslator;
    await Zotero.LlmForZoteroTranslator.hooks.onStartup();
  }
}

async function onMainWindowLoad({ window }, reason) {
  if (Zotero.LlmForZoteroTranslator) {
    await Zotero.LlmForZoteroTranslator.hooks.onMainWindowLoad(window);
  }
}

async function onMainWindowUnload({ window }, reason) {
  if (Zotero.LlmForZoteroTranslator) {
    await Zotero.LlmForZoteroTranslator.hooks.onMainWindowUnload(window);
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
      Components.interfaces.nsISupports,
    ).wrappedJSObject;
  }

  Zotero.LlmForZoteroTranslator?.hooks.onShutdown();
  delete Zotero.LlmForZoteroTranslator;

  Cu.unload(rootURI + "chrome/content/scripts/llm-for-zotero-translator.js");

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
