# Collab Editor

Collab Editor is a small real-time editor for sharing a code snippet with a few people. Create a room, send the invite link, and everyone can edit the same document from their browser.

I kept the scope deliberately focused. Each room holds one temporary document, supports up to eight participants, and lives in one Node.js process. There are no accounts, databases, chat features, or code execution.

## Why I built it this way

The original version sent the whole document after every change. That was simple, but two people typing at once could overwrite each other. This version uses CodeMirror's maintained collaboration library to send structured edits instead. The server puts those edits in a single order, rebases stale edits, and lets every client pull the same history.

The project also handles the less visible parts of collaboration:

- room and participant identities come from the server;
- edits are accepted only from a socket that joined that room;
- reconnecting clients catch up before editing again;
- old or unsafe sessions move into an explicit recovery flow;
- documents, rooms, history, payloads, and request rates all have limits;
- a tab-scoped draft gives users something to export when a room cannot be recovered.

## Run it locally

You need Node.js 24.21.0 and npm 11.19.0. The repository pins both versions in `.nvmrc` and `package.json`.

```bash
npm ci --ignore-scripts
npm run build
npm start
```

Open `http://localhost:3000`, create a blank or sample room, and open the invite in another browser window.

For development, `npm run dev` builds the browser files once and watches the server. Run `npm run build` again after changing client-side code.

Local defaults are `HOST=127.0.0.1`, `PORT=3000`, and `NODE_ENV=development`. A production start also needs `PUBLIC_ORIGIN` set to the site's exact HTTPS origin.

## Run the checks

```bash
npm test
npm run build
npm run test:e2e
npm run demo
npm audit --audit-level=moderate
```

Install the Playwright browsers once before running the browser suite:

```bash
npx --no-install playwright install chromium firefox webkit
```

The tests create their own loopback servers and close every socket they open. Build output and test artifacts are ignored by Git.

## Project guide

- [Architecture](docs/architecture.md) explains how the server, browser, and collaboration loop fit together.
- [Protocol](docs/protocol.md) describes the messages exchanged over Socket.IO.
- [Safety and limits](docs/safety.md) covers privacy, resource limits, and deployment boundaries.
- [Demo](docs/demo.md) gives a short walkthrough for showing the project to someone else.

Rooms are temporary. Anyone with an invite can read and edit the document, and restarting the server removes every room. In the interface, **Synced** means this tab's edits have reached the current server process; it does not mean the document was saved to disk.
