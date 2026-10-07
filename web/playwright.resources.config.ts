import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const port = process.env.HOLOBOARD_TEST_PORT ?? "4196";
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
    ...base,
    testMatch: "**/discussionResources.spec.ts",
    timeout: 180000,
    workers: 1,
    use: { ...base.use, baseURL: origin },
    webServer: {
        command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: origin,
        reuseExistingServer: false,
    },
});
