# Bifröst — Architecture & Current State

> Living document. Describes what the bridge does **today**, how it works internally,
> and where the gaps are. The forward-looking plan is in [ROADMAP.md](./ROADMAP.md).

## 1. Overview

Bifröst bridges a Discord guild and a Fluxer guild. It runs two bot clients in one process:

| Client | SDK | Entry point |
|---|---|---|
| Discord | `discord.js@14` | `src/discord.ts` |
| Fluxer | `@fluxerjs/core@3` (discord.js-like) | `src/fluxer.ts` |

Messages are relayed **via webhooks** so they appear with the original author's username and
avatar (`src/services/WebhookService.ts`). Every relayed message pair is persisted in
`message_links`, which is what allows edits and deletions to be mirrored later.

```
Discord message ─┐                        ┌─▶ Fluxer webhook message
                 ├▶ MessageTransformer ──┤
Fluxer message ──┘   (normalize, emoji)   └─▶ Discord webhook message
                          │
                          ▼
                   message_links (discordMessageId ⇄ fluxerMessageId)
```

## 2. Runtime topology

- `src/index.ts` — bootstrap, DB init + migrations, repo wiring (cached repos),
  Fluxer client supervision with auto-restart/backoff (`src/index.ts:92-179`).
- `src/discord.ts` — Discord client, command registry, event handlers.
- `src/fluxer.ts` — Fluxer client, command registry, event handlers.
- `src/services/` — relay logic (`messageRelay/`), payload normalization
  (`messageTransformer/`), lookups (`entityResolver/`), webhooks, queues, metrics, health,
  plus the P0 sync foundations: `SyncEchoGuard` (echo/loop prevention),
  `emojiMapping/EmojiMapper` (cross-platform emoji resolution) and `BridgeLogService`
  (optional per-guild-link bridge log channels).
- `src/commands/` — prefix commands (`!b …`, configurable via `BF_COMMAND_PREFIX`,
  `src/utils/env.ts:50`). Identical command set on both platforms. **No slash commands.**
- `src/web/` + `dashboard/` — optional Express 5 JSON API + React 19 SPA
  (behind `BF_ENABLE_WEB_DASHBOARD`). **Status: FROZEN** (see ROADMAP decisions).
- `src/db/` — Sequelize 6 (sqlite by default, postgres optional), umzug migrations,
  layered repositories (interface → sequelize → in-memory cached).

## 3. Message pipeline

### Creation
1. `messageCreate` on either side (`src/discord.ts:252`, `src/fluxer.ts:265`).
   Scope: guild text channels only (`src/discord.ts:315-322`, `src/fluxer.ts:332-338`);
   command invocations and webhook echoes are ignored (`src/discord.ts:255-265`).
2. `MessageTransformer` normalizes: attachments, stickers (→ images), replies
   (→ quoted embed, **not** native replies), forwarded messages (Discord→Fluxer only),
   embeds, join messages, polls (Discord→Fluxer only, rendered as text).
3. `WebhookService.sendMessageVia{Discord,Fluxer}Webhook` posts as the author.
4. `message_links` row is written (both platform message IDs).

### Edits & deletes
- `messageUpdate` → re-transform and `editMessageVia{Discord,Fluxer}Webhook`
  (`src/services/WebhookService.ts:121`, `:268`).
- `messageDelete` → resolve the paired message via `message_links` and delete it.

### Resilience
- Failed relays are persisted to `queued_messages` and drained every 30 s
  (`src/services/MessageQueueService.ts:50-185`).
- Fluxer IP-ban backoff (`src/utils/fluxerApiGuard.ts`).
- Metrics via Prometheus (`src/services/MetricsService.ts`), health pushes
  (`src/services/HealthCheckService.ts`).

## 4. Data model

| Table | Purpose | Key columns |
|---|---|---|
| `guild_links` | 1:1 guild pairing | `discordGuildId`, `fluxerGuildId` (unique) |
| `guild_link_settings` | per-link feature toggles (sync scope) + bridge log channels | `guildLinkId` (PK, FK → `guild_links`, cascade) |
| `channel_links` | message bridge for a channel pair | channel IDs, webhook id/token for both sides, `linkId` (public nanoid(10)) |
| `message_links` | message pairing | `discordMessageId`, `fluxerMessageId` (unique, indexed — `00002`) |
| `queued_messages` | outage replay queue | `direction`, `payload`, `retryCount`, `lastError` |
| `Sessions` | web sessions (frozen feature) | — |

Migrations: `src/db/migrations/00001-baseline.ts`, `00002-add-channel-link-indexes.ts`,
`00003-add-guild-link-settings.ts`.
Next free number: **00004**.

## 5. What is synced today

| Feature | Status |
|---|---|
| Messages (content, attachments, stickers, embeds) | ✅ both ways |
| Edits / deletions | ✅ both ways |
| Replies | ⚠️ rendered as quote embed, not native replies |
| Custom emojis in content | ⚠️ matched **by name** across guilds (`src/utils/emojis.ts:16-31`) |
| Mentions | ⚠️ rendered as plain text `@name`/`#name` (`src/utils/sanitizeMentions.ts`) |
| Join messages | ✅ rendered as text |
| Polls | ⚠️ Discord→Fluxer only, as formatted text |
| Forwarded messages | ⚠️ Discord→Fluxer only |
| **Reactions** | ❌ |
| **Typing indicators** | ❌ |
| **Pins** | ❌ |
| **Channels (create/rename/delete/move)** | ❌ (manual link only) |
| **Roles (structure or membership)** | ❌ |
| **Custom emoji sync** | ❌ |
| Threads / forum posts | ❌ |
| Member/ban/moderation events | ❌ |
| Bulk delete (`messageDeleteBulk`) | ❌ |

## 6. Platform API facts (verified against published types)

### Fluxer (`@fluxerjs/core@3.3.0`, `@fluxerjs/types@3.3.0`)
- **No intents system** — the gateway sends everything (`ClientOptions.intents` is
  deprecated and always sends `0`, `ignoredEvents` exists instead). No privileged-intent
  verification on this side.
- **Reactions: full support.** Events `messageReactionAdd/Remove/RemoveAll/RemoveEmoji`
  (+ `messageReactionAddMany` bulk). `Message.react()`, `removeReaction(emoji, userId?)`,
  `removeReactionEmoji()`. Emoji identifier format: `name:id`, `a:name:id` (animated), or unicode.
- **Roles: full support.** `GuildRoleManager.create/edit/delete`, `guild.setRolePositions`,
  `GuildMemberRoleManager`, events `guildRoleCreate/Update/Delete`.
- **Channels: full support.** `channelCreate/Update/Delete` events, `GuildChannelCreateOptions`,
  categories, forums/media/link channel types.
- **Emojis: full support.** `guildEmojis` CRUD, **`guildEmojisClone`** route,
  `guildEmojisUpdate` event, `GuildEmoji` class, `cdnEmojiURL`.
- **Typing**: `channel.sendTyping()`, `typingStart` event.
- **Pins**: `pin()` / `unpin()`, `channelPinsUpdate` event.
- **Threads**: full API (create/edit/archive/search).
- **NO native polls** — no poll symbol anywhere in the SDK/types.
- **NO interactions/components** — no buttons, select menus, modals, or slash commands.

### Discord (`discord.js@14.25`)
- Intents currently enabled: `Guilds`, `GuildMessages`, `MessageContent` + partials
  `Message`, `Channel` (`src/discord.ts:61-67`).
- Needed for the roadmap: `GuildMessageReactions`, `GuildMessageTyping`,
  `GuildModeration` (all **non-privileged**), `GuildInvites`; `GuildMembers` is
  **privileged** (only needed for the future membership/moderation sync phase).
- Partial `Reaction`, `User` will be required for reaction events on uncached messages.
- Full interactions support (slash commands, buttons, selects, modals).

## 7. Known limitations (accepted)

1. Mirrored reactions on Discord are attributed to the bot account (Discord does not allow
   reacting "as" another user). Counts stay accurate; the reactor list shows Bifröst.
2. Custom emoji rendering depends on **name matching** across guilds (documented in README).
3. Replies are quotes, not native cross-references (webhook executes cannot reference
   messages on Discord).
4. Messages sent while the bridge is offline are not retroactively linked
   (the queue only covers relay failures, not missed source events).
5. Role *permissions* are not transposable between platforms (different models).

## 8. Decision log

| Date | Decision |
|---|---|
| 2026-10 | Web dashboard is **frozen**, not deleted. OAuth flows (`src/web/oauth/`) are kept as the likely foundation for future account linking. |
| 2026-10 | Role sync scope = **structure only** (name/color/position mirror + mention rendering). Membership sync is deferred to a future identity-linking phase. |
| 2026-10 | Management UI lives on **Discord** (slash commands + components). Fluxer keeps prefix commands (`!b`), as Fluxer has no interaction model. |
| 2026-10 | P0 foundations landed: `guild_link_settings` toggles (defaults = today's behavior), `SyncEchoGuard`, `EmojiMapper`, bridge log + sync metrics. No user-visible change yet. |
| 2026-10 | `SyncEchoGuard` uses a small internal TTL map with an injectable clock instead of `lru-cache` (whose TTL clock is not injectable → non-deterministic tests). |
| 2026-10 | Test suite introduced with vitest (`*.spec.ts`, excluded from the build). Runs without live API access: SDK-type-checked code + unit tests + sqlite migration tests. |
