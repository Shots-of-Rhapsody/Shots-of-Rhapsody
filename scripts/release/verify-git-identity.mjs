import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditGitMetadata } from "./audit-repository.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(SCRIPT_DIR, "audit-policy.json");
const [requestedRevision = "HEAD", ...unexpectedArguments] =
	process.argv.slice(2);

if (
	unexpectedArguments.length > 0 ||
	!(/^[0-9a-f]{40}$/u.test(requestedRevision) || requestedRevision === "HEAD")
) {
	console.error(
		"Usage: node scripts/release/verify-git-identity.mjs [HEAD|40-character-commit-sha]",
	);
	process.exit(2);
}

const audit = await auditGitMetadata({
	cwd: process.cwd(),
	policy: DEFAULT_POLICY,
	revisions: [requestedRevision],
	includeRefMetadata: false,
});

const blockingFindings = audit.findings.filter(
	(finding) => finding.blocking,
).length;
const reviewFindings = audit.findings.length - blockingFindings;

console.log(
	`Verified Git identity metadata across ${audit.commits.length} commits reachable from ${requestedRevision}.`,
);
console.log(
	`Git identity findings: ${blockingFindings} blocking, ${reviewFindings} requiring review.`,
);
for (const finding of audit.findings) {
	console.log(
		`- ${finding.blocking ? "BLOCK" : "REVIEW"} ${finding.rule}: ${finding.path}${finding.commit ? ` at ${finding.commit}` : ""}`,
	);
}

if (audit.findings.length > 0) process.exitCode = 1;
