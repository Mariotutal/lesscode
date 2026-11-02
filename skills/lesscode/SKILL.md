---
name: lesscode
description: Run LessCode review or simplify-tool on the current checkout and return the JSON result path without inventing a verdict.
allowed-tools: Read, Bash, Grep, Glob, Edit, Write
---

# LessCode Skill

Use this skill to run LessCode from an agent. Do not invent a verdict — read the JSON output.

## Instructions

1. Resolve model config via Factory `LESSCODE_*` env and an optional committed `.lesscode.json` (`apiKeyEnv` only, never a literal key).
2. Run `node scripts/lesscode.mjs review --out <path>` or `tool --out <path>`. The CLI writes a deterministic `.lesscode.json` and the requested result JSON.
3. Return the JSON path to the caller; do not summarize a verdict yourself. The engine is the source of truth.

## References

- `docs/consumers.md` — consumer integrations
- `docs/run.md` — run modes and config
- `scripts/lesscode.mjs` — CLI wrapper
