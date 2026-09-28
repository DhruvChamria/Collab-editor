import test from "node:test";
import assert from "node:assert/strict";
import { ChangeSet } from "@codemirror/state";
import { RoomStore, ProtocolError } from "../server/rooms.js";
import { TokenBucket } from "../server/limits.js";
import { normalizeName } from "../server/protocol.js";
import { CollaborationConnection } from "../client/connection.js";

test("names normalize while controls and bidi overrides are rejected", () => {
  assert.equal(normalizeName("  Jose\u0301  "), "José");
  for (const value of [
    null,
    "",
    "bad\u0000name",
    "bad\u202ename",
    "x".repeat(33),
  ])
    assert.throws(() => normalizeName(value), ProtocolError);
});

test("token bucket refills against an injected clock", () => {
  let now = 0;
  const bucket = new TokenBucket({ rate: 2, burst: 2, now: () => now });
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  now = 500;
  assert.equal(bucket.take(), true);
});

test("generated room collisions retry without overwriting", () => {
  const ids = [
    "a".repeat(22),
    "b".repeat(22),
    "c".repeat(22),
    "t".repeat(43),
    "a".repeat(22),
    "d".repeat(22),
    "e".repeat(22),
    "f".repeat(22),
    "u".repeat(43),
  ];
  const store = new RoomStore({ randomId: () => ids.shift() });
  const first = store.create({ name: "A", sample: false, socketId: "one" });
  const second = store.create({ name: "B", sample: false, socketId: "two" });
  assert.notEqual(first.roomId, second.roomId);
  assert.equal(store.rooms.size, 2);
});

test("authority rebases concurrent inserts and deduplicates retries", () => {
  const store = new RoomStore();
  const a = store.create({ name: "A", sample: false, socketId: "a" });
  const b = store.join({ roomId: a.roomId, name: "B", socketId: "b" });
  const left = ChangeSet.of({ from: 0, insert: "A" }, 0);
  const right = ChangeSet.of({ from: 0, insert: "B" }, 0);
  store.push({
    roomId: a.roomId,
    epoch: a.epoch,
    clientID: a.clientID,
    version: 0,
    updates: [{ changes: left.toJSON() }],
  });
  store.push({
    roomId: b.roomId,
    epoch: b.epoch,
    clientID: b.clientID,
    version: 0,
    updates: [{ changes: right.toJSON() }],
  });
  const room = store.rooms.get(a.roomId);
  assert.equal(room.version, 2);
  assert.equal(room.doc.length, 2);
  store.push({
    roomId: a.roomId,
    epoch: a.epoch,
    clientID: a.clientID,
    version: 0,
    updates: [{ changes: left.toJSON() }],
  });
  assert.equal(room.version, 2);
});

test("document and history versions are rejected safely", () => {
  const store = new RoomStore();
  const member = store.create({ name: "A", sample: false, socketId: "a" });
  assert.throws(
    () => store.pull({ ...member, version: 1 }),
    (error) => error.code === "FUTURE_VERSION",
  );
  const huge = ChangeSet.of({ from: 0, insert: "x".repeat(32769) }, 0);
  assert.throws(
    () =>
      store.push({
        ...member,
        version: 0,
        updates: [{ changes: huge.toJSON() }],
      }),
    (error) => error.code === "DOCUMENT_LIMIT",
  );
  assert.equal(store.rooms.get(member.roomId).version, 0);
});

test("time-zero disconnected sessions and empty rooms expire", () => {
  let now = 0;
  const store = new RoomStore({ now: () => now });
  const member = store.create({ name: "A", sample: false, socketId: "a" });
  store.disconnect("a");
  now = 121_000;
  store.sweep();
  assert.equal(store.rooms.get(member.roomId).sessions.size, 0);
  now = 601_000;
  store.sweep();
  assert.equal(store.rooms.has(member.roomId), false);
});

test("participant ID collisions retry without replacing a session", () => {
  const ids = [
    "a".repeat(22),
    "b".repeat(22),
    "c".repeat(22),
    "t".repeat(43),
    "c".repeat(22),
    "d".repeat(22),
    "u".repeat(43),
  ];
  const store = new RoomStore({ randomId: () => ids.shift() });
  const first = store.create({ name: "A", sample: false, socketId: "a" });
  const second = store.join({ roomId: first.roomId, name: "B", socketId: "b" });
  assert.notEqual(first.clientID, second.clientID);
  assert.equal(store.rooms.get(first.roomId).sessions.size, 2);
});

test("valid empty updates are versioned and bounded history expires old versions", () => {
  const store = new RoomStore();
  const member = store.create({ name: "A", sample: false, socketId: "a" });
  const empty = ChangeSet.empty(0).toJSON();
  for (let version = 0; version < 513; version += 1)
    store.push({
      roomId: member.roomId,
      epoch: member.epoch,
      clientID: member.clientID,
      version,
      updates: [{ changes: empty }],
    });
  const room = store.rooms.get(member.roomId);
  assert.equal(room.version, 513);
  assert.equal(room.history.length, 512);
  assert.equal(room.historyStart, 1);
  assert.throws(
    () =>
      store.pull({
        roomId: member.roomId,
        epoch: member.epoch,
        clientID: member.clientID,
        version: 0,
      }),
    (error) => error.code === "HISTORY_EXPIRED",
  );
});

test("room participant and global room capacity are enforced", () => {
  const store = new RoomStore();
  const first = store.create({ name: "0", sample: false, socketId: "0" });
  for (let index = 1; index < 8; index += 1)
    store.join({
      roomId: first.roomId,
      name: String(index),
      socketId: String(index),
    });
  assert.throws(
    () =>
      store.join({
        roomId: first.roomId,
        name: "overflow",
        socketId: "overflow",
      }),
    (error) => error.code === "ROOM_FULL",
  );
  for (let index = 1; index < 16; index += 1)
    store.create({ name: "A", sample: false, socketId: `room-${index}` });
  assert.throws(
    () => store.create({ name: "A", sample: false, socketId: "room-overflow" }),
    (error) => error.code === "CAPACITY",
  );
});

test("leaving clears an uncertain edit before another room can start", async () => {
  const connection = new CollaborationConnection({
    onPhase() {},
    onPresence() {},
    onTyping() {},
    onEnded() {},
  });
  connection.membership = { roomId: "old-room", epoch: "old-epoch" };
  connection.inFlightPush = {
    requestId: "old-request",
    payload: { roomId: "old-room" },
  };
  connection.dirty = true;
  connection.failures = 2;

  await connection.leave();

  assert.equal(connection.membership, null);
  assert.equal(connection.inFlightPush, null);
  assert.equal(connection.dirty, false);
  assert.equal(connection.failures, 0);
});
