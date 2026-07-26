import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const LEVELS = ["info", "low", "moderate", "high", "critical"];

function emptyCounts() {
	return Object.fromEntries(LEVELS.map((level) => [level, 0]));
}

function normalizeSeverity(value) {
	const severity = String(value ?? "").toLowerCase();
	return LEVELS.includes(severity) ? severity : "info";
}

function normalizePath(value) {
	return String(value ?? "")
		.replaceAll("\\", "/")
		.replace(/^node_modules\//, "")
		.trim();
}

function summarizeLegacyAdvisories(report) {
	const findings = [];
	for (const advisory of Object.values(report.advisories ?? {})) {
		const paths = new Set();
		for (const finding of advisory.findings ?? []) {
			for (const item of finding.paths ?? []) paths.add(normalizePath(item));
		}
		findings.push({
			package: advisory.module_name ?? advisory.name ?? "unknown",
			severity: normalizeSeverity(advisory.severity),
			title: advisory.title ?? "Unnamed advisory",
			url: advisory.url ?? null,
			paths: [...paths].filter(Boolean).sort(),
			fixAvailable: advisory.patched_versions ?? null,
		});
	}
	return findings;
}

function summarizeV2Vulnerabilities(report) {
	const findings = [];
	for (const [name, vulnerability] of Object.entries(
		report.vulnerabilities ?? {},
	)) {
		const advisory = (vulnerability.via ?? []).find(
			(item) => typeof item === "object" && item !== null,
		);
		findings.push({
			package: vulnerability.name ?? name,
			severity: normalizeSeverity(vulnerability.severity),
			title: advisory?.title ?? "Transitive vulnerability",
			url: advisory?.url ?? null,
			paths: (vulnerability.nodes ?? [])
				.map(normalizePath)
				.filter(Boolean)
				.sort(),
			fixAvailable: vulnerability.fixAvailable ?? null,
		});
	}
	return findings;
}

export function summarizeAudit(report) {
	if (!report || typeof report !== "object" || Array.isArray(report)) {
		throw new TypeError("Audit output must be a JSON object");
	}
	if (report.error) throw new Error("Package registry returned an audit error");
	if (
		!("advisories" in report) &&
		!("vulnerabilities" in report) &&
		report.auditReportVersion === undefined
	) {
		throw new Error("Unrecognized pnpm audit report shape");
	}
	if (!report.metadata?.vulnerabilities) {
		throw new Error("Audit report is missing vulnerability totals");
	}

	const findings = report.advisories
		? summarizeLegacyAdvisories(report)
		: summarizeV2Vulnerabilities(report);
	const derivedCounts = emptyCounts();
	for (const finding of findings) derivedCounts[finding.severity] += 1;

	const metadataCounts = report.metadata?.vulnerabilities;
	const counts = emptyCounts();
	for (const level of LEVELS) {
		const value = metadataCounts?.[level];
		counts[level] = Number.isInteger(value) ? value : derivedCounts[level];
	}

	return {
		counts,
		findings: findings.sort((left, right) => {
			const severity =
				LEVELS.indexOf(right.severity) - LEVELS.indexOf(left.severity);
			return severity || left.package.localeCompare(right.package);
		}),
	};
}

export function assertReleaseAudit(summary) {
	const blocking = summary.counts.critical + summary.counts.high;
	if (blocking > 0) {
		throw new Error(
			`Dependency launch gate failed: ${summary.counts.critical} critical and ${summary.counts.high} high advisories remain`,
		);
	}
	return summary;
}

function formatFinding(finding) {
	const path = finding.paths[0] || "path unavailable";
	const extraPaths = Math.max(0, finding.paths.length - 1);
	const fix =
		typeof finding.fixAvailable === "string"
			? finding.fixAvailable
			: finding.fixAvailable
				? "available"
				: "not reported";
	return `- ${finding.severity}: ${finding.package} — ${finding.title}; path: ${path}${extraPaths ? ` (+${extraPaths} more)` : ""}; fix: ${fix}${finding.url ? `; ${finding.url}` : ""}`;
}

async function main() {
	const file = process.argv[2];
	if (!file)
		throw new Error("Usage: node verify-dependency-audit.mjs <audit.json>");
	const report = JSON.parse(await readFile(file, "utf8"));
	const summary = summarizeAudit(report);
	console.log(
		`Dependency audit: ${summary.counts.critical} critical, ${summary.counts.high} high, ${summary.counts.moderate} moderate, ${summary.counts.low} low`,
	);
	const nonBlocking = summary.findings.filter(({ severity }) =>
		["moderate", "low"].includes(severity),
	);
	if (nonBlocking.length > 0) {
		console.log("Moderate/low findings requiring PR disposition:");
		for (const finding of nonBlocking) console.log(formatFinding(finding));
	}
	assertReleaseAudit(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
