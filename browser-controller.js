// browser-controller.js
const { chromium } = require("playwright");
const config = require("./config");

// ─────────────────────────────────────────────────────────────
// HTML-to-Markdown converter
// Runs INSIDE the browser via page.evaluate, so it must be
// fully self-contained — no Node.js or external references.
// ─────────────────────────────────────────────────────────────
const HTML_TO_MARKDOWN = function (rootElement) {
  var SKIP_TAGS = {
    BUTTON: 1, SVG: 1, PATH: 1, CIRCLE: 1, LINE: 1, POLYLINE: 1,
    RECT: 1, POLYGON: 1, NAV: 1, STYLE: 1, SCRIPT: 1, IFRAME: 1,
    "CLIPBOARD-COPY": 1,
  };

  function isChrome(node) {
    if (!node || node.nodeType !== 1) return false;
    // Skip the sticky header bar and action buttons inside textdoc popovers
    if (node.getAttribute("aria-label") === "Copy") return true;
    var txt = (node.textContent || "").trim().toLowerCase();
    if (txt === "copy" || txt === "edit" || txt === "download") return true;
    // Common toolbar containers
    var cls = node.className || "";
    if (typeof cls === "string" && cls.includes("backdrop-blur-sm")) return true;
    return false;
  }

  function extractLanguage(preEl) {
    var codeEl = preEl.querySelector("code");
    if (codeEl) {
      var match = (codeEl.className || "").match(/language-(\S+)/);
      if (match) return match[1];
    }
    return "";
  }

  function walk(node, listDepth) {
    if (typeof listDepth === "undefined") listDepth = 0;

    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";

    var tag = node.tagName;

    if (SKIP_TAGS[tag]) return "";
    if (isChrome(node)) return "";

    // Hard skip hidden chrome, but DO NOT skip contenteditable=false editor roots
    if (node.getAttribute("aria-hidden") === "true" && tag !== "PRE" && tag !== "CODE") {
      return "";
    }

    // Fence code blocks
    if (tag === "PRE") {
      var lang = extractLanguage(node);
      var codeEl = node.querySelector("code");
      var codeText = codeEl ? codeEl.textContent : node.textContent;
      codeText = codeText.replace(/\n$/, "");
      return "\n\n```" + lang + "\n" + codeText + "\n```\n\n";
    }

    // Inline code
    if (tag === "CODE") {
      if (node.closest("pre")) return node.textContent;
      var codeContent = node.textContent;
      if (codeContent.indexOf("`") !== -1) return "`` " + codeContent + " ``";
      return "`" + codeContent + "`";
    }

    // Walk children
    var children = "";
    for (var i = 0; i < node.childNodes.length; i++) {
      children += walk(node.childNodes[i], listDepth);
    }

    switch (tag) {
      case "DIV":
      case "SPAN":
        return children;

      case "P":
        return "\n\n" + children.trim();

      case "BR":
        return "\n";

      case "H1": return "\n\n# " + children.trim() + "\n";
      case "H2": return "\n\n## " + children.trim() + "\n";
      case "H3": return "\n\n### " + children.trim() + "\n";

      case "STRONG":
      case "B":
        return "**" + children + "**";
      case "EM":
      case "I":
        return "*" + children + "*";

      case "UL":
      case "OL": {
        var out = "";
        for (var j = 0; j < node.childNodes.length; j++) {
          out += walk(node.childNodes[j], listDepth + 1);
        }
        return (listDepth === 0 ? "\n\n" : "\n") + out + (listDepth === 0 ? "\n" : "");
      }

      case "LI": {
        var indent = "";
        for (var d = 0; d < Math.max(0, listDepth - 1); d++) indent += "  ";

        var parent = node.parentElement;
        var prefix = "- ";
        if (parent && parent.tagName === "OL") {
          var siblings = parent.querySelectorAll(":scope > li");
          var idx = Array.prototype.indexOf.call(siblings, node) + 1;
          prefix = idx + ". ";
        }

        // Split nested list blocks from inline content
        var liText = "";
        var nested = "";
        for (var k = 0; k < node.childNodes.length; k++) {
          var kid = node.childNodes[k];
          if (kid.nodeType === 1 && (kid.tagName === "UL" || kid.tagName === "OL")) {
            nested += walk(kid, listDepth + 1);
          } else {
            liText += walk(kid, listDepth);
          }
        }

        return indent + prefix + liText.trim() + "\n" + nested;
      }

      case "A": {
        var href = node.getAttribute("href") || "";
        var text = children.trim();
        return text ? "[" + text + "](" + href + ")" : "";
      }

      default:
        return children;
    }
  }

  var md = walk(rootElement, 0);
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  return md;
};

// ─────────────────────────────────────────────────────────────

class BrowserController {
  constructor() {
    this.browser = null;
    this.page = null;
    this.selectors = config.selectors[config.target.type];
    this.ready = false;
  }

  // ─── Lifecycle ───────────────────────────────────────────
  async initialize() {
    console.log("[Browser] Launching browser...");
    this.browser = await chromium.launchPersistentContext(
      config.target.userDataDir,
      {
        headless: config.target.headless,
        viewport: { width: 1280, height: 900 },
        args: ["--disable-blink-features=AutomationControlled"],
      }
    );
    this.page = this.browser.pages()[0] || (await this.browser.newPage());
    await this.page.goto(config.target.url, { waitUntil: "networkidle" });

    await this.page.waitForSelector(this.selectors.textArea, {
      timeout: 60000,
    });

    // Inject the HTML-to-Markdown converter into the page
    await this._injectConverter();

    this.ready = true;
    console.log("[Browser] Ready and logged in.");
  }

  /**
   * Injects the HTML-to-Markdown converter onto window.__bridgeHtmlToMd.
   * Must be called after every full page navigation.
   */
  async _injectConverter() {
    await this.page.evaluate((fnStr) => {
      window.__bridgeHtmlToMd = new Function("return " + fnStr)();
    }, HTML_TO_MARKDOWN.toString());
    console.log("[Browser] Markdown converter injected.");
  }

  // ─── Send a message and collect the full response ────────
  async sendMessage(message) {
    if (!this.ready) throw new Error("Browser not initialized");
    const sel = this.selectors;

    // 1. Count existing response blocks BEFORE sending
    const before = await this.page.evaluate(({ sel }) => {
      return {
        respCount: document.querySelectorAll(sel.responseBlock).length,
        docCount: sel.textdocPopover ? document.querySelectorAll(sel.textdocPopover).length : 0,
      };
    }, { sel });

    // 2. Type the message
    const inputEl = this.page.locator(sel.textArea);
    await inputEl.click();

    const tagName = await inputEl.evaluate((el) => el.tagName);
    if (tagName === "TEXTAREA" || tagName === "INPUT") {
      await inputEl.fill(message);
    } else {
      await inputEl.evaluate((el, text) => {
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, message);
    }

    await this.page.waitForTimeout(300);

    // 3. Click Send
    try {
      const sendBtn = this.page.locator(sel.sendButton);
      await sendBtn.click({ timeout: 3000 });
    } catch (e) {
      console.warn(
        "[Browser] Send button not clickable, pressing Enter:",
        e.message
      );
      await this.page.keyboard.press("Enter");
    }

    // 4. Wait for new response block
    await this.page.waitForFunction(
      ({ sel, before }) => {
        const respCount = document.querySelectorAll(sel.responseBlock).length;
        const docCount = sel.textdocPopover ? document.querySelectorAll(sel.textdocPopover).length : 0;
        return respCount > before.respCount || docCount > before.docCount;
      },
      { sel, before },
      { timeout: config.iteration.idleTimeout }
    );

    // 5. Poll until stable, returning clean Markdown
    const finalResponse = await this._waitForStableResponse();
    return finalResponse;
  }

  // ─── Wait for streaming to finish, return Markdown ───────
  async _waitForStableResponse() {
    const sel = this.selectors;
    const { responseStabilityTimeout, pollInterval, idleTimeout } =
      config.iteration;

    let lastText = "";
    let stableFor = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < idleTimeout) {
      const currentText = await this.page.evaluate(({ sel }) => {
        function toMd(el) {
          if (typeof window.__bridgeHtmlToMd === "function") {
            return window.__bridgeHtmlToMd(el);
          }
          return (el.innerText || "").trim();
        }

        // 1) Prefer the latest textdoc popover if present
        const popovers = document.querySelectorAll(sel.textdocPopover || "");
        if (popovers && popovers.length) {
          const lastPopover = popovers[popovers.length - 1];

          // Try ProseMirror content first
          const pm = lastPopover.querySelector(sel.textdocContent || "div.ProseMirror");
          if (pm) {
            const titleEl = sel.textdocTitle
              ? lastPopover.querySelector(sel.textdocTitle)
              : null;
            const title = titleEl ? (titleEl.textContent || "").trim() : "";

            const body = toMd(pm);
            if (body) {
              // Optional: include title as top H1 if it isn't already present
              if (title && !body.trim().toLowerCase().startsWith("#")) {
                return `# ${title}\n\n${body}`.trim();
              }
              return body.trim();
            }
          }

          // Fallback: convert entire popover (less ideal, but better than nothing)
          const pop = toMd(lastPopover);
          if (pop) return pop.trim();
        }

        // 2) Fallback to last normal response block
        const blocks = document.querySelectorAll(sel.responseBlock);
        const last = blocks[blocks.length - 1];
        if (!last) return "";
        return toMd(last).trim();
      }, { sel });

      if (currentText === lastText && currentText.length > 0) {
        stableFor += pollInterval;
      } else {
        stableFor = 0;
        lastText = currentText;
      }

      const isStreaming = sel.thinkingIndicator
        ? await this.page.$(sel.thinkingIndicator)
        : null;

      if (stableFor >= responseStabilityTimeout && !isStreaming) {
        return lastText;
      }

      await this.page.waitForTimeout(pollInterval);
    }

    console.warn("[Browser] Response timed out, returning partial.");
    return lastText;
  }

  // ─── Utility ─────────────────────────────────────────────
  async startNewChat() {
    if (config.target.type === "chatgpt") {
      await this.page.goto("https://chatgpt.com/?model=auto", {
        waitUntil: "networkidle",
      });
    } else if (config.target.type === "claude") {
      await this.page.goto("https://claude.ai/new", {
        waitUntil: "networkidle",
      });
    }

    await this.page.waitForSelector(this.selectors.textArea, {
      timeout: 30000,
    });

    // Re-inject converter after navigation wiped the page context
    await this._injectConverter();
  }

  async shutdown() {
    if (this.browser) await this.browser.close();
  }
}

module.exports = BrowserController;