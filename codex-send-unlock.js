(() => {
  if (window.top && window.self && window.top !== window.self) return;

  const API_KEY = "__codexPlusSendUnlock";
  const STYLE_ID = "codex-plus-send-unlock-style";
  const HIDDEN_ATTR = "data-codex-plus-hidden-quota-alert";
  const HIDDEN_KIND_ATTR = `${HIDDEN_ATTR}-kind`;
  const HIDDEN_MARKER_SELECTOR = `[${HIDDEN_ATTR}], [${HIDDEN_KIND_ATTR}]`;
  const SCRIPT_VERSION = "1.1.0";
  const PROTECTED_SURFACE_SELECTOR = [
    "[data-codex-composer-root]",
    "[data-codex-composer]",
    "[contenteditable]",
    "textarea",
    "input",
    "form",
  ].join(",");
  const MESSAGE_CONTENT_SELECTOR = [
    "[data-message-author-role]",
    "[data-testid*='message' i]",
    "[data-test-id*='message' i]",
    "[data-thread-find-target]",
    "article",
  ].join(",");
  const CANDIDATE_SELECTOR_GROUPS = [
    "aside",
    '[role="alert"],[role="status"],[aria-live]',
    "header,section,div",
  ];

  const previous = window[API_KEY];
  const legacy = window.__codexPlusHideUsageAlert;
  if (legacy && typeof legacy.destroy === "function") {
    legacy.destroy();
  }
  if (previous && typeof previous.destroy === "function") {
    previous.destroy();
  }

  const state = {
    observer: null,
    timer: 0,
    readyHandler: null,
    pendingRoots: new Set(),
    scans: 0,
    matches: 0,
    sendUnlock: { clients: 0, queries: 0, updates: 0, error: null },
  };
  const queryClients = new Map();
  const patchedQueries = new Map();
  let destroyed = false;

  const quotaBannerRe =
    /((?:你的\s*)?Codex\s*和\s*工作使用额度已用完|你的\s*Codex\s*消息限额已用尽|Codex\s*消息限额已用尽|message\s+limit|usage\s+limit|you['’]?re\s+out\s+of\s+Codex\s+messages|out\s+of\s+Codex\s+messages|你的\s*Codex\s*已用完|你的\s*Codex\s*消息\s*额度|你的\s*速率限制|速率限制\s*(?:将于|重置))/i;
  const quotaResetRe =
    /(额度将于|继续使用\s*Codex|升级至\s*Plus|quota\s+will\s+reset|limit\s+will\s+reset|rate\s+limit\s+resets|resets?\s+on|continue\s+using\s+Codex|start\s+your\s+free\s+trial\s+of\s+Plus|upgrade\s+to\s+plus|速率限制|将于\s*\d|重置)/i;
  const actionTextRe =
    /(升级|Plus|upgrade|pricing|plan|重置|reset|限额|额度|限制|limit|quota)/i;

  // Magpie already handles the request route. Only change the renderer's
  // message-quota gates, keeping the original usage counters and account data.
  function unlockLimit(limit) {
    if (!limit || typeof limit !== "object") return limit;
    if (limit.allowed !== false && limit.limit_reached !== true) return limit;
    return { ...limit, allowed: true, limit_reached: false };
  }

  function isMessageQuotaBanner(banner) {
    const type = banner?.banner_type;
    if (typeof type !== "string") return false;
    // These are protocol categories, not translated titles or CSS classes.
    // Credit depletion, image limits, reserve notices and spend controls are
    // separate categories and keep their original presentation.
    return type === "rate_limit_reached" || type.endsWith("_rate_limit_reached") ||
      type === "selected_model_limit_reached" ||
      type === "workspace_member_usage_limit_reached" ||
      type === "workspace_owner_usage_limit_reached";
  }

  function unlockStatus(data) {
    if (!data || typeof data !== "object" || !data.rate_limit) return data;
    const rateLimit = unlockLimit(data.rate_limit);
    const hideBanner = isMessageQuotaBanner(data.rate_limit_upsell);
    let changed = rateLimit !== data.rate_limit || hideBanner;
    const additional = Array.isArray(data.additional_rate_limits)
      ? data.additional_rate_limits.map((entry) => {
          if (!entry || typeof entry !== "object") return entry;
          const limit = unlockLimit(entry.rate_limit);
          if (limit === entry.rate_limit) return entry;
          changed = true;
          return { ...entry, rate_limit: limit };
        })
      : data.additional_rate_limits;
    if (!changed) return data;
    const next = { ...data, rate_limit: rateLimit, additional_rate_limits: additional };
    if (hideBanner) delete next.rate_limit_upsell;
    return next;
  }

  function isMessageQuotaQuery(query) {
    const key = query?.queryKey;
    // The current app uses either [rate-limit-status] (polling) or
    // [rate-limit-status, userId, accountId] (push). Exclude image generation
    // and checkout/continuation queries even though they share the prefix.
    return Array.isArray(key) && key[0] === "rate-limit-status" &&
      (key.length === 1 || (key.length === 3 &&
        typeof key[1] === "string" && typeof key[2] === "string" &&
        !["image-generation", "work-credit-continuation"].includes(key[1])));
  }

  function patchQuery(query) {
    if (destroyed || !isMessageQuotaQuery(query) || patchedQueries.has(query)) return;
    if (typeof query.setData !== "function" || typeof query.setState !== "function") return;
    const original = query.setData;
    const ownDescriptor = Object.getOwnPropertyDescriptor(query, "setData");
    const record = { original, ownDescriptor, raw: query.state?.data, patched: null, updatedAt: query.state?.dataUpdatedAt };
    const wrapped = function (data, options) {
      const next = unlockStatus(data);
      const result = original.call(this, next, options);
      record.raw = data;
      record.patched = next !== data ? this.state.data : null;
      record.updatedAt = this.state.dataUpdatedAt;
      if (next !== data) state.sendUnlock.updates += 1;
      return result;
    };
    query.setData = wrapped;
    record.wrapped = wrapped;
    patchedQueries.set(query, record);
    state.sendUnlock.queries = patchedQueries.size;
    const raw = query.state?.data;
    if (unlockStatus(raw) !== raw) {
      wrapped.call(query, raw, { updatedAt: record.updatedAt, manual: true });
    }
  }

  function connectQueryClient(client) {
    if (!client || queryClients.has(client) || typeof client.getQueryCache !== "function") return;
    const cache = client.getQueryCache();
    if (typeof cache?.getAll !== "function" || typeof cache?.subscribe !== "function") return;
    queryClients.set(client, cache.subscribe((event) => {
      if (destroyed) return;
      try {
        if (event.type === "removed") {
          restoreQuery(event.query, false);
        } else {
          patchQuery(event.query);
        }
      } catch (error) {
        state.sendUnlock.error = String(error?.message || error);
      }
    }));
    state.sendUnlock.clients = queryClients.size;
    for (const query of cache.getAll()) patchQuery(query);
  }

  function restoreQuery(query, restoreData = true) {
    const record = patchedQueries.get(query);
    if (!record) return;
    patchedQueries.delete(query);
    if (query.setData === record.wrapped) {
      if (record.ownDescriptor) Object.defineProperty(query, "setData", record.ownDescriptor);
      else delete query.setData;
    }
    if (restoreData && record.patched && query.state?.data === record.patched) {
      query.setState({ data: record.raw, dataUpdatedAt: record.updatedAt });
    }
    state.sendUnlock.queries = patchedQueries.size;
  }

  function discoverQueryClients(root = document.body || document.documentElement) {
    if (destroyed) return;
    if (!isElement(root)) return;
    // React providers expose the existing query client. Follow only the
    // provider/scope fields; never walk message contents or application state.
    const seen = new Set();
    const inspect = (value, depth = 0) => {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
      seen.add(value);
      if (typeof value.getQueryCache === "function") {
        connectQueryClient(value);
        return;
      }
      if (Object.prototype.toString.call(value) === "[object Map]") {
        for (const entry of value.values()) inspect(entry, depth + 1);
        return;
      }
      for (const key of ["queryClient", "client", "node", "scope", "value"]) {
        inspect(value[key], depth + 1);
      }
    };
    const anchors = [root, ...root.querySelectorAll("[data-codex-composer-root]")];
    if (root === document.body && root.firstElementChild) anchors.push(root.firstElementChild);
    try {
      const fibers = new Set();
      for (const anchor of anchors) {
        const key = Object.keys(anchor).find((name) => name.startsWith("__reactFiber$"));
        for (let fiber = key && anchor[key]; fiber && !fibers.has(fiber); fiber = fiber.return) {
          fibers.add(fiber);
          inspect(fiber.memoizedProps?.value);
          inspect(fiber.memoizedProps?.queryClient);
          for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) {
            inspect(dep.memoizedValue);
          }
        }
      }
    } catch (error) {
      state.sendUnlock.error = String(error?.message || error);
    }
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isElement(node) {
    return !!node && node.nodeType === Node.ELEMENT_NODE;
  }

  function candidateText(node) {
    if (!isElement(node)) return "";
    return normalizeText(node.textContent || node.innerText || "");
  }

  function isProtectedSurface(node) {
    return isElement(node) && (
      node.matches(PROTECTED_SURFACE_SELECTOR) ||
      !!node.querySelector(PROTECTED_SURFACE_SELECTOR)
    );
  }

  function visibleBox(node) {
    const rect = node.getBoundingClientRect();
    if (!rect || rect.width < 180 || rect.height < 16) return false;
    if (rect.bottom <= 0 || rect.top >= (window.innerHeight || 900)) return false;
    if (rect.right <= 0 || rect.left >= (window.innerWidth || 1200)) return false;
    return true;
  }

  function bannerBox(node) {
    if (!visibleBox(node)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 300 || rect.height < 30 || rect.height > 220) return false;
    return true;
  }

  function intersectsConversationContent(node) {
    return isElement(node) && (
      !!node.closest(MESSAGE_CONTENT_SELECTOR) ||
      !!node.querySelector(MESSAGE_CONTENT_SELECTOR)
    );
  }

  function hasAction(node, text) {
    const actions = Array.from(node.querySelectorAll("button, a, [role='button']")).slice(0, 8);
    if (!actions.length) return false;

    const actionableText = normalizeText(
      actions
        .map((item) => item.innerText || item.textContent || item.getAttribute("aria-label") || "")
        .join(" ")
    );

    return actionTextRe.test(`${text} ${actionableText}`);
  }

  function looksLikeQuotaBanner(node) {
    if (isProtectedSurface(node)) return false;
    if (intersectsConversationContent(node)) return false;
    const text = candidateText(node);
    if (text.length < 20 || text.length > 420) return false;
    if (!quotaBannerRe.test(text)) return false;
    if (!/Codex/i.test(text)) return false;
    if (!quotaResetRe.test(text)) return false;
    if (!hasAction(node, text)) return false;

    return bannerBox(node);
  }

  function hideNode(node, kind) {
    if (!isElement(node) || node === document.body || node === document.documentElement) return false;
    if (node.getAttribute(HIDDEN_ATTR) === "true") return false;
    if (isProtectedSurface(node) || intersectsConversationContent(node)) return false;
    node.setAttribute(HIDDEN_ATTR, "true");
    node.setAttribute(HIDDEN_KIND_ATTR, kind);
    state.matches += 1;
    return true;
  }

  function clearHiddenMarkers(root) {
    const clear = (node) => {
      node.removeAttribute(HIDDEN_ATTR);
      node.removeAttribute(HIDDEN_KIND_ATTR);
    };

    if (isElement(root) && root.matches(HIDDEN_MARKER_SELECTOR)) clear(root);
    for (const node of root.querySelectorAll(HIDDEN_MARKER_SELECTOR)) clear(node);
  }

  function installStyle() {
    if (!document.documentElement) return false;
    if (document.getElementById(STYLE_ID)) return true;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${HIDDEN_ATTR}="true"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
    return true;
  }

  function collectCandidates(root) {
    if (!isElement(root)) return [];

    const candidates = [];
    const seen = new Set();
    const add = (node) => {
      if (!seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    };

    for (const selector of CANDIDATE_SELECTOR_GROUPS) {
      const matches = Array.from(root.querySelectorAll(selector));
      if (root.matches(selector)) matches.unshift(root);
      for (let index = matches.length - 1; index >= 0; index -= 1) add(matches[index]);
    }
    return candidates;
  }

  function classifyCandidate(node) {
    if (!isElement(node)) return false;
    if (node.closest(`[${HIDDEN_ATTR}="true"]`)) return false;
    if (node.querySelector(`[${HIDDEN_ATTR}="true"]`)) return false;

    if (looksLikeQuotaBanner(node)) return hideNode(node, "quota-banner");
    return false;
  }

  function scanSubtree(root) {
    if (!isElement(root)) return false;
    state.scans += 1;
    if (!queryClients.size) discoverQueryClients(root);
    for (const node of collectCandidates(root)) classifyCandidate(node);
    return true;
  }

  function scan(root = document.body || document.documentElement) {
    if (!isElement(root)) return false;
    installStyle();
    return scanSubtree(root);
  }

  function isCandidate(node) {
    return isElement(node) && CANDIDATE_SELECTOR_GROUPS.some((selector) => node.matches(selector));
  }

  function isMutationBoundary(node) {
    if (!isElement(node)) return true;
    if (node === document.body || node === document.documentElement) return true;
    if (node.matches("[data-codex-composer-root]")) return true;
    return node.matches(MESSAGE_CONTENT_SELECTOR);
  }

  function markedMutationRoot(root) {
    for (let node = root; node; node = node.parentElement) {
      const boundary = isMutationBoundary(node);
      if (node.matches(HIDDEN_MARKER_SELECTOR) && (node === root || !boundary)) return node;
      if (boundary) break;
    }
    return root;
  }

  function scanMutationRoot(root) {
    if (!isElement(root) || root === document.documentElement) return;
    const scanRoot = markedMutationRoot(root);
    clearHiddenMarkers(scanRoot);
    scanSubtree(scanRoot);
    if (scanRoot === document.body || scanRoot.matches(MESSAGE_CONTENT_SELECTOR)) return;

    for (let ancestor = scanRoot.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (isMutationBoundary(ancestor)) break;
      if (isCandidate(ancestor)) classifyCandidate(ancestor);
    }
  }

  function flushPendingRoots() {
    state.timer = 0;
    const roots = new Set(state.pendingRoots);
    state.pendingRoots.clear();
    if (!roots.size) return;

    for (const root of roots) {
      if (!document.documentElement?.contains(root)) continue;
      let parent = root.parentElement;
      while (parent && !roots.has(parent)) parent = parent.parentElement;
      if (!parent) scanMutationRoot(root);
    }
  }

  function queueRoot(root) {
    if (!isElement(root) || root === document.documentElement) return;
    state.pendingRoots.add(root);
    if (!state.timer) state.timer = window.setTimeout(flushPendingRoots, 80);
  }

  function installObserver() {
    const root = document.body || document.documentElement;
    if (!isElement(root)) return false;
    if (state.observer) return true;

    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          queueRoot(mutation.target?.parentElement);
          continue;
        }
        if (mutation.type !== "childList") continue;
        for (const added of mutation.addedNodes || []) {
          queueRoot(isElement(added) ? added : added.parentElement);
        }
      }
    });
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return true;
  }

  function start() {
    const root = document.body || document.documentElement;
    if (!document.documentElement || !isElement(root)) return false;

    installStyle();
    scanSubtree(root);
    installObserver();
    return true;
  }

  function destroy() {
    const ownsRuntime = window[API_KEY]?.state === state;
    destroyed = true;
    for (const unsubscribe of queryClients.values()) unsubscribe();
    queryClients.clear();
    state.sendUnlock.clients = 0;
    for (const query of patchedQueries.keys()) restoreQuery(query);
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = 0;
    state.pendingRoots.clear();
    state.observer?.disconnect();
    state.observer = null;
    if (state.readyHandler) {
      document.removeEventListener("DOMContentLoaded", state.readyHandler);
      state.readyHandler = null;
    }
    if (!ownsRuntime) return;
    clearHiddenMarkers(document);
    document.getElementById(STYLE_ID)?.remove();
    if (window[API_KEY]?.version === SCRIPT_VERSION) {
      delete window[API_KEY];
    }
  }

  window[API_KEY] = {
    version: SCRIPT_VERSION,
    state,
    scan,
    refreshSendUnlock: discoverQueryClients,
    destroy,
  };

  if (!start()) {
    state.readyHandler = () => {
      const handler = state.readyHandler;
      state.readyHandler = null;
      if (handler) document.removeEventListener("DOMContentLoaded", handler);
      start();
    };
    document.addEventListener("DOMContentLoaded", state.readyHandler, { once: true });
  }
  const hostRuntime = window.__codexPlusUserScripts;
  if (hostRuntime?.currentKey && typeof hostRuntime.registerCleanup === "function") {
    hostRuntime.registerCleanup(destroy);
  }
})();
