// Tracerfy REST client — skip trace + DNC/litigator scrub.
// Docs: https://www.tracerfy.com/skip-tracing-api-documentation/
// Async batch model: submit a job -> poll a queue id -> read parsed results.
//
// Compliance posture: this client is the data source for the suppression path.
// Every external call is wrapped in try/catch and surfaced as a typed TracerfyError.
// The API key is read from env and NEVER logged.

const BASE_URL = "https://tracerfy.com/v1/api";

// ---- Errors ----------------------------------------------------------------

/** Typed error for any Tracerfy failure (network, auth, non-2xx, parse). */
export class TracerfyError extends Error {
  readonly status?: number;
  readonly detail?: string;
  constructor(message: string, opts: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = "TracerfyError";
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

function getApiKey(): string {
  const key = process.env.TRACERFY_API_KEY;
  if (!key) {
    throw new TracerfyError(
      "TRACERFY_API_KEY is not set. Add it to .env.local (gitignored) / Vercel env."
    );
  }
  return key;
}

// ---- Types -----------------------------------------------------------------

export type TraceType = "normal" | "advanced";

/** A contact mapped into Tracerfy trace input (name + situs address). */
export interface TraceInputRecord {
  address: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** One parsed trace result row. Mapping back to a contact is by address+city+state. */
export interface TraceResultRow {
  address: string | null;
  city: string | null;
  state: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null; // best usable mobile, or null if only landlines/no match
  phoneType: string | null;
  matched: boolean;
}

/** One parsed scrub result row. Any flag set => suppress. */
export interface ScrubResultRow {
  phone: string; // normalized to last-10-digits
  federalDnc: boolean;
  stateDnc: boolean;
  dma: boolean;
  litigator: boolean;
  isClean: boolean;
}

export interface PollOptions {
  intervalMs?: number;
  maxAttempts?: number;
}

// ---- Small utilities -------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize a phone to its last 10 digits for stable cross-source matching. */
export function normalizePhone(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Stable key to map trace results back to a contact. Tracerfy's CSV has no zip
 * column, so we key on normalized UPPER(address)|UPPER(city)|UPPER(state).
 */
export function matchKey(address: unknown, city: unknown, state: unknown): string {
  const norm = (v: unknown) =>
    String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return `${norm(address)}|${norm(city)}|${norm(state)}`;
}

/** Trim-coerce any cell to a string. */
function strOr(v: unknown): string {
  return String(v ?? "").trim();
}

/** Coerce assorted truthy encodings (true/"true"/"1"/"yes"/"y") to boolean. */
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "t";
}

function pick<T = unknown>(o: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k] as T;
  }
  return undefined;
}

// ---- Core fetch wrappers ---------------------------------------------------

/**
 * Authenticated request against the Tracerfy API. Throws TracerfyError.
 * Pass `body` for a JSON request, or `form` for a multipart/form-data request
 * (the trace submit endpoint requires multipart — JSON is rejected with 415).
 */
async function apiFetch(
  path: string,
  init: { method?: string; body?: unknown; form?: FormData } = {}
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    Accept: "application/json",
  };
  // For multipart, let fetch set Content-Type (with the boundary) itself.
  if (init.form === undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
  } catch (err) {
    // Network / DNS / abort. Never leak the key; report the path only.
    throw new TracerfyError(`Network error calling ${path}`, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new TracerfyError(`Tracerfy ${res.status} on ${path}`, {
      status: res.status,
      detail: text.slice(0, 500),
    });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new TracerfyError(`Non-JSON response on ${path}`, {
      status: res.status,
      detail: text.slice(0, 500),
    });
  }
}

/** Fetch a (presigned) results file URL and return its raw text body. */
async function apiFetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new TracerfyError(`Results download ${res.status}`, { status: res.status });
    }
    return await res.text();
  } catch (err) {
    if (err instanceof TracerfyError) throw err;
    throw new TracerfyError("Network error downloading results", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- Credits / analytics ---------------------------------------------------

/** Remaining account credits (pre-flight guard before a full run). */
export async function getCredits(): Promise<number> {
  const data = (await apiFetch("/analytics/")) as Record<string, unknown>;
  const balance = pick<number>(data, ["balance", "credits", "remaining_credits"]);
  if (typeof balance !== "number") {
    throw new TracerfyError("Could not read credit balance from /analytics/", {
      detail: JSON.stringify(data).slice(0, 300),
    });
  }
  return balance;
}

// ---- Skip trace ------------------------------------------------------------

/**
 * Submit a batch trace job. Returns the queue id used to poll results.
 * Input is name + situs address; we send json_data plus *_column mappings.
 */
export async function submitTrace(
  records: TraceInputRecord[],
  opts: { traceType?: TraceType } = {}
): Promise<{ queueId: number; rowsUploaded: number }> {
  if (records.length === 0) {
    throw new TracerfyError("submitTrace called with zero records");
  }
  // Our list is owner-occupied (homestead-filtered), so the mailing address
  // equals the situs address — Tracerfy requires a mail address for normal
  // traces, and mail==situs is correct for this owner-occupied list.
  const json_data = records.map((r) => ({
    address: r.address,
    city: r.city ?? "",
    state: r.state ?? "",
    zip: r.zip ?? "",
    mail_address: r.address,
    mail_city: r.city ?? "",
    mail_state: r.state ?? "",
    first_name: r.firstName ?? "",
    last_name: r.lastName ?? "",
  }));
  // /trace/ requires multipart/form-data (rejects JSON with 415). The record
  // array goes in as a JSON-stringified form field plus the column mappings.
  const form = new FormData();
  form.append("json_data", JSON.stringify(json_data));
  form.append("address_column", "address");
  form.append("city_column", "city");
  form.append("state_column", "state");
  form.append("zip_column", "zip");
  form.append("mail_address_column", "mail_address");
  form.append("mail_city_column", "mail_city");
  form.append("mail_state_column", "mail_state");
  form.append("first_name_column", "first_name");
  form.append("last_name_column", "last_name");
  form.append("trace_type", opts.traceType ?? "normal");
  const data = (await apiFetch("/trace/", { method: "POST", form })) as Record<string, unknown>;
  const queueId = pick<number>(data, ["queue_id", "queueId", "id"]);
  if (typeof queueId !== "number") {
    throw new TracerfyError("submitTrace: no queue_id in response", {
      detail: JSON.stringify(data).slice(0, 300),
    });
  }
  const rowsUploaded = pick<number>(data, ["rows_uploaded", "rowsUploaded"]) ?? records.length;
  return { queueId, rowsUploaded };
}

/**
 * Pick the best SMS-usable phone from a trace row. Per the Tracerfy CSV shape:
 * use primary_phone when primary_phone_type is Mobile; otherwise the first
 * non-empty Mobile-N. If only landlines exist, return null (no usable mobile —
 * the caller treats this as a no-match for SMS and suppresses).
 */
function pickMobile(o: Record<string, unknown>): { phone: string | null; phoneType: string | null } {
  const primary = strOr(pick(o, ["primary_phone"]));
  const primaryType = strOr(pick(o, ["primary_phone_type"])).toLowerCase();
  if (primary && primaryType === "mobile") {
    return { phone: normalizePhone(primary), phoneType: "Mobile" };
  }
  for (let n = 1; n <= 5; n++) {
    const m = strOr(o[`mobile-${n}`] ?? o[`mobile_${n}`] ?? o[`mobile${n}`]);
    if (m) return { phone: normalizePhone(m), phoneType: "Mobile" };
  }
  return { phone: null, phoneType: null };
}

function toTraceRow(o: Record<string, unknown>): TraceResultRow {
  const { phone, phoneType } = pickMobile(o);
  return {
    address: (pick(o, ["address", "property_address", "mail_address"]) as string) ?? null,
    city: (pick(o, ["city", "mail_city"]) as string) ?? null,
    state: (pick(o, ["state", "mail_state"]) as string) ?? null,
    firstName: (pick(o, ["first_name"]) as string) ?? null,
    lastName: (pick(o, ["last_name"]) as string) ?? null,
    phone,
    phoneType,
    matched: Boolean(phone),
  };
}

/** Find the inline result-row array in a trace queue response (bare or wrapped). */
function extractTraceRows(payload: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const rows = pick<unknown[]>(payload as Record<string, unknown>, [
      "results",
      "rows",
      "data",
      "leads",
    ]);
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return null;
}

/**
 * Poll a trace queue until its inline JSON results are ready, then parse them.
 * The endpoint (`GET /queue/:id`, no trailing slash) returns a bare array of
 * row objects — it has no status field, so completion is detected by the row
 * count reaching `expectedRows` (the batch may materialize incrementally).
 *
 * Transient network errors (the job is still being written) are retried, not
 * fatal. On timeout we return whatever rows arrived: any contact missing from
 * the results falls through to a no-match and is suppressed downstream (fail
 * closed), so a partial read can never leave an unverified number eligible.
 */
export async function getTraceResults(
  queueId: number,
  opts: PollOptions & { expectedRows?: number } = {}
): Promise<{ rows: TraceResultRow[]; raw: unknown }> {
  const intervalMs = opts.intervalMs ?? 5000;
  const maxAttempts = opts.maxAttempts ?? 60;
  const expected = opts.expectedRows ?? 1;
  let lastRaw: unknown = null;
  let lastRows: Record<string, unknown>[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let payload: unknown;
    try {
      payload = await apiFetch(`/queue/${queueId}`);
    } catch (err) {
      if (attempt < maxAttempts - 1) {
        await sleep(intervalMs);
        continue;
      }
      throw err;
    }
    lastRaw = payload;
    const inline = extractTraceRows(payload);
    if (inline) {
      lastRows = inline;
      if (inline.length >= expected) {
        return { rows: inline.map(toTraceRow), raw: payload };
      }
    }
    await sleep(intervalMs);
  }
  return { rows: lastRows.map(toTraceRow), raw: lastRaw };
}

// ---- DNC / litigator scrub -------------------------------------------------

/**
 * Submit a scrub job. Prefer scrub-from-queue (reuses a completed trace queue,
 * avoids re-uploading phones); falls back to an explicit phone list.
 */
export async function submitScrub(
  input: { queueId: number; phoneColumns?: string[] } | { phones: string[] }
): Promise<{ scrubQueueId: number }> {
  let data: Record<string, unknown>;
  if ("queueId" in input) {
    const body = {
      queue_id: input.queueId,
      phone_columns: input.phoneColumns ?? ["primary_phone"],
    };
    data = (await apiFetch("/dnc/scrub-from-queue/", { method: "POST", body })) as Record<
      string,
      unknown
    >;
  } else {
    if (input.phones.length === 0) {
      throw new TracerfyError("submitScrub called with zero phones");
    }
    data = (await apiFetch("/dnc/scrub/", {
      method: "POST",
      body: { phones: input.phones },
    })) as Record<string, unknown>;
  }
  const scrubQueueId = pick<number>(data, ["dnc_queue_id", "queue_id", "id"]);
  if (typeof scrubQueueId !== "number") {
    throw new TracerfyError("submitScrub: no dnc_queue_id in response", {
      detail: JSON.stringify(data).slice(0, 300),
    });
  }
  return { scrubQueueId };
}

/**
 * CSV parser for a downloaded results file. Quote-aware (handles commas and
 * newlines inside quoted fields, and "" escapes) because trace address columns
 * can contain commas. Headers are lowercased so callers can use stable keys.
 */
function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((cells) => {
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
      return row;
    });
}

/** Aliases for the results-file URL inside a completed queue/job response. */
function findDownloadUrl(meta: Record<string, unknown>): string | undefined {
  return pick<string>(meta, [
    "download_url",
    "results_url",
    "result_url",
    "csv_url",
    "file_url",
    "output_url",
  ]);
}

/**
 * Poll a queue/job endpoint until it is complete AND a results file URL is
 * available, then download and return the raw file text alongside the meta.
 * Throws on explicit job failure or timeout.
 */
async function pollForResultsFile(
  path: string,
  opts: PollOptions = {}
): Promise<{ meta: Record<string, unknown>; text: string }> {
  const intervalMs = opts.intervalMs ?? 5000;
  const maxAttempts = opts.maxAttempts ?? 60;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let meta: Record<string, unknown>;
    try {
      meta = (await apiFetch(path)) as Record<string, unknown>;
    } catch (err) {
      // Transient (job still materializing) — keep polling.
      if (attempt < maxAttempts - 1) {
        await sleep(intervalMs);
        continue;
      }
      throw err;
    }
    const status = strOr(pick(meta, ["status"])).toLowerCase();
    if (status === "failed" || status === "error") {
      throw new TracerfyError(`Job at ${path} failed`, {
        detail: JSON.stringify(meta).slice(0, 300),
      });
    }
    const pending = pick(meta, ["pending"]);
    const stillPending =
      pending === true ||
      ["pending", "processing", "queued", "running", "in_progress"].includes(status);
    const url = findDownloadUrl(meta);
    if (!stillPending && url) {
      const text = await apiFetchText(url);
      return { meta, text };
    }
    await sleep(intervalMs);
  }
  throw new TracerfyError(
    `Job at ${path} did not produce a results file after ${maxAttempts} polls`
  );
}

/** Parse the scrub results body (JSON array, wrapped JSON, or CSV). */
function parseScrubPayload(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const j = JSON.parse(trimmed);
    if (Array.isArray(j)) return j as Record<string, unknown>[];
    const rows = pick<unknown[]>(j as Record<string, unknown>, ["results", "rows", "data"]);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }
  return parseCsv(trimmed);
}

function toScrubRow(o: Record<string, unknown>): ScrubResultRow | null {
  const phoneRaw = pick(o, ["phone", "number", "primary_phone"]);
  if (!phoneRaw) return null;
  const federalDnc = toBool(pick(o, ["national_dnc", "federal_dnc", "dnc"]));
  const stateDnc = toBool(pick(o, ["state_dnc"]));
  const dma = toBool(pick(o, ["dma"]));
  const litigator = toBool(pick(o, ["litigator"]));
  const anyFlag = federalDnc || stateDnc || dma || litigator;
  const isCleanField = pick(o, ["is_clean", "clean"]);
  // Fail closed: clean only if no flag is set AND the explicit clean flag (if any) agrees.
  const isClean = !anyFlag && (isCleanField === undefined ? true : toBool(isCleanField));
  return { phone: normalizePhone(phoneRaw), federalDnc, stateDnc, dma, litigator, isClean };
}

/**
 * Poll a scrub queue until complete, download the results file, and parse it.
 * Returns rows, a phone->row map, and the set of explicitly-clean phones.
 * The caller fails closed: a phone NOT in `cleanByPhone` must be suppressed.
 */
export async function getScrubResults(
  scrubQueueId: number,
  opts: PollOptions = {}
): Promise<{
  rows: ScrubResultRow[];
  byPhone: Map<string, ScrubResultRow>;
  raw: unknown;
}> {
  const { meta, text } = await pollForResultsFile(`/dnc/queue/${scrubQueueId}`, opts);
  const rows = parseScrubPayload(text)
    .map((r) => toScrubRow(r))
    .filter((r): r is ScrubResultRow => r !== null);
  const byPhone = new Map<string, ScrubResultRow>();
  for (const r of rows) byPhone.set(r.phone, r);
  return { rows, byPhone, raw: { meta, csvSample: text.slice(0, 2000) } };
}
