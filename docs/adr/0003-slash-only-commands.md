# ADR-0003: Slash commands only — drop the `!` prefix

- Status: Accepted
- Date: 2026-07-08

## Context

Legacy `!` prefix commands are implemented via a hand-rolled mock-interaction object in `src/commands/index.js`. The shim is already broken: no `deferReply`/`editReply` support, positional argument parsing that fails on multi-word queries (`!play never gonna give you up` passes only `never` as the query), and no `member.voice` guarantees. It also forces the privileged MessageContent intent.

## Consequences of keeping it would be

Maintaining interaction-parity in the shim forever, plus intent management overhead — for a feature Discord itself has deprecated in favor of slash commands.

## Decision

Slash commands only. Delete the `messageCreate` handler and mock-interaction shim. Drop `GuildMessages` and `MessageContent` intents; keep `Guilds` and `GuildVoiceStates`.

## Consequences

- A whole bug class disappears; command modules can rely on real `ChatInputCommandInteraction` semantics (`deferReply`, `editReply`, ephemeral flags).
- Users must use `/play` etc. The bot presence string is updated accordingly.
- Message Content Intent can be disabled in the Discord Developer Portal.
