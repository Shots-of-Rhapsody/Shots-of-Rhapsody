export type ShotsBuildMode = "release" | "public-review";

export const SHOTS_BUILD_MODE_ENV = "SHOTS_BUILD_MODE";

export function resolveBuildMode(
	value: string | undefined = process.env[SHOTS_BUILD_MODE_ENV],
): ShotsBuildMode {
	if (value === undefined || value === "" || value === "release") {
		return "release";
	}
	if (value === "public-review") return value;
	throw new Error(
		`${SHOTS_BUILD_MODE_ENV} must be either release or public-review`,
	);
}

export const SHOTS_BUILD_MODE = resolveBuildMode();
export const IS_PUBLIC_REVIEW = SHOTS_BUILD_MODE === "public-review";
