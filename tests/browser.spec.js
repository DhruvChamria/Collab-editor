import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer } from "./helpers/server.js";
import { ProtocolError } from "../server/rooms.js";

let server;
test.beforeEach(async () => {
  server = await startTestServer();
});
test.afterEach(async () => {
  await server.stop();
});

async function createRoom(page, name = "Ada", sample = false) {
  await page.goto(server.origin);
  await page.getByLabel("Display name").fill(name);
  await page
    .getByRole("button", {
      name: sample ? "Create sample room" : "Create room",
      exact: true,
    })
    .click();
  await expect(page.locator("#statusBadge")).toHaveText("Synced");
  await expect(page.getByRole("listitem")).toContainText("(you)");
  await expect(page.locator(".cm-content")).toBeFocused();
  return page.locator("#roomLabel").textContent();
}

test("two independent contexts edit, converge, export controls work, and late join matches", async ({
  browser,
}) => {
  const a = await browser.newPage();
  const room = await createRoom(a, "Ada", true);
  const invite = `${server.origin}/#room=${room}`;
  const b = await browser.newPage();
  await b.goto(invite);
  await b.getByLabel("Display name").fill("Ada");
  await b.getByRole("button", { name: "Join room" }).click();
  await expect(b.locator("#statusBadge")).toHaveText("Synced");
  await a.locator(".cm-content").click();
  await a.keyboard.press("Control+End");
  await a.keyboard.type("\n// from A");
  await b.locator(".cm-content").click();
  await b.keyboard.press("Control+Home");
  await b.keyboard.type("// from B\n");
  await expect
    .poll(async () => a.locator(".cm-content").innerText())
    .toContain("from B");
  await expect
    .poll(async () => b.locator(".cm-content").innerText())
    .toContain("from A");
  await expect(a.locator("#statusBadge")).toHaveText("Synced");
  await expect(b.locator("#statusBadge")).toHaveText("Synced");
  await expect(a.locator("#pendingCount")).toHaveText("0 pending");
  await expect(b.locator("#pendingCount")).toHaveText("0 pending");
  const c = await browser.newPage();
  await c.goto(invite);
  await c.getByLabel("Display name").fill("Casey");
  await c.getByRole("button", { name: "Join room" }).click();
  await expect
    .poll(async () => c.locator(".cm-content").innerText())
    .toContain("from A");
  await expect(c.getByRole("listitem")).toHaveCount(3);
  await a.close();
  await b.close();
  await c.close();
});

test("typing notices use the exact participant name", async ({ browser }) => {
  const observer = await browser.newPage();
  const room = await createRoom(observer, "Observer");
  const writer = await browser.newPage();
  await writer.goto(`${server.origin}/#room=${room}`);
  await writer.getByLabel("Display name").fill("Ada · QA");
  await writer.getByRole("button", { name: "Join room" }).click();
  await expect(writer.locator("#statusBadge")).toHaveText("Synced");
  await expect(observer.getByRole("listitem")).toHaveCount(2);

  await writer.waitForTimeout(600);
  await writer.locator(".cm-content").click();
  await writer.keyboard.type("x");
  await expect(observer.locator("#typingText")).toHaveText(
    "Ada · QA is typing…",
  );
  await writer.waitForTimeout(800);
  await expect(writer.locator("#typingText")).toHaveText("No one is typing.");

  await observer.close();
  await writer.close();
});

test("landing, workspace, and clipboard fallback are keyboard accessible", async ({
  page,
  context,
}) => {
  await page.goto(server.origin);
  let result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact),
    ),
  ).toEqual([]);
  await createRoom(page);
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-content")).toBeFocused();
  result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact),
    ),
  ).toEqual([]);
  await context.grantPermissions([]);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    }),
  );
  await page.getByRole("button", { name: "Copy document" }).click();
  await expect(
    page.getByRole("heading", { name: "Copy manually" }),
  ).toBeVisible();
  result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact),
    ),
  ).toEqual([]);
});

test("mobile and narrow layouts avoid horizontal overflow", async ({
  page,
}) => {
  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(server.origin);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 700 });
  const room = await createRoom(page, "Observer");
  const writer = await page.context().newPage();
  await writer.goto(`${server.origin}/#room=${room}`);
  await writer.getByLabel("Display name").fill("W".repeat(32));
  await writer.getByRole("button", { name: "Join room" }).click();
  await expect(writer.locator("#statusBadge")).toHaveText("Synced");
  await writer.locator(".cm-content").click();
  await writer.keyboard.type("x");
  await expect(page.locator("#typingText")).toContainText("W".repeat(32));
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await writer.close();
});

test("stored drafts restore explicitly and terminal rooms expose recovery actions", async ({
  page,
}) => {
  await page.goto(server.origin);
  await page.evaluate(() =>
    sessionStorage.setItem(
      "collab-editor:draft:v1",
      JSON.stringify({
        schema: 1,
        roomId: null,
        epoch: null,
        text: "print('recovered')",
        language: "python",
        updatedAt: Date.now(),
      }),
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Recovery copy found" }),
  ).toBeVisible();
  await page.getByLabel("Display name").fill("Recoverer");
  await page
    .getByRole("button", { name: "Create new room from draft" })
    .click();
  await expect(page.locator("#statusBadge")).toHaveText("Synced");
  await expect(page.locator(".cm-content")).toContainText(
    "print('recovered')",
  );
  await expect(page.locator("#language")).toHaveValue("python");
  await expect(page.getByRole("button", { name: "Copy invite" })).toBeVisible();
  await expect(page.locator("#draftCard")).toBeHidden();
  const roomId = await page.locator("#roomLabel").textContent();
  const room = server.store.rooms.get(roomId);
  server.io
    .to(`doc:${room.id}:${room.epoch}`)
    .emit("room:ended", {
      v: 1,
      roomId: room.id,
      epoch: room.epoch,
      reason: "EXPIRED",
    });
  await expect(page.locator("#statusBadge")).toHaveText("Room ended");
  await expect(
    page.getByRole("heading", { name: "Recovery needed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export draft" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create new room from draft" })
    .click();
  await expect(page.locator("#statusBadge")).toHaveText("Synced");
  await expect(page.locator(".cm-content")).toContainText(
    "print('recovered')",
  );
  await expect(page.locator("#language")).toHaveValue("python");
});

test("invalid display names are rejected before creating a room", async ({
  page,
}) => {
  await page.goto(server.origin);
  await page.getByLabel("Display name").fill("W".repeat(33));
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page.locator("#nameError")).toContainText("1–32 characters");
  await expect(page.locator("#landing")).toBeVisible();
  expect(server.store.rooms.size).toBe(0);
});

test("a failed recovery-room creation keeps the draft visible and protected", async ({
  page,
}) => {
  const roomId = await createRoom(page, "Recoverer");
  await page.locator(".cm-content").fill("valuable draft");
  await expect(page.locator("#statusBadge")).toHaveText("Synced");
  await page.selectOption("#language", "text");
  const room = server.store.rooms.get(roomId);
  server.io.to(`doc:${room.id}:${room.epoch}`).emit("room:ended", {
    v: 1,
    roomId: room.id,
    epoch: room.epoch,
    reason: "EXPIRED",
  });
  await expect(page.locator("#statusBadge")).toHaveText("Room ended");

  const originalCreate = server.store.create.bind(server.store);
  server.store.create = () => {
    throw new ProtocolError("CAPACITY", "Temporary capacity limit");
  };
  await page
    .getByRole("button", { name: "Create new room from draft" })
    .click();
  await expect(page.locator("#landing")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recovery copy found" }),
  ).toBeVisible();
  await expect(page.locator("#roomError")).toHaveText(
    "Temporary capacity limit",
  );
  await expect(
    page.getByRole("button", { name: "Create room", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("collab-editor:draft:v1")),
    ),
  ).toMatchObject({ text: "valuable draft", language: "text" });

  server.store.create = originalCreate;
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Replace recovery copy?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#landing")).toBeVisible();
});

test("ordinary room creation cannot silently replace a recovery copy", async ({
  page,
}) => {
  await page.goto(server.origin);
  const stored = JSON.stringify({
    schema: 1,
    roomId: null,
    epoch: null,
    text: "important recovery",
    language: "text",
    updatedAt: 123,
  });
  await page.evaluate(
    ([key, value]) => sessionStorage.setItem(key, value),
    ["collab-editor:draft:v1", stored],
  );
  await page.reload();
  await page.getByLabel("Display name").fill("Keeper");

  for (const buttonName of ["Create room", "Create sample room"]) {
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Replace recovery copy?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#landing")).toBeVisible();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("collab-editor:draft:v1"),
      ),
    ).toBe(stored);
  }
});

test("failed resume attempts expose recovery and a manual retry can resume", async ({
  page,
}) => {
  const roomId = await createRoom(page, "Reconnecter");
  const room = server.store.rooms.get(roomId);
  const session = [...room.sessions.values()][0];
  const originalResume = server.store.resume.bind(server.store);
  let attempts = 0;
  server.store.resume = (input) => {
    attempts += 1;
    if (attempts <= 2)
      throw new ProtocolError(
        "RATE_LIMITED",
        "Temporary resume failure",
        10,
      );
    return originalResume(input);
  };

  server.io.sockets.sockets.get(session.socketId).conn.close();
  await expect(page.locator("#statusBadge")).toHaveText("Reconnecting");
  await expect(page.locator("#statusBadge")).toHaveText("Recovery needed", {
    timeout: 10_000,
  });
  expect(attempts).toBe(2);
  await expect(page.locator("#recoveryActions")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "false",
  );

  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(page.locator("#statusBadge")).toHaveText("Synced", {
    timeout: 10_000,
  });
  await expect(page.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "true",
  );
});

test("late composition end cannot refreeze a resumed editor", async ({
  page,
}) => {
  const roomId = await createRoom(page, "IME");
  const room = server.store.rooms.get(roomId);
  const session = [...room.sessions.values()][0];
  const content = page.locator(".cm-content");

  await content.dispatchEvent("compositionstart", { data: "あ" });
  server.io.sockets.sockets.get(session.socketId).conn.close();
  await expect(page.locator("#statusBadge")).toHaveText("Reconnecting");
  await expect(page.locator("#statusBadge")).toHaveText("Synced", {
    timeout: 10_000,
  });
  await expect(content).toHaveAttribute("contenteditable", "true");
  await content.dispatchEvent("compositionend", { data: "あ" });
  await page.waitForTimeout(100);
  await expect(content).toHaveAttribute("contenteditable", "true");
});

test("leaving surfaces the recovery copy and requires confirmation before another join", async ({
  page,
}) => {
  const room = await createRoom(page, "Leaver", false);
  await page.locator(".cm-content").fill("keep this draft");
  await expect(page.locator("#statusBadge")).toHaveText("Synced");
  await page.getByRole("button", { name: "Leave" }).click();
  await expect(
    page.getByRole("heading", { name: "Recovery copy found" }),
  ).toBeVisible();
  await page.getByLabel("Room code").fill(room);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(
    page.getByRole("heading", { name: "Replace recovery copy?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#landing")).toBeVisible();
});
