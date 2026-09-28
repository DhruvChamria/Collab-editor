import { CollaborationConnection } from "./connection.js";
import { createCollaborativeEditor } from "./editor.js";
import { clearDraft, downloadText, readDraft, saveDraft } from "./recovery.js";
import { copyWithFallback, renderPresence, setStatus } from "./ui.js";

const $ = (selector) => document.querySelector(selector);
const encoder = new TextEncoder();
let editor;
let snapshot;
let saveTimer;
let typingTimer;
let lastTyping = 0;
let restoring = false;
let startupDraft = readDraft();
let participants = new Map();
const connection = new CollaborationConnection({
  onPhase: (phase, detail) => {
    setStatus(phase, detail);
    $("#statusBadge").hidden = false;
    $("#recoveryActions").hidden = !["Recovery needed", "Room ended"].includes(
      phase,
    );
    $("#recoveryRetry").hidden = phase === "Room ended";
    $("#recoveryJoin").hidden = phase === "Room ended";
  },
  onPresence: (people, selfID) => {
    participants = new Map(people.map((person) => [person.clientID, person]));
    renderPresence(people, selfID);
  },
  onTyping: (clientID) => {
    const person = participants.get(clientID);
    $("#typingText").textContent = person
      ? `${person.name} is typing…`
      : "A participant is typing…";
    clearTimeout(typingTimer);
    typingTimer = setTimeout(
      () => ($("#typingText").textContent = "No one is typing."),
      2000,
    );
  },
  onEnded: () => persist(),
});
function roomFromFragment() {
  const match = location.hash.match(/^#room=([A-Za-z0-9_-]{22})$/);
  return match?.[1] || "";
}
function validate() {
  const name = $("#name").value.trim().normalize("NFC");
  const roomId = $("#roomCode").value.trim();
  const invalidName =
    [...name].length > 32 ||
    encoder.encode(name).byteLength > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name);
  $("#nameError").textContent = !name
    ? "Enter a display name."
    : invalidName
      ? "Use 1–32 characters without control or direction-changing characters."
      : "";
  $("#roomError").textContent =
    roomId && !/^[A-Za-z0-9_-]{22}$/.test(roomId)
      ? "Room codes contain exactly 22 letters, numbers, _ or -."
      : "";
  return {
    name,
    roomId,
    valid: Boolean(
      name &&
        !invalidName &&
        (!roomId || /^[A-Za-z0-9_-]{22}$/.test(roomId)),
    ),
  };
}
function persist() {
  if (!editor || restoring) return;
  const ok = saveDraft({
    roomId: snapshot.roomId,
    epoch: snapshot.epoch,
    text: editor.text(),
    language: $("#language").value,
  });
  if (!ok)
    setStatus(
      $("#statusBadge").textContent,
      "Local draft storage is unavailable; export important text.",
    );
}
function updateEditorStatus() {
  const bytes = encoder.encode(editor.text()).byteLength;
  $("#documentSize").textContent = `${bytes} / 32768 bytes`;
  $("#pendingCount").textContent = `${editor.pending().length} pending`;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}
function announceTyping() {
  const now = Date.now();
  if (now - lastTyping > 500) {
    lastTyping = now;
    connection.typing();
  }
}
function enterWorkspace(data, seedText, seedLanguage = "javascript") {
  restoring = seedText != null;
  snapshot = data;
  history.replaceState(null, "", `#room=${data.roomId}`);
  $("#landing").hidden = true;
  $("#workspace").hidden = false;
  $("#roomLabel").textContent = data.roomId;
  $("#expiry").textContent =
    `Expires ${new Date(data.expiresAt).toLocaleTimeString()}`;
  editor?.destroy();
  editor = createCollaborativeEditor({
    parent: $("#editorMount"),
    doc: data.doc,
    version: data.version,
    clientID: data.clientID,
    onLocalChange: () => {
      connection.schedule();
      announceTyping();
    },
    onTextChange: updateEditorStatus,
    onLimit: () =>
      setStatus(
        editor?.pending().length ? "Syncing" : "Synced",
        "The 32 KiB document or 128 pending-edit limit was reached; export before continuing.",
      ),
  });
  connection.attachEditor(editor);
  const language = ["javascript", "python", "text"].includes(seedLanguage)
    ? seedLanguage
    : "javascript";
  $("#language").value = language;
  editor.setLanguage(language);
  updateEditorStatus();
  if (seedText != null) {
    $("#copyInvite").hidden = true;
    setStatus(
      "Syncing",
      "Restoring draft before the invite becomes available.",
    );
    if (seedText !== data.doc) editor.insert(seedText);
    const sourceDraft = seedText;
    const wait = setInterval(() => {
      if (!editor || snapshot !== data) {
        clearInterval(wait);
        return;
      }
      if (
        editor.pending().length === 0 &&
        $("#statusBadge").textContent === "Synced"
      ) {
        clearInterval(wait);
        restoring = false;
        startupDraft = null;
        $("#draftCard").hidden = true;
        $("#copyInvite").hidden = false;
        saveDraft({
          roomId: data.roomId,
          epoch: data.epoch,
          text: editor.text(),
          language: $("#language").value,
        });
      } else if ($("#statusBadge").textContent === "Recovery needed") {
        clearInterval(wait);
        saveDraft({
          roomId: null,
          epoch: null,
          text: sourceDraft,
          language: $("#language").value,
        });
      }
    }, 50);
  }
  editor.focus();
}
async function approveDraftReplacement() {
  if (!startupDraft) return true;
  const dialog = $("#draftConflictDialog");
  dialog.showModal();
  const result = await new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue), {
      once: true,
    }),
  );
  return result === "replace";
}
async function submit(
  action,
  seedText,
  seedLanguage = "javascript",
  skipDraftConfirmation = false,
) {
  const values = validate();
  if (!values.valid) return;
  const replacesDraft = Boolean(startupDraft && seedText == null);
  if (
    replacesDraft &&
    !skipDraftConfirmation &&
    !(await approveDraftReplacement())
  )
    return;
  for (const button of $("#joinForm").querySelectorAll("button"))
    button.disabled = true;
  try {
    const data =
      action === "join"
        ? await connection.join(values.name, values.roomId)
        : await connection.create(values.name, action === "sample");
    if (replacesDraft) {
      clearDraft();
      startupDraft = null;
      $("#draftCard").hidden = true;
    }
    enterWorkspace(data, seedText, seedLanguage);
  } catch (error) {
    if (error.code === "BAD_REQUEST")
      $("#nameError").textContent = error.message;
    else $("#roomError").textContent = error.message;
    setStatus("Recovery needed", error.message);
  } finally {
    for (const button of $("#joinForm").querySelectorAll("button"))
      button.disabled = false;
  }
}
$("#roomCode").value = roomFromFragment();
$("#joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const { roomId } = validate();
  void submit(roomId ? "join" : "blank");
});
$("#createBlank").addEventListener("click", () => void submit("blank"));
$("#createSample").addEventListener("click", () => void submit("sample"));
$(".skip-link").addEventListener("click", (event) => {
  if (!editor) return;
  event.preventDefault();
  editor.focus();
});
$("#language").addEventListener("change", () => {
  editor.setLanguage($("#language").value);
  persist();
});
$("#wrap").addEventListener("change", () => editor.setWrap($("#wrap").checked));
$("#copyInvite").addEventListener(
  "click",
  () => void copyWithFallback(connection.invite()),
);
$("#copyDocument").addEventListener(
  "click",
  () => void copyWithFallback(editor.text()),
);
$("#downloadDocument").addEventListener("click", () =>
  downloadText(editor.text(), $("#language").value),
);
async function finishLeave() {
  if (editor) {
    startupDraft = {
      schema: 1,
      roomId: snapshot?.roomId || null,
      epoch: snapshot?.epoch || null,
      text: editor.text(),
      language: $("#language").value,
      updatedAt: Date.now(),
    };
    persist();
  }
  await connection.leave();
  editor?.destroy();
  editor = null;
  snapshot = null;
  participants.clear();
  restoring = false;
  $("#workspace").hidden = true;
  $("#landing").hidden = false;
  $("#statusBadge").hidden = true;
  $("#draftCard").hidden = !startupDraft;
}
async function attemptLeave() {
  if (
    editor?.pending().length ||
    editor?.isComposing() ||
    restoring ||
    !$("#recoveryActions").hidden
  ) {
    const dialog = $("#leaveDialog");
    dialog.showModal();
    const result = await new Promise((resolve) =>
      dialog.addEventListener("close", () => resolve(dialog.returnValue), {
        once: true,
      }),
    );
    if (result !== "leave") return;
  }
  await finishLeave();
}
$("#leave").addEventListener("click", () => void attemptLeave());
$("#leaveExport").addEventListener("click", () =>
  downloadText(editor.text(), $("#language").value),
);
$("#recoveryExport").addEventListener("click", () =>
  downloadText(editor.text(), $("#language").value),
);
$("#recoveryRetry").addEventListener("click", () => connection.retry());
$("#recoveryLeave").addEventListener("click", () => void attemptLeave());
$("#recoveryJoin").addEventListener("click", async () => {
  const dialog = $("#freshJoinDialog");
  dialog.showModal();
  const result = await new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue), {
      once: true,
    }),
  );
  if (result !== "join") return;
  const roomId = snapshot.roomId;
  await finishLeave();
  $("#roomCode").value = roomId;
  await submit("join", null, "javascript", true);
});
$("#recoveryCreate").addEventListener("click", async () => {
  const source = editor.text();
  const sourceLanguage = $("#language").value;
  startupDraft = {
    schema: 1,
    roomId: snapshot?.roomId || null,
    epoch: snapshot?.epoch || null,
    text: source,
    language: sourceLanguage,
    updatedAt: Date.now(),
  };
  persist();
  await connection.leave();
  editor.destroy();
  editor = null;
  snapshot = null;
  participants.clear();
  $("#workspace").hidden = true;
  $("#landing").hidden = false;
  $("#draftCard").hidden = false;
  await submit("blank", source, sourceLanguage, true);
});
if (startupDraft) $("#draftCard").hidden = false;
$("#exportDraft").addEventListener("click", () => {
  if (startupDraft) downloadText(startupDraft.text, startupDraft.language);
});
$("#restoreDraft").addEventListener("click", () => {
  if (startupDraft)
    void submit("blank", startupDraft.text, startupDraft.language, true);
});
$("#clearDraft").addEventListener("click", () => {
  if (startupDraft && confirm("Clear this tab’s recovery copy?")) {
    clearDraft();
    startupDraft = null;
    $("#draftCard").hidden = true;
  }
});
$("#draftConflictExport").addEventListener("click", () => {
  if (startupDraft) downloadText(startupDraft.text, startupDraft.language);
});
$("#freshJoinExport").addEventListener("click", () => {
  if (editor) downloadText(editor.text(), $("#language").value);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) persist();
});
addEventListener("pagehide", persist);
