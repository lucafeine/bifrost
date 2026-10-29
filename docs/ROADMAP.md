# Bifröst — Roadmap

> Goal: make the experience **quasi-identical on both platforms** — a member can stay on
> Discord or move to Fluxer without losing the "life of the server".
>
> Status is tracked per phase below. Each phase has a detailed technical plan in
> `docs/plan/`. Current state is described in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Decisions (locked)

- **Web dashboard: frozen.** Not developed further, not deleted. The Discord + Fluxer
  OAuth flows in `src/web/oauth/` are kept as the likely base for future account linking.
- **Role sync: structure only.** Mirroring who-has-which-role requires identity linking
  (same person on both platforms) and is deferred to a future phase.
- **Management interface: on Discord.** Slash commands + buttons/selects/modals.
  Fluxer keeps prefix commands (`!b`), since the Fluxer API has no interaction model.

## Feature gaps vs. the "quasi-identique" goal

| Gap | Impact for users | Phase |
|---|---|---|
| Reactions don't cross the bridge | 🔴 High — most visible daily difference | P2 |
| Channel created on one side doesn't exist on the other | 🔴 High — servers drift apart | P4 |
| No typing indicators | 🟠 Medium — conversations feel dead | P3 |
| Custom emojis break (name matching only) | 🟠 Medium | P5 |
| Roles don't exist on the other side | 🟠 Medium — mentions/status | P5 |
| Pins not synced | 🟡 Low-Medium | P3 |
| Bulk deletes / moderation events not mirrored | 🟡 Low-Medium | P3 |
| Management only via `!b` commands | 🟠 Medium — UX for admins | P1 |

## Phases

### P0 — Foundations (prerequisite for P2–P5) · size S/M · ✅ done · plan: [00-foundations.md](./plan/00-foundations.md)
- `guild_link_settings` table (per-link feature toggles).
- `SyncEchoGuard` (loop prevention for mirrored actions).
- `EmojiMapper` service skeleton (shared by reactions, content, emoji mirror).
- Metrics + bridge-log plumbing.

### P1 — Discord management interface · size L · plan: [05-discord-management-ui.md](./plan/05-discord-management-ui.md)
Slash commands + interactive panels: link guild/channel, autolink, list, unlink,
settings toggles, status. Independent of other phases — can be built in parallel.
Replaces the painful `!b … / !b … confirm` flow on Discord (kept on Fluxer).

### P2 — Reactions sync · size M · 🟡 implemented (live test pending) · plan: [01-reactions-sync.md](./plan/01-reactions-sync.md)
Add/remove/emoji-remove/remove-all mirrored both ways on linked messages.
Custom + unicode emojis via `EmojiMapper`.

### P3 — Conversation quick wins · size S/M · plan: [06-quality-of-life.md](./plan/06-quality-of-life.md)
Typing indicators, pins sync, bulk delete mirror, system messages
(join/leave/ban/kick) as bot embeds, poll renderer improvements.

### P4 — Channel structure sync · size L · plan: [02-channels-sync.md](./plan/02-channels-sync.md)
Mirror channel/category create, rename, topic, slowmode, delete (opt-in, destructive
actions gated). Auto-link created channels (webhooks + `channel_links`).

### P5 — Emoji mirror + role structure · size M/L · plans: [04-emoji-mirror.md](./plan/04-emoji-mirror.md), [03-roles-structure-sync.md](./plan/03-roles-structure-sync.md)
Lazy custom-emoji mirroring (fixes name-matching fragility, unlocks native reactions),
role list mirror (name/color/position) + improved role mentions.

### P6 — Future (not committed) · size XL
- **Identity linking** (Discord account ⇄ Fluxer account) → role *membership* sync,
  nickname sync, moderation sync (ban/kick/timeout mirrored per-user).
- Thread ⇄ linked channel bridging.
- Native reply fidelity (if platform APIs ever allow webhook message references).
- Per-channel permission-overwrite mapping via role links.

## Out of scope

- Voice / stage / video bridging.
- Syncing platform-specific features (Discord activities, forum tags, server discovery…).
- Permission-overwrite parity (different permission models; see P6 note).

## Suggested order & parallelism

```
P0 ──▶ P2 ──▶ P4 ──▶ P5
 │               ▲
 └──▶ P1 ────────┤ (independent, admin UX early = easier testing of everything else)
                 │
      P3 ────────┘ (anytime after P0)
```

**Recommendation:** P0 + P1 first (admin UX makes testing every later phase cheaper),
then P2 (biggest user-visible win), then P3/P4/P5.

## Bot permission requirements (to revisit `generateBotInvite.ts`)

| Feature | Discord permission | Fluxer permission |
|---|---|---|
| Webhooks (core) | Manage Webhooks | Manage Webhooks |
| P2 reactions (full fidelity) | Manage Messages *(to clear/mirror others' reactions)* | Manage Messages |
| P3 pins | Manage Messages | Manage Messages |
| P4 channel sync | Manage Channels | Manage Channels |
| P5 emoji mirror | Manage Guild Expressions | Manage Expressions |
| P5 role mirror | Manage Roles | Manage Roles |

The invite permission constant `536947712` (`src/utils/generateBotInvite.ts`,
`src/web/routes/invites.ts`) must be updated when phases land.
