import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function ready(page) {
  await page.goto("/");
  await expect(page.locator(".vendor-card")).toHaveCount(3);
  await expect(page.locator("#results")).toHaveAttribute("aria-busy", "false");
}

async function openFilters(page) {
  const toggle = page.locator("#toggle-filters");
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("first screen renders real cards, assets and common facts without browser errors", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await expect(page.locator("h1")).toContainText("Подбор подрядчиков");
  await expect(page.locator("#result-context")).toContainText("17.10.2026");
  await expect(page.locator("#explanation-source")).toContainText("По фактам каталога");
  expect(await page.locator(".vendor-card svg").count()).toBeGreaterThan(6);
  expect(await page.locator(".sidebar-season img").evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(errors).toEqual([]);
  await noOverflow(page);
  await mkdir(".cache/screenshots", { recursive: true });
  await page.screenshot({ path: `.cache/screenshots/${testInfo.project.name}.png`, fullPage: true });
});

test("rare category shows one explicitly synthetic profile", async ({ page }) => {
  await ready(page);
  await page.locator('[data-demo="rare"]').click();
  await expect(page.locator(".vendor-card")).toHaveCount(1);
  await expect(page.locator("#result-notice")).toHaveAttribute("data-state", "partial");
  await expect(page.locator(".badge").first()).toHaveText("Синтетический профиль");
  await noOverflow(page);
});

test("empty result gives reasons and a working minimum-budget action", async ({ page }) => {
  await ready(page);
  await page.locator('[data-demo="empty"]').click();
  await expect(page.locator("#result-notice")).toHaveAttribute("data-state", "all_filtered");
  await expect(page.locator(".vendor-card")).toHaveCount(0);
  await expect(page.locator(".reason-breakdown")).toContainText("Дороже бюджета");
  await page.getByRole("button", { name: /Показать с бюджетом/ }).click();
  await expect(page.locator(".vendor-card").first()).toBeVisible();
  await expect(page.locator("#budget")).toHaveValue("500000");
  await noOverflow(page);
});

test("missing category suggests another city and applies it", async ({ page }) => {
  await ready(page);
  await openFilters(page);
  await page.locator("#city").selectOption("Астана");
  await page.locator("#category").selectOption("Декоратор");
  await page.getByRole("button", { name: "Найти подрядчиков" }).click();
  await expect(page.locator("#result-notice")).toHaveAttribute("data-state", "no_category");
  await page.getByRole("button", { name: /Показать в Алматы/ }).click();
  await expect(page.locator("#city")).toHaveValue("Алматы");
  await expect(page.locator("#result-notice")).toHaveAttribute("data-state", "all_filtered");
  await page.getByRole("button", { name: /Показать с бюджетом/ }).click();
  await expect(page.locator(".vendor-card").first()).toBeVisible();
});

test("busy date changes the selection to a single contractor", async ({ page }) => {
  await ready(page);
  await openFilters(page);
  await page.locator("#date").fill("2026-12-26");
  await page.getByRole("button", { name: "Найти подрядчиков" }).click();
  await expect(page.locator(".vendor-card")).toHaveCount(1);
  await expect(page.locator("#result-context")).toContainText("26.12.2026");
  await expect(page.locator("#result-notice")).toContainText("9 заняты");
});

test("profile modal, persisted favorites, removal and JSON export work", async ({ page }) => {
  await ready(page);
  const first = page.locator(".vendor-card").first();
  const name = await first.locator("h3").textContent();
  await first.getByRole("button", { name: "Профиль" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#profile-title")).toHaveText(name);
  await page.getByRole("dialog").getByRole("button", { name: "Добавить в избранное" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Избранное", exact: true }).click();
  await expect(page.locator(".vendor-card")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".vendor-card h3")).toHaveText(name);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать подборку JSON" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("pitchers-favorites.json");
  await page.getByRole("button", { name: "Убрать из избранного" }).click();
  await expect(page.locator(".empty-state")).toContainText("Избранное пока пусто");
  await noOverflow(page);
});

test("failed request has a working retry, without an empty screen", async ({ page }) => {
  await page.route("**/api/recommend", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Сервис временно недоступен." }) }));
  await page.goto("/");
  await expect(page.locator("#result-notice")).toContainText("Сервис временно недоступен.");
  await page.unroute("**/api/recommend");
  await page.getByRole("button", { name: "Повторить запрос" }).click();
  await expect(page.locator(".vendor-card")).toHaveCount(3);
});

test("320-pixel layout and modal have no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await ready(page);
  await noOverflow(page);
  await page.locator(".vendor-card").first().getByRole("button", { name: "Профиль" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.getByRole("dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await noOverflow(page);
});

test("calendar bounds prevent submitting a date outside the dataset", async ({ page }) => {
  await ready(page);
  await openFilters(page);
  await page.locator("#date").fill("2027-01-01");
  await page.getByRole("button", { name: "Найти подрядчиков" }).click();
  expect(await page.locator("#date").evaluate((input) => input.validity.rangeOverflow)).toBe(true);
  await expect(page.locator(".vendor-card")).toHaveCount(3);
});

test("optional language and duration filter the real engine results", async ({ page }) => {
  await ready(page);
  await openFilters(page);
  await page.locator(".extra-filters summary").click();
  await page.locator("#language").selectOption("казахский");
  await page.locator("#hours").fill("8");
  await page.getByRole("button", { name: "Найти подрядчиков" }).click();
  await expect(page.locator(".vendor-card")).toHaveCount(2);
  await expect(page.locator("#result-context")).toContainText(/казахск/);
  await expect(page.locator("#result-context")).toContainText("8 ч");
});

test("a superseded slow query cannot overwrite the latest demo selection", async ({ page }) => {
  await ready(page);
  let delayed = false;
  await page.route("**/api/recommend", async (route) => {
    if (route.request().postDataJSON().category === "Ведущий") {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await route.continue().catch(() => {});
  });
  await page.locator('[data-demo="dense"]').click();
  await expect.poll(() => delayed).toBe(true);
  await page.locator('[data-demo="rare"]').click();
  await expect(page.locator(".vendor-card")).toHaveCount(1);
  await expect(page.locator("#results")).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(500);
  await expect(page.locator(".vendor-card")).toHaveCount(1);
  await expect(page.locator(".card-meta")).toContainText("Флорист");
});

test("blind comparison hides identities in cards and profiles without losing facts", async ({ page }) => {
  await ready(page);
  const names = await page.locator(".vendor-card h3").allTextContents();
  await page.getByRole("checkbox", { name: "Скрыть имена" }).check();
  await expect(page.locator(".vendor-card h3")).toHaveText(["Подрядчик A", "Подрядчик B", "Подрядчик C"]);
  for (const name of names) await expect(page.locator("#results")).not.toContainText(name);
  await page.locator(".vendor-card").first().getByRole("button", { name: "Профиль" }).click();
  await expect(page.locator("#profile-title")).toHaveText("Подрядчик A");
  for (const name of names) await expect(page.getByRole("dialog")).not.toContainText(name);
  await expect(page.getByRole("dialog")).toContainText("Соответствие запросу");
  await expect(page.locator(".profile-chip").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Скрыть имена" }).uncheck();
  await expect(page.locator(".vendor-card h3")).toHaveText(names);
  await noOverflow(page);
});

test("natural-language parameters remain editable before finding real candidates", async ({ page }) => {
  await ready(page);
  await openFilters(page);
  await page.locator(".brief-input summary").click();
  await page.route("**/api/parse", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    query: { city: "Алматы", date: "2026-10-17", category: "Флорист", eventType: "свадьба", budget: 500000 },
  }) }));
  await page.locator("#free-text").fill("Флорист в Алматы на свадьбу 17 октября, бюджет 500000 тенге");
  await page.getByRole("button", { name: "Заполнить параметры" }).click();
  await expect(page.locator("#parse-feedback")).toHaveText("Параметры заполнены.");
  await expect(page.locator("#category")).toHaveValue("Флорист");
  await expect(page.locator("#budget")).toHaveValue("500000");
  await page.getByRole("button", { name: "Найти подрядчиков" }).click();
  await expect(page.locator(".vendor-card")).toHaveCount(1);
  await expect(page.locator(".card-meta")).toContainText("Флорист");
});

test("unavailable text parsing does not prevent manual selection", async ({ page }) => {
  await ready(page);
  await openFilters(page);
  await page.locator(".brief-input summary").click();
  await page.locator("#free-text").fill("Нужен ведущий на корпоратив");
  const responsePromise = page.waitForResponse("**/api/parse");
  await page.getByRole("button", { name: "Заполнить параметры" }).click();
  expect((await responsePromise).status()).toBe(503);
  await expect(page.locator("#parse-feedback")).not.toBeEmpty();
  await expect(page.locator("#parse-button")).toBeEnabled();
  await page.locator("#date").fill("2026-12-26");
  await page.getByRole("button", { name: "Найти подрядчиков" }).click();
  await expect(page.locator(".vendor-card")).toHaveCount(1);
});
