# Plan 02 — Channel structure sync (P4)

Keep the two servers' channel trees from drifting apart: mirror channel/category creation,
renames and (opt-in) deletions, and auto-link created text channels so they bridge
immediately.

Depends on: [00-foundations.md](./00-foundations.md) (`SyncEchoGuard`, settings toggles).

## 1. Scope

| Action | Mirror | Gated by |
|---|---|---|
| Text channel created | Create twin (+ webhooks + `channel_links` if `autoLinkCreatedChannels`) | `syncChannelStructure` |
| Category created | Create twin category | `syncChannelStructure` |
| Channel renamed / topic / slowmode / nsfw | Edit twin | `syncChannelStructure` |
| Channel moved between categories | Move twin (best-effort ordering) | `syncChannelStructure` |
| Channel deleted | Delete twin | `syncChannelDeletes` (opt-in, destructive) |
| Voice / forum / media / link channels | **Not mirrored** (v1) | — |

## 2. Data model

`channel_links` today = "message bridge pair with webhooks on both sides"
(nullable webhooks would be a breaking change to its contract). Structure mirroring also
covers categories, which can't have webhooks. So: **new table** for structure mapping,
keeping `channel_links` as the bridge table.

Migration `00004-add-structure-links.ts`:

```ts
structure_links
  id                 UUID PK
  guildLinkId        FK → guild_links ON DELETE CASCADE
  discordChannelId   VARCHAR unique
  fluxerChannelId    VARCHAR unique
  kind               ENUM('category','text')
  origin             ENUM('manual','auto','autolink')   // who created the twin
  createdAt          TIMESTAMP
  INDEX (guildLinkId)
```

- A bridged text channel can have **both** a `structure_links` row and a `channel_links`
  row (correlated by the channel ID pair).
- `origin='auto'` ⇒ the twin was created by this sync feature ⇒ safe to auto-delete later
  when `syncChannelDeletes` is on. `manual`/`autolink` twins are never auto-deleted
  (they'd delete a channel a human deliberately set up) — instead the delete event posts a
  bridge-log warning ("counterpart #x still exists").

## 3. Events & flows

Discord: `Events.ChannelCreate`, `ChannelUpdate`, `ChannelDelete`.
Fluxer: `channelCreate`, `channelUpdate`, `channelDelete`.

### Create
```
onChannelCreate(platform, channel)
  1. guild pair linked? settings.syncChannelStructure?              else skip
  2. channel.type is category or guild text?                        else skip
  3. echoGuard.isEcho(`${platform}:channel:create:${normalized(channel.name)}:${kind}`)?  → skip
  4. a structure_links row already exists for this channel id?       → skip (already mirrored)
  5. resolve parent category: structure_links match, else mirror the category first
  6. create twin (same name, topic, nsfw, rateLimitPerUser; parent = twin category)
     - echoGuard.expect on the target platform before the call
  7. insert structure_links row (origin='auto')
  8. if kind==='text' && settings.autoLinkCreatedChannels:
       create webhooks both sides (WebhookService.createDiscordWebhook / createFluxerWebhook)
       insert channel_links row  → channel is live immediately
  9. bridge log: "➕ #general mirrored and linked"
```

The row-first/expect ordering in steps 4–7 is what prevents loops: the target's own
`channelCreate` event either matches `echoGuard` (reserved key) or finds the freshly
inserted `structure_links` row.

### Update
Diff relevant fields: `name`, `topic`, `rateLimitPerUser`, `nsfw`, `parentId`.
Apply to twin via edit. Echo guard key includes the field+value hash
(`discord:channel:update:{id}:{field}:{value}`) so a mirrored edit's echo is swallowed but
a genuine later edit with the same value is harmless anyway (idempotent).
Debounce bulk operations (e.g. a category rename plus its children) — a 1 s trailing
window per guild pair.

### Delete
- If the twin has `origin='auto'` **and** `syncChannelDeletes` → delete twin
  (also delete its `channel_links` row + webhooks — reuse `Unlink*CommandHandler` logic,
  extracted into `LinkService`).
- Else → bridge log warning, keep the twin.

## 4. Name normalization

Discord channel names are lowercase, spaces forbidden; Fluxer allows nicer names.
Rules:
- Creation: copy the source name verbatim where the target accepts it; otherwise
  lowercase + replace spaces with `-` (Discord target).
- Matching (`autolink`, category resolution): reuse the normalization style of
  `src/utils/channelMatcher.ts` (Levenshtein + containment, threshold 0.5).

## 5. Auto-link integration

Reuse the existing link flow internals instead of the command handlers:
- Extract the "create webhooks both sides + insert `channel_links`" core of
  `LinkDiscordCommandHandler.ts:55-288` / `LinkFluxerCommandHandler.ts` into
  `LinkService.createChannelLink(guildLinkId, discordChannelId, fluxerChannelId)`.
- The slash command (plan 05) and `autolink` command then call the same service.
- Auto-linked channels get `channel_links.linkId` as usual (needed by `unlink`).

Failure handling: if webhook creation fails (limit of 30 webhooks/channel, permissions),
create the twin channel anyway, insert `structure_links`, log the failure, and let an
admin link it manually later.

## 6. Position & ordering

Best-effort:
- Mirror category order via `guild.channels.setPositions()` (Discord) /
  equivalent on Fluxer after bulk changes (debounce 2 s per guild).
- Child channel order within a category mirrored the same way.
- Skip fine-grained ordering when the two platforms disagree about other channels'
  positions (compute relative order among *mirrored* channels only).

## 7. Permissions

- Discord: **Manage Channels** (create/edit/delete), **Manage Webhooks** (auto-link).
- Fluxer: same.
- The bot cannot mirror channels above its highest role / outside its permission scope —
  skip + log.

## 8. Edge cases & risks

| Case | Handling |
|---|---|
| Channel created manually on one side while sync is off | Stays local; admin can link manually or via autolink |
| Two channels normalized to the same name | Allowed; matching uses IDs once created |
| Mirror create fails (rate limit / perms) | Retry once via backoff, then bridge log + metric |
| Category deleted with children | Children mirrors are left in place; children move to "no category" on both sides naturally |
| Voice/invite/AFK channel events | Ignored (kind filter) |
| `syncChannelDeletes` toggled after channels were mirrored | `origin` column decides eligibility, not the toggle history |
| Massive server restructures (bulk edits) | Debounce + coalescing; a full "resync" command can fix drift (see below) |

## 9. Drift repair (recommended, small)

`/bridge structure sync` (management UI, plan 05): one-shot dry-run diff of the two
channel trees (name-matched, like `autolink`), proposing: create missing, link unlinked,
flag orphans. Not automatic — human confirms. This is the safety net for the "bridge was
offline during a big restructure" case.

## 10. Acceptance criteria

- [ ] Creating `#general` (text) on Discord creates `general` on Fluxer, with webhooks and
      a live bridge (and vice versa).
- [ ] Creating a category + channels inside it reproduces the tree on the other side.
- [ ] Rename/topic/slowmode/nsfw changes propagate; no echo loops.
- [ ] Deleting an auto-created channel (with the toggle on) removes its twin + webhooks;
      a manual/autolink channel is never auto-deleted.
- [ ] Turning `syncChannelStructure` off stops all of the above within the cache TTL.
- [ ] Unlinked channels and manual channels are untouched by the sync.

## 11. Open questions

- Should `autoLinkCreatedChannels` create the bridge immediately or queue a
  "pending link" for admin confirmation? (Immediate = quasi-identique goal; confirmation =
  safer for large public servers. Default proposed: immediate.)
- Mirror only text + category in v1 — are announcement channels wanted? (Easy add: same
  type family on both platforms.)
