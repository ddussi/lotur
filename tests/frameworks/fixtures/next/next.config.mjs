import { withReviewTunnel } from "@review-tunnel/next";

/** @type {import('next').NextConfig} */
const nextConfig = withReviewTunnel({
  agentRules: false,
  reactStrictMode: true,
}, {
  allowedDevOrigins: ["*.localhost"],
});

export default nextConfig;
