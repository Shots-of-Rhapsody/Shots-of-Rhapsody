import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PODCAST_EPISODES } from "../../src/data/podcast.ts";
import reviewSourceJson from "./review-source.v1.json" with { type: "json" };

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(
	new URL("../../", import.meta.url),
);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TIMING_PATTERN =
	/^(\d{2}):(\d{2}):(\d{2}\.\d{3}) --> (\d{2}):(\d{2}):(\d{2}\.\d{3})$/u;
const ROOT_KEYS = [
	"audio",
	"drafts",
	"episodeSlug",
	"expectedTiming",
	"outputPath",
	"version",
];
const AUDIO_KEYS = ["byteLength", "durationSeconds", "path", "sha256"];
const DRAFTS_KEYS = ["json", "text", "vtt"];
const FILE_KEYS = ["byteLength", "path", "sha256"];
const EXPECTED_TIMING_KEYS = [
	"cueCount",
	"cueDurationSeconds",
	"firstStartSeconds",
	"interCueGapCount",
	"interCueGapSeconds",
	"lastEndSeconds",
	"trailingUncaptionedSeconds",
];

function sha256(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function roundMillis(value) {
	return Math.round(value * 1000) / 1000;
}

function seconds(hours, minutes, secondsAndMillis) {
	return Number(hours) * 3600 + Number(minutes) * 60 + Number(secondsAndMillis);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function isPlainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
	return (
		Object.keys(value).toSorted().join("\0") === expected.toSorted().join("\0")
	);
}

function assertExactRecord(value, expected, label) {
	if (!isPlainRecord(value) || !hasExactKeys(value, expected))
		throw new Error(`${label} contains unknown or missing fields`);
	return value;
}

function assertLocalReviewPath(repositoryRoot, filePath, label) {
	const absolute = path.resolve(repositoryRoot, filePath);
	const localRoot = path.resolve(repositoryRoot, ".podcast-import");
	const relative = path.relative(localRoot, absolute);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`${label} must remain inside .podcast-import`);
	}
	return absolute;
}

function validateFileContract(
	contract,
	label,
	{ localOnly = false, expectedKeys = FILE_KEYS } = {},
) {
	assertExactRecord(contract, expectedKeys, label);
	if (
		typeof contract.path !== "string" ||
		contract.path.length === 0 ||
		!Number.isInteger(contract.byteLength) ||
		contract.byteLength <= 0 ||
		typeof contract.sha256 !== "string" ||
		!SHA256_PATTERN.test(contract.sha256)
	) {
		throw new Error(`${label} contract is malformed`);
	}
	if (
		path.isAbsolute(contract.path) ||
		contract.path.includes("\\") ||
		contract.path.split("/").some((segment) => segment === "..")
	) {
		throw new Error(`${label} path is malformed`);
	}
	if (localOnly && !contract.path.startsWith(".podcast-import/"))
		throw new Error(`${label} must remain local-only`);
	return contract;
}

export function validatePodcastReviewSource(value) {
	assertExactRecord(value, ROOT_KEYS, "Podcast review source contract");
	assertExactRecord(value.audio, AUDIO_KEYS, "Podcast review audio");
	assertExactRecord(value.drafts, DRAFTS_KEYS, "Podcast review drafts");
	assertExactRecord(
		value.expectedTiming,
		EXPECTED_TIMING_KEYS,
		"Podcast expected timing",
	);
	if (
		value.version !== 1 ||
		value.episodeSlug !== "modular-ethics" ||
		!Number.isFinite(value.audio.durationSeconds) ||
		value.audio.durationSeconds <= 0 ||
		typeof value.outputPath !== "string" ||
		!value.outputPath.startsWith(".podcast-import/") ||
		path.isAbsolute(value.outputPath) ||
		value.outputPath.includes("\\") ||
		value.outputPath.split("/").some((segment) => segment === "..")
	) {
		throw new Error("Podcast review source contract is malformed");
	}
	validateFileContract(value.audio, "Podcast review audio", {
		expectedKeys: AUDIO_KEYS,
	});
	for (const name of ["text", "vtt", "json"])
		validateFileContract(value.drafts[name], `Podcast ${name} draft`, {
			localOnly: true,
		});
	for (const field of [
		"cueCount",
		"firstStartSeconds",
		"lastEndSeconds",
		"cueDurationSeconds",
		"interCueGapCount",
		"interCueGapSeconds",
		"trailingUncaptionedSeconds",
	]) {
		if (!Number.isFinite(value.expectedTiming[field]))
			throw new Error(`Podcast expected timing is malformed: ${field}`);
	}
	return value;
}

async function readBoundFile(repositoryRoot, contract, label, { localOnly }) {
	const absolute = localOnly
		? assertLocalReviewPath(repositoryRoot, contract.path, label)
		: path.resolve(repositoryRoot, contract.path);
	const bytes = await readFile(absolute);
	if (bytes.byteLength !== contract.byteLength)
		throw new Error(`${label} byte length changed`);
	if (sha256(bytes) !== contract.sha256)
		throw new Error(`${label} SHA-256 changed`);
	return { absolute, bytes };
}

export function parseReviewVtt(source, durationSeconds) {
	const normalized = source.replaceAll("\r\n", "\n");
	const blocks = normalized.trimEnd().split(/\n{2,}/u);
	if (blocks.shift()?.trim() !== "WEBVTT")
		throw new Error("Podcast transcript draft is not a plain WEBVTT file");
	const cues = blocks.map((block, index) => {
		const lines = block.split("\n");
		const match = TIMING_PATTERN.exec(lines[0] ?? "");
		if (!match)
			throw new Error(
				`Podcast transcript cue ${index + 1} timing is malformed`,
			);
		if (
			Number(match[2]) > 59 ||
			Number(match[3]) >= 60 ||
			Number(match[5]) > 59 ||
			Number(match[6]) >= 60
		) {
			throw new Error(
				`Podcast transcript cue ${index + 1} timing is malformed`,
			);
		}
		const start = seconds(match[1], match[2], match[3]);
		const end = seconds(match[4], match[5], match[6]);
		const text = lines.slice(1).join("\n");
		if (text.trim().length === 0)
			throw new Error(`Podcast transcript cue ${index + 1} is empty`);
		if (start < 0 || end <= start || end > durationSeconds)
			throw new Error(
				`Podcast transcript cue ${index + 1} is outside the audio duration`,
			);
		return { index: index + 1, start, end, timestamp: lines[0], text };
	});
	if (cues.length === 0)
		throw new Error("Podcast transcript draft has no cues");

	const gaps = [];
	for (let index = 1; index < cues.length; index += 1) {
		const previous = cues[index - 1];
		const cue = cues[index];
		if (cue.start < previous.start)
			throw new Error(`Podcast transcript cue ${cue.index} is not monotonic`);
		if (cue.start < previous.end)
			throw new Error(
				`Podcast transcript cue ${cue.index} overlaps its predecessor`,
			);
		if (cue.start > previous.end) {
			gaps.push({
				start: previous.end,
				end: cue.start,
				duration: roundMillis(cue.start - previous.end),
			});
		}
	}
	const cueDurationSeconds = roundMillis(
		cues.reduce((total, cue) => total + cue.end - cue.start, 0),
	);
	const interCueGapSeconds = roundMillis(
		gaps.reduce((total, gap) => total + gap.duration, 0),
	);
	return {
		cues,
		gaps,
		stats: {
			cueCount: cues.length,
			firstStartSeconds: cues[0].start,
			lastEndSeconds: cues.at(-1).end,
			cueDurationSeconds,
			interCueGapCount: gaps.length,
			interCueGapSeconds,
			trailingUncaptionedSeconds: roundMillis(
				durationSeconds - cues.at(-1).end,
			),
		},
	};
}

function assertExpectedTiming(actual, expected) {
	for (const field of Object.keys(expected)) {
		if (actual[field] !== expected[field])
			throw new Error(
				`Podcast transcript timing changed: ${field} expected ${expected[field]}, received ${actual[field]}`,
			);
	}
}

function assertDraftsAgree(textSource, parsedVtt, jsonSource) {
	const canonicalText = textSource.replaceAll("\r\n", "\n").replace(/\n$/u, "");
	const cueText = parsedVtt.cues.map((cue) => cue.text).join("\n");
	if (canonicalText !== cueText)
		throw new Error("Podcast TXT and VTT drafts disagree");
	let parsedJson;
	try {
		parsedJson = JSON.parse(jsonSource);
	} catch {
		throw new Error("Podcast JSON draft is malformed");
	}
	if (
		!Array.isArray(parsedJson.transcription) ||
		parsedJson.transcription.length !== parsedVtt.cues.length
	) {
		throw new Error("Podcast JSON and VTT cue counts disagree");
	}
	for (const [index, cue] of parsedVtt.cues.entries()) {
		const segment = parsedJson.transcription[index];
		if (
			segment?.text !== cue.text ||
			segment?.offsets?.from !== Math.round(cue.start * 1000) ||
			segment?.offsets?.to !== Math.round(cue.end * 1000)
		) {
			throw new Error(`Podcast JSON and VTT disagree at cue ${cue.index}`);
		}
	}
}

export async function verifyPodcastReviewSources({
	repositoryRoot = DEFAULT_REPOSITORY_ROOT,
	source = reviewSourceJson,
	episode = PODCAST_EPISODES[0],
} = {}) {
	const contract = validatePodcastReviewSource(source);
	if (
		contract.episodeSlug !== episode?.slug ||
		contract.audio.path !== `public${episode.audio.publicPath}` ||
		contract.audio.byteLength !== episode.audio.byteLength ||
		contract.audio.sha256 !== episode.audio.sha256 ||
		contract.audio.durationSeconds !== episode.audio.durationSeconds
	) {
		throw new Error("Podcast review audio differs from the tracked manifest");
	}
	const audio = await readBoundFile(
		repositoryRoot,
		contract.audio,
		"Podcast review audio",
		{ localOnly: false },
	);
	const drafts = {};
	for (const name of ["text", "vtt", "json"]) {
		drafts[name] = await readBoundFile(
			repositoryRoot,
			contract.drafts[name],
			`Podcast ${name} draft`,
			{ localOnly: true },
		);
	}
	const parsedVtt = parseReviewVtt(
		drafts.vtt.bytes.toString("utf8"),
		contract.audio.durationSeconds,
	);
	assertExpectedTiming(parsedVtt.stats, contract.expectedTiming);
	assertDraftsAgree(
		drafts.text.bytes.toString("utf8"),
		parsedVtt,
		drafts.json.bytes.toString("utf8"),
	);
	return { contract, audio, drafts, ...parsedVtt };
}

export function renderReviewWorksheet(evidence, repositoryRoot) {
	const output = path.resolve(repositoryRoot, evidence.contract.outputPath);
	const audioRelative = path
		.relative(path.dirname(output), evidence.audio.absolute)
		.replaceAll(path.sep, "/");
	const cues = evidence.cues
		.map(
			(cue) => `<li id="cue-${String(cue.index).padStart(3, "0")}">
	<button type="button" data-start="${cue.start}">${escapeHtml(cue.timestamp)}</button>
	<p>${escapeHtml(cue.text)}</p>
	<label><input type="checkbox" /> Manually checked against the exact MP3</label>
</li>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Episode 1 transcript review worksheet</title>
	<style>
		:root { color-scheme: light dark; font: 16px/1.6 system-ui, sans-serif; }
		body { width: min(100% - 2rem, 72rem); margin: 2rem auto; }
		audio { position: sticky; top: 0; z-index: 1; width: 100%; padding-block: .75rem; background: Canvas; }
		.warning { padding: 1rem; border: 2px solid #a33; }
		li { margin-block: 1.5rem; padding-block-end: 1.5rem; border-bottom: 1px solid GrayText; }
		button { min-height: 44px; padding: .5rem .75rem; font: inherit; }
		p { max-width: 72ch; }
	</style>
</head>
<body>
	<h1>Episode 1 transcript review worksheet</h1>
	<p class="warning"><strong>Local review evidence only.</strong> Checking boxes does not save, approve, publish, or change any signoff.</p>
	<p>Audio SHA-256: <code>${escapeHtml(evidence.contract.audio.sha256)}</code></p>
	<p>${evidence.stats.cueCount} machine cues; ${evidence.stats.trailingUncaptionedSeconds.toFixed(3)} seconds after the final cue require listening review.</p>
	<audio id="review-audio" controls preload="metadata" src="${escapeHtml(audioRelative)}"></audio>
	<ol>${cues}</ol>
	<script>
		const audio = document.querySelector("#review-audio");
		document.addEventListener("click", (event) => {
			const button = event.target.closest("button[data-start]");
			if (!button || !audio) return;
			audio.currentTime = Number(button.dataset.start);
			audio.focus();
		});
	</script>
</body>
</html>
`;
}

export async function runPodcastReview({
	repositoryRoot = DEFAULT_REPOSITORY_ROOT,
	write = false,
	source = reviewSourceJson,
	episode = PODCAST_EPISODES[0],
} = {}) {
	const evidence = await verifyPodcastReviewSources({
		repositoryRoot,
		source,
		episode,
	});
	const output = assertLocalReviewPath(
		repositoryRoot,
		evidence.contract.outputPath,
		"Podcast review worksheet",
	);
	if (write) {
		await mkdir(path.dirname(output), { recursive: true });
		try {
			await writeFile(output, renderReviewWorksheet(evidence, repositoryRoot), {
				encoding: "utf8",
				flag: "wx",
			});
		} catch (error) {
			if (error && typeof error === "object" && error.code === "EEXIST")
				throw new Error(`Podcast review worksheet already exists: ${output}`);
			throw error;
		}
	}
	return {
		episode: evidence.contract.episodeSlug,
		audioSha256: evidence.contract.audio.sha256,
		draftSha256: Object.fromEntries(
			Object.entries(evidence.contract.drafts).map(([name, draft]) => [
				name,
				draft.sha256,
			]),
		),
		timing: evidence.stats,
		worksheet: write ? output : null,
		publicationChanged: false,
		reviewApproved: false,
	};
}

function parseArguments(argv) {
	const unsupported = argv.filter(
		(argument) => argument !== "--write" && argument !== "--dry-run",
	);
	if (unsupported.length > 0)
		throw new Error(`Unknown podcast review option: ${unsupported[0]}`);
	if (argv.includes("--write") && argv.includes("--dry-run"))
		throw new Error("Choose either --write or --dry-run");
	return { write: argv.includes("--write") };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try {
		const result = await runPodcastReview(
			parseArguments(process.argv.slice(2)),
		);
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
