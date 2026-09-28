# Architecture

Collab Editor has three main parts:

1. Express serves the built browser files and the health endpoint.
2. Socket.IO carries room, presence, and document messages.
3. CodeMirror's collaboration package transforms concurrent edits.

Everything runs in one Node.js process. That keeps the project easy to run and makes the collaboration rules visible in the code.

## Server responsibilities

`server/app.js` wires together Express, the HTTP server, Socket.IO, security headers, transport limits, and shutdown behavior.

`server/protocol.js` is the boundary for Socket.IO messages. It validates payloads, checks that a socket belongs to the requested room, applies rate limits, and turns internal errors into safe protocol responses.

`server/rooms.js` owns the actual room state. A room contains:

- the current CodeMirror `Text` document;
- a monotonically increasing version;
- a bounded list of accepted updates;
- participant sessions and reconnect credentials;
- creation and expiry timestamps.

Keeping room mutations synchronous is intentional. Validation, rebasing, size checks, and the final commit happen without an `await` in the middle, so another request cannot observe half-applied state.

## Browser responsibilities

`client/editor.js` creates the CodeMirror editor and exposes a small wrapper for local changes, remote updates, language selection, line wrapping, and read-only recovery states.

`client/connection.js` owns the collaboration loop. It pulls updates, applies them, pushes pending local work, and pulls again to confirm the client's own updates. Only one copy of that loop runs at a time.

`client/script.js` connects the protocol to the page: forms, status messages, export controls, presence, leave dialogs, and draft recovery. `client/recovery.js` is the only module that touches `sessionStorage`.

## How two edits converge

Suppose Alice and Bob both start from version 10 and type before receiving each other's change:

1. Alice's update reaches the server first and becomes version 11.
2. Bob still submits against version 10.
3. The server rebases Bob's update over Alice's accepted update.
4. Bob's transformed update becomes version 12.
5. Both clients pull versions 11 and 12 and apply the same ordered history.

The project does not implement transformation rules itself. It relies on `@codemirror/collab`, then adds the room lifecycle, validation, history bounds, acknowledgements, and recovery behavior around it.

## Why not a CRDT or database?

A peer-to-peer CRDT would make sense for offline-first editing or multiple authorities. This project has one server and deliberately disables offline editing, so a central authority is easier to reason about.

A database would make rooms durable, but it would also introduce migrations, cleanup jobs, and a different recovery model. Temporary rooms are enough for the intended use case: sharing a short snippet during a discussion or interview practice session.

The browser bundle is built with esbuild. All editor, language, and Socket.IO code is served from the same origin; the page does not depend on a CDN, web font, analytics script, or service worker.
