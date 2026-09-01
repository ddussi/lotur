import {
  accountAccessRequirement,
  type AccountAuthorizationCheck,
  type AuthService,
} from "../../../packages/auth/src/index.ts";
import {
  type GatewaySession,
  type GatewayEventSink,
  captureGatewayTransport,
  isCurrentGatewaySessionTransport,
  isCurrentGatewaySessionStream,
  removeGatewayStream,
} from "./gateway-session.ts";
import { sendReset } from "./gateway-streams.ts";
import { PromiseDeadlineError, withPromiseDeadline, toSafeErrorReason } from "./gateway-async.ts";
import { retainAdmissionUntilSettled } from "./retained-operation.ts";

const AUTHORIZATION_REVALIDATION_CONCURRENCY = 4;

export function startAuthorizationRevalidation(
  input: Readonly<{
    authService: AuthService | undefined;
    sessions: ReadonlyMap<string, GatewaySession>;
    authorizationQueryTimeoutMs: number;
    intervalMs: number;
    emit: GatewayEventSink;
    terminateGatewaySession(session: GatewaySession, reason: string, closeCode?: number): void;
  }>,
): () => void {
  const {
    authService,
    sessions,
    authorizationQueryTimeoutMs,
    intervalMs,
    emit,
    terminateGatewaySession,
  } = input;
  if (authService === undefined) return () => {};
  let activeAuthorizationRevalidations = 0;
  const withRetainedRevalidationAdmission = <T>(
    start: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T> => {
    if (activeAuthorizationRevalidations >= AUTHORIZATION_REVALIDATION_CONCURRENCY) {
      return Promise.reject(new Error("authorization revalidation capacity exhausted"));
    }
    activeAuthorizationRevalidations += 1;
    let running: Promise<T>;
    try {
      running = start();
    } catch (error) {
      activeAuthorizationRevalidations -= 1;
      throw error;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeAuthorizationRevalidations -= 1;
    };
    retainAdmissionUntilSettled(running, release);
    return withPromiseDeadline(running, authorizationQueryTimeoutMs, timeoutMessage);
  };
  let revocationCheckRunning = false;
  const revocationAuthService = authService;
  const revocationTimer = setInterval(() => {
    if (revocationAuthService === undefined || revocationCheckRunning) return;
    revocationCheckRunning = true;
    void (async () => {
      const pendingSessions = [...sessions.values()].filter((session) => !session.terminal);
      const checkAuthorizations = async (
        checks: readonly AccountAuthorizationCheck[],
      ): Promise<readonly PromiseSettledResult<boolean>[]> => {
        if (checks.length === 0) return [];
        const purpose =
          checks[0] !== undefined && "capability" in checks[0] ? "shared content" : "role";
        try {
          const results = await withRetainedRevalidationAdmission(
            () => revocationAuthService.areAccountsAuthorized(checks),
            `${purpose} authorization batch query timed out`,
          );
          if (results.length !== checks.length) {
            throw new Error("authorization batch returned an invalid result count");
          }
          return results.map((value) => ({ status: "fulfilled", value }));
        } catch (error) {
          if (error instanceof PromiseDeadlineError) {
            return checks.map(() => ({ status: "rejected", reason: error }));
          }
          const fallbackResults: PromiseSettledResult<boolean>[] = Array(checks.length);
          let nextCheck = 0;
          const workerCount = Math.min(AUTHORIZATION_REVALIDATION_CONCURRENCY, checks.length);
          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              while (nextCheck < checks.length) {
                const index = nextCheck;
                nextCheck += 1;
                const check = checks[index];
                if (check === undefined) return;
                try {
                  const value = await withRetainedRevalidationAdmission(
                    () =>
                      revocationAuthService.isAccountAuthorized(
                        check.accountId,
                        check.accountAuthVersion,
                        accountAccessRequirement(check),
                      ),
                    `${purpose} authorization query timed out`,
                  );
                  fallbackResults[index] = { status: "fulfilled", value };
                } catch (reason) {
                  fallbackResults[index] = { status: "rejected", reason };
                }
              }
            }),
          );
          return fallbackResults;
        }
      };
      const developerSnapshots = pendingSessions.flatMap((session) => {
        const accountId = session.ownerAccountId;
        const accountAuthVersion = session.ownerAuthVersion;
        return accountId === undefined || accountAuthVersion === undefined
          ? []
          : [
              {
                session,
                transport: captureGatewayTransport(session),
                check: { accountId, accountAuthVersion, role: "DEVELOPER" as const },
              },
            ];
      });
      const developerResults = await checkAuthorizations(
        developerSnapshots.map((snapshot) => snapshot.check),
      );
      for (const [index, snapshot] of developerSnapshots.entries()) {
        const result = developerResults[index];
        if (
          result === undefined ||
          !isCurrentGatewaySessionTransport(sessions, snapshot.session, snapshot.transport)
        )
          continue;
        if (result.status === "rejected") {
          emit("authorization.revalidation_failed", snapshot.session, {
            reason: toSafeErrorReason(result.reason),
          });
          terminateGatewaySession(snapshot.session, "authorization revalidation unavailable", 1011);
        } else if (!result.value) {
          terminateGatewaySession(snapshot.session, "developer authorization revoked");
        }
      }
      const reviewerSnapshots = pendingSessions.flatMap((session) => {
        const transport = captureGatewayTransport(session);
        if (!isCurrentGatewaySessionTransport(sessions, session, transport)) return [];
        return [...session.streams.entries()].flatMap(([streamId, stream]) => {
          const accountId = stream.reviewerAccountId;
          const accountAuthVersion = stream.reviewerAuthVersion;
          return accountId === undefined || accountAuthVersion === undefined
            ? []
            : [
                {
                  session,
                  streamId,
                  stream,
                  check: { accountId, accountAuthVersion, capability: "SHARED_CONTENT" as const },
                },
              ];
        });
      });
      const reviewerResults = await checkAuthorizations(
        reviewerSnapshots.map((snapshot) => snapshot.check),
      );
      for (const [index, snapshot] of reviewerSnapshots.entries()) {
        const result = reviewerResults[index];
        if (
          result === undefined ||
          !isCurrentGatewaySessionStream(
            sessions,
            snapshot.session,
            snapshot.streamId,
            snapshot.stream,
          )
        )
          continue;
        if (result.status === "fulfilled" && result.value) continue;
        if (result.status === "rejected") {
          emit("authorization.revalidation_failed", snapshot.session, {
            reason: toSafeErrorReason(result.reason),
          });
        }
        snapshot.stream.cancelled = true;
        removeGatewayStream(snapshot.session, snapshot.streamId, snapshot.stream, "LOCAL_RESET");
        snapshot.stream.transport.outboundFlow.closeStream(snapshot.streamId);
        if (snapshot.stream.kind === "HTTP") {
          snapshot.stream.response.destroy();
          snapshot.stream.request.destroy();
        } else snapshot.stream.browserSocket.destroy();
        void sendReset(
          snapshot.stream.transport,
          snapshot.streamId,
          result.status === "rejected" ? "AUTHORIZATION_UNAVAILABLE" : "AUTHORIZATION_REVOKED",
        );
      }
    })()
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "authorization_revalidation_loop_failed",
            reason: toSafeErrorReason(error),
          }),
        );
        for (const session of sessions.values()) {
          emit("authorization.revalidation_failed", session, {
            reason: toSafeErrorReason(error),
          });
          terminateGatewaySession(session, "authorization revalidation unavailable", 1011);
        }
      })
      .finally(() => {
        revocationCheckRunning = false;
      });
  }, intervalMs);
  revocationTimer.unref();
  return () => clearInterval(revocationTimer);
}
