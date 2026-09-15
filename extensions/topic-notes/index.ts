/**
 * topic-notes — durable, per-topic learning notes with an approval gate.
 *
 * Why this exists
 * ---------------
 * The `md-log` extension keeps a *chronological* transcript of a lesson. That is
 * great for "what happened", terrible for "what do I actually know about X".
 * This extension owns the second half: one living markdown note per topic under
 * `<cwd>/topics/<topic-id>.md`, with a fixed section skeleton, and a hard rule
 * that the model may never write into `topics/` directly.
 *
 * Every mutation goes through `propose_topic_note_update`, which:
 *   1. checks the note's current sha256 against the `baseRevision` the model saw,
 *   2. opens the *full* proposed markdown in `ctx.ui.editor` so the human edits
 *      and approves it,
 *   3. re-checks the hash (the file may have changed while the editor was open),
 *   4. writes atomically (temp file + rename) inside `withFileMutationQueue`,
 *      keeping one ignored backup of the previous content under `.pi/.state`.
 *
 * Tools
 *   get_topic_note_context     — read (or template) a topic note + provenance
 *   propose_topic_note_update  — human-approved, hash-checked write
 *
 * Commands
 *   /topic-update [topic]      — ask the main agent to propose an update
 *   /topic-status              — report pending/clean + active lesson log
 *
 * Dirty tracking
 *   Substantive assistant lesson text or an answered learning question/quiz
 *   while an md-log lesson file is linked means "the topic note may now be
 *   stale" -> dirty. Dirty state is persisted as a `topic-note-state` custom
 *   entry (so it survives
 *   reload/resume) and, at shutdown, as a project-local pending marker under
 *   `<config>/.state/topic-notes/<sessionId>.json`. Markers are *not* drafts —
 *   they only say "session S ended with an unrecorded lesson".
 */

import { CONFIG_DIR_NAME, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { Type, type Static } from "typebox";

import {
	STATE_ENTRY_TYPE,
	STATUS_KEY,
	TOPIC_NOTE_SECTIONS,
	UPDATE_ENTRY_TYPE,
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
	readFileIfExists,
	readPendingMarkers,
	relativeIfInside,
	renderTopicNoteTemplate,
	resolveTopicNotePath,
	revisionOf,
	shortRevision,
	slugifyTopicId,
	titleFromSlug,
	writePendingMarker,
} from "./core.ts";

// ---------------------------------------------------------------------------
// Shared UI mutex — MUST use the exact same global key as quiz / ask_user_question
// so popup-style tools across separate extension files serialize against each other.
// ---------------------------------------------------------------------------

const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => {
					release = r;
				});
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();
function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GetContextParams = Type.Object({
	topicId: Type.String({
		description:
			"Stable topic identifier. Broad, not lesson-sized: 'graph-theory', not 'dijkstra-on-a-5-node-graph'. Automatically normalized to lower-kebab-case.",
	}),
	title: Type.String({
		description: "Human-readable title for the topic, used as the note's H1 when the note does not exist yet.",
	}),
});

const ProposeUpdateParams = Type.Object({
	topicId: Type.String({ description: "Topic identifier, same value passed to get_topic_note_context." }),
	title: Type.String({ description: "Human-readable topic title." }),
	baseRevision: Type.String({
		description:
			"The `revision` returned by the most recent get_topic_note_context call for this topic. Use the literal string 'missing' when the note did not exist. A mismatch aborts the write.",
	}),
	fullMarkdown: Type.String({
		description:
			"The COMPLETE new contents of the topic note, not a diff or a fragment. Keep every canonical section heading. This exact text is shown to the user in an editor for approval and editing.",
	}),
	changeSummary: Type.String({
		description: "One or two sentences describing what changed and why, shown to the user and stored as provenance.",
	}),
	incorporatedPendingSessionIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Session ids from get_topic_note_context.pendingLessons whose lesson logs were actually incorporated into this draft. Only these pending markers are cleared.",
		}),
	),
});

export type GetTopicNoteContextInput = Static<typeof GetContextParams>;
export type ProposeTopicNoteUpdateInput = Static<typeof ProposeUpdateParams>;

type UpdateStatus = "written" | "cancelled" | "conflict" | "invalid" | "unavailable" | "unchanged";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function topicNotes(pi: ExtensionAPI) {
	// --- session-scoped state ------------------------------------------------
	let logFile: string | null = null; // active md-log lesson file, if any
	let dirtyLogFile: string | null = null; // provenance retained if /md-unlog is called while dirty
	let dirty = false; // lesson content not yet folded into a topic note
	let knownTopicId: string | undefined;
	let knownTopicTitle: string | undefined;
	let curatedThisSession = false;
	let pendingFromPriorSessions = 0;
	let notifiedPendingThisSession = false;

	function syncLogFileFromSession(ctx: { sessionManager: { getBranch(): any[] } }): void {
		let latest: string | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "md-log") continue;
			const data = entry.data as { file?: string | null } | undefined;
			latest = data?.file ?? null;
		}
		logFile = latest;
	}

	function sourceLogFile(): string | null {
		return logFile ?? (dirty ? dirtyLogFile : null);
	}

	function setStatus(ctx: { ui: { setStatus(k: string, t: string | undefined): void; theme?: any } }) {
		const sourceLog = sourceLogFile();
		const text = formatStatusText({
			dirty,
			pendingFromPriorSessions,
			topicId: knownTopicId,
			logBase: sourceLog ? path.basename(sourceLog) : undefined,
		});
		const theme = (ctx.ui as any).theme;
		const icon = dirty || pendingFromPriorSessions > 0 ? "📝 " : "📗 ";
		const rendered = theme
			? theme.fg(dirty || pendingFromPriorSessions > 0 ? "warning" : "dim", icon + text)
			: icon + text;
		ctx.ui.setStatus(STATUS_KEY, rendered);
	}

	async function refreshPendingCount(ctx: { cwd: string; sessionManager: { getSessionId(): string } }): Promise<void> {
		const currentId = ctx.sessionManager.getSessionId();
		pendingFromPriorSessions = (await readPendingMarkers(ctx.cwd, CONFIG_DIR_NAME)).filter(
			({ marker }) => marker.sessionId !== currentId,
		).length;
	}

	/** Persist dirty/known-topic state, but only when it actually changed. */
	function persistState(next: { dirty: boolean; topicId?: string; topicTitle?: string }, reason: string) {
		const nextDirtyLogFile = next.dirty ? (dirtyLogFile ?? logFile) : null;
		const changed =
			next.dirty !== dirty ||
			next.topicId !== knownTopicId ||
			next.topicTitle !== knownTopicTitle ||
			nextDirtyLogFile !== dirtyLogFile;
		dirty = next.dirty;
		dirtyLogFile = nextDirtyLogFile;
		knownTopicId = next.topicId;
		knownTopicTitle = next.topicTitle;
		if (!changed) return;
		try {
			pi.appendEntry(STATE_ENTRY_TYPE, {
				dirty,
				topicId: knownTopicId ?? null,
				topicTitle: knownTopicTitle ?? null,
				logFile: dirtyLogFile,
				reason,
				at: new Date().toISOString(),
			});
		} catch {
			// Session may be ephemeral; state tracking is best effort.
		}
	}

	// --- session_start: rebuild state, scan pending markers ------------------

	pi.on("session_start", async (_event, ctx) => {
		logFile = null;
		dirtyLogFile = null;
		dirty = false;
		knownTopicId = undefined;
		knownTopicTitle = undefined;
		curatedThisSession = false;
		pendingFromPriorSessions = 0;
		notifiedPendingThisSession = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "md-log") {
				const data = entry.data as { file?: string | null } | undefined;
				logFile = data?.file ?? null;
			} else if (entry.customType === STATE_ENTRY_TYPE) {
				const data = entry.data as {
					dirty?: boolean;
					topicId?: string | null;
					topicTitle?: string | null;
					logFile?: string | null;
				} | undefined;
				dirty = Boolean(data?.dirty);
				dirtyLogFile = dirty ? (data?.logFile ?? dirtyLogFile) : null;
				if (dirty) curatedThisSession = false;
				knownTopicId = data?.topicId ?? undefined;
				knownTopicTitle = data?.topicTitle ?? undefined;
			} else if (entry.customType === UPDATE_ENTRY_TYPE) {
				const data = entry.data as { status?: string; topicId?: string; title?: string } | undefined;
				if (data?.status === "written" || data?.status === "unchanged") {
					dirty = false;
					dirtyLogFile = null;
					curatedThisSession = true;
					knownTopicId = data.topicId ?? knownTopicId;
					knownTopicTitle = data.title ?? knownTopicTitle;
				}
			}
		}

		// Pending markers left by previous sessions of this project.
		try {
			const currentId = ctx.sessionManager.getSessionId();
			const markers = (await readPendingMarkers(ctx.cwd, CONFIG_DIR_NAME)).filter((m) => m.marker.sessionId !== currentId);
			pendingFromPriorSessions = markers.length;
			if (markers.length > 0 && ctx.hasUI && !notifiedPendingThisSession) {
				notifiedPendingThisSession = true;
				const names = markers
					.map((m) => m.marker.topicId ?? (m.marker.logFile ? path.basename(m.marker.logFile) : m.marker.sessionId))
					.slice(0, 3)
					.join(", ");
				// Non-blocking only: never pop a dialog at session start.
				ctx.ui.notify(
					`topic-notes: ${markers.length} earlier session(s) ended with unrecorded lessons (${names}). Run /topic-update when ready.`,
					"info",
				);
			}
		} catch {
			pendingFromPriorSessions = 0;
		}

		if (ctx.hasUI) setStatus(ctx);
	});

	// --- dirty detection ------------------------------------------------------
	// The first substantive assistant text catches quiz-free/expository lessons.
	// Answered quiz/question tools catch turns whose assistant message contains
	// only a tool call. Once curation succeeds, the closing acknowledgement does
	// not make the just-curated lesson dirty again.

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as any;
		if (message?.role !== "assistant" || curatedThisSession || dirty) return;
		syncLogFileFromSession(ctx);
		if (!logFile) return;
		const hasText = Array.isArray(message.content) && message.content.some(
			(part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
		);
		if (!hasText) return;
		persistState({ dirty: true, topicId: knownTopicId, topicTitle: knownTopicTitle }, "assistant-lesson-text");
		if (ctx.hasUI) setStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "quiz" && event.toolName !== "ask_user_question") return;
		if (event.isError) return;
		syncLogFileFromSession(ctx);
		if (!logFile) return; // no lesson linked -> no provenance, stay graceful
		const details = event.details as { status?: string } | undefined;
		if (details?.status !== "answered") return;
		if (dirty) return;
		curatedThisSession = false;
		persistState(
			{ dirty: true, topicId: knownTopicId, topicTitle: knownTopicTitle },
			event.toolName === "quiz" ? "quiz-answered" : "learning-question-answered",
		);
		if (ctx.hasUI) setStatus(ctx);
	});

	// --- guard: the model must not write into topics/ directly ---------------

	pi.on("tool_call", async (event, ctx) => {
		let targetDescription: string | undefined;
		if (event.toolName === "write" || event.toolName === "edit") {
			const raw = (event.input as { path?: unknown } | undefined)?.path;
			let guarded = false;
			try {
				guarded = await isGuardedTopicsPath(ctx.cwd, raw);
			} catch {
				guarded = false;
			}
			if (guarded) targetDescription = String(raw);
		} else if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			if (bashCommandMayMutateTopics(command)) targetDescription = "shell command referencing topics/";
		} else {
			return;
		}
		if (!targetDescription) return;
		const reason =
			`topics/ is owned by the topic-notes extension. Do not use ${event.toolName} to mutate it. ` +
			"Call get_topic_note_context to read the note, then propose_topic_note_update with the complete new markdown; " +
			"the user reviews and approves the change in an editor.";
		if (ctx.hasUI) {
			ctx.ui.notify(`topic-notes: blocked ${event.toolName} mutation (${targetDescription})`, "warning");
		}
		return { block: true, reason };
	});

	// --- idle: status only, never a popup ------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		syncLogFileFromSession(ctx);
		if (ctx.hasUI) setStatus(ctx);
	});

	// --- shutdown: drop a pending marker, never block ------------------------

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!dirty) return;
		syncLogFileFromSession(ctx);
		try {
			const sourceLog = sourceLogFile();
			const inferredTopicId = knownTopicId ?? inferTopicIdFromLessonPath(ctx.cwd, sourceLog);
			const marker = buildPendingMarker({
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				logFile: sourceLog,
				topicId: inferredTopicId ?? null,
				topicTitle: knownTopicTitle ?? (inferredTopicId ? titleFromSlug(inferredTopicId) : null),
				reason: "session ended with an unrecorded lesson",
			});
			await writePendingMarker(ctx.cwd, CONFIG_DIR_NAME, marker);
		} catch {
			// Shutdown must not fail because of bookkeeping.
		}
	});

	// =========================================================================
	// Tool: get_topic_note_context
	// =========================================================================

	pi.registerTool({
		name: "get_topic_note_context",
		label: "topic note",
		description:
			"Read the living note for a topic under topics/<topic-id>.md. Returns the full current markdown (or a fresh section template when the note does not exist yet), plus a `revision` hash you MUST pass back as `baseRevision` to propose_topic_note_update. Also reports the active lesson log so you can cite it. Always call this before proposing an update.",
		promptSnippet: "Read the durable topic note (topics/<topic-id>.md) plus its revision hash before proposing an update.",
		promptGuidelines: [
			"Use get_topic_note_context before propose_topic_note_update; the revision hash it returns is required.",
			"Topic ids in get_topic_note_context are broad subject areas, not individual lessons.",
			"Never use write or edit inside topics/ — those calls are blocked. Use propose_topic_note_update instead.",
		],
		parameters: GetContextParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			syncLogFileFromSession(ctx);
			const resolved = resolveTopicNotePath(ctx.cwd, params.topicId);
			await assertTopicPathConfined(ctx.cwd, resolved);
			const existing = await readFileIfExists(resolved.absolutePath);
			const exists = existing !== undefined;
			const title = params.title?.trim() || titleFromSlug(resolved.topicId);
			const content = exists ? existing! : renderTopicNoteTemplate(title, resolved.topicId, new Date().toISOString());
			const revision = revisionOf(existing);

			const currentLogFile = sourceLogFile();
			const lessonRelative = relativeIfInside(ctx.cwd, currentLogFile);
			const currentSessionId = ctx.sessionManager.getSessionId();
			const pendingLessons = (await readPendingMarkers(ctx.cwd, CONFIG_DIR_NAME))
				.filter(({ marker }) => {
					if (marker.sessionId === currentSessionId) return false;
					const markerTopic = marker.topicId ?? inferTopicIdFromLessonPath(ctx.cwd, marker.logFile);
					return markerTopic === resolved.topicId;
				})
				.map(({ marker }) => ({
					sessionId: marker.sessionId,
					sessionFile: marker.sessionFile,
					lessonLogPath: marker.logFile,
					lessonLogRelativePath: relativeIfInside(ctx.cwd, marker.logFile),
					topicId: marker.topicId ?? inferTopicIdFromLessonPath(ctx.cwd, marker.logFile),
					topicTitle: marker.topicTitle,
					updatedAt: marker.updatedAt,
				}));
			const details = {
				topicId: resolved.topicId,
				title,
				exists,
				relativePath: resolved.relativePath,
				absolutePath: resolved.absolutePath,
				revision,
				content,
				sections: [...TOPIC_NOTE_SECTIONS],
				missingSections: exists ? missingSections(content) : [],
				lessonLogPath: currentLogFile ?? undefined,
				lessonLogRelativePath: lessonRelative,
				pendingLessons,
				dirty,
				sessionId: currentSessionId,
				sessionFile: ctx.sessionManager.getSessionFile(),
				leafId: ctx.sessionManager.getLeafId(),
			};

			// Remember which topic this session is about, for status + markers.
			if (knownTopicId !== resolved.topicId || knownTopicTitle !== title) {
				persistState({ dirty, topicId: resolved.topicId, topicTitle: title }, "topic-identified");
				if (ctx.hasUI) setStatus(ctx);
			}

			const pendingLines = pendingLessons.length > 0
				? [
					`pending earlier lessons for this topic: ${pendingLessons.length}`,
					...pendingLessons.map((lesson) =>
						`- session ${lesson.sessionId}: ${lesson.lessonLogRelativePath ?? lesson.lessonLogPath ?? "(no lesson log)"}`,
					),
					"Read and incorporate each relevant pending lesson log, then pass those session ids as `incorporatedPendingSessionIds` so only processed markers are cleared.",
				]
				: ["pending earlier lessons for this topic: none"];
			const header = [
				`topic: ${resolved.topicId} (${title})`,
				`path: ${resolved.relativePath}`,
				`revision: ${revision}${exists ? "" : "  (note does not exist yet — content below is a template)"}`,
				lessonRelative ? `current lesson log: ${lessonRelative}` : "current lesson log: (none linked)",
				...pendingLines,
				"",
				"Pass `revision` back as `baseRevision`. Send the COMPLETE markdown to propose_topic_note_update.",
				"---",
			].join("\n");

			return {
				content: [{ type: "text", text: `${header}\n${content}` }],
				details,
			};
		},

		renderCall(args, theme) {
			const id = slugifyTopicId((args as { topicId?: string })?.topicId) || "?";
			return new Text(theme.fg("toolTitle", theme.bold("topic note ")) + theme.fg("muted", id), 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as { topicId?: string; exists?: boolean; revision?: string; relativePath?: string } | undefined;
			if (!d) return new Text(theme.fg("dim", "read"), 0, 0);
			const state = d.exists ? theme.fg("success", "read") : theme.fg("warning", "new (template)");
			return new Text(`${state} ${theme.fg("dim", `${d.relativePath ?? ""} @ ${shortRevision(d.revision ?? "")}`)}`, 0, 0);
		},
	});

	// =========================================================================
	// Tool: propose_topic_note_update
	// =========================================================================

	pi.registerTool({
		name: "propose_topic_note_update",
		label: "topic note update",
		description:
			"Propose the COMPLETE new contents of a topic note. The user reviews and edits the markdown in an interactive editor before anything is written; cancelling writes nothing. The write is rejected if the note changed since `baseRevision`. It cannot write in print or JSON mode. This is the only sanctioned way to modify files under topics/.",
		promptSnippet: "Propose the full new markdown for a topic note; the user approves or edits it before it is written.",
		promptGuidelines: [
			"propose_topic_note_update takes the entire file contents, never a diff or a partial section.",
			"Pass the exact revision from get_topic_note_context as baseRevision to propose_topic_note_update; use 'missing' for a note that does not exist yet.",
			"Keep every canonical section heading when calling propose_topic_note_update, even if a section stays empty.",
			"When get_topic_note_context reports pendingLessons, read the relevant logs and pass only the session ids actually incorporated as incorporatedPendingSessionIds.",
		],
		parameters: ProposeUpdateParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			syncLogFileFromSession(ctx);
			const resolved = resolveTopicNotePath(ctx.cwd, params.topicId);
			await assertTopicPathConfined(ctx.cwd, resolved);
			const title = params.title?.trim() || titleFromSlug(resolved.topicId);

			const finish = (status: UpdateStatus, message: string, extra: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text: message }],
				details: {
					status,
					message,
					topicId: resolved.topicId,
					title,
					relativePath: resolved.relativePath,
					absolutePath: resolved.absolutePath,
					baseRevision: params.baseRevision,
					changeSummary: params.changeSummary,
					...extra,
				},
			});

			if (signal?.aborted) return finish("cancelled", "Aborted before the approval editor opened.");

			// Approval is mandatory: TUI and RPC can provide an editor; print/JSON cannot.
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				return finish(
					"unavailable",
					`Refusing to write ${resolved.relativePath}: propose_topic_note_update requires interactive editor approval (current mode: ${ctx.mode}). Nothing was written.`,
				);
			}

			// --- pre-flight hash check (cheap, before we bother the user) ------
			const before = await readFileIfExists(resolved.absolutePath);
			const currentRevision = revisionOf(before);
			if (currentRevision !== params.baseRevision) {
				return finish(
					"conflict",
					`Conflict: ${resolved.relativePath} is at revision ${shortRevision(currentRevision)} but you based your update on ${shortRevision(params.baseRevision)}. Nothing was written. Call get_topic_note_context again and rebase your proposal.`,
					{ currentRevision },
				);
			}

			const draft = ensureFinalNewline(params.fullMarkdown);
			const draftMissingSections = missingSections(draft);
			if (draftMissingSections.length > 0) {
				return finish(
					"invalid",
					`Invalid draft: the complete topic note is missing these required sections: ${draftMissingSections.join(", ")}. Nothing was written.`,
					{ missingSections: draftMissingSections },
				);
			}

			// --- human approval, serialized against every other popup tool ----
			// If the learner accidentally removes a required heading, reopen their
			// exact edited text rather than discarding it.
			let finalContent = draft;
			for (;;) {
				const approved = await withUILock(async () => {
					if (signal?.aborted) return undefined;
					const heading = `Topic note: ${title} — ${params.changeSummary.trim() || "review and approve"}`;
					return ctx.ui.editor(heading, finalContent, { signal });
				});

				if (approved === undefined) {
					return finish("cancelled", `Update to ${resolved.relativePath} cancelled by the user. Nothing was written.`, {
						currentRevision,
					});
				}

				finalContent = ensureFinalNewline(approved);
				const finalMissingSections = missingSections(finalContent);
				if (finalMissingSections.length === 0) break;
				ctx.ui.notify(
					`Not saved yet. Restore these required headings, then submit again: ${finalMissingSections.join(", ")}`,
					"warning",
				);
			}
			if (before !== undefined && finalContent === before) {
				const currentLogFile = sourceLogFile();
				curatedThisSession = true;
				try {
					pi.appendEntry(UPDATE_ENTRY_TYPE, {
						status: "unchanged",
						topicId: resolved.topicId,
						title,
						relativePath: resolved.relativePath,
						revision: currentRevision,
						changeSummary: params.changeSummary,
						incorporatedPendingSessionIds: params.incorporatedPendingSessionIds ?? [],
						lessonLogPath: currentLogFile,
						sessionId: ctx.sessionManager.getSessionId(),
						sessionFile: ctx.sessionManager.getSessionFile() ?? null,
						leafId: ctx.sessionManager.getLeafId(),
						at: new Date().toISOString(),
					});
				} catch {
					// best effort
				}
				persistState({ dirty: false, topicId: resolved.topicId, topicTitle: title }, "topic-note-approved-unchanged");
				let clearedMarkers: string[] = [];
				try {
					clearedMarkers = await clearPendingMarkers(ctx.cwd, CONFIG_DIR_NAME, {
						sessionId: ctx.sessionManager.getSessionId(),
						sessionIds: params.incorporatedPendingSessionIds ?? [],
						logFile: currentLogFile ?? undefined,
					});
					await refreshPendingCount(ctx);
				} catch {
					// best effort
				}
				setStatus(ctx);
				return finish("unchanged", `No change: the approved content is identical to ${resolved.relativePath}.`, {
					currentRevision,
					revision: currentRevision,
					clearedPendingMarkers: clearedMarkers.length,
				});
			}

			// --- write window: queued so built-in edit/write cannot interleave -
			const outcome = await withFileMutationQueue(resolved.absolutePath, async () => {
				// Re-verify: the file may have moved while the editor was open.
				const now = await readFileIfExists(resolved.absolutePath);
				const nowRevision = revisionOf(now);
				if (nowRevision !== params.baseRevision) {
					return { conflict: true as const, nowRevision };
				}

				await fsp.mkdir(path.dirname(resolved.absolutePath), { recursive: true });

				let backupPath: string | undefined;
				if (now !== undefined) {
					backupPath = path.resolve(
						ctx.cwd,
						CONFIG_DIR_NAME,
						".state",
						"topic-notes",
						"backups",
						`${resolved.topicId}.md.bak`,
					);
					await atomicWriteFile(backupPath, now); // exactly one .bak, always the immediately previous content
				}

				await atomicWriteFile(resolved.absolutePath, finalContent);
				return { conflict: false as const, backupPath, previousRevision: nowRevision };
			});

			if (outcome.conflict) {
				return finish(
					"conflict",
					`Conflict: ${resolved.relativePath} changed while the approval editor was open (now ${shortRevision(outcome.nowRevision)}). Nothing was written.`,
					{ currentRevision: outcome.nowRevision },
				);
			}

			const newRevision = revisionOf(finalContent);
			const editedByUser = finalContent !== draft;
			const currentLogFile = sourceLogFile();
			const lessonRelative = relativeIfInside(ctx.cwd, currentLogFile);

			// Provenance entry: technical, not conversational, and not sent to the LLM.
			try {
				pi.appendEntry(UPDATE_ENTRY_TYPE, {
					status: "written",
					topicId: resolved.topicId,
					title,
					relativePath: resolved.relativePath,
					absolutePath: resolved.absolutePath,
					baseRevision: params.baseRevision,
					previousRevision: outcome.previousRevision,
					revision: newRevision,
					bytes: Buffer.byteLength(finalContent, "utf8"),
					editedByUser,
					changeSummary: params.changeSummary,
					incorporatedPendingSessionIds: params.incorporatedPendingSessionIds ?? [],
					backupPath: outcome.backupPath ?? null,
					lessonLogPath: currentLogFile,
					lessonLogRelativePath: lessonRelative ?? null,
					sessionId: ctx.sessionManager.getSessionId(),
					sessionFile: ctx.sessionManager.getSessionFile() ?? null,
					leafId: ctx.sessionManager.getLeafId(),
					at: new Date().toISOString(),
				});
			} catch {
				// best effort
			}

			// The lesson is now recorded: clean this session and matching markers.
			curatedThisSession = true;
			persistState({ dirty: false, topicId: resolved.topicId, topicTitle: title }, "topic-note-written");
			let clearedMarkers: string[] = [];
			try {
				clearedMarkers = await clearPendingMarkers(ctx.cwd, CONFIG_DIR_NAME, {
					sessionId: ctx.sessionManager.getSessionId(),
					sessionIds: params.incorporatedPendingSessionIds ?? [],
					logFile: currentLogFile ?? undefined,
				});
				await refreshPendingCount(ctx);
			} catch {
				// best effort
			}
			setStatus(ctx);

			return finish(
				"written",
				`Wrote ${resolved.relativePath} (${shortRevision(params.baseRevision)} -> ${shortRevision(newRevision)}${editedByUser ? ", user edited your draft before approving" : ""}).`,
				{
					revision: newRevision,
					previousRevision: outcome.previousRevision,
					editedByUser,
					backupPath: outcome.backupPath ?? null,
					clearedPendingMarkers: clearedMarkers.length,
				},
			);
		},

		renderCall(args, theme) {
			const a = args as { topicId?: string; changeSummary?: string };
			let text = theme.fg("toolTitle", theme.bold("topic note update ")) + theme.fg("muted", slugifyTopicId(a?.topicId) || "?");
			if (a?.changeSummary) text += theme.fg("dim", ` — ${a.changeSummary}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as { status?: UpdateStatus; message?: string; relativePath?: string; revision?: string } | undefined;
			if (!d) return new Text(theme.fg("dim", "done"), 0, 0);
			switch (d.status) {
				case "written":
					return new Text(
						theme.fg("success", "✓ written ") + theme.fg("dim", `${d.relativePath} @ ${shortRevision(d.revision ?? "")}`),
						0,
						0,
					);
				case "unchanged":
					return new Text(theme.fg("dim", `= unchanged ${d.relativePath}`), 0, 0);
				case "cancelled":
					return new Text(theme.fg("warning", "✗ cancelled — nothing written"), 0, 0);
				case "conflict":
					return new Text(theme.fg("error", `✗ conflict — ${d.message ?? "nothing written"}`), 0, 0);
				case "invalid":
					return new Text(theme.fg("error", `✗ invalid — ${d.message ?? "nothing written"}`), 0, 0);
				default:
					return new Text(theme.fg("warning", d.message ?? "unavailable"), 0, 0);
			}
		},
	});

	// =========================================================================
	// Commands
	// =========================================================================

	pi.registerCommand("topic-update", {
		description: "Ask the agent to fold this lesson into the durable topic note (optionally: /topic-update <topic>)",
		handler: async (args, ctx) => {
			const requested = args?.trim() ?? "";
			// Never mutate the session while a turn is in flight.
			await ctx.waitForIdle();
			syncLogFileFromSession(ctx);

			const currentLogFile = sourceLogFile();
			const lessonRelative = relativeIfInside(ctx.cwd, currentLogFile);
			const requestedTopicId = requested ? slugifyTopicId(requested) : undefined;
			let pendingMarkers: Array<{
				sessionId: string;
				topicId?: string;
				topicTitle?: string;
				logFile?: string;
				lessonRelative?: string;
			}> = [];
			try {
				const currentId = ctx.sessionManager.getSessionId();
				pendingMarkers = (await readPendingMarkers(ctx.cwd, CONFIG_DIR_NAME))
					.filter(({ marker }) => marker.sessionId !== currentId)
					.map(({ marker }) => ({
						sessionId: marker.sessionId,
						topicId: marker.topicId ?? inferTopicIdFromLessonPath(ctx.cwd, marker.logFile),
						topicTitle: marker.topicTitle,
						logFile: marker.logFile,
						lessonRelative: relativeIfInside(ctx.cwd, marker.logFile),
					}))
					.filter((marker) => !requestedTopicId || marker.topicId === requestedTopicId);
			} catch {
				pendingMarkers = [];
			}
			const lines: string[] = [];
			lines.push("Update the durable topic note for what we just covered.");
			lines.push("");
			lines.push("1. Load the `topic-notes` skill and follow it (if it is not available, proceed with the steps below).");
			if (requested) {
				lines.push(`2. The topic is: "${requested}". Normalize it to a broad lower-kebab topic id.`);
			} else if (knownTopicId) {
				lines.push(
					`2. The topic for this session appears to be \`${knownTopicId}\`${knownTopicTitle ? ` ("${knownTopicTitle}")` : ""}. Confirm that is the right broad topic; if it clearly is not, infer the correct one from the conversation, and if it is genuinely ambiguous ask me with ask_user_question.`,
				);
			} else {
				lines.push(
					"2. Infer the broad topic of this session (a subject area like `graph-theory`, not a single lesson). If it is genuinely ambiguous, ask me with ask_user_question before continuing.",
				);
			}
			lines.push(
				lessonRelative
					? `3. Read the current lesson log at \`${lessonRelative}\` for what actually happened in this session.`
					: "3. There is no linked current lesson log; use this conversation plus any pending lesson logs listed below.",
			);
			if (pendingMarkers.length > 0) {
				lines.push("Pending lessons available for recovery:");
				for (const marker of pendingMarkers) {
					lines.push(
						`- session ${marker.sessionId}; topic ${marker.topicId ?? "unknown"}; lesson ${marker.lessonRelative ?? marker.logFile ?? "(no log)"}`,
					);
				}
				lines.push(
					"Read every pending lesson log that belongs to the selected topic. When proposing, pass only the session ids you actually incorporated as `incorporatedPendingSessionIds`.",
				);
			}
			lines.push("4. Call `get_topic_note_context` for that topic to read the existing note, revision, and any additional pending lessons.");
			lines.push(
				"5. Merge the new understanding into the note — keep every canonical section, integrate rather than append, prune what is now wrong, and record misconceptions I actually had and gaps that remain.",
			);
			lines.push(
				"6. Call `propose_topic_note_update` with the COMPLETE new markdown, the revision as `baseRevision`, and a one-line `changeSummary`. I will review it in the editor.",
			);
			lines.push("");
			lines.push("Do not use write or edit inside `topics/` — those calls are blocked.");

			await pi.sendUserMessage(lines.join("\n"));
		},
		getArgumentCompletions: (prefix: string) => {
			const items: Array<{ value: string; label: string }> = [];
			if (knownTopicId) items.push({ value: knownTopicId, label: `${knownTopicId} (current session)` });
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
	});

	pi.registerCommand("topic-dismiss", {
		description: "Dismiss a stale pending lesson marker: /topic-dismiss <session-id|all>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			await ctx.waitForIdle();
			const currentId = ctx.sessionManager.getSessionId();
			const markers = (await readPendingMarkers(ctx.cwd, CONFIG_DIR_NAME)).filter(
				({ marker }) => marker.sessionId !== currentId,
			);
			const requested = args.trim();
			if (!requested) {
				const ids = markers.map(({ marker }) => `${marker.sessionId} (${marker.topicId ?? marker.logFile ?? "unknown"})`);
				ctx.ui.notify(
					ids.length > 0 ? `Usage: /topic-dismiss <session-id|all>. Pending: ${ids.join(", ")}` : "No earlier pending lesson markers.",
					ids.length > 0 ? "warning" : "info",
				);
				return;
			}
			const selected = requested === "all"
				? markers
				: markers.filter(({ marker }) => marker.sessionId === requested || marker.sessionId.startsWith(requested));
			if (selected.length === 0) {
				ctx.ui.notify(`No pending marker matches: ${requested}`, "warning");
				return;
			}
			if (requested !== "all" && selected.length > 1) {
				ctx.ui.notify(`Session-id prefix is ambiguous: ${requested}`, "warning");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Dismiss pending lesson recovery?",
				`This removes ${selected.length} recovery marker(s) without updating a topic note. Lesson Markdown files are not deleted.`,
			);
			if (!confirmed) return;
			const removed = await clearPendingMarkers(ctx.cwd, CONFIG_DIR_NAME, {
				sessionIds: selected.map(({ marker }) => marker.sessionId),
			});
			await refreshPendingCount(ctx);
			setStatus(ctx);
			ctx.ui.notify(`Dismissed ${removed.length} pending marker(s).`, "info");
		},
	});

	pi.registerCommand("topic-status", {
		description: "Show whether this lesson still needs to be folded into a topic note",
		handler: async (_args, ctx) => {
			syncLogFileFromSession(ctx);
			const currentLogFile = sourceLogFile();
			const lessonRelative = relativeIfInside(ctx.cwd, currentLogFile) ?? currentLogFile ?? undefined;
			const parts: string[] = [];
			parts.push(dirty ? "pending: this session has unrecorded learning" : "clean: nothing pending in this session");
			parts.push(lessonRelative ? `lesson: ${lessonRelative}` : "lesson: none linked (md-log not active)");
			parts.push(knownTopicId ? `topic: ${knownTopicId}` : "topic: not identified yet");

			try {
				const currentId = ctx.sessionManager.getSessionId();
				const markers = (await readPendingMarkers(ctx.cwd, CONFIG_DIR_NAME)).filter((m) => m.marker.sessionId !== currentId);
				pendingFromPriorSessions = markers.length;
				if (markers.length > 0) {
					parts.push(
						`earlier pending sessions: ${markers.length} (${markers
							.map((m) => m.marker.topicId ?? (m.marker.logFile ? path.basename(m.marker.logFile) : m.marker.sessionId))
							.join(", ")})`,
					);
				}
			} catch {
				// ignore
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`topic-notes — ${parts.join(" · ")}`, dirty || pendingFromPriorSessions > 0 ? "warning" : "info");
				setStatus(ctx);
			}
		},
	});
}
