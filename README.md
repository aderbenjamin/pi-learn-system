# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This is a personal system I built for myself, shared as-is. Built as a pi configuration: the teaching philosophy encoded in a skill, a few small extensions, and agent definitions.

## What's in it

- `skills/teach/` — the philosophy and the probe → plan → teach → curate process
- `skills/topic-notes/` — distils a lesson into the learner's living broad-topic note
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `extensions/ask-user-question.ts` — the agent asks you questions through a UI popup
- `extensions/quiz.ts` — graded questions with instant feedback (✓/✗, correct answer, explanation)
- `extensions/md-log.ts` — links a markdown file to the session and provides `/learn`
- `extensions/topic-notes/` — editable topic-note approval, safe writes, pending state, and `/topic-update`
- `extensions/visual-tools/` — tools for visualization subagents
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to

## Install

This repo **is** a `.pi` directory. From your learning project's root:

```bash
git clone https://github.com/aderbenjamin/pi-learn-system .pi
cp .pi/AGENTS.example.md AGENTS.md
```

Then open pi in that directory. (Or copy the pieces you want into your existing project config.)

`AGENTS.example.md` contains the cumulative learning-vault conventions. Copy it to the learning-project root as shown above so Pi loads it as always-on context. Keep the resulting root `AGENTS.md` and your personal lesson/topic notes outside the `.pi` harness repository.

## Learning workflow

From a fresh or intentionally reused Pi session:

```text
/learn SQL | joins
```

This creates and links `lessons/sql/<date>-joins.md`, names the Pi session, and asks the teaching agent to clarify the concrete goal before probing. If you already have a note, `/md-log <existing-file>` still links it directly. Because backfill rebuilds the file from the active session branch, Pi asks for explicit confirmation before replacing a non-empty note.

At a natural lesson end, the teaching skill loads `topic-notes` and submits the complete merged `topics/sql.md` through an editable approval screen. Submit the editor to save; cancel it to leave the note and pending state unchanged. Use the deterministic fallback at any time:

```text
/topic-update sql
/topic-status
/topic-dismiss <stale-session-id|all>   # discard recovery markers only
```

Topic notes are living documents, not transcripts. The model is blocked from ordinary `write`/`edit` operations in `topics/**`; approved updates go through the topic-note extension with revision checks and atomic writes. Interrupted work is recorded as a pending marker and resurfaced in a later interactive session.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- A subagent implementation, so the system can spawn the researcher and the visual makers. Recommended: [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) (tmux only). With it, everything works out of the box. Any other implementation works too, but expect to adapt the agent definitions, e.g. `agents/researcher.md` lists `safe_bash` in its tools, which is specific to that extension.
- `ask-user-question` — use the copy bundled here. If your setup already has an `ask-user-question` extension, use **this** one in its place. Popups from different extensions serialize through a shared UI lock, which only works when it's the same implementation.

## Development checks

From the learning-project root:

```bash
node .pi/tests/md-log.test.ts
node .pi/extensions/topic-notes/core.test.ts
```

These exercise structured lesson creation/backfill safety plus topic path, revision, template, shell-guard, atomic-write, and pending-marker helpers without making model calls.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.
