# Visa Slot Watcher (JS)

Watches Japan visa booking slots from:
`https://toronto.rsvsys.jp/reservations/calendar`

When a new matching slot appears, it sends a Telegram message.

## What it watches

- Category: `VISA Application` (event id usually `16`)
- Plan IDs can be set explicitly (recommended), e.g.:
  - `20` VISA Application up to 4 applicants
  - `34` Working Holiday Visa Application
  - `24` VISA Application with COE
  - `35` VISA Application for Canada Travel Document holders
  - `23` VISA Application 5 applicants or more

If `PLAN_IDS` is empty, the watcher auto-selects plans whose label contains `visa`.

## Setup

1. Copy env template:
```bash
cp .env.example .env
```

2. Fill in:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `PLAN_IDS` (comma-separated plan ids you want)

3. Run:
```bash
set -a; source .env; set +a
npm start
```

## Telegram quick setup

1. Create bot with `@BotFather`, get token.
2. Send a message to your bot from your Telegram account.
3. Get chat id by opening:
`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Put your numeric `chat.id` into `TELEGRAM_CHAT_ID`.

## Config

From `.env`:

- `POLL_INTERVAL_MS` default `45000`
- `REQUEST_TIMEOUT_MS` default `20000`
- `MONTHS_AHEAD` default `1`
- `PLAN_IDS` comma-separated integers
- `DRY_RUN=true` to print alerts without Telegram send
- `STATE_FILE` for dedup state persistence

The app sends one Telegram "started" message at startup, then only sends Telegram messages when new slots are found.

## How dedup works

It stores seen keys as `<planId>|<YYYY-MM-DD>` in `STATE_FILE`.
A specific plan/date pair is only alerted once unless you clear the state file.

## Deploy (recommended: Railway)

1. Push this folder to GitHub.
2. In Railway: New Project -> Deploy from GitHub Repo.
3. Add environment variables from `.env`.
4. Start command: `node src/index.js`.
5. Keep it as a worker service (not web).

If Railway datacenter IP is blocked by target site, deploy on:
- Home server / Raspberry Pi (best reliability for scraping)
- A small VPS with stable IP and monitoring

## Docker

Build:
```bash
docker build -t visa-watcher .
```

Run:
```bash
docker run --env-file .env -v $(pwd)/.watcher-state.json:/app/.watcher-state.json visa-watcher
```

If state file does not exist yet:
```bash
echo '{"seen":{}}' > .watcher-state.json
```

## Notes

- Site markup can change. If alerts stop, update parser selectors in `src/index.js`.
- Keep poll interval reasonable to avoid rate-limits/blocking.
