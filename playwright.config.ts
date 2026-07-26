import { defineConfig, devices } from "@playwright/test";
import {
	hasExternalPlaywrightBaseURL,
	playwrightBaseURL,
	playwrightPort,
} from "./tests/e2e/base-url";

// Playwright otherwise writes an automatic accessibility snapshot of the page
// to error-context.md on failure, even when screenshots and traces are off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

// Local runs own a dedicated preview process. A deliberate PLAYWRIGHT_BASE_URL
// targets an already-deployed site and disables the local web server.
export default defineConfig({
	testDir: "./tests/e2e",
	outputDir: "test-results",
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: "list",
	use: {
		baseURL: playwrightBaseURL,
		// Failure artifacts can preserve page content before the privacy assertions
		// have had a chance to stop the test. Release screenshots are captured
		// explicitly only after the privacy-safe state check passes.
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	webServer: hasExternalPlaywrightBaseURL
		? undefined
		: {
				command: `pnpm preview --host 127.0.0.1 --port ${playwrightPort}`,
				url: playwrightBaseURL,
				reuseExistingServer: false,
				timeout: 120_000,
			},
	projects: [
		{
			name: "desktop-chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 1000 },
			},
		},
		{
			name: "mobile-chromium",
			use: { ...devices["Pixel 5"], viewport: { width: 360, height: 800 } },
		},
	],
});
