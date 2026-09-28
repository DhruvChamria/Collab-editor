# Protocol

The browser and server speak a small versioned protocol over Socket.IO. Most requests include:

```js
{ v: 1, requestId: "...", /* event-specific fields */ }
```

The server answers through the Socket.IO acknowledgement callback:

```js
{ v: 1, requestId: "...", ok: true, data: { /* result */ } }
```

or:

```js
{ v: 1, requestId: "...", ok: false, error: { code, message } }
```

Typing notifications are the one exception. They are temporary hints, so they are sent without an acknowledgement.

## Rooms and participants

The server generates every room ID, room epoch, participant ID, and resume token. A room ID appears in the invite fragment (`#room=...`), which means the browser does not send it in the initial HTTP request.

Joining a room returns the current document, version, participant list, expiry time, and the new participant's reconnect credentials. The client keeps the resume token in memory; it is never placed in the invite or `sessionStorage`.

A socket can belong to only one room. Pull, push, typing, leave, and resume requests are checked against that server-side membership instead of trusting a room or participant supplied by the browser.

## Document synchronization

The browser repeats one serialized loop:

1. pull updates after its current synchronized version;
2. apply them with CodeMirror's `receiveUpdates`;
3. push up to 32 pending local updates;
4. pull again so its own accepted updates are confirmed;
5. stop when there are no pending updates.

A successful push acknowledgement means the server accepted the request. The client reports **Synced** only after pulling the accepted history and clearing its pending queue.

The server parses each serialized `ChangeSet`, checks its starting document length, rebases stale updates with `rebaseUpdates`, applies the result to a temporary document, and checks the final size. The whole batch is committed only if every update is valid.

Room versions count accepted updates, including valid empty updates created by rebasing overlapping edits. History keeps at most 512 updates and 1 MiB. A client that falls behind the retained history moves into recovery instead of replacing the shared document.

## Retries and reconnects

Control requests are retried once with the same request ID and payload. The server remembers the last control result for that socket, so a lost acknowledgement does not create a second room or participant.

Pending document pushes keep their exact request data until the client knows whether the server accepted them. After reconnecting, the client resumes the same participant session, retries uncertain work, catches up, and only then enables editing.

If the room, session, epoch, or required history is gone, the client freezes the editor and offers explicit choices: retry, export, join afresh, create a new room from the draft, or leave. It never uploads an old draft over newer shared content automatically.

## Lifetimes

- A room can live for up to four hours.
- An empty room is kept for ten minutes.
- A disconnected participant can resume for 120 seconds.
- An unjoined transport is closed after 15 seconds.
- Restarting the server removes all rooms and sessions.
