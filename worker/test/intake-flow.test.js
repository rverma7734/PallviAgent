import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  escalateUnacknowledgedAlerts,
  handleRequest,
  processIncomingSms,
  retryPendingAlerts
} from "../src/index.mjs";

const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

function smsSegmentCount(value) {
  let septets = 0;
  for (const character of String(value)) {
    if (GSM_BASIC.includes(character)) septets += 1;
    else if (GSM_EXTENDED.includes(character)) septets += 2;
    else {
      const units = [...String(value)].reduce((total, item) => total + (item.codePointAt(0) > 0xffff ? 2 : 1), 0);
      return units <= 70 ? 1 : Math.ceil(units / 67);
    }
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

function env(options = {}) {
  const store = new Map();
  return {
    INTAKE_ORG_NAME: "PallviAgent",
    AI: options.ai,
    AI_TRIAGE_ENABLED: options.aiTriageEnabled ? "true" : "false",
    AI_SUMMARY_ENABLED: options.aiSummaryEnabled ? "true" : "false",
    VALIDATE_TWILIO_SIGNATURE: "false",
    STAFF_NOTIFIER: options.staffNotifier,
    TWILIO_MESSAGE_SENDER: options.twilioMessageSender,
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
  const consentReply = await processIncomingSms(testEnv, phone, "START");
  assert.match(consentReply, /Reply YES/);
  assert.equal(smsSegmentCount(consentReply), 2);
  const languageReply = await processIncomingSms(testEnv, phone, "YES");
  assert.match(languageReply, /Choose your language/);
  assert.equal(smsSegmentCount(languageReply), 1);
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
  assert.deepEqual(notifications.map(({ kind }) => kind), ["urgent"]);
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

  await processIncomingSms(testEnv, phone, "María López");
  await processIncomingSms(testEnv, phone, "+1 555 555 0136");
  await processIncomingSms(testEnv, phone, "FAMILIAR");
  const urgencyReply = await processIncomingSms(testEnv, phone, "Newark NJ");
  assert.equal(smsSegmentCount(urgencyReply), 2);
  const detailsReply = await processIncomingSms(testEnv, phone, "2 detenido ahora");
  assert.equal(smsSegmentCount(detailsReply), 2);
  const reply = await processIncomingSms(testEnv, phone, "ICE detuvo a mi esposo esta noche.");

  assert.match(reply, /Equipo alertado/);
  assert.equal(smsSegmentCount(reply), 1);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.answers.language, "Spanish");
  assert.equal(saved.priority, "P0");
  assert.deepEqual(notifications.map(({ kind }) => kind), ["urgent"]);
  assert.ok(saved.audit.some(({ type, language }) => type === "language_selected" && language === "Spanish"));
});

test("AI triage can escalate ambiguous text without receiving identity fields", async () => {
  const notifications = [];
  let modelInput;
  const testEnv = env({
    aiTriageEnabled: true,
    ai: {
      async run(_model, input) {
        modelInput = input;
        return { response: "P0" };
      }
    },
    staffNotifier: async (intake, kind) => {
      notifications.push({ kind, priority: intake.priority });
      return { ok: true };
    }
  });
  const phone = "+15555550139";
  const messages = [
    "START", "YES", "2", "Nombre Privado", phone, "FAMILIAR", "Newark NJ"
  ];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);
  const reply = await processIncomingSms(testEnv, phone, "ICE detuvo a mi esposo esta noche");

  assert.match(reply, /equipo alertado/i);
  assert.equal(modelInput.messages[1].content, "ICE detuvo a mi esposo esta noche");
  assert.doesNotMatch(JSON.stringify(modelInput), /Nombre Privado|15555550139|Newark/);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.priority, "P0");
  assert.deepEqual(notifications, [{ kind: "urgent", priority: "P0" }]);
  assert.ok(saved.audit.some(({ type, from, to }) => type === "ai_triage_escalated" && from === "P2" && to === "P0"));
});

test("deterministic numbered urgency bypasses AI triage", async () => {
  let calls = 0;
  const testEnv = env({
    aiTriageEnabled: true,
    ai: { async run() { calls += 1; return { response: "P2" }; } },
    staffNotifier: async () => ({ ok: true })
  });
  const phone = "+15555550140";
  const messages = ["START", "YES", "1", "Test Person", phone, "SELF", "Boston MA", "2 detained now"];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);
  assert.equal(calls, 0);
});

test("AI triage failure falls back to deterministic routing", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  const testEnv = env({
    aiTriageEnabled: true,
    ai: { async run() { throw new Error("test failure"); } }
  });
  try {
    const phone = "+15555550141";
    const messages = ["START", "YES", "1", "Test Person", phone, "SELF", "Boston MA", "Need help with a notice"];
    for (const message of messages) await processIncomingSms(testEnv, phone, message);
    const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
    assert.equal(saved.priority, "P2");
    assert.ok(saved.audit.some(({ type }) => type === "ai_triage_failed"));
  } finally {
    console.error = originalConsoleError;
  }
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

test("sms endpoint reuses the saved reply for duplicate Twilio MessageSids", async () => {
  const testEnv = env();
  const phone = "+15555550137";
  const messageSid = `SM${"a".repeat(32)}`;
  const request = () => new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: phone, Body: "START", MessageSid: messageSid })
  });

  const first = await handleRequest(request(), testEnv);
  const duplicate = await handleRequest(request(), testEnv);
  assert.equal(await duplicate.text(), await first.text());

  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.equal(saved.status, "awaiting_consent");
  assert.equal(saved.audit.filter(({ type }) => type === "start_received").length, 1);
});

test("sms endpoint rejects MMS attachments without creating an intake", async () => {
  const testEnv = env();
  const phone = "+15555550138";
  const response = await handleRequest(new Request("https://example.com/sms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: phone,
      Body: "",
      MessageSid: `SM${"b".repeat(32)}`,
      NumMedia: "1",
      MediaUrl0: "https://example.com/document.jpg"
    })
  }), testEnv);

  assert.match(await response.text(), /cannot accept MMS attachments/);
  assert.equal(await testEnv.INTAKE_KV.get(`conversation:${phone}`), null);
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

test("staff hub page is served without exposing intake data", async () => {
  const response = await handleRequest(new Request("https://example.com/hub"), env());
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /PallviAgent Staff Hub/);
  assert.match(body, /Staff access/);
  assert.doesNotMatch(body, /Maria Lopez/);
});

test("staff hub API requires the configured access token", async () => {
  const testEnv = env();
  testEnv.HUB_ACCESS_TOKEN = "test-access-token";

  const missing = await handleRequest(new Request("https://example.com/api/intakes"), testEnv);
  assert.equal(missing.status, 401);

  const valid = await handleRequest(new Request("https://example.com/api/intakes", {
    headers: { Authorization: "Bearer test-access-token" }
  }), testEnv);
  assert.equal(valid.status, 200);
  const payload = await valid.json();
  assert.deepEqual(payload.intakes, []);
  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("staff hub lists and updates completed intakes", async () => {
  const testEnv = env({
    staffNotifier: async () => ({ ok: true })
  });
  testEnv.HUB_ACCESS_TOKEN = "test-access-token";
  const phone = "+15555550144";
  const messages = [
    "START", "YES", "1", "Maria Lopez", "+15555550144", "FAMILY", "Newark NJ",
    "2 detained now", "ICE detained my husband tonight after a traffic stop."
  ];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);

  const list = await handleRequest(new Request("https://example.com/api/intakes", {
    headers: { Authorization: "Bearer test-access-token" }
  }), testEnv);
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.intakes.length, 1);
  assert.equal(listed.intakes[0].name, "Maria Lopez");
  assert.equal(listed.intakes[0].priority, "P0");
  assert.equal(listed.intakes[0].callbackPhone, "+15555550144");

  const token = listed.intakes[0].token;
  const update = await handleRequest(new Request(`https://example.com/api/intakes/${token}`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ status: "in_progress", note: "Assigned to overnight staff." })
  }), testEnv);
  assert.equal(update.status, 200);
  const detail = await update.json();
  assert.equal(detail.status, "in_progress");
  assert.equal(detail.staffNotes[0].note, "Assigned to overnight staff.");
  assert.ok(detail.audit.some(({ type }) => type === "hub_status_updated"));
});

test("completed intakes send full staff email in parallel with SMS alert", async () => {
  const alerts = [];
  const emails = [];
  const testEnv = env({
    twilioMessageSender: async (message) => {
      alerts.push(message);
      return { ok: true };
    }
  });
  testEnv.TWILIO_ACCOUNT_SID = "ACtest";
  testEnv.TWILIO_AUTH_TOKEN = "test-token";
  testEnv.TWILIO_PHONE_NUMBER = "+15168714383";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  testEnv.RESEND_API_KEY = "test-resend-key";
  testEnv.STAFF_ALERT_EMAIL = "alerts@example.com";
  testEnv.STAFF_FROM_EMAIL = "intake@example.com";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    emails.push({ url, body: JSON.parse(options.body) });
    return Response.json({ id: "email-test-id" });
  };
  try {
    const phone = "+15555550145";
    const messages = [
      "START", "YES", "1", "Jordan Lee", "+15555550145", "SELF", "Boston MA",
      "4 general immigration help", "Needs help understanding a court notice."
    ];
    for (const message of messages) await processIncomingSms(testEnv, phone, message);

    assert.equal(alerts.length, 1);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].url, "https://api.resend.com/emails");
    assert.equal(emails[0].body.to[0], "alerts@example.com");
    assert.match(emails[0].body.subject, /\[P2 ROUTINE\] Jordan Lee - Boston MA/);
    assert.match(emails[0].body.text, /Name: Jordan Lee/);
    assert.match(emails[0].body.text, /Callback: \+15555550145/);
    assert.match(emails[0].body.text, /Details:\nNeeds help understanding a court notice/);
    const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
    assert.equal(saved.emailAlert.status, "sent");
    assert.equal(saved.emailAlert.lastMessageId, "email-test-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("privacy policy discloses limited automated triage", async () => {
  const response = await handleRequest(new Request("https://example.com/privacy-policy.html"), env());
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Automated Triage/);
  assert.match(body, /does not receive the sender's name, phone number, or callback number/);
  assert.match(body, /cannot lower a rule-based emergency classification/);
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
  const payload = `https://example.com/sms?source=twilio${[...form.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${value}`)
    .join("")}`;
  const signature = createHmac("sha1", testEnv.TWILIO_AUTH_TOKEN).update(payload).digest("base64");

  const valid = await handleRequest(new Request("https://internal.example.com/sms?source=twilio", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature
    },
    body: form
  }), testEnv);
  assert.equal(valid.status, 200);

  const invalid = await handleRequest(new Request("https://internal.example.com/sms?source=twilio", {
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

test("staff alerts are sent through the configured Twilio number", async () => {
  const alerts = [];
  const testEnv = env({
    twilioMessageSender: async (message) => {
      alerts.push(message);
      return { ok: true };
    }
  });
  testEnv.TWILIO_ACCOUNT_SID = "ACtest";
  testEnv.TWILIO_AUTH_TOKEN = "test-token";
  testEnv.TWILIO_PHONE_NUMBER = "+15168714383";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  const phone = "+15555550132";
  const messages = [
    "START", "YES", "1", "Test Person", "+15555550132", "FAMILY", "Newark NJ",
    "2 detained now", "ICE detained a family member tonight."
  ];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].from, "+15168714383");
  assert.equal(alerts[0].to, "+15555550999");
  assert.equal(alerts[0].body, [
    "URGENT PallviAgent P0 - EN",
    "Test Person - Newark NJ",
    "2 detained now",
    "Call (555) 555-0132"
  ].join("\n"));
  assert.equal(smsSegmentCount(alerts[0].body), 1);
});

test("AI formats a concise staff summary without receiving identity fields", async () => {
  const alerts = [];
  let modelInput;
  const testEnv = env({
    aiSummaryEnabled: true,
    ai: {
      async run(_model, input) {
        modelInput = input;
        return { response: "Client received notice and requests staff review." };
      }
    },
    twilioMessageSender: async (message) => {
      alerts.push(message);
      return { ok: true };
    }
  });
  testEnv.TWILIO_ACCOUNT_SID = "ACtest";
  testEnv.TWILIO_AUTH_TOKEN = "test-token";
  testEnv.TWILIO_PHONE_NUMBER = "+15168714383";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  const phone = "+16462048447";
  const messages = [
    "START", "YES", "1", "Private Name", phone, "SELF", "Queens NY",
    "4 general immigration help", "Received a court notice and needs help."
  ];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);

  assert.equal(alerts.length, 1);
  assert.doesNotMatch(JSON.stringify(modelInput), /Private Name|16462048447/);
  assert.match(modelInput.messages[1].content, /general immigration help/);
  assert.match(modelInput.messages[1].content, /court notice/);
  assert.equal(alerts[0].body, [
    "NEW PallviAgent P2 - EN",
    "Private Name - Queens NY",
    "Client received notice and requests staff review",
    "Call (646) 204-8447"
  ].join("\n"));
  assert.equal(smsSegmentCount(alerts[0].body), 1);
  const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
  assert.ok(saved.audit.some(({ type }) => type === "ai_summary_generated"));
});

test("AI summary failures use the deterministic intake text", async () => {
  const alerts = [];
  const originalConsoleError = console.error;
  console.error = () => {};
  const testEnv = env({
    aiSummaryEnabled: true,
    ai: { async run() { throw new Error("test failure"); } },
    twilioMessageSender: async (message) => {
      alerts.push(message);
      return { ok: true };
    }
  });
  testEnv.TWILIO_ACCOUNT_SID = "ACtest";
  testEnv.TWILIO_AUTH_TOKEN = "test-token";
  testEnv.TWILIO_PHONE_NUMBER = "+15168714383";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  const phone = "+15555550142";
  try {
    const messages = [
      "START", "YES", "1", "Private Name", phone, "SELF", "Boston MA",
      "4 general immigration help", "Needs help understanding a notice."
    ];
    for (const message of messages) await processIncomingSms(testEnv, phone, message);

    assert.equal(alerts.length, 1);
    assert.match(alerts[0].body, /Needs help understanding a notice/);
    assert.equal(smsSegmentCount(alerts[0].body), 1);
    const saved = JSON.parse(await testEnv.INTAKE_KV.get(`conversation:${phone}`));
    assert.ok(saved.audit.some(({ type }) => type === "ai_summary_failed"));
  } finally {
    console.error = originalConsoleError;
  }
});

test("identity and callback remain visible when the summary must shrink to one segment", async () => {
  const alerts = [];
  const testEnv = env({
    aiSummaryEnabled: true,
    ai: { async run() { return { response: "A deliberately long summary describing a routine intake request for staff review" }; } },
    twilioMessageSender: async (message) => {
      alerts.push(message);
      return { ok: true };
    }
  });
  testEnv.TWILIO_ACCOUNT_SID = "ACtest";
  testEnv.TWILIO_AUTH_TOKEN = "test-token";
  testEnv.TWILIO_PHONE_NUMBER = "+15168714383";
  testEnv.STAFF_ALERT_PHONE = "+15555550999";
  testEnv.STAFF_ACK_ENABLED = "true";
  const phone = "+15555550143";
  const messages = [
    "START", "YES", "1", "A".repeat(60), phone, "SELF", "L".repeat(60),
    "4 general immigration help", "Needs routine review of an immigration notice."
  ];
  for (const message of messages) await processIncomingSms(testEnv, phone, message);

  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, new RegExp(`${"A".repeat(28)} - ${"L".repeat(24)}`));
  assert.match(alerts[0].body, /Call \(555\) 555-0143/);
  assert.match(alerts[0].body, /ACK [A-Z0-9]{8}/);
  assert.equal(smsSegmentCount(alerts[0].body), 1);
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
