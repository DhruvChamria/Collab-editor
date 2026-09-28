import { once } from "node:events";
import { io as clientIO } from "socket.io-client";
import { createApp } from "../../server/app.js";

export async function startTestServer(options = {}) {
  const instance = await createApp({ host: "127.0.0.1", port: 0, allowPortZero: true, nodeEnv: "test", publicOrigin: "http://127.0.0.1:3000", ...options });
  instance.httpServer.listen(0, "127.0.0.1"); await once(instance.httpServer, "listening");
  const port = instance.httpServer.address().port; const origin = `http://127.0.0.1:${port}`;
  return { ...instance, origin, async stop() { await instance.close(); } };
}

export async function connect(origin) {
  const socket = clientIO(origin, { transports: ["websocket"], extraHeaders: { Origin: origin }, forceNew: true, reconnection: false });
  await once(socket, "connect"); return socket;
}

let sequence = 0;
export function request(socket, event, payload) {
  sequence += 1;
  return new Promise((resolve, reject) => socket.timeout(2000).emit(event, { v: 1, requestId: `test-${sequence}`, ...payload }, (error, response) => error ? reject(error) : resolve(response)));
}

export async function closeSockets(...sockets) { for (const socket of sockets) socket?.disconnect(); }
