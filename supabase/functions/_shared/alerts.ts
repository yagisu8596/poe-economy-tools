/**
 * Alert delivery: turns fired alert events into Discord webhook messages.
 * Pure formatting + an injected fetch, so it is tested without network.
 * All text here is user-facing and therefore English.
 */
import { formatValue } from "./normalize.ts";

export interface AlertEvent {
  id: number;
  alert_id: number;
  item_id: number;
  item_name: string | null;
  alert_label: string | null;
  league_id: string;
  fired_at: string;
  kind: "above" | "below" | "rise" | "drop";
  threshold: number;
  unit: "chaos" | "divine" | null;
  window_minutes: number | null;
  now_chaos: number | null;
  now_divine: number | null;
  change_pct: number | null;
  volume_chaos: number | null;
  confidence: number | null;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  footer: { text: string };
}
export interface DiscordPayload {
  username: string;
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: string[] };
}

const GREEN = 0x2f9e44;
const RED = 0xc92a2a;
const FOOTER = "PoE Economy Tools · prices via poe.ninja · not affiliated with Grinding Gear Games";
const CONFIDENCE = ["low", "medium", "high"];
/** Discord allows at most 10 embeds per message. */
const EMBEDS_PER_MESSAGE = 10;

export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function windowLabel(minutes: number | null): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0 && minutes < 1440) return `${minutes / 60}h`;
  if (minutes === 1440) return "24h";
  return `${minutes}m`;
}

function compactChaos(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function signed(pct: number): string {
  const s = pct.toFixed(1);
  return pct > 0 ? `+${s}%` : pct < 0 ? `−${s.replace("-", "")}%` : "0.0%";
}

export function formatEvent(e: AlertEvent): DiscordEmbed {
  const name = e.item_name ?? `Item #${e.item_id}`;
  const up = e.kind === "rise" || e.kind === "above";
  let title: string;
  if (e.kind === "rise" || e.kind === "drop") {
    const pct = e.change_pct === null ? "?" : signed(e.change_pct);
    title = `${up ? "📈" : "📉"} ${name} ${pct} in ${windowLabel(e.window_minutes)}`;
  } else {
    const lvl = `${e.threshold} ${e.unit === "divine" ? "div" : "c"}`;
    title = `🔔 ${name} ${e.kind === "above" ? "rose above" : "fell below"} ${lvl}`;
  }

  const divinePrice = e.now_chaos && e.now_divine ? e.now_chaos / e.now_divine : null;
  const price = divinePrice ? formatValue(e.now_chaos, divinePrice) : { main: "—", alt: null };
  const lines = [
    `**Now:** ${price.main}${price.alt ? ` (${price.alt})` : ""}`,
    `**League:** ${e.league_id}`,
    `**Traded:** ${e.volume_chaos === null ? "—" : `${compactChaos(e.volume_chaos)} c`} · **Confidence:** ${
      e.confidence === null ? "—" : CONFIDENCE[e.confidence]
    }`,
  ];
  if (e.alert_label) lines.push(`**Rule:** ${e.alert_label}`);
  lines.push("_Check the live rate in game before you trade._");

  return { title, description: lines.join("\n"), color: up ? GREEN : RED, timestamp: e.fired_at, footer: { text: FOOTER } };
}

export function buildPayloads(events: AlertEvent[]): { payload: DiscordPayload; ids: number[] }[] {
  const out: { payload: DiscordPayload; ids: number[] }[] = [];
  for (let i = 0; i < events.length; i += EMBEDS_PER_MESSAGE) {
    const chunk = events.slice(i, i + EMBEDS_PER_MESSAGE);
    out.push({
      payload: { username: "PoE Economy Tools", embeds: chunk.map(formatEvent), allowed_mentions: { parse: [] } },
      ids: chunk.map((e) => e.id),
    });
  }
  return out;
}

export function testPayload(at: string): DiscordPayload {
  return {
    username: "PoE Economy Tools",
    embeds: [{
      title: "✅ Alerts are connected",
      description: "This channel will receive price alerts from PoE Economy Tools.",
      color: GREEN,
      timestamp: at,
      footer: { text: FOOTER },
    }],
    allowed_mentions: { parse: [] },
  };
}

export type PostJson = (url: string, body: unknown) => Promise<{ status: number; retryAfterMs: number | null }>;

/**
 * Sends one payload; on HTTP 429 waits the time Discord asks for (max 5 s) and
 * tries once more. Returns null on success, or an error text.
 */
export async function sendDiscord(
  post: PostJson,
  sleep: (ms: number) => Promise<void>,
  webhookUrl: string,
  payload: DiscordPayload,
): Promise<string | null> {
  if (!DISCORD_WEBHOOK_RE.test(webhookUrl)) return "Discord webhook URL is not valid";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: { status: number; retryAfterMs: number | null };
    try {
      res = await post(webhookUrl, payload);
    } catch (e) {
      return `Discord unreachable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (res.status >= 200 && res.status < 300) return null;
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(res.retryAfterMs ?? 1000, 5000));
      continue;
    }
    if (res.status === 404 || res.status === 401) return `Discord rejected the webhook (HTTP ${res.status}); it may have been deleted`;
    return `Discord HTTP ${res.status}`;
  }
  return "Discord rate limit";
}
