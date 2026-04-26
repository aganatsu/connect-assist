import { corsHeaders } from "../_shared/cors.ts";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

// M9: Rate limit tracking — max 1 message per 5 seconds per chat
const _lastSentTimestamps = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const TELEGRAM_API_KEY = Deno.env.get("TELEGRAM_API_KEY");
    if (!TELEGRAM_API_KEY) throw new Error("TELEGRAM_API_KEY is not configured");

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

    // M9: Send with retry (max 2 retries)
    let lastError: Error | null = null;
    let messageId: number | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${GATEWAY_URL}/sendMessage`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "X-Connection-Api-Key": TELEGRAM_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: combinedMessage,
            parse_mode: "HTML",
          }),
        });

        const data = await response.json();
        if (response.ok) {
          messageId = data.result?.message_id || null;
          _lastSentTimestamps.set(String(chatId), Date.now());
          break;
        }

        console.error(`[telegram-notify] Attempt ${attempt + 1} failed [${response.status}]:`, JSON.stringify(data));
        lastError = new Error(`Telegram API failed [${response.status}]`);

        // Don't retry on 4xx (client errors)
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
