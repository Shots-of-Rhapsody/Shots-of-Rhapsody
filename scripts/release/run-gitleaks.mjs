import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "8.30.1";
const RELEASE = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}`;
export const GITLEAKS_CONFIG = [
	'title = "Shots of Rhapsody pinned Gitleaks defaults"',
	"",
	"[extend]",
	"useDefault = true",
	"",
].join("\n");
export const GITLEAKS_CONFIG_SHA256 =
	"938e63613316df90d0bccebd6a9353b480a62ab79d4e07a7a861a6b7191e141e";
const ARCHIVES = {
	"linux-x64": {
		name: `gitleaks_${VERSION}_linux_x64.tar.gz`,
		sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
	},
	"win32-x64": {
		name: `gitleaks_${VERSION}_windows_x64.zip`,
		sha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
	},
};

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: options.stdio ?? "pipe",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (
		!options.allowedExitCodes?.includes(result.status) &&
		result.status !== 0
	) {
		if (options.redactFailure) {
			throw new Error(`${command} failed (${result.status})`);
		}
		throw new Error(
			`${command} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
		);
	}
	return result;
}

export function isolatedGitleaksEnvironment(environment = process.env) {
	const isolated = { ...environment };
	delete isolated.GITLEAKS_CONFIG;
	delete isolated.GITLEAKS_CONFIG_TOML;
	return isolated;
}

export function createScanArguments({
	configPath,
	ignorePath,
	reportPath,
	source,
}) {
	return [
		"git",
		"--redact=100",
		"--report-format=json",
		`--report-path=${reportPath}`,
		"--log-opts=--all",
		`--config=${configPath}`,
		`--gitleaks-ignore-path=${ignorePath}`,
		source,
	];
}

export async function sanitizeGitleaksReport(source, destination) {
	const parsed = JSON.parse(await readFile(source, "utf8"));
	if (!Array.isArray(parsed)) {
		throw new Error("Gitleaks report must be a JSON array");
	}
	const sanitized = parsed.map((finding) => ({
		RuleID:
			typeof finding.RuleID === "string" && finding.RuleID
				? finding.RuleID
				: "unclassified",
		File: "redacted",
		Commit:
			typeof finding.Commit === "string" &&
			/^[0-9a-f]{40}$/.test(finding.Commit)
				? finding.Commit
				: null,
		StartLine: Number.isSafeInteger(finding.StartLine)
			? finding.StartLine
			: null,
		EndLine: Number.isSafeInteger(finding.EndLine) ? finding.EndLine : null,
	}));
	await writeFile(
		destination,
		`${JSON.stringify(sanitized, null, 2)}\n`,
		"utf8",
	);
	return sanitized;
}

function parseArguments(argv) {
	const options = { cwd: process.cwd(), report: null };
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--cwd") options.cwd = path.resolve(argv[++index]);
		else if (argv[index] === "--report")
			options.report = path.resolve(argv[++index]);
		else throw new Error(`Unknown argument: ${argv[index]}`);
	}
	if (!options.report) {
		throw new Error(
			"Usage: node run-gitleaks.mjs --report <redacted-report.json> [--cwd <repository>]",
		);
	}
	return options;
}

async function download(url) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`Download failed: ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

function assertChecksum(buffer, expected) {
	const actual = createHash("sha256").update(buffer).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`Gitleaks archive checksum mismatch: expected ${expected}, received ${actual}`,
		);
	}
}

async function extract(archivePath, destination, platform) {
	if (platform === "win32") {
		run("pwsh", [
			"-NoProfile",
			"-Command",
			"& { param($archivePath, $destinationPath) Expand-Archive -LiteralPath $archivePath -DestinationPath $destinationPath }",
			archivePath,
			destination,
		]);
		return path.join(destination, "gitleaks.exe");
	}
	run("tar", ["-xzf", archivePath, "-C", destination]);
	const binary = path.join(destination, "gitleaks");
	await chmod(binary, 0o755);
	return binary;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const key = `${process.platform}-${process.arch}`;
	const archive = ARCHIVES[key];
	if (!archive) throw new Error(`Unsupported Gitleaks platform: ${key}`);

	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "shots-gitleaks-"));
	try {
		const buffer = await download(`${RELEASE}/${archive.name}`);
		assertChecksum(buffer, archive.sha256);
		const archivePath = path.join(tempRoot, archive.name);
		await writeFile(archivePath, buffer);
		const binary = await extract(archivePath, tempRoot, process.platform);
		const version = run(binary, ["version"]).stdout.trim();
		console.log(`Verified ${version}; archive SHA-256 ${archive.sha256}.`);
		const rawReport = path.join(tempRoot, "gitleaks-raw.json");
		const configPath = path.join(tempRoot, "gitleaks.toml");
		const ignorePath = path.join(tempRoot, ".gitleaksignore");
		const configSha256 = createHash("sha256")
			.update(GITLEAKS_CONFIG)
			.digest("hex");
		if (configSha256 !== GITLEAKS_CONFIG_SHA256) {
			throw new Error("Embedded Gitleaks configuration checksum mismatch");
		}
		await writeFile(configPath, GITLEAKS_CONFIG, "utf8");
		await writeFile(ignorePath, "", "utf8");
		console.log(
			`Gitleaks configuration SHA-256 ${GITLEAKS_CONFIG_SHA256}; repository and environment overrides disabled.`,
		);

		const scan = run(
			binary,
			createScanArguments({
				configPath,
				ignorePath,
				reportPath: rawReport,
				source: options.cwd,
			}),
			{
				cwd: options.cwd,
				env: isolatedGitleaksEnvironment(),
				allowedExitCodes: [1],
				redactFailure: true,
			},
		);
		await sanitizeGitleaksReport(rawReport, options.report);
		if (scan.status === 1) {
			console.error(
				"Gitleaks reported one or more redacted findings; keep the repository private pending review.",
			);
			process.exitCode = 1;
		} else {
			console.log("Gitleaks found no secrets in reachable Git history.");
		}
	} finally {
		const resolvedTemp = path.resolve(tempRoot);
		const resolvedOsTemp = path.resolve(os.tmpdir());
		if (
			resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}shots-gitleaks-`)
		) {
			await rm(resolvedTemp, { recursive: true, force: true });
		}
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
