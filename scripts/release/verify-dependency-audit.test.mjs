import assert from "node:assert/strict";
import test from "node:test";
import {
	assertReleaseAudit,
	summarizeAudit,
} from "./verify-dependency-audit.mjs";

test("accepts a v2 audit with no high or critical findings", () => {
	const summary = summarizeAudit({
		auditReportVersion: 2,
		vulnerabilities: {
			minor: {
				name: "minor",
				severity: "moderate",
				via: [{ title: "Example advisory", url: "https://example.invalid/1" }],
				nodes: ["node_modules/minor"],
				fixAvailable: true,
			},
		},
		metadata: {
			vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
		},
	});

	assert.equal(summary.counts.moderate, 1);
	assert.equal(summary.findings[0].paths[0], "minor");
	assert.doesNotThrow(() => assertReleaseAudit(summary));
});

test("rejects blocking counts even when the advisory body is absent", () => {
	const summary = summarizeAudit({
		metadata: {
			vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
		},
		vulnerabilities: {},
	});

	assert.throws(() => assertReleaseAudit(summary), /1 high/);
});

test("supports the legacy pnpm advisory shape", () => {
	const summary = summarizeAudit({
		advisories: {
			42: {
				module_name: "legacy-package",
				severity: "low",
				title: "Legacy example",
				patched_versions: ">=2.0.0",
				findings: [{ paths: ["root>legacy-package"] }],
			},
		},
		metadata: {
			vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 },
		},
	});

	assert.equal(summary.counts.low, 1);
	assert.equal(summary.findings[0].package, "legacy-package");
});

test("fails closed on registry errors or incomplete reports", () => {
	assert.throws(
		() => summarizeAudit({ error: { summary: "registry unavailable" } }),
		/audit error/,
	);
	assert.throws(
		() => summarizeAudit({ auditReportVersion: 2, vulnerabilities: {} }),
		/missing vulnerability totals/,
	);
});
