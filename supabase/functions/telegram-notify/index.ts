import { corsHeaders } from "../_shared/cors.ts";

// Telegram's own Bot API. This used to post to connector-gateway.lovable.dev
// with LOVABLE_API_KEY as bearer auth and the Telegram credential as
// X-Connection-Api-Key — so notifications stopped the moment the Lovable
// subscription did, and threw before reading the request body.
//
// The bot token comes from BotFather and looks like "123456789:AA...".
// TELEGRAM_BOT_TOKEN is the name to use; TELEGRAM_API_KEY is accepted because
// that is what the old deployment called it.
const TELEGRAM_API = "https://api.telegram.org";

// M9: Rate limit tracking — max 1 message per 5 seconds per chat
const _lastSentTimestamps = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

/** A BotFather token is "<digits>:<35 or so url-safe chars>". */
function looksLikeBotToken(t: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? Deno.env.get("TELEGRAM_API_KEY");
    if (!botToken) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN is not configured (get one from @BotFather)",
      );
    }
    // The old value was a Lovable connection key, not a bot token, so an
    // upgraded project carries a credential that is the right name and the
    // wrong thing. Say that plainly rather than letting Telegram answer 404.
    if (!looksLikeBotToken(botToken)) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN is not a Telegram bot token — expected " +
          "\"<digits>:<letters>\" from @BotFather. A Lovable connection key " +
          "will not work now that this calls Telegram directly.",
      );
    }

    const body = await req.json();

    // M9: Support both single message and batch messages
    // Single: { chat_id, message }
    // Batch:  { chat_id, messages: string[] }
    const chatId = body.chat_id;
    if (!chatId) {
      return new Response(JSON.stringify({ error: "chat_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let messages: string[] = [];
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      // Batch mode: combine multiple messages into one
      messages = body.messages;
    } else if (body.message) {
      messages = [body.message];
    } else {
      return new Response(JSON.stringify({ error: "message or messages[] is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // M9: Batch messages into a single Telegram message (separated by divider)
    const combinedMessage = messages.length === 1
      ? messages[0]
      : messages.map((m, i) => `${i + 1}. ${m}`).join("\n\n━━━━━━━━━━━━━━━\n\n");

    // M9: Rate limit check — skip if sent too recently to this chat
    const lastSent = _lastSentTimestamps.get(String(chatId)) || 0;
    const now = Date.now();
    if (now - lastSent < RATE_LIMIT_MS) {
      const waitMs = RATE_LIMIT_MS - (now - lastSent);
      console.log(`[telegram-notify] Rate limit: waiting ${waitMs}ms for chat ${chatId}`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

    // M9: Send with retry (max 2 retries)
    let lastError: Error | null = null;
    let messageId: number | null = null;
    // Messages are assembled from symbols, prices and reasons, so a stray "<"
    // makes Telegram reject the whole thing as bad HTML — a 4xx, which does not
    // retry, so the alert would be lost silently. Drop the formatting and send
    // it as plain text instead.
    let parseMode: string | null = "HTML";

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: combinedMessage,
            ...(parseMode ? { parse_mode: parseMode } : {}),
          }),
        });

        const data = await response.json();
        // Telegram signals failure with ok:false, not only by status.
        if (response.ok && data?.ok) {
          messageId = data.result?.message_id || null;
          _lastSentTimestamps.set(String(chatId), Date.now());
          break;
        }

        const description = String(data?.description ?? "");
        console.error(
          `[telegram-notify] Attempt ${attempt + 1} failed [${response.status}]: ${description}`,
        );
        lastError = new Error(`Telegram API failed [${response.status}]: ${description}`);

        // Bad HTML in the message body — resend once without parse_mode rather
        // than dropping the notification.
        if (parseMode && /can't parse entities/i.test(description)) {
          console.warn("[telegram-notify] retrying as plain text — message was not valid HTML");
          parseMode = null;
          continue;
        }

        // Telegram tells us exactly how long to wait when it rate limits.
        if (response.status === 429) {
          const retryAfter = Number(data?.parameters?.retry_after ?? 1);
          console.warn(`[telegram-notify] 429 — waiting ${retryAfter}s as instructed`);
          await new Promise(r => setTimeout(r, Math.min(retryAfter, 30) * 1000));
          continue;
        }

        // Don't retry on other 4xx (bad chat_id, bot blocked, wrong token)
        if (response.status >= 400 && response.status < 500) break;

        // Wait before retry
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      } catch (e: any) {
        lastError = e;
        console.error(`[telegram-notify] Attempt ${attempt + 1} network error:`, e.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }

    if (messageId !== null) {
      return new Response(JSON.stringify({ success: true, message_id: messageId, batched: messages.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw lastError || new Error("Failed to send Telegram message after retries");
  } catch (error: any) {
    console.error("telegram-notify error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
