import {
  LIMITS,
  PROTOCOL_VERSION,
  idPattern,
  requestPattern,
  tokenPattern,
  utf8Bytes,
} from "../shared/contract.js";
import { ProtocolError, fail } from "./rooms.js";
import { createSocketLimiters, TokenBucket } from "./limits.js";
import { createHash } from "node:crypto";

const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function exact(value, keys) {
  if (
    !plain(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail("BAD_REQUEST");
}
function base(payload, keys) {
  exact(payload, ["v", "requestId", ...keys]);
  if (payload.v !== PROTOCOL_VERSION)
    fail("VERSION_MISMATCH", "This client protocol is not supported.");
  if (
    typeof payload.requestId !== "string" ||
    !requestPattern.test(payload.requestId)
  )
    fail("BAD_REQUEST");
}
function stringId(value, pattern = idPattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail("BAD_REQUEST");
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("BAD_REQUEST");
}
export function normalizeName(value) {
  if (typeof value !== "string") fail("BAD_REQUEST");
  const name = value.trim().normalize("NFC");
  if (
    !name ||
    [...name].length > 32 ||
    utf8Bytes(name) > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)
  )
    fail("BAD_REQUEST");
  return name;
}

function parse(event, payload) {
  if (event === "room:create") {
    base(payload, ["name", "sample"]);
    if (typeof payload.sample !== "boolean") fail("BAD_REQUEST");
    return { ...payload, name: normalizeName(payload.name) };
  }
  if (event === "room:join") {
    base(payload, ["roomId", "name"]);
    stringId(payload.roomId);
    return { ...payload, name: normalizeName(payload.name) };
  }
  if (event === "room:resume") {
    base(payload, ["roomId", "epoch", "clientID", "resumeToken", "version"]);
    stringId(payload.roomId);
    stringId(payload.epoch);
    stringId(payload.clientID);
    stringId(payload.resumeToken, tokenPattern);
    integer(payload.version);
    return payload;
  }
  if (event === "room:leave") {
    base(payload, ["roomId", "epoch"]);
    stringId(payload.roomId);
    stringId(payload.epoch);
    return payload;
  }
  if (event === "doc:pull") {
    base(payload, ["roomId", "epoch", "version"]);
    stringId(payload.roomId);
    stringId(payload.epoch);
    integer(payload.version);
    return payload;
  }
  if (event === "doc:push") {
    base(payload, ["roomId", "epoch", "version", "updates"]);
    stringId(payload.roomId);
    stringId(payload.epoch);
    integer(payload.version);
    if (
      !Array.isArray(payload.updates) ||
      payload.updates.length < 1 ||
      payload.updates.length > LIMITS.requestUpdates ||
      utf8Bytes(JSON.stringify(payload.updates)) > LIMITS.responseBytes
    )
      fail("BAD_REQUEST");
    let sections = 0;
    for (const update of payload.updates) {
      exact(update, ["changes"]);
      if (!Array.isArray(update.changes)) fail("CHANGE_INVALID");
      sections += update.changes.length;
    }
    if (sections > LIMITS.changeSections) fail("CHANGE_INVALID");
    return payload;
  }
  fail("BAD_REQUEST");
}

function response(requestId, data) {
  return { v: PROTOCOL_VERSION, requestId, ok: true, data };
}
function errorResponse(requestId, error) {
  const code = error instanceof ProtocolError ? error.code : "BAD_REQUEST";
  const body = {
    code,
    message:
      error instanceof ProtocolError
        ? error.message
        : "That request could not be processed.",
  };
  if (error.retryAfterMs != null) body.retryAfterMs = error.retryAfterMs;
  return {
    v: PROTOCOL_VERSION,
    requestId: typeof requestId === "string" ? requestId : "invalid",
    ok: false,
    error: body,
  };
}

export function registerProtocol(
  io,
  store,
  { now = Date.now, unjoinedTimeoutMs = 15_000 } = {},
) {
  const admissionGlobal = new TokenBucket({ rate: 0.5, burst: 30, now });
  const admissionPeers = new Map();
  const roomPushBuckets = new Map();
  const roomKey = (room) => `doc:${room.id}:${room.epoch}`;
  const knownEvents = new Set([
    "room:create",
    "room:join",
    "room:resume",
    "room:leave",
    "doc:pull",
    "doc:push",
    "presence:typing",
  ]);
  const cleanupTimer = setInterval(() => {
    const cutoff = now() - 600_000;
    for (const [peer, value] of admissionPeers)
      if (value.lastSeen < cutoff) admissionPeers.delete(peer);
    for (const roomId of roomPushBuckets.keys())
      if (!store.rooms.has(roomId)) roomPushBuckets.delete(roomId);
  }, 60_000);
  cleanupTimer.unref();
  io.engine.once("close", () => clearInterval(cleanupTimer));
  const peerBucket = (peer) => {
    let value = admissionPeers.get(peer);
    if (!value) {
      if (admissionPeers.size >= 1024) fail("CAPACITY");
      value = {
        bucket: new TokenBucket({ rate: 5 / 60, burst: 5, now }),
        lastSeen: now(),
      };
      admissionPeers.set(peer, value);
    }
    value.lastSeen = now();
    return value.bucket;
  };
  const announcePresence = (room) =>
    io.to(roomKey(room)).emit("presence:state", {
      v: 1,
      roomId: room.id,
      epoch: room.epoch,
      presence: [...room.sessions.values()]
        .filter((s) => s.socketId)
        .map(({ clientID, name, colorIndex }) => ({
          clientID,
          name,
          colorIndex,
        }))
        .sort((a, b) => a.clientID.localeCompare(b.clientID)),
    });
  io.on("connection", (socket) => {
    socket.data.limiters = createSocketLimiters(now);
    socket.data.invalid = [];
    let unjoinedTimer;
    const armUnjoinedDeadline = () => {
      clearTimeout(unjoinedTimer);
      unjoinedTimer = setTimeout(() => {
        if (!socket.data.membership) socket.disconnect(true);
      }, unjoinedTimeoutMs);
      unjoinedTimer.unref();
    };
    socket.data.armUnjoinedDeadline = armUnjoinedDeadline;
    armUnjoinedDeadline();

    const recordInvalid = () => {
      const cutoff = now() - 10_000;
      socket.data.invalid = socket.data.invalid.filter((time) => time >= cutoff);
      socket.data.invalid.push(now());
      return socket.data.invalid.length >= 5;
    };

    const recordRateRejection = () => {
      const cutoff = now() - 10_000;
      socket.data.rateRejected = (socket.data.rateRejected || []).filter(
        (time) => time >= cutoff,
      );
      socket.data.rateRejected.push(now());
      if (socket.data.rateRejected.length > 20) socket.disconnect(true);
    };

    const takeRequestTokens = (limiterName) => {
      const globalLimiter = socket.data.limiters.all;
      if (!globalLimiter.take())
        throw new ProtocolError(
          "RATE_LIMITED",
          "Too many requests. Try again shortly.",
          globalLimiter.retryAfterMs(),
        );
      const eventLimiter = socket.data.limiters[limiterName];
      if (eventLimiter !== globalLimiter && !eventLimiter.take())
        throw new ProtocolError(
          "RATE_LIMITED",
          "Too many requests. Try again shortly.",
          eventLimiter.retryAfterMs(),
        );
    };

    const takeRoomAdmission = () => {
      const peer = socket.handshake.address || "unknown";
      const bucket = peerBucket(peer);
      if (!admissionGlobal.take() || !bucket.take())
        throw new ProtocolError(
          "RATE_LIMITED",
          "Too many room requests. Try again shortly.",
          Math.max(admissionGlobal.retryAfterMs(), bucket.retryAfterMs()),
        );
    };

    const attachToRoom = (snapshot) => {
      socket.data.membership = {
        roomId: snapshot.roomId,
        epoch: snapshot.epoch,
        clientID: snapshot.clientID,
      };
      clearTimeout(unjoinedTimer);
      socket.join(`doc:${snapshot.roomId}:${snapshot.epoch}`);
      announcePresence(store.rooms.get(snapshot.roomId));
      return snapshot;
    };

    const handle = (event, action, limiterName = "all") =>
      socket.on(event, (payload, ack) => {
        if (typeof ack !== "function") return;
        try {
          takeRequestTokens(limiterName);
          const input = parse(event, payload);
          const control = event.startsWith("room:");
          const payloadHash = control
            ? createHash("sha256").update(JSON.stringify(input)).digest("hex")
            : null;
          if (
            control &&
            socket.data.lastControl?.requestId === input.requestId
          ) {
            if (socket.data.lastControl.payloadHash !== payloadHash)
              fail("BAD_REQUEST");
            if (event === "room:resume") {
              const fresh = response(input.requestId, action(input));
              socket.data.lastControl.response = fresh;
              ack(fresh);
              return;
            }
            ack(socket.data.lastControl.response);
            return;
          }
          if (
            socket.data.membership &&
            ["room:create", "room:join"].includes(event)
          )
            fail("ALREADY_JOINED");
          const data = action(input);
          const success = response(input.requestId, data);
          if (control)
            socket.data.lastControl = {
              requestId: input.requestId,
              payloadHash,
              response: success,
            };
          ack(success);
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "RATE_LIMITED")
            recordRateRejection();
          ack(errorResponse(payload?.requestId, error));
        }
      });

    handle("room:create", (input) => {
      takeRoomAdmission();
      return attachToRoom(store.create({ ...input, socketId: socket.id }));
    });
    handle("room:join", (input) => {
      takeRoomAdmission();
      return attachToRoom(store.join({ ...input, socketId: socket.id }));
    });
    handle("room:resume", (input) => {
      takeRoomAdmission();
      if (
        socket.data.membership &&
        (socket.data.membership.roomId !== input.roomId ||
          socket.data.membership.epoch !== input.epoch ||
          socket.data.membership.clientID !== input.clientID)
      )
        fail("ALREADY_JOINED");
      return attachToRoom(store.resume({ ...input, socketId: socket.id }));
    });
    handle("room:leave", (input) => {
      const membership = socket.data.membership;
      if (!membership) fail("NOT_JOINED");
      if (
        membership.roomId !== input.roomId ||
        membership.epoch !== input.epoch
      )
        fail("EPOCH_MISMATCH");
      const room = store.leave(membership);
      socket.leave(roomKey(room));
      socket.data.membership = null;
      armUnjoinedDeadline();
      announcePresence(room);
      return { left: true };
    });
    handle(
      "doc:pull",
      (input) => {
        const membership = socket.data.membership;
        if (!membership) fail("NOT_JOINED");
        if (
          membership.roomId !== input.roomId ||
          membership.epoch !== input.epoch
        )
          fail("EPOCH_MISMATCH");
        return store.pull({ ...input, clientID: membership.clientID });
      },
      "pull",
    );
    handle(
      "doc:push",
      (input) => {
        const membership = socket.data.membership;
        if (!membership) fail("NOT_JOINED");
        if (
          membership.roomId !== input.roomId ||
          membership.epoch !== input.epoch
        )
          fail("EPOCH_MISMATCH");
        let roomBucket = roomPushBuckets.get(input.roomId);
        if (!roomBucket) {
          roomBucket = new TokenBucket({ rate: 40, burst: 80, now });
          roomPushBuckets.set(input.roomId, roomBucket);
        }
        if (!roomBucket.take())
          throw new ProtocolError(
            "RATE_LIMITED",
            "This room is receiving too many edits.",
            roomBucket.retryAfterMs(),
          );
        const data = store.push({ ...input, clientID: membership.clientID });
        io.to(`doc:${input.roomId}:${input.epoch}`).emit("doc:available", {
          v: 1,
          roomId: input.roomId,
          epoch: input.epoch,
          version: data.version,
        });
        return data;
      },
      "push",
    );
    socket.on("presence:typing", (payload) => {
      try {
        takeRequestTokens("typing");
        exact(payload, ["v", "roomId", "epoch"]);
        if (payload.v !== 1) fail("VERSION_MISMATCH");
        stringId(payload.roomId);
        stringId(payload.epoch);
        const membership = socket.data.membership;
        if (
          !membership ||
          membership.roomId !== payload.roomId ||
          membership.epoch !== payload.epoch
        )
          return;
        socket
          .to(`doc:${payload.roomId}:${payload.epoch}`)
          .volatile.emit("presence:typing", {
            v: 1,
            roomId: payload.roomId,
            epoch: payload.epoch,
            clientID: membership.clientID,
          });
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "RATE_LIMITED")
          recordRateRejection();
        else if (recordInvalid()) socket.disconnect(true);
      }
    });
    socket.onAny((event, ...args) => {
      if (
        !knownEvents.has(event) ||
        (event !== "presence:typing" && typeof args.at(-1) !== "function")
      ) {
        const shouldDisconnect = recordInvalid();
        if (!knownEvents.has(event) && typeof args.at(-1) === "function")
          args.at(-1)(
            errorResponse(
              args[0]?.requestId,
              new ProtocolError("BAD_REQUEST", "That event is not supported."),
            ),
          );
        if (shouldDisconnect) socket.disconnect(true);
      }
    });
    socket.on("disconnect", () => {
      clearTimeout(unjoinedTimer);
      const room = store.disconnect(socket.id);
      if (room) announcePresence(room);
    });
  });
}
