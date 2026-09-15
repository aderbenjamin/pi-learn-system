# Learning vault

- Teaching sessions belong in `lessons/<topic-id>/<YYYY-MM-DD>-<subtopic>.md`; living knowledge belongs in `topics/<topic-id>.md`.
- Topic notes describe the learner's current mental model, capabilities, open questions, corrected misconceptions, review prompts, and lesson/visual provenance. They are not transcripts or generic encyclopaedia articles.
- At the natural end of every teaching session—including an early stop—load the `topic-notes` skill and propose a topic-note update before saying goodbye. If nothing durable changed, say so instead of manufacturing an update.
- Never mutate `topics/**` through ordinary `write`, `edit`, or shell commands. Read/update topic notes only through `get_topic_note_context` and `propose_topic_note_update`, so the learner sees and can edit the complete draft before it is saved.
- `/topic-update [topic]` is the manual curation fallback; `/learn <topic> | <subtopic>` starts and logs a structured lesson.
