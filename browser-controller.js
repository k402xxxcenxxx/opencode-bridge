// browser-controller.js
const { chromium } = require("playwright");
const config = require("./config");

// ─────────────────────────────────────────────────────────────
// HTML-to-Markdown converter
// Runs INSIDE the browser via page.evaluate, so it must be
// fully self-contained — no Node.js or external references.
// ─────────────────────────────────────────────────────────────
const HTML_TO_MARKDOWN = function (rootElement) {
  // UI chrome elements to skip entirely (buttons, icons, copy widgets)
  var SKIP_TAGS = {
    BUTTON: 1, SVG: 1, PATH: 1, CIRCLE: 1, LINE: 1, POLYLINE: 1,
    RECT: 1, POLYGON: 1, NAV: 1, STYLE: 1, SCRIPT: 1, IFRAME: 1,
    "CLIPBOARD-COPY": 1,
  };

  function extractLanguage(preEl) {
    // Method 1: class="language-xxx" on <code>
    var codeEl = preEl.querySelector("code");
    if (codeEl) {
      var match = (codeEl.className || "").match(/language-(\S+)/);
      if (match) return match[1];
      // Some UIs use "hljs xxx" style classes
      var cls = codeEl.className || "";
      var parts = cls.split(/\s+/);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] && parts[i] !== "hljs" && parts[i].length < 20 &&
            /^[a-z0-9+#._-]+$/i.test(parts[i])) {
          return parts[i].toLowerCase();
        }
      }
    }
    // Method 2: small <span> in a header div (ChatGPT-style)
    var spans = preEl.querySelectorAll("span");
    for (var j = 0; j < spans.length; j++) {
      var text = spans[j].textContent.trim().toLowerCase();
      if (text.length > 0 && text.length < 20 &&
          /^[a-z0-9+#._-]+$/.test(text) &&
          !spans[j].closest("code")) {
        return text;
      }
    }
    return "";
  }

  function walk(node, listDepth) {
    if (typeof listDepth === "undefined") listDepth = 0;

    // Text node — return raw text
    if (node.nodeType === 3) {
      return node.textContent;
    }
    // Not an element node — skip
    if (node.nodeType !== 1) return "";

    var tag = node.tagName;

    // Skip non-content UI elements
    if (SKIP_TAGS[tag]) return "";
    // Skip elements commonly used for copy buttons or toolbars
    if (node.getAttribute("aria-hidden") === "true" && tag !== "PRE" && tag !== "CODE") return "";

    // ── PRE: fenced code block ───────────────────────
    if (tag === "PRE") {
      var lang = extractLanguage(node);
      var codeEl = node.querySelector("code");
      var codeText = codeEl ? codeEl.textContent : node.textContent;
      // Trim one trailing newline, but preserve internal formatting
      codeText = codeText.replace(/\n$/, "");
      return "\n\n```" + lang + "\n" + codeText + "\n```\n\n";
    }

    // ── CODE: inline code (skip if already inside a PRE) ─
    if (tag === "CODE") {
      if (node.closest("pre")) return node.textContent;
      var codeContent = node.textContent;
      // Use double backticks if content contains a backtick
      if (codeContent.indexOf("`") !== -1) {
        return "`` " + codeContent + " ``";
      }
      return "`" + codeContent + "`";
    }

    // ── Recursively process children ─────────────────
    var childNodes = node.childNodes;
    var children = "";
    for (var c = 0; c < childNodes.length; c++) {
      children += walk(childNodes[c], listDepth);
    }

    switch (tag) {
      // ── Block elements ─────────────────────────────
      case "P":
        return "\n\n" + children.trim();
      case "BR":
        return "\n";
      case "HR":
        return "\n\n---\n\n";

      // ── Headings ───────────────────────────────────
      case "H1": return "\n\n# " + children.trim() + "\n";
      case "H2": return "\n\n## " + children.trim() + "\n";
      case "H3": return "\n\n### " + children.trim() + "\n";
      case "H4": return "\n\n#### " + children.trim() + "\n";
      case "H5": return "\n\n##### " + children.trim() + "\n";
      case "H6": return "\n\n###### " + children.trim() + "\n";

      // ── Inline formatting ──────────────────────────
      case "STRONG":
      case "B":
        return "**" + children + "**";
      case "EM":
      case "I":
        return "*" + children + "*";
      case "DEL":
      case "S":
        return "~~" + children + "~~";
      case "U":
        // Markdown has no native underline; use emphasis
        return "_" + children + "_";

      // ── Links & Images ─────────────────────────────
      case "A": {
        var href = node.getAttribute("href") || "";
        var linkText = children.trim();
        if (!linkText) return "";
        return "[" + linkText + "](" + href + ")";
      }
      case "IMG": {
        var alt = node.getAttribute("alt") || "";
        var src = node.getAttribute("src") || "";
        return "![" + alt + "](" + src + ")";
      }

      // ── Lists ──────────────────────────────────────
      case "UL":
      case "OL": {
        var listItems = "";
        var liChildren = node.childNodes;
        for (var li = 0; li < liChildren.length; li++) {
          listItems += walk(liChildren[li], listDepth + 1);
        }
        // Only add surrounding newlines at the top level
        return (listDepth === 0 ? "\n\n" : "\n") + listItems +
               (listDepth === 0 ? "\n" : "");
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
        // Separate inline content from nested lists
        var liText = "";
        var nestedLists = "";
        var liKids = node.childNodes;
        for (var k = 0; k < liKids.length; k++) {
          var kid = liKids[k];
          if (kid.nodeType === 1 && (kid.tagName === "UL" || kid.tagName === "OL")) {
            nestedLists += walk(kid, listDepth + 1);
          } else {
            liText += walk(kid, listDepth);
          }
        }
        return indent + prefix + liText.trim() + "\n" + nestedLists;
      }

      // ── Blockquote ─────────────────────────────────
      case "BLOCKQUOTE": {
        var lines = children.trim().split("\n");
        var quoted = "";
        for (var q = 0; q < lines.length; q++) {
          quoted += "> " + lines[q] + "\n";
        }
        return "\n\n" + quoted + "\n";
      }

      // ── Tables ─────────────────────────────────────
      case "TABLE":
        return "\n\n" + children + "\n";
      case "THEAD":
      case "TBODY":
      case "TFOOT":
        return children;
      case "TR": {
        var cells = node.querySelectorAll(":scope > td, :scope > th");
        var row = "|";
        for (var t = 0; t < cells.length; t++) {
          row += " " + walk(cells[t], listDepth).trim() + " |";
        }
        row += "\n";
        // Add separator after header row
        if (node.parentElement && node.parentElement.tagName === "THEAD") {
          var sep = "|";
          for (var s = 0; s < cells.length; s++) sep += " --- |";
          row += sep + "\n";
        }
        return row;
      }
      case "TH":
      case "TD":
        return children;

      // ── Details/Summary (collapsible) ──────────────
      case "DETAILS":
        return "\n\n" + children + "\n";
      case "SUMMARY":
        return "**" + children.trim() + "**\n\n";

      // ── DIV and other containers: pass through ─────
      default:
        return children;
    }
  }

  var md = walk(rootElement, 0);

  // Clean up: collapse 3+ newlines to 2, trim edges
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
    const beforeCount = await this.page.$$eval(
      sel.responseBlock,
      (els) => els.length
    );

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
      ({ selector, prevCount }) =>
        document.querySelectorAll(selector).length > prevCount,
      { selector: sel.responseBlock, prevCount: beforeCount },
      { timeout: config.iteration.idleTimeout }
    );

    // 5. Poll until stable, returning clean Markdown
    const finalResponse = await this._waitForStableResponse(beforeCount);
    return finalResponse;
  }

  // ─── Wait for streaming to finish, return Markdown ───────
  async _waitForStableResponse(beforeCount) {
    const sel = this.selectors;
    const { responseStabilityTimeout, pollInterval, idleTimeout } =
      config.iteration;

    let lastText = "";
    let stableFor = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < idleTimeout) {
      // Extract the latest response block as clean Markdown
      const currentText = await this.page.$$eval(
        sel.responseBlock,
        (els) => {
          const last = els[els.length - 1];
          if (!last) return "";
          // Use the injected converter if available, fall back to innerText
          if (typeof window.__bridgeHtmlToMd === "function") {
            return window.__bridgeHtmlToMd(last);
          }
          return last.innerText.trim();
        }
      );

      if (currentText === lastText && currentText.length > 0) {
        stableFor += pollInterval;
      } else {
        stableFor = 0;
        lastText = currentText;
      }

      const isStreaming = await this.page.$(sel.thinkingIndicator);
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