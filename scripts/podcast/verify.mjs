import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serializeOuter } from "parse5";
import sharp from "sharp";
import {
	assertPodcastManifest,
	getPodcastPublicationBlockers,
	getPublishablePodcastEpisodes,
	PODCAST_EPISODES,
	PODCAST_SHOW,
} from "../../src/data/podcast.ts";
import { assertPodcastContentSignoff } from "../../src/data/podcast-approval.ts";
import { canonicalTranscriptHtml } from "../../src/utils/podcast-transcript.mjs";
import { verifyPresentationSignoffV2 } from "../content/presentation.js";
import { validateContentSignoffsV2 } from "../content/signoffs.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const trackedAudioPath = path.join(
	repositoryRoot,
	"public",
	"media",
	"podcast",
	"episode-001-modular-ethics.mp3",
);
const retiredLegacyAudioPath = path.join(
	repositoryRoot,
	"legacy",
	"podcast",
	"Podcast Ep 1.mp3",
);
const coverSourcePath = path.join(
	repositoryRoot,
	...PODCAST_SHOW.artwork.sourcePath.split("/"),
);
const coverPngPath = path.join(
	repositoryRoot,
	...PODCAST_SHOW.artwork.archivePath.split("/"),
);
const contentSignoffsPath = path.join(
	repositoryRoot,
	"provenance",
	"reviews",
	"content-signoffs-v2.json",
);
const presentationSignoffsPath = path.join(
	repositoryRoot,
	"provenance",
	"reviews",
	"presentation-signoffs-v2.json",
);
const releaseTargetPath = path.join(
	repositoryRoot,
	"provenance",
	"release-target.json",
);

function sha256(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function exists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT")
			return false;
		throw error;
	}
}

async function readPodcastReleaseTarget() {
	const target = JSON.parse(await readFile(releaseTargetPath, "utf8"));
	const expectedEpisodes = target?.expected?.podcastEpisodes;
	if (
		target?.schemaVersion !== 3 ||
		target?.release !== "v1.0.0" ||
		!Number.isInteger(expectedEpisodes) ||
		expectedEpisodes < 0 ||
		expectedEpisodes > 1
	) {
		throw new Error("Podcast release target is invalid");
	}
	return { release: target.release, expectedEpisodes };
}

async function findFiles(directory, extension) {
	if (!(await exists(directory))) return [];
	const matches = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory())
			matches.push(...(await findFiles(entryPath, extension)));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension))
			matches.push(entryPath);
	}
	return matches;
}

function findElement(node, attributeName) {
	if (node?.attrs?.some((attribute) => attribute.name === attributeName))
		return node;
	for (const child of node?.childNodes ?? []) {
		const match = findElement(child, attributeName);
		if (match) return match;
	}
	return null;
}

function publicFilePath(publicPath) {
	return path.join(
		repositoryRoot,
		"public",
		...publicPath.split("/").filter(Boolean),
	);
}

function builtFilePath(publicPath) {
	return path.join(
		repositoryRoot,
		"dist",
		...publicPath.split("/").filter(Boolean),
	);
}

function builtRoutePath(publicPath) {
	return path.join(
		repositoryRoot,
		"dist",
		...publicPath.split("/").filter(Boolean),
		"index.html",
	);
}

async function verifyTrackedPodcastEvidence() {
	assertPodcastManifest();
	if (PODCAST_EPISODES.length !== 1)
		throw new Error("Podcast verifier expects exactly one tracked episode");

	const episode = PODCAST_EPISODES[0];
	if (await exists(retiredLegacyAudioPath))
		throw new Error("Podcast audio is duplicated at its retired legacy path");
	const audioBytes = await readFile(trackedAudioPath);
	const audioStats = await stat(trackedAudioPath);
	const audioHash = sha256(audioBytes);
	if (audioStats.size !== episode.audio.byteLength)
		throw new Error("Tracked podcast byte length changed");
	if (audioHash !== episode.audio.sha256)
		throw new Error("Tracked podcast SHA-256 changed");
	const beginsWithId3 = audioBytes.subarray(0, 3).toString("ascii") === "ID3";
	const beginsWithFrameSync =
		audioBytes[0] === 0xff && (audioBytes[1] & 0xe0) === 0xe0;
	if (!beginsWithId3 && !beginsWithFrameSync)
		throw new Error("Tracked podcast does not have a recognizable MP3 prefix");

	const coverHash = sha256(await readFile(coverSourcePath));
	if (coverHash !== PODCAST_SHOW.artwork.sourceSha256)
		throw new Error("Podcast cover source SHA-256 changed");
	const coverPng = await readFile(coverPngPath);
	const coverPngHash = sha256(coverPng);
	if (coverPngHash !== PODCAST_SHOW.artwork.sha256)
		throw new Error("Podcast cover PNG SHA-256 changed");
	const coverMetadata = await sharp(coverPng).metadata();
	if (
		coverMetadata.format !== "png" ||
		coverMetadata.width !== 3000 ||
		coverMetadata.height !== 3000 ||
		coverMetadata.hasAlpha === true ||
		coverMetadata.space !== "srgb"
	) {
		throw new Error("Podcast cover must be an opaque sRGB 3000 by 3000 PNG");
	}
	if (
		episode.audio.durationSeconds !== 1445.784 ||
		episode.audio.sampleRateHz !== 48_000 ||
		episode.audio.channels !== 2 ||
		episode.audio.bitrateBps !== 320_000 ||
		episode.audio.codec !== "MPEG-1 Layer III" ||
		episode.audio.channelMode !== "Joint stereo" ||
		episode.audio.duration !== "00:24:05.784" ||
		episode.audio.loudnessLkfs !== -27 ||
		episode.audio.truePeakDbfs !== -6.9
	) {
		throw new Error("Podcast audio measurements differ from verified evidence");
	}
	return {
		episode,
		audioStats,
		audioHash,
		coverHash,
		coverPngHash,
		coverPng,
	};
}

export async function verifyPodcastDraft({ withBuilt = false } = {}) {
	const { episode, audioStats, audioHash, coverHash, coverPngHash } =
		await verifyTrackedPodcastEvidence();

	const blockers = getPodcastPublicationBlockers(episode);
	if (getPublishablePodcastEpisodes().length !== 0)
		throw new Error("Podcast draft unexpectedly became publishable");

	if (withBuilt) {
		const builtAudioPath = builtFilePath(episode.audio.publicPath);
		const builtEpisodePath = path.join(
			repositoryRoot,
			"dist",
			"podcast",
			episode.slug,
			"index.html",
		);
		for (const [builtPath, label] of [
			[builtAudioPath, "audio"],
			[builtEpisodePath, "episode route"],
			[
				path.join(repositoryRoot, "dist", "podcast", "index.html"),
				"index route",
			],
			[builtFilePath(PODCAST_SHOW.artwork.publicPath), "cover"],
		]) {
			if (await exists(builtPath))
				throw new Error(`Draft podcast ${label} leaked into the built site`);
		}
		const exposedAudio = await findFiles(
			path.join(repositoryRoot, "dist"),
			".mp3",
		);
		if (exposedAudio.length > 0)
			throw new Error(
				`Draft MP3 files leaked into publication assets: ${exposedAudio
					.map((file) => path.relative(repositoryRoot, file))
					.join(", ")}`,
			);
	}

	return {
		episode: episode.slug,
		audioBytes: audioStats.size,
		audioSha256: audioHash,
		coverSourceSha256: coverHash,
		coverPngSha256: coverPngHash,
		publicationBlockers: blockers,
		publishableEpisodes: 0,
		episodes: 0,
		builtArtifactsChecked: withBuilt,
		complete: true,
	};
}

export async function verifyPodcastRelease({
	withBuilt = false,
	release = "v1.0.0",
} = {}) {
	if (release !== "v1.0.0")
		throw new Error(`Unsupported podcast release target: ${release}`);
	const evidence = await verifyTrackedPodcastEvidence();
	const contentSignoffs = {
		version: 2,
		entries: validateContentSignoffsV2(
			JSON.parse(await readFile(contentSignoffsPath, "utf8")),
		),
	};
	const publishable = getPublishablePodcastEpisodes();
	if (publishable.length !== PODCAST_EPISODES.length) {
		throw new Error(
			`Podcast publication is incomplete: ${PODCAST_EPISODES.map(
				(episode) =>
					`${episode.slug} (${getPodcastPublicationBlockers(episode).join(", ")})`,
			).join("; ")}`,
		);
	}

	if (withBuilt) {
		const builtCoverPath = builtFilePath(PODCAST_SHOW.artwork.publicPath);
		for (const builtPath of [
			builtCoverPath,
			path.join(repositoryRoot, "dist", "podcast", "index.html"),
		]) {
			if (!(await exists(builtPath)))
				throw new Error(`Podcast release artifact is missing: ${builtPath}`);
		}
		if (sha256(await readFile(builtCoverPath)) !== PODCAST_SHOW.artwork.sha256)
			throw new Error("Built podcast cover differs from approved bytes");
	}

	for (const episode of publishable) {
		const publicAudio = await readFile(
			publicFilePath(episode.audio.publicPath),
		);
		if (
			publicAudio.byteLength !== episode.audio.byteLength ||
			sha256(publicAudio) !== episode.audio.sha256
		) {
			throw new Error(`Published podcast audio differs for ${episode.slug}`);
		}
		assertPodcastContentSignoff(episode, contentSignoffs);
		if (withBuilt) {
			const builtAudioPath = builtFilePath(episode.audio.publicPath);
			for (const builtPath of [
				builtAudioPath,
				path.join(
					repositoryRoot,
					"dist",
					"podcast",
					episode.slug,
					"index.html",
				),
			]) {
				if (!(await exists(builtPath)))
					throw new Error(`Podcast release artifact is missing: ${builtPath}`);
			}
			const builtAudio = await readFile(builtAudioPath);
			if (
				builtAudio.byteLength !== episode.audio.byteLength ||
				sha256(builtAudio) !== episode.audio.sha256
			)
				throw new Error(`Built podcast audio differs for ${episode.slug}`);
		}
		if (episode.transcript !== null) {
			const transcript = await readFile(
				path.join(repositoryRoot, ...episode.transcript.sourcePath.split("/")),
			);
			if (sha256(transcript) !== episode.transcript.sha256)
				throw new Error(`Published transcript differs for ${episode.slug}`);
			const canonicalTranscript = canonicalTranscriptHtml(
				transcript.toString("utf8"),
				`Podcast transcript ${episode.slug}`,
			);
			if (withBuilt) {
				const builtTranscriptPath = builtRoutePath(
					episode.transcript.publicPath,
				);
				if (!(await exists(builtTranscriptPath)))
					throw new Error(
						`Podcast release artifact is missing: ${builtTranscriptPath}`,
					);
				const builtTranscript = parse(
					await readFile(builtTranscriptPath, "utf8"),
				);
				const transcriptElement = findElement(
					builtTranscript,
					"data-podcast-transcript",
				);
				if (!transcriptElement)
					throw new Error(
						`Built podcast transcript wrapper is missing: ${episode.slug}`,
					);
				const builtCanonicalTranscript = (transcriptElement.childNodes ?? [])
					.map((node) => serializeOuter(node))
					.join("");
				if (builtCanonicalTranscript !== canonicalTranscript)
					throw new Error(
						`Built podcast transcript differs for ${episode.slug}`,
					);
			}
		} else if (withBuilt) {
			const builtEpisode = await readFile(
				path.join(
					repositoryRoot,
					"dist",
					"podcast",
					episode.slug,
					"index.html",
				),
				"utf8",
			);
			if (
				builtEpisode.includes("data-podcast-transcript") ||
				builtEpisode.includes(`/podcast/${episode.slug}/transcript/`)
			) {
				throw new Error(
					`Transcript-free podcast episode exposes transcript data: ${episode.slug}`,
				);
			}
		}
	}
	if (withBuilt) {
		const builtFiles = await findFiles(path.join(repositoryRoot, "dist"), "");
		const builtAudioFiles = builtFiles.filter((file) =>
			/\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu.test(file),
		);
		const expectedAudioFiles = publishable.map((episode) =>
			path.normalize(builtFilePath(episode.audio.publicPath)),
		);
		if (
			builtAudioFiles.length !== expectedAudioFiles.length ||
			builtAudioFiles.some(
				(file) => !expectedAudioFiles.includes(path.normalize(file)),
			)
		)
			throw new Error(
				"Built podcast audio allowlist differs from the manifest",
			);
		if (await exists(builtFilePath(PODCAST_SHOW.feedPath)))
			throw new Error(
				"Podcast feed must remain private before the custom domain",
			);
		for (const file of builtFiles.filter((file) => file.endsWith(".html"))) {
			if ((await readFile(file, "utf8")).includes(PODCAST_SHOW.feedPath))
				throw new Error(
					"Podcast feed discovery must remain absent before the custom domain",
				);
		}
		await verifyPresentationSignoffV2({
			ledger: JSON.parse(await readFile(presentationSignoffsPath, "utf8")),
			repoRoot: repositoryRoot,
			distRoot: path.join(repositoryRoot, "dist"),
			release,
		});
	}

	return {
		episodes: publishable.length,
		audioSha256: evidence.audioHash,
		coverSourceSha256: evidence.coverHash,
		coverPngSha256: evidence.coverPngHash,
		builtArtifactsChecked: withBuilt,
		complete: true,
	};
}

export async function verifyPodcastTarget({
	withBuilt = false,
	release,
	expectedEpisodes,
} = {}) {
	const configured = await readPodcastReleaseTarget();
	const resolvedRelease = release ?? configured.release;
	const resolvedExpected = expectedEpisodes ?? configured.expectedEpisodes;
	if (resolvedRelease !== "v1.0.0")
		throw new Error(`Unsupported podcast release target: ${resolvedRelease}`);
	if (resolvedExpected === 0) return verifyPodcastDraft({ withBuilt });
	if (resolvedExpected === 1)
		return verifyPodcastRelease({ withBuilt, release: resolvedRelease });
	throw new Error("Podcast release target episode count is unsupported");
}

export async function verifyPodcastPublicationState({
	withBuilt = false,
} = {}) {
	return getPublishablePodcastEpisodes().length === 0
		? verifyPodcastDraft({ withBuilt })
		: verifyPodcastRelease({ withBuilt });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		const unsupported = process.argv
			.slice(2)
			.filter(
				(argument) =>
					argument !== "--require-complete" && argument !== "--with-built",
			);
		if (unsupported.length > 0)
			throw new Error(`Unknown podcast verification option: ${unsupported[0]}`);
		const withBuilt = process.argv.includes("--with-built");
		const result = process.argv.includes("--require-complete")
			? await verifyPodcastTarget({ withBuilt })
			: await verifyPodcastPublicationState({ withBuilt });
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
