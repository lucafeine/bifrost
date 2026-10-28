# Plan 00 — Foundations

Prerequisite for P2–P5. Small, shared building blocks so every sync feature plugs into the
same plumbing instead of reinventing loop prevention, emoji mapping and configuration.

## 0. Scope

- Per-guild-link feature toggles.
- Echo/loop guard for mirrored actions.
- `EmojiMapper` service (skeleton here, lazy mirroring in [04-emoji-mirror.md](./04-emoji-mirror.md)).
- Bridge log channel + metrics conventions.

No user-visible behavior change yet (all toggles default to today's behavior).

## 1. `guild_link_settings`

New table, 1:1 with `guild_links`. Migration `00003-add-guild-link-settings.ts`.

```ts
guild_link_settings
  guildLinkId      UUID PK, FK → guild_links(id) ON DELETE CASCADE
  syncReactions        BOOLEAN default true    // P2
  syncTyping           BOOLEAN default true    // P3
  syncPins             BOOLEAN default true    // P3
  syncSystemMessages   BOOLEAN default true    // P3
  syncChannelStructure BOOLEAN default false   // P4 (opt-in: creates/deletes channels)
  autoLinkCreatedChannels BOOLEAN default true // P4 (only meaningful with the above)
  syncChannelDeletes   BOOLEAN default false   // P4 (destructive → opt-in)
  syncRoleStructure    BOOLEAN default false   // P5 (opt-in)
  syncRoleDeletes      BOOLEAN default false   // P5 (destructive → opt-in)
  mirrorEmojis         BOOLEAN default true    // P5
  discordLogChannelId  VARCHAR NULL            // bridge log, Discord side
  fluxerLogChannelId   VARCHAR NULL            // bridge log, Fluxer side
  updatedAt            TIMESTAMP
```

Defaults rationale: non-destructive features (reactions, typing, pins) default **on**;
anything that creates or deletes guild structure defaults **off** and is enabled from the
management panel ([05-discord-management-ui.md](./05-discord-management-ui.md)).

### Code changes
- `src/db/entities/GuildLinkSettings.ts`, `src/db/models/GuildLinkSettingsModel.ts`,
  `src/db/repositories/GuildLinkSettingsRepository.ts`,
  `src/db/sequelizerepos/SequelizeGuildLinkSettingsRepository.ts`,
  `src/db/cachedrepos/CachedGuildLinkSettingsRepository.ts` (short TTL, e.g. 30 s —
  settings reads happen on every relayed event).
- Wire in `src/db/models/index.ts` associations and `src/index.ts` bootstrap.

## 2. `SyncEchoGuard` (loop prevention)

Mirrored actions re-emit events on the target platform. Today the relay solves this for
messages by ignoring webhook messages (`src/discord.ts:255-265`, `src/fluxer.ts:268-278`).
Reactions/roles/channels have no such natural marker, so we add an explicit guard.

```ts
// src/services/SyncEchoGuard.ts
expect(key: string, ttlMs = 15_000): void   // we are about to perform action `key`
isEcho(key: string): boolean                // consumes the reservation on match
```

- Key format: `{platform}:{action}:{targetId}:{qualifier}` e.g.
  `fluxer:reaction:add:9876543210:lemon`, `discord:channel:update:1234:name`.
- Backed by an LRU with TTL (`lru-cache` is already a dependency).
- **Additionally**, events whose actor is the bridge bot itself are always ignored
  (reactions added by us, channels/roles created by our API calls when the payload carries
  an actor).

Usage rule in every sync handler:

```ts
if (echoGuard.isEcho(key)) return;
// ...do the mirror...
```

Reserve with `expect(key)` *before* the API call; if the call fails, `expect` simply
expires. This is best-effort by design — a redundant mirror is idempotent
(`react()` twice is a no-op, re-editing a channel converges) so worst case is a harmless
duplicate, never a ping-pong loop (the guard is checked on receipt, and the echo of a
mirror is always registered).

## 3. `EmojiMapper`

Single place that answers: *"given an emoji on side A, what do I send to side B?"*

```ts
// src/services/emojiMapping/EmojiMapper.ts
resolve(input: EmojiRef, target: 'discord' | 'fluxer'): Promise<MappedEmoji | null>
```

`EmojiRef` = `{ platform, id | null, name, animated, sourceGuildId }` (id is null for
unicode). Resolution order (P0 implements steps 1–3; step 4 arrives in P5):

1. Unicode → identity on both sides.
2. `emoji_links` lookup by source emoji ID (P5, table created there — P0 ships the
   interface with this branch stubbed).
3. Name match in the target guild — reuse the logic in `src/utils/emojis.ts:16-31` and the
   per-guild emoji caches in `DiscordEntityResolver.fetchEmojis` (60 s) /
   `FluxerEntityResolver.fetchEmojis` (30 s negative cache).
4. Lazy mirror: create the emoji on the target side (P5).
5. Fallback: `null` → caller renders `:name:` text or the emoji image URL.

Output formats:
- Discord: unicode string or `GuildEmojiResolvable` (`<a:name:id>` also works in content).
- Fluxer: unicode string or `name:id` / `a:name:id` (the identifier format used by
  reaction routes and `Message.react(emoji)`).

Normalization gotcha to handle here: unicode emoji + variation selector `U+FE0F` and
keycap sequences (`1️⃣`) render differently across platforms — normalize to a canonical
form before comparing/sending (strip `FE0F`, keep keycap `U+20E3`).

Refactor: `MessageTransformer.replaceEmojis` (`src/services/messageTransformer/MessageTransformer.ts:9-17`)
delegates to `EmojiMapper` instead of doing its own regex matching.

## 4. Bridge log + metrics

- **Bridge log**: `GuildLinkSettings.discordLogChannelId` / `fluxerLogChannelId`. When set,
  sync events post a compact embed ("♻️ reactions synced on #general", "⚠️ emoji mirror
  failed: no free emoji slots"). Helper `BridgeLogService.post(guildLinkId, level, text)`.
  Suppressed by default (null = silent).
- **Metrics** (`src/services/MetricsService.ts`): counters
  `bifrost_sync_events_total{kind, direction, result}` (kind = reaction|channel|role|emoji|typing|pin,
  result = ok|skipped|error) and `bifrost_sync_echo_suppressed_total{kind}`.
  Also expose queue depth for the reaction coalescer (see P2).

## 5. Acceptance criteria

- [x] Migration 00003 applies cleanly on sqlite **and** postgres. *(sqlite covered by
      `00003-add-guild-link-settings.spec.ts`; postgres pending verification on a live DB —
      the migration only uses dialect-agnostic `queryInterface` calls.)*
- [x] Settings read path is cached; a settings change is visible within the cache TTL.
- [x] `SyncEchoGuard` unit tests: reserve/consume, TTL expiry, concurrent keys.
- [x] `EmojiMapper` unit tests: unicode normalization, name match, `null` fallback.
- [x] No behavior change when all toggles are at defaults (messages relay exactly as today).

## 6. Implementation notes (as landed)

- `guild_link_settings` rows are backfilled in migration 00003 and created lazily
  (`getOrCreate`) for new guild links, so reads never hit a missing row.
- `SyncEchoGuard` uses a small internal TTL map with an injectable clock instead of
  `lru-cache` (whose TTL clock is not injectable → non-deterministic tests). Same
  semantics: bounded size, per-key TTL, consume-on-match.
- `EmojiMapper.mapContent` preserves today's content rendering exactly
  (`<:name:id>` mentions on **both** platforms); the per-platform identifier formats
  (`<:name:id>` for Discord, `name:id` for Fluxer) are used by `resolve()` for the
  upcoming reaction/emoji-mirror paths.
- Migration glob now matches `*.{js,ts}` (excluding `.d.ts`) with forward slashes:
  migrations were previously skipped entirely when running through `tsx` (dev mode).

## 7. Open questions

- Should toggles eventually live per **channel link** instead of per guild link
  (e.g. sync reactions everywhere except #admin)? Start per guild link; add per-link
  overrides only if requested.
- Settings cache TTL vs. immediacy of the management panel — 30 s is fine for relay paths;
  the panel can write-through and invalidate locally.
