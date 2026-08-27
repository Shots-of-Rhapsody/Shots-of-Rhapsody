export interface ContentSignoffV2 {
	readonly slug: string;
	readonly kind: "writing" | "podcast";
	readonly sourceSha256: `sha256:${string}`;
	readonly outputSha256: `sha256:${string}`;
	readonly assetSha256: readonly `sha256:${string}`[];
	readonly reviewer: "Tai Song";
	readonly reviewedAt: string;
	/** Confirms exact reproduction from the hash-bound author master. */
	readonly accuracy: "passed";
	readonly rights: "passed";
}

export interface PresentationSignoffV2 {
	readonly release: string;
	readonly reviewedCommit: string;
	readonly rendererSha256: `sha256:${string}`;
	readonly siteSha256: `sha256:${string}`;
	readonly reviewer: "Tai Song";
	readonly reviewedAt: string;
	readonly responsive: "passed";
	readonly accessibility: "passed";
}
