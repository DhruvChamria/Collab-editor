# Demo walkthrough

## Automated demo

After installing dependencies, run:

```bash
npm run demo
```

The demo starts its own loopback server and uses real Socket.IO clients with real CodeMirror states. It checks that:

- two concurrent edits are both preserved;
- both clients and the server end with the same document;
- a late third client receives that document;
- a second room stays isolated;
- a cross-room request is rejected without affecting server health.

The script closes every socket and the server in `finally`, including after a failed assertion.

## Browser demo

For a short interview walkthrough:

1. Run `npm run build` and `npm start`.
2. Create a sample room and open its invite in a private window.
3. Use the same display name in both windows and point out the different participant IDs.
4. Type at opposite ends of the document and wait for both windows to show **Synced**.
5. Open the invite in a third window and show that a late join receives the same text.
6. Disconnect one window. Explain why editing becomes read-only until the session resumes and catches up.
7. Show the export and recovery choices instead of pretending the document is saved permanently.
8. Create another room and show that its content never appears in the first room.
9. Stop the server and explain why the old room cannot return after restart.

## A simple way to explain the design

The original editor broadcast complete documents, so simultaneous typing could lose work. The new version sends CodeMirror changes to one server authority. The server orders and rebases those changes, while clients pull the same accepted history until they converge.

The important tradeoff is that this is connected, temporary collaboration—not an offline-first editor. Bounded history keeps memory predictable. When safe automatic recovery is no longer possible, the application preserves the user's visible draft and asks what to do instead of silently overwriting the room.
