const socket = io();

const joinPanel = document.getElementById("joinPanel");
const editorSection = document.getElementById("editorSection");
const joinBtn = document.getElementById("joinBtn");

const usernameInput = document.getElementById("username");
const roomIdInput = document.getElementById("roomId");

const currentRoom = document.getElementById("currentRoom");
const usersList = document.getElementById("usersList");
const typingStatus = document.getElementById("typingStatus");

// Flag to prevent infinite loop when applying remote updates
let isApplyingRemoteChange = false;

// For typing indicator timeout
let typingTimeout = null;

// Create CodeMirror editor
const editor = CodeMirror.fromTextArea(document.getElementById("editor"), {
  mode: "javascript",
  theme: "material-darker",
  lineNumbers: true,
  tabSize: 2,
  indentWithTabs: false,
  autoCloseBrackets: true,
  matchBrackets: true,
});

let currentRoomId = "";
let currentUsername = "";

function renderUsers(users) {
  usersList.innerHTML = "";

  users.forEach((user) => {
    const li = document.createElement("li");
    li.textContent = user;
    usersList.appendChild(li);
  });
}

joinBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const roomId = roomIdInput.value.trim();

  if (!username || !roomId) {
    alert("Please enter both username and room ID.");
    return;
  }

  currentUsername = username;
  currentRoomId = roomId;

  socket.emit("join-room", { roomId, username });

  joinPanel.classList.add("hidden");
  editorSection.classList.remove("hidden");
  currentRoom.textContent = roomId;
});

/*
  Local editor changes:
  - If user types, send entire latest document to server
  - Server updates room state
  - Others receive the latest version
*/
editor.on("change", () => {
  if (!currentRoomId) return;

  // Ignore changes caused by remote updates
  if (isApplyingRemoteChange) return;

  const code = editor.getValue();

  socket.emit("code-change", {
    roomId: currentRoomId,
    code,
  });

  socket.emit("typing", {
    roomId: currentRoomId,
    username: currentUsername,
  });
});

// Receive initial room document
socket.on("document-state", ({ code, users, roomId }) => {
  isApplyingRemoteChange = true;
  editor.setValue(code);
  isApplyingRemoteChange = false;

  currentRoom.textContent = roomId;
  renderUsers(users);
});

// Receive remote code update
socket.on("remote-code-change", ({ code, updatedBy }) => {
  const currentCursor = editor.getCursor();

  isApplyingRemoteChange = true;
  editor.setValue(code);
  isApplyingRemoteChange = false;

  // Restore cursor as best as possible
  editor.setCursor(currentCursor);

  typingStatus.textContent = `${updatedBy} made changes`;
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingStatus.textContent = "No one is typing";
  }, 1500);
});

// User list updates
socket.on("users-update", ({ users }) => {
  renderUsers(users);
});

socket.on("user-joined", ({ username, users }) => {
  typingStatus.textContent = `${username} joined the room`;
  renderUsers(users);

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingStatus.textContent = "No one is typing";
  }, 1500);
});

socket.on("user-left", ({ username, users }) => {
  typingStatus.textContent = `${username} left the room`;
  renderUsers(users);

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingStatus.textContent = "No one is typing";
  }, 1500);
});

socket.on("user-typing", ({ username }) => {
  if (username === currentUsername) return;

  typingStatus.textContent = `${username} is typing...`;

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingStatus.textContent = "No one is typing";
  }, 1200);
});