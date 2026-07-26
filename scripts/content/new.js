#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	AUTHOR_NAME,
	assertSlug,
	DEFAULT_REPO_ROOT,
	MediumContractError,
} from "../medium/lib/contract.js";

const SECTIONS = new Set(["fiction", "poetry-reflection", "nonfiction"]);
const HELP = `Usage:
  node scripts/content/new.js --section <section> --slug <slug> [--date YYYY-MM-DD]

Creates one unpublished draft and refuses to overwrite any existing path.
`;

function titleFromSlug(slug) {
	return slug
		.split("-")
		.map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
		.join(" ");
}

function utcDate() {
	return new Date().toISOString().slice(0, 10);
}

async function pathExists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export async function createDraft({
	repoRoot,
	section,
	slug,
	date = utcDate(),
}) {
	if (!SECTIONS.has(section)) {
		throw new MediumContractError(
			"section must be fiction, poetry-reflection, or nonfiction",
		);
	}
	assertSlug(slug);
	const parsedDate = new Date(`${date}T00:00:00.000Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
		Number.isNaN(parsedDate.valueOf()) ||
		parsedDate.toISOString().slice(0, 10) !== date
	) {
		throw new MediumContractError("date must use YYYY-MM-DD");
	}
	const directory = path.join(repoRoot, "src", "content", "posts", slug);
	const target = path.join(directory, "index.md");
	const legacyTarget = path.join(
		repoRoot,
		"src",
		"content",
		"posts",
		`${slug}.md`,
	);
	if ((await pathExists(directory)) || (await pathExists(legacyTarget))) {
		throw new MediumContractError(`Refusing duplicate content slug ${slug}`);
	}
	await mkdir(directory, { recursive: true });
	const title = titleFromSlug(slug);
	const contents = `---
title: ${JSON.stringify(title)}
subtitle: ""
summary: ""
author: ${JSON.stringify(AUTHOR_NAME)}
published: ${JSON.stringify(`${date}T00:00:00.000Z`)}
description: ""
image: ""
imageAlt: null
imageCaption: ""
tags: []
category: ""
section: ${JSON.stringify(section)}
draft: true
lang: "en"
license:
  name: "All Rights Reserved"
---

`;
	try {
		await writeFile(target, contents, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new MediumContractError(
				`Refusing to overwrite existing draft ${target}`,
			);
		}
		throw error;
	}
	return target;
}

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				section: { type: "string" },
				slug: { type: "string" },
				date: { type: "string" },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		}).values;
		if (!values.help && (!values.section || !values.slug)) {
			throw new MediumContractError("--section and --slug are required");
		}
	} catch (error) {
		console.error(`Usage error: ${error.message}`);
		console.error(HELP);
		return 2;
	}
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	try {
		const target = await createDraft({
			repoRoot: DEFAULT_REPO_ROOT,
			section: values.section,
			slug: values.slug,
			date: values.date,
		});
		console.log(`Created unpublished draft ${target}`);
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Draft creation failed: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
