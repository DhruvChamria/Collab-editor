# Safety and limits

Collab Editor is designed as a bounded portfolio application, not a hardened public collaboration service.

## Room privacy

An invite link works like a key. Anyone who has it can join the room, read the document, and edit it until the room expires. There are no accounts or verified identities, and participant names are only display labels. Do not use a room for passwords, API keys, or other secrets.

The server keeps room content in memory and never writes it to disk. The browser may keep one recovery copy in that tab's `sessionStorage`. Users can clear or export that copy at any time. Browser storage can be blocked and may miss the last few keystrokes before a crash, so it is not a replacement for saving important work.

## Resource limits

The main limits are intentionally easy to state:

- 32 KiB per document;
- 8 participant reservations per room;
- 16 rooms per process;
- 32 admitted transports globally and 12 per peer address;
- 512 retained updates and 1 MiB of update history per room;
- bounded packet, batch, pull-response, pending-edit, and request rates.

These limits reduce accidental overload and simple application-layer abuse. They do not protect against every operating-system, proxy, TLS, or volumetric denial-of-service attack.

## Browser and HTTP boundaries

WebSocket handshakes require an allowed `Origin`, and HTTP requests require an expected `Host`. Production accepts one exact HTTPS `PUBLIC_ORIGIN`. Origin checking helps browsers enforce same-origin use, but it is not authentication: a custom native client can choose its own Origin header.

The server exposes only the built browser assets and `/health`. It disables framework disclosure and sends a nonce-based content security policy, `nosniff`, a no-referrer policy, a restricted permissions policy, and HSTS in production. Application responses and logs do not include room content, invite capabilities, resume tokens, names, or peer addresses.

## Deployment boundary

The simplest hosting shape is one WebSocket-capable Node.js service. For example, a single Render service could use:

- build: `npm ci --include=dev --ignore-scripts && npm run build`
- start: `npm start`
- runtime: Node 24.21.0
- environment: `HOST=0.0.0.0`, platform-provided `PORT`, `NODE_ENV=production`, and the exact HTTPS `PUBLIC_ORIGIN`
- health check: `/health`

Keep it to one instance. A restart, sleep, or replacement removes every room, and multiple instances would need shared state and a different synchronization design. This repository prepares the application for that shape but does not deploy it.
