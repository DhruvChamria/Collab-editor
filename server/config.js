function parseInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function parseOrigin(value, fallback, production) {
  const origin = value || fallback;
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without credentials, path, query, or fragment.",
    );
  }
  if (production && url.protocol !== "https:")
    throw new Error("Production PUBLIC_ORIGIN must use HTTPS.");
  return url.origin;
}

export function readConfig(env = process.env, overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv))
    throw new Error("NODE_ENV is invalid.");
  const host = overrides.host ?? env.HOST ?? "127.0.0.1";
  const port = parseInteger(
    overrides.port ?? env.PORT,
    3000,
    overrides.allowPortZero ? 0 : 1,
    65535,
    "PORT",
  );
  const defaultOrigin = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  if (nodeEnv === "production" && !overrides.publicOrigin && !env.PUBLIC_ORIGIN)
    throw new Error("PUBLIC_ORIGIN is required in production.");
  const publicOrigin = parseOrigin(
    overrides.publicOrigin ?? env.PUBLIC_ORIGIN,
    defaultOrigin,
    nodeEnv === "production",
  );
  return { nodeEnv, host, port, publicOrigin };
}
