# PallviAgent

SMS-based emergency immigration intake prototype built with Flask, SQLite, Twilio, and optional Gemini-assisted summary notes.

The app is designed for intake and staff callback routing only. It should not provide legal advice by SMS.

## Local run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
```

## Test

```bash
.venv/bin/python -m unittest discover -s tests
```

## Key routes

- `/sms` - Twilio webhook
- `/simulate` - local testing endpoint
- `/conversations` - list saved conversations
- `/conversations/<phone>` - full conversation detail

## Intake flow

The conversation collects:

- Consent to continue by SMS
- Full name
- Callback phone
- Whether the caller, family, friend, client, or another person needs help
- Current city/state
- Urgency category
- A-number if available
- Preferred callback language
- Brief facts

Completed intakes are classified:

- `P0` - ICE present now, detained now, or equivalent emergency
- `P1` - hearing, removal, or deadline within roughly 72 hours
- `P2` - general urgent intake

## Policy pages

This repo includes:

- `privacy-policy.html`
- `terms.html`

These can be published via GitHub Pages for Twilio A2P registration.

Expected GitHub Pages URLs after Pages is enabled:

- `https://rverma7734.github.io/PallviAgent/privacy-policy.html`
- `https://rverma7734.github.io/PallviAgent/terms.html`

## Twilio webhook

Set the incoming message webhook to:

```text
https://YOUR-DOMAIN/sms
```

The route returns TwiML with a `<Message>` response.

For production, set:

```text
VALIDATE_TWILIO_SIGNATURE=true
PUBLIC_BASE_URL=https://YOUR-DOMAIN
```

This enables Twilio request signature validation for `/sms`.
