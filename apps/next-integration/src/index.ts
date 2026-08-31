import type { NextConfig } from "next";

export type ReviewTunnelNextOptions = Readonly<{
  allowedDevOrigins: readonly string[];
  enabled?: boolean;
}>;

const DEVELOPMENT_SCRIPT_PROPS = Object.freeze({
  src: "/_review-tunnel/review/bootstrap.js",
  type: "module",
  strategy: "afterInteractive",
});

export function reviewTunnelScriptProps(
  enabled = process.env.NODE_ENV !== "production",
  nonce?: string,
): (typeof DEVELOPMENT_SCRIPT_PROPS & Readonly<{ nonce?: string }>) | undefined {
  if (!enabled) return undefined;
  return nonce === undefined
    ? DEVELOPMENT_SCRIPT_PROPS
    : Object.freeze({ ...DEVELOPMENT_SCRIPT_PROPS, nonce });
}

export function withReviewTunnel(
  nextConfig: NextConfig,
  options: ReviewTunnelNextOptions,
): NextConfig {
  const enabled = options.enabled ?? process.env.NODE_ENV !== "production";
  if (!enabled) return { ...nextConfig };
  if (options.allowedDevOrigins.length === 0) {
    throw new Error("allowedDevOrigins must include the controlled Review Tunnel domain");
  }
  return {
    ...nextConfig,
    allowedDevOrigins: [
      ...new Set([
        ...(nextConfig.allowedDevOrigins ?? []),
        ...options.allowedDevOrigins,
      ]),
    ],
  };
}
