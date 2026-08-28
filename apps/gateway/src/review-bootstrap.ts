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

export const REVIEW_PAGE_MERGER_SOURCE = `(current, latest) => {
  const latestIds = new Set(latest.comments.map((comment) => comment.id));
  const currentById = new Map(current.comments.map((comment) => [comment.id, comment]));
  const latestComments = latest.comments.map((latestComment) => {
    const currentComment = currentById.get(latestComment.id);
    if (currentComment === undefined) return latestComment;
    const latestReplyIds = new Set(latestComment.replies.map((reply) => reply.id));
    const keptReplies = currentComment.replies.filter((reply) => !latestReplyIds.has(reply.id));
    const keptOlderReplies = currentComment.replies.length > latestComment.replies.length;
    return {
      ...latestComment,
      replies: [...keptReplies, ...latestComment.replies],
      replyPageInfo: keptOlderReplies
        ? currentComment.replyPageInfo
        : latestComment.replyPageInfo,
    };
  });
  const keptComments = current.comments.filter((comment) => !latestIds.has(comment.id));
  const keptOlderComments = current.comments.length > latest.comments.length;
  return {
    ...latest,
    comments: [...keptComments, ...latestComments],
    pageInfo: keptOlderComments ? current.pageInfo : latest.pageInfo,
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
    ".selection-layer { z-index: 2; pointer-events: auto; cursor: crosshair; touch-action: none; background: rgba(20, 87, 217, .025); }",
    ".selection-layer[hidden] { display: none; }",
    ".selection-preview { fill: rgba(20, 87, 217, .13); stroke: #1457d9; stroke-width: 2; pointer-events: none; }",
    ".selection-preview[hidden] { display: none; }",
    ".marker { pointer-events: auto; cursor: pointer; outline: none; }",
    ".marker-shape { fill: rgba(20, 87, 217, .82); stroke: #1457d9; stroke-width: 2; filter: drop-shadow(0 2px 4px rgba(15, 23, 42, .25)); }",
    ".marker.point .marker-shape { fill: #1457d9; }",
    ".marker.active .marker-shape { fill: rgba(240, 68, 56, .2); stroke: #f04438; stroke-width: 3; }",
    ".marker.point.active .marker-shape { fill: #f04438; }",
    ".marker:focus-visible .marker-shape { stroke: #f04438; stroke-width: 4; }",
    ".marker-label { fill: #fff; pointer-events: none; text-anchor: middle; font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; }",
    ".panel { position: fixed; z-index: 3; top: 16px; right: 16px; width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 16px; border: 1px solid #d7dce2; border-radius: 12px; background: #fff; color: #17202a; box-shadow: 0 16px 48px rgba(15, 23, 42, .2); font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; pointer-events: auto; }",
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
  heading.append(title, contextLabel);
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
  panel.append(heading, status, notificationPanel, comments, loadOlderButton, form);
  root.append(style, markerLayer, selectionLayer, panel);
  document.documentElement.append(host);

  let context;
  let loadSequence = 0;
  let commentPage = { comments: [], openCount: 0, eventCursor: "0", pageInfo: { hasMore: false } };
  let commentPath;
  let activeThreadId;
  let pendingAnchor;
  let selectionStart;
  let eventSource;
  let eventPath;
  const api = "/_review-tunnel/review";
  const readJson = async (response) => {
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "HTTP_" + response.status);
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
  const anchorFromSelection = (start, end) => {
    const dragged = Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) >= 6;
    const geometry = end.geometry;
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

  const updateMarkerPositions = () => {
    const geometry = documentGeometry();
    for (const marker of markerLayer.querySelectorAll(".marker")) {
      const item = commentPage.comments.find((candidate) => candidate.id === marker.dataset.reviewThreadId);
      if (item === undefined || item.anchor.type !== "REGION_V1") continue;
      const x = item.anchor.x * geometry.width - scrollX;
      const y = item.anchor.y * geometry.height - scrollY;
      const markerShape = marker.querySelector(".marker-shape");
      const markerLabel = marker.querySelector(".marker-label");
      if (item.anchor.selection === "RECT") {
        markerShape?.setAttribute("x", String(x));
        markerShape?.setAttribute("y", String(y));
        markerShape?.setAttribute("width", String(Math.max(12, item.anchor.width * geometry.width)));
        markerShape?.setAttribute("height", String(Math.max(12, item.anchor.height * geometry.height)));
        markerLabel?.setAttribute("x", String(x + 10));
        markerLabel?.setAttribute("y", String(y + 15));
      } else {
        markerShape?.setAttribute("cx", String(x));
        markerShape?.setAttribute("cy", String(y));
        markerLabel?.setAttribute("x", String(x));
        markerLabel?.setAttribute("y", String(y + 4));
      }
    }
  };
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
      const geometry = documentGeometry();
      window.scrollTo({ top: Math.max(0, item.anchor.y * geometry.height - innerHeight * 0.25), behavior: "smooth" });
      requestAnimationFrame(updateMarkerPositions);
    }
  };
  const renderMarkers = () => {
    markerLayer.replaceChildren();
    for (const item of commentPage.comments) {
      if (item.anchor.type !== "REGION_V1") continue;
      const marker = document.createElementNS(svgNamespace, "g");
      marker.setAttribute("class", "marker " + (item.anchor.selection === "POINT" ? "point" : "rect"));
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
  const renderComments = () => {
    const { comments: items, openCount, pageInfo } = commentPage;
    loadOlderButton.hidden = !pageInfo.hasMore;
    comments.replaceChildren();
    for (const item of items) {
      const row = document.createElement("li");
      row.className = "thread comment";
      row.dataset.reviewThreadId = item.id;
      const threadHeader = document.createElement("div");
      threadHeader.className = "thread-header";
      const author = document.createElement("div");
      author.className = "author";
      author.textContent = item.author.displayName;
      const threadStatus = document.createElement("span");
      threadStatus.className = "thread-status";
      threadStatus.textContent = item.body === null
        ? "Deleted"
        : item.status === "RESOLVED" ? "Resolved" : "Open";
      threadHeader.append(author, threadStatus);
      const text = document.createElement("div");
      text.className = "comment-body";
      text.textContent = item.body === null ? "Deleted comment" : item.body;
      if (item.body === null) text.classList.add("tombstone");
      row.append(threadHeader, text);

      if (item.canEdit || item.canDelete) {
        const contentActions = document.createElement("div");
        contentActions.className = "content-actions";
        if (item.canEdit) {
          const editButton = document.createElement("button");
          editButton.type = "button";
          editButton.className = "secondary-button small-button";
          editButton.textContent = "Edit comment";
          editButton.addEventListener("click", async () => {
            const nextBody = window.prompt("Edit comment", item.body);
            if (nextBody === null || nextBody === item.body) return;
            await runMutationAction(
              editButton,
              "Editing comment…",
              "Comment edit failed: ",
              async () => {
                await mutateReview("/comments/" + encodeURIComponent(item.id), "PATCH", {
                  path: location.pathname,
                  expectedVersion: item.version,
                  body: nextBody,
                });
                await requestLoad();
              },
            );
          });
          contentActions.append(editButton);
        }
        if (item.canDelete) {
          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "danger-button small-button";
          deleteButton.textContent = "Delete comment";
          deleteButton.addEventListener("click", async () => {
            if (!window.confirm("Delete this comment? Replies and the pin will remain.")) return;
            await runMutationAction(
              deleteButton,
              "Deleting comment…",
              "Comment delete failed: ",
              async () => {
                await mutateReview("/comments/" + encodeURIComponent(item.id), "DELETE", {
                  path: location.pathname,
                  expectedVersion: item.version,
                });
                await requestLoad();
              },
            );
          });
          contentActions.append(deleteButton);
        }
        row.append(contentActions);
      }

      if (item.anchor.type === "REGION_V1") {
        const anchorSummary = document.createElement("div");
        anchorSummary.className = "anchor-summary";
        const anchorLabel = document.createElement("span");
        anchorLabel.textContent = "Pin #" + item.pinNumber +
          (item.anchor.selection === "POINT" ? " · Point" : " · Area");
        const anchorButton = document.createElement("button");
        anchorButton.type = "button";
        anchorButton.className = "anchor-button small-button";
        anchorButton.textContent = "Show pin";
        anchorButton.addEventListener("click", () => activateThread(item.id, true));
        anchorSummary.append(anchorLabel, anchorButton);
        row.append(anchorSummary);
      }

      const replies = document.createElement("div");
      replies.className = "replies";
      for (const itemReply of item.replies ?? []) {
        const reply = document.createElement("div");
        reply.className = "reply";
        const replyAuthor = document.createElement("div");
        replyAuthor.className = "author";
        replyAuthor.textContent = itemReply.author.displayName;
        const replyBody = document.createElement("div");
        replyBody.className = "reply-body";
        replyBody.textContent = itemReply.body === null ? "Deleted reply" : itemReply.body;
        if (itemReply.body === null) replyBody.classList.add("tombstone");
        reply.append(replyAuthor, replyBody);
        if (itemReply.canEdit || itemReply.canDelete) {
          const replyActions = document.createElement("div");
          replyActions.className = "content-actions";
          if (itemReply.canEdit) {
            const editReplyButton = document.createElement("button");
            editReplyButton.type = "button";
            editReplyButton.className = "secondary-button small-button";
            editReplyButton.textContent = "Edit reply";
            editReplyButton.addEventListener("click", async () => {
              const nextBody = window.prompt("Edit reply", itemReply.body);
              if (nextBody === null || nextBody === itemReply.body) return;
              await runMutationAction(
                editReplyButton,
                "Editing reply…",
                "Reply edit failed: ",
                async () => {
                  await mutateReview(
                    "/comments/" + encodeURIComponent(item.id) + "/replies/" + encodeURIComponent(itemReply.id),
                    "PATCH",
                    {
                      path: location.pathname,
                      expectedVersion: itemReply.version,
                      body: nextBody,
                    },
                  );
                  await requestLoad();
                },
              );
            });
            replyActions.append(editReplyButton);
          }
          if (itemReply.canDelete) {
            const deleteReplyButton = document.createElement("button");
            deleteReplyButton.type = "button";
            deleteReplyButton.className = "danger-button small-button";
            deleteReplyButton.textContent = "Delete reply";
            deleteReplyButton.addEventListener("click", async () => {
              if (!window.confirm("Delete this reply?")) return;
              await runMutationAction(
                deleteReplyButton,
                "Deleting reply…",
                "Reply delete failed: ",
                async () => {
                  await mutateReview(
                    "/comments/" + encodeURIComponent(item.id) + "/replies/" + encodeURIComponent(itemReply.id),
                    "DELETE",
                    { path: location.pathname, expectedVersion: itemReply.version },
                  );
                  await requestLoad();
                },
              );
            });
            replyActions.append(deleteReplyButton);
          }
          reply.append(replyActions);
        }
        replies.append(reply);
      }
      if (item.replyPageInfo?.hasMore) {
        const olderRepliesButton = document.createElement("button");
        olderRepliesButton.type = "button";
        olderRepliesButton.className = "secondary-button small-button";
        olderRepliesButton.textContent = "Load older replies";
        olderRepliesButton.addEventListener("click", async () => {
          olderRepliesButton.disabled = true;
          const routePath = location.pathname;
          try {
            const result = await readReview(
              "/comments/" + encodeURIComponent(item.id) + "/replies?path=" +
              encodeURIComponent(routePath) + "&before=" +
              encodeURIComponent(item.replyPageInfo.nextCursor),
            );
            if (routePath !== location.pathname) return;
            const seen = new Set(result.replies.map((reply) => reply.id));
            const mergedReplies = [...result.replies, ...item.replies.filter((reply) => !seen.has(reply.id))];
            replaceCommentPage({
              ...commentPage,
              comments: commentPage.comments.map((candidate) => candidate.id === item.id
                ? { ...candidate, replies: mergedReplies, replyPageInfo: result.pageInfo }
                : candidate),
            });
          } catch (error) {
            setStatus("Older replies failed: " + (error instanceof Error ? error.message : "unknown error"), true);
            olderRepliesButton.disabled = false;
          }
        });
        replies.append(olderRepliesButton);
      }
      if (replies.childElementCount > 0) row.append(replies);

      if (context.principal.canComment && item.status === "OPEN" && item.body !== null) {
        const replyForm = document.createElement("form");
        replyForm.className = "reply-form";
        const replyBody = document.createElement("textarea");
        replyBody.maxLength = 4000;
        replyBody.required = true;
        replyBody.placeholder = "Reply to this comment";
        replyBody.setAttribute("aria-label", "Reply to comment");
        const replySubmit = document.createElement("button");
        replySubmit.type = "submit";
        replySubmit.textContent = "Reply";
        replyForm.append(replyBody, replySubmit);
        replyForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          await runMutationAction(
            replySubmit,
            "Saving reply…",
            "Reply failed: ",
            async () => {
              await mutateReview("/comments/" + encodeURIComponent(item.id) + "/replies", "POST", {
                path: location.pathname,
                body: replyBody.value,
              });
              await requestLoad();
            },
          );
        });
        row.append(replyForm);
      }

      if (context.principal.canManageProject && item.body !== null) {
        const statusButton = document.createElement("button");
        statusButton.type = "button";
        statusButton.className = "status-button";
        statusButton.textContent = item.status === "RESOLVED" ? "Reopen" : "Resolve";
        statusButton.addEventListener("click", async () => {
          const nextStatus = item.status === "RESOLVED" ? "OPEN" : "RESOLVED";
          await runMutationAction(
            statusButton,
            nextStatus === "RESOLVED" ? "Resolving comment…" : "Reopening comment…",
            "Status change failed: ",
            async () => {
              await mutateReview("/comments/" + encodeURIComponent(item.id) + "/status", "PATCH", {
                path: location.pathname,
                expectedStatus: item.status,
                status: nextStatus,
              });
              await requestLoad();
            },
          );
        });
        row.append(statusButton);
      }
      comments.append(row);
    }
    renderMarkers();
    if (items.length === 0) setPassiveStatus("No comments on this page");
    else setPassiveStatus(openCount + " open · " + items.length + " loaded");
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
      message.textContent = item.actor.displayName + " mentioned you in a " +
        (item.contentType === "COMMENT" ? "comment" : "reply");
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
    eventSource.addEventListener("review-error", (event) => {
      let code = "REVIEW_UNAVAILABLE";
      try {
        const value = JSON.parse(event.data);
        if (typeof value.error === "string") code = value.error;
      } catch {}
      eventSource?.close();
      eventSource = undefined;
      setStatus("Live updates unavailable: " + code, true);
    });
  };
  const loadOnce = async () => {
    const sequence = ++loadSequence;
    const routePath = location.pathname;
    setPassiveStatus("Loading comments…");
    try {
      if (context === undefined) {
        context = await readReview("/context");
        contextLabel.textContent = context.project.displayName + " · " + context.revision.key;
        form.hidden = !context.principal.canComment;
      }
      const [result, notificationResult] = await Promise.all([
        readReview("/comments?path=" + encodeURIComponent(routePath)),
        readReview("/notifications?path=" + encodeURIComponent(routePath)),
      ]);
      if (sequence === loadSequence && routePath === location.pathname) {
        replaceCommentPage(commentPath === routePath
          ? (${REVIEW_PAGE_MERGER_SOURCE})(commentPage, result)
          : result);
        commentPath = routePath;
        renderNotifications(notificationResult.notifications);
        ensureEventStream(result.eventCursor);
      }
    } catch (error) {
      if (sequence === loadSequence) setStatus("Review unavailable: " + (error instanceof Error ? error.message : "unknown error"), true);
    }
  };
  const requestLoad = (${REVIEW_REFRESH_COORDINATOR_SOURCE})(loadOnce);
  loadOlderButton.addEventListener("click", async () => {
    if (!commentPage.pageInfo.hasMore) return;
    loadOlderButton.disabled = true;
    const sequence = ++loadSequence;
    const routePath = location.pathname;
    try {
      const result = await readReview(
        "/comments?path=" + encodeURIComponent(routePath) + "&before=" +
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
      if (pendingAnchor !== undefined) command.anchor = pendingAnchor;
      await mutateReview("/comments", "POST", command);
      body.value = "";
      pendingAnchor = undefined;
      updateSelectionState();
      await requestLoad();
    });
  });
  window.addEventListener("scroll", updateMarkerPositions, { passive: true });
  window.addEventListener("resize", updateMarkerPositions);
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
    activeThreadId = undefined;
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
