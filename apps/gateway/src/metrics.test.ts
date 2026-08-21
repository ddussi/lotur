import assert from "node:assert/strict";
import test from "node:test";

import { GatewayMetrics } from "./metrics.ts";

test("metrics는 payload나 식별자 없이 bounded label만 출력한다", () => {
  const metrics = new GatewayMetrics();
  metrics.increment("tunnel_active");
  metrics.increment("stream_rejected");
  const rendered = metrics.render({
    activeTunnels: 2,
    reconnectingTunnels: 1,
    activeStreams: 3,
    killSwitchEnabled: false,
    admissionReady: true,
  });

  assert.match(rendered, /event="tunnel_active"} 1/);
  assert.match(rendered, /review_tunnel_active_streams 3/);
  assert.doesNotMatch(rendered, /cookie|authorization|payload|tunnelId/i);
});
