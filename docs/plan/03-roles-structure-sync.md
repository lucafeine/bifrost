# Plan 03 — Role structure sync (P5)

Mirror the **role list** (name, color, position, hoist/mentionable flags) between the two
guilds so role mentions and the "color ladder" feel the same on both sides.

> **Scope decision (locked):** structure only. Syncing *who has which role* requires
> identity linking (same person ⇄ same person) and is deferred to P6. See
> [ROADMAP.md](../ROADMAP.md).

Depends on: [00-foundations.md](./00-foundations.md) (`SyncEchoGuard`, `syncRoleStructure`
/ `syncRoleDeletes` toggles).

## 1. Scope

| Action | Mirror | Gated by |
|---|---|---|
| Role created | Create twin (name, color) | `syncRoleStructure` |
| Role renamed / recolored / flags changed | Edit twin | `syncRoleStructure` |
| Role reordered | Reorder twin (best-effort) | `syncRoleStructure` |
| Role deleted | Delete twin | `syncRoleDeletes` (opt-in) + `origin='auto'` |
| Role **membership** (who has it) | ❌ not in this phase | — |
| Permission overwrites / role permissions | ❌ not in this phase (different permission models) | — |

## 2. Data model

Migration `00005-add-role-links.ts`:

```ts
role_links
  id              UUID PK
  guildLinkId     FK → guild_links ON DELETE CASCADE
  discordRoleId   VARCHAR unique
  fluxerRoleId    VARCHAR unique
  name            VARCHAR          // last mirrored name (for mention rendering fallback)
  origin          ENUM('auto','manual')
  createdAt       TIMESTAMP
  INDEX (guildLinkId)
```

## 3. Events & flows

Discord: `Events.GuildRoleCreate`, `GuildRoleUpdate`, `GuildRoleDelete`
(intent `Guilds` — already enabled).
Fluxer: `guildRoleCreate`, `guildRoleUpdate`, `guildRoleDelete`.

### Which roles are mirrored
Skip:
- `@everyone` (both platforms).
- **Managed** roles: bot/integration roles, Discord booster role, Discord/Fluxer system
  roles (`role.managed` on Discord; the equivalent flag on `GuildRole`).
- Roles the bot cannot manage: above the bot's highest role (Discord hierarchy) —
  skip + bridge log.

Everything else (user-created roles) is eligible.

### Create
```
onRoleCreate(platform, role)
  1. guild pair linked? settings.syncRoleStructure? eligible(role)?   else skip
  2. echoGuard.isEcho(`${platform}:role:create:${role.name}:${role.color}`)? → skip
  3. role_links row exists for this role id? → skip
  4. create twin: { name: role.name, color: role.color }
     (RoleCreateOptions on Fluxer: name + color 24-bit RGB; discord.js: guild.roles.create)
     echoGuard.expect on target first
  5. insert role_links (origin='auto')
  6. mirror position: see §4
  7. bridge log: "🎭 role @Foo mirrored"
```

### Update
Diff `name`, `color`, `hoist`, `mentionable` → edit twin. Debounce per guild (bulk role
edits during a restructure) with a 1 s trailing window.
Fluxer note: `RoleEditOptions` marks `unicodeEmoji` read-only → role icons/unicode emoji
are **not** mirrored (documented limitation).

### Delete
Only when `syncRoleDeletes` is on **and** `role_links.origin === 'auto'` → delete twin +
row. Otherwise: keep the twin, bridge-log a warning. (A human-created twin must never be
deleted automatically.)

## 4. Position sync

- Discord: `guild.roles.setPositions()`; Fluxer: `guild.setRolePositions()`.
- Compute the target order from the source's `position` **among mirrored roles only**
  (unmirrored managed/bot roles keep their place; platforms anchor them differently).
- Debounced bulk apply (2 s window per guild pair); do not reorder on every single event.
- Known drift: absolute positions can't match when the two guilds have different numbers
  of roles. Acceptance is **relative order of mirrored roles**, not numeric equality.

## 5. Role mentions in messages (upgrade)

Today mentions degrade to `@name` text (`src/utils/sanitizeMentions.ts:22-26`,
`@unknown-role` fallback). With `role_links`:
1. A Discord role mention `<@&id>` resolves via `role_links` → renders `@{name}` where
   `name` is the mirrored role's name on the target side (even if the source role was
   renamed and caches are stale — store `name` in `role_links` and refresh on update).
2. Same in the other direction.
3. Optionally prefix the mirrored message with a role color swatch
   (e.g. `🟦 @Moderator`) — purely cosmetic; keep behind a setting if added.

Real pings (`<@&id>` on the other side) are deliberately **not** sent: cross-platform
pings would double notifications and the mirrored role ID doesn't exist there anyway.

## 6. Permissions

- Discord: **Manage Roles** (and the bot's top role must sit **above** mirrored roles).
- Fluxer: role create/edit/delete + `setRolePositions`.
- Document in the setup guide: the bot's role must be at the top of the ladder for
  faithful mirroring.

## 7. Edge cases & risks

| Case | Handling |
|---|---|
| Bot's role below some roles | Those roles are unmanageable → skip + bridge log ("move my role up") |
| Role with a Discord-only feature (links, tags, colors > platform limit) | Mirror the common subset (name, color, flags) |
| Color format differences | 24-bit RGB on both; Fluxer `RoleCreateOptions.color` is exactly that |
| Huge role ladders (100+ roles) | Debounce + single bulk position apply; rate limits on role create (Discord: 250 roles/guild hard cap) |
| Duplicate role names | Allowed (IDs disambiguate) |
| Deleting a role that members still have | Platform removes it from members on both sides; membership itself is not tracked in this phase |

## 8. Acceptance criteria

- [ ] Creating a role on Discord creates its twin on Fluxer with the same name/color (and vice versa).
- [ ] Rename/recolor propagates; no echo loops.
- [ ] Relative order of mirrored roles matches across sides after a reorder.
- [ ] Managed/@everyone/bot roles never mirrored.
- [ ] With `syncRoleDeletes` off, deleting a role leaves the twin (warning logged).
- [ ] Role mentions in bridged messages show the correct mirrored name both ways.

## 9. Open questions

- Do we want a **manual mapping** UI ("this Discord role = this existing Fluxer role")
  for guilds that already have parallel roles? (`role_links` with `origin='manual'`
  supports it; the management panel can add a mapping dialog later.)
- Mirror `mentionable` and `hoist` flags, or leave them platform-local? (Proposed: mirror —
  both platforms support them — but harmless to defer.)
