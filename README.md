# PallviAgent

SMS-based immigration intake prototype built with Flask, SQLite, Twilio, and Gemini-assisted summary notes.

## Local run

```bash
./venv/bin/python server.py
```

## Key routes

- `/sms` - Twilio webhook
- `/simulate` - local testing endpoint
- `/conversations` - list saved conversations
- `/conversations/<phone>` - full conversation detail

## Policy pages

This repo includes:

- `privacy-policy.html`
- `terms.html`

These can be published via GitHub Pages for Twilio A2P registration.
