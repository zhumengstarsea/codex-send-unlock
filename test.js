const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync("codex-send-unlock.js", "utf8");
const API_KEY = "__codexPlusSendUnlock";
const STYLE_ID = "codex-plus-send-unlock-style";
const HIDDEN_ATTR = "data-codex-plus-hidden-quota-alert";
const HIDDEN_KIND_ATTR = `${HIDDEN_ATTR}-kind`;

const newOutOfMessagesAlert = [
  "You’re out of Codex messages",
  "Your rate limit resets on Jul 1, 2026, 4:45 PM.",
  "To continue using Codex and get access to GPT-5.3-Codex, start your free trial of Plus today.",
].join(" ");

const subagentQuotaCard = [
  "你的 Codex 消息限额已用尽",
  "你的额度将于 2026年6月11日 08:25重置。",
  "请增加额度以继续使用 Codex。",
  "增加额度",
].join(" ");

const mergedQuotaAlert = "你的 Codex 和工作使用额度已用完 升级至 Pro 重置使用量";
const mergedQuotaWithoutPronoun = "Codex 和工作使用额度已用完 添加额度或升级套餐，或等待使用量于 16:33 重置";
const legacyUsageCard = "剩余 0% 使用量 重置频率 每周 下次重置时间 2026年7月20日 08:00 升级";

function descendantsOf(root) {
  return (root?.children || []).flatMap((child) =>
    child.nodeType === 1 ? [child, ...descendantsOf(child)] : []
  );
}

function subtreeAccessReads(root) {
  return [root, ...descendantsOf(root)].reduce((total, node) => total + node.accessReads, 0);
}

function styleCount(document) {
  return document.querySelectorAll("style").filter((style) => style.id === STYLE_ID).length;
}

function matchesAttribute(element, selector) {
  const match = selector.match(
    /^\[([^\s~|^$*=\]]+)\s*(?:(\*=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*(i)?)?\]$/
  );
  if (!match) return false;

  const [, name, operator, doubleQuoted, singleQuoted, bare, caseInsensitive] = match;
  if (!element.hasAttribute(name)) return false;
  if (!operator) return true;

  const expected = doubleQuoted ?? singleQuoted ?? bare ?? "";
  let actual = element.getAttribute(name);
  if (caseInsensitive) {
    actual = actual.toLowerCase();
    return operator === "="
      ? actual === expected.toLowerCase()
      : actual.includes(expected.toLowerCase());
  }
  return operator === "=" ? actual === expected : actual.includes(expected);
}

function matchesSelector(element, selector) {
  return selector.split(",").some((part) => {
    const simple = part.trim();
    if (!simple) return false;
    if (simple.startsWith("[")) return matchesAttribute(element, simple);
    return element.tagName === simple.toUpperCase();
  });
}

class FakeElement {
  constructor(tagName = "div", { text = "", attrs = {}, rect = {}, children = [] } = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.parentElement = null;
    this.attributes = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
    this.rect = {
      width: 360,
      height: 120,
      top: 600,
      bottom: 720,
      left: 700,
      right: 1060,
      ...rect,
    };
    this.children = [];
    this._text = String(text);
    this.layoutReads = 0;
    this.matchesReads = 0;
    this.queryReads = 0;
    this.textReads = 0;
    this.attributeReads = 0;
    children.forEach((child) => this.appendChild(child));
  }

  get id() {
    return this.getAttribute("id") || "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(value) {
    this._text = String(value || "");
  }

  get textContent() {
    this.textReads += 1;
    return [this._text, ...this.children.map((child) => child.textContent)].filter(Boolean).join(" ");
  }

  set textContent(value) {
    this._text = String(value || "");
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  get isConnected() {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    return root.tagName === "HTML";
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  getBoundingClientRect() {
    this.layoutReads += 1;
    return this.rect;
  }

  getAttribute(name) {
    this.attributeReads += 1;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    this.attributeReads += 1;
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  matches(selector) {
    this.matchesReads += 1;
    return matchesSelector(this, selector);
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelector(selector) {
    this.queryReads += 1;
    return descendantsOf(this).find((node) => node.matches(selector)) || null;
  }

  querySelectorAll(selector) {
    this.queryReads += 1;
    return descendantsOf(this).filter((node) => node.matches(selector));
  }

  resetAccessCounts({ subtree = false } = {}) {
    this.matchesReads = 0;
    this.queryReads = 0;
    this.layoutReads = 0;
    this.textReads = 0;
    this.attributeReads = 0;
    if (subtree) descendantsOf(this).forEach((node) => node.resetAccessCounts());
  }

  get accessReads() {
    return (
      this.matchesReads +
      this.queryReads +
      this.textReads +
      this.attributeReads +
      this.layoutReads
    );
  }
}

class FakeText {
  constructor(text = "") {
    this.nodeType = 3;
    this.parentElement = null;
    this._text = String(text);
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value || "");
  }
}

function createFakeDocument(documentElement = null, body = null) {
  const listeners = new Map();
  const document = {
    body,
    documentElement,
    readyState: documentElement ? "complete" : "loading",
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    getElementById(id) {
      return allElements().find((element) => element.id === id) || null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      return allElements().filter((element) => element.matches(selector));
    },
    addEventListener(event, callback, options = {}) {
      const callbacks = listeners.get(event) || [];
      callbacks.push({ callback, once: !!options.once });
      listeners.set(event, callbacks);
    },
    removeEventListener(event, callback) {
      listeners.set(
        event,
        (listeners.get(event) || []).filter((item) => item.callback !== callback)
      );
    },
    fire(event) {
      if (event === "DOMContentLoaded") this.readyState = "interactive";
      for (const item of [...(listeners.get(event) || [])]) {
        if (item.once) this.removeEventListener(event, item.callback);
        item.callback();
      }
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
  const allElements = () =>
    document.documentElement
      ? [document.documentElement, ...descendantsOf(document.documentElement)]
      : [];

  return document;
}

function createFakeWindow() {
  let nextTimerId = 1;
  const timers = new Map();

  return {
    innerHeight: 900,
    innerWidth: 1200,
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pendingTimerCount() {
      return timers.size;
    },
    flushTimers() {
      let rounds = 0;
      while (timers.size) {
        if (++rounds > 100) throw new Error("Fake timer queue did not settle");
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach((callback) => callback());
      }
    },
  };
}

function createEnvironment(
  body = null,
  { autoRun = true, documentElementReady = false, topLevel = true } = {}
) {
  const observers = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }

    observe(target, options) {
      if (!target || typeof target.nodeType !== "number") {
        throw new TypeError("MutationObserver target must be a Node");
      }
      if (!options || !(options.childList || options.attributes || options.characterData)) {
        throw new TypeError("MutationObserver options must observe at least one mutation type");
      }
      this.target = target;
      this.options = { ...options };
      this.connected = true;
    }

    disconnect() {
      this.connected = false;
    }

    emit(mutations) {
      if (this.connected) this.callback(mutations);
    }
  }

  const documentElement = body || documentElementReady
    ? new FakeElement("html", { children: body ? [body] : [] })
    : null;
  const document = createFakeDocument(documentElement, body);
  const window = createFakeWindow();
  window.window = window;
  window.self = window;
  window.top = topLevel ? window : {};

  const context = {
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: FakeMutationObserver,
    document,
    window,
  };

  function runScript() {
    return vm.runInNewContext(source, context);
  }

  function attachBody(nextBody) {
    const nextDocumentElement = new FakeElement("html", { children: [nextBody] });
    document.body = nextBody;
    document.documentElement = nextDocumentElement;
    return nextDocumentElement;
  }

  function mountBody(nextBody) {
    if (!document.documentElement || document.body) {
      throw new Error("mountBody requires an existing documentElement without a body");
    }
    document.documentElement.appendChild(nextBody);
    document.body = nextBody;
    for (const observer of observers) {
      observer.emit([
        { type: "childList", target: document.documentElement, addedNodes: [nextBody] },
      ]);
    }
    return document.documentElement;
  }

  const environment = { attachBody, context, document, mountBody, observers, runScript, window };
  Object.defineProperty(environment, "activeObserverCount", {
    get() {
      return observers.filter((observer) => observer.connected).length;
    },
  });

  if (autoRun) {
    runScript();
    window.flushTimers();
  }
  return environment;
}

function quotaAlert(text, { tagName = "aside", attrs = {}, children = [] } = {}) {
  const button = new FakeElement("button", { text: "增加额度", rect: { width: 80, height: 32 } });
  return new FakeElement(tagName, {
    text,
    attrs,
    rect: { width: 720, height: 80 },
    children: [...children, button],
  });
}

const protectedSurfaces = [
  { selector: "[data-codex-composer-root]", tagName: "div", attrs: { "data-codex-composer-root": "true" } },
  { selector: "[data-codex-composer]", tagName: "div", attrs: { "data-codex-composer": "true" } },
  { selector: "[contenteditable]", tagName: "div", attrs: { contenteditable: "true" } },
  { selector: "textarea", tagName: "textarea", attrs: {} },
  { selector: "input", tagName: "input", attrs: {} },
  { selector: "form", tagName: "form", attrs: {} },
];

test("hides the English role=alert out-of-messages banner", () => {
  const alert = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });

  createEnvironment(new FakeElement("body", { children: [alert] }));

  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");
  assert.equal(alert.getAttribute(HIDDEN_KIND_ATTR), "quota-banner");
});

test("hides the legacy bottom div quota banner", () => {
  const banner = quotaAlert(newOutOfMessagesAlert, { tagName: "div" });

  createEnvironment(new FakeElement("body", { children: [banner] }));

  assert.equal(banner.getAttribute(HIDDEN_ATTR), "true");
  assert.equal(banner.getAttribute(HIDDEN_KIND_ATTR), "quota-banner");
});

test("hides the smallest nested legacy quota card", () => {
  const copy = new FakeElement("div", { text: newOutOfMessagesAlert });
  const action = new FakeElement("button", { text: "Upgrade", rect: { width: 80, height: 32 } });
  const card = new FakeElement("div", {
    rect: { width: 720, height: 100 },
    children: [copy, action],
  });
  const sibling = new FakeElement("div", { text: "Unrelated controls" });
  const wrapper = new FakeElement("div", {
    rect: { width: 760, height: 180 },
    children: [card, sibling],
  });

  createEnvironment(new FakeElement("body", { children: [wrapper] }));

  assert.equal(wrapper.getAttribute(HIDDEN_ATTR), null, "outer wrapper must remain visible");
  assert.equal(card.getAttribute(HIDDEN_ATTR), "true", "the complete quota card should be hidden");
  assert.equal(copy.getAttribute(HIDDEN_ATTR), null, "copy alone is not the complete alert surface");
  assert.equal(sibling.getAttribute(HIDDEN_ATTR), null, "unrelated sibling must remain visible");
});

test("preserves the legacy role=status usage card", () => {
  const upgrade = new FakeElement("button", { text: "升级", rect: { width: 80, height: 32 } });
  const card = new FakeElement("div", {
    text: legacyUsageCard,
    attrs: { role: "status" },
    rect: { width: 360, height: 160 },
    children: [upgrade],
  });

  createEnvironment(new FakeElement("body", { children: [card] }));

  assert.equal(card.getAttribute(HIDDEN_ATTR), null);
  assert.equal(card.getAttribute(HIDDEN_KIND_ATTR), null);
});

test("preserves header Plus buttons and unrelated quota alerts", () => {
  const buttons = ["获取 Plus", "Get Plus", "升级至 Plus"].map((text) => new FakeElement("button", { text }));
  const header = new FakeElement("header", { children: buttons });
  const alert = quotaAlert("Your message limit is reached. Upgrade to Plus. Limit will reset tomorrow.");
  createEnvironment(new FakeElement("body", { children: [header, alert] }));
  for (const node of [header, ...buttons, alert]) assert.equal(node.getAttribute(HIDDEN_ATTR), null);
});

function createQuotaClient(data, key = ["rate-limit-status"]) {
  const listeners = new Set();
  const queries = [];
  const cache = {
    getAll: () => queries,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    notify: (event) => { for (const listener of listeners) listener(event); },
  };
  const client = { getQueryCache: () => cache };
  const add = (data, queryKey = key) => {
    const query = {
      queryKey,
      state: { data, dataUpdatedAt: 123 },
      setData(data, options) {
        this.state = { ...this.state, data, dataUpdatedAt: options?.updatedAt ?? 456 };
        cache.notify({ type: "updated", query: this });
        return data;
      },
      setState(state) { this.state = { ...this.state, ...state }; cache.notify({ type: "updated", query: this }); },
    };
    queries.push(query);
    cache.notify({ type: "added", query });
    return query;
  };
  const query = add(data);
  const composer = new FakeElement("div", { attrs: { "data-codex-composer-root": "" } });
  // Mirrors the scoped provider map in the installed app; no bundle names.
  composer.__reactFiber$test = {
    memoizedProps: {},
    return: { memoizedProps: { value: new Map([["root", { queryClient: client }]]) } },
  };
  return { client, query, composer, add, cache, listeners };
}

function exhaustedStatus() {
  return {
    account_id: "account", user_id: "user", plan_type: "free",
    rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 999 } },
    additional_rate_limits: [{ limit_name: "model", rate_limit: { allowed: false, limit_reached: true } }],
    credits: { has_credits: false, balance: "0" },
    spend_control: { reached: true },
    code_review_rate_limit: { allowed: false, limit_reached: true },
  };
}

test("unlocks cached message quota while preserving counters, account and other restrictions", () => {
  const raw = exhaustedStatus();
  const { composer, query } = createQuotaClient(raw);
  const environment = createEnvironment(new FakeElement("body", { children: [composer] }));
  const current = query.state.data;
  assert.equal(current.rate_limit.allowed, true);
  assert.equal(current.rate_limit.limit_reached, false);
  assert.equal(current.additional_rate_limits[0].rate_limit.allowed, true);
  for (const key of ["credits", "spend_control", "code_review_rate_limit", "account_id", "user_id", "plan_type"]) {
    assert.equal(current[key], raw[key], key);
  }
  assert.equal(current.rate_limit.primary_window, raw.rate_limit.primary_window);
  assert.equal(raw.rate_limit.allowed, false, "never mutate the server snapshot");
  assert.equal(query.state.dataUpdatedAt, 123);
  assert.equal(environment.window[API_KEY].state.sendUnlock.clients, 1);
});

test("unlocks incoming push/poll updates before cache observers see them", () => {
  const { composer, query, cache } = createQuotaClient(exhaustedStatus(), ["rate-limit-status", "user", "account"]);
  createEnvironment(new FakeElement("body", { children: [composer] }));
  const observed = [];
  cache.subscribe(({ query }) => observed.push(query.state.data.rate_limit.allowed));
  query.setData(exhaustedStatus(), { updatedAt: 789 });
  assert.deepEqual(observed, [true]);
  assert.equal(query.state.dataUpdatedAt, 789);
});

for (const type of ["free_or_go_rate_limit_reached", "plus_gpt6_rate_limit_reached", "selected_model_limit_reached", "workspace_member_usage_limit_reached", "workspace_owner_usage_limit_reached"]) {
  test(`suppresses ${type} by protocol category regardless of text or language`, () => {
    const raw = exhaustedStatus();
    raw.rate_limit_upsell = { banner_type: type, title: "文案完全改变", description: "別の言語", ctas: [] };
    const { composer, query } = createQuotaClient(raw);
    const environment = createEnvironment(new FakeElement("body", { children: [composer] }));
    assert.equal(Object.hasOwn(query.state.data, "rate_limit_upsell"), false);
    assert.equal(query.state.data.rate_limit.primary_window, raw.rate_limit.primary_window);
    assert.equal(raw.rate_limit_upsell.banner_type, type);
    environment.window[API_KEY].destroy();
    assert.equal(query.state.data, raw);
  });
}

test("suppresses quota upsell even when message sending is already allowed", () => {
  const raw = { rate_limit: { allowed: true, limit_reached: false }, rate_limit_upsell: { banner_type: "plus_rate_limit_reached" } };
  const { composer, query } = createQuotaClient(raw);
  createEnvironment(new FakeElement("body", { children: [composer] }));
  assert.equal(query.state.data.rate_limit, raw.rate_limit);
  assert.equal(query.state.data.rate_limit_upsell, undefined);
});

test("preserves image, credits, reserve, spend and unknown upsells", () => {
  const { composer, query } = createQuotaClient(exhaustedStatus());
  createEnvironment(new FakeElement("body", { children: [composer] }));
  for (const type of ["image_generation_limit_reached", "workspace_member_credits_depleted", "workspace_owner_credits_depleted", "luna_reserve", "spend_control_limit_reached", "unknown_notice"]) {
    const raw = exhaustedStatus();
    raw.rate_limit_upsell = { banner_type: type, title: "You're out of Codex messages", ctas: [] };
    query.setData(raw);
    assert.equal(query.state.data.rate_limit_upsell, raw.rate_limit_upsell, type);
  }
});

test("removes incoming message banners before notifying observers and restores the newest copy", () => {
  const { composer, query, cache } = createQuotaClient(exhaustedStatus());
  const environment = createEnvironment(new FakeElement("body", { children: [composer] }));
  const observed = [];
  cache.subscribe(({query}) => observed.push(query.state.data.rate_limit_upsell));
  const raw = exhaustedStatus();
  raw.rate_limit_upsell = { banner_type: "free_or_go_rate_limit_reached", title: "New copy" };
  query.setData(raw);
  assert.deepEqual(observed, [undefined]);
  environment.window[API_KEY].destroy();
  assert.equal(query.state.data, raw);
  assert.equal(query.state.data.rate_limit_upsell.title, "New copy");
});

test("hooks newly added quota queries and leaves image, checkout and unrelated queries alone", () => {
  const { composer, add } = createQuotaClient(exhaustedStatus());
  createEnvironment(new FakeElement("body", { children: [composer] }));
  assert.equal(add(exhaustedStatus(), ["rate-limit-status", "new-user", "new-account"]).state.data.rate_limit.allowed, true);
  for (const key of [["other"], ["rate-limit-status", "image-generation", "presentation"], ["rate-limit-status", "work-credit-continuation", "id"]]) {
    const raw = exhaustedStatus();
    const query = add(raw, key);
    assert.equal(query.state.data, raw);
    query.setData(raw);
    assert.equal(query.state.data, raw);
  }
});

test("destroy restores the latest raw quota snapshot and detaches cache hooks", () => {
  const { composer, query, listeners } = createQuotaClient(exhaustedStatus());
  const originalSetData = query.setData;
  const environment = createEnvironment(new FakeElement("body", { children: [composer] }));
  const latest = exhaustedStatus();
  latest.rate_limit.primary_window.reset_at = 2000;
  query.setData(latest, { updatedAt: 789 });
  environment.window[API_KEY].destroy();
  assert.equal(query.state.data, latest);
  assert.equal(query.state.dataUpdatedAt, 789);
  assert.equal(query.setData, originalSetData);
  assert.equal(listeners.size, 0);
});

test("reinjects quota hooks once and handles reset and removal", () => {
  const { composer, query, cache, listeners } = createQuotaClient(exhaustedStatus());
  const environment = createEnvironment(new FakeElement("body", { children: [composer] }));
  const first = environment.window[API_KEY];
  environment.runScript();
  first.destroy();
  assert.equal(listeners.size, 1);
  assert.equal(query.state.data.rate_limit.allowed, true);
  const reset = { ...exhaustedStatus(), rate_limit: { allowed: true, limit_reached: false }, additional_rate_limits: [] };
  query.setData(reset);
  assert.equal(query.state.data, reset);
  cache.notify({ type: "removed", query });
  assert.equal(environment.window[API_KEY].state.sendUnlock.queries, 0);
  environment.window[API_KEY].destroy();
  assert.equal(query.state.data, reset);
});

test("registers synchronous Codex++ cleanup that restores quota hooks", () => {
  const raw = exhaustedStatus();
  const { composer, query, listeners } = createQuotaClient(raw);
  const environment = createEnvironment(new FakeElement("body", { children: [composer] }), { autoRun: false });
  const cleanups = [];
  environment.window.__codexPlusUserScripts = {
    currentKey: "user:codex-send-unlock.js",
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  };
  environment.runScript();
  assert.equal(cleanups.length, 1);
  assert.equal(query.state.data.rate_limit.allowed, true);
  assert.equal(cleanups[0](), undefined);
  assert.equal(query.state.data, raw);
  assert.equal(listeners.size, 0);
  assert.equal(environment.window[API_KEY], undefined);
});

test("hides the subagent quota card", () => {
  const button = new FakeElement("button", { text: "增加额度", rect: { width: 80, height: 32 } });
  const quotaCard = new FakeElement("div", {
    text: subagentQuotaCard,
    rect: { width: 360, height: 160 },
    children: [button],
  });
  createEnvironment(new FakeElement("body", { children: [quotaCard] }));
  assert.equal(quotaCard.getAttribute(HIDDEN_ATTR), "true");
});

for (const container of [
  { name: "data-message-author-role", tagName: "div", attrs: { "data-message-author-role": "assistant" } },
  { name: "article", tagName: "article", attrs: {} },
]) {
  test(`does not hide quoted quota copy inside ${container.name}`, () => {
    const quote = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });
    const message = new FakeElement(container.tagName, {
      attrs: container.attrs,
      children: [quote],
    });

    createEnvironment(new FakeElement("body", { children: [message] }));

    assert.equal(message.getAttribute(HIDDEN_ATTR), null);
    assert.equal(quote.getAttribute(HIDDEN_ATTR), null);
  });
}

test("does not hide ancestors containing quoted quota copy", () => {
  const quote = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });
  const article = new FakeElement("article", { children: [quote] });
  const section = new FakeElement("section", { children: [article] });
  const outer = new FakeElement("div", { children: [section] });

  createEnvironment(new FakeElement("body", { children: [outer] }));

  for (const node of [outer, section, article, quote]) {
    assert.equal(node.getAttribute(HIDDEN_ATTR), null);
  }
});

test("hides the quota aside without hiding its composer sibling or shared layout", () => {
  const alert = quotaAlert(subagentQuotaCard);
  const composer = new FakeElement("div", {
    attrs: { "data-codex-composer": "true", contenteditable: "true" },
    rect: { width: 720, height: 110 },
  });
  const layout = new FakeElement("div", {
    children: [alert, composer],
    rect: { width: 760, height: 210 },
  });
  const composerRoot = new FakeElement("div", {
    attrs: { "data-codex-composer-root": "true" },
    children: [layout],
    rect: { width: 800, height: 240 },
  });

  createEnvironment(new FakeElement("body", { children: [composerRoot] }));

  assert.equal(layout.getAttribute(HIDDEN_ATTR), null, "shared layout must not be hidden");
  assert.equal(composerRoot.getAttribute(HIDDEN_ATTR), null, "composer root must not be hidden");
  assert.equal(composer.getAttribute(HIDDEN_ATTR), null, "composer must not be hidden");
  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true", "quota aside should be hidden directly");
});

test("hides the merged Codex and work usage quota copy", () => {
  const alert = quotaAlert(mergedQuotaAlert);

  createEnvironment(new FakeElement("body", { children: [alert] }));

  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");
});

test("hides the merged quota banner without the possessive pronoun", () => {
  const banner = quotaAlert(mergedQuotaWithoutPronoun, { tagName: "div" });
  createEnvironment(new FakeElement("body", { children: [banner] }));
  assert.equal(banner.getAttribute(HIDDEN_ATTR), "true");
  assert.equal(banner.getAttribute(HIDDEN_KIND_ATTR), "quota-banner");
});

test("keeps the composer and quoted merged quota copy visible without the pronoun", () => {
  const banner = quotaAlert(mergedQuotaWithoutPronoun);
  const composer = new FakeElement("div", { attrs: { "data-codex-composer": "", contenteditable: "true" } });
  const root = new FakeElement("div", { attrs: { "data-codex-composer-root": "" }, children: [banner, composer] });
  const quote = quotaAlert(mergedQuotaWithoutPronoun);
  const article = new FakeElement("article", { children: [quote] });
  createEnvironment(new FakeElement("body", { children: [root, article] }));
  assert.equal(banner.getAttribute(HIDDEN_ATTR), "true");
  for (const node of [root, composer, article, quote]) assert.equal(node.getAttribute(HIDDEN_ATTR), null);
});

for (const surface of protectedSurfaces) {
  test(`does not hide a quota candidate that is ${surface.selector}`, () => {
    const candidate = quotaAlert(subagentQuotaCard, {
      tagName: surface.tagName,
      attrs: { role: "alert", ...surface.attrs },
    });

    createEnvironment(new FakeElement("body", { children: [candidate] }));

    assert.equal(candidate.getAttribute(HIDDEN_ATTR), null);
  });

  test(`does not hide a quota candidate containing ${surface.selector}`, () => {
    const protectedChild = new FakeElement(surface.tagName, { attrs: surface.attrs });
    const candidate = quotaAlert(subagentQuotaCard, { children: [protectedChild] });

    createEnvironment(new FakeElement("body", { children: [candidate] }));

    assert.equal(candidate.getAttribute(HIDDEN_ATTR), null);
  });
}

test("does not read layout for non-quota text", () => {
  const candidate = new FakeElement("aside", {
    text: "Project activity is available and the editor is ready.",
    rect: { width: 720, height: 80 },
  });

  createEnvironment(new FakeElement("body", { children: [candidate] }));

  assert.equal(candidate.layoutReads, 0);
});

test("scans only the added childList subtree", () => {
  const unrelated = new FakeElement("section", {
    children: [new FakeElement("div", { text: "Existing project activity" })],
  });
  const body = new FakeElement("body", { children: [unrelated] });
  const environment = createEnvironment(body);
  unrelated.resetAccessCounts({ subtree: true });

  const alert = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });
  body.appendChild(alert);
  environment.observers.find((observer) => observer.connected).emit([
    { type: "childList", target: body, addedNodes: [alert] },
  ]);
  environment.window.flushTimers();

  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");
  assert.equal(subtreeAccessReads(unrelated), 0, "unrelated existing DOM must not be rescanned");
});

test("does not hide outer ancestors when a quoted message is added", () => {
  const outer = new FakeElement("div");
  const body = new FakeElement("body", { children: [outer] });
  const environment = createEnvironment(body);
  const quote = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });
  const article = new FakeElement("article", { children: [quote] });

  outer.appendChild(article);
  environment.observers.find((observer) => observer.connected).emit([
    { type: "childList", target: outer, addedNodes: [article] },
  ]);
  environment.window.flushTimers();

  for (const node of [outer, article, quote]) {
    assert.equal(node.getAttribute(HIDDEN_ATTR), null);
  }
});

test("does not cross an added message boundary to revalidate an outer marker", () => {
  const outer = new FakeElement("div");
  const body = new FakeElement("body", { children: [outer] });
  const environment = createEnvironment(body);
  outer.setAttribute(HIDDEN_ATTR, "true");
  outer.setAttribute(HIDDEN_KIND_ATTR, "quota-banner");
  const quote = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });
  const article = new FakeElement("article", { children: [quote] });

  outer.appendChild(article);
  environment.observers.find((observer) => observer.connected).emit([
    { type: "childList", target: outer, addedNodes: [article] },
  ]);
  environment.window.flushTimers();

  assert.equal(outer.getAttribute(HIDDEN_ATTR), "true");
  assert.equal(quote.getAttribute(HIDDEN_ATTR), null);
});

test("drops a detached pending mutation root", () => {
  const body = new FakeElement("body");
  const environment = createEnvironment(body);
  const alert = quotaAlert(newOutOfMessagesAlert, { attrs: { role: "alert" } });

  body.appendChild(alert);
  environment.observers.find((observer) => observer.connected).emit([
    { type: "childList", target: body, addedNodes: [alert] },
  ]);
  alert.remove();
  assert.equal(alert.isConnected, false);
  environment.window.flushTimers();

  assert.equal(alert.getAttribute(HIDDEN_ATTR), null);
});

test("rescans a characterData parent and coalesces mutation timers", () => {
  const text = new FakeText("Project activity is available.");
  const button = new FakeElement("button", { text: "升级至 Plus" });
  const alert = new FakeElement("aside", {
    attrs: { role: "alert" },
    rect: { width: 720, height: 80 },
    children: [text, button],
  });
  const environment = createEnvironment(new FakeElement("body", { children: [alert] }));
  assert.equal(alert.getAttribute(HIDDEN_ATTR), null);

  text.textContent = newOutOfMessagesAlert;
  environment.observers.find((observer) => observer.connected).emit([
    { type: "characterData", target: text, addedNodes: [] },
    { type: "characterData", target: text, addedNodes: [] },
  ]);

  assert.equal(environment.window.pendingTimerCount, 1);
  environment.window.flushTimers();
  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");
});

test("revalidates a hidden alert when nested text stops matching", () => {
  const text = new FakeText(newOutOfMessagesAlert);
  const copy = new FakeElement("div", { children: [text] });
  const button = new FakeElement("button", { text: "Upgrade" });
  const alert = new FakeElement("aside", {
    rect: { width: 720, height: 80 },
    children: [copy, button],
  });
  const environment = createEnvironment(new FakeElement("body", { children: [alert] }));
  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");

  text.textContent = "Project activity is available and the editor is ready.";
  environment.observers.find((observer) => observer.connected).emit([
    { type: "characterData", target: text, addedNodes: [] },
  ]);
  environment.window.flushTimers();

  assert.equal(alert.getAttribute(HIDDEN_ATTR), null);
  assert.equal(alert.getAttribute(HIDDEN_KIND_ATTR), null);
});

test("reinjects with one active observer and one style", () => {
  const environment = createEnvironment(new FakeElement("body"));

  environment.runScript();
  environment.window.flushTimers();

  assert.equal(environment.activeObserverCount, 1);
  assert.equal(styleCount(environment.document), 1);
});

test("scans a populated body mounted after documentElement", () => {
  const environment = createEnvironment(null, { documentElementReady: true });
  const alert = quotaAlert(newOutOfMessagesAlert);
  const body = new FakeElement("body", { children: [alert] });

  environment.mountBody(body);
  environment.window.flushTimers();

  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");
});

test("a stale API cannot destroy the current instance effects", () => {
  const alert = quotaAlert(newOutOfMessagesAlert);
  const environment = createEnvironment(new FakeElement("body", { children: [alert] }));
  const staleApi = environment.window[API_KEY];

  environment.runScript();
  environment.window.flushTimers();
  const currentApi = environment.window[API_KEY];
  staleApi.destroy();

  assert.equal(environment.window[API_KEY], currentApi);
  assert.equal(environment.activeObserverCount, 1);
  assert.equal(styleCount(environment.document), 1);
  assert.equal(alert.getAttribute(HIDDEN_ATTR), "true");
});

test("manual scan is idempotent", () => {
  const alert = quotaAlert(newOutOfMessagesAlert);
  const environment = createEnvironment(new FakeElement("body", { children: [alert] }));
  const api = environment.window[API_KEY];
  const matches = api.state.matches;

  api.scan();
  api.scan();

  assert.equal(api.state.matches, matches);
  assert.equal(environment.document.querySelectorAll(`[${HIDDEN_ATTR}="true"]`).length, 1);
  assert.equal(styleCount(environment.document), 1);
});

test("destroy removes hidden and kind markers, including stale markers", () => {
  const tracked = quotaAlert(newOutOfMessagesAlert);
  const body = new FakeElement("body", { children: [tracked] });
  const environment = createEnvironment(body);
  const stale = new FakeElement("div", {
    attrs: { [HIDDEN_ATTR]: "true", [HIDDEN_KIND_ATTR]: "quota-banner" },
  });
  const kindOnly = new FakeElement("div", {
    attrs: { [HIDDEN_KIND_ATTR]: "usage-card" },
  });
  body.appendChild(stale);
  body.appendChild(kindOnly);

  environment.window[API_KEY].destroy();

  const markerState = [tracked, stale, kindOnly].map((node) => ({
    hidden: node.getAttribute(HIDDEN_ATTR),
    kind: node.getAttribute(HIDDEN_KIND_ATTR),
  }));
  assert.deepEqual(markerState, [
    { hidden: null, kind: null },
    { hidden: null, kind: null },
    { hidden: null, kind: null },
  ]);
});

test("revalidates a detached stale marker when the node is reattached", () => {
  const alert = quotaAlert(newOutOfMessagesAlert);
  const body = new FakeElement("body", { children: [alert] });
  const environment = createEnvironment(body);
  const firstApi = environment.window[API_KEY];

  alert.remove();
  firstApi.destroy();
  alert.textContent = "Project activity is available and the editor is ready.";
  environment.runScript();
  body.appendChild(alert);
  environment.observers.find((observer) => observer.connected).emit([
    { type: "childList", target: body, addedNodes: [alert] },
  ]);
  environment.window.flushTimers();

  assert.equal(alert.getAttribute(HIDDEN_ATTR), null);
  assert.equal(alert.getAttribute(HIDDEN_KIND_ATTR), null);
});

test("destroy stops the runtime and remains safe when called twice", () => {
  const body = new FakeElement("body");
  const environment = createEnvironment(body);
  const api = environment.window[API_KEY];
  const destroy = api.destroy;
  const added = quotaAlert(newOutOfMessagesAlert);
  body.appendChild(added);
  environment.observers.find((observer) => observer.connected).emit([
    { type: "childList", target: body, addedNodes: [added] },
  ]);
  assert.equal(environment.window.pendingTimerCount, 1);

  destroy();

  assert.deepEqual(
    {
      activeObservers: environment.activeObserverCount,
      apiPresent: Object.hasOwn(environment.window, API_KEY),
      pendingTimers: environment.window.pendingTimerCount,
      styles: styleCount(environment.document),
    },
    { activeObservers: 0, apiPresent: false, pendingTimers: 0, styles: 0 }
  );
  assert.doesNotThrow(() => destroy());
});

test("does not retain persistent DOM Sets in public API state", () => {
  const environment = createEnvironment(new FakeElement("body"));
  const state = environment.window[API_KEY].state;
  const persistentSetKeys = Object.entries(state)
    .filter(
      ([key, value]) =>
        key !== "pendingRoots" && Object.prototype.toString.call(value) === "[object Set]"
    )
    .map(([key]) => key);

  assert.deepEqual(persistentSetKeys, []);
  if (Object.hasOwn(state, "pendingRoots")) assert.equal(state.pendingRoots.size, 0);
});

test("defers initialization until document roots exist and starts once", () => {
  const environment = createEnvironment(null, { autoRun: false });

  assert.doesNotThrow(() => environment.runScript());
  assert.ok(environment.window[API_KEY]);
  assert.equal(environment.activeObserverCount, 0);
  assert.equal(styleCount(environment.document), 0);

  environment.attachBody(new FakeElement("body"));
  environment.document.fire("DOMContentLoaded");
  environment.document.fire("DOMContentLoaded");
  environment.window.flushTimers();

  assert.equal(environment.activeObserverCount, 1);
  assert.equal(styleCount(environment.document), 1);
  assert.equal(environment.document.listenerCount("DOMContentLoaded"), 0);
});

test("destroy before DOMContentLoaded cancels deferred startup", () => {
  const environment = createEnvironment(null, { autoRun: false });
  assert.doesNotThrow(() => environment.runScript());
  const destroy = environment.window[API_KEY].destroy;

  destroy();
  environment.attachBody(new FakeElement("body"));
  environment.document.fire("DOMContentLoaded");
  environment.window.flushTimers();

  assert.deepEqual(
    {
      activeObservers: environment.activeObserverCount,
      apiPresent: Object.hasOwn(environment.window, API_KEY),
      pendingTimers: environment.window.pendingTimerCount,
      styles: styleCount(environment.document),
    },
    { activeObservers: 0, apiPresent: false, pendingTimers: 0, styles: 0 }
  );
});

test("does not initialize inside a child frame", () => {
  const environment = createEnvironment(new FakeElement("body"), {
    autoRun: false,
    topLevel: false,
  });

  environment.runScript();
  environment.window.flushTimers();

  assert.deepEqual(
    {
      activeObservers: environment.activeObserverCount,
      apiPresent: Object.hasOwn(environment.window, API_KEY),
      styles: styleCount(environment.document),
    },
    { activeObservers: 0, apiPresent: false, styles: 0 }
  );
});
