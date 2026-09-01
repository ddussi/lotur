export const ACCOUNT_ROLES = ["ADMIN", "DEVELOPER", "REVIEWER"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export function canAccessSharedContent(roles: readonly AccountRole[]): boolean {
  return roles.includes("REVIEWER") || roles.includes("DEVELOPER");
}

export type Account = Readonly<{
  id: string;
  username: string;
  displayName: string;
  roles: readonly AccountRole[];
  passwordHash: string;
  enabled: boolean;
  mustChangePassword: boolean;
  authVersion: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AuthSession = Readonly<{
  id: string;
  tokenDigest: string;
  accountId: string;
  accountAuthVersion: number;
  audience: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}>;

export type LoginThrottle = Readonly<{
  key: string;
  failures: number;
  lockedUntil?: Date;
  updatedAt: Date;
}>;

export type LoginIntent = Readonly<{
  id: string;
  targetHost: string;
  targetPath: string;
  expiresAt: Date;
}>;

export type SessionExchange = Readonly<{
  codeDigest: string;
  accountId: string;
  accountAuthVersion: number;
  targetHost: string;
  targetPath: string;
  expiresAt: Date;
}>;

export type CarrierPurpose = "create" | "resume";

export type CarrierCredential = Readonly<{
  id: string;
  secretDigest: string;
  accountId: string;
  accountAuthVersion: number;
  purpose: CarrierPurpose;
  tunnelId: string;
  expiresAt: Date;
}>;

export type DeveloperAuthorization = Readonly<{
  accountId: string;
  accountAuthVersion: number;
  username: string;
  purpose: CarrierPurpose;
  tunnelId: string;
}>;

export type AuditAction =
  | "ACCOUNT_BOOTSTRAPPED"
  | "ACCOUNT_CREATED"
  | "ACCOUNT_ENABLED"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_ROLES_CHANGED"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET"
  | "SESSIONS_REVOKED";

export type AuditEvent = Readonly<{
  id: string;
  action: AuditAction;
  actorAccountId?: string;
  targetAccountId?: string;
  occurredAt: Date;
  metadata: Readonly<Record<string, string | number | boolean>>;
}>;

export type AuthenticationEvent = Readonly<{
  action: "LOGIN_SUCCEEDED" | "LOGIN_FAILED";
  occurredAt: Date;
  identityRef: string;
  remoteRef: string;
  accountId?: string;
  reason?: "INVALID_CREDENTIALS" | "LOGIN_THROTTLED" | "THROTTLE_CAPACITY";
}>;

export type Principal = Readonly<{
  accountId: string;
  username: string;
  displayName: string;
  roles: readonly AccountRole[];
  mustChangePassword: boolean;
  authVersion: number;
  sessionId: string;
}>;

export type AccountAuthorization = Readonly<{
  accountId: string;
  authVersion: number;
}>;

export type AccountAccessRequirement = AccountRole | Readonly<{ capability: "SHARED_CONTENT" }>;

export type AccountAuthorizationCheck = Readonly<{
  accountId: string;
  accountAuthVersion: number;
}> & (Readonly<{ role: AccountRole }> | Readonly<{ capability: "SHARED_CONTENT" }>);

export function accountAccessRequirement(check: AccountAuthorizationCheck): AccountAccessRequirement {
  return "role" in check ? check.role : { capability: check.capability };
}

export function satisfiesAccountAccess(roles: readonly AccountRole[], requirement: AccountAccessRequirement): boolean {
  return typeof requirement === "string" ? roles.includes(requirement) : canAccessSharedContent(roles);
}
