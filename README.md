# Real-Time Collaborative Code Editor

A Google Docs-style collaborative code editor built with Node.js and Socket.IO. Multiple users can join a shared room and edit code simultaneously, with changes synced in real time across all connected clients.

## Demo

```
User A types → server receives → broadcasts to User B, C, D → all editors update instantly
```

## Tech Stack

- **Node.js + Express** - HTTP server and static file serving
- **Socket.IO** - WebSocket-based real-time event broadcasting
- **CodeMirror 5** - syntax-highlighted code editor with bracket matching
- **Vanilla JS** - no frontend framework

## Features

- Join or create rooms by room ID - multiple independent sessions
- Sub-100ms edit synchronization across concurrent clients
- Server-maintained authoritative document state - new users get full document on join
- Online user list with live join/leave notifications
- Typing indicator shows who is currently editing
- Cursor position preserved when remote updates arrive
- Conflict resolution via last-write-wins
- Auto-cleanup of empty rooms

## Architecture

```
Client A  ──┐
Client B  ──┼──► Socket.IO Server ──► broadcast to others in room
Client C  ──┘         │
                       └──► In-memory room store
                            { roomId: { code, users } }
```

The server is the single source of truth. Every `code-change` event updates the room's stored document, and the latest state is sent to any user who joins mid-session.

## Getting Started

**Prerequisites:** Node.js 16+

```bash
git clone https://github.com/DhruvChamria/collab-editor.git
cd collab-editor
npm install
npm run dev       # uses nodemon for auto-reload
```

Open `http://localhost:3000`, enter a username and room ID, and open the same URL in another tab to test live collaboration.

## Project Structure

```
collab-editor/
├── server/
│   └── server.js        # Socket.IO events, room management
├── client/
│   ├── index.html       # Join panel + editor layout
│   ├── script.js        # Socket client, CodeMirror integration
│   └── style.css        # Dark-themed UI
└── package.json
```

## Known Limitations

- State is in-memory only - restarting the server clears all rooms
- No OT (Operational Transformation) or CRDT - concurrent edits use last-write-wins