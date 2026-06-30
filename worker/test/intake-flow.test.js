import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import test from "node:test";
import {
  escalateUnacknowledgedAlerts,
  handleRequest,
  processIncomingSms,
  retryPendingAlerts,
  retryPendingTelnyxJobs
} from "../src/index.mjs";

function env(options = {}) {
  const store = new Map();
  return {
    INTAKE_ORG_NAME: "PallviAgent",
    VALIDATE_TWILIO_SIGNATURE: "false",
    VALIDATE_TELNYX_SIGNATURE: "false",
    STAFF_NOTIFIER: options.staffNotifier,
    TELNYX_MESSAGE_SENDER: options.telnyxMessageSender,
    _store: store,
    INTAKE_KV: {
      async get(key) {
        return store.get(key) || null;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
      async list({ prefix = "" } = {}) {
        return {
          keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
          list_complete: true
        };
      }
    }
  };
}

function telnyxEvent({ id = "event-123", text = "START" } = {}) {
  return JSON.stringify({
    data: {
      event_type: "message.received",
      id,
      occurred_at: new Date().toISOString(),
      payload: {
        id: `message-${id}`,
        from: { phone_number: "+15555550131" },
        to: [{ phone_number: "+15168714383" }],
        text,
        type: "SMS",
        media: []
      },
      record_type: "event"
    }
  });
}

test("emergency flow classifies detention as P0", async () => {
  const notifications = [];
  const testEnv = env({
    staffNotifier: async (intake, kind) => {
      notifications.push({ kind, priority: intake.priority });
      return { ok: true };
    }
  });
  const phone = "+15555550123";

  assert.match(await processIncomingSms(testEnv, phone, "hello"), /reply START/i);
  assert.match(await processIncomingSms(testEnv, phone, "START"), /Reply YES/);
  assert.match(await processIncomingSms(testEnv, phone, "YES"), /Choose your language/);
  assert.equal(await processIncomingSms(testEnv, phone, "1"), "What is your full name?");

  const answers = [
    "Maria Lopez",
    "+1 555 555 0123",
    "FAMILY",
    "Newark NJ",
    "2 detained now",
    "ICE detained my husband tonight after a traffic stop."
  ];

  let reply = "";
  for (const answer of answers) {
    reply = await processIncomingSms(testEnv, phone, answer);
  }

  assert.match(reply, /on-call team/);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.priority, "P0");
  assert.equal(saved.status, "needs_staff_callback");
  assert.deepEqual(notifications.map(({ kind }) => kind), ["urgent", "complete"]);
  assert.ok(saved.audit.some(({ type }) => type === "consent_granted"));
  assert.ok(saved.audit.some(({ type, language }) => type === "language_selected" && language === "English"));
  assert.ok(saved.audit.some(({ type }) => type === "staff_alert_sent"));
  assert.equal("aNumber" in saved.answers, false);
});

test("Spanish selection localizes the intake and is recorded in the audit", async () => {
  const notifications = [];
  const testEnv = env({
    staffNotifier: async (intake, kind) => {
      notifications.push({ kind, language: intake.answers.language });
      return { ok: true };
    }
  });
  const phone = "+15555550136";

  await processIncomingSms(testEnv, phone, "START");
  assert.match(await processIncomingSms(testEnv, phone, "YES"), /Elija su idioma/);
  assert.match(await processIncomingSms(testEnv, phone, "not-a-language"), /Responda 2 para Español/);
  assert.equal(await processIncomingSms(testEnv, phone, "2"), "¿Cuál es su nombre completo?");

  const answers = [
    "María López",
    "+1 555 555 0136",
    "FAMILIAR",
    "Newark NJ",
    "2 detenido ahora",
    "ICE detuvo a mi esposo esta noche."
  ];
  let reply = "";
  for (const answer of answers) reply = await processIncomingSms(testEnv, phone, answer);

  assert.match(reply, /equipo de guardia/);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.answers.language, "Spanish");
  assert.equal(saved.priority, "P0");
  assert.deepEqual(notifications.map(({ kind }) => kind), ["urgent", "complete"]);
  assert.ok(saved.audit.some(({ type, language }) => type === "language_selected" && language === "Spanish"));
});

test("STOP redacts intake data but preserves a minimal audit trail", async () => {
  const testEnv = env();
  const phone = "+15555550124";

  await processIncomingSms(testEnv, phone, "START");
  await processIncomingSms(testEnv, phone, "YES");
  await processIncomingSms(testEnv, phone, "1");
  await processIncomingSms(testEnv, phone, "Sensitive Name");

  const reply = await processIncomingSms(testEnv, phone, "STOP");
  assert.match(reply, /opted out/);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.status, "opted_out");
  assert.deepEqual(saved.answers, {});
  assert.ok(saved.audit.some(({ type }) => type === "opted_out"));
  assert.doesNotMatch(JSON.stringify(saved), /Sensitive Name/);
});

test("consent must follow START and declined consent closes the intake", async () => {
  const testEnv = env();
  const phone = "+15555550126";

  assert.match(await processIncomingSms(testEnv, phone, "YES"), /reply START/i);
  await processIncomingSms(testEnv, phone, "START");
  assert.match(await processIncomingSms(testEnv, phone, "maybe"), /Reply YES/);
  assert.match(await processIncomingSms(testEnv, phone, "NO"), /cannot continue/);

  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.status, "closed_no_consent");
  assert.ok(saved.audit.some(({ type }) => type === "consent_declined"));
});

test("sms endpoint returns TwiML", async () => {
  const testEnv = env();
  const request = new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: "+15555550125", Body: "hello" })
  });

  const response = await handleRequest(request, testEnv);
  const body = await response.text();
  assert.equal(response.headers.get("Content-Type"), "application/xml; charset=utf-8");
  assert.match(body, /<Response><Message>/);
});

test("public SMS opt-in page includes required disclosures", async () => {
  const response = await handleRequest(new Request("https://example.com/sms-opt-in.html"), env());
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /\+1 \(516\) 871-4383/);
  assert.match(body, /Message and data rates may apply/);
  assert.match(body, /Reply <strong>STOP<\/strong>/);
  assert.match(body, /Reply <strong>HELP<\/strong>/);
  assert.match(body, /1 for English/);
  assert.match(body, /2 para Español/);
  assert.match(body, /privacy-policy\.html/);
  assert.match(body, /terms\.html/);
});

test("failed staff alerts are retried and do not claim confirmed delivery", async () => {
  let attempts = 0;
  const testEnv = env({
    staffNotifier: async () => {
      attempts += 1;
      return attempts >= 2 ? { ok: true } : { ok: false, code: "test_failure" };
    }
  });
  const phone = "+15555550127";
  const messages = [
    "START", "YES", "1", "Jordan Lee", "+15555550127", "SELF", "Boston MA",
    "4 general immigration help", "Need help understanding a notice."
  ];

  let reply;
  for (const message of messages) reply = await processIncomingSms(testEnv, phone, message);
  assert.match(reply, /delivery to on-call staff has not been confirmed/);

  const result = await retryPendingAlerts(testEnv);
  assert.equal(result.retried, 1);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.alert.status, "sent");
  assert.equal(saved.alert.pendingKind, null);
});

test("sms endpoint rejects oversized messages without storing them", async () => {
  const testEnv = env();
  const phone = "+15555550128";
  const request = new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: phone, Body: "x".repeat(801) })
  });

  const response = await handleRequest(request, testEnv);
  assert.match(await response.text(), /message is too long/);
  assert.equal(await testEnv.INTAKE_KV.get(`conversation:${phone}`), null);
});

test("sms endpoint validates Twilio signatures when enabled", async () => {
  const testEnv = env();
  testEnv.VALIDATE_TWILIO_SIGNATURE = "true";
  testEnv.TWILIO_AUTH_TOKEN = "test-auth-token";
  testEnv.PUBLIC_BASE_URL = "https://example.com";
  const form = new URLSearchParams({ From: "+15555550129", Body: "START" });
  const payload = `https://example.com/sms${[...form.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${value}`)
    .join("")}`;
  const signature = createHmac("sha1", testEnv.TWILIO_AUTH_TOKEN).update(payload).digest("base64");

  const valid = await handleRequest(new Request("https://example.com/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature
    },
    body: form
  }), testEnv);
  assert.equal(valid.status, 200);

  const invalid = await handleRequest(new Request("https://example.com/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": "invalid"
    },
    body: form
  }), testEnv);
  assert.equal(invalid.status, 403);
});

test("sms endpoint rate limits bursts but still permits STOP", async () => {
  const testEnv = env();
  const phone = "+15555550130";

  let response;
  for (let index = 0; index <= 30; index += 1) {
    response = await handleRequest(new Request("https://example.com/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: phone, Body: "HELP" })
    }), testEnv);
  }
  assert.match(await response.text(), /Too many messages/);

  const stop = await handleRequest(new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: phone, Body: "STOP" })
  }), testEnv);
  assert.match(await stop.text(), /opted out/);
});

test("Telnyx webhook acknowledges, replies, and deduplicates events", async () => {
  const sent = [];
  const pending = [];
  const testEnv = env({
    telnyxMessageSender: async (message) => {
      sent.push(message);
      return { ok: true };
    }
  });
  const body = telnyxEvent();
  const request = () => new Request("https://example.com/telnyx/sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  const response = await handleRequest(request(), testEnv, ctx);
  assert.equal(response.status, 200);
  await Promise.all(pending);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "+15168714383");
  assert.equal(sent[0].to, "+15555550131");
  assert.match(sent[0].text, /Reply YES/);

  const duplicate = await handleRequest(request(), testEnv, ctx);
  assert.deepEqual(await duplicate.json(), { received: true, duplicate: true });
  assert.equal(sent.length, 1);
});

test("Telnyx reply retries reuse the saved reply without advancing intake", async () => {
  const sent = [];
  let attempts = 0;
  const testEnv = env({
    telnyxMessageSender: async (message) => {
      attempts += 1;
      sent.push(message);
      return attempts === 1 ? { ok: false, code: "test_failure" } : { ok: true };
    }
  });
  const body = telnyxEvent({ id: "event-retry" });

  await handleRequest(new Request("https://example.com/telnyx/sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  }), testEnv);
  const before = JSON.parse(await testEnv.INTAKE_KV.get("conversation:+15555550131"));
  assert.equal(before.status, "awaiting_consent");

  const result = await retryPendingTelnyxJobs(testEnv);
  assert.equal(result.retried, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, sent[1].text);
  const after = JSON.parse(await testEnv.INTAKE_KV.get("conversation:+15555550131"));
  assert.equal(after.status, "awaiting_consent");
  assert.equal(after.audit.filter(({ type }) => type === "start_received").length, 1);
  assert.equal(await testEnv.INTAKE_KV.get("provider-job:telnyx:event-retry"), null);
});

test("Telnyx webhook verifies Ed25519 signatures and rejects stale timestamps", async () => {
  const keys = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  const testEnv = env({ telnyxMessageSender: async () => ({ ok: true }) });
  testEnv.VALIDATE_TELNYX_SIGNATURE = "true";
  testEnv.TELNYX_PUBLIC_KEY = publicKey;
  const body = telnyxEvent({ id: "event-signed" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(await webcrypto.subtle.sign(
    { name: "Ed25519" },
    keys.privateKey,
    new TextEncoder().encode(`${timestamp}|${body}`)
  )).toString("base64");

  const signedResponse = await handleRequest(new Request("https://example.com/telnyx/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp
    },
    body
  }), testEnv);
  assert.equal(signedResponse.status, 200);

  const staleTimestamp = String(Number(timestamp) - 301);
  const staleSignature = Buffer.from(await webcrypto.subtle.sign(
    { name: "Ed25519" },
    keys.privateKey,
    new TextEncoder().encode(`${staleTimestamp}|${body}`)
  )).toString("base64");
  const staleResponse = await handleRequest(new Request("https://example.com/telnyx/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "telnyx-signature-ed25519": staleSignature,
      "telnyx-timestamp": staleTimestamp
    },
    body
  }), testEnv);
  assert.equal(staleResponse.status, 403);
});

test("staff alerts can be sent through Telnyx", async () => {
  const alerts = [];
  const testEnv = env({
    telnyxMessageSender: async (message) => {
      alerts.push(message);
      return { ok: true };
    }
  });
  testEnv.STAFF_ALERT_PROVIDER = "telnyx";
  testEnv.TELNYX_PHONE_NUMBER = "+15168714383";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  const phone = "+15555550132";
  const messages = [
    "START", "YES", "1", "Test Person", "+15555550132", "FAMILY", "Newark NJ",
    "2 detained now", "ICE detained a family member tonight."
  ];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].to, "+15555550999");
  assert.match(alerts[0].text, /URGENT PallviAgent intake/);
  assert.match(alerts[1].text, /Intake complete/);
});

test("authorized staff can acknowledge an urgent case by SMS", async () => {
  const testEnv = env({ staffNotifier: async () => ({ ok: true }) });
  testEnv.STAFF_ACK_ENABLED = "true";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  const clientPhone = "+15555550133";
  const urgentMessages = [
    "START", "YES", "1", "Test Person", clientPhone, "FAMILY", "Newark NJ", "2 detained now"
  ];
  for (const message of urgentMessages) await processIncomingSms(testEnv, clientPhone, message);

  const before = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${clientPhone}`));
  const token = before.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  const response = await handleRequest(new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: testEnv.STAFF_ALERT_PHONE, Body: `ACK ${token}` })
  }), testEnv);
  assert.match(await response.text(), new RegExp(`case ${token} acknowledged`));

  const acknowledged = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${clientPhone}`));
  assert.equal(acknowledged.alert.status, "acknowledged");
  assert.equal(acknowledged.alert.acknowledgedBy, "primary");
  assert.ok(acknowledged.audit.some(({ type }) => type === "staff_alert_acknowledged"));

  await processIncomingSms(testEnv, clientPhone, "ICE detained a family member tonight.");
  const completed = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${clientPhone}`));
  assert.equal(completed.alert.status, "acknowledged");
});

test("unacknowledged urgent cases escalate once to the backup number", async () => {
  const notifications = [];
  const testEnv = env({
    staffNotifier: async (_intake, kind, targetPhone) => {
      notifications.push({ kind, targetPhone });
      return { ok: true };
    }
  });
  testEnv.STAFF_ACK_ENABLED = "true";
  testEnv.STAFF_ACK_TIMEOUT_MINUTES = "15";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  testEnv.STAFF_BACKUP_PHONE = "+15555550888";
  const clientPhone = "+15555550134";
  const urgentMessages = [
    "START", "YES", "1", "Test Person", clientPhone, "SELF", "Boston MA", "1 ICE is here now"
  ];
  for (const message of urgentMessages) await processIncomingSms(testEnv, clientPhone, message);

  const key = `conversation:${clientPhone}`;
  const intake = JSON.parse(await testEnv.INTAKE_KV.get(key));
  intake.alert.lastSuccessfulAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  await testEnv.INTAKE_KV.put(key, JSON.stringify(intake));

  const first = await escalateUnacknowledgedAlerts(testEnv);
  const second = await escalateUnacknowledgedAlerts(testEnv);
  assert.equal(first.escalated, 1);
  assert.equal(second.escalated, 0);
  assert.deepEqual(notifications.map(({ kind, targetPhone }) => ({ kind, targetPhone })), [
    { kind: "urgent", targetPhone: testEnv.STAFF_ALERT_PHONE },
    { kind: "escalation", targetPhone: testEnv.STAFF_BACKUP_PHONE }
  ]);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(key));
  assert.ok(saved.alert.escalationSentAt);
  assert.ok(saved.audit.some(({ type }) => type === "staff_alert_escalated"));
});

test("acknowledged urgent cases do not escalate", async () => {
  const notifications = [];
  const testEnv = env({
    staffNotifier: async (_intake, kind, targetPhone) => {
      notifications.push({ kind, targetPhone });
      return { ok: true };
    }
  });
  testEnv.STAFF_ACK_ENABLED = "true";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  testEnv.STAFF_BACKUP_PHONE = "+15555550888";
  const clientPhone = "+15555550135";
  const urgentMessages = [
    "START", "YES", "1", "Test Person", clientPhone, "SELF", "Boston MA", "2 detained now"
  ];
  for (const message of urgentMessages) await processIncomingSms(testEnv, clientPhone, message);
  const key = `conversation:${clientPhone}`;
  const intake = JSON.parse(await testEnv.INTAKE_KV.get(key));
  const token = intake.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  await handleRequest(new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: testEnv.STAFF_ALERT_PHONE, Body: `ACK ${token}` })
  }), testEnv);
  const acknowledged = JSON.parse(await testEnv.INTAKE_KV.get(key));
  acknowledged.alert.lastSuccessfulAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await testEnv.INTAKE_KV.put(key, JSON.stringify(acknowledged));

  const result = await escalateUnacknowledgedAlerts(testEnv);
  assert.equal(result.escalated, 0);
  assert.equal(notifications.filter(({ kind }) => kind === "escalation").length, 0);
});
