# Cloudflare Workers Deployment

Cloudflare Workers is the preferred low-cost deployment path for this project. It avoids always-on server pricing and is a good fit for Twilio SMS webhooks.

## What This Adds

The `worker/` directory contains a Cloudflare Worker version of the intake system:

- `POST /sms` for Twilio incoming SMS webhooks.
- `GET /health` for smoke tests.
- `GET /privacy-policy.html` and `GET /terms.html` as backup policy URLs.
- Cloudflare KV storage for conversation state.
- Optional Twilio request signature validation.
- Staff SMS alerts using the Twilio REST API, with immediate urgent alerts and automatic retries.
- Minimal consent and opt-out audit events with bounded retention.

## Cloudflare Setup

1. In Cloudflare, create a Workers KV namespace named `PALLVI_INTAKES`.
2. Copy its namespace ID.
3. In Cloudflare, bind the namespace to the Worker with this binding name:

```text
INTAKE_KV
```

The root `wrangler.toml` is intentionally used for Cloudflare's GitHub deployment flow. The `worker/wrangler.toml` file is kept for local Worker-only development.

Current KV namespace ID:

```text
65b5756f72064b4786698cf00670fa7a
```

## Secrets And Variables

Set these in the Cloudflare Worker dashboard.

Variables:

```text
INTAKE_ORG_NAME=PallviAgent
PUBLIC_BASE_URL=https://pallvi-agent.rohitverma7734.workers.dev
VALIDATE_TWILIO_SIGNATURE=true
GEMINI_MODEL=gemini-2.0-flash
DATA_RETENTION_DAYS=30
```

Secrets:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
STAFF_ALERT_PHONE
STAFF_ALERT_EMAIL
GEMINI_API_KEY
```

`GEMINI_API_KEY` and `STAFF_ALERT_EMAIL` are optional in the Worker version. Staff alert SMS requires the Twilio values and `STAFF_ALERT_PHONE`. Do not launch overnight intake until all four Twilio/staff alert secrets are configured and a real alert has been received by staff.

## Operational Behavior

- A sender must text `START` and then `YES` before intake questions begin.
- P0/P1 answers trigger an immediate minimized staff alert; completion triggers a final handoff alert.
- Failed staff alerts are retried every five minutes, up to three total attempts.
- Incomplete intake state expires after seven days. Completed intake state defaults to 30 days. Minimal declined-consent and opt-out audit records expire after 90 days.
- The automated flow never asks for documents, A-numbers, Social Security numbers, or passport numbers.

## Cloudflare GitHub Build Settings

If deploying from the Cloudflare dashboard with GitHub connected:

```text
Root directory: worker
Build command: npm install
Deploy command: npx wrangler deploy
```

If Cloudflare asks for the Worker entrypoint:

```text
worker/src/index.mjs
```

## Local Test

```bash
cd worker
npm install
npm test
```

## Twilio Webhook

After Cloudflare deploys, set the Twilio incoming SMS webhook to:

```text
https://pallvi-agent.rohitverma7734.workers.dev/sms
```

Method: `POST`.

## Smoke Tests

```bash
curl https://pallvi-agent.rohitverma7734.workers.dev/health
curl -I https://pallvi-agent.rohitverma7734.workers.dev/privacy-policy.html
curl -I https://pallvi-agent.rohitverma7734.workers.dev/terms.html
```

The existing GitHub Pages URLs remain valid for A2P registration:

- `https://rverma7734.github.io/PallviAgent/privacy-policy.html`
- `https://rverma7734.github.io/PallviAgent/terms.html`
