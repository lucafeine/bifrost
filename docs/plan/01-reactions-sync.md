# Plan 01 — Reactions sync (P2)

Mirror reactions on relayed messages in both directions. Biggest user-visible gap.

Depends on: [00-foundations.md](./00-foundations.md) (`SyncEchoGuard`, `EmojiMapper`,
`guild_link_settings.syncReactions`).

## 1. Scope

| Event | Discord source | Fluxer source | Mirror action |
|---|---|---|---|
| Reaction added | `Events.MessageReactionAdd` | `messageReactionAdd` | `react()` on paired message |
| Reaction removed | `Events.MessageReactionRemove` | `messageReactionRemove` | remove our mirrored reaction when count reaches 0 |
| Emoji cleared | `Events.MessageReactionRemoveEmoji` | `messageReactionRemoveEmoji` | `removeReactionEmoji()` |
| All cleared | `Events.MessageReactionRemoveAll` | `messageReactionRemoveAll` | remove all our mirrored reactions |
| Bulk add | — | `messageReactionAddMany` | ignore (per-emoji events cover it) |

Out of scope: per-user attribution (impossible on Discord — the mirror reacts as the bot),
"who reacted" lists.

## 2. Client setup

### Discord (`src/discord.ts:61-67`)
```ts
intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,   // + new, non-privileged
    GatewayIntentBits.GuildMessageTyping,      // + new (P3)
],
partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User], // + Reaction, User
```
No privileged intent needed. Partials are required because reactions on uncached messages
(often the case for old messages) arrive as partials — `await reaction.fetch()` /
`reaction.message.fetch()` when `partial` is true.

### Fluxer (`src/fluxer.ts:73`)
Nothing to do — no intents system; all events are delivered. Just register handlers on
`Events.MessageReactionAdd/Remove/RemoveEmoji/RemoveAll` from `@fluxerjs/core`.

## 3. Data flow

```
onReactionEvent(platform, kind, payload)
  1. actor is the bridge bot on that platform?            → skip (echo)
  2. echoGuard.isEcho(`${platform}:reaction:...`)?        → skip
  3. channelLink = channelLinks.getBy{Discord|Fluxer}ChannelId(channelId)   (cached)
     channelLink missing OR !settings.syncReactions?      → skip
  4. msgLink = messageLinks.getBy{Discord|Fluxer}MessageId(messageId)       (cached)
     msgLink missing → skip  (message predates the bridge or wasn't relayed)
  5. emoji = emojiMapper.resolve(payload.emoji, targetPlatform)             → null ⇒ skip + log
  6. kind: add|remove|removeEmoji|removeAll → mirror (see §4)
  7. metrics + optional bridge log
```

`MessageLinkRepository` already exposes `getMessageLinkByDiscordMessageId` /
`getMessageLinkByFluxerMessageId` (`src/db/repositories/MessageLinkRepository.ts:13-19`),
and `CachedMessageLinkRepository` caches them (15 s TTL) — reaction bursts make this cache
essential; verify it's hit on the hot path and raise TTL if needed.

## 4. Mirroring semantics

### add
`targetMessage.react(emoji)` — **idempotent** on both platforms, so duplicate events are safe.

⚠️ The key subtlety: reactions are **per-user** on the source but the mirror is a single
bot reaction on the target. If Alice and Bob react 🍋 on Discord, Fluxer must see exactly
one 🍋. Strategy:

- **add**: react on target only if the bridge reaction doesn't exist yet
  (`message.reactions.cache.get(emoji)?.me` / fetch the message and inspect `reactions`).
  If `me` is already true → skip.
- **remove**: only remove when the source count for that emoji drops to **0**.
  Discord's event payload carries `reaction.count` (fetch when partial). Fluxer's
  `APIMessageReaction` carries `count` too; `messageReactionRemove` payload exposes the
  aggregate (`reaction.count`). If count is unavailable (partial), fetch the source message
  and check the reaction's users/count before removing.

This gives exact emoji-set parity. User-level counts don't match 1:1 (a 5-user reaction on
Discord shows as 1 on Fluxer) — accepted limitation (see ARCHITECTURE §7).

### remove
As above: `removeReaction(emoji)` on the target (removes our own reaction; requires no
extra permission).

### removeEmoji (all reactions of one emoji cleared)
`targetMessage.removeReactionEmoji(emoji)` — clears every reaction with that emoji on the
target. Fine when the target's reactions are mostly mirrors; if real users on the target
also reacted with it, they get wiped too. **Requires Manage Messages** on Discord.
Alternative conservative mode: only remove our own reaction (`removeReaction(emoji)`).
Make this a constant/setting; default to the conservative mode, document the trade-off.

### removeAll (message cleared)
Remove every **bridge-owned** reaction on the target: iterate `message.reactions.cache`,
for each where `me === true` → `removeReaction(emoji)`. Do **not** use the nuclear
`reactions.removeAll()` (would wipe real users' reactions on the other side).

### Burst handling
A message that goes viral produces dozens of events per second. Coalesce per
`(channelLinkId, messageId)`: a trailing debounce (~500 ms) that, when flushed, performs a
**reconcile** of that message: fetch source reactions (aggregated `reactions[]` with
counts) and target reactions (ours), then compute the diff:
```
toAdd    = sourceEmojis(count>0) − targetEmojis(mine)
toRemove = targetEmojis(mine) − sourceEmojis(count>0)
```
Reconcile-on-flush is simpler and more robust than per-event bookkeeping, and the debounce
absorbs bursts. Single isolated events can skip the debounce (or use a tiny one, 150 ms).

For Fluxer, `MessageReactionManager` caches reactions keyed by emoji identifier — handy
for the diff. For Discord, `message.reactions.cache` with `me` flags.

## 5. Emoji mapping in reactions

Input shapes:
- Discord `reaction.emoji`: `{ id, name, animated }` (id null ⇒ unicode).
- Fluxer `MessageReaction.emoji`: identifier `name:id` / `a:name:id` / unicode
  (`ReactionEmojiPayload` also carries a parsed camelCase form).

Route through `EmojiMapper.resolve()` (foundations §3). For custom emojis that fail to
resolve (not mirrored, no name match), fall back to reacting with the emoji **image URL is
not possible** in a reaction → skip + `BridgeLogService` warning. (Content rendering keeps
its own richer fallback; reactions just skip.)

## 6. New code

```
src/services/reactionSync/ReactionSyncService.ts     # handlers + reconcile
src/services/reactionSync/ReactionCoalescer.ts       # per-message debounce
src/services/reactionSync/types.ts
```
Event wiring: `src/discord.ts` + `src/fluxer.ts` register the four events each side and
delegate to `ReactionSyncService` with a `platform` argument. Keep the event-specific
payload normalization in the service (like `messageTransformer` does for messages).

Do **not** force these through `MessageQueueService` (it serializes `WebhookMessageData`);
reactions retry inline with the existing `fluxerApiGuard` backoff awareness.

## 7. Edge cases & risks

| Case | Handling |
|---|---|
| Reacting to a non-relayed message (bot offline at send time) | No `message_links` row → skip silently (debug log) |
| Partial payloads (uncached message/reaction) | `fetch()` before processing |
| Reactions on the bridge's own webhook messages | Normal — those messages *have* message links; they are the main case! |
| Unicode normalization (FE0F, keycaps) | Handled in `EmojiMapper` |
| Animated emojis | `a:name:id` on Fluxer, `animated: true` on Discord — preserved by mapper |
| User removes the *bridge's* reaction manually on the target | Next reconcile re-adds it if source count > 0 (self-healing) |
| Rate limits on reaction endpoints (bursts) | Coalescer + per-channel concurrency limit (e.g. 1 in-flight reconcile per message) |
| Unknown/removed emoji on source | `resolve()` returns null → skip + log |
| Bot lacks Add Reactions permission | Error → bridge log + metric; no retry storm |

## 8. Permissions

- Discord: **Add Reactions** (minimum). **Manage Messages** for full `removeEmoji` fidelity
  (else conservative mode only).
- Fluxer: add reactions on target messages; `removeReaction(emoji)` for self.
  (Fluxer also exposes `removeReaction(emoji, userId)` — per-user removal — which could
  give better fidelity later with identity linking.)

## 9. Acceptance criteria

- [ ] React on Discord ⇒ same emoji appears on the Fluxer twin, and vice versa.
- [ ] Two users reacting with the same emoji ⇒ **one** mirrored reaction each way.
- [ ] Last user removes ⇒ mirrored reaction disappears; intermediate removes don't.
- [ ] `removeAll` on one side clears only bridge-owned reactions on the other.
- [ ] Unicode + custom (name-matched) + animated emojis all round-trip.
- [ ] No ping-pong: mirrored reactions never re-trigger a mirror (echo guard + bot-actor skip).
- [ ] Bursts of 50+ reactions on one message cause ≤ 2 fetches after debounce.
- [ ] Toggling `syncReactions` off stops mirroring within the settings cache TTL.

## 10. Open questions

- Do we want an optional "reaction summary" line (e.g. `🍋 Alice, Bob`) instead of a real
  reaction when the emoji can't be mirrored? Cheap to add later; skip for now.
- Should `syncReactions` also be toggleable per channel link? (Same question as foundations §6.)
