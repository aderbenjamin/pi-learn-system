---
name: topic-notes
description: Curate a completed or paused teaching session into one living `topics/<broad-topic>.md` knowledge note. Use when a lesson reaches its goal, the learner asks to stop or wrap up, `/topic-update` is invoked, or an uncurated lesson must be recovered. The agent judges the learner's current understanding, merges it with the existing note, and submits the complete Markdown draft through editable approval.
---

# Topic notes

A lesson transcript preserves the path. A topic note preserves the learner's **current, reusable model**. Curate the former into the latter without turning the topic note into either a transcript or a generic textbook.

The agent owns the semantic judgment. The `topic-notes` extension owns paths, revision checks, editable approval, and safe writes.

## Non-negotiable rules

1. **Never mutate `topics/**` directly with write, edit, or shell commands.** Use `get_topic_note_context`, then `propose_topic_note_update`.
2. **Submit the complete merged document.** Do not submit an append fragment or patch.
3. **The learner approves the exact file.** The proposal tool opens an editable Markdown draft; submitting saves it and cancelling leaves the file unchanged.
4. **Use judgment, not a quiz-only rule.** Infer understanding from the whole conversation: explanations in the learner's own words, reasoning, questions, practice, quiz answers, corrections, and confidence. Do not equate "was explained" with "was learned."
5. **Keep the note current.** Replace outdated models and deduplicate overlapping explanations. Preserve important changes under `Misconceptions corrected` and `Learning history`.
6. **Do not manufacture progress.** If the session created no durable change, say so and do not call the proposal tool.

## Curation workflow

### 1. Identify the broad topic

Choose the stable broad topic that should accumulate across lessons—for example `sql`, `networking`, or `linear-algebra`—not the narrow lesson name.

- `topicId` must be lower-kebab-case.
- `title` is the human-facing title, preserving acronyms such as `SQL`.
- If more than one existing broad topic is genuinely plausible, ask one `ask_user_question` preference question. Otherwise infer it.

### 2. Load the current note context

Call:

```text
get_topic_note_context({ topicId, title })
```

Use the returned:

- full existing content or new-note template;
- `revision` token;
- active lesson-log path and Obsidian link, when available;
- pending earlier lesson logs for the same topic;
- date and technical session provenance.

Read every relevant pending lesson log before claiming it was incorporated. Keep the session ids of the pending logs actually used; the proposal tool clears only those markers. If no lesson log is linked, curation may continue from the conversation, but do not invent a lesson link.

### 3. Assess the learner state

Build a compact evidence-based picture:

- **Current mental model:** the smallest connected explanation the learner now appears to hold.
- **Core ideas:** durable concepts supporting that model.
- **Capabilities:** things the learner can apparently explain, derive, decide, or do. Phrase uncertain abilities modestly (for example, `Developing: ...`).
- **Open questions and weak areas:** gaps, fragile links, or explicitly deferred material that should guide a later lesson.
- **Misconceptions corrected:** only meaningful old-model → replacement-model changes worth retaining.
- **Review prompts:** short retrieval or application questions that can test retention later. Do not include answers here.
- **Lessons and visuals:** Obsidian links to relevant lesson notes and verified visuals.
- **Learning history:** one dated, concise description of what this session changed, with its lesson link when available.

A wrong quiz answer is diagnostic evidence, not automatically a persistent misconception. Record it only when the conversation shows a meaningful wrong model and its replacement.

### 4. Merge as a living document

Preserve this section order:

```markdown
---
topic: <Title>
topic-id: <topic-id>
updated: <YYYY-MM-DD>
---

# <Title>

## Mental model

## Core ideas

## Capabilities

## Open questions and weak areas

## Misconceptions corrected

## Review prompts

## Lessons and visuals

## Learning history
```

Merge rules:

- Rewrite sections to express the current best model; do not pile a new summary below an old one.
- Preserve correct prior knowledge not contradicted by the current lesson.
- Remove duplicates and obsolete wording.
- Keep claims concise and learner-specific.
- Keep important correction provenance even after rewriting the main model.
- Add the current lesson link at most once.
- Link visuals by Obsidian filename or path; do not duplicate image files.
- Add one learning-history bullet per curated lesson. Update an existing matching bullet instead of duplicating it.
- Do not put raw session paths, IDs, hashes, tool output, or implementation details in the Markdown; the extension stores those in structured session state.
- Use `None recorded yet.` for an empty section rather than deleting required headings.

### 5. Propose the exact update

Call:

```text
propose_topic_note_update({
  topicId,
  title,
  baseRevision: <revision returned by get_topic_note_context>,
  fullMarkdown: <the complete merged Markdown document>,
  changeSummary: <one short sentence>,
  incorporatedPendingSessionIds: <only pending session ids whose logs were merged>
})
```

Call it once per proposed topic update. The extension will open the complete document in an editor.

- If saved, acknowledge briefly and state the topic path.
- If cancelled, respect the cancellation; do not try a direct write or immediately reopen it.
- If a revision conflict is reported, call `get_topic_note_context` again, re-merge against the new content, and present a fresh proposal.
- If UI is unavailable, leave the update pending and tell the learner to resume in interactive Pi and run `/topic-update <topicId>`.

## When invoked at lesson close

Curate before the final goodbye when:

- the planned learning goal has been reached;
- the learner says `stop`, `wrap up`, `that's enough`, or equivalent;
- a lesson ends early but still established knowledge, gaps, or corrected models;
- `/topic-update` requests recovery of an uncurated lesson.

Curation is not another teaching node. Do not add a knowledge-check quiz merely to finish the note. If the evidence is too ambiguous to document responsibly, put the uncertainty under `Open questions and weak areas` or ask one focused clarification.
