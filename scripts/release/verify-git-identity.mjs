import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditGitMetadata } from "./audit-repository.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(SCRIPT_DIR, "audit-policy.json");

const audit = await auditGitMetadata({
	cwd: process.cwd(),
	policy: DEFAULT_POLICY,
	revisions: ["HEAD"],
	includeRefMetadata: false,
});

const blockingFindings = audit.findings.filter(
	(finding) => finding.blocking,
).length;
const reviewFindings = audit.findings.length - blockingFindings;

console.log(
	`Verified Git identity metadata across ${audit.commits.length} commits reachable from HEAD.`,
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
