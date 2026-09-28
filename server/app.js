import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { readConfig } from "./config.js";
import { RoomStore } from "./rooms.js";
import { registerProtocol } from "./protocol.js";
import { TokenBucket } from "./limits.js";

function allowedOrigin(origin, config) {
  if (!origin || origin === "null") return false;
  if (origin === config.publicOrigin) return true;
  if (config.nodeEnv !== "production")
    return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  return false;
}

function allowedHost(host, config) {
  if (!host) return false;
  if (config.nodeEnv !== "production")
    return /^(localhost|127\.0\.0\.1):\d+$/.test(host);
  return host === new URL(config.publicOrigin).host;
}

export async function createApp(options = {}) {
  const config = readConfig(process.env, {
    nodeEnv: "test",
    allowPortZero: true,
    ...options,
  });
  const dist = options.dist ?? path.resolve("dist");
  if (!options.skipDistCheck) await readFile(path.join(dist, "index.html"));
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", false);
  app.set("trust proxy", false);
  let shuttingDown = false;
  app.use((req, res, next) => {
    const host = req.headers.host || "";
    if (!allowedHost(host, config)) return res.status(400).end();
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    next();
  });
  app.get("/health", (_req, res) =>
    res
      .status(shuttingDown ? 503 : 200)
      .json({ status: shuttingDown ? "shutting-down" : "ok" }),
  );
  const serveIndex = async (_req, res, next) => {
    try {
      const nonce = randomBytes(16).toString("base64url");
      const html = (
        await readFile(path.join(dist, "index.html"), "utf8")
      ).replaceAll("__CSP_NONCE__", nonce);
      res.set("Cache-Control", "no-store");
      if (config.nodeEnv === "production")
        res.set("Strict-Transport-Security", "max-age=31536000");
      res.set(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self' ${config.publicOrigin.replace("http", "ws")}; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      );
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  };
  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);
  app.use(
    express.static(dist, {
      dotfiles: "deny",
      index: false,
      etag: true,
      maxAge: 0,
    }),
  );
  const httpServer = createHttpServer(
    { maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000 },
    app,
  );
  let transportCount = 0;
  const peerCounts = new Map();
  const reservations = new WeakMap();
  const admissionGlobal = new TokenBucket({ rate: 2, burst: 120 });
  const admissionPeers = new Map();
  const release = (reservation) => {
    if (!reservation || reservation.released) return;
    reservation.released = true;
    clearTimeout(reservation.timer);
    transportCount -= 1;
    const next = (peerCounts.get(reservation.peer) || 1) - 1;
    if (next) peerCounts.set(reservation.peer, next);
    else peerCounts.delete(reservation.peer);
  };
  const io = new Server(httpServer, {
    transports: ["websocket"],
    allowUpgrades: false,
    maxHttpBufferSize: 524_288,
    perMessageDeflate: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 5_000,
    cors: { origin: config.publicOrigin, credentials: false },
    allowRequest: (req, callback) => {
      const peer = req.socket.remoteAddress || "unknown";
      const cutoff = Date.now() - 600_000;
      for (const [key, value] of admissionPeers)
        if (value.lastSeen < cutoff && !peerCounts.has(key))
          admissionPeers.delete(key);
      let attempt = admissionPeers.get(peer);
      if (!attempt) {
        if (admissionPeers.size >= 1024) return callback("rejected", false);
        attempt = {
          bucket: new TokenBucket({ rate: 20 / 60, burst: 20 }),
          lastSeen: Date.now(),
        };
        admissionPeers.set(peer, attempt);
      }
      attempt.lastSeen = Date.now();
      if (
        !allowedOrigin(req.headers.origin, config) ||
        !allowedHost(req.headers.host, config) ||
        !admissionGlobal.take() ||
        !attempt.bucket.take() ||
        transportCount >= 32 ||
        (peerCounts.get(peer) || 0) >= 12
      )
        return callback("rejected", false);
      const reservation = { peer, released: false, timer: null };
      transportCount += 1;
      peerCounts.set(peer, (peerCounts.get(peer) || 0) + 1);
      reservations.set(req, reservation);
      reservation.timer = setTimeout(() => {
        req.socket.destroy();
        release(reservation);
      }, 5000);
      reservation.timer.unref();
      callback(null, true);
    },
  });
  io.engine.on("connection", (transport) => {
    const reservation = reservations.get(transport.request);
    if (!reservation) return transport.close();
    clearTimeout(reservation.timer);
    transport.once("close", () => release(reservation));
  });
  const store = options.store ?? new RoomStore(options);
  registerProtocol(io, store, options);
  const sweepTimer = setInterval(() => {
    for (const room of store.sweep()) {
      const key = `doc:${room.id}:${room.epoch}`;
      const socketIds = io.sockets.adapter.rooms.get(key) || [];
      for (const socketId of socketIds) {
        const socket = io.sockets.sockets.get(socketId);
        socket?.emit("room:ended", {
          v: 1,
          roomId: room.id,
          epoch: room.epoch,
          reason: "EXPIRED",
        });
        if (socket) {
          socket.data.membership = null;
          socket.data.lastControl = null;
          socket.leave(key);
          socket.data.armUnjoinedDeadline?.();
        }
      }
    }
  }, 1000);
  sweepTimer.unref();
  async function close(reason = "SHUTTING_DOWN") {
    if (shuttingDown) return;
    shuttingDown = true;
    store.shuttingDown = true;
    clearInterval(sweepTimer);
    for (const room of store.rooms.values())
      io.to(`doc:${room.id}:${room.epoch}`).emit("room:ended", {
        v: 1,
        roomId: room.id,
        epoch: room.epoch,
        reason,
      });
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening)
      await new Promise((resolve) => httpServer.close(resolve));
  }
  return { app, httpServer, io, store, config, close };
}
