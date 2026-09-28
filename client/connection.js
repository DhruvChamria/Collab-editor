import { io } from "socket.io-client";
import { ChangeSet } from "@codemirror/state";

const deadline = 5000;
const requestId = () => crypto.randomUUID().replaceAll("-", "");

export class CollaborationConnection {
  constructor({ onPhase, onPresence, onTyping, onEnded }) {
    this.handlers = { onPhase, onPresence, onTyping, onEnded };
    this.generation = 0;
    this.membership = null;
    this.editor = null;
    this.running = false;
    this.dirty = false;
    this.idleTimer = null;
    this.resumeTimer = null;
    this.sessionRetryUsed = false;
    this.inFlightPush = null;
    this.failures = 0;
    this.socket = io({
      autoConnect: false,
      transports: ["websocket"],
      reconnectionAttempts: 5,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 5000,
    });
    this.recovering = false;
    this.socket.on("connect", () => {
      if (this.membership && this.editor) void this.resume();
      else onPhase("Connecting");
    });
    this.socket.on("disconnect", () => {
      this.generation += 1;
      if (this.membership) {
        void this.editor?.freeze();
        onPhase("Reconnecting");
      }
    });
    this.socket.on("doc:available", (notice) => {
      if (this.matches(notice)) this.schedule();
    });
    this.socket.on("presence:state", (notice) => {
      if (this.matches(notice))
        onPresence(notice.presence, this.membership.clientID);
    });
    this.socket.on("presence:typing", (notice) => {
      if (this.matches(notice)) onTyping(notice.clientID);
    });
    this.socket.on("room:ended", (notice) => {
      if (this.matches(notice)) {
        this.generation += 1;
        this.clearIdle();
        clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
        this.inFlightPush = null;
        void this.editor?.freeze();
        this.membership = null;
        this.socket.disconnect();
        onPhase("Room ended");
        onEnded(notice.reason);
      }
    });
    this.socket.io.on("reconnect_failed", () =>
      this.handlers.onPhase(
        "Recovery needed",
        "Automatic reconnect attempts were exhausted. Retry, export, or leave.",
      ),
    );
  }
  matches(value) {
    return (
      this.membership &&
      value.roomId === this.membership.roomId &&
      value.epoch === this.membership.epoch
    );
  }
  emit(event, payload, timeout = deadline, stableRequestId = requestId()) {
    return new Promise((resolve, reject) => {
      if (!this.socket.connected) return reject(new Error("Not connected"));
      this.socket
        .timeout(timeout)
        .emit(
          event,
          { v: 1, requestId: stableRequestId, ...payload },
          (error, response) => {
            if (error) reject(error);
            else if (!response?.ok) {
              const failure = new Error(
                response?.error?.message || "Request failed",
              );
              failure.code = response?.error?.code;
              failure.retryAfterMs = response?.error?.retryAfterMs;
              reject(failure);
            } else resolve(response.data);
          },
        );
    });
  }
  async control(event, payload) {
    const stableRequestId = requestId();
    try {
      return await this.emit(event, payload, deadline, stableRequestId);
    } catch (first) {
      if (first.code && first.code !== "RATE_LIMITED") throw first;
      if (first.code === "RATE_LIMITED")
        await new Promise((resolve) =>
          setTimeout(resolve, first.retryAfterMs || 500),
        );
      else if (!this.socket.connected) throw first;
      try {
        return await this.emit(event, payload, deadline, stableRequestId);
      } catch (second) {
        if (!second.code && ["room:create", "room:join"].includes(event)) {
          this.socket.disconnect();
          this.generation += 1;
          const unknown = new Error(
            "Join result unknown; try joining again. A newly created room may expire unused.",
          );
          unknown.code = "UNKNOWN_RESULT";
          throw unknown;
        }
        throw second;
      }
    }
  }
  async open() {
    if (this.socket.connected) return;
    await new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off("connect", done);
        this.socket.off("connect_error", fail);
      };
      this.socket.once("connect", done);
      this.socket.once("connect_error", fail);
      this.socket.connect();
    });
  }
  async create(name, sample) {
    this.handlers.onPhase("Connecting");
    await this.open();
    this.handlers.onPhase("Joining");
    return this.accept(await this.control("room:create", { name, sample }));
  }
  async join(name, roomId) {
    this.handlers.onPhase("Connecting");
    await this.open();
    this.handlers.onPhase("Joining");
    return this.accept(await this.control("room:join", { name, roomId }));
  }
  accept(snapshot) {
    this.membership = snapshot;
    this.sessionRetryUsed = false;
    this.handlers.onPresence(snapshot.presence, snapshot.clientID);
    this.handlers.onPhase("Syncing");
    return snapshot;
  }
  attachEditor(editor) {
    this.editor = editor;
    this.startIdle();
    this.schedule();
  }
  async resume() {
    if (this.recovering || !this.membership || !this.editor) return;
    this.recovering = true;
    this.handlers.onPhase("Reconnecting");
    this.editor.setEditable(false);
    try {
      await this.control("room:resume", {
        roomId: this.membership.roomId,
        epoch: this.membership.epoch,
        clientID: this.membership.clientID,
        resumeToken: this.membership.resumeToken,
        version: this.editor.version(),
      });
      this.schedule();
    } catch (error) {
      if (error.code === "SESSION_IN_USE") {
        this.socket.io.opts.reconnection = false;
        this.socket.disconnect();
        if (this.sessionRetryUsed)
          this.handlers.onPhase(
            "Recovery needed",
            "The previous session is still active. Retry manually, export, or leave.",
          );
        else {
          this.sessionRetryUsed = true;
          this.handlers.onPhase(
            "Reconnecting",
            "The previous connection is still closing.",
          );
          const generation = this.generation;
          clearTimeout(this.resumeTimer);
          this.resumeTimer = setTimeout(() => {
            if (generation !== this.generation || !this.membership) return;
            this.socket.io.opts.reconnection = true;
            this.socket.connect();
          }, 50_000);
        }
      } else
        this.handlers.onPhase(
          "Recovery needed",
          error.message,
        );
    } finally {
      this.recovering = false;
    }
  }
  startIdle() {
    this.clearIdle();
    this.idleTimer = setInterval(() => this.schedule(), 2000);
  }
  clearIdle() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
  schedule() {
    this.dirty = true;
    if (!this.running) queueMicrotask(() => this.sync());
  }
  async sync() {
    if (
      this.running ||
      !this.editor ||
      !this.membership ||
      !this.socket.connected
    )
      return;
    this.running = true;
    this.handlers.onPhase("Syncing");
    const generation = this.generation;
    const member = this.membership;
    const attachedEditor = this.editor;
    const current = () =>
      generation === this.generation &&
      member === this.membership &&
      attachedEditor === this.editor;
    try {
      do {
        this.dirty = false;
        if (this.inFlightPush) {
          await this.emit(
            "doc:push",
            this.inFlightPush.payload,
            deadline,
            this.inFlightPush.requestId,
          );
          if (!current()) return;
          this.inFlightPush = null;
        }
        const pulled = await this.emit("doc:pull", {
          roomId: this.membership.roomId,
          epoch: this.membership.epoch,
          version: this.editor.version(),
        });
        if (!current()) return;
        if (pulled.fromVersion !== this.editor.version())
          throw new Error("Version gap");
        if (pulled.updates.length)
          this.editor.receive(
            pulled.updates.map((update) => ({
              clientID: update.clientID,
              changes: ChangeSet.fromJSON(update.changes),
            })),
          );
        const pending = this.editor.pending().slice(0, 32);
        if (pending.length) {
          this.inFlightPush = {
            requestId: requestId(),
            payload: {
              roomId: this.membership.roomId,
              epoch: this.membership.epoch,
              version: this.editor.version(),
              updates: pending.map((update) => ({
                changes: update.changes.toJSON(),
              })),
            },
          };
          await this.emit(
            "doc:push",
            this.inFlightPush.payload,
            deadline,
            this.inFlightPush.requestId,
          );
          if (!current()) return;
          this.inFlightPush = null;
          this.dirty = true;
        }
      } while (this.dirty || this.editor.pending().length);
      this.failures = 0;
      this.editor.setEditable(true);
      this.handlers.onPhase("Synced");
    } catch (error) {
      this.failures += 1;
      void this.editor.freeze();
      this.handlers.onPhase(
        error.code &&
          [
            "HISTORY_EXPIRED",
            "ROOM_GONE",
            "SESSION_EXPIRED",
            "EPOCH_MISMATCH",
            "CHANGE_INVALID",
            "DOCUMENT_LIMIT",
          ].includes(error.code)
          ? "Recovery needed"
          : "Reconnecting",
        error.message,
      );
      if (error.code === "RATE_LIMITED") {
        setTimeout(() => this.schedule(), error.retryAfterMs || 500);
        return;
      }
      if (!error.code && this.socket.connected && this.failures >= 3) {
        this.socket.disconnect();
        this.socket.connect();
      }
    } finally {
      this.running = false;
      if (this.dirty) this.schedule();
    }
  }
  typing() {
    if (this.socket.connected && this.membership)
      this.socket.volatile.emit("presence:typing", {
        v: 1,
        roomId: this.membership.roomId,
        epoch: this.membership.epoch,
      });
  }
  retry() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.generation += 1;
    if (this.socket.connected) void this.resume();
    else this.socket.connect();
  }
  invite() {
    return `${location.origin}${location.pathname}#room=${this.membership.roomId}`;
  }
  async leave() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.generation += 1;
    this.inFlightPush = null;
    this.dirty = false;
    this.failures = 0;
    if (this.membership && this.socket.connected)
      try {
        await this.control("room:leave", {
          roomId: this.membership.roomId,
          epoch: this.membership.epoch,
        });
      } catch {}
    this.clearIdle();
    this.socket.disconnect();
    this.membership = null;
    this.editor = null;
  }
}
