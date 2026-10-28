# Plan 06 — Conversation quick wins (P3)

Small, high-value features that make conversations feel alive across the bridge.

Depends on: [00-foundations.md](./00-foundations.md) (settings toggles, `SyncEchoGuard`).

## 1. Typing indicators

"X is en train d'écrire…" cross-platform. Cheap and very noticeable.

- Discord → Fluxer: `Events.TypingStart` (intent `GuildMessageTyping`, non-privileged) →
  `fluxerChannel.sendTyping()`.
- Fluxer → Discord: `typingStart` event → `discordChannel.sendTyping()`.
- Behavior notes:
  - Skip bots/webhooks and the bridge itself.
  - Throttle per `(channelLinkId, userId)`: forward at most every **8 s** (Discord typing
    indicators last ~10 s and re-fire while typing; a single `sendTyping()` is enough per
    window on both platforms).
  - Gated by `syncTyping` (default on).
- Edge cases: typing in a channel whose link is gone → skip; partials not an issue
  (`typingStart` always carries channel + user ids).

## 2. Pins sync

- Events: `Events.MessagePinsUpdate` (Discord) / `channelPinsUpdate` (Fluxer) — use them
  as *triggers* to reconcile, plus direct mirroring on the action itself:
  - Discord: `message.pin()` / `message.unpin()` (needs **Manage Messages**).
  - Fluxer: `message.pin()` / `message.unpin()`.
- Flow: pin/unpin on a **linked message** (`message_links` lookup) → pin/unpin the twin.
  Echo-guarded (`discord:pin:{messageId}:{state}`).
- Skip when the target message is missing (deleted twin) or already in the desired state.
- Gated by `syncPins` (default on).
- Note: the pins *list* on each side shows only that side's pins; we mirror pin **state**
  of bridged messages, which is what users notice.

## 3. Bulk delete mirror

- Events: `Events.MessageDeleteBulk` (Discord) / `messageDeleteBulk` (Fluxer).
- Resolve every deleted source message through `message_links`, batch-delete the twins
  (concurrency ~5, respect rate limits). Reuse the single-delete path
  (`src/discord.ts:157-201`, `src/fluxer.ts:164-204`) extracted into `LinkService`.
- Skip messages without links (pre-bridge). Partial link coverage is fine.

## 4. System messages (join/leave/moderation)

Today only joins are relayed as text (`src/utils/formatJoinMessage.ts`,
`DiscordToFluxerMessageRelay.ts:68-73`, `FluxerToDiscordMessageRelay` equivalent at
`FluxerToDiscordMessageRelay.ts:55-65`). Upgrade to a consistent "system embed" posted via
the existing webhooks or a dedicated bot message:

| Event | Discord | Fluxer | Rendered as |
|---|---|---|---|
| Member joined | `guildMemberAdd` | `guildMemberAdd` | "👋 X joined" (existing text) |
| Member left | `guildMemberRemove` | `guildMemberRemove` | "🚶 X left" |
| Banned | `guildBanAdd` | `guildBanAdd` | "🔨 X was banned" |
| Unbanned | `guildBanRemove` | `guildBanRemove` | "🔓 X was unbanned" |
| Kick / timeout | `guildAuditLogEntryCreate` | `guildAuditLogEntryCreate` | "👢 X was kicked" / "⏳ X timed out" |

- ⚠️ Discord side needs the **privileged `GuildMembers` intent** for
  `guildMemberAdd/Remove`. Make this feature degrade gracefully: if the intent is missing,
  log once at startup and disable member events (ban events use `GuildModeration`, which is
  non-privileged).
- Renders through the same transformer pipeline (username/avatar of the *subject* is not
  available for leavers → use the bot's embed style with the name).
- Gated by `syncSystemMessages` (default on, minus the member events when the intent is off).

## 5. Polls

Verified platform fact: **Fluxer has no native polls** (no poll types in
`@fluxerjs/types@3.3.0`). So:
- Discord → Fluxer: keep the current text renderer
  (`src/utils/pollMessageFormatter.ts`) but improve it:
  - Prefix/labels localized and platform-neutral (today it hardcodes "created on Discord").
  - Map each option to a numbered emoji and instruct Fluxer users to **react** to vote —
    with P2 reactions synced, votes show up back on Discord as reactions (approximate but
    alive). Optional: a "results" line refreshed on edit.
  - Answering the poll itself from Fluxer is impossible (Discord polls only accept real
    votes from real users) — document in the rendered message.
- Fluxer → Discord: nothing to do (no polls on Fluxer).
- If Fluxer adds polls later: Discord's poll API (`MessagePollVoteAdd/Remove` events,
  poll message send options) can mirror results as an edited summary.

## 6. Reply fidelity (stretch)

Native cross-platform replies are impossible today (Discord webhook executes don't accept
`message_reference`). Current quote-embed approach stays. Small upgrade: make the quote
clickable where a jump URL exists (Discord message link), and store `message_links` to
render the twin's URL when the reply target is itself a bridged message.

## 7. Acceptance criteria

- [ ] Typing on one side shows the typing indicator on the other within ~1 s, throttled.
- [ ] Pinning a bridged message pins its twin (and unpin likewise).
- [ ] Bulk-deleting 20 messages on one side removes the twins on the other.
- [ ] Joins/leaves/bans render as clean bot messages both ways (with the intents present).
- [ ] Poll renderer: options + react-to-vote hint; no hardcoded "Discord" phrasing.
- [ ] Every feature respects its settings toggle and never loops (echo guard).

## 8. Open questions

- Typing indicators expose *who* is typing to the other platform — some servers may not
  want that. Toggle `syncTyping` default on or off? (Proposed: on — it's ephemeral data.)
- System messages: use webhook impersonation (consistent look) or plain bot embeds (clearer
  that it's a bridge event)? Proposed: bot embeds with a distinct color.
