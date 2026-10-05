import { defineConfig, devices } from "@playwright/test";

const appOrigin = `http://127.0.0.1:${process.env.HOLOBOARD_TEST_PORT ?? "4173"}`;

export default defineConfig({
    testDir: "./tests",
    timeout: 45000,
    use: { baseURL: appOrigin, trace: "retain-on-failure" },
    projects: [
        { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
        { name: "android", use: { ...devices["Pixel 7"], channel: "chrome" } },
        { name: "iphone", use: { ...devices["iPhone 13"], browserName: "webkit" } },
    ],
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${process.env.HOLOBOARD_TEST_PORT ?? "4173"} --strictPort`,
        url: appOrigin, reuseExistingServer: !process.env.CI,
        env: { VITE_RELAY_URL: "ws://127.0.0.1:3334", VITE_API_URL: "http://127.0.0.1:3334", VITE_PUBLIC_RELAYS: "ws://127.0.0.1:3334", VITE_SATS_ENDPOINT: "http://127.0.0.1:3334/api/board" },
    },
});
