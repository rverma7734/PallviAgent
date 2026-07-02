# PallviAgent On-Call Operations

## Launch Gate

Do not advertise the line as monitored overnight until all of these are true:

- The Twilio campaign is approved and the production number is in its Messaging Service Sender Pool.
- The Twilio incoming-message webhook points to the production Worker and signed webhooks are accepted.
- The primary staff phone receives both an urgent and a completed-intake alert.
- The primary staff phone can acknowledge a test case.
- The backup staff phone receives an overdue escalation.
- Staff has reviewed the callback script and understands that automated SMS is not legal advice.

## Configuration

Set these Cloudflare Worker values:

```text
STAFF_ALERT_PHONE=+1XXXXXXXXXX
STAFF_BACKUP_PHONE=+1XXXXXXXXXX
STAFF_ACK_TIMEOUT_MINUTES=15
STAFF_ACK_ENABLED=true
```

The primary and backup numbers must be different and use E.164 format. Keep acknowledgment disabled if no backup number is available.

## Acknowledgment Flow

Urgent P0/P1 staff alerts contain a case code:

```text
URGENT PallviAgent intake - P0
Case: 8F2C1A7B
Location: Newark NJ
Language: Spanish
Callback: +15555550123
Initial alert; intake may still be in progress.
Reply ACK 8F2C1A7B
```

The primary or backup staff member replies from the configured staff phone:

```text
ACK 8F2C1A7B
```

The system confirms the acknowledgment and returns the callback number. ACK commands from any other phone number are not authorized and cannot acknowledge a case.

## Escalation

Every five minutes, the Worker checks P0/P1 records with a successfully delivered staff alert. If no authorized acknowledgment exists after `STAFF_ACK_TIMEOUT_MINUTES`, it sends one escalation to `STAFF_BACKUP_PHONE`. A failed escalation is retried up to three times. Acknowledged, P2, duplicate, and already-escalated cases are skipped.

## Pre-Launch Test

1. Use fake names, locations, and callback numbers.
2. Send `START`, then `YES`, and complete an intake with urgency `2 detained now`.
3. Confirm the primary staff alert contains the expected case code and minimized details.
4. Reply `ACK <case-code>` from the primary staff phone and verify the confirmation.
5. Repeat with a new fake case, do not acknowledge, and verify backup escalation after the configured timeout.
6. Send `STOP` from the fake client and confirm intake answers are redacted.
7. Restore the intended timeout after testing.

## Failure Handling

- If the client receives a message that on-call delivery was not confirmed, investigate provider credentials and Worker logs immediately.
- If staff alerts fail, the Worker retries up to three times and does not tell the client that delivery succeeded.
- If acknowledgment is unavailable, disable claims of continuous monitoring and maintain a documented manual fallback number.
- Never request documents, A-numbers, Social Security numbers, or passport numbers over SMS.
