import { defineConfig } from "vite";

import { reviewTunnel } from "@review-tunnel/vite";

export default defineConfig({
  plugins: [reviewTunnel()],
});
