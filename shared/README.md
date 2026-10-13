# shared

Canonical logic shared by `server/` and `board/` so both agree on topic and
workspace identity:

- `topic-canonicalization/` — display name → canonical topic key, plus known aliases
- `topic-context/` — event labels and workflow-graph assembly for topic timelines
- `workspace-normalization/` — checkout path → workspace key normalization

Plain `.mjs` modules, no build step. Import directly under Node ≥ 22.5.
