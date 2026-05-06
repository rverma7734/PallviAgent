# Cloudflare Workers Deployment

Cloudflare Workers is the preferred low-cost deployment path for this project. It avoids always-on server pricing and is a good fit for Twilio SMS webhooks.

## What This Adds

The `worker/` directory contains a Cloudflare Worker version of the intake system:

- `POST /sms` for Twilio incoming SMS webhooks.
- `GET /health` for smoke tests.
- `GET /privacy-policy.html` and `GET /terms.html` as backup policy URLs.
- Cloudflare KV storage for conversation state.
- Optional Twilio request signature validation.
- Optional staff SMS alerts using the Twilio REST API.

## Cloudflare Setup

1. In Cloudflare, create a Workers KV namespace named `PALLVI_INTAKES`.
2. Copy its namespace ID.
3. In Cloudflare, bind the namespace to the Worker with this binding name:

```text
INTAKE_KV
```

The root `wrangler.toml` is intentionally used for Cloudflare's GitHub deployment flow. The `worker/wrangler.toml` file is kept for local Worker-only development.

## Secrets And Variables

Set these in the Cloudflare Worker dashboard.

Variables:

```text
INTAKE_ORG_NAME=PallviAgent
PUBLIC_BASE_URL=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev
VALIDATE_TWILIO_SIGNATURE=true
GEMINI_MODEL=gemini-2.0-flash
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

`GEMINI_API_KEY` and `STAFF_ALERT_EMAIL` are optional in the Worker version. Staff alert SMS requires the Twilio values and `STAFF_ALERT_PHONE`.

## Cloudflare GitHub Build Settings

If deploying from the Cloudflare dashboard with GitHub connected:

```text
Root directory: worker
Build command: npm install
Deploy command: npx wrangler deploy
```

If Cloudflare asks for the Worker entrypoint:

```text
worker/src/index.js
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
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/sms
```

Method: `POST`.

## Smoke Tests

```bash
curl https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
curl -I https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/privacy-policy.html
curl -I https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/terms.html
```

The existing GitHub Pages URLs remain valid for A2P registration:

- `https://rverma7734.github.io/PallviAgent/privacy-policy.html`
- `https://rverma7734.github.io/PallviAgent/terms.html`
