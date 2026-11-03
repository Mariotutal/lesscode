---
name: lesscode
description: Run LessCode review or simplify-tool on the current checkout and return the JSON result path without inventing a verdict.
compatibility: Requires Node.js 22+, Git and a built LessCode installation on PATH. Docker mode requires an approved runner image.
allowed-tools: Read Bash
---

# LessCode Skill

Use this skill to run LessCode from an agent. Do not invent a verdict — read the JSON output.

## Instructions

1. Use operator-provided configuration; never rewrite `.lesscode.json` or store credentials.
2. Run `lesscode review --repo <checkout> --base <ref> --intent <files> --out <result.json>`. For untrusted source add `--execution docker --runner-image <operator-approved-image>`.
3. Read the generated RunRecord. Exit 0 means accepted, 1 means reviewed (successful note-only outcome), 2 means failed. A path alone is not proof of success: inspect verdict, state and failure.
4. Read each review item's `verification`. Present `verified` items with their listed inputs and assumptions from `review.facts`. Present `unverified` items as model advice needing confirmation. A successful verdict and existing citations do not establish factual correctness; absent verification fields mean verification is unknown. Withheld claim checks are in `audit.reviewVerification`.
5. Return the JSON path and recorded verdict. Apply patches only when authorized by the user.

## References

- Run `lesscode --help` for the installed command contract. This skill can be copied independently and depends on the installed executable.
