const STEPS = [
  {
    key: "consent",
    prompt: (env) =>
      `You have reached ${env.INTAKE_ORG_NAME || "our"} emergency immigration intake line. This line collects basic information for staff callback. It is not legal advice and does not create an attorney-client relationship. If someone is in immediate physical danger, call 911.\n\nReply YES to continue by text, or STOP to opt out.`
  },
  { key: "fullName", maxLength: 120, prompt: () => "What is your full name?" },
  { key: "callbackPhone", maxLength: 40, prompt: () => "What phone number should staff call back?" },
  { key: "personAtRisk", maxLength: 40, prompt: () => "Who needs help? Reply SELF, FAMILY, FRIEND, CLIENT, or OTHER." },
  { key: "location", maxLength: 120, prompt: () => "What city and state is the person in right now?" },
  { key: "urgency", maxLength: 240, prompt: () => "What is happening? Reply 1 ICE is here now, 2 detained now, 3 hearing/removal/deadline within 72 hours, 4 general immigration help." },
  { key: "language", maxLength: 80, prompt: () => "What language should staff use when calling?" },
  { key: "details", maxLength: 800, prompt: () => "Briefly describe what happened. Do not text documents, A-numbers, Social Security numbers, or passport numbers." }
];

const POLICY_VERSION = "2026-06-29";
const START_WORDS = new Set(["START"]);
const YES_WORDS = new Set(["YES", "Y"]);
const NO_WORDS = new Set(["NO", "N"]);
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const MAX_INBOUND_LENGTH = 800;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const RATE_LIMIT_MAX_MESSAGES = 30;

const P0_TERMS = [
  "ice is here", "at the door", "detained", "custody", "taken", "arrested", "separated",
  "medical emergency", "needs medicine", "child alone", "minor child"
];
const P1_TERMS = ["tomorrow", "72 hours", "hearing", "court", "deadline", "removal", "deportation", "within 3 days"];

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      retryPendingAlerts(env),
      retryPendingTelnyxJobs(env)
    ]));
  }
};

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/privacy-policy.html") {
    return html(PRIVACY_POLICY_HTML);
  }

  if (request.method === "GET" && url.pathname === "/terms.html") {
    return html(TERMS_HTML);
  }

  if (request.method === "GET" && url.pathname === "/sms-opt-in.html") {
    return html(SMS_OPT_IN_HTML);
  }

  if (request.method === "POST" && url.pathname === "/sms") {
    if (!(await isValidTwilioRequest(request, env))) {
      return new Response("invalid signature", { status: 403 });
    }

    const form = await request.formData();
    const from = normalizePhone(form.get("From"));
    const body = String(form.get("Body") || "").trim();

    if (!from || !body) {
      return twiml("");
    }

    if (body.length > MAX_INBOUND_LENGTH) {
      return twiml(`That message is too long. Please resend only the basic facts in ${MAX_INBOUND_LENGTH} characters or fewer. Do not send documents or identification numbers.`);
    }

    if (!STOP_WORDS.has(body.toUpperCase()) && await isRateLimited(env, from)) {
      return twiml("Too many messages were received in a short period. Please wait ten minutes and try again. If someone is in immediate physical danger, call 911.");
    }

    try {
      const reply = await processIncomingSms(env, from, body);
      return twiml(reply);
    } catch (error) {
      console.error("SMS intake processing failed", error instanceof Error ? error.message : "unknown error");
      return twiml("We could not process that message. Please try again shortly. If someone is in immediate physical danger, call 911.");
    }
  }

  if (request.method === "POST" && url.pathname === "/telnyx/sms") {
    return handleTelnyxWebhook(request, env, ctx);
  }

  return json({ error: "not found" }, 404);
}

async function handleTelnyxWebhook(request, env, ctx) {
  const rawBody = await request.text();
  if (rawBody.length > 64 * 1024) {
    return json({ error: "payload too large" }, 413);
  }
  if (!(await isValidTelnyxRequest(rawBody, request.headers, env))) {
    return json({ error: "invalid signature" }, 403);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }

  if (event?.data?.event_type !== "message.received") {
    return json({ received: true });
  }

  const payload = event.data.payload || {};
  const eventId = cleanIdentifier(event.data.id || payload.id);
  const from = normalizePhone(payload.from?.phone_number);
  const to = normalizePhone(payload.to?.[0]?.phone_number);
  const body = String(payload.text || "").trim();
  if (!eventId || !from || !to) {
    return json({ received: true });
  }

  const eventKey = telnyxEventKey(eventId);
  if (await env.INTAKE_KV.get(eventKey)) {
    return json({ received: true, duplicate: true });
  }

  const jobKey = telnyxJobKey(eventId);
  const job = {
    id: eventId,
    from,
    to,
    body,
    hasMedia: Array.isArray(payload.media) && payload.media.length > 0,
    attempts: 0,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await env.INTAKE_KV.put(eventKey, "received", { expirationTtl: 60 * 60 * 24 });
  await saveTelnyxJob(env, jobKey, job);

  const work = processTelnyxJob(env, jobKey).catch((error) => {
    console.error("Telnyx inbound processing failed", error instanceof Error ? error.message : "unknown error");
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(work);
  } else {
    await work;
  }
  return json({ received: true });
}

export async function processIncomingSms(env, from, body) {
  const normalized = body.trim().toUpperCase();
  const key = conversationKey(from);
  let intake = await loadIntake(env, key);
  if (intake) {
    intake.id = intake.id || crypto.randomUUID();
    intake.policyVersion = intake.policyVersion || POLICY_VERSION;
    intake.answers = intake.answers || {};
    intake.audit = Array.isArray(intake.audit) ? intake.audit : [];
  }

  if (STOP_WORDS.has(normalized)) {
    if (intake) {
      redactIntake(intake);
      intake.status = "opted_out";
      intake.updatedAt = nowIso();
      addAuditEvent(intake, "opted_out");
      await saveIntake(env, key, intake);
    }
    return "You have opted out and will not receive further texts from this intake line.";
  }

  if (HELP_WORDS.has(normalized)) {
    return "This line collects immigration intake information for staff callback. Reply STOP to opt out. If someone is in immediate physical danger, call 911.";
  }

  if (!intake || ["opted_out", "closed_no_consent", "needs_staff_callback"].includes(intake.status)) {
    if (!START_WORDS.has(normalized)) {
      if (intake?.status === "needs_staff_callback") {
        return "Your intake has already been saved for staff callback. Reply START to begin a new intake, HELP for help, or STOP to opt out.";
      }
      return "To begin the PallviAgent immigration intake, reply START. Reply HELP for help or STOP to opt out.";
    }
    intake = createIntake(from);
    await saveIntake(env, key, intake);
    return STEPS[0].prompt(env);
  }

  const step = nextStep(intake);
  if (step?.key === "consent") {
    if (START_WORDS.has(normalized)) {
      addAuditEvent(intake, "consent_prompted");
      intake.updatedAt = nowIso();
      await saveIntake(env, key, intake);
      return STEPS[0].prompt(env);
    }
    if (NO_WORDS.has(normalized)) {
      intake.status = "closed_no_consent";
      intake.updatedAt = nowIso();
      addAuditEvent(intake, "consent_declined");
      await saveIntake(env, key, intake);
      return "We cannot continue by text without consent. Please call the office directly if you need help.";
    }
    if (!YES_WORDS.has(normalized)) {
      return "Reply YES to consent and continue, or STOP to opt out. Automated SMS is not legal advice and does not create an attorney-client relationship.";
    }
    intake.answers.consent = "yes";
    intake.status = "open";
    addAuditEvent(intake, "consent_granted");
  } else if (step) {
    if (START_WORDS.has(normalized)) {
      return `Your intake is already active. ${step.prompt(env)}`;
    }
    const answer = cleanAnswer(body, step.maxLength || MAX_INBOUND_LENGTH);
    if (!answer) return step.prompt(env);
    intake.answers[step.key] = answer;
  }

  intake.updatedAt = nowIso();
  let urgentAlertSent = false;
  if (step?.key === "urgency") {
    intake.priority = classifyPriority(intake);
    if (["P0", "P1"].includes(intake.priority) && !intake.alert?.lastSuccessfulAt) {
      urgentAlertSent = await attemptStaffAlert(env, intake, "urgent");
    }
  }

  const followingStep = nextStep(intake);
  if (followingStep) {
    await saveIntake(env, key, intake);
    const prefix = urgentAlertSent ? "This appears urgent, and the on-call team has been alerted. Please continue. " : "";
    return `${prefix}${followingStep.prompt(env)}`;
  }

  intake.priority = classifyPriority(intake);
  intake.status = "needs_staff_callback";
  addAuditEvent(intake, "intake_completed", { priority: intake.priority });
  const finalAlertSent = await attemptStaffAlert(env, intake, "complete");
  await saveIntake(env, key, intake);

  if (finalAlertSent || intake.alert?.lastSuccessfulAt) {
    return "Thank you. The on-call team has been alerted. Please keep your phone available for a callback. If there is immediate physical danger, call 911.";
  }
  return "Thank you. Your intake was saved, but delivery to on-call staff has not been confirmed. Please try this line again shortly. If someone is in immediate physical danger, call 911.";
}

function createIntake(phone) {
  const now = nowIso();
  const intake = {
    id: crypto.randomUUID(),
    phone,
    policyVersion: POLICY_VERSION,
    status: "awaiting_consent",
    answers: {},
    audit: [],
    createdAt: now,
    updatedAt: now
  };
  addAuditEvent(intake, "start_received");
  addAuditEvent(intake, "consent_prompted");
  return intake;
}

function nextStep(intake) {
  return STEPS.find((step) => !(step.key in intake.answers));
}

function classifyPriority(intake) {
  const urgency = String(intake.answers.urgency || "").toLowerCase();
  const details = String(intake.answers.details || "").toLowerCase();
  const combined = `${urgency} ${details}`;

  if (urgency.startsWith("1") || urgency.startsWith("2")) return "P0";
  if (P0_TERMS.some((term) => combined.includes(term))) return "P0";
  if (urgency.startsWith("3") || P1_TERMS.some((term) => combined.includes(term))) return "P1";
  return "P2";
}

async function notifyStaff(env, intake, kind) {
  if (typeof env.STAFF_NOTIFIER === "function") {
    return env.STAFF_NOTIFIER(intake, kind);
  }
  const body = [
    `${kind === "urgent" ? "URGENT" : "New"} PallviAgent intake ${intake.id.slice(0, 8)} - ${intake.priority}`,
    `Location: ${intake.answers.location || "N/A"}`,
    `Language: ${intake.answers.language || "N/A"}`,
    `Callback: ${intake.answers.callbackPhone || intake.phone}`,
    kind === "urgent" ? "Initial alert; intake may still be in progress." : "Intake complete; call the listed callback number."
  ].join("\n");

  const provider = String(env.STAFF_ALERT_PROVIDER || "twilio").toLowerCase();
  if (provider === "telnyx") {
    if (!env.STAFF_ALERT_PHONE || !env.TELNYX_PHONE_NUMBER) {
      console.error("Telnyx staff alert unavailable: missing notification configuration");
      return { ok: false, code: "configuration_missing" };
    }
    return sendTelnyxMessage(env, {
      from: env.TELNYX_PHONE_NUMBER,
      to: env.STAFF_ALERT_PHONE,
      text: body
    });
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER || !env.STAFF_ALERT_PHONE) {
    console.error("Twilio staff alert unavailable: missing notification configuration");
    return { ok: false, code: "configuration_missing" };
  }

  const credentials = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const params = new URLSearchParams({
    From: env.TWILIO_PHONE_NUMBER,
    To: env.STAFF_ALERT_PHONE,
    Body: body
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  if (!response.ok) {
    console.error("Staff alert failed", response.status);
    return { ok: false, code: `twilio_${response.status}` };
  }
  return { ok: true };
}

async function sendTelnyxMessage(env, message) {
  if (typeof env.TELNYX_MESSAGE_SENDER === "function") {
    return env.TELNYX_MESSAGE_SENDER(message);
  }
  if (!env.TELNYX_API_KEY) {
    return { ok: false, code: "configuration_missing" };
  }

  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });
  if (!response.ok) {
    console.error("Telnyx message failed", response.status);
    return { ok: false, code: `telnyx_${response.status}` };
  }
  return { ok: true };
}

async function attemptStaffAlert(env, intake, kind) {
  intake.alert = intake.alert || { attempts: 0 };
  intake.alert.attempts += 1;
  intake.alert.lastAttemptAt = nowIso();
  intake.alert.pendingKind = kind;

  let result;
  try {
    result = await notifyStaff(env, intake, kind);
  } catch (error) {
    console.error("Staff alert request failed", error instanceof Error ? error.message : "unknown error");
    result = { ok: false, code: "request_failed" };
  }

  if (result.ok) {
    intake.alert.status = "sent";
    intake.alert.lastSuccessfulAt = nowIso();
    intake.alert.pendingKind = null;
    intake.alert.lastErrorCode = null;
    addAuditEvent(intake, "staff_alert_sent", { kind });
    return true;
  }

  intake.alert.status = "pending_retry";
  intake.alert.lastErrorCode = result.code || "unknown";
  addAuditEvent(intake, "staff_alert_failed", { kind, code: intake.alert.lastErrorCode });
  return false;
}

export async function retryPendingAlerts(env) {
  if (!env.INTAKE_KV?.list) return { checked: 0, retried: 0 };
  let cursor;
  let checked = 0;
  let retried = 0;

  do {
    const page = await env.INTAKE_KV.list({ prefix: "conversation:", cursor, limit: 100 });
    for (const item of page.keys || []) {
      checked += 1;
      const intake = await loadIntake(env, item.name);
      if (!intake?.alert?.pendingKind || intake.alert.attempts >= 3) continue;
      await attemptStaffAlert(env, intake, intake.alert.pendingKind);
      intake.updatedAt = nowIso();
      await saveIntake(env, item.name, intake);
      retried += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { checked, retried };
}

async function processTelnyxJob(env, jobKey) {
  const job = await loadJson(env, jobKey);
  if (!job || job.attempts >= 3) return false;

  if (!job.reply) {
    if (job.hasMedia && !job.body) {
      job.reply = "PallviAgent cannot accept MMS attachments. Please resend only basic facts by text. Do not send documents or identification numbers.";
    } else if (!job.body) {
      job.reply = "Reply START to begin the PallviAgent immigration intake, HELP for help, or STOP to opt out.";
    } else if (job.body.length > MAX_INBOUND_LENGTH) {
      job.reply = `That message is too long. Please resend only the basic facts in ${MAX_INBOUND_LENGTH} characters or fewer. Do not send documents or identification numbers.`;
    } else if (!STOP_WORDS.has(job.body.toUpperCase()) && await isRateLimited(env, job.from)) {
      job.reply = "Too many messages were received in a short period. Please wait ten minutes and try again. If someone is in immediate physical danger, call 911.";
    } else {
      job.reply = await processIncomingSms(env, job.from, job.body);
    }
    job.updatedAt = nowIso();
    await saveTelnyxJob(env, jobKey, job);
  }

  let result;
  try {
    result = await sendTelnyxMessage(env, {
      from: job.to,
      to: job.from,
      text: job.reply
    });
  } catch (error) {
    console.error("Telnyx reply request failed", error instanceof Error ? error.message : "unknown error");
    result = { ok: false, code: "request_failed" };
  }
  if (result.ok) {
    await env.INTAKE_KV.delete(jobKey);
    return true;
  }

  job.attempts += 1;
  job.lastErrorCode = result.code || "unknown";
  job.updatedAt = nowIso();
  await saveTelnyxJob(env, jobKey, job);
  return false;
}

export async function retryPendingTelnyxJobs(env) {
  if (!env.INTAKE_KV?.list) return { checked: 0, retried: 0 };
  const page = await env.INTAKE_KV.list({ prefix: "provider-job:telnyx:", limit: 100 });
  let retried = 0;
  for (const item of page.keys || []) {
    const job = await loadJson(env, item.name);
    if (!job || job.attempts >= 3) continue;
    await processTelnyxJob(env, item.name);
    retried += 1;
  }
  return { checked: (page.keys || []).length, retried };
}

async function isValidTelnyxRequest(rawBody, headers, env) {
  if (String(env.VALIDATE_TELNYX_SIGNATURE || "").toLowerCase() !== "true") {
    return true;
  }
  if (!env.TELNYX_PUBLIC_KEY) {
    console.error("Telnyx signature validation enabled but TELNYX_PUBLIC_KEY is missing");
    return false;
  }

  const signature = headers.get("telnyx-signature-ed25519") || "";
  const timestamp = headers.get("telnyx-timestamp") || "";
  const timestampNumber = Number(timestamp);
  if (!signature || !Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 5 * 60) return false;

  try {
    const { format, bytes } = parseTelnyxPublicKey(env.TELNYX_PUBLIC_KEY);
    const key = await crypto.subtle.importKey(format, bytes, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      base64ToBytes(signature),
      new TextEncoder().encode(`${timestamp}|${rawBody}`)
    );
  } catch (error) {
    console.error("Telnyx signature verification failed", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

function parseTelnyxPublicKey(value) {
  const key = String(value || "").trim();
  if (key.includes("BEGIN PUBLIC KEY")) {
    const encoded = key.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    return { format: "spki", bytes: base64ToBytes(encoded) };
  }
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return { format: "raw", bytes: Uint8Array.from(key.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)) };
  }
  const bytes = base64ToBytes(key);
  return { format: bytes.length === 32 ? "raw" : "spki", bytes };
}

async function isValidTwilioRequest(request, env) {
  if (String(env.VALIDATE_TWILIO_SIGNATURE || "").toLowerCase() !== "true") {
    return true;
  }
  if (!env.TWILIO_AUTH_TOKEN) {
    console.log("Twilio signature validation enabled but TWILIO_AUTH_TOKEN is missing");
    return false;
  }

  const signature = request.headers.get("X-Twilio-Signature") || "";
  if (!signature) return false;

  const requestClone = request.clone();
  const form = await requestClone.formData();
  const url = env.PUBLIC_BASE_URL
    ? `${String(env.PUBLIC_BASE_URL).replace(/\/$/, "")}${new URL(request.url).pathname}`
    : request.url;
  const sorted = [...form.entries()].sort(([a], [b]) => a.localeCompare(b));
  const signedPayload = `${url}${sorted.map(([key, value]) => `${key}${value}`).join("")}`;
  const digest = await hmacSha1(env.TWILIO_AUTH_TOKEN, signedPayload);
  return timingSafeEqual(signature, digest);
}

async function hmacSha1(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return arrayBufferToBase64(signature);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function loadIntake(env, key) {
  return loadJson(env, key);
}

async function loadJson(env, key) {
  const raw = await env.INTAKE_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.error("Invalid intake record encountered");
    return null;
  }
}

async function saveTelnyxJob(env, key, job) {
  await env.INTAKE_KV.put(key, JSON.stringify(job), { expirationTtl: 60 * 60 * 24 });
}

async function saveIntake(env, key, intake) {
  const auditOnly = ["opted_out", "closed_no_consent"].includes(intake.status);
  const days = auditOnly
    ? 90
    : intake.status === "needs_staff_callback"
      ? clampNumber(env.DATA_RETENTION_DAYS, 1, 90, 30)
      : 7;
  await env.INTAKE_KV.put(key, JSON.stringify(intake), { expirationTtl: 60 * 60 * 24 * days });
}

function conversationKey(phone) {
  return `conversation:${phone}`;
}

function telnyxEventKey(id) {
  return `provider-event:telnyx:${id}`;
}

function telnyxJobKey(id) {
  return `provider-job:telnyx:${id}`;
}

function cleanIdentifier(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
}

function normalizePhone(value) {
  const phone = String(value || "").replace(/[^\d+]/g, "");
  return /^\+\d{8,15}$/.test(phone) ? phone : "";
}

function cleanAnswer(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function redactIntake(intake) {
  intake.answers = {};
  delete intake.priority;
  delete intake.summary;
  delete intake.alert;
  delete intake.transcript;
}

function addAuditEvent(intake, type, metadata = {}) {
  intake.audit = Array.isArray(intake.audit) ? intake.audit : [];
  intake.audit.push({ at: nowIso(), type, policyVersion: intake.policyVersion || POLICY_VERSION, ...metadata });
  intake.audit = intake.audit.slice(-50);
}

async function isRateLimited(env, phone) {
  if (!env.INTAKE_KV) return false;
  const window = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `rate:${phone}:${window}`;
  const count = Number(await env.INTAKE_KV.get(key)) || 0;
  if (count >= RATE_LIMIT_MAX_MESSAGES) return true;
  await env.INTAKE_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return false;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function twiml(message) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" }
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function html(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PallviAgent Privacy Policy</title></head>
<body>
<main style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;max-width:760px;margin:32px auto;padding:0 20px;color:#1f2933">
<h1>Privacy Policy</h1>
<p>Last updated: June 29, 2026</p>
<p>PallviAgent respects your privacy. This Privacy Policy explains how information is collected, used, and protected when you contact the emergency immigration intake line by SMS or related intake channels.</p>
<h2>Information Collected</h2>
<p>The intake line may collect information you choose to provide, including your name, phone number, callback phone number, preferred language, location, basic immigration emergency details, consent status, and message timestamps. The automated intake does not ask for A-numbers, Social Security numbers, passport numbers, or documents.</p>
<h2>SMS Information</h2>
<p>If you contact the intake line by SMS, the system may collect your phone number, message contents, timestamps, language preference, and basic intake information you provide. This information is used to respond to your request, route it to appropriate staff, maintain records, and support operational obligations.</p>
<p>Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties. Personal information collected through SMS is not sold or rented.</p>
<h2>SMS Consent</h2>
<p>Users opt in by reviewing the public <a href="sms-opt-in.html">SMS opt-in page</a>, texting START to +1 (516) 871-4383, and replying YES to the consent prompt. Messages relate only to the user's intake, callback, appointment, or service request. Message and data rates may apply. Message frequency varies. Reply <strong>STOP</strong> to opt out or <strong>HELP</strong> for help.</p>
<h2>Security and Retention</h2>
<p>Do not send documents, A-numbers, Social Security numbers, passport numbers, or other highly sensitive identifiers by SMS. Incomplete intake records expire after seven days, completed intake records after up to 30 days, and minimal consent or opt-out audit records after up to 90 days. Replying STOP removes intake answers from the active SMS record.</p>
<h2>Contact</h2>
<p>For SMS assistance, reply HELP to +1 (516) 871-4383.</p>
</main>
</body>
</html>`;

const TERMS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PallviAgent SMS Terms and Conditions</title></head>
<body>
<main style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;max-width:760px;margin:32px auto;padding:0 20px;color:#1f2933">
<h1>SMS Terms and Conditions</h1>
<p>Last updated: June 29, 2026</p>
<p>PallviAgent uses SMS for immigration intake coordination, emergency callback routing, appointment coordination, and related client-service communications.</p>
<h2>Program Description</h2>
<p>Users opt in by reviewing the public <a href="sms-opt-in.html">SMS opt-in page</a>, texting <strong>START</strong> to +1 (516) 871-4383, and replying <strong>YES</strong> to the consent prompt. The system may then send messages related to the user's immigration intake or emergency callback request.</p>
<h2>No Legal Advice By SMS</h2>
<p>Automated SMS messages do not provide legal advice and do not create an attorney-client relationship. Staff review is required before any legal advice or representation decision is made.</p>
<h2>Message Frequency</h2>
<p>Message frequency varies. Message and data rates may apply. Reply <strong>STOP</strong> to opt out. Reply <strong>HELP</strong> for help or text HELP to +1 (516) 871-4383.</p>
<h2>Emergency Notice</h2>
<p>SMS is not monitored continuously and should not be used for immediate physical danger. If someone is in immediate physical danger, call 911.</p>
<h2>Privacy</h2>
<p>Review the <a href="privacy-policy.html">Privacy Policy</a>.</p>
</main>
</body>
</html>`;

const SMS_OPT_IN_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PallviAgent SMS Emergency Intake Opt-In</title></head>
<body>
<main style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;max-width:760px;margin:32px auto;padding:0 20px;color:#17202a">
<p style="color:#9f2d20;font-weight:700;text-transform:uppercase">PallviAgent</p>
<h1>Emergency immigration intake by SMS</h1>
<p>Use this line to provide basic information for a staff callback. Automated messages do not provide legal advice or create an attorney-client relationship.</p>
<h2>How to opt in</h2>
<ol><li>Review the disclosures on this page.</li><li>Text <strong>START</strong> to <strong>+1 (516) 871-4383</strong>.</li><li>Reply <strong>YES</strong> to the PallviAgent consent prompt before intake questions begin.</li></ol>
<h2>SMS disclosures</h2>
<p>By texting START and then replying YES, you agree to receive conversational SMS messages from PallviAgent about your immigration intake or emergency callback request.</p>
<ul><li>Message frequency varies during an active intake.</li><li>Message and data rates may apply.</li><li>Reply <strong>STOP</strong> to opt out.</li><li>Reply <strong>HELP</strong> for help.</li><li>Consent is not a condition of purchasing goods or services.</li></ul>
<h2>Important safety notice</h2>
<p>This line is not monitored continuously. If someone is in immediate physical danger, call 911. Do not send documents, A-numbers, Social Security numbers, passport numbers, or other highly sensitive identifiers by SMS.</p>
<p><a href="privacy-policy.html">Privacy Policy</a> | <a href="terms.html">SMS Terms and Conditions</a></p>
</main>
</body>
</html>`;
