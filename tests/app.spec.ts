import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function signIn(context: BrowserContext) {
  const start = await context.request.get("/auth/login", { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const state = new URL(start.headers().location).searchParams.get("state")!;
  await context.request.get(`/auth/callback?code=${randomUUID()}&state=${state}`);
}

test("signed-out view, account menu, sign-in redirect and responsive layout", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Small tasks. Clear mind." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with Microsoft" })).toBeVisible();
  await page.getByRole("button", { name: "Account: signed out" }).click();
  await expect(page.getByText("Welcome to Pocket Tasks")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Welcome to Pocket Tasks")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  let destination = "";
  await page.route("**/auth/login", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    destination = response.headers().location;
    await route.fulfill({ status: 200, contentType: "text/html", body: "Microsoft sign-in redirect verified." });
  });
  await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByText("Microsoft sign-in redirect verified.")).toBeVisible();
  expect(destination).toMatch(/^https:\/\/login\.example\.test\/authorize\?state=/);
  expect(errors).toEqual([]);
});

test("private tasks, filters, profile, persisted dark mode and logout", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hello, Bob." })).toBeVisible();
  await expect(page.getByText("A fresh page, just for you.")).toBeVisible();
  await page.getByRole("textbox", { name: "New task" }).fill("Ship the little demo");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByText("Ship the little demo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit: Ship the little demo" }).click();
  await expect(page.getByRole("dialog", { name: "Edit task" })).toBeVisible();
  await page.getByRole("textbox", { name: "Task name" }).fill("Ship the polished demo");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Complete: Ship the polished demo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark active: Ship the polished demo" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.getByText("Nothing here just yet.")).toBeVisible();
  await page.getByRole("button", { name: /^Completed/ }).click();
  await expect(page.getByText("Ship the polished demo", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("absent");
  await expect(page.getByText("Nothing here just yet.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
  await page.getByRole("button", { name: "Account: Bob Example" }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Your profile" })).toContainText("Microsoft Entra ID");
  await expect(page.getByRole("dialog")).toContainText("Bob Example");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Account: Bob Example" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Dark mode" }).click();
  await expect(page.getByRole("switch", { name: "Dark mode" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Ship the polished demo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete: Ship the polished demo" }).click();
  await expect(page.getByText("A fresh page, just for you.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.route("https://login.example.test/logout", (route) => route.fulfill({ body: "Logged out of test identity provider" }));
  await page.getByRole("button", { name: "Account: Bob Example" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL("https://login.example.test/logout");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Account: signed out" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("workspace remains responsive after adding two tasks and continuing to work", async ({ page, context }) => {
  const errors: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) {
      failures.push(`${response.request().method()} ${new URL(response.url()).pathname}: ${response.status()}`);
    }
  });
  await signIn(context);
  await page.goto("/");
  const account = page.getByRole("button", { name: "Account: Bob Example" });
  await account.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Dark mode" }).click();
  await expect(page.getByRole("switch", { name: "Dark mode" })).toBeChecked();
  await page.getByRole("button", { name: "Close dialog" }).click();

  const titles = Array.from({ length: 6 }, (_, index) => `Repeated task ${index + 1}`);
  for (const title of titles) {
    await page.getByRole("textbox", { name: "New task" }).fill(title);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New task" })).toBeEnabled();
    await expect(account).toBeEnabled();
    await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add task" })).toHaveCSS("cursor", "not-allowed");
    if (title === titles[1]) {
      await page.getByRole("button", { name: `Complete: ${titles[0]}`, exact: true }).click();
      await page.getByRole("button", { name: `Mark active: ${titles[0]}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `Complete: ${titles[0]}`, exact: true })).toBeEnabled();
    }
  }
  await expect(page.locator(".task-row")).toHaveCount(6);
  for (const title of titles.slice(0, 3)) {
    await page.getByRole("button", { name: `Complete: ${title}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Mark active: ${title}`, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: `Edit: ${titles[3]}`, exact: true }).click();
  titles[3] = "Edited fourth task";
  await page.getByRole("textbox", { name: "Task name" }).fill(titles[3]);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".task-row")).toHaveCount(6);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  for (const title of titles.slice(0, 3)) {
    await expect(page.getByRole("button", { name: `Mark active: ${title}`, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.locator(".task-row")).toHaveCount(3);
  await expect(page.getByText(titles[3], { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^All tasks/ }).click();
  for (const title of titles) {
    await page.getByRole("button", { name: `Delete: ${title}`, exact: true }).click();
    await expect(page.getByText(title, { exact: true })).not.toBeVisible();
  }
  await expect(page.getByText("A fresh page, just for you.")).toBeVisible();
  await account.click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Your profile" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("alert")).not.toBeVisible();
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
});

test("shows authentication and mutation errors explicitly", async ({ page, context }) => {
  await page.goto("/?authError=invalid_state");
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await signIn(context);
  await page.goto("/");
  await page.getByRole("textbox", { name: "New task" }).fill("Cannot save");
  await page.route("**/api/todos", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The database is unavailable." }) });
    } else await route.continue();
  });

  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("alert")).toHaveText("The database is unavailable.");
  await expect(page.getByRole("textbox", { name: "New task" })).toHaveValue("Cannot save");
});

test("frontend logs and HTTP headers share a correlation ID without task contents", async ({ page, context }) => {
  const logs: Record<string, unknown>[] = [];
  page.on("console", (message) => {
    if (message.type() === "info" && message.text().startsWith("{")) {
      logs.push(JSON.parse(message.text()) as Record<string, unknown>);
    }
  });
  await signIn(context);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hello, Bob." })).toBeVisible();
  const title = "Private content must not appear in logs";
  await page.getByRole("textbox", { name: "New task" }).fill(title);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/todos") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Add task" }).click();
  const response = await responsePromise;
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const id = await response.headerValue("X-Request-ID");
  expect(await response.request().headerValue("X-Request-ID")).toBe(id);
  expect(await response.request().headerValue("X-Client-Action")).toBe("todos.create");
  expect(logs).toContainEqual(expect.objectContaining({ event: "frontend.request.started", requestId: id, clientAction: "todos.create" }));
  expect(logs).toContainEqual(expect.objectContaining({ event: "frontend.request.completed", requestId: id, serverRequestId: id, status: 201 }));
  expect(JSON.stringify(logs)).not.toContain(title);
  expect(JSON.stringify(logs)).not.toContain("csrfToken");
});
