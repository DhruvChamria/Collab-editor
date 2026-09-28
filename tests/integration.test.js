import test from "node:test";
import assert from "node:assert/strict";
import { ChangeSet, EditorState } from "@codemirror/state";
import { collab, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import {
  closeSockets,
  connect,
  request,
  startTestServer,
} from "./helpers/server.js";

test("malformed and unauthenticated events do not mutate rooms or kill health", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const socket = await connect(server.origin);
  t.after(() => closeSockets(socket));
  const malformed = await new Promise((resolve) =>
    socket.emit("room:create", null, resolve),
  );
  assert.equal(malformed.ok, false);
  const unjoined = await request(socket, "doc:pull", {
    roomId: "a".repeat(22),
    epoch: "b".repeat(22),
    version: 0,
  });
  assert.equal(unjoined.error.code, "NOT_JOINED");
  const health = await fetch(`${server.origin}/health`, {
    headers: { Host: new URL(server.origin).host },
  });
  assert.equal(health.status, 200);
  assert.equal(server.store.rooms.size, 0);
});

test("root and direct index responses both inject nonce CSP and disable caching", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  for (const pathname of ["/", "/index.html"]) {
    const response = await fetch(`${server.origin}${pathname}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      response.headers.get("content-security-policy"),
      /script-src 'self'/,
    );
    assert.doesNotMatch(html, /__CSP_NONCE__/);
    assert.match(html, /meta name="csp-nonce" content="[A-Za-z0-9_-]+"/);
  }
});

test("two clients converge through authoritative OT, receive own confirmation, and late join matches", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const aSocket = await connect(server.origin);
  const bSocket = await connect(server.origin);
  const cSocket = await connect(server.origin);
  t.after(() => closeSockets(aSocket, bSocket, cSocket));
  const aJoin = (
    await request(aSocket, "room:create", { name: "Alex", sample: false })
  ).data;
  const bJoin = (
    await request(bSocket, "room:join", { roomId: aJoin.roomId, name: "Alex" })
  ).data;
  let a = EditorState.create({
    doc: aJoin.doc,
    extensions: [collab({ startVersion: 0, clientID: aJoin.clientID })],
  });
  let b = EditorState.create({
    doc: bJoin.doc,
    extensions: [collab({ startVersion: 0, clientID: bJoin.clientID })],
  });
  a = a.update({ changes: { from: 0, insert: "left" } }).state;
  b = b.update({ changes: { from: 0, insert: "right" } }).state;
  for (const [socket, state] of [
    [aSocket, a],
    [bSocket, b],
  ]) {
    const response = await request(socket, "doc:push", {
      roomId: aJoin.roomId,
      epoch: aJoin.epoch,
      version: 0,
      updates: sendableUpdates(state).map((u) => ({
        changes: u.changes.toJSON(),
      })),
    });
    assert.equal(response.ok, true);
  }
  const pullA = (
    await request(aSocket, "doc:pull", {
      roomId: aJoin.roomId,
      epoch: aJoin.epoch,
      version: 0,
    })
  ).data;
  a = a.update(
    receiveUpdates(
      a,
      pullA.updates.map((u) => ({
        clientID: u.clientID,
        changes: ChangeSet.fromJSON(u.changes),
      })),
    ),
  ).state;
  const pullB = (
    await request(bSocket, "doc:pull", {
      roomId: aJoin.roomId,
      epoch: aJoin.epoch,
      version: 0,
    })
  ).data;
  b = b.update(
    receiveUpdates(
      b,
      pullB.updates.map((u) => ({
        clientID: u.clientID,
        changes: ChangeSet.fromJSON(u.changes),
      })),
    ),
  ).state;
  assert.equal(a.doc.toString(), b.doc.toString());
  assert.equal(sendableUpdates(a).length, 0);
  assert.equal(sendableUpdates(b).length, 0);
  const cJoin = (
    await request(cSocket, "room:join", { roomId: aJoin.roomId, name: "Casey" })
  ).data;
  assert.equal(cJoin.doc, a.doc.toString());
  assert.equal(cJoin.presence.length, 3);
});

test("membership prevents cross-room writes and leave stops old-room access", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const a = await connect(server.origin);
  const b = await connect(server.origin);
  t.after(() => closeSockets(a, b));
  const first = (await request(a, "room:create", { name: "A", sample: false }))
    .data;
  const second = (await request(b, "room:create", { name: "B", sample: false }))
    .data;
  const forged = await request(a, "doc:pull", {
    roomId: second.roomId,
    epoch: second.epoch,
    version: 0,
  });
  assert.equal(forged.error.code, "EPOCH_MISMATCH");
  const left = await request(a, "room:leave", {
    roomId: first.roomId,
    epoch: first.epoch,
  });
  assert.equal(left.data.left, true);
  const after = await request(a, "doc:pull", {
    roomId: first.roomId,
    epoch: first.epoch,
    version: 0,
  });
  assert.equal(after.error.code, "NOT_JOINED");
});

test("disconnect and resume preserve identity while an active session rejects takeover", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const a = await connect(server.origin);
  const other = await connect(server.origin);
  t.after(() => closeSockets(a, other));
  const joined = (await request(a, "room:create", { name: "A", sample: false }))
    .data;
  const active = await request(other, "room:resume", {
    roomId: joined.roomId,
    epoch: joined.epoch,
    clientID: joined.clientID,
    resumeToken: joined.resumeToken,
    version: 0,
  });
  assert.equal(active.error.code, "SESSION_IN_USE");
  a.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  const resumed = await request(other, "room:resume", {
    roomId: joined.roomId,
    epoch: joined.epoch,
    clientID: joined.clientID,
    resumeToken: joined.resumeToken,
    version: 0,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.clientID, joined.clientID);
});

test("control replay is idempotent and resume cannot change a joined socket's room", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const a = await connect(server.origin);
  const b = await connect(server.origin);
  t.after(() => closeSockets(a, b));
  const payload = {
    v: 1,
    requestId: "stable-create",
    name: "A",
    sample: false,
  };
  const first = await new Promise((resolve) =>
    a.emit("room:create", payload, resolve),
  );
  const replay = await new Promise((resolve) =>
    a.emit("room:create", payload, resolve),
  );
  assert.deepEqual(replay, first);
  assert.equal(server.store.rooms.size, 1);
  assert.equal(server.store.rooms.get(first.data.roomId).sessions.size, 1);
  const other = (await request(b, "room:create", { name: "B", sample: false }))
    .data;
  const cross = await request(a, "room:resume", {
    roomId: other.roomId,
    epoch: other.epoch,
    clientID: other.clientID,
    resumeToken: other.resumeToken,
    version: 0,
  });
  assert.equal(cross.error.code, "ALREADY_JOINED");
  assert.equal(a.connected, true);
});

test("unknown acknowledged events are rejected and repeated invalid traffic disconnects", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const socket = await connect(server.origin);
  t.after(() => closeSockets(socket));
  const disconnected = new Promise((resolve) =>
    socket.once("disconnect", resolve),
  );
  for (let index = 0; index < 5; index += 1) {
    const response = await new Promise((resolve) =>
      socket.emit(
        "unknown:event",
        { v: 1, requestId: `bad-${index}` },
        resolve,
      ),
    );
    assert.equal(response.error.code, "BAD_REQUEST");
  }
  await Promise.race([
    disconnected,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("invalid event flood was not disconnected")),
        2000,
      ),
    ),
  ]);
  assert.equal(socket.connected, false);
});

test("malformed typing floods consume limits and disconnect the sender", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const socket = await connect(server.origin);
  t.after(() => closeSockets(socket));
  const disconnected = new Promise((resolve) =>
    socket.once("disconnect", resolve),
  );

  for (let index = 0; index < 30; index += 1)
    socket.emit("presence:typing", null);

  await Promise.race([
    disconnected,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("typing flood was not disconnected")),
        2000,
      ),
    ),
  ]);
  assert.equal(socket.connected, false);
});

test("a client that stays connected after leave is reclaimed by the unjoined deadline", async (t) => {
  const server = await startTestServer({ unjoinedTimeoutMs: 25 });
  t.after(() => server.stop());
  const socket = await connect(server.origin);
  t.after(() => closeSockets(socket));
  const joined = (
    await request(socket, "room:create", { name: "A", sample: false })
  ).data;
  const disconnected = new Promise((resolve) =>
    socket.once("disconnect", resolve),
  );
  const left = await request(socket, "room:leave", {
    roomId: joined.roomId,
    epoch: joined.epoch,
  });
  assert.equal(left.data.left, true);
  await disconnected;
  assert.equal(socket.connected, false);
});
