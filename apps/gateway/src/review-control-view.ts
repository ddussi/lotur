import { REVIEW_MENTIONS_VIEW_SOURCE } from "./review-mentions-view.ts";
import { REVIEW_THREAD_VIEW_SOURCE } from "./review-thread-view.ts";

export const REVIEW_CONTROL_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>리뷰함 · Review Tunnel</title><style>
body{font:16px system-ui;color:#18202a;background:#f6f8fb;max-width:1000px;margin:32px auto;padding:0 20px}nav,.filters,.content-actions{display:flex;gap:12px;flex-wrap:wrap}a{color:#234fa8}button,select,input,textarea{font:inherit;padding:8px;border:1px solid #bbc6d5;border-radius:6px}button{cursor:pointer;background:white}button:disabled{opacity:.5}textarea{display:block;box-sizing:border-box;width:100%;min-height:80px;margin:10px 0}li{list-style:none}ul,ol{padding:0}.card,.thread{padding:20px;margin:16px 0;background:white;border:1px solid #dae0e8;border-radius:12px;overflow-wrap:anywhere}.thread-status{float:right}.comment-body,.reply-body{white-space:pre-wrap;margin:12px 0}.replies{padding-left:20px;border-left:3px solid #d9e5f7}.reply{margin:16px 0}.author{font-weight:600}.small-button{font-size:14px}.status-button{margin:12px 8px 0 0}.error{color:#a40000}.context,.tombstone{color:#586577}.edit-form{border:1px solid #7899ce;padding:12px}.notice{background:#fff4c2;padding:12px}h1{font-size:28px}.mention-options button[aria-selected=true]{background:#dbe8ff}[hidden]{display:none!important}@media(max-width:600px){body{padding:0 12px;margin:20px auto}.thread{padding:14px}}
</style><script defer src="/reviews/app.js"></script></head><body><nav><a href="/reviews">리뷰함</a><a href="/account">내 계정</a></nav><h1>리뷰함</h1><p id="status" role="status" aria-live="polite">불러오는 중…</p><details id="inbox"><summary>내 알림</summary><label><input id="unread" type="checkbox">읽지 않은 알림만</label><ul id="notifications"></ul><button id="notification-more" hidden>이전 알림 더 보기</button></details><main id="main"></main></body></html>`;

export const REVIEW_CONTROL_SOURCE = `(() => {
  const main = document.querySelector("#main");
  const status = document.querySelector("#status");
  const showStatus = (text, error) => { status.textContent = text; status.className = error ? "error" : ""; };
  const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
  const link = (text, href) => { const value = node("a", text); value.href = href; return value; };
  let clearDrafts = () => {};
  const read = async (path, options) => {
    const response = await fetch("/api/reviews" + path, { credentials: "same-origin", ...options });
    if (response.status === 401 || response.status === 403) {
      clearDrafts(); document.querySelector("#notifications").replaceChildren();
      main.replaceChildren();
      showStatus("로그인 또는 리뷰 권한이 필요합니다.", true);
      main.append(link("로그인", "/login?returnTo=" + encodeURIComponent(location.pathname + location.search)));
      throw new Error("REVIEW_FORBIDDEN");
    }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "REVIEW_UNAVAILABLE");
    return value;
  };
  const mutate = async (path, method, body) => {
    const result = await read(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!path.startsWith("/notifications/")) void refreshInbox(false);
    return result;
  };
  let notificationCursor; let notificationSequence = 0;
  const loadInbox = async (append = false) => {
    const sequence = ++notificationSequence;
    const query = new URLSearchParams(); if (document.querySelector("#unread").checked) query.set("unread", "true");
    if (append && notificationCursor) query.set("before", notificationCursor);
    const result = await read("/notifications?" + query);
    if (sequence !== notificationSequence) return;
    document.querySelector("#inbox summary").textContent = "내 알림 · 읽지 않음 " + result.unreadCount + "개";
    const list = document.querySelector("#notifications"); if (!append) list.replaceChildren();
    for (const item of result.notifications) {
      const row = node("li", undefined, "card"); const action = node("button", item.readAt ? "읽지 않음으로 표시" : "읽음으로 표시");
      action.onclick = async () => { try { await mutate("/notifications/" + item.id, "PATCH", { read: !item.readAt }); await loadInbox(); } catch (error) { showStatus(error.message, true); } };
      row.append(link(item.actor.displayName + (item.reason === "REPLY" ? "님이 답글을 남겼습니다" : item.reason === "WORKFLOW_REQUEST" ? "님이 재검토를 요청했습니다" : item.reason === "WORKFLOW_RESULT" ? "님이 재검토 결과를 남겼습니다" : "님이 나를 언급했습니다"), "/reviews/threads/" + item.threadId + "?notification=" + item.id), node("p", item.routePath + " · " + new Date(item.createdAt).toLocaleString(), "context"), action); list.append(row);
    }
    notificationCursor = result.nextCursor; document.querySelector("#notification-more").hidden = !notificationCursor;
  };
  const refreshInbox = append => loadInbox(append).catch(error => showStatus(error.message, true));
  document.querySelector("#unread").onchange = () => refreshInbox(false);
  document.querySelector("#notification-more").onclick = () => refreshInbox(true);
  void refreshInbox(false);
  setInterval(() => { if (!document.hidden && !document.querySelector("#inbox").open) void refreshInbox(false); }, 2000);
  const run = async () => {
    const parts = location.pathname.split("/");
    if (parts[2] === "threads" && parts[3]) {
      const endpoint = "/comments/" + encodeURIComponent(parts[3]);
      let detail;
      let page = { comments: [] };
      const heading = node("div");
      const list = node("ol");
      main.append(heading, list);
      let loading = false;
      const reload = async () => {
        if (loading) return;
        loading = true;
        try {
          const next = await read(endpoint);
          const oldest = page.comments[0]?.replies[0];
          while (oldest && next.comment.replyPageInfo?.hasMore && !next.comment.replies.some(reply => reply.id === oldest.id)) {
            const older = await read(endpoint + "/replies?before=" + encodeURIComponent(next.comment.replyPageInfo.nextCursor));
            next.comment.replies = [...older.replies, ...next.comment.replies];
            next.comment.replyPageInfo = older.pageInfo;
          }
          detail = next;
          if (detail.readOnly) {
            detail.principal.canManageProject = false;
            detail.comment.canEdit = false; detail.comment.canDelete = false; detail.comment.canVerify = false;
            for (const reply of detail.comment.replies) { reply.canEdit = false; reply.canDelete = false; }
          }
          page = { comments: [detail.comment] };
          heading.replaceChildren(link(detail.project.slug, "/reviews/projects/" + detail.project.id + "?revision=" + detail.revision.id),
            node("p", detail.revision.key + " · " + detail.comment.routePath, "context"));
          if (detail.readOnly) heading.append(node("p", "공유 중지 상태입니다. 저장된 리뷰를 읽을 수 있습니다.", "notice"));
          else if (!detail.targets.length) heading.append(node("p", "이 버전의 앱이 꺼져 있습니다. 댓글과 답글은 계속 사용할 수 있습니다.", "context"));
          for (const target of detail.targets) heading.append(link(target.label, target.url));
          view.render(); showStatus("저장된 리뷰");
        } finally { loading = false; }
      };
      (${REVIEW_MENTIONS_VIEW_SOURCE})(main, prefix => read(endpoint + "/mentions?prefix=" + encodeURIComponent(prefix)));
      const view = (${REVIEW_THREAD_VIEW_SOURCE})({ container: list, getPage: () => page, getContext: () => detail,
        getRoutePath: item => item.routePath, read, mutate, reload, replacePage: value => { page = value; }, showStatus,
        afterRender() {} });
      clearDrafts = view.clear;
      await reload();
      const notification = new URLSearchParams(location.search).get("notification");
      if (notification && !detail.readOnly) { await mutate("/notifications/" + encodeURIComponent(notification), "PATCH", { read: true, threadId: parts[3] }); await loadInbox(); }
      const refresh = node("button", "새로고침"); refresh.onclick = () => reload().catch(error => showStatus(error.message, true)); main.prepend(refresh);
      setInterval(() => { if (!document.hidden) reload().catch(error => showStatus(error.message, true)); }, 1500);
      return;
    }
    if (parts[2] === "projects" && parts[3]) {
      const endpoint = "/projects/" + encodeURIComponent(parts[3]);
      const { revisions } = await read(endpoint);
      const filters = node("div", undefined, "filters");
      const revision = node("select"); revision.setAttribute("aria-label", "버전");
      for (const item of revisions) { const option = node("option", item.key + " · 미해결 " + item.openCount); option.value = item.id; revision.append(option); }
      const requested = new URLSearchParams(location.search).get("revision");
      if (revisions.some(item => item.id === requested)) revision.value = requested;
      const state = node("select"); state.setAttribute("aria-label", "상태");
      for (const [value, label] of [["OPEN", "미해결"], ["ALL", "전체"], ["RESOLVED", "해결됨"]]) { const option = node("option", label); option.value = value; state.append(option); }
      const mine = node("input"); mine.type = "checkbox"; const mineLabel = node("label", "내가 시작한 리뷰 "); mineLabel.append(mine);
      const path = node("input"); path.placeholder = "전체 페이지"; path.setAttribute("aria-label", "페이지 경로 (선택)");
      const list = node("ul"); const more = node("button", "이전 댓글 더 보기"); more.hidden = true;
      filters.append(revision, state, mineLabel, path); main.append(filters, list, more);
      let cursor; let sequence = 0;
      const load = async (append = false) => {
        const current = ++sequence;
        if (!revision.value) { showStatus("저장된 버전이 없습니다."); return; }
        const query = new URLSearchParams({ status: state.value }); if (mine.checked) query.set("author", "me"); if (path.value) query.set("path", path.value); if (append && cursor) query.set("before", cursor);
        const page = await read(endpoint + "/revisions/" + revision.value + "/comments?" + query);
        if (current !== sequence) return;
        if (!append) list.replaceChildren();
        for (const item of [...page.comments].reverse()) {
          const row = node("li", undefined, "card"); row.append(link(item.body ?? "삭제된 댓글", "/reviews/threads/" + item.id), node("p", item.routePath + " · " + item.author.displayName + " · " + item.status, "context")); list.append(row);
        }
        cursor = page.pageInfo.nextCursor; more.hidden = !page.pageInfo.hasMore;
        showStatus("미해결 " + page.openCount + "개 · 현재 조건 " + page.filteredCount + "개");
      };
      const guarded = append => load(append).catch(error => showStatus(error.message, true));
      for (const control of [revision, state, mine, path]) control.onchange = () => guarded(false);
      more.onclick = () => guarded(true);
      await load(); return;
    }
    const { projects } = await read("/projects");
    const list = node("ul"); main.append(list);
    for (const project of projects) {
      const row = node("li", undefined, "card"); row.append(link(project.slug, "/reviews/projects/" + project.id), node("p", "미해결 " + project.openCount + "개 · 최근 활동 " + new Date(project.lastActivityAt).toLocaleString(), "context")); list.append(row);
    }
    showStatus(projects.length ? "프로젝트 " + projects.length + "개" : "아직 저장된 리뷰 프로젝트가 없습니다.");
  };
  run().catch(error => showStatus(error.message, true));
})();`;
