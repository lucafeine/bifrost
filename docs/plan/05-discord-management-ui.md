# Plan 05 — Discord management interface (P1)

Replace the `!b … / !b … confirm` command flow on Discord with slash commands and
interactive components (buttons, select menus, modals): a real admin panel.

> Platform constraint (verified): **Fluxer has no interaction model** (no slash commands,
> buttons, or components in `@fluxerjs/core` / `@fluxerjs/types`). The panel is
> Discord-only; Fluxer keeps the prefix commands `!b` unchanged.

Independent of P2–P5 — can be built first or in parallel. Recommended early: it makes
testing every later phase cheaper.

## 1. Command surface

Single command group with subcommands (keeps the global command count small):

| Command | What it does | Replaces |
|---|---|---|
| `/bridge link guild partner:` | Guild pairing wizard (partner guild ID → confirm button) | `!b link <id>` + `!b link confirm` |
| `/bridge link channel [discord_channel] [fluxer_channel]` | Channel linking (autocomplete both sides) | `!b link <id>` + `confirm` |
| `/bridge autolink [apply]` | Fuzzy-match preview (table embed) → "Apply" button | `!b autolink` |
| `/bridge unlink target:` | Select menu of links (channels + guild) → confirm button | `!b unlink` |
| `/bridge list` | Paginated embed of channel links (with `linkId`) | `!b list` |
| `/bridge settings` | Interactive settings panel (see §3) | — (new) |
| `/bridge status` | Pings, queue depth, link counts, health | `!b stats` |
| `/bridge log channel:` | Set/clear the bridge-log channel | — (new) |
| `/bridge structure sync` *(P4)* | Dry-run drift diff + apply | — (new) |

Keep `!b` commands working on Discord too (people have scripts/bots posting them), but the
help output advertises the slash commands.

## 2. Interaction architecture

```
src/commands/interactions/
  registerCommands.ts        # REST put, guild-scoped, diffed by JSON hash
  InteractionRouter.ts       # Events.InteractionCreate → chat / button / select / modal
  handlers/
    linkGuild.ts  linkChannel.ts  autolink.ts  unlink.ts
    list.ts  settings.ts  status.ts  logChannel.ts
  components/
    confirmPanel.ts          # reusable Confirm/Cancel button pair
    settingsPanel.ts         # toggle buttons + state embed
```

- **Registration**: guild commands (`Routes.applicationGuildCommands`) at startup for the
  guilds in `guild_links` — instant updates, no global propagation delay. Switch to global
  commands (`Routes.applicationCommands`) once stable. Store a hash of the command JSON to
  avoid re-registering on every boot (rate limits).
- **Permissions**: `defaultMemberPermissions: [ManageGuild]` for the group; channel
  linking additionally requires Manage Webhooks (mirror `DiscordCommandHandler.requirePermission`,
  `src/commands/discord/DiscordCommandHandler.ts:28-71`). Owner-only commands
  (`list all`, admin stats) check `BF_DISCORD_OWNER_ID`.
- **Replies**: ephemeral by default (admin noise stays private).
- **State**: the existing two-step "pending action" TTL maps
  (`LinkDiscordCommandHandler.ts:23-53`, 5 min) can back the confirm buttons; key them by
  interaction user + guild. In-memory is fine for the current single-process architecture
  (note in code where a DB-backed store would go if multi-instance ever ships).
- **Component state**: `customId` encodes the action + target
  (`bifrost:link:confirm:<token>`); route in `InteractionRouter`.

## 3. Settings panel (`/bridge settings`)

Embed showing every toggle from `guild_link_settings` (foundations §1) with live state,
plus:

```
┌─ Bifröst — #general ⇄ general ──────────────────────────┐
│ ✅ Reactions sync ................. [on]   [toggle]      │
│ ✅ Typing indicators .............. [on]   [toggle]      │
│ ✅ Pins ........................... [on]   [toggle]      │
│ ⬜ Channel structure sync ......... [off]  [toggle]      │
│ ⬜ Auto-link created channels ..... [on]   [toggle]      │
│ ⬜ Channel delete sync ............ [off]  [toggle]      │
│ ⬜ Role structure sync ............ [off]  [toggle]      │
│ ✅ Emoji mirror ................... [on]   [toggle]      │
│                                                            │
│ [Bridge log channel]  [Unlink]  [Status]                   │
└────────────────────────────────────────────────────────────┘
```

Implementation: one embed + a row of button pairs (or a StringSelect with options when
buttons get crowded — select menus support multi-select toggles nicely). Each interaction
writes the setting (write-through + local cache invalidation) and refreshes the embed.

## 4. Fluxer side (unchanged for now)

- `!b` commands stay as-is (`src/commands/fluxer/`).
- Optional nicety (cheap, later): a numbered text menu (`!b panel` → "reply with 1-9")
  since Fluxer has no components. Not required for P1.

## 5. Web dashboard: frozen

Per the locked decision ([ROADMAP.md](../ROADMAP.md)):
- `src/web/` and `dashboard/` are **not developed further and not deleted**.
- `BF_ENABLE_WEB_DASHBOARD` stays; hosted instance keeps it off unless needed.
- The OAuth flows (`src/web/oauth/discordOAuth.ts`, `fluxerOAuth.ts`) are earmarked for the
  future account-linking phase (P6) — do not refactor them away.
- Cleanup note: `dashboard/src/api/client.ts:153-170` calls non-existent
  `/api/admin/guild-links` routes (dead code). When the freeze ends, either implement or
  remove.

## 6. Permissions / setup flow UX

- `/bridge link guild` should detect missing bot permissions early: when the user picks a
  target channel, reply with a checklist ("❌ Manage Webhooks missing on Fluxer's #general")
  instead of failing halfway. Reuse the invite-link helper
  (`src/utils/generateBotInvite.ts`, `src/web/routes/invites.ts`) to offer the bot invite
  for the missing side.
- Autocomplete for `fluxer_channel` uses the linked Fluxer guild's cached channel list
  (`FluxerEntityResolver`) + `channelMatcher` scoring for fuzzy names.

## 7. Acceptance criteria

- [ ] Every `!b` management action is reachable via `/bridge` with ≤ 3 interactions
      (command → select → confirm).
- [ ] Permission errors are caught **before** the action with a clear checklist.
- [ ] Settings panel toggles take effect within the settings cache TTL.
- [ ] Replies are ephemeral; no admin spam in bridged channels.
- [ ] Command registration doesn't re-PUT on every restart (hash diff).
- [ ] `!b` still works on both platforms (no regression).

## 8. Open questions

- Guild commands during beta (instant updates) vs. global from day one (visibility in
  every server the bot joins)? Proposed: guild commands → global at v1.7.x stability.
- Should the panel also be reachable from the **Fluxer** side as a read-only summary
  (`!b status` already close)?
