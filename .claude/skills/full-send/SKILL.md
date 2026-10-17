---
name: full-send
description: Run the full-stop lifecycle, then merge the PR into main once every gate passes, and confirm the merge and the automatic release it triggers. Only when the user explicitly says "Full Send" for this specific task; installing the skill grants no merge authority. Not for releases, tags, audio/operator deploys or promotions (use promote).
disable-model-invocation: true
---

<!-- Claude Code entry point. The canonical skill is shared with Codex; edit it there. -->

Read `.agents/skills/full-send/SKILL.md` from the repository root and follow it exactly.
It is the single source of truth for this skill.
