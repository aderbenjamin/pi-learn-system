#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import registerMdLog from "../extensions/md-log.ts";

interface HarnessOptions {
	entries?: any[];
	confirm?: boolean;
}

function createHarness(cwd: string, options: HarnessOptions = {}) {
	const commands = new Map<string, any>();
	const entries = [...(options.entries ?? [])];
	const appended: Array<{ customType: string; data: any }> = [];
	let sentMessage = "";
	let sessionName = "";

	const pi: any = {
		on() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		appendEntry(customType: string, data: any) {
			appended.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		sendUserMessage(message: string) {
			sentMessage = message;
		},
	};
	registerMdLog(pi);

	const ctx: any = {
		cwd,
		hasUI: true,
		waitForIdle: async () => {},
		isIdle: () => true,
		sessionManager: {
			getBranch: () => entries,
		},
		ui: {
			confirm: async () => options.confirm ?? true,
			input: async () => {
				throw new Error("unexpected input prompt");
			},
			notify() {},
			setStatus() {},
			theme: { fg: (_name: string, text: string) => text },
		},
	};

	return {
		commands,
		ctx,
		entries,
		appended,
		get sentMessage() {
			return sentMessage;
		},
		get sessionName() {
			return sessionName;
		},
	};
}

async function withTempDir(fn: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(path.join(tmpdir(), "md-log-test-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("/learn creates, links, names, and starts a structured lesson", async () => {
	await withTempDir(async (cwd) => {
		const h = createHarness(cwd);
		await h.commands.get("learn").handler("SQL | joins", h.ctx);

		const dir = path.join(cwd, "lessons", "sql");
		const [name] = await import("node:fs/promises").then((fs) => fs.readdir(dir));
		const lesson = path.join(dir, name);
		const content = await readFile(lesson, "utf8");
		assert.match(content, /^---\ntopic: "SQL"\ntopic-id: sql\nsubtopic: "joins"\ndate: \d{4}-\d{2}-\d{2}\n---\n\n# SQL — joins\n$/);
		assert.equal(h.sessionName, "SQL: joins");
		assert.match(h.sentMessage, /Start a teaching session using the `teach` skill/);
		assert.equal(h.appended.at(-1)?.customType, "md-log");
		assert.equal(h.appended.at(-1)?.data.file, lesson);
	});
});

test("/learn does not duplicate its preamble when history produces no log blocks", async () => {
	await withTempDir(async (cwd) => {
		const entries = [{
			type: "message",
			id: "assistant-tool-only",
			parentId: null,
			message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "read", arguments: {} }] },
		}];
		const h = createHarness(cwd, { entries, confirm: true });
		await h.commands.get("learn").handler("SQL | joins", h.ctx);
		const dir = path.join(cwd, "lessons", "sql");
		const [name] = await import("node:fs/promises").then((fs) => fs.readdir(dir));
		const content = await readFile(path.join(dir, name), "utf8");
		assert.equal((content.match(/^---$/gm) ?? []).length, 2, "exactly one YAML frontmatter block");
		assert.equal((content.match(/^# SQL — joins$/gm) ?? []).length, 1);
	});
});

test("/md-log refuses to overwrite a non-empty note without confirmation", async () => {
	await withTempDir(async (cwd) => {
		const note = path.join(cwd, "existing.md");
		await writeFile(note, "Keep this content.\n", "utf8");
		const entries = [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Session text" } }];
		const h = createHarness(cwd, { entries, confirm: false });
		await h.commands.get("md-log").handler("existing.md", h.ctx);
		assert.equal(await readFile(note, "utf8"), "Keep this content.\n");
		assert.equal(h.appended.length, 0);
	});
});

test("/md-log replaces a non-empty note only after explicit confirmation", async () => {
	await withTempDir(async (cwd) => {
		const note = path.join(cwd, "existing.md");
		await writeFile(note, "Replace me.\n", "utf8");
		const entries = [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Session text" } }];
		const h = createHarness(cwd, { entries, confirm: true });
		await h.commands.get("md-log").handler("existing.md", h.ctx);
		const content = await readFile(note, "utf8");
		assert.doesNotMatch(content, /Replace me/);
		assert.match(content, /Session text/);
		assert.equal(h.appended.at(-1)?.customType, "md-log");
	});
});
