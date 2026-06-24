/**
 * lib/twilio.ts — Twilio client + single-message send helper + pacing/send-window.
 *
 * Message rendering lives in lib/sms.ts and is NOT re-implemented here. This module
 * only deals with: building the SDK client from env, sending one SMS with typed
 * error handling, pacing math (sends/hour), and the allowed send-window check.
 *
 * Secrets come from env only and are never logged (we never print the auth token).
 */

import twilio, { type Twilio } from "twilio";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendOk {
  ok: true;
  sid: string;
  status: string;
}

export interface SendError {
  ok: false;
  error: string;
  code?: number | string;
}

export type SendResult = SendOk | SendError;

/** Thrown only for misconfiguration (missing env). Never carries the auth token. */
export class TwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioConfigError";
  }
}

// ---------------------------------------------------------------------------
// Client + sender config (lazy — env is read on first use, not at import)
// ---------------------------------------------------------------------------

let cachedClient: Twilio | null = null;

function getClient(): Twilio {
  if (cachedClient) return cachedClient;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in the environment."
    );
  }
  cachedClient = twilio(accountSid, authToken);
  return cachedClient;
}

/**
 * Resolve the sender. Prefer a Messaging Service SID (better for 10DLC routing);
 * fall back to a bare from-number. Returns the field Twilio's create() expects.
 */
export function getSenderField(): { messagingServiceSid: string } | { from: string } {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (messagingServiceSid) return { messagingServiceSid };
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (from) return { from };
  throw new TwilioConfigError(
    "Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER to choose the sender."
  );
}

// ---------------------------------------------------------------------------
// sendOne
// ---------------------------------------------------------------------------

/**
 * Send exactly one SMS. Wrapped in try/catch — returns a typed result instead of
 * throwing for send failures so the caller can mark the contact 'failed' and move
 * on. The auth token is never included in any error.
 *
 * `sender` is the per-client Twilio sender (from clientSender(client)). When omitted it falls
 * back to the env sender (getSenderField) — used by the smoke scripts. The account credentials
 * (SID/token) are always account-level env; only the from-number/messaging-service is per client.
 */
export async function sendOne(
  to: string,
  body: string,
  sender?: { messagingServiceSid: string } | { from: string }
): Promise<SendResult> {
  try {
    const client = getClient();
    const s = sender ?? getSenderField();
    const msg = await client.messages.create({ to, body, ...s });
    return { ok: true, sid: msg.sid, status: msg.status };
  } catch (err: unknown) {
    // Twilio errors carry a numeric `code` and a `message`; surface those, nothing else.
    const e = err as { message?: string; code?: number | string };
    return {
      ok: false,
      error: e?.message ? String(e.message) : "twilio_send_failed",
      code: e?.code,
    };
  }
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/**
 * Sends/hour. Prefers an explicit per-client `override` (client.send_rate_per_hour); falls back
 * to env SEND_RATE_PER_HOUR (default 60). Clamped to a sane floor of 1.
 */
export function sendRatePerHour(override?: number): number {
  const raw = override !== undefined ? override : Number(process.env.SEND_RATE_PER_HOUR);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.max(1, Math.floor(raw));
}

/** Milliseconds to wait between consecutive sends to honor the hourly rate (per-client override). */
export function pacingDelayMs(rateOverride?: number): number {
  return Math.round(3_600_000 / sendRatePerHour(rateOverride));
}

/** Promise-based sleep used to space sends. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Send window (local-hours guard)
// ---------------------------------------------------------------------------

/**
 * Default allowed window: 10:00–19:00 in the campaign timezone (America/New_York —
 * Tallahassee is Eastern; the earlier CT default was wrong, RESOLVED 2026-06-22, see
 * overview.md). All three are env-overridable: SEND_WINDOW_START_HOUR,
 * SEND_WINDOW_END_HOUR, SEND_TIMEZONE. Window is [start, end) — a send at exactly the
 * end hour is OUT.
 */
const DEFAULT_START_HOUR = 10;
const DEFAULT_END_HOUR = 19;
const DEFAULT_TIMEZONE = "America/New_York";

/**
 * Per-client send-window config (from clientWindow(client)). When a caller passes it, the
 * window/timezone come from the client record; when omitted, they fall back to env (used by
 * scripts / any pre-v2 caller). Structurally compatible with lib/clients SendWindowConfig.
 */
export interface SendWindowOptions {
  startHour: number;
  endHour: number;
  timezone: string;
}

function envHour(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isInteger(raw) || raw < 0 || raw > 23) return fallback;
  return raw;
}

/** Resolve effective window config from an optional per-client override, else env defaults. */
function resolveWindow(cfg?: SendWindowOptions): SendWindowOptions {
  if (cfg) return cfg;
  return {
    startHour: envHour("SEND_WINDOW_START_HOUR", DEFAULT_START_HOUR),
    endHour: envHour("SEND_WINDOW_END_HOUR", DEFAULT_END_HOUR),
    timezone: process.env.SEND_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
  };
}

export function sendTimezone(): string {
  return process.env.SEND_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

/** The local hour (0–23) for `now` in the given timezone (defaults to the env campaign timezone). */
export function localHour(now: Date = new Date(), timezone: string = sendTimezone()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  });
  // hourCycle differences can yield "24" for midnight; normalize to 0–23.
  const raw = parseInt(fmt.format(now), 10);
  if (Number.isNaN(raw)) {
    // Fail closed rather than silently fall back to server-local (UTC on Vercel) time,
    // which would evaluate the send window in the wrong timezone.
    throw new Error(`localHour: Intl returned a non-numeric hour for timezone ${timezone}`);
  }
  return raw % 24;
}

/** True only if `now` falls within [start, end) local hours of the client's campaign timezone. */
export function withinSendWindow(now: Date = new Date(), cfg?: SendWindowOptions): boolean {
  const w = resolveWindow(cfg);
  const hour = localHour(now, w.timezone);
  return hour >= w.startHour && hour < w.endHour;
}

/** Human-readable window description for logs / API responses. */
export function sendWindowLabel(cfg?: SendWindowOptions): string {
  const w = resolveWindow(cfg);
  return `${w.startHour}:00–${w.endHour}:00 ${w.timezone}`;
}
