/**
 * topic-notes/core.ts — pure, dependency-free helpers.
 *
 * Nothing in this module imports Pi or touches the TUI, so it can be unit
 * tested with plain `node core.test.ts` (Node >= 22 type stripping).
 * Only `node:` builtins are allowed here.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory (relative to cwd) that holds one markdown note per topic. */
export const TOPICS_DIR = "topics";

/** Sentinel revision used when the note file does not exist yet. */
export const MISSING_REVISION = "missing";

/** Footer status key / session custom entry namespace. */
export const STATUS_KEY = "topic-notes";
export const STATE_ENTRY_TYPE = "topic-note-state";
export const UPDATE_ENTRY_TYPE = "topic-note-update";

/** Project-local pending-marker directory, relative to cwd (joined with the config dir). */
export const PENDING_MARKER_SUBDIR = path.join(".state", "topic-notes");

/** Canonical section headings, in order, for a topic note. */
export const TOPIC_NOTE_SECTIONS = [
	"Mental model",
	"Core ideas",
	"Capabilities",
	"Open questions and weak areas",
	"Misconceptions corrected",
	"Review prompts",
	"Lessons and visuals",
	"Learning history",
] as const;

export type TopicNoteSection = (typeof TOPIC_NOTE_SECTIONS)[number];

const MAX_SLUG_LENGTH = 80;

// ---------------------------------------------------------------------------
// Slugging
// ---------------------------------------------------------------------------

/**
 * Normalize an arbitrary topic identifier / title into a lower-kebab slug.
 *
 * The result is guaranteed to match /^[a-z0-9]+(-[a-z0-9]+)*$/ or be the empty
 * string. In particular it can never contain `/`, `\`, `.` or whitespace, which
 * is what makes path confinement below trivially safe.
 */
export function slugifyTopicId(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const decomposed = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	const slug = decomposed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= MAX_SLUG_LENGTH) return slug;
	return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

/** Human-ish title fallback derived from a slug ("graph-theory" -> "Graph theory"). */
export function titleFromSlug(slug: string): string {
	if (!slug) return "Untitled topic";
	const words = slug.split("-").filter(Boolean);
	if (words.length === 0) return "Untitled topic";
	return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(" ")}` : "");
}

// ---------------------------------------------------------------------------
// Path handling / confinement
// ---------------------------------------------------------------------------

/** Some models prefix path arguments with `@`. Strip it like built-in tools do. */
export function normalizeAtPath(raw: string): string {
	return raw.startsWith("@") ? raw.slice(1) : raw;
}

/** True when `child` is strictly inside `parent`. */
export function pathIsInside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface ResolvedTopicPath {
	topicId: string;
	absolutePath: string;
	relativePath: string;
	topicsRoot: string;
}

/**
 * Resolve `<cwd>/topics/<slug>.md`, refusing anything that would escape the
 * topics directory. Because the slug is sanitized first this is defence in
 * depth, but the explicit containment check is kept so a future looser slug
 * rule cannot silently open a traversal hole.
 */
export function resolveTopicNotePath(cwd: string, rawTopicId: unknown): ResolvedTopicPath {
	const topicId = slugifyTopicId(rawTopicId);
	if (!topicId) {
		throw new Error(`Invalid topicId: ${JSON.stringify(rawTopicId)} (must contain at least one alphanumeric character)`);
	}
	const topicsRoot = path.resolve(cwd, TOPICS_DIR);
	const absolutePath = path.resolve(topicsRoot, `${topicId}.md`);
	if (path.dirname(absolutePath) !== topicsRoot || !pathIsInside(topicsRoot, absolutePath)) {
		throw new Error(`Refusing to resolve topic note outside ${topicsRoot}`);
	}
	return {
		topicId,
		absolutePath,
		relativePath: path.relative(cwd, absolutePath) || path.basename(absolutePath),
		topicsRoot,
	};
}

/** Relative path when `target` is inside `cwd`, otherwise undefined. */
export function relativeIfInside(cwd: string, target: string | undefined | null): string | undefined {
	if (!target) return undefined;
	if (!pathIsInside(cwd, target)) return undefined;
	return path.relative(path.resolve(cwd), path.resolve(target));
}

/** Infer the broad topic id from the canonical `lessons/<topic-id>/...` layout. */
export function inferTopicIdFromLessonPath(cwd: string, target: string | undefined | null): string | undefined {
	const relative = relativeIfInside(cwd, target);
	if (!relative) return undefined;
	const parts = relative.split(path.sep);
	if (parts.length < 3 || parts[0] !== "lessons") return undefined;
	const topicId = slugifyTopicId(parts[1]);
	return topicId || undefined;
}

/**
 * Resolve symlinks for the deepest existing ancestor of `p`, re-appending the
 * not-yet-existing tail. Never throws.
 */
export async function realpathBestEffort(p: string): Promise<string> {
	const start = path.resolve(p);
	let current = start;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = await fsp.realpath(current);
			return tail.length > 0 ? path.join(real, ...tail) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return start;
			tail.unshift(path.basename(current));
			current = parent;
		}
	}
}

/**
 * Assert that the extension's own resolved topic path stays inside the real
 * project and real topics directory. This rejects a `topics` directory or an
 * existing note that is symlinked outside the vault.
 */
export async function assertTopicPathConfined(cwd: string, resolved: ResolvedTopicPath): Promise<void> {
	const [realCwd, realRoot, realTarget] = await Promise.all([
		realpathBestEffort(cwd),
		realpathBestEffort(resolved.topicsRoot),
		realpathBestEffort(resolved.absolutePath),
	]);
	if (!pathIsInside(realCwd, realRoot)) {
		throw new Error(`Refusing topic path: ${resolved.topicsRoot} resolves outside the learning vault`);
	}
	if (!pathIsInside(realRoot, realTarget)) {
		throw new Error(`Refusing topic path: ${resolved.absolutePath} resolves outside the topics directory`);
	}
}

/**
 * Symlink-conscious test: does `rawPath` (as a model would pass it) land inside
 * `<cwd>/topics`? Used by the tool_call guard.
 */
export async function isGuardedTopicsPath(cwd: string, rawPath: unknown): Promise<boolean> {
	if (typeof rawPath !== "string" || rawPath.trim() === "") return false;
	const requested = path.resolve(cwd, normalizeAtPath(rawPath.trim()));
	const topicsRoot = path.resolve(cwd, TOPICS_DIR);
	// Fast, purely lexical check first — catches `../` games and absolute paths.
	if (requested === topicsRoot || pathIsInside(topicsRoot, requested)) return true;
	// Then the symlink-aware check, in case `topics` or the target is a link.
	const [realTarget, realRoot] = await Promise.all([realpathBestEffort(requested), realpathBestEffort(topicsRoot)]);
	return realTarget === realRoot || pathIsInside(realRoot, realTarget);
}

/**
 * Conservative guard for model-issued shell commands that both reference the
 * topics directory and contain a likely mutation primitive. This is not a
 * security sandbox, but it prevents ordinary shell redirection/rm/mv/etc. from
 * bypassing the editable topic-note approval flow while still allowing reads.
 */
export function bashCommandMayMutateTopics(command: unknown): boolean {
	if (typeof command !== "string" || command.trim() === "") return false;
	const referencesTopics = /(?:^|[\/\s"'`=;|&()])topics(?:[\\/]|[\s"'`;&|>)]|$)/i.test(command);
	if (!referencesTopics) return false;
	const mutationCommand =
		/(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|mv|cp|install|touch|mkdir|rmdir|truncate|tee|dd|sed\s+[^;&|]*-i|perl\s+[^;&|]*-i|python\d*|node|ruby|sh|bash|zsh|git\s+(?:checkout|restore|clean)|apply_patch)\b/i;
	const redirectsOutput = /(^|[^<])>{1,2}(?!>)/.test(command);
	return mutationCommand.test(command) || redirectsOutput;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export function sha256OfContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Revision id for note content; `MISSING_REVISION` when the file is absent. */
export function revisionOf(content: string | undefined | null): string {
	if (content === undefined || content === null) return MISSING_REVISION;
	return sha256OfContent(content);
}

/** Markdown files are line oriented; always end with exactly one trailing newline. */
export function ensureFinalNewline(content: string): string {
	const trimmed = content.replace(/\s+$/u, "");
	return trimmed.length === 0 ? "\n" : `${trimmed}\n`;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/** Render a fresh topic note skeleton matching the curation skill's schema. */
export function renderTopicNoteTemplate(title: string, topicId: string, nowIso?: string): string {
	const heading = title.trim() || titleFromSlug(topicId);
	const updated = (nowIso ?? new Date().toISOString()).slice(0, 10);
	const lines: string[] = [
		"---",
		`topic: ${JSON.stringify(heading)}`,
		`topic-id: ${topicId}`,
		`updated: ${updated}`,
		"---",
		"",
		`# ${heading}`,
		"",
	];
	for (const section of TOPIC_NOTE_SECTIONS) {
		lines.push(`## ${section}`);
		lines.push("");
		lines.push("None recorded yet.");
		lines.push("");
	}
	return ensureFinalNewline(lines.join("\n"));
}

/** Which canonical sections are missing from a markdown body (heading match, any level). */
export function missingSections(markdown: string): TopicNoteSection[] {
	const found = new Set<string>();
	for (const line of markdown.split(/\r?\n/)) {
		const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		if (m) found.add(m[1].trim().toLowerCase());
	}
	return TOPIC_NOTE_SECTIONS.filter((s) => !found.has(s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/** Write `content` via temp file + rename, so readers never see a partial file. */
export async function atomicWriteFile(absolutePath: string, content: string): Promise<void> {
	const dir = path.dirname(absolutePath);
	await fsp.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(absolutePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await fsp.writeFile(tmp, content, "utf8");
		await fsp.rename(tmp, absolutePath);
	} catch (error) {
		await fsp.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

/** Read a file, returning undefined when it does not exist. */
export async function readFileIfExists(absolutePath: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(absolutePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Pending markers
// ---------------------------------------------------------------------------

export interface PendingMarker {
	version: 1;
	sessionId: string;
	sessionFile?: string;
	logFile?: string;
	topicId?: string;
	topicTitle?: string;
	reason?: string;
	updatedAt: string;
}

/** Directory holding pending markers for a project. */
export function pendingMarkerDir(cwd: string, configDirName: string): string {
	return path.resolve(cwd, configDirName, PENDING_MARKER_SUBDIR);
}

/** Per-session marker file path. Session ids are slugged so they stay filename-safe. */
export function pendingMarkerPath(cwd: string, configDirName: string, sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown-session";
	return path.join(pendingMarkerDir(cwd, configDirName), `${safe}.json`);
}

export function buildPendingMarker(input: {
	sessionId: string;
	sessionFile?: string | null;
	logFile?: string | null;
	topicId?: string | null;
	topicTitle?: string | null;
	reason?: string | null;
	now?: Date;
}): PendingMarker {
	const marker: PendingMarker = {
		version: 1,
		sessionId: input.sessionId,
		updatedAt: (input.now ?? new Date()).toISOString(),
	};
	if (input.sessionFile) marker.sessionFile = input.sessionFile;
	if (input.logFile) marker.logFile = input.logFile;
	if (input.topicId) marker.topicId = slugifyTopicId(input.topicId) || undefined;
	if (input.topicTitle) marker.topicTitle = input.topicTitle;
	if (input.reason) marker.reason = input.reason;
	return marker;
}

/** Defensive parse: unknown JSON -> PendingMarker, or undefined when unusable. */
export function parsePendingMarker(raw: unknown): PendingMarker | undefined {
	if (typeof raw === "string") {
		try {
			return parsePendingMarker(JSON.parse(raw));
		} catch {
			return undefined;
		}
	}
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	if (obj.version !== 1) return undefined;
	if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) return undefined;
	const marker: PendingMarker = {
		version: 1,
		sessionId: obj.sessionId,
		updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(0).toISOString(),
	};
	if (typeof obj.sessionFile === "string") marker.sessionFile = obj.sessionFile;
	if (typeof obj.logFile === "string") marker.logFile = obj.logFile;
	if (typeof obj.topicId === "string") marker.topicId = obj.topicId;
	if (typeof obj.topicTitle === "string") marker.topicTitle = obj.topicTitle;
	if (typeof obj.reason === "string") marker.reason = obj.reason;
	return marker;
}

export async function writePendingMarker(cwd: string, configDirName: string, marker: PendingMarker): Promise<string> {
	const file = pendingMarkerPath(cwd, configDirName, marker.sessionId);
	await atomicWriteFile(file, `${JSON.stringify(marker, null, 2)}\n`);
	return file;
}

export async function readPendingMarkers(cwd: string, configDirName: string): Promise<Array<{ file: string; marker: PendingMarker }>> {
	const dir = pendingMarkerDir(cwd, configDirName);
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch {
		return [];
	}
	const out: Array<{ file: string; marker: PendingMarker }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		const marker = parsePendingMarker(await readFileIfExists(file));
		if (marker) out.push({ file, marker });
	}
	return out;
}

/** Remove the current session marker plus any marker referencing the same lesson log. */
export async function clearPendingMarkers(
	cwd: string,
	configDirName: string,
	match: { sessionId?: string; sessionIds?: string[]; logFile?: string },
): Promise<string[]> {
	const removed: string[] = [];
	const sessionIds = new Set(match.sessionIds ?? []);
	for (const { file, marker } of await readPendingMarkers(cwd, configDirName)) {
		const hit =
			(match.sessionId !== undefined && marker.sessionId === match.sessionId) ||
			sessionIds.has(marker.sessionId) ||
			(match.logFile !== undefined && marker.logFile !== undefined && path.resolve(marker.logFile) === path.resolve(match.logFile));
		if (!hit) continue;
		try {
			await fsp.rm(file, { force: true });
			removed.push(file);
		} catch {
			// best effort
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Misc formatting
// ---------------------------------------------------------------------------

export function shortRevision(revision: string): string {
	return revision === MISSING_REVISION ? MISSING_REVISION : revision.slice(0, 12);
}

/** One-line footer status text (theme-free so it is testable). */
export function formatStatusText(state: { dirty: boolean; pendingFromPriorSessions: number; topicId?: string; logBase?: string }): string {
	const bits: string[] = [];
	if (state.dirty) bits.push("pending");
	else if (state.pendingFromPriorSessions === 0) bits.push("clean");
	if (state.pendingFromPriorSessions > 0) bits.push(`prior(${state.pendingFromPriorSessions})`);
	if (state.topicId) bits.push(state.topicId);
	if (state.logBase) bits.push(state.logBase);
	return bits.join(" · ");
}
