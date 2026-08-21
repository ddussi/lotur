export type GatewayCounter =
  | "tunnel_provisioned"
  | "config_applied"
  | "activation_failed"
  | "tunnel_active"
  | "tunnel_resumed"
  | "tunnel_reconnecting"
  | "tunnel_closed"
  | "tunnel_expired"
  | "stream_opened"
  | "stream_rejected"
  | "kill_switch_changed";

export type GatewayGaugeSnapshot = Readonly<{
  activeTunnels: number;
  reconnectingTunnels: number;
  activeStreams: number;
  killSwitchEnabled: boolean;
  admissionReady: boolean;
}>;

const COUNTERS: readonly GatewayCounter[] = [
  "tunnel_provisioned",
  "config_applied",
  "activation_failed",
  "tunnel_active",
  "tunnel_resumed",
  "tunnel_reconnecting",
  "tunnel_closed",
  "tunnel_expired",
  "stream_opened",
  "stream_rejected",
  "kill_switch_changed",
];

export class GatewayMetrics {
  readonly #counters = new Map<GatewayCounter, number>();

  increment(counter: GatewayCounter): void {
    this.#counters.set(counter, (this.#counters.get(counter) ?? 0) + 1);
  }

  value(counter: GatewayCounter): number {
    return this.#counters.get(counter) ?? 0;
  }

  render(snapshot: GatewayGaugeSnapshot): string {
    const lines = [
      "# TYPE review_tunnel_events_total counter",
      ...COUNTERS.map((counter) =>
        `review_tunnel_events_total{event="${counter}"} ${this.value(counter)}`
      ),
      "# TYPE review_tunnel_active_tunnels gauge",
      `review_tunnel_active_tunnels ${snapshot.activeTunnels}`,
      "# TYPE review_tunnel_reconnecting_tunnels gauge",
      `review_tunnel_reconnecting_tunnels ${snapshot.reconnectingTunnels}`,
      "# TYPE review_tunnel_active_streams gauge",
      `review_tunnel_active_streams ${snapshot.activeStreams}`,
      "# TYPE review_tunnel_kill_switch_enabled gauge",
      `review_tunnel_kill_switch_enabled ${snapshot.killSwitchEnabled ? 1 : 0}`,
      "# TYPE review_tunnel_gateway_admission_ready gauge",
      `review_tunnel_gateway_admission_ready ${snapshot.admissionReady ? 1 : 0}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}
