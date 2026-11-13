# Release plan

The intro links [elsewhere](../other.md), and a code block shows a checkbox that is not a task:

```md
- [ ] not a task
```

## Background

- A bullet outside the plan, which is not a step.

## Steps

1. **Parser — done.** Write `src/parse.ts`; see [the notes](notes/parser.md#top).
2. **Checker.** After 1. It never reads /etc/passwd, but reads https://example.com/spec.html.
   - Rules for headings
   - Rules for lists
     - A nested rule
3. **Exporter (in progress).** Depends on step 2; ∥ with 4.
4. **Docs.** Needs 2 files and a review. Blocked by Exporter.
5. **Release notes.** Replaces step 4, once steps 2 and 3 are in.
6. [x] Tag the release
7. [ ] Announce it. Decides step 8.
8. **Retrospective — later.**

## Decisions

| Question | Decision |
| --- | --- |
| Format | Markdown, `docs/format.md` |
| Hosting | **Not decided.** |

## Open questions

- **Who reviews?** The owner or the team.
- **Which version — settled.** 1.0.
