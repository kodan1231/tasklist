import type { Env } from "./env";
import { HttpError, type Member } from "./model";

export function parseUsers(raw: string | undefined): Member[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf("=");
      const email = (i < 0 ? entry : entry.slice(0, i)).trim().toLowerCase();
      const name = (i < 0 ? "" : entry.slice(i + 1).trim()) || email;
      return { email, name };
    });
}

function normalizeDomain(raw: string): string {
  const d = raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return d.includes(".") ? d : `${d}.cloudflareaccess.com`;
}

type Jwk = JsonWebKey & { kid?: string };

let certCache: { domain: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function getKeys(domain: string, force: boolean): Promise<Jwk[]> {
  if (!force && certCache?.domain === domain && Date.now() - certCache.fetchedAt < 3600_000) {
    return certCache.keys;
  }
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`failed to fetch Access certs: HTTP ${res.status}`);
  const { keys } = await res.json<{ keys: Jwk[] }>();
  certCache = { domain, keys, fetchedAt: Date.now() };
  return keys;
}

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Cloudflare Access が付与する JWT を検証し、メールアドレスを返す
async function verifyAccessJwt(token: string, domain: string, aud: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; iss?: string; email?: string };
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  let jwk = (await getKeys(domain, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(domain, true)).find((k) => k.kid === header.kid); // 鍵のローテーション対応
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return null;

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
  if (payload.iss !== `https://${domain}`) return null;
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}

// ログイン中のメールアドレスを返す。メンバーかどうかの判定は TaskStore 側で行う
export async function authenticate(req: Request, env: Env): Promise<string> {
  const host = new URL(req.url).hostname;
  if (env.DEV_USER_EMAIL && (host === "localhost" || host === "127.0.0.1")) {
    return env.DEV_USER_EMAIL.toLowerCase();
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(500, "ACCESS_TEAM_DOMAIN / ACCESS_AUD が設定されていません");
  }
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new HttpError(401, "ログインしていません");
  const email = await verifyAccessJwt(token, normalizeDomain(env.ACCESS_TEAM_DOMAIN), env.ACCESS_AUD);
  if (!email) throw new HttpError(401, "ログイン情報が無効です");
  return email;
}
