import { randomBytes } from "node:crypto";
import type { Principal, DeveloperAuthorization } from "../../../packages/auth/src/index.ts";
import type { GatewaySession } from "./gateway-session.ts";

/** Owns capacity reservations; a timeout does not release unfinished authorization work. */
export function createGatewayAdmission(
  input: Readonly<{
    getSessions(): ReadonlyMap<string, GatewaySession>;
    now(): number;
    maxPendingTunnels: number;
    maxActiveTunnels: number;
    maxTunnelsPerAccount: number;
    config: Readonly<{
      maxOutstandingCarrierCredentials?: number;
      maxOutstandingCarrierCredentialsPerAccount?: number;
      carrierCredentialsPerMinute?: number;
      carrierCredentialsPerAccountPerMinute?: number;
    }>;
  }>,
) {
  const { now, config, maxPendingTunnels, maxActiveTunnels, maxTunnelsPerAccount } = input;
  const credentialReservations = new Map<
    string,
    Readonly<{
      accountId: string;
      purpose: "create" | "resume";
      tunnelId: string;
      expiresAt: number;
    }>
  >();
  const maxOutstandingCarrierCredentials =
    config.maxOutstandingCarrierCredentials ?? DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS;
  const maxOutstandingCarrierCredentialsPerAccount =
    config.maxOutstandingCarrierCredentialsPerAccount ??
    DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT;
  const carrierCredentialRate = createFixedWindowRateLimiter({
    now,
    globalLimit: config.carrierCredentialsPerMinute ?? DEFAULT_CARRIER_CREDENTIALS_PER_MINUTE,
    perKeyLimit:
      config.carrierCredentialsPerAccountPerMinute ??
      DEFAULT_CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE,
  });
  let pendingCarrierConnections = 0;
  let carrierAuthorizationAttempts = 0;

  return {
    reserveCarrierCredential,
    canAdmitNewTunnel,
    canActivateTunnel,
    consumeCredentialReservation,
    reservePendingCarrierConnection,
    reserveCarrierAuthorizationAttempt,
    close() {
      credentialReservations.clear();
    },
  };

  function reserveCarrierCredential(
    principal: Pick<Principal, "accountId">,
    purpose: "create" | "resume",
    tunnelId: string,
  ): (() => void) | undefined {
    cleanupCredentialReservations();
    if (!hasPendingTunnelCapacity()) return undefined;
    if (purpose === "create" && !canAdmitNewTunnel(principal.accountId, tunnelId)) {
      return undefined;
    }
    let accountOutstanding = 0;
    for (const reservation of credentialReservations.values()) {
      if (reservation.accountId === principal.accountId) accountOutstanding += 1;
    }
    if (
      credentialReservations.size >= maxOutstandingCarrierCredentials ||
      accountOutstanding >= maxOutstandingCarrierCredentialsPerAccount ||
      !carrierCredentialRate.admit(principal.accountId)
    ) {
      return undefined;
    }
    const reservationId = randomBytes(16).toString("base64url");
    credentialReservations.set(reservationId, {
      accountId: principal.accountId,
      purpose,
      tunnelId,
      expiresAt: now() + CREATE_RESERVATION_TTL_MS,
    });
    return () => credentialReservations.delete(reservationId);
  }

  function canAdmitNewTunnel(accountId: string | undefined, _excludedTunnelId?: string): boolean {
    cleanupCredentialReservations();
    let pending = pendingCarrierConnections;
    let active = 0;
    let owned = 0;
    for (const session of input.getSessions().values()) {
      if (session.terminal) continue;
      if (session.lifecycle.status === "CREATING") pending += 1;
      else if (session.lifecycle.status === "ACTIVE" || session.lifecycle.status === "RECONNECTING")
        active += 1;
      if (accountId !== undefined && session.ownerAccountId === accountId) owned += 1;
    }
    for (const reservation of credentialReservations.values()) {
      pending += 1;
      if (accountId !== undefined && reservation.accountId === accountId) owned += 1;
    }
    return (
      pending < maxPendingTunnels &&
      active < maxActiveTunnels &&
      (accountId === undefined || owned < maxTunnelsPerAccount)
    );
  }

  function canActivateTunnel(candidate: GatewaySession): boolean {
    let active = 0;
    let owned = 0;
    for (const session of input.getSessions().values()) {
      if (session === candidate || session.terminal) continue;
      if (session.lifecycle.status === "ACTIVE" || session.lifecycle.status === "RECONNECTING")
        active += 1;
      if (
        candidate.ownerAccountId !== undefined &&
        session.ownerAccountId === candidate.ownerAccountId
      )
        owned += 1;
    }
    return (
      active < maxActiveTunnels &&
      (candidate.ownerAccountId === undefined || owned < maxTunnelsPerAccount)
    );
  }

  function cleanupCredentialReservations(): void {
    const checkedAt = now();
    for (const [reservationId, reservation] of credentialReservations) {
      if (reservation.expiresAt <= checkedAt) {
        credentialReservations.delete(reservationId);
      }
    }
  }

  function consumeCredentialReservation(authorization: DeveloperAuthorization): void {
    cleanupCredentialReservations();
    for (const [reservationId, reservation] of credentialReservations) {
      if (
        reservation.accountId === authorization.accountId &&
        reservation.purpose === authorization.purpose &&
        reservation.tunnelId === authorization.tunnelId
      ) {
        credentialReservations.delete(reservationId);
        return;
      }
    }
  }

  function reservePendingCarrierConnection(): (() => void) | undefined {
    cleanupCredentialReservations();
    if (!hasPendingTunnelCapacity()) return undefined;
    pendingCarrierConnections += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingCarrierConnections -= 1;
    };
  }

  function hasPendingTunnelCapacity(): boolean {
    let occupiedPendingSlots = pendingCarrierConnections + credentialReservations.size;
    for (const session of input.getSessions().values()) {
      if (!session.terminal && session.lifecycle.status === "CREATING") {
        occupiedPendingSlots += 1;
      }
    }
    return occupiedPendingSlots < maxPendingTunnels;
  }

  function reserveCarrierAuthorizationAttempt(): (() => void) | undefined {
    if (carrierAuthorizationAttempts >= maxPendingTunnels) return undefined;
    carrierAuthorizationAttempts += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      carrierAuthorizationAttempts -= 1;
    };
  }
}

export function createFixedWindowRateLimiter(
  input: Readonly<{
    now: () => number;
    globalLimit: number;
    perKeyLimit: number;
  }>,
): Readonly<{ admit(key: string): boolean }> {
  let windowStartedAt = input.now();
  let globalCount = 0;
  const keyCounts = new Map<string, number>();
  return {
    admit(key) {
      const checkedAt = input.now();
      if (checkedAt - windowStartedAt >= 60_000) {
        windowStartedAt = checkedAt;
        globalCount = 0;
        keyCounts.clear();
      }
      const keyCount = keyCounts.get(key) ?? 0;
      if (globalCount >= input.globalLimit || keyCount >= input.perKeyLimit) {
        return false;
      }
      globalCount += 1;
      keyCounts.set(key, keyCount + 1);
      return true;
    },
  };
}

const CREATE_RESERVATION_TTL_MS = 60_000;
const DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS = 128;
const DEFAULT_MAX_OUTSTANDING_CARRIER_CREDENTIALS_PER_ACCOUNT = 8;
const DEFAULT_CARRIER_CREDENTIALS_PER_MINUTE = 1_000;
const DEFAULT_CARRIER_CREDENTIALS_PER_ACCOUNT_PER_MINUTE = 60;
