import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AuthError,
  type Account,
  type AccountRole,
  type AuthService,
  type Principal,
} from "../../../packages/auth/src/index.ts";

const MAX_FORM_BYTES = 16 * 1024;

export type WebAuthOptions = Readonly<{
  authService: AuthService;
  controlHost: string;
  secureCookies?: boolean;
  setKillSwitch?: (enabled: boolean, actor: Principal) => void;
  getKillSwitch?: () => boolean;
}>;

export type WebAuthHandler = Readonly<{
  handleControl(request: IncomingMessage, response: ServerResponse): Promise<void>;
  authorizeContent(request: IncomingMessage, response: ServerResponse): Promise<Principal | undefined>;
  resolveContentUpgrade(request: IncomingMessage): Promise<Principal | undefined>;
}>;

export function createWebAuthHandler(options: WebAuthOptions): WebAuthHandler {
  const secureCookies = options.secureCookies ?? true;
  const scheme = secureCookies ? "https" : "http";
  const controlCookie = secureCookies ? "__Host-rt_control" : "rt_control_dev";
  const contentCookie = secureCookies ? "__Host-rt_session" : "rt_session_dev";

  return {
    async handleControl(request, response) {
      applySecurityHeaders(response);
      const url = new URL(request.url ?? "/", `${scheme}://${request.headers.host ?? options.controlHost}`);
      const principal = await resolveCookiePrincipal(options.authService, request, controlCookie);
      try {
        if (request.method === "POST" && url.pathname === "/api/client/login") {
          requireCliRequest(request);
          const form = await readForm(request);
          const login = await options.authService.authenticate({
            username: requiredFormValue(form, "username"),
            password: requiredFormValue(form, "password"),
            remoteAddress: request.socket.remoteAddress ?? "unknown",
          });
          if (login.principal.mustChangePassword) {
            throw new AuthError("PASSWORD_CHANGE_REQUIRED", "먼저 웹 또는 관리자 CLI에서 비밀번호를 변경하세요.");
          }
          if (!login.principal.roles.includes("DEVELOPER")) {
            throw new AuthError("FORBIDDEN", "개발자 권한이 필요합니다.");
          }
          writeJson(response, 200, { sessionToken: login.sessionToken, expiresInSeconds: 43_200 });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/carrier-credentials") {
          requireCliRequest(request);
          const token = bearerToken(request.headers.authorization);
          const clientPrincipal = token === undefined
            ? undefined
            : await options.authService.resolveSession(token);
          if (clientPrincipal === undefined) throw new AuthError("FORBIDDEN", "로그인이 필요합니다.");
          const form = await readForm(request);
          const purpose = requiredFormValue(form, "purpose");
          if (purpose !== "create" && purpose !== "resume") {
            throw new AuthError("INVALID_ACCOUNT_INPUT", "올바르지 않은 Carrier 목적입니다.");
          }
          const tunnelId = purpose === "create"
            ? randomBytes(16).toString("hex")
            : requiredFormValue(form, "tunnelId");
          const credential = await options.authService.issueCarrierCredential(clientPrincipal, {
            purpose,
            tunnelId,
          });
          writeJson(response, 201, { credential, tunnelId, expiresInSeconds: 60 });
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/admin/operations" &&
          options.getKillSwitch !== undefined
        ) {
          requireAdministrator(principal);
          writeHtml(response, 200, operationsPage(options.getKillSwitch()));
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/admin/operations/kill-switch" &&
          options.setKillSwitch !== undefined &&
          options.getKillSwitch !== undefined
        ) {
          requireSameOrigin(request, scheme);
          const administrator = requireAdministrator(principal);
          const form = await readForm(request);
          await confirmAdministratorPassword(
            options.authService,
            administrator,
            form,
            request.socket.remoteAddress ?? "unknown",
          );
          options.setKillSwitch(
            requiredFormValue(form, "enabled") === "true",
            administrator,
          );
          writeHtml(response, 200, operationsPage(options.getKillSwitch()));
          return;
        }
        if (request.method === "GET" && url.pathname === "/login") {
          if (principal !== undefined && !principal.mustChangePassword && url.searchParams.has("intent")) {
            await redirectToExchange(options.authService, principal, url.searchParams.get("intent") ?? "", response, scheme);
            return;
          }
          writeHtml(response, 200, loginPage(url.searchParams.get("intent"), undefined));
          return;
        }
        if (request.method === "POST" && url.pathname === "/login") {
          requireSameOrigin(request, scheme);
          const form = await readForm(request);
          const login = await options.authService.authenticate({
            username: requiredFormValue(form, "username"),
            password: requiredFormValue(form, "password"),
            remoteAddress: request.socket.remoteAddress ?? "unknown",
          });
          setSessionCookie(response, controlCookie, login.sessionToken, secureCookies);
          const intent = form.get("intent") ?? "";
          if (login.principal.mustChangePassword) {
            redirect(response, `/account/change-password${intent === "" ? "" : `?intent=${encodeURIComponent(intent)}`}`);
          } else if (intent !== "") {
            await redirectToExchange(options.authService, login.principal, intent, response, scheme);
          } else {
            redirect(response, login.principal.roles.includes("ADMIN") ? "/admin/users" : "/account");
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/account/change-password") {
          if (principal === undefined) {
            redirect(response, `/login${url.search}`);
            return;
          }
          writeHtml(response, 200, passwordChangePage(url.searchParams.get("intent"), undefined));
          return;
        }
        if (request.method === "POST" && url.pathname === "/account/change-password") {
          requireSameOrigin(request, scheme);
          if (principal === undefined) throw new AuthError("FORBIDDEN", "로그인이 필요합니다.");
          const form = await readForm(request);
          const currentPassword = requiredFormValue(form, "currentPassword");
          const newPassword = requiredFormValue(form, "newPassword");
          if (newPassword !== requiredFormValue(form, "confirmation")) {
            throw new AuthError("WEAK_PASSWORD", "새 비밀번호 확인이 일치하지 않습니다.");
          }
          await options.authService.changeOwnPassword(principal, { currentPassword, newPassword });
          const login = await options.authService.authenticate({
            username: principal.username,
            password: newPassword,
            remoteAddress: request.socket.remoteAddress ?? "unknown",
          });
          setSessionCookie(response, controlCookie, login.sessionToken, secureCookies);
          const intent = form.get("intent") ?? "";
          if (intent !== "") {
            await redirectToExchange(options.authService, login.principal, intent, response, scheme);
          } else {
            redirect(response, login.principal.roles.includes("ADMIN") ? "/admin/users" : "/account");
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/logout") {
          requireSameOrigin(request, scheme);
          if (principal !== undefined) await options.authService.logout(principal);
          clearSessionCookie(response, controlCookie, secureCookies);
          redirect(response, "/login");
          return;
        }
        if (request.method === "GET" && url.pathname === "/account") {
          if (principal === undefined) {
            redirect(response, "/login");
            return;
          }
          writeHtml(response, 200, accountPage(principal));
          return;
        }
        if (url.pathname === "/admin/users" && request.method === "GET") {
          const administrator = requireAdministrator(principal);
          const accounts = await options.authService.listAccounts(administrator);
          writeHtml(response, 200, usersPage(administrator, accounts));
          return;
        }
        if (url.pathname === "/admin/users" && request.method === "POST") {
          requireSameOrigin(request, scheme);
          const administrator = requireAdministrator(principal);
          const form = await readForm(request);
          await confirmAdministratorPassword(
            options.authService,
            administrator,
            form,
            request.socket.remoteAddress ?? "unknown",
          );
          const result = await options.authService.createAccount(administrator, {
            username: requiredFormValue(form, "username"),
            displayName: requiredFormValue(form, "displayName"),
            roles: rolesFromForm(form),
          });
          const accounts = await options.authService.listAccounts(administrator);
          writeHtml(response, 201, usersPage(administrator, accounts, {
            username: result.account.username,
            temporaryPassword: result.temporaryPassword,
          }));
          return;
        }
        const action = matchAdminAction(url.pathname);
        if (action !== undefined && request.method === "POST") {
          requireSameOrigin(request, scheme);
          const administrator = requireAdministrator(principal);
          const accounts = await options.authService.listAccounts(administrator);
          const target = accounts.find((account) => account.id === action.accountId);
          if (target === undefined) throw new AuthError("ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
          const form = await readForm(request);
          await confirmAdministratorPassword(
            options.authService,
            administrator,
            form,
            request.socket.remoteAddress ?? "unknown",
          );
          if (action.action === "enable") await options.authService.setAccountEnabled(administrator, target.id, true);
          else if (action.action === "disable") await options.authService.setAccountEnabled(administrator, target.id, false);
          else if (action.action === "roles") await options.authService.setAccountRoles(administrator, target.id, rolesFromForm(form));
          else if (action.action === "revoke") await options.authService.revokeSessions(administrator, target.id);
          else {
            const reset = await options.authService.resetPassword(administrator, target.id);
            const updated = await options.authService.listAccounts(administrator);
            writeHtml(response, 200, usersPage(administrator, updated, {
              username: reset.account.username,
              temporaryPassword: reset.temporaryPassword,
            }));
            return;
          }
          redirect(response, "/admin/users");
          return;
        }
        writeHtml(response, 404, messagePage("페이지를 찾을 수 없습니다."));
      } catch (error) {
        handleWebError(response, error, url.pathname, url.searchParams.get("intent"));
      }
    },

    async authorizeContent(request, response) {
      applySecurityHeaders(response);
      const host = normalizedAuthority(request.headers.host);
      const url = new URL(request.url ?? "/", `${scheme}://${host}`);
      if (url.pathname === "/_review-tunnel/session") {
        const code = url.searchParams.get("code") ?? "";
        try {
          const exchanged = await options.authService.consumeSessionExchange(code, host);
          setSessionCookie(response, contentCookie, exchanged.sessionToken, secureCookies);
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Referrer-Policy", "no-referrer");
          redirect(response, exchanged.targetPath);
        } catch (error) {
          handleWebError(response, error, url.pathname, null);
        }
        return undefined;
      }
      const principal = await resolveCookiePrincipal(
        options.authService,
        request,
        contentCookie,
        `content:${host}`,
      );
      if (principal !== undefined && principal.roles.includes("REVIEWER") && !principal.mustChangePassword) {
        return principal;
      }
      const acceptsHtml = request.method === "GET" && (request.headers.accept ?? "").includes("text/html");
      if (!acceptsHtml) {
        writeJsonError(response, 401, "AUTHENTICATION_REQUIRED");
        return undefined;
      }
      const intent = await options.authService.createLoginIntent(host, url.pathname + url.search);
      redirect(response, `${scheme}://${options.controlHost}/login?intent=${encodeURIComponent(intent)}`);
      return undefined;
    },

    async resolveContentUpgrade(request) {
      const authority = normalizedAuthority(request.headers.host);
      const principal = await resolveCookiePrincipal(
        options.authService,
        request,
        contentCookie,
        `content:${authority}`,
      );
      return principal?.roles.includes("REVIEWER") === true && !principal.mustChangePassword
        ? principal
        : undefined;
    },
  };
}

function requireAdministrator(principal: Principal | undefined): Principal {
  if (principal === undefined) throw new AuthError("FORBIDDEN", "로그인이 필요합니다.");
  if (principal.mustChangePassword) throw new AuthError("PASSWORD_CHANGE_REQUIRED", "먼저 비밀번호를 변경하세요.");
  if (!principal.roles.includes("ADMIN")) throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
  return principal;
}

async function confirmAdministratorPassword(
  service: AuthService,
  administrator: Principal,
  form: URLSearchParams,
  remoteAddress: string,
): Promise<void> {
  const confirmation = await service.authenticate({
    username: administrator.username,
    password: requiredFormValue(form, "adminPassword"),
    remoteAddress,
  });
  try {
    if (!confirmation.principal.roles.includes("ADMIN") || confirmation.principal.mustChangePassword) {
      throw new AuthError("FORBIDDEN", "관리자 권한이 필요합니다.");
    }
  } finally {
    await service.logout(confirmation.principal);
  }
}

async function resolveCookiePrincipal(
  service: AuthService,
  request: IncomingMessage,
  name: string,
  audience = "control",
): Promise<Principal | undefined> {
  const token = parseCookie(request.headers.cookie, name);
  return token === undefined ? undefined : service.resolveSession(token, audience);
}

async function redirectToExchange(
  service: AuthService,
  principal: Principal,
  intent: string,
  response: ServerResponse,
  scheme: string,
): Promise<void> {
  const exchange = await service.createSessionExchange(principal, intent);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  redirect(
    response,
    `${scheme}://${exchange.targetHost}/_review-tunnel/session?code=${encodeURIComponent(exchange.code)}`,
  );
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
    throw new AuthError("INVALID_ACCOUNT_INPUT", "지원하지 않는 요청 형식입니다.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_FORM_BYTES) throw new AuthError("INVALID_ACCOUNT_INPUT", "요청이 너무 큽니다.");
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = form.get(name);
  if (value === null || value === "") throw new AuthError("INVALID_ACCOUNT_INPUT", `${name} 값이 필요합니다.`);
  return value;
}

function rolesFromForm(form: URLSearchParams): readonly AccountRole[] {
  const allowed = new Set<AccountRole>(["ADMIN", "DEVELOPER", "REVIEWER"]);
  const roles = form.getAll("roles").filter((role): role is AccountRole => allowed.has(role as AccountRole));
  if (roles.length === 0) throw new AuthError("INVALID_ACCOUNT_INPUT", "하나 이상의 권한이 필요합니다.");
  return roles;
}

function requireSameOrigin(request: IncomingMessage, scheme: string): void {
  const host = request.headers.host;
  if (host === undefined || request.headers.origin !== `${scheme}://${host}`) {
    throw new AuthError("FORBIDDEN", "요청 출처를 확인할 수 없습니다.");
  }
}

function requireCliRequest(request: IncomingMessage): void {
  if (request.headers["x-review-tunnel-client"] !== "1" || request.headers.origin !== undefined) {
    throw new AuthError("FORBIDDEN", "올바르지 않은 Client 요청입니다.");
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  return token.length >= 20 && token.length <= 512 ? token : undefined;
}

function normalizedAuthority(hostHeader: string | undefined): string {
  if (hostHeader === undefined) return "";
  try {
    return new URL(`http://${hostHeader}`).host.toLowerCase();
  } catch {
    return "";
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const encoded = values[0]?.slice(name.length + 1);
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function setSessionCookie(response: ServerResponse, name: string, token: string, secure: boolean): void {
  response.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(response: ServerResponse, name: string, secure: boolean): void {
  response.setHeader(
    "Set-Cookie",
    `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.end();
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(body);
}

function writeJsonError(response: ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: code }));
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: Readonly<Record<string, string | number>>,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function handleWebError(
  response: ServerResponse,
  error: unknown,
  path: string,
  intent: string | null,
): void {
  if (!(error instanceof AuthError)) {
    writeHtml(response, 500, messagePage("요청을 처리하지 못했습니다."));
    return;
  }
  const status = error.code === "LOGIN_THROTTLED" ? 429
    : error.code === "FORBIDDEN" ? 403
    : error.code === "ACCOUNT_NOT_FOUND" ? 404
    : 400;
  if (path.startsWith("/api/")) writeJsonError(response, status, error.code);
  else if (path === "/login") writeHtml(response, status, loginPage(intent, error.message));
  else if (path === "/account/change-password") {
    writeHtml(response, status, passwordChangePage(intent, error.message));
  } else writeHtml(response, status, messagePage(error.message));
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:960px;margin:48px auto;padding:0 20px;color:#18202a}form{display:grid;gap:12px;max-width:520px}input,button{font:inherit;padding:10px}fieldset{border:1px solid #ccd3da}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}.error{color:#a40000}.notice{padding:14px;background:#fff4c2;overflow-wrap:anywhere}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions form{display:block}</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}

function operationsPage(killSwitchEnabled: boolean): string {
  const targetState = killSwitchEnabled ? "false" : "true";
  const action = killSwitchEnabled ? "공유 기능 다시 활성화" : "모든 공유 즉시 중지";
  const passwordField = `<label>관리자 비밀번호 <input type="password" name="adminPassword" autocomplete="current-password" required></label>`;
  return page(
    "운영 제어",
    `<p>현재 kill switch: <strong>${killSwitchEnabled ? "활성화됨" : "비활성화됨"}</strong></p><p>활성화하면 신규 요청·재연결을 차단하고 현재 Tunnel과 열린 Stream을 종료합니다.</p><form method="post" action="/admin/operations/kill-switch"><input type="hidden" name="enabled" value="${targetState}">${passwordField}<button type="submit">${action}</button></form>`,
  );
}

function loginPage(intent: string | null, error: string | undefined): string {
  return page("Review Tunnel 로그인", `${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}<p>관리자가 발급한 내부 계정으로 로그인하세요.</p><form method="post" action="/login"><input type="hidden" name="intent" value="${escapeHtml(intent ?? "")}"><label>아이디 <input name="username" autocomplete="username" required></label><label>비밀번호 <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">로그인</button></form>`);
}

function passwordChangePage(intent: string | null, error: string | undefined): string {
  return page("비밀번호 변경", `${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}<p>임시 비밀번호를 15자 이상의 새 비밀번호로 변경하세요.</p><form method="post" action="/account/change-password"><input type="hidden" name="intent" value="${escapeHtml(intent ?? "")}"><label>현재 비밀번호 <input type="password" name="currentPassword" autocomplete="current-password" required></label><label>새 비밀번호 <input type="password" name="newPassword" autocomplete="new-password" minlength="15" maxlength="128" required></label><label>새 비밀번호 확인 <input type="password" name="confirmation" autocomplete="new-password" minlength="15" maxlength="128" required></label><button type="submit">변경</button></form>`);
}

function accountPage(principal: Principal): string {
  return page("내 계정", `<p>${escapeHtml(principal.displayName)} (${escapeHtml(principal.username)})</p><p>권한: ${principal.roles.map(escapeHtml).join(", ")}</p><form method="post" action="/logout"><button type="submit">로그아웃</button></form>`);
}

function usersPage(
  principal: Principal,
  accounts: readonly Account[],
  temporary?: Readonly<{ username: string; temporaryPassword: string }>,
): string {
  const notice = temporary === undefined ? "" : `<div class="notice"><strong>${escapeHtml(temporary.username)} 임시 비밀번호</strong><p>${escapeHtml(temporary.temporaryPassword)}</p><p>다시 표시되지 않습니다.</p></div>`;
  const passwordField = `<label>관리자 비밀번호 <input type="password" name="adminPassword" autocomplete="current-password" required></label>`;
  const rows = accounts.map((account) => `<tr><td>${escapeHtml(account.username)}</td><td>${escapeHtml(account.displayName)}</td><td><form method="post" action="/admin/users/${encodeURIComponent(account.id)}/roles"><fieldset>${roleCheckboxes(account.roles)}</fieldset>${passwordField}<button>권한 저장</button></form></td><td>${account.enabled ? "활성" : "정지"}${account.mustChangePassword ? " · 변경 필요" : ""}</td><td><div class="actions"><form method="post" action="/admin/users/${encodeURIComponent(account.id)}/${account.enabled ? "disable" : "enable"}">${passwordField}<button>${account.enabled ? "정지" : "활성화"}</button></form><form method="post" action="/admin/users/${encodeURIComponent(account.id)}/reset">${passwordField}<button>비밀번호 초기화</button></form><form method="post" action="/admin/users/${encodeURIComponent(account.id)}/revoke">${passwordField}<button>세션 종료</button></form></div></td></tr>`).join("");
  return page("계정 관리", `<p>관리자: ${escapeHtml(principal.username)}</p>${notice}<p>계정 변경 작업은 관리자 비밀번호를 다시 확인합니다.</p><h2>계정 생성</h2><form method="post" action="/admin/users"><label>아이디 <input name="username" required></label><label>표시 이름 <input name="displayName" required></label><fieldset>${roleCheckboxes(["REVIEWER"])}</fieldset>${passwordField}<button>계정 생성</button></form><h2>계정 목록</h2><table><thead><tr><th>아이디</th><th>이름</th><th>권한</th><th>상태</th><th>작업</th></tr></thead><tbody>${rows}</tbody></table><form method="post" action="/logout"><button>로그아웃</button></form>`);
}

function roleCheckboxes(selected: readonly AccountRole[]): string {
  return (["ADMIN", "DEVELOPER", "REVIEWER"] as const).map((role) => `<label><input type="checkbox" name="roles" value="${role}"${selected.includes(role) ? " checked" : ""}> ${role}</label>`).join(" ");
}

function messagePage(message: string): string {
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

function matchAdminAction(pathname: string): Readonly<{
  accountId: string;
  action: "enable" | "disable" | "roles" | "reset" | "revoke";
}> | undefined {
  const match = /^\/admin\/users\/([^/]+)\/(enable|disable|roles|reset|revoke)$/.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    accountId: decodeURIComponent(match[1]),
    action: match[2] as "enable" | "disable" | "roles" | "reset" | "revoke",
  };
}
