import { createHash } from "node:crypto";
import type { Principal } from "../../../packages/auth/src/index.ts";

// A non-credential namespace changes on login and authorization changes.
export function reviewDraftSession(principal: Principal): string {
  return createHash("sha256").update(JSON.stringify([
    "review-tunnel:drafts:v1", principal.accountId, principal.sessionId, principal.authVersion,
  ])).digest("hex");
}
