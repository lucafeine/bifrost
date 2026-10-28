# Plan 04 — Custom emoji mirror (P5)

Fix the fragile "matching names" emoji replacement (README limitation) by lazily miroring
custom emojis across the guild pair. This also makes custom emojis work in reactions
([01-reactions-sync.md](./01-reactions-sync.md)).

Depends on: [00-foundations.md](./00-foundations.md) (`EmojiMapper` step 4, `mirrorEmojis`
toggle).

## 1. Problem today

`MessageTransformer.replaceEmojis` (`src/services/messageTransformer/MessageTransformer.ts:9-17`)
rewrites `<:name:id>` to a same-**name** emoji of the target guild, else leaves the raw
markup (which renders as broken text). Reactions have no fallback at all.

## 2. Scope

| Action | Behavior | Gated by |
|---|---|---|
| Message/reaction references a custom emoji the target lacks | Create it on the target (lazy), then use it | `mirrorEmojis` |
| Emoji deleted / renamed on source | Rename/delete the mirror (rename: yes; delete: opt-in, see §6) | `syncRoleDeletes`-style toggle later; v1: rename only |
| Bulk emoji sync at link time | ❌ (lazy only — slot limits) | — |
| Stickers | ❌ (already handled as image attachments) | — |

## 3. Data model

Migration `00006-add-emoji-links.ts`:

```ts
emoji_links
  id              UUID PK
  guildLinkId     FK → guild_links ON DELETE CASCADE
  discordEmojiId  VARCHAR unique
  fluxerEmojiId   VARCHAR unique
  name            VARCHAR
  animated        BOOLEAN
  origin          ENUM('auto')          // 'manual' reserved for future explicit mapping
  lastUsedAt      TIMESTAMP             // for optional GC
  createdAt       TIMESTAMP
  INDEX (guildLinkId, name)
```

## 4. Resolution algorithm (EmojiMapper step 4)

```
resolve(ref, target):
  1. unicode? → normalized unicode (foundations §3)
  2. emoji_links lookup by (sourceEmojiId)          → mapped target emoji
  3. name match in target guild (existing fetchEmojis caches)
  4. lazy mirror:
       a. image = download from source CDN
          - Discord: emoji.url / `cdnEmojiURL` (gif for animated)
          - Fluxer: `cdnEmojiURL(...)` from @fluxerjs/core
       b. check target capacity (see §5); fail ⇒ fallback
       c. create:
          - Discord: guild.emojis.create({ attachment: image, name })
            (needs Manage Guild Expressions)
          - Fluxer: guild emojis create via `guildEmojis` POST (`GuildEmoji`)
       d. echoGuard.reserve; insert emoji_links; return the new emoji
  5. fallback: null → caller renders `:name:` text + image URL as attachment
```

Failures at 4c (rate limit, permissions, slots) must **not** break message relay: fall
back to step 5 and schedule no retry storm (negative-cache the decision for ~10 min, like
`FluxerEntityResolver.fetchEmojis` already does with its 30 s negative cache).

## 5. Slot & rate-limit management

- **Discord emoji slots are limited** (50 base, up to 250 with boosts). Before creating,
  compare `guild.emojis.cache.size` vs `guild.maximumEmojis`. When full:
  - fallback rendering (step 5), bridge-log "emoji slots full", metric.
  - optional **GC**: mirrored emojis with `lastUsedAt` older than N days (default: never
    auto-delete — only suggest via bridge log). Deleting user-visible content automatically
    is surprising; keep GC manual (`/bridge emoji gc`) or explicitly configured.
- Rate limits: emoji creation is heavily rate-limited. Coalesce identical requests
  (in-flight map keyed by `guildLinkId + emoji name`) so a burst of the same emoji creates
  one copy.
- Discord animated emojis must stay animated (GIF) on the mirror.

## 6. Rename & delete propagation

- **Rename** on source (`guildEmojisUpdate` / `emojiUpdate` via `GuildEmojisUpdate` event
  on Fluxer, `guildEmojiUpdate`… Discord: `Events.GuildEmojiUpdate`) → rename mirror
  (echo-guarded).
- **Delete** on source → v1: leave the mirror (it still renders fine) + bridge log.
  Auto-deleting mirrored content is gated behind a future toggle.

## 7. Interactions with reactions (plan 01)

`EmojiMapper.resolve()` is the single entry point for both content and reactions. Once
lazy mirroring exists, custom emojis in reactions work natively: the emoji gets created on
demand the first time someone reacts with it.

## 8. Permissions

- Discord: **Manage Guild Expressions** (emoji create/edit).
- Fluxer: emoji create/edit (`guildEmojis` routes).
- Without the permission: features degrade to the current name-matching + fallback.

## 9. Edge cases & risks

| Case | Handling |
|---|---|
| Name collision with a *different* emoji on target | Prefer `emoji_links` by ID over name match; name match only when no link row exists |
| Source emoji removed between message and mirror | Download fails → fallback |
| NSFW/unknown content in emoji images | Mirrored as-is; the guild owner chose to bridge the guild (document in setup guide) |
| Huge bursts of distinct new emojis | In-flight coalescing + creation rate limiting; fallback renders text |
| Animated ↔ static mismatch | Preserve `animated` flag |
| Same emoji referenced from many messages at once | One creation (coalesced), `emoji_links` row makes it permanent |

## 10. Acceptance criteria

- [ ] Sending `hello <:wave:123>` where `wave` doesn't exist on the target creates it and
      renders it natively (both directions).
- [ ] Second use of the same emoji never creates a duplicate.
- [ ] Reactions with custom emojis work after first use (integrates with plan 01).
- [ ] Slots exhausted ⇒ graceful `:name:` + image fallback, relay never breaks.
- [ ] `mirrorEmojis` off ⇒ behavior identical to today.
- [ ] Renames on source rename the mirror.

## 11. Open questions

- Should mirrored emojis get a naming marker (e.g. suffix) to make them recognizable in
  the emoji picker? (Cosmetic; can confuse name matching in the other direction — proposed: no.)
- Keep the name-matching step 3 at all once `emoji_links` is authoritative?
  (Yes for pre-existing guilds that already matched by name; cheap to keep.)
