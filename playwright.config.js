import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const port = process.env.UI_TEST_PORT || "3100";
const edgeInstalled = process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: ".cache/ui-tests",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PLAYWRIGHT_CHANNEL || (edgeInstalled ? "msedge" : undefined),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1050 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "node src/server.js",
    url: `http://127.0.0.1:${port}/api/meta`,
    reuseExistingServer: false,
    env: { PORT: port, LLM_API_KEY: "", OPENAI_API_KEY: "", LLM_MODEL: "browser-test-offline" },
    timeout: 15000,
  },
});
