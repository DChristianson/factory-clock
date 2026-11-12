# Vendored schema

Copied from Snagboat's schema package, [`packages/schema/src`](https://github.com/DChristianson/snagboat/tree/fc9a72bb87925445fc279bf8b352484fe32fb262/packages/schema/src), at Snagboat commit `fc9a72bb87925445fc279bf8b352484fe32fb262` (2026-11-12).

Factory Clock keeps its own copy instead of depending on a shared package. The two copies will drift. When Snagboat's event format changes, copy the changed files again and run `npm test`.

| File | What it has |
| --- | --- |
| `types.ts` | `NormalizedEvent` and the types it uses |
| `toolCategory.ts` | Tool categories and their labels |
| `eventDay.ts` | The day an event falls on |
| `sessions.ts` | `SessionSummary` and `SessionIndex` |
| `contextMarks.ts` | Context sizes and limits per model |
| `sessionModel.ts` | `SessionView` and `buildSessionView` |
| `index.ts` | Written here: re-exports the files above |

The files are unchanged copies. Snagboat's JSON Schema files (`jsonSchema.ts` and `normalizedEvent.v*.schema.json`) are not copied, because nothing here uses them.
