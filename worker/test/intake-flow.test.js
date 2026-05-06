import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, processIncomingSms } from "../src/index.mjs";

function env() {
  const store = new Map();
  return {
    INTAKE_ORG_NAME: "PallviAgent",
    VALIDATE_TWILIO_SIGNATURE: "false",
    INTAKE_KV: {
      async get(key) {
        return store.get(key) || null;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      }
    }
  };
}

test("emergency flow classifies detention as P0", async () => {
  const testEnv = env();
  const phone = "+15555550123";

  assert.match(await processIncomingSms(testEnv, phone, "hello"), /Reply YES/);
  assert.equal(await processIncomingSms(testEnv, phone, "YES"), "What is your full name?");

  const answers = [
    "Maria Lopez",
    "+1 555 555 0123",
    "FAMILY",
    "Newark NJ",
    "2 detained now",
    "NONE",
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
});

test("STOP clears the active conversation", async () => {
  const testEnv = env();
  const phone = "+15555550124";

  await processIncomingSms(testEnv, phone, "hello");
  assert.ok(await testEnv.INTAKE_KV.get(`conversation:${phone}`));

  const reply = await processIncomingSms(testEnv, phone, "STOP");
  assert.match(reply, /opted out/);
  assert.equal(await testEnv.INTAKE_KV.get(`conversation:${phone}`), null);
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
