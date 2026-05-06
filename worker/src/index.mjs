const STEPS = [
  {
    key: "consent",
    prompt: (env) =>
      `You have reached ${env.INTAKE_ORG_NAME || "our"} emergency immigration intake line. This line collects basic information for staff callback. It is not legal advice and does not create an attorney-client relationship. If someone is in immediate physical danger, call 911.\n\nReply YES to continue by text, or STOP to opt out.`
  },
  { key: "fullName", prompt: () => "What is your full name?" },
  { key: "callbackPhone", prompt: () => "What phone number should staff call back?" },
  { key: "personAtRisk", prompt: () => "Who needs help? Reply SELF, FAMILY, FRIEND, CLIENT, or OTHER." },
  { key: "location", prompt: () => "What city and state is the person in right now?" },
  { key: "urgency", prompt: () => "What is happening? Reply 1 ICE is here now, 2 detained now, 3 hearing/deadline within 72 hours, 4 general immigration help." },
  { key: "aNumber", prompt: () => "If you have an A-number, send it now. If not, reply NONE." },
  { key: "language", prompt: () => "What language should staff use when calling?" },
  { key: "details", prompt: () => "Briefly describe what happened. Do not send documents by text unless staff asks." }
];

const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

const P0_TERMS = ["ice is here", "at the door", "detained", "custody", "taken", "arrested", "separated"];
const P1_TERMS = ["tomorrow", "72 hours", "hearing", "court", "deadline", "removal", "deportation"];

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

export async function handleRequest(request, env) {
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

    const reply = await processIncomingSms(env, from, body);
    return twiml(reply);
  }

  return json({ error: "not found" }, 404);
}

export async function processIncomingSms(env, from, body) {
  const normalized = body.trim().toUpperCase();
  const key = conversationKey(from);

  if (STOP_WORDS.has(normalized)) {
    await env.INTAKE_KV.delete(key);
    return "You have opted out and will not receive further texts from this intake line.";
  }

  if (HELP_WORDS.has(normalized)) {
    return "This line collects immigration intake information for staff callback. Reply STOP to opt out. If someone is in immediate physical danger, call 911.";
  }

  let intake = await loadIntake(env, key);
  if (!intake || intake.status !== "open") {
    intake = {
      phone: from,
      status: "open",
      answers: {},
      transcript: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveIntake(env, key, intake);
    return STEPS[0].prompt(env);
  }

  intake.transcript.push({ at: new Date().toISOString(), direction: "inbound", text: body });

  const step = nextStep(intake);
  if (step?.key === "consent") {
    if (!["YES", "Y", "START"].includes(normalized)) {
      intake.status = "closed_no_consent";
      intake.updatedAt = new Date().toISOString();
      await saveIntake(env, key, intake);
      return "We cannot continue by text without consent. Please call the office directly if you need help.";
    }
    intake.answers.consent = "yes";
  } else if (step) {
    intake.answers[step.key] = body;
  }

  intake.updatedAt = new Date().toISOString();
  const followingStep = nextStep(intake);
  if (followingStep) {
    await saveIntake(env, key, intake);
    return followingStep.prompt(env);
  }

  intake.priority = classifyPriority(intake);
  intake.summary = summarize(intake);
  intake.status = "needs_staff_callback";
  await saveIntake(env, key, intake);
  await notifyStaff(env, intake);

  return "Thank you. We sent this intake to the on-call team. Please keep your phone available for a callback. If there is immediate physical danger, call 911.";
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

function summarize(intake) {
  const a = intake.answers;
  return [
    `Priority: ${intake.priority}`,
    `Name: ${a.fullName || "N/A"}`,
    `Callback: ${a.callbackPhone || intake.phone}`,
    `Person at risk: ${a.personAtRisk || "N/A"}`,
    `Location: ${a.location || "N/A"}`,
    `Urgency: ${a.urgency || "N/A"}`,
    `A-number: ${a.aNumber || "N/A"}`,
    `Language: ${a.language || "N/A"}`,
    `Details: ${a.details || "N/A"}`
  ].join("\n");
}

async function notifyStaff(env, intake) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER || !env.STAFF_ALERT_PHONE) {
    console.log("Staff alert skipped: missing Twilio/staff alert configuration", intake.summary);
    return;
  }

  const body = [
    `New immigration emergency intake - ${intake.priority}`,
    `Location: ${intake.answers.location || "N/A"}`,
    `Language: ${intake.answers.language || "N/A"}`,
    `Callback: ${intake.answers.callbackPhone || intake.phone}`
  ].join("\n");

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
    console.log("Staff alert failed", response.status, await response.text());
  }
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
  const raw = await env.INTAKE_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function saveIntake(env, key, intake) {
  await env.INTAKE_KV.put(key, JSON.stringify(intake), { expirationTtl: 60 * 60 * 24 * 90 });
}

function conversationKey(phone) {
  return `conversation:${phone}`;
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
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
<p>Last updated: May 6, 2026</p>
<p>PallviAgent respects your privacy. This Privacy Policy explains how information is collected, used, and protected when you contact the emergency immigration intake line by SMS or related intake channels.</p>
<h2>Information Collected</h2>
<p>The intake line may collect information you choose to provide, including your name, phone number, callback phone number, preferred language, location, A-number if provided, basic immigration emergency details, message contents, and message timestamps.</p>
<h2>SMS Information</h2>
<p>If you contact the intake line by SMS, the system may collect your phone number, message contents, timestamps, language preference, and basic intake information you provide. This information is used to respond to your request, route it to appropriate staff, maintain records, and support operational obligations.</p>
<p>SMS opt-in data and consent are not sold, rented, or shared with third parties for their marketing purposes. Personal information collected through SMS is not sold.</p>
<h2>SMS Consent</h2>
<p>By texting the intake number or submitting a form that includes SMS disclosure language, you agree to receive SMS messages related to your intake, callback, appointment, or service request. Message and data rates may apply. Message frequency varies. You may reply STOP to opt out or HELP for help.</p>
<h2>Contact</h2>
<p>For questions about this Privacy Policy, contact the organization operating this intake line.</p>
</main>
</body>
</html>`;

const TERMS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PallviAgent SMS Terms and Conditions</title></head>
<body>
<main style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;max-width:760px;margin:32px auto;padding:0 20px;color:#1f2933">
<h1>SMS Terms and Conditions</h1>
<p>Last updated: May 6, 2026</p>
<p>PallviAgent uses SMS for immigration intake coordination, emergency callback routing, appointment coordination, and related client-service communications.</p>
<h2>Program Description</h2>
<p>When you text the intake number or opt in through a form, the system may send SMS messages related to your immigration intake or emergency callback request. Messages may include consent prompts, intake questions, callback status updates, appointment coordination, HELP responses, and STOP confirmations.</p>
<h2>No Legal Advice By SMS</h2>
<p>Automated SMS messages do not provide legal advice and do not create an attorney-client relationship. Staff review is required before any legal advice or representation decision is made.</p>
<h2>Message Frequency</h2>
<p>Message frequency varies. Message and data rates may apply. Reply STOP to opt out. Reply HELP for help.</p>
<h2>Emergency Notice</h2>
<p>SMS is not monitored continuously and should not be used for immediate physical danger. If someone is in immediate physical danger, call 911.</p>
</main>
</body>
</html>`;
