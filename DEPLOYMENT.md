# Deployment

## Public Policy URLs

These GitHub Pages URLs are live and can be used for Twilio A2P registration:

- Privacy Policy: `https://rverma7734.github.io/PallviAgent/privacy-policy.html`
- Terms and Conditions: `https://rverma7734.github.io/PallviAgent/terms.html`

## Render Web Service

This repo includes `render.yaml` and `Procfile` for deploying the Flask webhook service.

1. Create or open a Render account.
2. Choose **New** -> **Blueprint**.
3. Connect GitHub repository `rverma7734/PallviAgent`.
4. Select the blueprint from `render.yaml`.
5. Set environment variables:

```text
PUBLIC_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com
VALIDATE_TWILIO_SIGNATURE=true
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
STAFF_ALERT_PHONE=...
STAFF_ALERT_EMAIL=...
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
ADMIN_API_TOKEN=generate-a-long-random-secret
ENABLE_SIMULATOR=false
ENABLE_DEBUG_OUTPUT=false
```

`GEMINI_API_KEY` is optional. If it is blank, the app uses deterministic fallback staff notes.

## Twilio Webhook

After deployment, configure the Twilio phone number incoming SMS webhook:

```text
https://YOUR-RENDER-SERVICE.onrender.com/sms
```

Use HTTP `POST`.

## Smoke Tests

After deployment:

```bash
curl https://YOUR-RENDER-SERVICE.onrender.com/health
curl -I https://YOUR-RENDER-SERVICE.onrender.com/privacy-policy.html
curl -I https://YOUR-RENDER-SERVICE.onrender.com/terms.html
```

Then send a real SMS to the Twilio number and confirm the consent message is returned.
