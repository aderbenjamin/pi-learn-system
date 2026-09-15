# topic-notes

Durable, per-topic learning notes with a human approval gate.

`md-log` records *what happened* in a lesson (chronological transcript).
`topic-notes` records *what is now known* about a subject: one living markdown
file per topic at `<cwd>/topics/<topic-id>.md`, rewritten wholesale each time,
always through a review step.

## Files

| File | Role |
|---|---|
| `index.ts` | Auto-discovered entry point: tools, commands, event handlers, state. |
| `core.ts` | Pure helpers — slugging, path confinement, hashing, template, atomic writes, pending markers. No Pi imports. |
| `core.test.ts` | `node:test` suite for `core.ts`. Run with `node core.test.ts`. No npm deps, no Pi UI. |

## Tools

### `get_topic_note_context({ topicId, title })`

Reads `topics/<slug>.md`, or returns a fresh section template when it does not
exist. `details` carries `topicId`, `title`, `exists`, `relativePath`,
`absolutePath`, `revision` (sha256, or the literal `missing`), `content`,
`sections`, `missingSections`, `lessonLogPath` / `lessonLogRelativePath`
(inferred from the last `md-log` custom entry), matching `pendingLessons`,
`dirty`, `sessionId`, `sessionFile`, and `leafId`.

### `propose_topic_note_update({ topicId, title, baseRevision, fullMarkdown, changeSummary })`

The only sanctioned way to change anything under `topics/`:

1. Resolve `<cwd>/topics/<slug>.md` (slug can't contain `/`, `\` or `.`, and
   lexical plus realpath checks reject a `topics` directory or topic file
   symlinked outside the vault).
2. Refuse outright unless interactive editor approval is available (TUI or an RPC client implementing Pi's UI protocol) — approval is not optional.
3. Compare the file's current sha256 against `baseRevision`; mismatch ⇒
   `conflict`, editor never opens, nothing written.
4. Reject a draft that omits any canonical section.
5. Open the **complete** draft in `ctx.ui.editor` under the shared
   `__piSharedUiLock` global mutex (so `quiz` / `ask_user_question` popups can't
   collide with it). `undefined` ⇒ `cancelled`, nothing written.
6. Revalidate the edited document's sections, then inside
   `withFileMutationQueue(absolutePath, ...)`: re-verify the hash (the file may
   have changed while the editor was open), copy the previous content to a
   single `.pi/.state/topic-notes/backups/<topic>.md.bak`, then write atomically
   (temp file + `rename`).
7. Append a `topic-note-update` custom entry with technical provenance
   (hashes, byte count, `editedByUser`, backup path, lesson log, session/leaf
   ids), mark the session clean, clear matching pending markers, refresh status.

Result statuses: `written` | `unchanged` | `cancelled` | `conflict` | `invalid` | `unavailable`.

The optional `incorporatedPendingSessionIds` parameter names only prior lesson
markers whose logs were actually merged. This prevents one update from silently
clearing unrelated or unprocessed lessons in the same broad topic.

## Commands

- `/topic-update [topic]` — waits for idle, then sends a *normal user message*
  instructing the agent to load the `topic-notes` skill, settle on a broad topic
  (given, inferred, or asked via `ask_user_question`), read the active lesson
  log, call `get_topic_note_context`, and propose a merged update.
- `/topic-status` — non-blocking report of pending/clean, active lesson log,
  known topic, and markers left by earlier sessions.
- `/topic-dismiss <session-id|all>` — after confirmation, discard stale recovery
  markers without deleting lesson Markdown.

## Guard

`tool_call` blocks built-in `write` and `edit` whose `path` lands inside
`topics/`. Resolution strips a leading `@`, resolves against `cwd`, checks
lexically (catching absolute paths and `../` traversal), then re-checks after
`realpath`-ing the deepest existing ancestor, so symlinked aliases are caught
too. It also conservatively blocks model-issued `bash` commands that both
reference `topics/` and contain a likely mutation primitive or output redirect.
This is a guardrail, not a security sandbox. The extension's own writes go
through `node:fs` directly and are unaffected.

## Dirty / pending tracking

- Active lesson log is re-read from the latest `md-log` custom entry on the
  active session branch whenever it matters, so linking, unlinking, forks, and
  tree navigation are reflected immediately. If a
  linked lesson becomes dirty and is then unlinked, its provenance is retained.
- The first substantive assistant lesson text, or a successful `quiz` /
  `ask_user_question` result while a lesson log is linked, marks the session
  dirty. Successful curation suppresses the closing acknowledgement from
  immediately making the lesson dirty again. Without `md-log` the extension
  degrades gracefully: provenance fields are `undefined` and nothing goes dirty.
- State changes are persisted once as a `topic-note-state` custom entry and
  replayed on `session_start`.
- Footer status lives under the `topic-notes` key. `agent_settled` only refreshes
  that status — it never opens a dialog.
- `session_shutdown` while dirty writes a **pending marker** (not a draft) to
  `.pi/.state/topic-notes/<sessionId>.json` via the same atomic temp+rename path.
  Failures are swallowed so shutdown is never blocked.
- The next `session_start` scans those markers and emits exactly one
  non-blocking notification plus a pending status.
- A successful update deletes the current session's marker, markers referencing
  the same lesson log, and only the explicit pending session ids the agent says
  it actually incorporated.

## Design notes

- `core.ts` deliberately imports nothing but `node:` builtins, which is what
  makes `node core.test.ts` work with Node's native type stripping — no
  `package.json`, no npm dependencies, no build step.
- The file-mutation queue wraps only the write window, not the interactive
  editor; holding it across a human's editing session would stall the built-in
  `edit`/`write` tools indefinitely. Correctness is preserved by re-hashing
  inside the queue.
- Exactly one ignored backup under `.pi/.state/topic-notes/backups/` is kept —
  always the content immediately preceding the last successful write. Session
  history holds the longer trail.
