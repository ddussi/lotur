// Register before navigation: an interactive page can precede its HMR socket.
// Keep only readiness/counts, never Vite tokens or full WebSocket frames.
export function observeViteHmr(page, shareUrl) {
  const host = new URL(shareUrl).host;
  let connectedSocket;
  let updates = 0;
  page.on("websocket", socket => {
    if (new URL(socket.url()).host !== host) return;
    socket.on("framereceived", ({ payload }) => {
      let message;
      try { message = JSON.parse(String(payload)); } catch { return; }
      if (message.type === "connected") connectedSocket = socket;
      if (message.type === "update" && socket === connectedSocket) updates += 1;
    });
    socket.on("close", () => { if (connectedSocket === socket) connectedSocket = undefined; });
  });
  return { connected: () => connectedSocket !== undefined, updates: () => updates };
}
