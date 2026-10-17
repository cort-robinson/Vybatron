---
name: promote
description: Prepare a release promotion — a versioned release (version bump PR, tag, GitHub Release) or an operator release of audio/infrastructure changes that automatic Deploy refuses. Compares what is live with main, lists included PRs, checks data, config and audio compatibility, and produces an approval-ready release summary. Stops at the approval boundary; executes only with separate explicit authorization. Use when asked to promote, release, cut a version or ship an operator release.
disable-model-invocation: true
---

<!-- Claude Code entry point. The canonical skill is shared with Codex; edit it there. -->

Read `.agents/skills/promote/SKILL.md` from the repository root and follow it exactly.
It is the single source of truth for this skill.
