# Style (Sanglard)

Product stays in `AGENTS.md` + `GRAPH.md`. This file is only how to write code.
No standing LOC cap. Preserve readable code, useful comments, and necessary tests. Size reviewable changes to the authorized task.

Human text (comments, commits, replies): as few words as possible. No praise. No superlatives. Cold truth.

New code:

- Named constants for spec values (HTTP 402, `$0.01`, `10000` atomic). One-off literals stay inline.
- Early return. No arrow nesting.
- Names < 30 chars.
- Prefer a two-value const/object over a boolean parameter (`{ mode: "live" | "dry" }`).
- `{}` on every `if` / `else`.
- Export only what another file must call.
- Comment only a non-obvious constraint, with why. Do not comment code you did not touch.
- Do not edit unrelated blocks. Minimize the diff.

Layers here are GRAPH nodes, not a new package tree. Do not punch through: consume does not grow `/call`; lock does not grow slash; this process does not import `wzrd-final`.

Bugfix: write the failing test first, then the fix, then watch it pass.

Commits:

1. Subject blank line body.
2. Subject ≤ 50 chars (72 hard). Capital, imperative, no period.
3. Completes "If applied, this commit will …".
4. Body wrap 72. What/why, not how.

Dilution: one feature per session. If style slips, reload this file.
