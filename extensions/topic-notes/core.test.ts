#!/usr/bin/env node
/**
 * Unit tests for topic-notes pure helpers.
 *
 * No Pi runtime, no TUI, no npm deps — just node:test + node:assert.
 * Run with:   node .pi/extensions/topic-notes/core.test.ts
 * (Node >= 22.6 strips the TypeScript types natively.)
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	MISSING_REVISION,
	TOPIC_NOTE_SECTIONS,
	assertTopicPathConfined,
	atomicWriteFile,
	bashCommandMayMutateTopics,
	buildPendingMarker,
	clearPendingMarkers,
	ensureFinalNewline,
	formatStatusText,
	inferTopicIdFromLessonPath,
	isGuardedTopicsPath,
	missingSections,
	parsePendingMarker,
	pathIsInside,
	pendingMarkerPath,
	readFileIfExists,
	readPendingMarkers,
	relativeIfInside,
	renderTopicNoteTemplate,
	resolveTopicNotePath,
	revisionOf,
	sha256OfContent,
	shortRevision,
	slugifyTopicId,
	titleFromSlug,
	writePendingMarker,
} from "./core.ts";

const CONFIG_DIR = ".pi";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "topic-notes-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------

test("slugifyTopicId normalizes to lower-kebab", () => {
	assert.equal(slugifyTopicId("Graph Theory"), "graph-theory");
	assert.equal(slugifyTopicId("  Linear   Algebra!!  "), "linear-algebra");
	assert.equal(slugifyTopicId("Naïve Bayes"), "naive-bayes");
	assert.equal(slugifyTopicId("C++ / Rust"), "c-rust");
	assert.equal(slugifyTopicId("already-kebab"), "already-kebab");
	assert.equal(slugifyTopicId("__--__"), "");
	assert.equal(slugifyTopicId(42), "");
	assert.equal(slugifyTopicId(undefined), "");
});

test("slugifyTopicId strips every path-significant character", () => {
	for (const evil of ["../../etc/passwd", "..", ".", "a/b/c", "C:\\Windows", "foo\u0000bar", "~/secrets"]) {
		const slug = slugifyTopicId(evil);
		assert.ok(!slug.includes("/"), `slash survived in ${slug}`);
		assert.ok(!slug.includes("\\"), `backslash survived in ${slug}`);
		assert.ok(!slug.includes("."), `dot survived in ${slug}`);
		assert.ok(slug === "" || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `bad slug shape: ${slug}`);
	}
});

test("slugifyTopicId caps length without a trailing dash", () => {
	const slug = slugifyTopicId(`${"a".repeat(60)} ${"b".repeat(60)}`);
	assert.ok(slug.length <= 80);
	assert.ok(!slug.endsWith("-"));
});

test("titleFromSlug produces a readable heading", () => {
	assert.equal(titleFromSlug("graph-theory"), "Graph theory");
	assert.equal(titleFromSlug(""), "Untitled topic");
});

// ---------------------------------------------------------------------------

test("pathIsInside is strict about containment", () => {
	assert.equal(pathIsInside("/a/b", "/a/b/c"), true);
	assert.equal(pathIsInside("/a/b", "/a/b"), false);
	assert.equal(pathIsInside("/a/b", "/a/bc"), false);
	assert.equal(pathIsInside("/a/b", "/a"), false);
	assert.equal(pathIsInside("/a/b", "/a/b/../../c"), false);
});

test("resolveTopicNotePath confines to <cwd>/topics", () => {
	const cwd = "/workspace/learn";
	const r = resolveTopicNotePath(cwd, "Graph Theory");
	assert.equal(r.topicId, "graph-theory");
	assert.equal(r.absolutePath, path.join(cwd, "topics", "graph-theory.md"));
	assert.equal(r.relativePath, path.join("topics", "graph-theory.md"));
	assert.equal(r.topicsRoot, path.join(cwd, "topics"));
});

test("resolveTopicNotePath rejects traversal and empty ids", () => {
	const cwd = "/workspace/learn";
	for (const evil of ["../../etc/passwd", "/etc/passwd", "..", "", "   ", "///"]) {
		const slug = slugifyTopicId(evil);
		if (slug === "") {
			assert.throws(() => resolveTopicNotePath(cwd, evil), /Invalid topicId/);
		} else {
			// Anything that does slug must still land directly in topics/.
			const r = resolveTopicNotePath(cwd, evil);
			assert.equal(path.dirname(r.absolutePath), path.join(cwd, "topics"));
		}
	}
});

test("relativeIfInside only returns paths under cwd", () => {
	assert.equal(relativeIfInside("/a", "/a/b/c.md"), path.join("b", "c.md"));
	assert.equal(relativeIfInside("/a", "/x/c.md"), undefined);
	assert.equal(relativeIfInside("/a", null), undefined);
	assert.equal(relativeIfInside("/a", undefined), undefined);
});

test("inferTopicIdFromLessonPath recognizes the canonical lesson layout", () => {
	assert.equal(inferTopicIdFromLessonPath("/vault", "/vault/lessons/SQL/2026-05-02-joins.md"), "sql");
	assert.equal(inferTopicIdFromLessonPath("/vault", "/vault/Lesson.md"), undefined);
	assert.equal(inferTopicIdFromLessonPath("/vault", "/other/lessons/sql/x.md"), undefined);
});

test("assertTopicPathConfined rejects symlinks outside the vault", async () => {
	await withTempDir(async (parent) => {
		const cwd = path.join(parent, "vault");
		const outside = path.join(parent, "outside");
		await mkdir(cwd);
		await mkdir(outside);
		await symlink(outside, path.join(cwd, "topics"));
		const resolved = resolveTopicNotePath(cwd, "sql");
		await assert.rejects(() => assertTopicPathConfined(cwd, resolved), /outside the learning vault/);
	});
});

test("assertTopicPathConfined rejects a topic file symlinked outside topics", async () => {
	await withTempDir(async (parent) => {
		const cwd = path.join(parent, "vault");
		const topics = path.join(cwd, "topics");
		const outside = path.join(parent, "outside.md");
		await mkdir(topics, { recursive: true });
		await writeFile(outside, "outside\n");
		await symlink(outside, path.join(topics, "sql.md"));
		const resolved = resolveTopicNotePath(cwd, "sql");
		await assert.rejects(() => assertTopicPathConfined(cwd, resolved), /outside the topics directory/);
	});
});

test("isGuardedTopicsPath catches relative, absolute and traversal forms", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, "topics"), { recursive: true });
		await mkdir(path.join(cwd, "notes"), { recursive: true });

		assert.equal(await isGuardedTopicsPath(cwd, "topics/x.md"), true);
		assert.equal(await isGuardedTopicsPath(cwd, "./topics/nested/deep.md"), true);
		assert.equal(await isGuardedTopicsPath(cwd, "@topics/x.md"), true, "leading @ must be normalized");
		assert.equal(await isGuardedTopicsPath(cwd, path.join(cwd, "topics", "x.md")), true);
		assert.equal(await isGuardedTopicsPath(cwd, "notes/../topics/x.md"), true);
		assert.equal(await isGuardedTopicsPath(cwd, "topics"), true);

		assert.equal(await isGuardedTopicsPath(cwd, "notes/x.md"), false);
		assert.equal(await isGuardedTopicsPath(cwd, "Lesson.md"), false);
		assert.equal(await isGuardedTopicsPath(cwd, "topicsx/x.md"), false);
		assert.equal(await isGuardedTopicsPath(cwd, ""), false);
		assert.equal(await isGuardedTopicsPath(cwd, undefined), false);
	});
});

test("isGuardedTopicsPath follows symlinks into topics/", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, "topics"), { recursive: true });
		await writeFile(path.join(cwd, "topics", "real.md"), "x\n");
		await symlink(path.join(cwd, "topics"), path.join(cwd, "shortcut"));
		await symlink(path.join(cwd, "topics", "real.md"), path.join(cwd, "alias.md"));

		assert.equal(await isGuardedTopicsPath(cwd, "shortcut/real.md"), true);
		assert.equal(await isGuardedTopicsPath(cwd, "alias.md"), true);
	});
});

test("bashCommandMayMutateTopics blocks likely writes but permits reads", () => {
	for (const command of [
		"rm topics/sql.md",
		"echo x > topics/sql.md",
		"cat input | tee topics/sql.md",
		"cd topics && mv sql.md old.md",
		"sed -i '' s/a/b/ topics/sql.md",
		"python3 script.py /vault/topics/sql.md",
		"git restore -- topics/sql.md",
	]) {
		assert.equal(bashCommandMayMutateTopics(command), true, command);
	}
	for (const command of [
		"cat topics/sql.md",
		"rg joins topics",
		"ls topics",
		"rm other/sql.md",
		"echo topics are useful",
	]) {
		assert.equal(bashCommandMayMutateTopics(command), false, command);
	}
});

// ---------------------------------------------------------------------------

test("revisionOf hashes content and uses the missing sentinel", () => {
	assert.equal(revisionOf(undefined), MISSING_REVISION);
	assert.equal(revisionOf(null), MISSING_REVISION);
	assert.equal(revisionOf(""), sha256OfContent(""));
	assert.equal(revisionOf("hello"), sha256OfContent("hello"));
	assert.notEqual(revisionOf("a"), revisionOf("b"));
	assert.match(revisionOf("a"), /^[0-9a-f]{64}$/);
	assert.equal(shortRevision(MISSING_REVISION), MISSING_REVISION);
	assert.equal(shortRevision(revisionOf("a")).length, 12);
});

test("ensureFinalNewline yields exactly one trailing newline", () => {
	assert.equal(ensureFinalNewline("a"), "a\n");
	assert.equal(ensureFinalNewline("a\n"), "a\n");
	assert.equal(ensureFinalNewline("a\n\n\n"), "a\n");
	assert.equal(ensureFinalNewline("a\n  \n"), "a\n");
	assert.equal(ensureFinalNewline(""), "\n");
	assert.equal(ensureFinalNewline("   \n"), "\n");
	// idempotent
	assert.equal(ensureFinalNewline(ensureFinalNewline("x\n\n")), "x\n");
});

// ---------------------------------------------------------------------------

test("renderTopicNoteTemplate contains frontmatter and every canonical section", () => {
	const md = renderTopicNoteTemplate("Graph Theory", "graph-theory", "2024-01-01T00:00:00.000Z");
	assert.ok(md.startsWith("---\ntopic: \"Graph Theory\"\ntopic-id: graph-theory\nupdated: 2024-01-01\n---\n"));
	assert.ok(md.includes("# Graph Theory\n"));
	for (const section of TOPIC_NOTE_SECTIONS) {
		assert.ok(md.includes(`## ${section}\n\nNone recorded yet.`), `missing section: ${section}`);
	}
	assert.equal(md.endsWith("\n"), true);
	assert.equal(md.endsWith("\n\n"), false);
	assert.deepEqual(missingSections(md), []);
});

test("renderTopicNoteTemplate falls back to a slug-derived title", () => {
	assert.ok(renderTopicNoteTemplate("   ", "graph-theory").includes("# Graph theory\n"));
});

test("missingSections reports what a body lacks", () => {
	assert.deepEqual(missingSections("# T\n\n## Core ideas\n"), TOPIC_NOTE_SECTIONS.filter((s) => s !== "Core ideas"));
	assert.deepEqual(missingSections(""), [...TOPIC_NOTE_SECTIONS]);
	// heading level and case are irrelevant
	assert.ok(!missingSections("### mental MODEL\n").includes("Mental model"));
});

// ---------------------------------------------------------------------------

test("atomicWriteFile creates dirs, replaces content and leaves no temp files", async () => {
	await withTempDir(async (dir) => {
		const target = path.join(dir, "deep", "nested", "note.md");
		await atomicWriteFile(target, "one\n");
		assert.equal(await readFile(target, "utf8"), "one\n");
		await atomicWriteFile(target, "two\n");
		assert.equal(await readFile(target, "utf8"), "two\n");

		const { readdir } = await import("node:fs/promises");
		const leftovers = (await readdir(path.dirname(target))).filter((n) => n.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
	});
});

test("readFileIfExists returns undefined for missing files", async () => {
	await withTempDir(async (dir) => {
		assert.equal(await readFileIfExists(path.join(dir, "nope.md")), undefined);
		await atomicWriteFile(path.join(dir, "yes.md"), "hi\n");
		assert.equal(await readFileIfExists(path.join(dir, "yes.md")), "hi\n");
	});
});

// ---------------------------------------------------------------------------

test("pendingMarkerPath sanitizes session ids", () => {
	const p = pendingMarkerPath("/w", CONFIG_DIR, "../../evil id/../x");
	assert.equal(path.dirname(p), path.join("/w", CONFIG_DIR, ".state", "topic-notes"));
	assert.ok(!path.basename(p).includes("/"));
	assert.equal(path.basename(p), ".._.._evil_id_.._x.json");
});

test("buildPendingMarker normalizes and drops empty fields", () => {
	const m = buildPendingMarker({
		sessionId: "s1",
		sessionFile: null,
		logFile: "/w/Lesson.md",
		topicId: "Graph Theory",
		topicTitle: "Graph Theory",
		now: new Date(0),
	});
	assert.deepEqual(m, {
		version: 1,
		sessionId: "s1",
		updatedAt: "1970-01-01T00:00:00.000Z",
		logFile: "/w/Lesson.md",
		topicId: "graph-theory",
		topicTitle: "Graph Theory",
	});
	assert.equal("sessionFile" in m, false);
});

test("parsePendingMarker rejects junk and accepts round-trips", () => {
	const m = buildPendingMarker({ sessionId: "s1", topicId: "x" });
	assert.deepEqual(parsePendingMarker(JSON.stringify(m)), m);
	assert.equal(parsePendingMarker("not json"), undefined);
	assert.equal(parsePendingMarker(null), undefined);
	assert.equal(parsePendingMarker(42), undefined);
	assert.equal(parsePendingMarker({ version: 2, sessionId: "s" }), undefined);
	assert.equal(parsePendingMarker({ version: 1 }), undefined);
	assert.equal(parsePendingMarker({ version: 1, sessionId: "" }), undefined);
	// tolerates a marker written by an older/odd writer
	const loose = parsePendingMarker({ version: 1, sessionId: "s", extra: "ignored" });
	assert.equal(loose?.sessionId, "s");
	assert.equal(loose?.updatedAt, new Date(0).toISOString());
});

test("pending markers round-trip through the filesystem", async () => {
	await withTempDir(async (cwd) => {
		assert.deepEqual(await readPendingMarkers(cwd, CONFIG_DIR), [], "missing dir must be empty, not an error");

		const a = buildPendingMarker({ sessionId: "sess-a", logFile: path.join(cwd, "Lesson.md"), topicId: "graph-theory" });
		const b = buildPendingMarker({ sessionId: "sess-b", topicId: "linear-algebra" });
		await writePendingMarker(cwd, CONFIG_DIR, a);
		await writePendingMarker(cwd, CONFIG_DIR, b);

		// Junk files must be skipped, not throw.
		await atomicWriteFile(path.join(cwd, CONFIG_DIR, ".state", "topic-notes", "junk.json"), "{{{");
		await atomicWriteFile(path.join(cwd, CONFIG_DIR, ".state", "topic-notes", "README.txt"), "ignore me");

		const found = await readPendingMarkers(cwd, CONFIG_DIR);
		assert.deepEqual(
			found.map((f) => f.marker.sessionId).sort(),
			["sess-a", "sess-b"],
		);
	});
});

test("clearPendingMarkers removes by session, log file and incorporated session ids", async () => {
	await withTempDir(async (cwd) => {
		const log = path.join(cwd, "Lesson.md");
		await writePendingMarker(cwd, CONFIG_DIR, buildPendingMarker({ sessionId: "s1", logFile: log }));
		await writePendingMarker(cwd, CONFIG_DIR, buildPendingMarker({ sessionId: "s2", logFile: log }));
		await writePendingMarker(cwd, CONFIG_DIR, buildPendingMarker({ sessionId: "s3", topicId: "graph-theory" }));
		await writePendingMarker(cwd, CONFIG_DIR, buildPendingMarker({ sessionId: "s4", topicId: "other" }));

		// Current session s1 + everything sharing its lesson log + one explicitly incorporated pending session.
		const removed = await clearPendingMarkers(cwd, CONFIG_DIR, { sessionId: "s1", logFile: log, sessionIds: ["s3"] });
		assert.equal(removed.length, 3);
		const left = await readPendingMarkers(cwd, CONFIG_DIR);
		assert.deepEqual(
			left.map((l) => l.marker.sessionId),
			["s4"],
		);

		// Idempotent.
		assert.deepEqual(await clearPendingMarkers(cwd, CONFIG_DIR, { sessionId: "s1" }), []);
	});
});

test("clearPendingMarkers matches log files across ./ and trailing-slash forms", async () => {
	await withTempDir(async (cwd) => {
		await writePendingMarker(cwd, CONFIG_DIR, buildPendingMarker({ sessionId: "s1", logFile: path.join(cwd, "a", "..", "Lesson.md") }));
		const removed = await clearPendingMarkers(cwd, CONFIG_DIR, { logFile: path.join(cwd, "./Lesson.md") });
		assert.equal(removed.length, 1);
	});
});

// ---------------------------------------------------------------------------

test("formatStatusText summarizes state compactly", () => {
	assert.equal(formatStatusText({ dirty: false, pendingFromPriorSessions: 0 }), "clean");
	assert.equal(formatStatusText({ dirty: true, pendingFromPriorSessions: 0, topicId: "graph-theory" }), "pending · graph-theory");
	assert.equal(formatStatusText({ dirty: false, pendingFromPriorSessions: 2 }), "prior(2)");
	assert.equal(
		formatStatusText({ dirty: true, pendingFromPriorSessions: 3, topicId: "t", logBase: "Lesson.md" }),
		"pending · prior(3) · t · Lesson.md",
	);
});
