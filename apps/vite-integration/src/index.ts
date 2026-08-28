import type { Plugin } from "vite";

export type ReviewTunnelViteOptions = Readonly<{
  nonce?: string;
}>;

export function reviewTunnel(options: ReviewTunnelViteOptions = {}): Plugin {
  return {
    name: "review-tunnel",
    apply: "serve",
    transformIndexHtml() {
      return [{
        tag: "script",
        attrs: {
          type: "module",
          src: "/_review-tunnel/review/bootstrap.js",
          ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
        },
        injectTo: "head",
      }];
    },
  };
}
