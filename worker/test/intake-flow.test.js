import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { handleRequest, processIncomingSms, retryPendingAlerts } from "../src/index.mjs";

function env(options = {}) {
  const store = new Map();
  return {
    INTAKE_ORG_NAME: "PallviAgent",
    VALIDATE_TWILIO_SIGNATURE: "false",
    STAFF_NOTIFIER: options.staffNotifier,
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
  assert.match(await processIncomingSms(testEnv, phone, "START"), /Reply YES/);
  assert.equal(await processIncomingSms(testEnv, phone, "YES"), "What is your full name?");

  const answers = [
    "Maria Lopez",
    "+1 555 555 0123",
    "FAMILY",
    "Newark NJ",
    "2 detained now",
    "Spanish",
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
  assert.ok(saved.audit.some(({ type }) => type === "staff_alert_sent"));
  assert.equal("aNumber" in saved.answers, false);
});

test("STOP redacts intake data but preserves a minimal audit trail", async () => {
  const testEnv = env();
  const phone = "+15555550124";

  await processIncomingSms(testEnv, phone, "START");
  await processIncomingSms(testEnv, phone, "YES");
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
    "START", "YES", "Jordan Lee", "+15555550127", "SELF", "Boston MA",
    "4 general immigration help", "English", "Need help understanding a notice."
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
