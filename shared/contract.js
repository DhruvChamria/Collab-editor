export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  documentBytes: 32_768,
  documentUnits: 32_768,
  roomParticipants: 8,
  rooms: 16,
  transports: 32,
  transportsPerPeer: 12,
  pendingUpdates: 128,
  requestUpdates: 32,
  historyUpdates: 512,
  historyBytes: 1_048_576,
  responseBytes: 262_144,
  changeSections: 2_048,
  sessionsSeconds: 120,
  emptyRoomSeconds: 600,
  roomSeconds: 14_400,
});

export const ERROR_CODES = Object.freeze([
  "BAD_REQUEST",
  "VERSION_MISMATCH",
  "NOT_JOINED",
  "ALREADY_JOINED",
  "ROOM_GONE",
  "ROOM_FULL",
  "CAPACITY",
  "RATE_LIMITED",
  "SESSION_EXPIRED",
  "SESSION_IN_USE",
  "EPOCH_MISMATCH",
  "HISTORY_EXPIRED",
  "FUTURE_VERSION",
  "CHANGE_INVALID",
  "DOCUMENT_LIMIT",
  "SHUTTING_DOWN",
]);

export const SAMPLE_DOCUMENT = `function greet(name) {
  return \`Hello, ${"${name}"}!\`;
}

const teammates = ["Ada", "Linus"];

for (const teammate of teammates) {
  console.log(greet(teammate));
}

// Try editing this together.
`;

export const idPattern = /^[A-Za-z0-9_-]{22}$/;
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const requestPattern = /^[A-Za-z0-9-]{1,64}$/;

export function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}
