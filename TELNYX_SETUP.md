# Telnyx Parallel Setup

This runbook prepares PallviAgent for Telnyx without changing the active Twilio webhook. The same public opt-in, privacy, terms, campaign description, and sample-message strategy can be reused.

## Before Registration

1. Sign in to the Telnyx Mission Control Portal and complete Level 2 account verification.
2. Add billing information directly in Telnyx.
3. Use the exact legal name, EIN, and address from the IRS CP-575 letter when registering the brand.
4. If Telnyx reports that the EIN already exists through Twilio or another CSP, do not create a conflicting brand. Follow the secondary-CSP path shown by Telnyx or contact `10dlcquestions@telnyx.com`.

Telnyx currently passes through a $4.50 brand application fee and a $15 campaign review fee per submission or resubmission. Campaign monthly fees vary by use case and are initially billed for three months. Confirm the amount displayed in the portal before submitting.

Official references:

- https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges
- https://support.telnyx.com/en/articles/10646301-telnyx-10dlc-process
- https://developers.telnyx.com/docs/messaging/10dlc/troubleshooting

## Public URLs

```text
Current Twilio opt-in: https://rverma7734.github.io/PallviAgent/sms-opt-in.html
Privacy: https://rverma7734.github.io/PallviAgent/privacy-policy.html
Terms: https://rverma7734.github.io/PallviAgent/terms.html
```

Do not use the current Twilio opt-in URL in the Telnyx campaign if Telnyx assigns a different number. After purchasing the Telnyx number, publish a separate `telnyx-opt-in.html` page that is identical in disclosures but displays only the Telnyx number. Keep the Twilio page unchanged while its campaign is under review.

Generate that page after the Telnyx number is known:

```bash
node scripts/create-telnyx-opt-in.mjs +1XXXXXXXXXX
```

Review and publish the resulting `telnyx-opt-in.html` before entering its URL in the campaign.

## Campaign Fields

### Program name

```text
PallviAgent
```

### Description

```text
PallviAgent uses conversational SMS for inbound immigration intake and staff callback coordination. A user initiates the conversation, expressly consents before intake questions begin, provides basic non-documentary information, and receives status acknowledgments. Urgent answers alert on-call staff for human callback. Messages are not promotional or marketing. Automated messages do not provide legal advice and do not create an attorney-client relationship.
```

### Message flow / call to action

```text
End users opt in through the publicly accessible page at [TELNYX_OPT_IN_URL]. The page displays the PallviAgent program name, the SMS number [TELNYX_NUMBER], and instructions to text START. It discloses that messages concern immigration intake and emergency callback coordination, message frequency varies, message and data rates may apply, consent is not a condition of purchase, and users may reply STOP to opt out or HELP for help. It links directly to the Privacy Policy and SMS Terms. After the user texts START, PallviAgent identifies itself, states that automated SMS is not legal advice and does not create an attorney-client relationship, and asks the user to reply YES. The user must reply YES before any intake questions are sent. This public webpage-to-keyword flow is the only opt-in method used for this campaign.
```

Replace both bracketed values and verify the Telnyx opt-in page anonymously before final campaign submission.

### Sample messages

```text
PallviAgent: You have reached our immigration intake line. This line collects basic information for staff callback. It is not legal advice and does not create an attorney-client relationship. Reply YES to continue or STOP to opt out.
```

```text
PallviAgent: Thank you. The on-call team has been alerted. Please keep your phone available for a callback. If there is immediate physical danger, call 911. Reply STOP to opt out or HELP for help.
```

```text
PallviAgent: What city and state is the person in right now? Do not text documents, A-numbers, Social Security numbers, or passport numbers. Reply STOP to opt out or HELP for help.
```

### Campaign settings

```text
Opt-in: True
Opt-out: True
HELP: True
Embedded links in messages: False
Embedded phone numbers in messages: True
Age-gated content: False
Direct lending: False
Affiliate marketing: False
Number pooling: False
```

Use the use case for which the verified brand qualifies and which Telnyx confirms best matches low-volume, non-marketing conversational intake. Do not select `Emergency` solely because some intakes are urgent; that category can require special approval.

## Messaging Profile

After the campaign and a Telnyx number are ready:

1. Create a messaging profile.
2. Select API v2 webhooks.
3. Set the primary webhook URL to:

```text
https://pallviagent.rohitverma7734.workers.dev/telnyx/sms
```

4. Assign the Telnyx number to that profile and the approved campaign.
5. Copy the Telnyx public key from **Keys & Credentials**.

## Cloudflare Configuration

Set these values on the `pallviagent` Worker:

```text
VALIDATE_TELNYX_SIGNATURE=true
TELNYX_PHONE_NUMBER=+1...
```

Set these secrets/credentials without placing them in Git:

```text
TELNYX_API_KEY
TELNYX_PUBLIC_KEY
```

The Worker verifies Ed25519 signatures over the raw webhook body, rejects timestamps older than five minutes, deduplicates event IDs, and retries failed outbound replies without processing the same intake answer twice.

To send internal staff alerts through Telnyx after a real test succeeds, change:

```text
STAFF_ALERT_PROVIDER=telnyx
STAFF_ALERT_PHONE=+1...
```

Until that change, staff alerts continue using Twilio.
