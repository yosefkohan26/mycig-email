// Matter-Intel RPC client. Signs requests with HMAC-SHA256 over a canonical
// string that must exactly match the server-side scheme in MyCIG's
// backend/internal/middleware/service_auth.go — any divergence here yields a
// 401 "signature mismatch" with no other diagnostic.
//
// Canonical:
//   METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + HEX(SHA256(BODY))
// Signature:
//   HEX(HMAC_SHA256(shared_secret, canonical))

import type { ZeroEnv } from '../env';

export type MatterIntelConfig = {
  /** Base URL, e.g. https://api.ciglaw.com or http://localhost:8080 */
  baseUrl: string;
  /** Key id registered on the server side in MATTER_INTEL_SERVICE_KEYS. */
  keyId: string;
  /** Shared HMAC secret paired with the key id on the server. */
  secret: string;
};

export type MatterIntelResponse<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const enc = new TextEncoder();

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bufToHex(new Uint8Array(sig));
}

function bufToHex(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, '0');
  }
  return out;
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bufToHex(bytes);
}

/**
 * Call a Matter-Intel endpoint. Caller supplies method + path (path is
 * relative — e.g. '/matter-intel/health') + optional JSON body. Returns a
 * discriminated union so callers never have to parse the raw Response.
 */
export async function matterIntelCall<T = unknown>(
  cfg: MatterIntelConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<MatterIntelResponse<T>> {
  if (!cfg.baseUrl || !cfg.keyId || !cfg.secret) {
    return { ok: false, status: 0, error: 'matter-intel not configured' };
  }

  const bodyBytes = body === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = newNonce();
  const bodyHash = await sha256Hex(bodyBytes);

  // The `path` param here is the full request-target (path + raw query
  // string), matching Go's r.URL.RequestURI() on the server side. Query
  // params are part of the signature so an attacker can't swap `?user_id=X`
  // for `?user_id=Y` on a signed request.
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = await hmacSha256Hex(cfg.secret, canonical);

  const url = cfg.baseUrl.replace(/\/+$/, '') + path;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        'X-Service-Key-Id': cfg.keyId,
        'X-Service-Timestamp': timestamp,
        'X-Service-Nonce': nonce,
        'X-Service-Signature': signature,
        ...(bodyBytes.length > 0 ? { 'Content-Type': 'application/json' } : {}),
      },
      body: bodyBytes.length > 0 ? bodyBytes : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: text || resp.statusText };
  }
  try {
    return { ok: true, status: resp.status, data: text ? (JSON.parse(text) as T) : (null as T) };
  } catch {
    // Server is supposed to return JSON, but don't hard-fail if it doesn't.
    return { ok: true, status: resp.status, data: text as unknown as T };
  }
}

/**
 * Build a MatterIntelConfig from the worker env. Returns null when any of
 * the three required vars are missing, so callers can cleanly skip the call
 * in local dev without crashing.
 */
export function matterIntelFromEnv(env: ZeroEnv): MatterIntelConfig | null {
  const baseUrl = env.MATTER_INTEL_BASE_URL;
  const keyId = env.MATTER_INTEL_KEY_ID;
  const secret = env.MATTER_INTEL_SECRET;
  if (!baseUrl || !keyId || !secret) return null;
  return { baseUrl, keyId, secret };
}

// ----------------------------------------------------------------------------
// Typed wrappers — grow this surface as Phase 3b lands real endpoints.
// ----------------------------------------------------------------------------

export type HealthResponse = {
  status: 'ok';
  service_key_id: string;
  server_time: string;
};

export function matterIntelHealth(cfg: MatterIntelConfig) {
  return matterIntelCall<HealthResponse>(cfg, 'GET', '/api/v1/matter-intel/health');
}

// --- Mailroom --------------------------------------------------------------
// Matches MyCIG backend handlers/matter_intel.go MailroomResponse. MyCIG
// wraps responses in an APIResponse envelope, so the data we care about
// sits under `data`. Callers unpack that — see matterIntelMailroom below.

export type MailroomEmailResponse = {
  id: string;
  user_id?: string;
  project_id?: string | null;
  message_id?: string;
  thread_id?: string | null;
  internet_message_id?: string | null;
  subject?: string | null;
  from_address?: string | null;
  from_name?: string | null;
  received_at?: string | null;
  ai_suggested_project_id?: string | null;
  ai_classification_confidence?: number | null;
  ai_classification_reasoning?: string | null;
  // Additional fields exist on the server side — typed as-needed. Keep this
  // shape conservative so callers don't rely on fields that may disappear.
  [k: string]: unknown;
};

export type MailroomResponse = {
  emails: MailroomEmailResponse[];
  total: number;
  limit: number;
  offset: number;
};

export type MailroomFilter = 'all' | 'suggestions' | 'errors' | 'unclassified';

/**
 * Read a user's mailroom queue. `filter` defaults to 'all' on the server
 * when omitted. `limit` is clamped to [1, 200] server-side; sending a value
 * outside that range silently falls back to the 50 default.
 */
export function matterIntelMailroom(
  cfg: MatterIntelConfig,
  params: { userId: string; filter?: MailroomFilter; limit?: number; offset?: number },
) {
  const q = new URLSearchParams();
  q.set('user_id', params.userId);
  if (params.filter) q.set('filter', params.filter);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  // MyCIG wraps success in { success: true, data: ... }. Declaring that here
  // so callers can pluck `.data` without a second type gymnastic.
  return matterIntelCall<{ success: boolean; data: MailroomResponse }>(
    cfg,
    'GET',
    `/api/v1/matter-intel/mailroom?${q.toString()}`,
  );
}
