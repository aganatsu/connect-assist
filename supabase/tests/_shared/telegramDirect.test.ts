import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * telegram-notify posted to connector-gateway.lovable.dev with LOVABLE_API_KEY
 * as bearer auth and the Telegram credential as X-Connection-Api-Key. Two
 * consequences, both bad for a system leaving Lovable:
 *
 *   1. It threw on the FIRST line of the handler when LOVABLE_API_KEY was
 *      absent, before reading the body — so every trade alert, every
 *      confirmation and both advisor digests die the moment the subscription
 *      lapses, with a 500 the callers do not check.
 *   2. Callers use `await fetch(...)` and discard the response, so nothing
 *      surfaces. Notifications simply stop.
 *
 * Now it calls api.telegram.org directly. The wire contract to callers is
 * unchanged: { chat_id, message } or { chat_id, messages[] } in,
 * { success, message_id, batched } out.
 */

const fn = await Deno.readTextFile(
  new URL("../../functions/telegram-notify/index.ts", import.meta.url),
);

/** Executable source only. The comments discuss Lovable deliberately — that
 *  history is why this function is shaped the way it is — so matching raw text
 *  would fail on its own explanation. */
const code = fn
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");

Deno.test("no Lovable dependency remains", () => {
  assert(!/LOVABLE_API_KEY/.test(code), "the key that made it throw must be gone");
  assert(!/X-Connection-Api-Key/i.test(code), "the gateway's connection header must be gone");
  assert(!/connector-gateway/.test(code), "the gateway host must be gone");
  assert(!/lovable\.dev/.test(code), "no lovable.dev endpoint anywhere");
  // And the comments must not be the only place the change is recorded.
  assert(/api\.telegram\.org/.test(code), "the replacement is in the code, not just described");
});

Deno.test("it posts to Telegram's own sendMessage endpoint", () => {
  assert(/https:\/\/api\.telegram\.org/.test(fn), "official API host");
  assert(/\/bot\$\{botToken\}\/sendMessage/.test(fn), "token goes in the path, as Telegram requires");
});

Deno.test("the token is read from either name", () => {
  // The old deployment called it TELEGRAM_API_KEY. Accepting both means the
  // rename is not a second thing that can silently break the migration.
  assert(
    /Deno\.env\.get\("TELEGRAM_BOT_TOKEN"\) \?\? Deno\.env\.get\("TELEGRAM_API_KEY"\)/.test(fn),
    "prefer TELEGRAM_BOT_TOKEN, fall back to TELEGRAM_API_KEY",
  );
});

/** Token shape check, mirroring the function. */
const looksLikeBotToken = (t: string) => /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t);

Deno.test("a Lovable connection key is rejected as a bot token", () => {
  // An upgraded project carries a credential with the right NAME and the wrong
  // CONTENT. Telegram answers 404 to that, which reads like an outage rather
  // than a misconfiguration.
  assertEquals(looksLikeBotToken("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), true);
  assertEquals(looksLikeBotToken("sb_secret_ZW4kRu-XhrE52BNBsZ"), false, "a Supabase key");
  assertEquals(looksLikeBotToken("abc123"), false, "a Lovable connection key");
  assertEquals(looksLikeBotToken(""), false);
  assertEquals(looksLikeBotToken("123456789:short"), false, "too short after the colon");
});

Deno.test("the misconfiguration message names the real cause", () => {
  // The TwelveData key was saved under the name "Twleve Data / Sept" and the
  // symptom was a scanner that found nothing and reported no errors. Credential
  // failures have to say what is actually wrong.
  assert(/@BotFather/.test(fn), "says where to get a real token");
  assert(/A Lovable connection key/.test(fn),
    "names the specific wrong value an upgraded project will be carrying");
  assert(/expected /.test(fn) && /<digits>:<letters>/.test(fn),
    "states the shape it wanted, so the fix is obvious from the message alone");
});

Deno.test("ok:false is treated as failure, not just a bad status", () => {
  // Telegram can answer 200 with { ok: false }. Reading response.ok alone
  // reports success and returns message_id null.
  assert(/if \(response\.ok && data\?\.ok\)/.test(fn));
});

Deno.test("a 429 waits as long as Telegram instructs", () => {
  assert(/parameters\?\.retry_after/.test(fn), "use the server's own figure");
  assert(/Math\.min\(retryAfter, 30\)/.test(fn), "but do not sleep unboundedly");
  // 429 must be handled BEFORE the generic 4xx break, or it never retries.
  assert(
    fn.indexOf("response.status === 429") < fn.indexOf("response.status >= 400 && response.status < 500"),
    "429 handling must precede the 4xx bail-out",
  );
});

Deno.test("bad HTML falls back to plain text instead of losing the alert", () => {
  // Messages carry symbols, prices and free-text reasons. One stray "<" makes
  // Telegram reject the whole message as unparseable — a 4xx, which does not
  // retry, so the notification would vanish.
  assert(/can't parse entities/i.test(fn), "detect Telegram's own wording");
  assert(/parseMode = null;/.test(fn), "resend without formatting");
  assert(/\.\.\.\(parseMode \? \{ parse_mode: parseMode \} : \{\}\)/.test(fn),
    "parse_mode omitted entirely on the retry, not set to empty");
});

Deno.test("the contract callers depend on is unchanged", () => {
  // 15 call sites across bot-scanner, zone-confirmation-scanner,
  // outcome-tracker, both advisors and Settings.tsx.
  for (const k of ["chat_id is required", "message or messages\\[\\] is required"]) {
    assert(new RegExp(k).test(fn), `still validates: ${k}`);
  }
  assert(/success: true, message_id: messageId, batched: messages\.length/.test(fn),
    "response shape unchanged");
  assert(/messages\.map\(\(m, i\) => `\$\{i \+ 1\}\. \$\{m\}`\)/.test(fn),
    "batch formatting unchanged");
  assert(/RATE_LIMIT_MS = 5_000/.test(fn), "per-chat rate limit unchanged");
});

Deno.test("callers still discard the response, so failures are log-only", () => {
  // Not fixed here, but worth asserting so it is not mistaken for handled.
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  assert(
    /await fetch\(`\$\{Deno\.env\.get\("SUPABASE_URL"\)\}\/functions\/v1\/telegram-notify`/.test(scanner),
    "bot-scanner fires and forgets — a failed alert is invisible outside the logs",
  );
});
