/**
 * md-log — mirror the session to a markdown file for comfortable reading.
 *
 * Designed for long teaching/learning sessions where the terminal is hard on
 * the eyes and markdown/math/code don't render. The linked .md file is meant
 * to be viewed rendered (e.g. in Obsidian), so assistant text with $...$ math,
 * code blocks, and markdown all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (lesson prose)
 *   - quiz / ask_user_question Q&A blocks
 * Other tools (bash, read, write, edit, ...) are omitted.
 *
 * Quiz/ask questions are written BEFORE the user answers (on tool_call), so the
 * reader sees the question appear live; the answer + feedback are appended on
 * tool_result. The question block NEVER contains the correct answer or
 * explanation (the user reads this file live).
 *
 * Commands:
 *   /learn <topic> | <subtopic> — Create and link a structured lesson, then start teaching.
 *   /md-log <filepath>          — Link a markdown file and backfill the session.
 *   /md-unlog                   — Stop logging.
 *
 * Append-only. No send-back-to-agent functionality (that lived in the old
 * .md-link extension this was modeled on), except `/learn`, which sends the
 * initial teaching request after the new lesson file has been linked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/g, "");
}

function localDate(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseLearnArgs(raw: string): { topic: string; subtopic: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { topic: "", subtopic: "" };
	if (trimmed.includes("|")) {
		const [topic, ...rest] = trimmed.split("|");
		return { topic: topic.trim(), subtopic: rest.join("|").trim() };
	}
	const [topic, ...rest] = trimmed.split(/\s+/);
	return { topic: topic || "", subtopic: rest.join(" ").trim() };
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;

	// --- State restoration on session restart ---

	pi.on("session_start", async (_event, ctx) => {
		let lastLinkData: { file: string | null } | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "md-log") {
				lastLinkData = entry.data as { file: string | null } | undefined;
			}
		}
		logFile = lastLinkData?.file ?? null;
		setLogStatus(ctx, logFile);
	});

	// --- Serialization: events can fire close together; keep appends ordered ---

	let writeLock: Promise<void> = Promise.resolve();
	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = writeLock;
		let release: () => void;
		writeLock = new Promise<void>((r) => {
			release = r;
		});
		return prev.then(fn).finally(() => release!());
	}

	function appendToFile(text: string): void {
		if (!logFile) return;
		try {
			let current = "";
			if (fs.existsSync(logFile)) {
				current = fs.readFileSync(logFile, "utf-8");
			}
			const prefix = current.trim().length > 0 ? "\n\n" : "";
			fs.writeFileSync(logFile, current + prefix + text + "\n", "utf-8");
		} catch {
			// File may have been deleted externally; ignore.
		}
	}

	function setLogStatus(ctx: any, file: string | null): void {
		if (!ctx.hasUI) return;
		if (!file) {
			ctx.ui.setStatus("md-log", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(
			"md-log",
			theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(file)),
		);
	}

	function linkLogFile(resolved: string, ctx: any): { messageCount: number; wrote: boolean } {
		logFile = resolved;
		pi.appendEntry("md-log", { file: resolved });
		const result = backfill(ctx);
		setLogStatus(ctx, resolved);
		return result;
	}

	// --- Formatting ---

	function callout(type: string, title: string, bodyLines: string[]): string {
		const lines = [`> [!${type}] ${title}`];
		for (const line of bodyLines) {
			lines.push(line.length === 0 ? ">" : `> ${line}`);
		}
		return lines.join("\n");
	}

	function userBlock(text: string): string {
		return `> [!quote] YOU\n\n${text}`;
	}

	// Skill declarations (`<skill name="..." ...> ...whole SKILL.md... </skill>`)
	// are system-injected context, not user prose. Replace each with a compact
	// callout noting the skill was loaded, so the log keeps the signal without
	// the noise. Runs on already-trimmed text.
	function stripSkillBlocks(text: string): string {
		return text.replace(
			/<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
			(_match, attrs: string) => {
				const name = /name="([^"]+)"/.exec(attrs)?.[1];
				return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
			},
		);
	}

	function assistantBlock(text: string): string {
		return `> [!abstract] PI\n\n${text}`;
	}

	function optionsList(options: Array<{ label: string }>): string[] {
		return options.map((o, i) => `${i + 1}. ${o.label}`);
	}

	function questionCallout(label: string, question: string, context: string | undefined, options: Array<{ label: string }>): string {
		const body: string[] = [];
		for (const line of question.split("\n")) body.push(line);
		if (context) {
			body.push("");
			for (const line of context.split("\n")) body.push(line);
		}
		if (options.length > 0) {
			body.push("");
			body.push(...optionsList(options));
		}
		return callout("question", label, body);
	}

	function answerCalloutQuiz(details: any): string {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("warning", "Quiz — cancelled", ["(user skipped)"]);
		}
		if (status === "unavailable") {
			return callout("warning", "Quiz — unavailable", [details?.message || ""]);
		}
		// "I don't know" is neither correct nor incorrect — it's a distinct signal,
		// so it never renders as a red ✗.
		const dontKnow = details?.dontKnow === true;
		const correct = details?.correct === true;
		const type = dontKnow ? "question" : correct ? "success" : "failure";
		const title = dontKnow
			? "Quiz — I don't know"
			: correct
				? "Quiz — correct ✓"
				: "Quiz — incorrect ✗";
		const body: string[] = [];

		if (dontKnow) {
			body.push("Your answer: I don't know");
		} else {
			const answers: any[] = details?.answers || [];
			const sel = answers.map((a) => `${a.index}. ${a.label}`).join(", ") || "(none)";
			body.push(`Your answer: ${sel}`);
		}

		const correctIndices: number[] = details?.correctIndices || [];
		const correctStr = correctIndices.map((i) => `${i}`).join(", ");
		body.push(`Correct answer: ${correctStr}`);

		// Optional free-text note the user typed in the always-present note field.
		// Only present (in details) when non-empty, so no guard for empty strings.
		if (details?.note) {
			body.push("");
			const noteLines = String(details.note).split("\n");
			body.push(`Note: ${noteLines[0]}`);
			for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i]);
		}

		if (details?.explanation) {
			body.push("");
			for (const line of String(details.explanation).split("\n")) body.push(line);
		}
		return callout(type, title, body);
	}

	function answerCalloutAsk(details: any): string {
		const status = details?.status;
		if (status === "cancelled") {
			return callout("warning", "Question — cancelled", ["(user skipped)"]);
		}
		if (status === "unavailable") {
			return callout("warning", "Question — unavailable", [details?.message || ""]);
		}
		const answers: any[] = details?.answers || [];
		const body: string[] = answers.map((a) => {
			if (a.type === "other") return `Other: ${a.label}`;
			if (a.type === "text") return a.label;
			return `${a.index}. ${a.label}`;
		});
		if (body.length === 0) body.push("(no answer)");
		return callout("example", "Answer", body);
	}

	// --- Event handlers ---

	pi.on("message_end", async (event, _ctx) => {
		if (!logFile) return;
		const msg = event.message;
		if (!msg || !("role" in msg)) return;

		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: "";
			const trimmed = stripSkillBlocks(text.trim());
			if (!trimmed) return;
			await withLock(() => appendToFile(userBlock(trimmed)));
			return;
		}

		if (msg.role === "assistant") {
			const textParts = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => (c.text as string).trim())
				.filter((t: string) => t.length > 0);
			if (textParts.length === 0) return;
			await withLock(() => appendToFile(assistantBlock(textParts.join("\n\n"))));
			return;
		}
		// toolResult messages are handled by the tool_result event (for QA tools).
	});

	// ask_user_question never shuffles its options, so the tool_call args are
	// already the true display order — safe to write the question live, before
	// the user answers.
	pi.on("tool_call", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName !== "ask_user_question") return;
		const input = (event as any).input || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options: Array<{ label: string }> = Array.isArray(input.options) ? input.options : [];
		const block = questionCallout("Question", question, context, options);
		await withLock(() => appendToFile(block));
	});

	// quiz DOES shuffle its options inside execute(), so the tool_call args are
	// the pre-shuffle author order — NOT what the user is shown. quiz emits an
	// onUpdate() with the true (post-shuffle) order before it blocks on the
	// user's answer; wait for that instead so the logged order always matches
	// what's on screen. Guard against duplicate writes if multiple updates fire
	// for the same call.
	const loggedQuizQuestion = new Set<string>();
	pi.on("tool_execution_update", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (toolName !== "quiz") return;
		const toolCallId = (event as any).toolCallId;
		if (loggedQuizQuestion.has(toolCallId)) return;
		const shuffled = (event as any).partialResult?.details?.options as Array<{ index: number; label: string }> | undefined;
		if (!shuffled || shuffled.length === 0) return;
		loggedQuizQuestion.add(toolCallId);
		const input = (event as any).args || {};
		const question: string = input.question || "";
		const context: string | undefined = input.details?.trim() || undefined;
		const options = shuffled.map((o) => ({ label: o.label }));
		const block = questionCallout("Quiz", question, context, options);
		await withLock(() => appendToFile(block));
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (!logFile) return;
		const toolName = (event as any).toolName;
		if (!QA_TOOLS.has(toolName)) return;
		const details = (event as any).details;
		const block = toolName === "quiz"
			? answerCalloutQuiz(details)
			: answerCalloutAsk(details);
		await withLock(() => appendToFile(block));
	});

	// --- Commands ---

	pi.registerCommand("learn", {
		description: "Create, link, and start a structured teaching session",
		getArgumentCompletions: () => null,
		handler: async (args, ctx: any) => {
			if (!ctx.hasUI) return;
			if (typeof ctx.waitForIdle === "function") await ctx.waitForIdle();

			let { topic, subtopic } = parseLearnArgs(args);
			if (!topic) {
				const answer = await ctx.ui.input("Broad topic", "e.g. SQL or linear algebra");
				if (answer === undefined) return;
				topic = answer.trim();
			}
			if (!subtopic) {
				const answer = await ctx.ui.input("Lesson subtopic", "e.g. joins or eigenvectors");
				if (answer === undefined) return;
				subtopic = answer.trim() || topic;
			}

			const topicId = slugify(topic);
			const subtopicId = slugify(subtopic);
			if (!topicId || !subtopicId) {
				ctx.ui.notify("Topic and subtopic must contain letters or numbers.", "error");
				return;
			}

			const hasConversation = ctx.sessionManager.getBranch().some((entry: any) =>
				entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"),
			);
			if (hasConversation) {
				const proceed = await ctx.ui.confirm(
					"Current session already has history",
					"The new lesson note will include the active conversation branch. Continue?",
				);
				if (!proceed) return;
			}

			const lessonDir = path.resolve(ctx.cwd, "lessons", topicId);
			fs.mkdirSync(lessonDir, { recursive: true });
			const date = localDate();
			let lessonFile = path.join(lessonDir, `${date}-${subtopicId}.md`);
			let suffix = 2;
			while (fs.existsSync(lessonFile)) {
				lessonFile = path.join(lessonDir, `${date}-${subtopicId}-${suffix}.md`);
				suffix++;
			}

			const heading = topic.toLowerCase() === subtopic.toLowerCase()
				? topic
				: `${topic} — ${subtopic}`;
			const initial = [
				"---",
				`topic: ${yamlString(topic)}`,
				`topic-id: ${topicId}`,
				`subtopic: ${yamlString(subtopic)}`,
				`date: ${date}`,
				"---",
				"",
				`# ${heading}`,
				"",
			].join("\n");
			fs.writeFileSync(lessonFile, initial, { encoding: "utf-8", flag: "wx" });

			const backfillResult = linkLogFile(lessonFile, ctx);
			// backfill() intentionally rebuilds an existing md-log from session
			// messages. For /learn, retain the structured lesson frontmatter/title
			// in front of that reconstructed history.
			if (backfillResult.wrote) {
				const backfilled = fs.readFileSync(lessonFile, "utf-8");
				fs.writeFileSync(lessonFile, `${initial.trimEnd()}\n\n${backfilled.trimStart()}`, "utf-8");
			}
			pi.setSessionName(`${topic}: ${subtopic}`);
			const relative = path.relative(ctx.cwd, lessonFile).split(path.sep).join("/");
			ctx.ui.notify(`Lesson linked: ${relative} (${backfillResult.messageCount} entries backfilled)`, "success");

			pi.sendUserMessage(
				[
					"Start a teaching session using the `teach` skill.",
					`Broad topic: ${topic}`,
					`Tentative subtopic: ${subtopic}`,
					`Lesson log: ${relative}`,
					"First make my desired learning outcome concrete, then probe, present a plan for approval, teach, and curate the resulting topic note at the natural end.",
				].join("\n"),
			);
		},
	});

	pi.registerCommand("md-log", {
		description: "Mirror the session to a markdown file (backfills history)",
		handler: async (args, ctx: any) => {
			const filepath = args.trim();
			if (!filepath) {
				ctx.ui.notify("Usage: /md-log <filepath>", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before linking.", "warning");
				return;
			}

			const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(ctx.cwd, filepath);

			// The file must already exist — /md-log links into an existing note,
			// it never creates one. This avoids silently scattering new files
			// (and parent directories) around the vault from a typo'd path.
			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`File does not exist: ${resolved}`, "error");
				return;
			}
			if (!fs.statSync(resolved).isFile()) {
				ctx.ui.notify(`Not a file: ${resolved}`, "error");
				return;
			}
			const existing = fs.readFileSync(resolved, "utf-8");
			if (existing.trim().length > 0) {
				const replace = await ctx.ui.confirm(
					"Replace existing note contents?",
					"/md-log backfills by rebuilding the file from the active session branch. The selected file is not empty; continuing will replace its current contents.",
				);
				if (!replace) {
					ctx.ui.notify("Link cancelled; the existing note was not changed.", "info");
					return;
				}
			}

			const result = linkLogFile(resolved, ctx);
			ctx.ui.notify(`Linked: ${resolved} (${result.messageCount} entries backfilled)`, "success");
		},
	});

	pi.registerCommand("md-unlog", {
		description: "Stop mirroring the session to a markdown file",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("No file linked", "warning");
				return;
			}
			const name = path.basename(logFile);
			logFile = null;
			pi.appendEntry("md-log", { file: null });
			setLogStatus(ctx, null);
			ctx.ui.notify(`Unlinked: ${name}`, "info");
		},
	});

	// --- Backfill ---

	function backfill(ctx: any): { messageCount: number; wrote: boolean } {
		if (!logFile) return { messageCount: 0, wrote: false };
		// getBranch() is already the ordered active root-to-leaf path. Using all
		// entries here can accidentally restore an abandoned branch after /tree
		// navigation or a fork.
		const chain: any[] = ctx.sessionManager.getBranch();
		if (chain.length === 0) return { messageCount: 0, wrote: false };

		// Track tool-call args from assistant messages so we can pair with results.
		const toolCallArgs = new Map<string, { name: string; args: any }>();

		const blocks: string[] = [];
		let count = 0;
		for (const entry of chain) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg || !("role" in msg)) continue;
			count++;

			if (msg.role === "user") {
				const text = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
						: "";
				const trimmed = stripSkillBlocks(text.trim());
				if (trimmed) blocks.push(userBlock(trimmed));
				continue;
			}

			if (msg.role === "assistant") {
				// Index tool calls for later pairing.
				for (const c of msg.content || []) {
					if (c.type === "toolCall" && QA_TOOLS.has(c.name)) {
						toolCallArgs.set(c.id, { name: c.name, args: c.arguments });
					}
				}
				const textParts = (msg.content || [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => (c.text as string).trim())
					.filter((t: string) => t.length > 0);
				if (textParts.length > 0) blocks.push(assistantBlock(textParts.join("\n\n")));
				continue;
			}

			if (msg.role === "toolResult") {
				if (!QA_TOOLS.has(msg.toolName)) continue;
				const tc = toolCallArgs.get(msg.toolCallId);
				// Question block. For quiz, use the persisted result's `details.options`
				// — the TRUE post-shuffle display order the user actually saw — rather
				// than the original tool-call args, which are the pre-shuffle author
				// order and can mismatch what's on screen. ask_user_question never
				// shuffles, so its tool-call args are already the true order.
				if (tc) {
					const a = tc.args || {};
					const label = tc.name === "quiz" ? "Quiz" : "Question";
					const shuffled = msg.toolName === "quiz"
						? (msg.details?.options as Array<{ index: number; label: string }> | undefined)
						: undefined;
					const options = shuffled && shuffled.length > 0
						? shuffled.map((o) => ({ label: o.label }))
						: (Array.isArray(a.options) ? a.options : []);
					blocks.push(questionCallout(label, a.question || "", a.details?.trim() || undefined, options));
				}
				if (msg.toolName === "quiz") {
					blocks.push(answerCalloutQuiz(msg.details));
				} else {
					blocks.push(answerCalloutAsk(msg.details));
				}
				continue;
			}
		}

		let wrote = false;
		if (blocks.length > 0) {
			try {
				fs.writeFileSync(logFile, blocks.join("\n\n") + "\n", "utf-8");
				wrote = true;
			} catch {
				// ignore
			}
		}
		return { messageCount: count, wrote };
	}
}
