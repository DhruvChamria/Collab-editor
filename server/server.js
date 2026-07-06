const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/*
  In-memory room store.

  Structure:
  rooms = {
    roomId: {
      code: "current document text",
      users: {
        socketId1: { username: "Alice" },
        socketId2: { username: "Bob" }
      }
    }
  }

  For an MVP, storing data in memory is enough.
  In production, use Redis/DB for persistence and scaling.
*/
const rooms = {};

// Serve frontend files
app.use(express.static(path.join(__dirname, "..", "client")));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Helper: create room if it doesn't exist
function ensureRoomExists(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      code: "",
      users: {},
    };
  }
}

// Helper: get list of usernames in a room
function getRoomUsers(roomId) {
  if (!rooms[roomId]) return [];
  return Object.values(rooms[roomId].users).map((user) => user.username);
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId || !username) return;

    ensureRoomExists(roomId);

    socket.join(roomId);

    // Save socket metadata
    socket.data.roomId = roomId;
    socket.data.username = username;

    // Register user in room
    rooms[roomId].users[socket.id] = { username };

    console.log(`${username} joined room: ${roomId}`);

    // Send current document state to newly joined user
    socket.emit("document-state", {
      code: rooms[roomId].code,
      users: getRoomUsers(roomId),
      roomId,
    });

    // Notify others in the room
    socket.to(roomId).emit("user-joined", {
      username,
      users: getRoomUsers(roomId),
    });

    // Send updated user list to everyone
    io.to(roomId).emit("users-update", {
      users: getRoomUsers(roomId),
    });
  });

  /*
    Real-time editing flow:
    - Client sends entire updated code
    - Server becomes source of truth
    - Server broadcasts latest code to everyone else
    - Conflict handling: last-write-wins
  */
  socket.on("code-change", ({ roomId, code }) => {
    if (!roomId || typeof code !== "string") return;
    if (!rooms[roomId]) return;

    rooms[roomId].code = code;

    // Broadcast to all other users in the room
    socket.to(roomId).emit("remote-code-change", {
      code,
      updatedBy: socket.data.username || "Unknown",
    });
  });

  // Optional typing indicator
  socket.on("typing", ({ roomId, username }) => {
    if (!roomId || !username) return;
    socket.to(roomId).emit("user-typing", { username });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const username = socket.data.username;

    console.log(`User disconnected: ${socket.id}`);

    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];

      // Notify remaining users
      socket.to(roomId).emit("user-left", {
        username,
        users: getRoomUsers(roomId),
      });

      io.to(roomId).emit("users-update", {
        users: getRoomUsers(roomId),
      });

      // Clean empty room
      if (Object.keys(rooms[roomId].users).length === 0) {
        delete rooms[roomId];
        console.log(`Deleted empty room: ${roomId}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});