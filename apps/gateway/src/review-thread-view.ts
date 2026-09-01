// Browser source shared by the overlay; event delegation keeps editors connected during refresh.
export const REVIEW_THREAD_VIEW_SOURCE = `({ container, getPage, getContext, getRoutePath, read, mutate, reload, replacePage, showStatus, showPin, togglePin, afterRender }) => {
  const drafts = new Map();
  const edits = new Map();
  const pending = new Set();
  const key = (id) => location.pathname + ":" + id;
  const node = (tag, className, text, id) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    if (id) value.dataset.key = id;
    return value;
  };
  const button = (label, action, className = "secondary-button small-button") => {
    const value = node("button", className, label, action);
    value.type = "button";
    value.dataset.action = action;
    return value;
  };
  const patch = (parent, fresh) => {
    const previous = [...parent.childNodes];
    const used = new Set();
    for (const desired of [...fresh.childNodes]) {
      const id = desired.nodeType === 1 ? desired.dataset.key : undefined;
      let current = previous.find((candidate) => !used.has(candidate) &&
        candidate.nodeName === desired.nodeName && (id
          ? candidate.nodeType === 1 && candidate.dataset.key === id
          : candidate.nodeType !== 1 || !candidate.dataset.key));
      if (!current) current = desired;
      else if (current.nodeType === 3) {
        if (current.textContent !== desired.textContent) current.textContent = desired.textContent;
      } else {
        for (const attribute of [...current.attributes]) {
          if (!desired.hasAttribute(attribute.name) && attribute.name !== "data-composing" && !(current.tagName === "DETAILS" && attribute.name === "open")) current.removeAttribute(attribute.name);
        }
        for (const attribute of [...desired.attributes]) {
          if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        }
        if (current.tagName === "TEXTAREA") {
          if (current.value !== desired.value && !current.dataset.composing) current.value = desired.value;
        } else patch(current, desired);
      }
      used.add(current);
      const next = parent.childNodes[used.size - 1];
      if (next !== current) parent.insertBefore(current, next ?? null);
    }
    for (const child of previous) if (!used.has(child)) child.remove();
  };
  const content = (parent, item, thread, isReply) => {
    const label = isReply ? "reply" : "comment";
    const state = edits.get(key(item.id));
    parent.dataset.contentId = item.id;
    parent.append(node("div", "author", item.author.displayName, "author"));
    parent.append(node("div", label + "-body" + (item.body === null ? " tombstone" : ""),
      item.body === null ? "Deleted " + label : item.body, "body"));
    if (state) {
      const editor = node("form", "edit-form", undefined, "editor");
      editor.dataset.action = "save-edit";
      const input = node("textarea", "", undefined, "input");
      input.maxLength = 4000;
      input.required = true;
      input.setAttribute("aria-label", "Edit " + label);
      input.value = state.body;
      input.dataset.draft = "edit";
      const count = node("span", "context", state.body.length + " / 4000", "count");
      count.dataset.counter = "";
      const save = button("Save changes", "save-edit");
      save.type = "submit";
      save.disabled = pending.has(key(thread.id));
      editor.append(input, count);
      if (state.version !== item.version) {
        editor.append(node("p", "error", "This " + label + " changed. Your draft is kept; review the latest text above.", "conflict"));
        editor.append(button("Use latest version and keep draft", "rebase-edit"));
        save.disabled = true;
      }
      editor.append(button("Cancel edit", "cancel-edit"), save);
      parent.append(editor);
    } else {
      const actions = node("div", "content-actions", undefined, "actions");
      if (item.canEdit) actions.append(button("Edit " + label, "edit"));
      if (item.canDelete) actions.append(button("Delete " + label, "delete", "danger-button small-button"));
      if (actions.childElementCount) parent.append(actions);
    }
  };
  const render = () => {
    const fresh = document.createDocumentFragment();
    for (const item of getPage().comments) {
      const row = node("li", "thread comment", undefined, item.id);
      row.dataset.reviewThreadId = item.id;
      if (getContext().controlOrigin) {
        const permalink = node("a", "permalink", "Permanent link", "permalink");
        permalink.href = getContext().controlOrigin + "/reviews/threads/" + encodeURIComponent(item.id);
        permalink.target = "_blank"; permalink.rel = "noopener noreferrer"; row.append(permalink);
      }
      content(row, item, item, false);
      row.prepend(node("span", "thread-status", item.body === null ? "Deleted" : item.status === "RESOLVED" ? "Resolved" : item.status === "NEEDS_REVIEW" ? "Needs review" : "Open", "status"));
      if (showPin && item.anchor.type === "REGION_V1") {
        const summary = node("div", "anchor-summary", undefined, "anchor");
        const go = button("Pin #" + item.pinNumber + (item.anchor.selection === "POINT" ? " · Point" : " · Area"), "show-pin");
        go.setAttribute("aria-label", "Go to pin " + item.pinNumber);
        summary.append(go, button("Show pin", "toggle-pin", "anchor-button small-button"));
        row.append(summary, node("div", "anchor-state", undefined, "anchor-state"));
      }
      const replies = node("div", "replies", undefined, "replies");
      for (const itemReply of item.replies) {
        const reply = node("div", "reply", undefined, itemReply.id);
        content(reply, itemReply, item, true);
        replies.append(reply);
      }
      if (item.replyPageInfo?.hasMore) replies.append(button("Load older replies", "older-replies"));
      if (replies.childElementCount) row.append(replies);
      if (getContext().principal.canComment && item.status !== "RESOLVED" && item.body !== null) {
        const form = node("form", "reply-form", undefined, "reply-form");
        form.dataset.action = "reply";
        const input = node("textarea", "", undefined, "input");
        input.maxLength = 4000;
        input.required = true;
        input.placeholder = "Reply to this comment";
        input.setAttribute("aria-label", "Reply to comment");
        input.value = drafts.get(key(item.id)) ?? "";
        input.dataset.draft = "reply";
        const submit = button("Reply", "reply", "");
        submit.type = "submit";
        submit.disabled = pending.has(key(item.id));
        form.append(input, submit);
        row.append(form);
      }
      if (getContext().principal.canManageProject && item.body !== null) {
        row.append(button(item.status === "RESOLVED" ? "Reopen" : "Resolve", "status", "status-button"));
      }
      if (getContext().principal.canComment && item.canVerify && item.body !== null) {
        row.append(button("Confirm resolved", "verify", "status-button"), button("Request more changes", "request-changes", "status-button"));
      }
      if (getContext().features?.canRequestReview && getContext().principal.canManageProject && item.body !== null && item.status === "OPEN") row.append(button("Request review", "request-review", "status-button"));
      if (item.workflowHistory?.length) {
        const history = node("details", "history", undefined, "history"); history.append(node("summary", "", "처리 기록 (최근 100개)"));
        for (const entry of item.workflowHistory) history.append(node("p", "context", entry.actor.displayName + " · " + entry.from + " → " + entry.to + " · " + new Date(entry.changedAt).toLocaleString()));
        row.append(history);
      }
      fresh.append(row);
    }
    const focus = container.getRootNode().activeElement;
    const selection = focus?.tagName === "TEXTAREA" ? [focus.selectionStart, focus.selectionEnd, focus.selectionDirection] : undefined;
    patch(container, fresh);
    if (focus?.isConnected && container.getRootNode().activeElement !== focus) {
      focus.focus({ preventScroll: true });
      if (selection) focus.setSelectionRange(...selection);
    }
    afterRender();
  };
  const locate = (target) => {
    const row = target.closest("[data-review-thread-id]");
    const item = getPage().comments.find(value => value.id === row?.dataset.reviewThreadId);
    const id = target.closest("[data-content-id]")?.dataset.contentId;
    return { item, content: item?.replies.find(value => value.id === id) ?? item };
  };
  container.addEventListener("compositionstart", event => { event.target.dataset.composing = "true"; });
  container.addEventListener("compositionend", event => { delete event.target.dataset.composing; });
  container.addEventListener("input", event => {
    const { item, content: value } = locate(event.target);
    if (!item || !value) return;
    if (event.target.dataset.draft === "reply") drafts.set(key(item.id), event.target.value);
    if (event.target.dataset.draft === "edit") {
      const edit = edits.get(key(value.id));
      if (edit) edit.body = event.target.value;
      const count = event.target.form?.querySelector("[data-counter]");
      if (count) count.textContent = event.target.value.length + " / 4000";
    }
  });
  const act = async (target, action) => {
    const { item, content: value } = locate(target);
    if (!item || !value) return;
    const pageLocation = location.pathname;
    const path = getRoutePath ? getRoutePath(item) : pageLocation;
    const draftKey = key(value.id);
    const threadKey = key(item.id);
    const endpoint = "/comments/" + encodeURIComponent(item.id);
    const contentEndpoint = value.id === item.id ? endpoint : endpoint + "/replies/" + encodeURIComponent(value.id);
    if (action === "edit") { edits.set(draftKey, { body: value.body, version: value.version }); render(); return; }
    if (action === "cancel-edit") { edits.delete(draftKey); render(); return; }
    if (action === "rebase-edit") { const edit = edits.get(draftKey); if (edit) edit.version = value.version; render(); return; }
    if (action === "show-pin") { showPin(item); return; }
    if (action === "toggle-pin") { togglePin(item); return; }
    if (pending.has(threadKey)) return;
    if (action === "delete" && !window.confirm(value.id === item.id ? "Delete this comment? Replies and the pin will remain." : "Delete this reply?")) return;
    pending.add(threadKey);
    target.disabled = true;
    try {
      if (action === "older-replies") {
        const result = await read(endpoint + "/replies?path=" + encodeURIComponent(path) + "&before=" + encodeURIComponent(item.replyPageInfo.nextCursor));
        if (location.pathname !== pageLocation) return;
        const current = getPage().comments.find(candidate => candidate.id === item.id);
        if (!current) return;
        const ids = new Set(result.replies.map(reply => reply.id));
        replacePage({ ...getPage(), comments: getPage().comments.map(candidate => candidate.id === item.id
          ? { ...candidate, replies: [...result.replies, ...current.replies.filter(reply => !ids.has(reply.id))], replyPageInfo: result.pageInfo } : candidate) });
      } else {
        showStatus("Saving…");
        if (action === "reply") {
          const text = drafts.get(threadKey) ?? "";
          await mutate(endpoint + "/replies", "POST", { path, body: text });
          if (drafts.get(threadKey) === text) drafts.delete(threadKey);
        } else if (action === "save-edit") {
          const state = edits.get(draftKey);
          if (!state) return;
          const sentBody = state.body;
          await mutate(contentEndpoint, "PATCH", { path, body: sentBody, expectedVersion: state.version });
          if (edits.get(draftKey)?.body === sentBody) edits.delete(draftKey);
        } else if (action === "delete") {
          await mutate(contentEndpoint, "DELETE", { path, expectedVersion: value.version });
          edits.delete(draftKey);
        } else if (["status", "verify", "request-changes", "request-review"].includes(action)) {
          const next = action === "request-review" ? "NEEDS_REVIEW" : action === "request-changes" ? "OPEN" : action === "verify" ? "RESOLVED" : item.status === "RESOLVED" ? "OPEN" : "RESOLVED";
          await mutate(endpoint + "/status", "PATCH", { path, expectedWorkflowVersion: item.workflowVersion ?? 1, expectedStatus: item.status, status: next });
        }
        await reload();
      }
    } catch (error) {
      await reload();
      showStatus("Review action failed: " + (error instanceof Error ? error.message === "REVIEW_REVIEWER_UNAVAILABLE" ? "The original reviewer is disabled or no longer has review access." : error.message : "unknown error"), true);
    } finally {
      pending.delete(threadKey);
      target.disabled = false;
      if (location.pathname === pageLocation) render();
    }
  };
  container.addEventListener("click", event => {
    const target = event.target.closest("button[data-action]");
    if (target && target.type !== "submit") void act(target, target.dataset.action);
  });
  container.addEventListener("submit", event => {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    void act(event.submitter ?? event.target, event.target.dataset.action);
  });
  return { render, clear() { drafts.clear(); edits.clear(); } };
}`;
