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
PUBLIC_BASE_URL=https://pallviagent.rohitverma7734.workers.dev
VALIDATE_TWILIO_SIGNATURE=true
STAFF_ACK_ENABLED=false
STAFF_ACK_TIMEOUT_MINUTES=15
AI_TRIAGE_ENABLED=true
AI_MODEL=@cf/meta/llama-3.2-3b-instruct
AI_TRIAGE_TIMEOUT_MS=2500
DATA_RETENTION_DAYS=30
```

Secrets:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
STAFF_ALERT_PHONE
STAFF_BACKUP_PHONE
```

Workers AI uses the `AI` binding in `wrangler.toml`; no additional AI API key is required. Do not launch overnight intake until the Twilio values and `STAFF_ALERT_PHONE` are configured and a real alert has been received by staff.

## Operational Behavior

- A sender must text `START` and then `YES` before intake questions begin.
- Twilio webhook retries with the same `MessageSid` reuse the original response for 24 hours and do not advance the intake twice.
- MMS attachments are rejected; clients are instructed to resend only basic facts as text.
- P0/P1 answers trigger one immediate compact staff alert. P2 cases send one compact alert at completion; a successful urgent alert is not duplicated at completion.
- Deterministic rules remain authoritative. Workers AI reviews only ambiguous free-text urgency answers, receives no identity or contact fields, and may only escalate P2 to P1/P0. AI errors fall back to deterministic routing.
- Failed staff alerts are retried every five minutes, up to three total attempts.
- Optional staff acknowledgment accepts `ACK <case-code>` only from the configured primary or backup staff numbers. Overdue P0/P1 alerts can escalate to the backup number.
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
https://pallviagent.rohitverma7734.workers.dev/sms
```

Method: `POST`.

The approved 10DLC number must be in the Sender Pool of the Messaging Service associated with the approved campaign. In the Messaging Service's **Integration** settings, either keep **Defer to sender's webhook** and configure the number itself with the URL above, or select the common webhook option and set the same URL there. Do not configure both paths to invoke different applications.

Before enabling the line, confirm the Worker has `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, and `STAFF_ALERT_PHONE`. Send one real `START` message and complete one fake urgent intake to verify both the client reply and staff alert.

## Smoke Tests

```bash
curl https://pallviagent.rohitverma7734.workers.dev/health
curl -I https://pallviagent.rohitverma7734.workers.dev/privacy-policy.html
curl -I https://pallviagent.rohitverma7734.workers.dev/terms.html
```

The existing GitHub Pages URLs remain valid for A2P registration:

- `https://rverma7734.github.io/PallviAgent/privacy-policy.html`
- `https://rverma7734.github.io/PallviAgent/terms.html`

## Staff Acknowledgment Rollout

Leave `STAFF_ACK_ENABLED=false` until both staff destinations have received a real test alert. Then configure distinct E.164 numbers for `STAFF_ALERT_PHONE` and `STAFF_BACKUP_PHONE`, choose a timeout from 1 to 120 minutes, and enable the flag. See `OPERATIONS.md` for the test and on-call procedure.
