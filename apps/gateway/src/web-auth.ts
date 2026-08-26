import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AuthError,
  type AccountAuthorization,
  type AccountRole,
  type AuthService,
  type Principal,
} from "../../../packages/auth/src/index.ts";
import { createClientAddressResolver } from "./client-address.ts";
import { retainAdmissionUntilSettled } from "./retained-operation.ts";
import {
  accountPage,
  escapeHtml,
  loginPage,
  messagePage,
  operationsPage,
  passwordChangePage,
  temporaryPasswordSuccessPage,
  usersPage,
} from "./web-auth-pages.ts";

export { escapeHtml };

const MAX_FORM_BYTES = 16 * 1024;
const DEFAULT_AUTHORIZATION_QUERY_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CONCURRENT_WEB_AUTHORIZATIONS = 32;
const DEFAULT_MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE = 4;

export type WebAuthOptions = Readonly<{
  authService: AuthService;
  controlHost: string;
  secureCookies?: boolean;
  setKillSwitch?: (enabled: boolean, actor: AccountAuthorization) => Promise<void>;
  getKillSwitch?: () => boolean;
  reserveCarrierCredential?: (
    principal: Principal,
    purpose: "create" | "resume",
    tunnelId: string,
  ) => (() => void) | undefined;
  admitLoginIntent?: (remoteAddress: string, targetHost: string) => boolean;
  maxConcurrentLoginAttempts?: number;
  maxConcurrentLoginAttemptsPerRemote?: number;
  loginAttemptsPerMinute?: number;
  loginAttemptsPerRemotePerMinute?: number;
  authorizationQueryTimeoutMs?: number;
  maxConcurrentWebAuthorizations?: number;
  maxConcurrentWebAuthorizationsPerRemote?: number;
  trustedProxyCidrs?: readonly string[];
  maxForwardedForEntries?: number;
}>;

export type WebAuthHandler = Readonly<{
  handleControl(request: IncomingMessage, response: ServerResponse): Promise<void>;
  authorizeContent(request: IncomingMessage, response: ServerResponse): Promise<Principal | undefined>;
  resolveContentUpgrade(request: IncomingMessage): Promise<Principal | undefined>;
}>;

export class WebAuthBoundaryError extends Error {
  readonly statusCode: 429 | 503;
  readonly code: "AUTHENTICATION_CAPACITY" | "AUTHENTICATION_UNAVAILABLE";

  constructor(
    statusCode: 429 | 503,
    code: "AUTHENTICATION_CAPACITY" | "AUTHENTICATION_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "WebAuthBoundaryError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createWebAuthHandler(options: WebAuthOptions): WebAuthHandler {
  const secureCookies = options.secureCookies ?? true;
  const scheme = secureCookies ? "https" : "http";
  const controlCookie = secureCookies ? "__Host-rt_control" : "rt_control_dev";
  const contentCookie = secureCookies ? "__Host-rt_session" : "rt_session_dev";
  const authorizationQueryTimeoutMs = options.authorizationQueryTimeoutMs ??
    DEFAULT_AUTHORIZATION_QUERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(authorizationQueryTimeoutMs) || authorizationQueryTimeoutMs <= 0) {
    throw new RangeError("authorizationQueryTimeoutMs must be a positive safe integer");
  }
  const maxConcurrentWebAuthorizations = options.maxConcurrentWebAuthorizations ??
    DEFAULT_MAX_CONCURRENT_WEB_AUTHORIZATIONS;
  const maxConcurrentWebAuthorizationsPerRemote =
    options.maxConcurrentWebAuthorizationsPerRemote ??
      DEFAULT_MAX_CONCURRENT_WEB_AUTHORIZATIONS_PER_REMOTE;
  const webAuthorizationAdmission = createConcurrentAdmission({
    global: maxConcurrentWebAuthorizations,
    perRemote: maxConcurrentWebAuthorizationsPerRemote,
  });
  const resolveClientAddress = createClientAddressResolver({
    trustedProxyCidrs: options.trustedProxyCidrs ?? [],
    ...(options.maxForwardedForEntries === undefined
      ? {}
      : { maxForwardedForEntries: options.maxForwardedForEntries }),
  });
  const clientAddress = (request: IncomingMessage): string => {
    let forwardedHeaderCount = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "x-forwarded-for") {
        forwardedHeaderCount += 1;
      }
    }
    return resolveClientAddress(
      request.socket.remoteAddress,
      forwardedHeaderCount > 1 ? [] : request.headers["x-forwarded-for"],
    );
  };
  const authorizationDeadlines = new WeakMap<IncomingMessage, number>();
  const startAdmittedAuthorizationOperation = <T>(
    request: IncomingMessage,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const release = webAuthorizationAdmission.acquire(clientAddress(request));
    if (release === undefined) {
      throw new WebAuthBoundaryError(
        429,
        "AUTHENTICATION_CAPACITY",
        "web authentication capacity exceeded",
      );
    }
    const running = Promise.resolve().then(operation);
    retainAdmissionUntilSettled(running, release);
    return running;
  };
  const runAuthorizationQuery = <T>(
    request: IncomingMessage,
    operation: () => Promise<T>,
  ): Promise<T> => {
    let deadlineAt = authorizationDeadlines.get(request);
    if (deadlineAt === undefined) {
      deadlineAt = Date.now() + authorizationQueryTimeoutMs;
      authorizationDeadlines.set(request, deadlineAt);
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new WebAuthBoundaryError(
        503,
        "AUTHENTICATION_UNAVAILABLE",
        "web authentication deadline exceeded",
      );
    }
    const running = startAdmittedAuthorizationOperation(request, operation);
    return withDeadline(
      running,
      remainingMs,
      new WebAuthBoundaryError(
        503,
        "AUTHENTICATION_UNAVAILABLE",
        "web authentication deadline exceeded",
      ),
    );
  };
  const runAuthorizationMutation = <T>(
    request: IncomingMessage,
    operation: () => Promise<T>,
  ): Promise<T> => startAdmittedAuthorizationOperation(request, operation);
  const loginAttempts = createLoginAttemptLimiter({
    maxConcurrent: options.maxConcurrentLoginAttempts ?? 32,
    maxConcurrentPerRemote: options.maxConcurrentLoginAttemptsPerRemote ?? 4,
    maxPerMinute: options.loginAttemptsPerMinute ?? 1_000,
    maxPerRemotePerMinute: options.loginAttemptsPerRemotePerMinute ?? 30,
  });
  const withCredentialAttempt = async <T>(
    remoteAddress: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const release = loginAttempts.acquire(remoteAddress);
    if (release === undefined) {
      throw new AuthError("LOGIN_THROTTLED", "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.");
    }
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const authenticateWithinAdmission = (input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>) => withCredentialAttempt(
    input.remoteAddress,
    () => options.authService.authenticate(input),
  );
  const createSessionExchangeWithLoginCompensation = async (
    login: Awaited<ReturnType<AuthService["authenticate"]>>,
    intent: string,
  ) => {
    if (intent === "") return undefined;
    try {
      return await options.authService.createSessionExchange(login.principal, intent);
    } catch (error) {
      await options.authService.logout(login.principal);
      throw error;
    }
  };
  const verifyAdministratorCredentialsWithinAdmission = (input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>) => withCredentialAttempt(
    input.remoteAddress,
    () => options.authService.verifyAdministratorCredentials(input),
  );
  const resolveCookiePrincipalForRequest = (
    request: IncomingMessage,
    name: string,
    audience = "control",
  ): Promise<Principal | undefined> => {
    const token = parseCookie(request.headers.cookie, name);
    return token === undefined
      ? Promise.resolve(undefined)
      : runAuthorizationQuery(
          request,
          () => options.authService.resolveSession(token, audience),
        );
  };
  const redirectToExchangeForRequest = (
    request: IncomingMessage,
    principal: Principal,
    intent: string,
    response: ServerResponse,
  ): Promise<void> => redirectToExchange(
    (candidate, loginIntent) => runAuthorizationMutation(
      request,
      () => options.authService.createSessionExchange(candidate, loginIntent),
    ),
    principal,
    intent,
    response,
    scheme,
  );

  const handler: WebAuthHandler = {
    async handleControl(request, response) {
      applySecurityHeaders(response);
      const url = new URL(request.url ?? "/", `${scheme}://${request.headers.host ?? options.controlHost}`);
      const principal = await resolveCookiePrincipalForRequest(request, controlCookie);
      try {
        if (request.method === "POST" && url.pathname === "/api/client/login") {
          requireCliRequest(request);
          const form = await readForm(request);
          const loginInput = {
            username: requiredFormValue(form, "username"),
            password: requiredFormValue(form, "password"),
            remoteAddress: clientAddress(request),
          };
          const login = await runAuthorizationMutation(request, async () => {
            const candidate = await authenticateWithinAdmission(loginInput);
            if (candidate.principal.mustChangePassword) {
              await options.authService.logout(candidate.principal);
              throw new AuthError(
                "PASSWORD_CHANGE_REQUIRED",
                "먼저 웹 또는 관리자 CLI에서 비밀번호를 변경하세요.",
              );
            }
            if (!candidate.principal.roles.includes("DEVELOPER")) {
              await options.authService.logout(candidate.principal);
              throw new AuthError("FORBIDDEN", "개발자 권한이 필요합니다.");
            }
            return candidate;
          });
          writeJson(response, 200, { sessionToken: login.sessionToken, expiresInSeconds: 43_200 });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/client/logout") {
          requireCliRequest(request);
          const token = bearerToken(request.headers.authorization);
          const clientPrincipal = token === undefined
            ? undefined
            : await runAuthorizationQuery(
                request,
                () => options.authService.resolveSession(token),
              );
          if (clientPrincipal !== undefined) {
            await runAuthorizationMutation(
              request,
              () => options.authService.logout(clientPrincipal),
            );
          }
          writeNoContent(response);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/carrier-credentials") {
          requireCliRequest(request);
          const token = bearerToken(request.headers.authorization);
          const clientPrincipal = token === undefined
            ? undefined
            : await runAuthorizationQuery(
                request,
                () => options.authService.resolveSession(token),
              );
          if (clientPrincipal === undefined) throw new AuthError("FORBIDDEN", "로그인이 필요합니다.");
          const form = await readForm(request);
          const purpose = requiredFormValue(form, "purpose");
          if (purpose !== "create" && purpose !== "resume") {
            throw new AuthError("INVALID_ACCOUNT_INPUT", "올바르지 않은 Carrier 목적입니다.");
          }
          const tunnelId = purpose === "create"
            ? randomBytes(16).toString("hex")
            : requiredFormValue(form, "tunnelId");
          const releaseReservation = options.reserveCarrierCredential?.(
            clientPrincipal,
            purpose,
            tunnelId,
          );
          if (options.reserveCarrierCredential !== undefined && releaseReservation === undefined) {
            response.setHeader("Retry-After", "60");
            writeJsonError(response, 429, "TUNNEL_LIMIT_EXCEEDED");
            return;
          }
          let credential: string;
          try {
            credential = await runAuthorizationMutation(
              request,
              () => options.authService.issueCarrierCredential(clientPrincipal, {
                purpose,
                tunnelId,
              }),
            );
          } catch (error) {
            releaseReservation?.();
            throw error;
          }
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
          await runAuthorizationMutation(request, async () => {
            const confirmedAdministrator = await confirmAdministratorPassword(
              verifyAdministratorCredentialsWithinAdmission,
              administrator,
              form,
              clientAddress(request),
            );
            await options.setKillSwitch?.(
              requiredBooleanFormValue(form, "enabled"),
              confirmedAdministrator,
            );
          });
          writeHtml(response, 200, operationsPage(options.getKillSwitch()));
          return;
        }
        if (request.method === "GET" && url.pathname === "/login") {
          if (principal !== undefined && !principal.mustChangePassword && url.searchParams.has("intent")) {
            await redirectToExchangeForRequest(
              request,
              principal,
              url.searchParams.get("intent") ?? "",
              response,
            );
            return;
          }
          writeHtml(response, 200, loginPage(url.searchParams.get("intent"), undefined));
          return;
        }
        if (request.method === "POST" && url.pathname === "/login") {
          requireSameOrigin(request, scheme);
          const form = await readForm(request);
          const intent = form.get("intent") ?? "";
          const { login, exchange } = await runAuthorizationMutation(request, async () => {
            const login = await authenticateWithinAdmission({
              username: requiredFormValue(form, "username"),
              password: requiredFormValue(form, "password"),
              remoteAddress: clientAddress(request),
            });
            const exchange = login.principal.mustChangePassword
              ? undefined
              : await createSessionExchangeWithLoginCompensation(login, intent);
            return { login, exchange };
          });
          setSessionCookie(response, controlCookie, login.sessionToken, secureCookies);
          if (login.principal.mustChangePassword) {
            redirect(response, `/account/change-password${intent === "" ? "" : `?intent=${encodeURIComponent(intent)}`}`);
          } else if (exchange !== undefined) {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            redirect(
              response,
              `${scheme}://${exchange.targetHost}/_review-tunnel/session?code=${encodeURIComponent(exchange.code)}`,
            );
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
          const intent = form.get("intent") ?? "";
          const { login, exchange } = await runAuthorizationMutation(request, async () => {
            await withCredentialAttempt(
              clientAddress(request),
              () => options.authService.changeOwnPassword(principal, {
                currentPassword,
                newPassword,
              }),
            );
            const login = await authenticateWithinAdmission({
              username: principal.username,
              password: newPassword,
              remoteAddress: clientAddress(request),
            });
            const exchange = await createSessionExchangeWithLoginCompensation(login, intent);
            return { login, exchange };
          });
          setSessionCookie(response, controlCookie, login.sessionToken, secureCookies);
          if (exchange !== undefined) {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            redirect(
              response,
              `${scheme}://${exchange.targetHost}/_review-tunnel/session?code=${encodeURIComponent(exchange.code)}`,
            );
          } else {
            redirect(response, login.principal.roles.includes("ADMIN") ? "/admin/users" : "/account");
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/logout") {
          requireSameOrigin(request, scheme);
          if (principal !== undefined) {
            await runAuthorizationMutation(
              request,
              () => options.authService.logout(principal),
            );
          }
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
          const accounts = await runAuthorizationQuery(
            request,
            () => options.authService.listAccounts(administrator),
          );
          writeHtml(response, 200, usersPage(administrator, accounts));
          return;
        }
        if (url.pathname === "/admin/users" && request.method === "POST") {
          requireSameOrigin(request, scheme);
          const administrator = requireAdministrator(principal);
          const form = await readForm(request);
          const result = await runAuthorizationMutation(request, async () => {
              const confirmedAdministrator = await confirmAdministratorPassword(
                verifyAdministratorCredentialsWithinAdmission,
                administrator,
                form,
                clientAddress(request),
              );
              return options.authService.createAccount(
                confirmedAdministrator,
                {
                  username: requiredFormValue(form, "username"),
                  displayName: requiredFormValue(form, "displayName"),
                  roles: rolesFromForm(form),
                },
              );
            });
          writeHtml(
            response,
            201,
            temporaryPasswordSuccessPage(
              result.account.username,
              result.temporaryPassword,
            ),
          );
          return;
        }
        const action = matchAdminAction(url.pathname);
        if (action !== undefined && request.method === "POST") {
          requireSameOrigin(request, scheme);
          const administrator = requireAdministrator(principal);
          const form = await readForm(request);
          const resetResult = await runAuthorizationMutation(request, async () => {
            const accounts = await options.authService.listAccounts(administrator);
            const target = accounts.find((account) => account.id === action.accountId);
            if (target === undefined) {
              throw new AuthError("ACCOUNT_NOT_FOUND", "계정을 찾을 수 없습니다.");
            }
            if (action.action === "reset" && target.id === administrator.accountId) {
              throw new AuthError(
                "INVALID_ACCOUNT_INPUT",
                "자신의 비밀번호는 비밀번호 변경 화면에서 변경하세요.",
              );
            }
            const confirmedAdministrator = await confirmAdministratorPassword(
              verifyAdministratorCredentialsWithinAdmission,
              administrator,
              form,
              clientAddress(request),
            );
            if (action.action === "enable") {
              await options.authService.setAccountEnabled(
                confirmedAdministrator,
                target.id,
                true,
              );
            } else if (action.action === "disable") {
              await options.authService.setAccountEnabled(
                confirmedAdministrator,
                target.id,
                false,
              );
            } else if (action.action === "roles") {
              await options.authService.setAccountRoles(
                confirmedAdministrator,
                target.id,
                rolesFromForm(form),
              );
            } else if (action.action === "revoke") {
              await options.authService.revokeSessions(
                confirmedAdministrator,
                target.id,
              );
            } else {
              const reset = await options.authService.resetPassword(
                confirmedAdministrator,
                target.id,
              );
              return reset;
            }
            return undefined;
          });
          if (resetResult !== undefined) {
            writeHtml(
              response,
              200,
              temporaryPasswordSuccessPage(
                resetResult.account.username,
                resetResult.temporaryPassword,
              ),
            );
          } else {
            redirect(response, "/admin/users");
          }
          return;
        }
        writeHtml(response, 404, messagePage("페이지를 찾을 수 없습니다."));
      } catch (error) {
        handleWebError(response, error, url.pathname, url.searchParams.get("intent"));
      }
    },

    async authorizeContent(request, response) {
      const host = normalizedAuthority(request.headers.host);
      const url = new URL(request.url ?? "/", `${scheme}://${host}`);
      if (url.pathname === "/_review-tunnel/session") {
        applySecurityHeaders(response);
        const code = url.searchParams.get("code") ?? "";
        try {
          const exchanged = await runAuthorizationMutation(
            request,
            () => options.authService.consumeSessionExchange(code, host),
          );
          setSessionCookie(response, contentCookie, exchanged.sessionToken, secureCookies);
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Referrer-Policy", "no-referrer");
          redirect(response, exchanged.targetPath);
        } catch (error) {
          handleWebError(response, error, url.pathname, null);
        }
        return undefined;
      }
      const principal = await resolveCookiePrincipalForRequest(
        request,
        contentCookie,
        `content:${host}`,
      );
      if (principal !== undefined && principal.roles.includes("REVIEWER") && !principal.mustChangePassword) {
        return principal;
      }
      if (!isTopLevelHtmlNavigation(request)) {
        applySecurityHeaders(response);
        writeJsonError(response, 401, "AUTHENTICATION_REQUIRED");
        return undefined;
      }
      applySecurityHeaders(response);
      if (
        options.admitLoginIntent !== undefined &&
        !options.admitLoginIntent(clientAddress(request), host)
      ) {
        response.setHeader("Retry-After", "60");
        writeJsonError(response, 429, "LOGIN_INTENT_RATE_LIMITED");
        return undefined;
      }
      try {
        const intent = await runAuthorizationMutation(
          request,
          () => options.authService.createLoginIntent(host, url.pathname + url.search),
        );
        redirect(response, `${scheme}://${options.controlHost}/login?intent=${encodeURIComponent(intent)}`);
      } catch (error) {
        handleWebError(response, error, url.pathname, null);
      }
      return undefined;
    },

    async resolveContentUpgrade(request) {
      const authority = normalizedAuthority(request.headers.host);
      const principal = await resolveCookiePrincipalForRequest(
        request,
        contentCookie,
        `content:${authority}`,
      );
      return principal?.roles.includes("REVIEWER") === true && !principal.mustChangePassword
        ? principal
        : undefined;
    },
  };

  const handleHttpBoundaryFailure = (
    request: IncomingMessage,
    response: ServerResponse,
    error: unknown,
  ): void => {
    if (response.writableEnded || response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      request.destroy();
      return;
    }
    applySecurityHeaders(response);
    if (error instanceof WebAuthBoundaryError) {
      if (error.statusCode === 429) {
        response.setHeader("Retry-After", "1");
      }
      writeJsonError(response, error.statusCode, error.code);
      return;
    }
    writeJsonError(response, 503, "AUTHENTICATION_UNAVAILABLE");
  };

  return {
    async handleControl(request, response) {
      try {
        await handler.handleControl(request, response);
      } catch (error) {
        handleHttpBoundaryFailure(request, response, error);
      }
    },
    async authorizeContent(request, response) {
      try {
        return await handler.authorizeContent(request, response);
      } catch (error) {
        handleHttpBoundaryFailure(request, response, error);
        return undefined;
      }
    },
    resolveContentUpgrade(request) {
      return handler.resolveContentUpgrade(request);
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
  verifyCredentials: (input: Readonly<{
    username: string;
    password: string;
    remoteAddress: string;
  }>) => Promise<AccountAuthorization>,
  administrator: Principal,
  form: URLSearchParams,
  remoteAddress: string,
): Promise<AccountAuthorization> {
  return verifyCredentials({
    username: administrator.username,
    password: requiredFormValue(form, "adminPassword"),
    remoteAddress,
  });
}

async function redirectToExchange(
  createExchange: (
    principal: Principal,
    intent: string,
  ) => ReturnType<AuthService["createSessionExchange"]>,
  principal: Principal,
  intent: string,
  response: ServerResponse,
  scheme: string,
): Promise<void> {
  const exchange = await createExchange(principal, intent);
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

function requiredBooleanFormValue(form: URLSearchParams, name: string): boolean {
  const value = requiredFormValue(form, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AuthError("INVALID_ACCOUNT_INPUT", `${name} 값은 true 또는 false여야 합니다.`);
}

function rolesFromForm(form: URLSearchParams): readonly AccountRole[] {
  const allowed = new Set<AccountRole>(["ADMIN", "DEVELOPER", "REVIEWER"]);
  const submitted = form.getAll("roles");
  if (submitted.length === 0) {
    throw new AuthError("INVALID_ACCOUNT_INPUT", "하나 이상의 권한이 필요합니다.");
  }
  if (
    submitted.some((role) => !allowed.has(role as AccountRole)) ||
    new Set(submitted).size !== submitted.length
  ) {
    throw new AuthError("INVALID_ACCOUNT_INPUT", "권한 값은 지원되는 고유 role이어야 합니다.");
  }
  return submitted as readonly AccountRole[];
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

function isTopLevelHtmlNavigation(request: IncomingMessage): boolean {
  if (request.method !== "GET") return false;
  const accept = joinedHeaderValue(request.headers.accept);
  if (!accept.toLowerCase().includes("text/html")) return false;

  const fetchMode = singleHeaderValue(request.headers["sec-fetch-mode"]);
  if (fetchMode !== undefined && fetchMode.toLowerCase() !== "navigate") return false;
  const fetchDestination = singleHeaderValue(request.headers["sec-fetch-dest"]);
  return fetchDestination === undefined || fetchDestination.toLowerCase() === "document";
}

function joinedHeaderValue(value: string | readonly string[] | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.join(",");
}

function singleHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function createLoginAttemptLimiter(input: Readonly<{
  maxConcurrent: number;
  maxConcurrentPerRemote: number;
  maxPerMinute: number;
  maxPerRemotePerMinute: number;
}>): Readonly<{ acquire(remoteAddress: string): (() => void) | undefined }> {
  let windowStartedAt = Date.now();
  let attemptsInWindow = 0;
  let concurrent = 0;
  const attemptsByRemote = new Map<string, number>();
  const concurrentByRemote = new Map<string, number>();
  return {
    acquire(remoteAddress) {
      const checkedAt = Date.now();
      if (checkedAt - windowStartedAt >= 60_000) {
        windowStartedAt = checkedAt;
        attemptsInWindow = 0;
        attemptsByRemote.clear();
      }
      const remoteAttempts = attemptsByRemote.get(remoteAddress) ?? 0;
      const remoteConcurrent = concurrentByRemote.get(remoteAddress) ?? 0;
      if (
        attemptsInWindow >= input.maxPerMinute ||
        remoteAttempts >= input.maxPerRemotePerMinute ||
        concurrent >= input.maxConcurrent ||
        remoteConcurrent >= input.maxConcurrentPerRemote
      ) {
        return undefined;
      }
      attemptsInWindow += 1;
      attemptsByRemote.set(remoteAddress, remoteAttempts + 1);
      concurrent += 1;
      concurrentByRemote.set(remoteAddress, remoteConcurrent + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        concurrent -= 1;
        const remaining = (concurrentByRemote.get(remoteAddress) ?? 1) - 1;
        if (remaining === 0) concurrentByRemote.delete(remoteAddress);
        else concurrentByRemote.set(remoteAddress, remaining);
      };
    },
  };
}

function createConcurrentAdmission(input: Readonly<{
  global: number;
  perRemote: number;
}>): Readonly<{ acquire(remoteAddress: string): (() => void) | undefined }> {
  if (
    !Number.isSafeInteger(input.global) ||
    input.global <= 0 ||
    !Number.isSafeInteger(input.perRemote) ||
    input.perRemote <= 0 ||
    input.perRemote > input.global
  ) {
    throw new RangeError(
      "web authorization limits must be positive safe integers and perRemote must not exceed global",
    );
  }
  let concurrent = 0;
  const concurrentByRemote = new Map<string, number>();
  return {
    acquire(remoteAddress) {
      const remoteConcurrent = concurrentByRemote.get(remoteAddress) ?? 0;
      if (concurrent >= input.global || remoteConcurrent >= input.perRemote) {
        return undefined;
      }
      concurrent += 1;
      concurrentByRemote.set(remoteAddress, remoteConcurrent + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        concurrent -= 1;
        const remaining = (concurrentByRemote.get(remoteAddress) ?? 1) - 1;
        if (remaining === 0) concurrentByRemote.delete(remoteAddress);
        else concurrentByRemote.set(remoteAddress, remaining);
      };
    },
  };
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function writeNoContent(response: ServerResponse): void {
  response.statusCode = 204;
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function handleWebError(
  response: ServerResponse,
  error: unknown,
  path: string,
  intent: string | null,
): void {
  if (response.writableEnded || response.destroyed) return;
  if (error instanceof WebAuthBoundaryError) {
    if (error.statusCode === 429) response.setHeader("Retry-After", "1");
    if (path.startsWith("/api/")) {
      writeJsonError(response, error.statusCode, error.code);
    } else {
      writeHtml(response, error.statusCode, messagePage(
        error.statusCode === 429
          ? "인증 요청이 너무 많습니다. 잠시 후 다시 시도하세요."
          : "인증 서비스를 사용할 수 없습니다.",
      ));
    }
    return;
  }
  if (!(error instanceof AuthError)) {
    if (path.startsWith("/api/")) {
      writeJsonError(response, 503, "AUTHENTICATION_UNAVAILABLE");
    } else {
      writeHtml(response, 503, messagePage("인증 서비스를 사용할 수 없습니다."));
    }
    return;
  }
  const status = error.code === "LOGIN_THROTTLED" ||
      error.code === "LOGIN_INTENT_CAPACITY" ||
      error.code === "AUTH_CAPACITY" ? 429
    : error.code === "FORBIDDEN" ? 403
    : error.code === "ACCOUNT_NOT_FOUND" ? 404
    : 400;
  if (error.code === "LOGIN_INTENT_CAPACITY" || error.code === "AUTH_CAPACITY") {
    response.setHeader("Retry-After", "60");
  }
  if (path.startsWith("/api/")) writeJsonError(response, status, error.code);
  else if (path === "/login") writeHtml(response, status, loginPage(intent, error.message));
  else if (path === "/account/change-password") {
    writeHtml(response, status, passwordChangePage(intent, error.message));
  } else writeHtml(response, status, messagePage(error.message));
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
