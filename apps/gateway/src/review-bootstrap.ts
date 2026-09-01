import { REVIEW_MENTIONS_VIEW_SOURCE } from "./review-mentions-view.ts";
import { REVIEW_THREAD_VIEW_SOURCE } from "./review-thread-view.ts";

export const REVIEW_REFRESH_COORDINATOR_SOURCE = `(loadOnce) => {
  let refreshPromise;
  let refreshDirty = false;
  return () => {
    if (refreshPromise !== undefined) {
      refreshDirty = true;
      return refreshPromise;
    }
    refreshPromise = (async () => {
      do {
        refreshDirty = false;
        await loadOnce();
      } while (refreshDirty);
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };
}`;

export const REVIEW_BOOTSTRAP_SOURCE = `
const overlayTag = "review-tunnel-overlay";
if (document.querySelector(overlayTag) === null) {
  const host = document.createElement(overlayTag);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  const bootstrapScript = [...document.scripts].find((script) =>
    script.src.endsWith("/_review-tunnel/review/bootstrap.js")
  );
  if (bootstrapScript?.nonce) style.nonce = bootstrapScript.nonce;
  style.textContent = [
    ":host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; pointer-events: none; color-scheme: light; }",
    ".marker-layer, .selection-layer { position: fixed; inset: 0; width: 100%; height: 100%; }",
    ".marker-layer { z-index: 1; pointer-events: none; overflow: hidden; }",
    ".marker[hidden] { display: none; }",
    ".selection-layer { z-index: 2; pointer-events: auto; cursor: crosshair; touch-action: none; background: rgba(20, 87, 217, .025); }",
    ".selection-layer[hidden] { display: none; }",
    ".selection-preview { fill: rgba(20, 87, 217, .13); stroke: #1457d9; stroke-width: 2; pointer-events: none; }",
    ".selection-preview[hidden] { display: none; }",
    ".marker { pointer-events: auto; cursor: pointer; outline: none; }",
    ".marker-shape { fill: rgba(20, 87, 217, .82); stroke: #1457d9; stroke-width: 2; filter: drop-shadow(0 2px 4px rgba(15, 23, 42, .25)); }",
    ".marker.point .marker-shape { fill: #1457d9; }",
    ".marker.rect .marker-shape { fill: rgba(20, 87, 217, .08); pointer-events: stroke; }",
    ".marker.approximate .marker-shape { stroke-dasharray: 5 4; }",
    ".marker.active .marker-shape { fill: rgba(240, 68, 56, .2); stroke: #f04438; stroke-width: 3; }",
    ".marker.point.active .marker-shape { fill: #f04438; }",
    ".marker:focus-visible .marker-shape { stroke: #f04438; stroke-width: 4; }",
    ".marker-label { fill: #fff; pointer-events: none; text-anchor: middle; font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; }",
    ".marker.rect .marker-label { fill: #1457d9; stroke: #fff; stroke-width: 3px; paint-order: stroke; pointer-events: auto; }",
    ".marker.rect.active .marker-label { fill: #f04438; }",
    ".mention-options button[aria-selected=true] { background: #dbe8ff; }",
    ".panel { position: fixed; z-index: 3; top: 16px; right: 16px; width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 16px; border: 1px solid #d7dce2; border-radius: 12px; background: #fff; color: #17202a; box-shadow: 0 16px 48px rgba(15, 23, 42, .2); font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; pointer-events: auto; }",
    ".panel[hidden], .review-launcher[hidden] { display: none; }",
    ".review-launcher { position: fixed; bottom: 16px; right: 16px; z-index: 4; pointer-events: auto; padding: 12px 16px; border-radius: 24px; box-shadow: 0 4px 20px #0003; }",
    ".review-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; }",
    ".review-filters select { padding: 6px; border: 1px solid #bcccdc; border-radius: 6px; background: white; color: #17202a; font: inherit; }",
    ".review-filters label { display: flex; align-items: center; gap: 4px; }",
    ".edit-form { margin-top: 8px; padding: 8px; border: 1px solid #bcccdc; border-radius: 8px; }",
    "@media (max-width: 600px) { .panel { top: auto; bottom: 8px; right: 8px; width: calc(100vw - 16px); max-height: 65vh; max-height: 65dvh; } }",
    ".heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }",
    "h2 { margin: 0; font-size: 16px; }",
    ".context, .status, .selection-state { color: #52606d; font-size: 12px; }",
    ".comments { display: grid; gap: 10px; margin: 12px 0; padding: 0; list-style: none; }",
    ".notification-panel { margin-top: 10px; padding: 8px; border: 1px solid #d7dce2; border-radius: 8px; background: #fbfcfd; }",
    ".notification-panel summary { cursor: pointer; color: #334e68; font-weight: 650; }",
    ".notifications { display: grid; gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }",
    ".notification { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px; border-radius: 6px; background: #eef4ff; font-size: 12px; }",
    ".notification.read { color: #697586; background: #f4f6f8; }",
    ".comment { padding: 10px; border: 1px solid transparent; border-radius: 8px; background: #f4f6f8; overflow-wrap: anywhere; }",
    ".comment.active { border-color: #f04438; background: #fff5f4; }",
    ".thread-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }",
    ".thread-status { color: #52606d; font-size: 11px; font-weight: 650; text-transform: uppercase; }",
    ".comment-body, .reply-body { white-space: pre-wrap; }",
    ".author { margin-bottom: 4px; color: #334e68; font-weight: 650; }",
    ".anchor-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: #1457d9; font-size: 12px; }",
    ".anchor-state { margin-top: 4px; color: #52606d; font-size: 12px; }",
    ".pin-controls { margin: 10px 0; }",
    ".content-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }",
    ".danger-button { color: #b42318; background: #ffebe9; }",
    ".tombstone { color: #697586; font-style: italic; }",
    ".replies { display: grid; gap: 8px; margin: 10px 0 0 12px; padding-left: 10px; border-left: 2px solid #d7dce2; }",
    ".reply { padding: 8px; border-radius: 6px; background: #fff; }",
    "form { display: grid; gap: 8px; }",
    ".selection-controls { display: flex; align-items: center; gap: 8px; }",
    ".selection-state { flex: 1; }",
    ".reply-form { margin-top: 10px; }",
    ".reply-form textarea { min-height: 54px; }",
    "textarea { min-height: 76px; box-sizing: border-box; resize: vertical; border: 1px solid #bcccdc; border-radius: 8px; padding: 8px; color: #17202a; background: #fff; font: inherit; }",
    "button { justify-self: end; border: 0; border-radius: 8px; padding: 8px 12px; color: #fff; background: #1457d9; font: inherit; font-weight: 650; cursor: pointer; }",
    ".secondary-button, .anchor-button, .status-button { color: #1457d9; background: #e8f0ff; }",
    ".small-button { padding: 5px 8px; font-size: 12px; }",
    ".status-button { margin-top: 10px; }",
    ".load-older { width: 100%; justify-self: stretch; margin-bottom: 10px; }",
    "button:disabled { cursor: wait; opacity: .6; }",
    ".error { color: #b42318; }",
  ].join("");

  const svgNamespace = "http://www.w3.org/2000/svg";
  const markerLayer = document.createElementNS(svgNamespace, "svg");
  markerLayer.setAttribute("class", "marker-layer");
  markerLayer.setAttribute("aria-hidden", "false");
  const selectionLayer = document.createElementNS(svgNamespace, "svg");
  selectionLayer.setAttribute("class", "selection-layer");
  selectionLayer.setAttribute("hidden", "");
  selectionLayer.setAttribute("aria-label", "Select review area or pin");
  const selectionPreview = document.createElementNS(svgNamespace, "rect");
  selectionPreview.setAttribute("class", "selection-preview");
  selectionPreview.setAttribute("hidden", "");
  selectionLayer.append(selectionPreview);

  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("aria-label", "Review Tunnel comments");
  const heading = document.createElement("div");
  heading.className = "heading";
  const title = document.createElement("h2");
  title.textContent = "Page review";
  const contextLabel = document.createElement("span");
  contextLabel.className = "context";
  const collapseButton = document.createElement("button");
  collapseButton.type = "button";
  collapseButton.className = "secondary-button small-button";
  collapseButton.textContent = "Close review panel";
  heading.append(title, contextLabel, collapseButton);
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "review-launcher";
  launcher.textContent = "Review";
  launcher.setAttribute("aria-label", "Open review panel");
  const readPreference = (key, fallback) => { try { return sessionStorage.getItem("review-tunnel:" + key) ?? fallback; } catch { return fallback; } };
  const savePreference = (key, value) => { try { sessionStorage.setItem("review-tunnel:" + key, value); } catch {} };
  let panelOpen = readPreference("panel-open", innerWidth <= 600 ? "false" : "true") === "true";
  panel.hidden = !panelOpen;
  launcher.hidden = panelOpen;
  const filters = document.createElement("div");
  filters.className = "review-filters";
  const statusFilter = document.createElement("select");
  statusFilter.setAttribute("aria-label", "Comment status");
  for (const [value, label] of [["OPEN", "Unresolved"], ["ALL", "All"], ["RESOLVED", "Resolved"]]) {
    const option = document.createElement("option");
    option.value = value; option.textContent = label; statusFilter.append(option);
  }
  const savedFilter = readPreference("comment-status", "OPEN");
  statusFilter.value = ["OPEN", "ALL", "RESOLVED"].includes(savedFilter) ? savedFilter : "OPEN";
  const authorLabel = document.createElement("label");
  const authorFilter = document.createElement("input");
  authorFilter.type = "checkbox";
  authorFilter.checked = readPreference("comment-mine", "false") === "true";
  authorLabel.append(authorFilter, document.createTextNode("Started by me"));
  filters.append(statusFilter, authorLabel);
  const pinControls = document.createElement("div");
  pinControls.className = "pin-controls";
  const pinVisibilityButton = document.createElement("button");
  pinVisibilityButton.type = "button";
  pinVisibilityButton.className = "secondary-button small-button";
  pinVisibilityButton.textContent = "Hide all pins";
  pinVisibilityButton.setAttribute("aria-pressed", "true");
  pinControls.append(pinVisibilityButton);
  const status = document.createElement("div");
  status.className = "status";
  status.setAttribute("role", "status");
  const notificationPanel = document.createElement("details");
  notificationPanel.className = "notification-panel";
  const notificationSummary = document.createElement("summary");
  notificationSummary.textContent = "Notifications (0)";
  const notifications = document.createElement("ol");
  notifications.className = "notifications";
  notificationPanel.append(notificationSummary, notifications);
  const comments = document.createElement("ol");
  comments.className = "comments";
  const loadOlderButton = document.createElement("button");
  loadOlderButton.type = "button";
  loadOlderButton.className = "secondary-button load-older";
  loadOlderButton.textContent = "Load older comments";
  loadOlderButton.hidden = true;
  const form = document.createElement("form");
  const body = document.createElement("textarea");
  body.name = "body";
  body.maxLength = 4000;
  body.required = true;
  body.placeholder = "Leave feedback; mention participants with @username";
  body.setAttribute("aria-label", "Comment");
  const selectionControls = document.createElement("div");
  selectionControls.className = "selection-controls";
  const selectionButton = document.createElement("button");
  selectionButton.type = "button";
  selectionButton.className = "secondary-button small-button";
  selectionButton.textContent = "Select area or pin";
  const clearSelectionButton = document.createElement("button");
  clearSelectionButton.type = "button";
  clearSelectionButton.className = "secondary-button small-button";
  clearSelectionButton.textContent = "Clear";
  clearSelectionButton.hidden = true;
  const selectionState = document.createElement("span");
  selectionState.className = "selection-state";
  selectionState.textContent = "Page comment";
  selectionControls.append(selectionButton, clearSelectionButton, selectionState);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Comment";
  form.append(body, selectionControls, submit);
  panel.append(heading, pinControls, filters, status, notificationPanel, comments, loadOlderButton, form);
  root.append(style, markerLayer, selectionLayer, panel, launcher);
  document.documentElement.append(host);

  const pageDrafts = new Map();
  let draftPath = location.pathname;
  body.addEventListener("input", () => pageDrafts.set(draftPath, body.value));
  let context;
  let loadSequence = 0;
  let commentPage = { comments: [], openCount: 0, eventCursor: "0", pageInfo: { hasMore: false } };
  let commentPath;
  let activeThreadId;
  let pendingAnchor;
  let selectionStart;
  let eventSource;
  let eventPath;
  let pinsVisible = true;
  try { pinsVisible = sessionStorage.getItem("review-tunnel:show-pins") !== "false"; } catch {}
  const pinOverrides = new Map();
  const wantsPinVisible = (threadId) => pinOverrides.get(threadId) ?? pinsVisible;
  const api = "/_review-tunnel/review";
  const readJson = async (response) => {
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        threadView.clear();
        pageDrafts.clear();
        body.value = "";
        commentPage = { comments: [], openCount: 0, eventCursor: "0", pageInfo: { hasMore: false } };
        renderComments();
      }
      throw new Error(typeof value.error === "string" ? value.error : "HTTP_" + response.status);
    }
    return value;
  };
  const readReview = async (path) => readJson(await fetch(api + path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }));
  const mutateReview = async (path, method, command) => readJson(await fetch(api + path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(command),
  }));
  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.className = isError ? "status error" : "status";
  };
  const setPassiveStatus = (message) => {
    if (!status.classList.contains("error")) setStatus(message);
  };
  const runMutationAction = async (button, pendingMessage, failurePrefix, action) => {
    button.disabled = true;
    if (pendingMessage !== undefined) setStatus(pendingMessage);
    try {
      await action();
    } catch (error) {
      setStatus(failurePrefix + (error instanceof Error ? error.message : "unknown error"), true);
    } finally {
      button.disabled = false;
    }
  };
  const documentGeometry = () => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, innerWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, innerHeight),
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  });
  const canonicalCoordinate = (value) => Math.round(value * 1000000) / 1000000;
  const documentPoint = (clientX, clientY) => {
    const geometry = documentGeometry();
    return {
      x: Math.max(0, Math.min(geometry.width, clientX + scrollX)),
      y: Math.max(0, Math.min(geometry.height, clientY + scrollY)),
      clientX,
      clientY,
      geometry,
    };
  };
  const findAnchorElement = (identity) => {
    const matches = document.querySelectorAll("[" + identity.attribute + "=" + CSS.escape(identity.value) + "]");
    return matches.length === 1 && matches[0] !== host ? matches[0] : undefined;
  };
  const elementAnchorFromSelection = (start, end, dragged) => {
    const left = dragged ? Math.min(start.clientX, end.clientX) : end.clientX;
    const top = dragged ? Math.min(start.clientY, end.clientY) : end.clientY;
    const right = dragged ? Math.max(start.clientX, end.clientX) : end.clientX;
    const bottom = dragged ? Math.max(start.clientY, end.clientY) : end.clientY;
    const hit = document.elementsFromPoint((left + right) / 2, (top + bottom) / 2)
      .find((element) => element !== host);
    // Prefer an explicit review identity; never guess by text, CSS classes, or child order.
    for (const attribute of ["data-review-id", "id"]) {
      for (let element = hit; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
        const value = element.getAttribute(attribute);
        if (!value || !value.trim() || value.length > 256 || /[\\u0000-\\u001f\\u007f]/.test(value)) continue;
        if (findAnchorElement({ attribute, value }) !== element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || left < rect.left || top < rect.top || right > rect.right || bottom > rect.bottom) continue;
        // A whole-page app wrapper is no more precise than a page-coordinate anchor.
        if (attribute === "id" && rect.width >= end.geometry.width * .9 && rect.height >= end.geometry.height * .9) continue;
        const x = canonicalCoordinate((left - rect.left) / rect.width);
        const y = canonicalCoordinate((top - rect.top) / rect.height);
        const width = Math.min(1 - x, canonicalCoordinate((right - left) / rect.width));
        const height = Math.min(1 - y, canonicalCoordinate((bottom - top) / rect.height));
        if (dragged && (width <= 0 || height <= 0)) continue;
        return { attribute, value, x, y, width, height };
      }
    }
  };
  const anchorFromSelection = (start, end) => {
    const dragged = Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) >= 6;
    const geometry = end.geometry;
    const element = elementAnchorFromSelection(start, end, dragged);
    const target = element === undefined ? {} : { element };
    if (!dragged) {
      return {
        type: "REGION_V1",
        selection: "POINT",
        x: canonicalCoordinate(end.x / geometry.width),
        y: canonicalCoordinate(end.y / geometry.height),
        width: 0,
        height: 0,
        document: { width: geometry.width, height: geometry.height },
        viewport: { width: geometry.viewportWidth, height: geometry.viewportHeight },
        ...target,
      };
    }
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const right = Math.max(start.x, end.x);
    const bottom = Math.max(start.y, end.y);
    return {
      type: "REGION_V1",
      selection: "RECT",
      x: canonicalCoordinate(left / geometry.width),
      y: canonicalCoordinate(top / geometry.height),
      width: canonicalCoordinate((right - left) / geometry.width),
      height: canonicalCoordinate((bottom - top) / geometry.height),
      document: { width: geometry.width, height: geometry.height },
      viewport: { width: geometry.viewportWidth, height: geometry.viewportHeight },
      ...target,
    };
  };
  const updateSelectionState = () => {
    selectionState.textContent = pendingAnchor === undefined
      ? "Page comment"
      : pendingAnchor.selection === "POINT"
      ? "Pinned point selected"
      : "Area selected";
    clearSelectionButton.hidden = pendingAnchor === undefined;
  };
  const cancelSelection = (clearPending) => {
    selectionLayer.setAttribute("hidden", "");
    selectionPreview.setAttribute("hidden", "");
    selectionStart = undefined;
    if (clearPending) pendingAnchor = undefined;
    updateSelectionState();
  };
  const positionSelectionPreview = (start, current) => {
    selectionPreview.setAttribute("x", String(Math.min(start.clientX, current.clientX)));
    selectionPreview.setAttribute("y", String(Math.min(start.clientY, current.clientY)));
    selectionPreview.setAttribute("width", String(Math.max(1, Math.abs(current.clientX - start.clientX))));
    selectionPreview.setAttribute("height", String(Math.max(1, Math.abs(current.clientY - start.clientY))));
    selectionPreview.removeAttribute("hidden");
  };
  selectionButton.addEventListener("click", () => {
    selectionLayer.removeAttribute("hidden");
    selectionPreview.setAttribute("hidden", "");
    selectionStart = undefined;
    setStatus("Click for a pin or drag to select an area. Press Esc to cancel.");
  });
  clearSelectionButton.addEventListener("click", () => cancelSelection(true));
  selectionLayer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    selectionStart = documentPoint(event.clientX, event.clientY);
    selectionLayer.setPointerCapture(event.pointerId);
  });
  selectionLayer.addEventListener("pointermove", (event) => {
    if (selectionStart === undefined) return;
    positionSelectionPreview(selectionStart, documentPoint(event.clientX, event.clientY));
  });
  selectionLayer.addEventListener("pointerup", (event) => {
    if (selectionStart === undefined) return;
    pendingAnchor = anchorFromSelection(selectionStart, documentPoint(event.clientX, event.clientY));
    cancelSelection(false);
    setStatus(pendingAnchor.selection === "POINT" ? "Pin selected; write the comment." : "Area selected; write the comment.");
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (!selectionLayer.hasAttribute("hidden") || pendingAnchor !== undefined)) {
      cancelSelection(true);
      setStatus("Selection cancelled");
    }
  });

  const anchorPlacement = (anchor, geometry) => {
    if (anchor.element !== undefined) {
      const element = findAnchorElement(anchor.element);
      if (element === undefined) return { reason: "Target missing or not unique on this page" };
      const rect = element.getBoundingClientRect();
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || rect.width <= 0 || rect.height <= 0) {
        return { reason: "Target hidden in this layout; open it to see the pin" };
      }
      return {
        x: rect.left + anchor.element.x * rect.width,
        y: rect.top + anchor.element.y * rect.height,
        width: anchor.element.width * rect.width,
        height: anchor.element.height * rect.height,
        element,
      };
    }
    if (Math.abs(geometry.width - anchor.document.width) > 2 ||
        Math.abs(geometry.height - anchor.document.height) > 2 ||
        Math.abs(geometry.viewportWidth - anchor.viewport.width) > 2) {
      return { reason: "Page layout differs from capture; coordinate pin hidden" };
    }
    return {
      x: anchor.x * geometry.width - scrollX,
      y: anchor.y * geometry.height - scrollY,
      width: anchor.width * geometry.width,
      height: anchor.height * geometry.height,
    };
  };
  const updateMarkerPositions = () => {
    const geometry = documentGeometry();
    const items = new Map(commentPage.comments.map((item) => [item.id, item]));
    for (const marker of markerLayer.querySelectorAll(".marker")) {
      const item = items.get(marker.dataset.reviewThreadId);
      if (item === undefined || item.anchor.type !== "REGION_V1") continue;
      const placement = anchorPlacement(item.anchor, geometry);
      const visible = placement.reason === undefined && wantsPinVisible(item.id);
      marker.toggleAttribute("hidden", !visible);
      marker.setAttribute("aria-hidden", String(!visible));
      const row = comments.querySelector('[data-review-thread-id="' + item.id + '"]');
      const button = row?.querySelector(".anchor-button");
      if (button) {
        button.textContent = visible ? "Hide pin" : "Show pin";
        button.setAttribute("aria-pressed", String(visible));
      }
      const state = row?.querySelector(".anchor-state");
      if (state) {
        const capture = "Captured at " + item.anchor.viewport.width + " × " + item.anchor.viewport.height;
        state.textContent = (placement.reason ?? (item.anchor.element ? "Follows target element" : "Approximate page coordinates")) + " · " + capture;
      }
      if (placement.reason !== undefined) continue;
      const { x, y, width, height } = placement;
      const markerShape = marker.querySelector(".marker-shape");
      const markerLabel = marker.querySelector(".marker-label");
      if (item.anchor.selection === "RECT") {
        markerShape?.setAttribute("x", String(x));
        markerShape?.setAttribute("y", String(y));
        markerShape?.setAttribute("width", String(Math.max(12, width)));
        markerShape?.setAttribute("height", String(Math.max(12, height)));
        markerLabel?.setAttribute("x", String(x + 10));
        markerLabel?.setAttribute("y", String(y + 15));
      } else {
        markerShape?.setAttribute("cx", String(x));
        markerShape?.setAttribute("cy", String(y));
        markerLabel?.setAttribute("x", String(x));
        markerLabel?.setAttribute("y", String(y + 4));
      }
    }
    const anyEnabled = pinsVisible || [...pinOverrides.values()].some(Boolean);
    pinVisibilityButton.textContent = anyEnabled ? "Hide all pins" : "Show all pins";
    pinVisibilityButton.setAttribute("aria-pressed", String(anyEnabled));
  };
  pinVisibilityButton.addEventListener("click", () => {
    pinsVisible = !(pinsVisible || [...pinOverrides.values()].some(Boolean));
    pinOverrides.clear();
    try { sessionStorage.setItem("review-tunnel:show-pins", String(pinsVisible)); } catch {}
    activateThread(undefined, false);
    updateMarkerPositions();
  });
  const activateThread = (threadId, scrollPage) => {
    activeThreadId = threadId;
    for (const row of comments.querySelectorAll(".comment")) {
      row.classList.toggle("active", row.dataset.reviewThreadId === threadId);
    }
    for (const marker of markerLayer.querySelectorAll(".marker")) {
      marker.classList.toggle("active", marker.dataset.reviewThreadId === threadId);
    }
    const item = commentPage.comments.find((candidate) => candidate.id === threadId);
    if (scrollPage && item?.anchor.type === "REGION_V1") {
      let placement = anchorPlacement(item.anchor, documentGeometry());
      if (placement.reason !== undefined) {
        setStatus(placement.reason);
        return;
      }
      placement.element?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      placement = anchorPlacement(item.anchor, documentGeometry());
      window.scrollTo({
        top: Math.max(0, placement.y + scrollY - innerHeight * 0.25),
        left: Math.max(0, placement.x + scrollX - innerWidth * 0.25),
        behavior: "smooth",
      });
      requestAnimationFrame(updateMarkerPositions);
    }
  };
  const renderMarkers = () => {
    markerLayer.replaceChildren();
    for (const item of commentPage.comments) {
      if (item.anchor.type !== "REGION_V1") continue;
      const marker = document.createElementNS(svgNamespace, "g");
      marker.setAttribute("class", "marker " + (item.anchor.selection === "POINT" ? "point" : "rect"));
      marker.classList.toggle("approximate", item.anchor.element === undefined);
      marker.setAttribute("role", "button");
      marker.setAttribute("tabindex", "0");
      marker.dataset.reviewThreadId = item.id;
      marker.setAttribute("aria-label", "Open pin " + item.pinNumber + " comment");
      const markerShape = document.createElementNS(
        svgNamespace,
        item.anchor.selection === "POINT" ? "circle" : "rect",
      );
      markerShape.setAttribute("class", "marker-shape");
      if (item.anchor.selection === "POINT") markerShape.setAttribute("r", "12");
      else markerShape.setAttribute("rx", "5");
      const markerLabel = document.createElementNS(svgNamespace, "text");
      markerLabel.setAttribute("class", "marker-label");
      markerLabel.textContent = String(item.pinNumber);
      marker.append(markerShape, markerLabel);
      const openMarker = () => {
        activateThread(item.id, false);
        comments.querySelector('[data-review-thread-id="' + item.id + '"]')?.scrollIntoView({ block: "nearest" });
      };
      marker.addEventListener("click", openMarker);
      marker.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openMarker();
      });
      markerLayer.append(marker);
    }
    updateMarkerPositions();
    if (activeThreadId !== undefined) activateThread(activeThreadId, false);
  };
  (${REVIEW_MENTIONS_VIEW_SOURCE})(root, prefix => readReview("/mentions?prefix=" + encodeURIComponent(prefix)));
  const threadView = (${REVIEW_THREAD_VIEW_SOURCE})({
    container: comments,
    getPage: () => commentPage,
    getContext: () => context,
    read: (path) => readReview(path),
    mutate: (path, method, command) => mutateReview(path, method, command),
    reload: () => requestLoad(),
    replacePage: (page) => replaceCommentPage(page),
    showStatus: setStatus,
    showPin(item) {
      const placement = anchorPlacement(item.anchor, documentGeometry());
      if (placement.reason !== undefined) { setStatus(placement.reason); return; }
      pinOverrides.set(item.id, true);
      activateThread(item.id, true);
      updateMarkerPositions();
    },
    togglePin(item) {
      const placement = anchorPlacement(item.anchor, documentGeometry());
      if (placement.reason !== undefined) { setStatus(placement.reason); return; }
      const show = !wantsPinVisible(item.id);
      pinOverrides.set(item.id, show);
      activateThread(show ? item.id : undefined, show);
      updateMarkerPositions();
    },
    afterRender: () => renderMarkers(),
  });
  const renderComments = () => {
    loadOlderButton.hidden = !commentPage.pageInfo.hasMore;
    launcher.textContent = "Review · " + commentPage.openCount + " unresolved";
    threadView.render();
    if (commentPage.comments.length === 0) setPassiveStatus("No comments on this page");
    else setPassiveStatus(commentPage.openCount + " open · " + commentPage.comments.length + " loaded");
  };
  const replaceCommentPage = (nextPage) => {
    commentPage = nextPage;
    renderComments();
  };
  const renderNotifications = (items) => {
    notifications.replaceChildren();
    const unread = items.filter((item) => item.readAt === null).length;
    notificationSummary.textContent = "Notifications (" + unread + " unread)";
    notificationPanel.hidden = items.length === 0;
    for (const item of items) {
      const row = document.createElement("li");
      row.className = "notification" + (item.readAt === null ? "" : " read");
      const message = document.createElement("span");
      message.textContent = item.actor.displayName + (item.reason === "REPLY" ? " replied to you" : item.reason === "WORKFLOW_REQUEST" ? " requested your review" : item.reason === "WORKFLOW_RESULT" ? " responded to your review request" : " mentioned you in a " + (item.contentType === "COMMENT" ? "comment" : "reply"));
      const action = document.createElement("button");
      action.type = "button";
      action.className = "secondary-button small-button";
      action.textContent = item.readAt === null ? "Mark read" : "Mark unread";
      action.addEventListener("click", async () => {
        await runMutationAction(action, undefined, "Notification update failed: ", async () => {
          await mutateReview("/notifications/" + encodeURIComponent(item.id), "PATCH", {
            path: location.pathname,
            read: item.readAt === null,
          });
          await requestLoad();
        });
      });
      message.addEventListener("click", () => activateThread(item.threadId, true));
      row.append(message, action);
      notifications.append(row);
    }
  };
  const ensureEventStream = (eventCursor) => {
    if (eventSource !== undefined && eventPath === location.pathname) return;
    eventSource?.close();
    eventPath = location.pathname;
    eventSource = new EventSource(
      api + "/events?path=" + encodeURIComponent(eventPath) +
      "&after=" + encodeURIComponent(eventCursor),
    );
    eventSource.addEventListener("review", () => void requestLoad());
    eventSource.addEventListener("open", () => void requestLoad());
    eventSource.addEventListener("review-error", (event) => {
      let code = "REVIEW_UNAVAILABLE";
      try {
        const value = JSON.parse(event.data);
        if (typeof value.error === "string") code = value.error;
      } catch {}
      eventSource?.close();
      eventSource = undefined;
      if (code === "REVIEW_FORBIDDEN") {
        threadView.clear(); pageDrafts.clear(); body.value = "";
        commentPage = { comments: [], openCount: 0, eventCursor: "0", pageInfo: { hasMore: false } };
        renderComments();
      }
      setStatus("Live updates unavailable: " + code, true);
    });
  };
  const reachesOldest = (items, previous) => {
    const oldest = previous?.[0];
    const first = items[0];
    return !oldest || !first || items.some(item => item.id === oldest.id) ||
      first.createdAt < oldest.createdAt ||
      (first.createdAt === oldest.createdAt && first.id <= oldest.id);
  };
  const commentQuery = (path) => "/comments?path=" + encodeURIComponent(path) +
    "&status=" + statusFilter.value + (authorFilter.checked ? "&author=me" : "");
  const readVisiblePage = async (path) => {
    const query = commentQuery(path);
    const previous = commentPath === path ? commentPage.comments : [];
    const result = await readReview(query);
    while (result.pageInfo.hasMore && !reachesOldest(result.comments, previous)) {
      const page = await readReview(query + "&before=" + encodeURIComponent(result.pageInfo.nextCursor));
      if (path !== location.pathname) return result;
      result.comments = [...page.comments, ...result.comments];
      result.pageInfo = page.pageInfo;
    }
    const previousById = new Map(previous.map(item => [item.id, item]));
    for (const item of result.comments) {
      const oldReplies = previousById.get(item.id)?.replies;
      while (item.replyPageInfo?.hasMore && !reachesOldest(item.replies, oldReplies)) {
        const page = await readReview("/comments/" + encodeURIComponent(item.id) + "/replies?path=" + encodeURIComponent(path) + "&before=" + encodeURIComponent(item.replyPageInfo.nextCursor));
        if (path !== location.pathname) return result;
        item.replies = [...page.replies, ...item.replies];
        item.replyPageInfo = page.pageInfo;
      }
    }
    return result;
  };
  let pendingFocus;
  try { pendingFocus = JSON.parse(sessionStorage.getItem("review-tunnel:focus") ?? "null"); sessionStorage.removeItem("review-tunnel:focus"); } catch {}
  if (pendingFocus && (pendingFocus.expiresAt < Date.now() || pendingFocus.path !== location.pathname)) pendingFocus = undefined;
  const loadOnce = async () => {
    const sequence = ++loadSequence;
    const routePath = location.pathname;
    setPassiveStatus("Loading comments…");
    try {
      if (context === undefined) {
        context = await readReview("/context");
        if (context.controlOrigin && !panel.querySelector(".review-inbox-link")) {
          const inboxLink = document.createElement("a"); inboxLink.className = "review-inbox-link"; inboxLink.textContent = "Review inbox · All pages"; inboxLink.href = context.controlOrigin + "/reviews"; inboxLink.target = "_blank"; inboxLink.rel = "noopener noreferrer"; contextLabel.after(inboxLink);
        }
        contextLabel.textContent = context.project.displayName + " · " + context.revision.key;
        form.hidden = !context.principal.canComment;
      }
      const [result, notificationResult] = await Promise.all([
        readVisiblePage(routePath),
        readReview("/notifications?path=" + encodeURIComponent(routePath)),
      ]);
      if (sequence === loadSequence && routePath === location.pathname) {
        const focus = pendingFocus; pendingFocus = undefined;
        if (focus && focus.revisionId === context.revision.id) {
          try {
            const target = await readReview("/comments/" + encodeURIComponent(focus.id) + "?path=" + encodeURIComponent(routePath));
            if (!result.comments.some(item => item.id === target.comment.id)) result.comments.push(target.comment);
          } catch { setStatus("This review is no longer available.", true); }
        }
        replaceCommentPage(result);
        if (focus) {
          setPanelOpen(true);
          const row = comments.querySelector('[data-review-thread-id="' + CSS.escape(focus.id) + '"]');
          row?.scrollIntoView({ block: "nearest" }); activateThread(focus.id, true);
        }
        commentPath = routePath;
        renderNotifications(notificationResult.notifications);
        ensureEventStream(result.eventCursor);
      }
    } catch (error) {
      if (sequence === loadSequence) setStatus("Review unavailable: " + (error instanceof Error ? error.message : "unknown error"), true);
    }
  };
  const requestLoad = (${REVIEW_REFRESH_COORDINATOR_SOURCE})(loadOnce);
  const setPanelOpen = (open) => {
    panelOpen = open;
    panel.hidden = !open;
    launcher.hidden = open;
    savePreference("panel-open", String(open));
    if (!open) cancelSelection(false);
    (open ? collapseButton : launcher).focus({ preventScroll: true });
  };
  collapseButton.addEventListener("click", () => setPanelOpen(false));
  launcher.addEventListener("click", () => setPanelOpen(true));
  const changeFilters = () => {
    savePreference("comment-status", statusFilter.value);
    savePreference("comment-mine", String(authorFilter.checked));
    ++loadSequence;
    commentPath = undefined;
    activeThreadId = undefined;
    commentPage = { comments: [], openCount: commentPage.openCount, eventCursor: "0", pageInfo: { hasMore: false } };
    renderComments();
    void requestLoad();
  };
  statusFilter.addEventListener("change", changeFilters);
  authorFilter.addEventListener("change", changeFilters);
  loadOlderButton.addEventListener("click", async () => {
    if (!commentPage.pageInfo.hasMore) return;
    loadOlderButton.disabled = true;
    const sequence = ++loadSequence;
    const routePath = location.pathname;
    try {
      const result = await readReview(
        commentQuery(routePath) + "&before=" +
        encodeURIComponent(commentPage.pageInfo.nextCursor),
      );
      if (sequence !== loadSequence || routePath !== location.pathname) return;
      const seen = new Set(result.comments.map((comment) => comment.id));
      replaceCommentPage({
        comments: [
          ...result.comments,
          ...commentPage.comments.filter((comment) => !seen.has(comment.id)),
        ],
        openCount: result.openCount,
        eventCursor: result.eventCursor,
        pageInfo: result.pageInfo,
      });
    } catch (error) {
      if (sequence === loadSequence) {
        setStatus("Older comments failed: " + (error instanceof Error ? error.message : "unknown error"), true);
      }
    } finally {
      loadOlderButton.disabled = false;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runMutationAction(submit, "Saving comment…", "Comment failed: ", async () => {
      const command = { path: location.pathname, body: body.value };
      const submittedPath = location.pathname;
      if (pendingAnchor !== undefined) command.anchor = pendingAnchor;
      await mutateReview("/comments", "POST", command);
      if (pageDrafts.get(submittedPath) === command.body) pageDrafts.delete(submittedPath);
      if (location.pathname === submittedPath && body.value === command.body) body.value = "";
      pendingAnchor = undefined;
      updateSelectionState();
      await requestLoad();
    });
  });
  let markerFrame;
  const scheduleMarkerUpdate = () => {
    if (markerFrame !== undefined) return;
    markerFrame = requestAnimationFrame(() => {
      markerFrame = undefined;
      updateMarkerPositions();
    });
  };
  window.addEventListener("scroll", scheduleMarkerUpdate, { passive: true, capture: true });
  window.addEventListener("resize", scheduleMarkerUpdate);
  new ResizeObserver(scheduleMarkerUpdate).observe(document.documentElement);
  new MutationObserver(scheduleMarkerUpdate).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  document.addEventListener("load", scheduleMarkerUpdate, true);
  document.addEventListener("transitionend", scheduleMarkerUpdate, true);
  document.addEventListener("animationend", scheduleMarkerUpdate, true);
  document.fonts.ready.then(scheduleMarkerUpdate);
  document.fonts.addEventListener("loadingdone", scheduleMarkerUpdate);
  const navigationEvent = "review-tunnel:navigation";
  const wrapHistory = (name) => {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event(navigationEvent));
      return result;
    };
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", () => window.dispatchEvent(new Event(navigationEvent)));
  window.addEventListener(navigationEvent, () => {
    if (draftPath !== location.pathname) {
      pageDrafts.set(draftPath, body.value);
      draftPath = location.pathname;
      body.value = pageDrafts.get(draftPath) ?? "";
    }
    activeThreadId = undefined;
    pinOverrides.clear();
    commentPage = { comments: [], openCount: 0, eventCursor: "0", pageInfo: { hasMore: false } };
    renderComments();
    cancelSelection(true);
    eventSource?.close();
    eventSource = undefined;
    eventPath = undefined;
    commentPath = undefined;
    setStatus("Loading comments…");
    void requestLoad();
  });
  void requestLoad();
}
`;
