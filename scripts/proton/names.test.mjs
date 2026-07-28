import assert from "node:assert/strict";
import test from "node:test";
import {
	assignWindowsSafeCloudNames,
	ProtonNameError,
	windowsNameKey,
	windowsSafeCloudName,
} from "./names.mjs";

test("Windows-safe Proton names preserve exact Unicode while replacing unsupported punctuation", () => {
	assert.equal(
		windowsSafeCloudName(
			"Before the Sky Went Quiet: Part I - The Girl Who Faded",
		),
		"Before the Sky Went Quiet - Part I - The Girl Who Faded",
	);
	assert.equal(
		windowsSafeCloudName(
			"The Future of Money: Will Cryptocurrency and AI Kill Traditional Banking?",
		),
		"The Future of Money - Will Cryptocurrency and AI Kill Traditional Banking",
	);
	assert.equal(
		windowsSafeCloudName("What We Call Freedom Isn’t Really Freedom"),
		"What We Call Freedom Isn’t Really Freedom",
	);
	assert.equal(windowsSafeCloudName("Unicode e\u0301"), "Unicode é");
	assert.equal(windowsSafeCloudName("A: ? * B..."), "A - B");
});

test("Windows-safe Proton names reject spoofing, reserved stems, and excessive components", () => {
	for (const value of [
		"CON",
		"con.txt",
		"COM1",
		"COM¹",
		"LPT9",
		"LPT³.txt",
		"bad\u0000name",
		"bidi\u202ename",
		"?*",
		"a".repeat(246),
	]) {
		assert.throws(() => windowsSafeCloudName(value), ProtonNameError);
	}
});

test("cloud-name collisions are folder-scoped and resolved with a deterministic slug suffix", () => {
	const input = [
		{
			slug: "first-work",
			masterFolder: "fiction",
			articleTitle: "Same: Name",
		},
		{
			slug: "second-work",
			masterFolder: "fiction",
			articleTitle: "same? name",
		},
		{
			slug: "third-work",
			masterFolder: "nonfiction",
			articleTitle: "Same - Name",
		},
	];
	const records = assignWindowsSafeCloudNames(input);
	assert.equal(records[0].cloudName, "Same - Name");
	assert.equal(records[1].cloudName, "same - name - second-w");
	assert.equal(records[2].cloudName, "Same - Name");
	const reversed = assignWindowsSafeCloudNames([...input].reverse());
	assert.deepEqual(
		new Map(records.map((record) => [record.slug, record.cloudName])),
		new Map(reversed.map((record) => [record.slug, record.cloudName])),
	);
	assert.equal(windowsNameKey("Same - Name."), windowsNameKey("same - name"));
	assert.throws(
		() => assignWindowsSafeCloudNames([input[0], input[0]]),
		/repeats slug/u,
	);
});
