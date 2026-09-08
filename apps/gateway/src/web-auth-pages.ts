import type {
  Account,
  AccountRole,
  Principal,
} from "../../../packages/auth/src/index.ts";

function page(title: string, content: string, head = ""): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${head}<style>body{font:16px system-ui;max-width:960px;margin:48px auto;padding:0 20px;color:#18202a}form{display:grid;gap:12px;max-width:520px}input,button{font:inherit;padding:10px}fieldset{border:1px solid #ccd3da}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}.error{color:#a40000}.notice{padding:14px;background:#fff4c2;overflow-wrap:anywhere}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions form{display:block}</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}

export function sessionExchangePage(location: string): string {
  const escaped = escapeHtml(location);
  return page(
    "공유 페이지로 이동",
    `<p>로그인되었습니다. 공유 페이지로 이동합니다.</p><p><a href="${escaped}" rel="noreferrer">자동으로 이동하지 않으면 여기를 누르세요.</a></p>`,
    `<meta http-equiv="refresh" content="0;url=${escaped}">`,
  );
}

export function operationsPage(killSwitchEnabled: boolean): string {
  const targetState = killSwitchEnabled ? "false" : "true";
  const action = killSwitchEnabled ? "공유 기능 다시 활성화" : "모든 공유 즉시 중지";
  const passwordField = `<label>관리자 비밀번호 <input type="password" name="adminPassword" autocomplete="current-password" required></label>`;
  return page(
    "운영 제어",
    `<p>현재 kill switch: <strong>${killSwitchEnabled ? "활성화됨" : "비활성화됨"}</strong></p><p>활성화하면 신규 요청·재연결을 차단하고 현재 Tunnel과 열린 Stream을 종료합니다.</p><form method="post" action="/admin/operations/kill-switch"><input type="hidden" name="enabled" value="${targetState}">${passwordField}<button type="submit">${action}</button></form>`,
  );
}

export function loginPage(intent: string | null, error: string | undefined, returnTo = ""): string {
  return page("Review Tunnel 로그인", `${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}<p>관리자가 발급한 계정으로 로그인하세요.</p><form method="post" action="/login${returnTo === "" ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}"><input type="hidden" name="intent" value="${escapeHtml(intent ?? "")}"><label>아이디 <input name="username" autocomplete="username" required></label><label>비밀번호 <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">로그인</button></form>`);
}

export function passwordChangePage(intent: string | null, error: string | undefined, returnTo = ""): string {
  return page("비밀번호 변경", `${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}<p>임시 비밀번호를 15자 이상의 새 비밀번호로 변경하세요.</p><form method="post" action="/account/change-password${returnTo === "" ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}"><input type="hidden" name="intent" value="${escapeHtml(intent ?? "")}"><label>현재 비밀번호 <input type="password" name="currentPassword" autocomplete="current-password" required></label><label>새 비밀번호 <input type="password" name="newPassword" autocomplete="new-password" minlength="15" maxlength="128" required></label><label>새 비밀번호 확인 <input type="password" name="confirmation" autocomplete="new-password" minlength="15" maxlength="128" required></label><button type="submit">변경</button></form>`);
}

export function accountPage(principal: Principal): string {
  return page("내 계정", `<p>${escapeHtml(principal.displayName)} (${escapeHtml(principal.username)})</p><p>권한: ${principal.roles.map(escapeHtml).join(", ")}</p><p><a href="/reviews">리뷰함</a> · <a href="/account/change-password">비밀번호 변경</a></p><form method="post" action="/logout"><button type="submit">로그아웃</button></form>`);
}

export function usersPage(
  principal: Principal,
  accounts: readonly Account[],
): string {
  const passwordField = `<label>관리자 비밀번호 <input type="password" name="adminPassword" autocomplete="current-password" required></label>`;
  const rows = accounts.map((account) => {
    const accountPath = `/admin/users/${encodeURIComponent(account.id)}`;
    const passwordAction = account.id === principal.accountId
      ? `<a href="/account/change-password">내 비밀번호 변경</a>`
      : `<form method="post" action="${accountPath}/reset">${passwordField}<button>비밀번호 초기화</button></form>`;
    return `<tr><td>${escapeHtml(account.username)}</td><td>${escapeHtml(account.displayName)}</td><td><form method="post" action="${accountPath}/roles"><fieldset>${roleCheckboxes(account.roles)}</fieldset>${passwordField}<button>권한 저장</button></form></td><td>${account.enabled ? "활성" : "정지"}${account.mustChangePassword ? " · 변경 필요" : ""}</td><td><div class="actions"><form method="post" action="${accountPath}/${account.enabled ? "disable" : "enable"}">${passwordField}<button>${account.enabled ? "정지" : "활성화"}</button></form>${passwordAction}<form method="post" action="${accountPath}/revoke">${passwordField}<button>세션 종료</button></form></div></td></tr>`;
  }).join("");
  return page("계정 관리", `<p>관리자: ${escapeHtml(principal.username)}</p><p>계정 변경 작업은 관리자 비밀번호를 다시 확인합니다.</p><h2>계정 생성</h2><form method="post" action="/admin/users"><label>아이디 <input name="username" required></label><label>표시 이름 <input name="displayName" required></label><fieldset>${roleCheckboxes(["REVIEWER"])}</fieldset>${passwordField}<button>계정 생성</button></form><h2>계정 목록</h2><table><thead><tr><th>아이디</th><th>이름</th><th>권한</th><th>상태</th><th>작업</th></tr></thead><tbody>${rows}</tbody></table><form method="post" action="/logout"><button>로그아웃</button></form>`);
}

export function temporaryPasswordSuccessPage(
  username: string,
  temporaryPassword: string,
): string {
  return page(
    "임시 비밀번호 발급",
    `<div class="notice"><strong>${escapeHtml(username)} 임시 비밀번호</strong><p>${escapeHtml(temporaryPassword)}</p><p>다시 표시되지 않습니다.</p></div><p><a href="/admin/users">계정 관리로 돌아가기</a></p>`,
  );
}

function roleCheckboxes(selected: readonly AccountRole[]): string {
  return (["ADMIN", "DEVELOPER", "REVIEWER"] as const).map((role) => `<label><input type="checkbox" name="roles" value="${role}"${selected.includes(role) ? " checked" : ""}> ${role}</label>`).join(" ");
}

export function messagePage(message: string): string {
  return page("Review Tunnel", `<p>${escapeHtml(message)}</p>`);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
