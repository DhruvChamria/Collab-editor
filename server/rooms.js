import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ChangeSet, Text } from "@codemirror/state";
import { rebaseUpdates } from "@codemirror/collab";
import { LIMITS, SAMPLE_DOCUMENT, utf8Bytes } from "../shared/contract.js";

export class ProtocolError extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const messages = {
  BAD_REQUEST: "That request is not valid.",
  ROOM_GONE: "This room is no longer available.",
  ROOM_FULL: "This room already has eight participants.",
  CAPACITY: "The service is at capacity.",
  SESSION_EXPIRED: "This editing session has expired.",
  SESSION_IN_USE: "The previous connection is still active.",
  EPOCH_MISMATCH: "This room has been replaced.",
  HISTORY_EXPIRED:
    "The collaboration history needed to recover is no longer available.",
  FUTURE_VERSION: "The requested version is ahead of the room.",
  CHANGE_INVALID: "The submitted edit is invalid.",
  DOCUMENT_LIMIT: "The shared document reached its 32 KiB limit.",
  NOT_JOINED: "Join a room first.",
  ALREADY_JOINED: "Leave the current room before joining another.",
  SHUTTING_DOWN: "The service is shutting down.",
};

export function fail(code, detail) {
  throw new ProtocolError(
    code,
    detail || messages[code] || messages.BAD_REQUEST,
  );
}
function id(bytes) {
  return randomBytes(bytes).toString("base64url");
}
function tokenHash(value) {
  return createHash("sha256").update(value).digest();
}

function updateBytes(update) {
  return utf8Bytes(
    JSON.stringify({
      clientID: update.clientID,
      changes: update.changes.toJSON(),
    }),
  );
}
function presence(room) {
  return [...room.sessions.values()]
    .filter((session) => session.socketId)
    .map(({ clientID, name, colorIndex }) => ({ clientID, name, colorIndex }))
    .sort((a, b) => a.clientID.localeCompare(b.clientID));
}

export class RoomStore {
  constructor({ now = Date.now, randomId = id } = {}) {
    this.rooms = new Map();
    this.now = now;
    this.randomId = randomId;
    this.shuttingDown = false;
  }

  create({ name, sample, socketId }) {
    if (this.shuttingDown) fail("SHUTTING_DOWN");
    if (this.rooms.size >= LIMITS.rooms) fail("CAPACITY");
    let roomId;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      roomId = this.randomId(16);
      if (!this.rooms.has(roomId)) break;
      roomId = undefined;
    }
    if (!roomId) fail("CAPACITY");
    const now = this.now();
    const room = {
      id: roomId,
      epoch: this.randomId(16),
      createdAt: now,
      emptySince: null,
      doc: Text.of((sample ? SAMPLE_DOCUMENT : "").split("\n")),
      version: 0,
      historyStart: 0,
      history: [],
      historyBytes: 0,
      sessions: new Map(),
    };
    this.rooms.set(roomId, room);
    return this.addSession(room, name, socketId);
  }

  join({ roomId, name, socketId }) {
    if (this.shuttingDown) fail("SHUTTING_DOWN");
    const room = this.rooms.get(roomId);
    if (!room) fail("ROOM_GONE");
    if (room.sessions.size >= LIMITS.roomParticipants) fail("ROOM_FULL");
    return this.addSession(room, name, socketId);
  }

  addSession(room, name, socketId) {
    let clientID;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = this.randomId(16);
      if (!room.sessions.has(candidate)) {
        clientID = candidate;
        break;
      }
    }
    if (!clientID) fail("CAPACITY");
    const resumeToken = this.randomId(32);
    room.sessions.set(clientID, {
      clientID,
      resumeTokenHash: tokenHash(resumeToken),
      name,
      colorIndex: tokenHash(clientID)[0] % 6,
      socketId,
      disconnectedAt: null,
    });
    room.emptySince = null;
    return this.snapshot(room, clientID, resumeToken);
  }

  snapshot(room, clientID, resumeToken) {
    return {
      roomId: room.id,
      epoch: room.epoch,
      clientID,
      resumeToken,
      doc: room.doc.toString(),
      version: room.version,
      historyStart: room.historyStart,
      presence: presence(room),
      expiresAt: room.createdAt + LIMITS.roomSeconds * 1000,
      limits: {
        documentBytes: LIMITS.documentBytes,
        roomParticipants: LIMITS.roomParticipants,
      },
    };
  }

  membership(roomId, epoch, clientID) {
    const room = this.rooms.get(roomId);
    if (!room) fail("ROOM_GONE");
    if (room.epoch !== epoch) fail("EPOCH_MISMATCH");
    const session = room.sessions.get(clientID);
    if (!session) fail("SESSION_EXPIRED");
    return { room, session };
  }

  resume({ roomId, epoch, clientID, resumeToken, version, socketId }) {
    const { room, session } = this.membership(roomId, epoch, clientID);
    if (!timingSafeEqual(tokenHash(resumeToken), session.resumeTokenHash))
      fail("SESSION_EXPIRED");
    if (version < room.historyStart) fail("HISTORY_EXPIRED");
    if (version > room.version) fail("FUTURE_VERSION");
    if (session.socketId && session.socketId !== socketId)
      fail("SESSION_IN_USE");
    session.socketId = socketId;
    session.disconnectedAt = null;
    room.emptySince = null;
    return {
      roomId,
      epoch,
      clientID,
      version: room.version,
      historyStart: room.historyStart,
      presence: presence(room),
      expiresAt: room.createdAt + LIMITS.roomSeconds * 1000,
    };
  }

  pull({ roomId, epoch, clientID, version }) {
    const { room } = this.membership(roomId, epoch, clientID);
    if (version < room.historyStart) fail("HISTORY_EXPIRED");
    if (version > room.version) fail("FUTURE_VERSION");
    const offset = version - room.historyStart;
    const updates = [];
    let bytes = 2;
    for (const item of room.history.slice(
      offset,
      offset + LIMITS.requestUpdates,
    )) {
      const serialized = {
        clientID: item.clientID,
        changes: item.changes.toJSON(),
      };
      const next =
        utf8Bytes(JSON.stringify(serialized)) + (updates.length ? 1 : 0);
      if (bytes + next + 256 > LIMITS.responseBytes) break;
      updates.push(serialized);
      bytes += next;
    }
    return {
      roomId,
      epoch,
      fromVersion: version,
      toVersion: version + updates.length,
      updates,
    };
  }

  push({ roomId, epoch, clientID, version, updates }) {
    const { room } = this.membership(roomId, epoch, clientID);
    if (version < room.historyStart) fail("HISTORY_EXPIRED");
    if (version > room.version) fail("FUTURE_VERSION");
    let parsed;
    try {
      parsed = updates.map((update) => ({
        clientID,
        changes: ChangeSet.fromJSON(update.changes),
      }));
    } catch {
      fail("CHANGE_INVALID");
    }
    const prior = room.history
      .slice(version - room.historyStart)
      .map(({ clientID: author, changes }) => ({ clientID: author, changes }));
    let rebased;
    try {
      rebased = rebaseUpdates(parsed, prior);
    } catch {
      fail("CHANGE_INVALID");
    }
    let candidate = room.doc;
    const accepted = [];
    try {
      for (const update of rebased) {
        candidate = update.changes.apply(candidate);
        const item = {
          clientID,
          changes: update.changes,
        };
        item.bytes = updateBytes(item);
        if (item.bytes > LIMITS.responseBytes - 1024) fail("CHANGE_INVALID");
        accepted.push(item);
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      fail("CHANGE_INVALID");
    }
    if (
      candidate.length > LIMITS.documentUnits ||
      utf8Bytes(candidate.toString()) > LIMITS.documentBytes
    )
      fail("DOCUMENT_LIMIT");
    room.doc = candidate;
    room.history.push(...accepted);
    room.version += accepted.length;
    room.historyBytes += accepted.reduce((sum, item) => sum + item.bytes, 0);
    while (
      room.history.length > LIMITS.historyUpdates ||
      room.historyBytes > LIMITS.historyBytes
    ) {
      const removed = room.history.shift();
      room.historyBytes -= removed.bytes;
      room.historyStart += 1;
    }
    return { roomId, epoch, version: room.version, accepted: accepted.length };
  }

  disconnect(socketId) {
    for (const room of this.rooms.values())
      for (const session of room.sessions.values())
        if (session.socketId === socketId) {
          session.socketId = null;
          session.disconnectedAt = this.now();
          if (![...room.sessions.values()].some((entry) => entry.socketId))
            room.emptySince = this.now();
          return room;
        }
  }

  leave({ roomId, epoch, clientID }) {
    const { room } = this.membership(roomId, epoch, clientID);
    room.sessions.delete(clientID);
    if (![...room.sessions.values()].some((entry) => entry.socketId))
      room.emptySince = this.now();
    return room;
  }

  sweep() {
    const now = this.now();
    const ended = [];
    for (const [roomId, room] of this.rooms) {
      for (const [clientID, session] of room.sessions)
        if (
          !session.socketId &&
          session.disconnectedAt != null &&
          now - session.disconnectedAt >= LIMITS.sessionsSeconds * 1000
        )
          room.sessions.delete(clientID);
      if (
        now - room.createdAt >= LIMITS.roomSeconds * 1000 ||
        (room.emptySince != null &&
          now - room.emptySince >= LIMITS.emptyRoomSeconds * 1000)
      ) {
        this.rooms.delete(roomId);
        ended.push(room);
      }
    }
    return ended;
  }
}
