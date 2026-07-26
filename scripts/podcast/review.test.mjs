import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	parseReviewVtt,
	renderReviewWorksheet,
	runPodcastReview,
	validatePodcastReviewSource,
	verifyPodcastReviewSources,
} from "./review.mjs";

function digest(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function createFixture(t) {
	const repositoryRoot = await mkdtemp(
		path.join(os.tmpdir(), "podcast-review-"),
	);
	t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
	const files = {
		audio: Buffer.from("fixed-audio-bytes"),
		text: Buffer.from(" Alpha\n Beta\n"),
		vtt: Buffer.from(
			"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n Alpha\n\n00:00:01.500 --> 00:00:02.000\n Beta\n",
		),
		json: Buffer.from(
			JSON.stringify({
				transcription: [
					{ text: " Alpha", offsets: { from: 0, to: 1000 } },
					{ text: " Beta", offsets: { from: 1500, to: 2000 } },
				],
			}),
		),
	};
	const paths = {
		audio: "public/media/podcast/episode.mp3",
		text: ".podcast-import/episode/draft.txt",
		vtt: ".podcast-import/episode/draft.vtt",
		json: ".podcast-import/episode/draft.json",
	};
	for (const [name, relative] of Object.entries(paths)) {
		const absolute = path.join(repositoryRoot, ...relative.split("/"));
		await mkdir(path.dirname(absolute), { recursive: true });
		await writeFile(absolute, files[name]);
	}
	const fileContract = (name) => ({
		path: paths[name],
		byteLength: files[name].byteLength,
		sha256: digest(files[name]),
	});
	const source = {
		version: 1,
		episodeSlug: "modular-ethics",
		audio: { ...fileContract("audio"), durationSeconds: 3 },
		drafts: {
			text: fileContract("text"),
			vtt: fileContract("vtt"),
			json: fileContract("json"),
		},
		expectedTiming: {
			cueCount: 2,
			firstStartSeconds: 0,
			lastEndSeconds: 2,
			cueDurationSeconds: 1.5,
			interCueGapCount: 1,
			interCueGapSeconds: 0.5,
			trailingUncaptionedSeconds: 1,
		},
		outputPath: ".podcast-import/episode/review-worksheet.html",
	};
	const episode = {
		slug: source.episodeSlug,
		audio: {
			publicPath: "/media/podcast/episode.mp3",
			byteLength: source.audio.byteLength,
			sha256: source.audio.sha256,
			durationSeconds: source.audio.durationSeconds,
		},
	};
	return { repositoryRoot, source, episode, files, paths };
}

test("review evidence binds audio and all three machine drafts", async (t) => {
	const fixture = await createFixture(t);
	const evidence = await verifyPodcastReviewSources(fixture);
	assert.deepEqual(evidence.stats, fixture.source.expectedTiming);
	assert.equal(evidence.cues.length, 2);
	const result = await runPodcastReview(fixture);
	assert.equal(result.worksheet, null);
	assert.equal(result.publicationChanged, false);
	assert.equal(result.reviewApproved, false);
});

test("review source contracts reject unknown and approval-like fields", async (t) => {
	const { source } = await createFixture(t);
	const cases = [
		["root", (value) => (value.reviewed = true)],
		["audio", (value) => (value.audio.approval = "passed")],
		["drafts", (value) => (value.drafts.approved = true)],
		[
			"expected timing",
			(value) => (value.expectedTiming.reviewer = "Tai Song"),
		],
		["text draft", (value) => (value.drafts.text.reviewed = true)],
		["VTT draft", (value) => (value.drafts.vtt.notes = "looks accurate")],
		["JSON draft", (value) => (value.drafts.json.approval = "passed")],
	];
	for (const [label, mutate] of cases) {
		const candidate = structuredClone(source);
		mutate(candidate);
		assert.throws(
			() => validatePodcastReviewSource(candidate),
			/unknown or missing fields/u,
			label,
		);
	}
});

test("review VTT validation rejects overlap and out-of-range cues", () => {
	assert.throws(
		() =>
			parseReviewVtt(
				"WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOne\n\n00:00:01.000 --> 00:00:03.000\nTwo\n",
				4,
			),
		/overlaps/u,
	);
	assert.throws(
		() => parseReviewVtt("WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nOne\n", 4),
		/outside the audio duration/u,
	);
});

test("review evidence rejects stale hashes and disagreeing drafts", async (t) => {
	const stale = await createFixture(t);
	stale.source.drafts.text.sha256 = `sha256:${"f".repeat(64)}`;
	await assert.rejects(verifyPodcastReviewSources(stale), /SHA-256 changed/u);

	const disagreement = await createFixture(t);
	const jsonPath = path.join(
		disagreement.repositoryRoot,
		...disagreement.paths.json.split("/"),
	);
	disagreement.files.json = Buffer.from(
		JSON.stringify({
			transcription: [
				{ text: " Wrong", offsets: { from: 0, to: 1000 } },
				{ text: " Beta", offsets: { from: 1500, to: 2000 } },
			],
		}),
	);
	await writeFile(jsonPath, disagreement.files.json);
	disagreement.source.drafts.json.byteLength =
		disagreement.files.json.byteLength;
	disagreement.source.drafts.json.sha256 = digest(disagreement.files.json);
	await assert.rejects(
		verifyPodcastReviewSources(disagreement),
		/disagree at cue 1/u,
	);
});

test("worksheet is local-only, time-linked, and refuses overwrite", async (t) => {
	const fixture = await createFixture(t);
	const evidence = await verifyPodcastReviewSources(fixture);
	const html = renderReviewWorksheet(evidence, fixture.repositoryRoot);
	assert.match(html, /data-start="0"/u);
	assert.match(html, /id="gap-001"/u);
	assert.match(html, /00:00:01\.000 to 00:00:01\.500/u);
	assert.match(html, /id="trailing-audio-review"/u);
	assert.match(html, /00:00:02\.000 to 00:00:03\.000/u);
	assert.match(html, /Checking boxes does not save, approve, publish/u);
	assert.doesNotMatch(html, /https?:\/\//u);

	const result = await runPodcastReview({ ...fixture, write: true });
	assert.equal(result.publicationChanged, false);
	assert.equal(result.reviewApproved, false);
	assert.match(
		await readFile(result.worksheet, "utf8"),
		/\.\.\/\.\.\/public\/media\/podcast\/episode\.mp3/u,
	);
	await assert.rejects(
		runPodcastReview({ ...fixture, write: true }),
		/already exists/u,
	);
});
