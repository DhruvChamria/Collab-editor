import assert from "node:assert/strict";
import { ChangeSet, EditorState } from "@codemirror/state";
import { collab, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import {
  closeSockets,
  connect,
  request,
  startTestServer,
} from "../tests/helpers/server.js";

const sockets = [];
let server;
try {
  server = await startTestServer();
  const a = await connect(server.origin);
  const b = await connect(server.origin);
  const c = await connect(server.origin);
  const outsider = await connect(server.origin);
  sockets.push(a, b, c, outsider);
  const joinedA = (
    await request(a, "room:create", { name: "Ada", sample: true })
  ).data;
  const joinedB = (
    await request(b, "room:join", { roomId: joinedA.roomId, name: "Linus" })
  ).data;
  let stateA = EditorState.create({
    doc: joinedA.doc,
    extensions: [collab({ clientID: joinedA.clientID })],
  });
  let stateB = EditorState.create({
    doc: joinedB.doc,
    extensions: [collab({ clientID: joinedB.clientID })],
  });
  stateA = stateA.update({ changes: { from: 0, insert: "// A\n" } }).state;
  stateB = stateB.update({
    changes: { from: stateB.doc.length, insert: "\n// B" },
  }).state;
  for (const [socket, state] of [
    [a, stateA],
    [b, stateB],
  ])
    await request(socket, "doc:push", {
      roomId: joinedA.roomId,
      epoch: joinedA.epoch,
      version: 0,
      updates: sendableUpdates(state).map((u) => ({
        changes: u.changes.toJSON(),
      })),
    });
  const pulledA = (
    await request(a, "doc:pull", {
      roomId: joinedA.roomId,
      epoch: joinedA.epoch,
      version: 0,
    })
  ).data;
  stateA = stateA.update(
    receiveUpdates(
      stateA,
      pulledA.updates.map((u) => ({
        clientID: u.clientID,
        changes: ChangeSet.fromJSON(u.changes),
      })),
    ),
  ).state;
  const pulledB = (
    await request(b, "doc:pull", {
      roomId: joinedA.roomId,
      epoch: joinedA.epoch,
      version: 0,
    })
  ).data;
  stateB = stateB.update(
    receiveUpdates(
      stateB,
      pulledB.updates.map((u) => ({
        clientID: u.clientID,
        changes: ChangeSet.fromJSON(u.changes),
      })),
    ),
  ).state;
  const authority = server.store.rooms.get(joinedA.roomId).doc.toString();
  assert.equal(stateA.doc.toString(), authority);
  assert.equal(stateB.doc.toString(), authority);
  assert.match(authority, /\/\/ A/);
  assert.match(authority, /\/\/ B/);
  console.log("PASS both live clients converge with authority");
  const joinedC = (
    await request(c, "room:join", { roomId: joinedA.roomId, name: "Grace" })
  ).data;
  assert.equal(
    joinedC.doc,
    server.store.rooms.get(joinedA.roomId).doc.toString(),
  );
  console.log("PASS late join matches authority");
  const isolated = (
    await request(outsider, "room:create", { name: "Other", sample: false })
  ).data;
  assert.notEqual(isolated.roomId, joinedA.roomId);
  assert.ok(!joinedC.doc.includes(isolated.roomId));
  console.log("PASS second room is isolated");
  const rejected = await request(outsider, "doc:pull", {
    roomId: joinedA.roomId,
    epoch: joinedA.epoch,
    version: 0,
  });
  assert.equal(rejected.ok, false);
  assert.equal((await fetch(`${server.origin}/health`)).status, 200);
  console.log("PASS cross-room request rejected and health remains ready");
} finally {
  await closeSockets(...sockets);
  await server?.stop();
}
