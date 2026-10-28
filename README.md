<p align="center">
  <img height="100px" width="100px" src="./.github/readme-assets/logo_readme.svg" alt="Bifröst logo">
</p>

<h1 align="center">Bifröst</h1>

<p align="center">
  A Discord ⇄ Fluxer bridge that keeps both sides of your community in sync.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="License: GPL-3.0"></a>
  <a href="https://bifrost-bot.com/"><img src="https://img.shields.io/badge/docs-bifrost--bot.com-9b59b6.svg" alt="Documentation"></a>
</p>

Bifröst runs a Discord bot and a Fluxer bot in the same process. Messages posted on one
platform are relayed to the linked channel on the other **through webhooks**, so they keep
the original author's name and avatar. Every relayed message pair is stored in the
database, which is what allows edits and deletions to be mirrored as well.

## Features

- Link channels between a Discord guild and a Fluxer guild, either manually or with
  automatic name matching (`!b autolink`).
- Sync messages both ways: content, replies (rendered as quotes), attachments, stickers,
  embeds, polls (Discord → Fluxer) and join messages.
- Mirror edits and deletions.
- Survive outages: failed relays are queued and replayed when the platform comes back.
- Optional Prometheus metrics, health-check pings and web dashboard.
- Customizable command prefix and per-deployment settings.

> Emoji support is limited to standard Unicode emojis and custom emojis whose **names
> match** on both servers. See [ROADMAP.md](./docs/ROADMAP.md) for the planned emoji mirror.

## Documentation

- Product and setup guides: <https://bifrost-bot.com/>
- Architecture and current state: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- Roadmap and phase plans: [docs/ROADMAP.md](./docs/ROADMAP.md)

## Hosted bot

The upstream project offers a managed instance — see the
[getting started guide](https://bifrost-bot.com/docs/getting-started/) and the
[status page](https://status.bifrost-bot.com). Everything below is about running your own.

## Self-hosting

### Prerequisites

- Docker with the Compose plugin (v2), **or** Node.js 20+ and pnpm 10 for a source install.
- A Discord application and a Fluxer application (bot token and application ID for each).

### 1. Create the bot applications

**Discord**

1. Create an application on the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open the **Bot** tab and reset/copy the token (`BF_DISCORD_TOKEN`).
3. Copy the **Application ID** from the General Information tab (`BF_DISCORD_APP_ID`).
4. Enable **Message Content Intent** under *Privileged Gateway Intents* — without it the
   bot receives empty message content and cannot relay anything.

**Fluxer**

1. Create a bot application on your Fluxer instance and copy its token
   (`BF_FLUXER_TOKEN`) and application ID (`BF_FLUXER_APP_ID`).
2. Self-hosted Fluxer? Point the bot at it with `BF_FLUXER_BASE_URL` (or
   `BF_FLUXER_AUTODISCOVERY_DOMAIN` if your instance supports discovery). See `.env.example`.

On startup the bot logs the **invite links** for both platforms, including the permissions
it needs. Invite it to one Discord guild and one Fluxer guild.

### 2. Get the code and configure the environment

```bash
git clone https://github.com/lucafeine/bifrost.git
cd bifrost
cp .env.example .env
```

Fill in the four required values (`BF_DISCORD_TOKEN`, `BF_DISCORD_APP_ID`,
`BF_FLUXER_TOKEN`, `BF_FLUXER_APP_ID`). Everything else has a sensible default — the full
reference is in [`.env.example`](./.env.example), and the most common settings are listed
[below](#configuration).

> Keep `.env` private: it contains bot tokens.

### 3. Start the bot

**Option A — Official prebuilt image**

```bash
docker compose up -d
docker compose logs -f bifrost
```

This uses `docker-compose.yml` and pulls `kartoffelchipss/bifrost:latest`.

**Option B — Build your own image** (no official image involved)

```bash
docker compose -f docker-compose-build.yml up -d --build
docker compose -f docker-compose-build.yml logs -f bifrost
```

This builds the image locally from the [Dockerfile](./Dockerfile) and tags it
`bifrost:local`. Build metadata is optional but shows up in `!b stats`:

```bash
GIT_COMMIT="$(git rev-parse --short HEAD)" \
REPO_URL="https://github.com/lucafeine/bifrost" \
docker compose -f docker-compose-build.yml up -d --build
```

> On PowerShell, set `$env:GIT_COMMIT` / `$env:REPO_URL` before running the command.

**Option C — From source (no Docker)**

```bash
corepack enable
pnpm install
pnpm build
node dist/index.js
```

> On Windows, `corepack enable` may require an elevated shell. If it fails, prefix the
> commands with `corepack` instead (`corepack pnpm install`, `corepack pnpm build`, …).

For development with hot reload, use `pnpm exec tsx watch src/index.ts` instead of the last
two steps (see [Development](#development)).

### 4. Link your servers

Commands work on both platforms with the same prefix (default `!b `):

```text
# On Discord, link the current guild to a Fluxer guild (then confirm)
!b link <fluxerGuildId>
!b link confirm

# In a Discord channel, link it to a Fluxer channel (then confirm)
!b link <fluxerChannelId>
!b link confirm

# Or let the bot propose links by channel-name similarity
!b autolink
!b autolink confirm

!b list       # show existing channel links
!b unlink <id> # remove a guild or channel link
!b help       # everything else
```

The same commands exist on the Fluxer side, with Discord IDs as arguments. Use `!b list`
after linking to verify the pairs.

### PostgreSQL instead of SQLite

SQLite is the default and stores its database in `./config/data.sqlite`. For PostgreSQL,
use the all-in-one compose file:

```bash
# add POSTGRES_PASSWORD=... to .env first
docker compose -f docker-compose-aio.yml up -d
```

To do the same with a **self-built image**, copy the `bifrost` service from
`docker-compose-aio.yml` and replace its `image:` line with the `build:` block from
`docker-compose-build.yml` (`context: .`, `dockerfile: Dockerfile`).

### Updating

```bash
# official image
docker compose pull && docker compose up -d

# self-built image
git pull
docker compose -f docker-compose-build.yml up -d --build

# postgres all-in-one
docker compose -f docker-compose-aio.yml pull && docker compose -f docker-compose-aio.yml up -d
```

Database migrations run automatically at startup.

### Backups

- SQLite: back up the `./config` folder (it contains `data.sqlite`).
- PostgreSQL: back up the `postgres_data` volume.

### Ports

Nothing is published by default. If you enable the web dashboard, uncomment the `9092`
port mapping in your compose file. Metrics are served on `BF_METRICS_PORT` (default
`9091`, endpoint `/metrics`) for Prometheus scraping — keep that port internal.

## Configuration

All settings are environment variables. See [`.env.example`](./.env.example) for the
exhaustive, commented list.

| Variable | Default | Description |
|---|---|---|
| `BF_DISCORD_TOKEN` / `BF_FLUXER_TOKEN` | — | **Required.** Bot tokens (also support `*_FILE` variants for Docker secrets). |
| `BF_DISCORD_APP_ID` / `BF_FLUXER_APP_ID` | — | **Required.** Application IDs, used for the invite links. |
| `BF_COMMAND_PREFIX` | `!b ` | Prefix for commands on both platforms. |
| `BF_DISCORD_OWNER_ID` / `BF_FLUXER_OWNER_ID` | — | Owner user IDs, unlocks debug commands such as `!b list all`. |
| `BF_DB_DIALECT` | `sqlite` | `sqlite` or `postgres`. |
| `BF_DB_NAME` / `BF_DB_USER` / `BF_DB_PASS` / `BF_DB_HOST` / `BF_DB_PORT` | — / — / — / `localhost` / `5432` | PostgreSQL connection (ignored for SQLite). |
| `BF_DELETE_INVOCATION` | `false` | Deletes the invoking `!b …` message (reduces command spam). |
| `BF_DISABLE_MESSAGE_QUEUE` | `false` | Disable the failed-relay retry queue. |
| `BF_QUEUE_TTL_MS` | `300000` | How long queued messages are kept for retry. |
| `BF_METRICS_PORT` | `9091` | Prometheus metrics port. |
| `BF_ENABLE_WEB_DASHBOARD` | `false` | Enable the optional web dashboard (currently frozen, not developed further). |
| `BF_WEB_PORT` / `BF_WEB_PUBLIC_URL` / `BF_SESSION_SECRET` | `9092` / `http://localhost:9092` / — | Dashboard binding and OAuth settings. |
| `BF_FLUXER_AUTODISCOVERY_DOMAIN` / `BF_FLUXER_BASE_URL` | — | Custom Fluxer instance. |
| `BF_DISCORD_HEALTH_URL` / `BF_FLUXER_HEALTH_URL` | — | Push health status to an uptime monitor. |
| `BF_FLUXER_GUILD_CACHE_LIMIT` / `BF_FLUXER_CHANNEL_CACHE_LIMIT` | `0` (unbounded) | Cap Fluxer client caches on large instances. |

## Development

Requires Node.js 20+ and pnpm 10 (the repo pins `pnpm@10.27.0` through Corepack).

```bash
corepack enable
pnpm install

pnpm exec tsx watch src/index.ts   # bot with hot reload
pnpm --dir dashboard dev           # dashboard dev server (optional)

pnpm build       # compile the bot (tsc) into dist/
pnpm lint        # eslint + prettier checks
pnpm test        # vitest unit + migration tests
```

If you use [Task](https://taskfile.dev), shortcuts are available:
`task dev:bot`, `task dev:dashboard`, `task prod:build`, `task prod:up`,
`task prod:docker:up` (build the image locally and start it).

Useful layout:

```text
src/discord.ts, src/fluxer.ts   client bootstrap + command/event wiring
src/services/                   relay, transformers, webhooks, queue, metrics, sync foundations
src/db/                         Sequelize models, repositories, umzug migrations
src/commands/                   prefix commands, one folder per platform
dashboard/                      React dashboard (frozen)
docs/                           architecture, roadmap and phase plans
```

## Contributing

Bug reports and feature requests are welcome through the issue templates. Before opening a
pull request, run `pnpm lint`, `pnpm test` and `pnpm build`; keep changes consistent with
the surrounding code and the current phase plans in [docs/plan](./docs/plan).

## Community

Join the community Fluxer server for support and updates:
<https://bifrost-bot.com/community/fluxer>

## License & credits

Licensed under the [GNU GPL-3.0](./LICENSE). Originally created by
[KartoffelChipss](https://github.com/KartoffelChipss/bifrost).
