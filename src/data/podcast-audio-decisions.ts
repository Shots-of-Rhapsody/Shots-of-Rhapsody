import audioDecisionsJson from "../../provenance/reviews/podcast-audio-decisions-v1.json" with {
	type: "json",
};

export type PodcastAudioDistributionDecision =
	| "pending"
	| "retain-current-audio"
	| "replace-from-matching-lossless-master";

export interface PodcastAudioDecisionApprovalV1 {
	readonly slug: string;
	readonly decision: "retain-current-audio";
	readonly audioSha256: `sha256:${string}`;
	readonly reviewer: "Tai Song";
	readonly reviewedAt: string;
	readonly approval: "passed";
}

export interface PodcastAudioDecisionLedgerV1 {
	readonly version: 1;
	readonly entries: readonly PodcastAudioDecisionApprovalV1[];
}

interface PodcastAudioDecisionSubject {
	readonly slug: string;
	readonly audio: {
		readonly sha256: `sha256:${string}`;
		readonly distributionDecision: PodcastAudioDistributionDecision;
	};
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENTRY_KEYS = [
	"approval",
	"audioSha256",
	"decision",
	"reviewedAt",
	"reviewer",
	"slug",
];

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
	return (
		Object.keys(value).toSorted().join("\0") === expected.toSorted().join("\0")
	);
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

export function validatePodcastAudioDecisionLedgerV1(
	value: unknown,
): PodcastAudioDecisionLedgerV1 {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!hasExactKeys(value as Record<string, unknown>, ["entries", "version"])
	) {
		throw new Error("Podcast audio decision ledger is malformed");
	}
	const ledger = value as { version?: unknown; entries?: unknown };
	if (ledger.version !== 1 || !Array.isArray(ledger.entries))
		throw new Error("Podcast audio decision ledger must use version 1");

	const slugs = new Set<string>();
	const entries = ledger.entries.map((candidate) => {
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			Array.isArray(candidate) ||
			!hasExactKeys(candidate as Record<string, unknown>, ENTRY_KEYS)
		) {
			throw new Error("Podcast audio decision entry is malformed");
		}
		const entry = candidate as Record<string, unknown>;
		if (typeof entry.slug !== "string" || !SLUG_PATTERN.test(entry.slug))
			throw new Error("Podcast audio decision slug is malformed");
		if (slugs.has(entry.slug))
			throw new Error(`Duplicate podcast audio decision: ${entry.slug}`);
		slugs.add(entry.slug);
		if (
			entry.decision !== "retain-current-audio" ||
			typeof entry.audioSha256 !== "string" ||
			!SHA256_PATTERN.test(entry.audioSha256) ||
			entry.reviewer !== "Tai Song" ||
			!isCanonicalUtcTimestamp(entry.reviewedAt) ||
			entry.approval !== "passed"
		) {
			throw new Error(`Podcast audio decision is incomplete: ${entry.slug}`);
		}
		return entry as unknown as PodcastAudioDecisionApprovalV1;
	});

	return { version: 1, entries };
}

export const PODCAST_AUDIO_DECISIONS =
	validatePodcastAudioDecisionLedgerV1(audioDecisionsJson);

export function hasApprovedCurrentAudioDecision(
	episode: PodcastAudioDecisionSubject,
	ledger: PodcastAudioDecisionLedgerV1 = PODCAST_AUDIO_DECISIONS,
): boolean {
	if (episode.audio.distributionDecision !== "retain-current-audio")
		return false;
	const approval = validatePodcastAudioDecisionLedgerV1(ledger).entries.find(
		(entry) => entry.slug === episode.slug,
	);
	return (
		approval?.decision === episode.audio.distributionDecision &&
		approval.audioSha256 === episode.audio.sha256 &&
		approval.reviewer === "Tai Song" &&
		approval.approval === "passed"
	);
}
