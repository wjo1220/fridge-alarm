// 알림에 필요한 계산과 웹 푸시 발송 (Cloudflare Workers / Node 공통)
const enc = new TextEncoder();

export function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 알림 서버 열쇠(VAPID) — 처음 한 번 만들어서 저장해 두고 계속 씀
export async function ensureVapid(storage) {
  let v = await storage.get("vapid");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    v = { priv, pub };
    await storage.put("vapid", v);
  }
  return v;
}

export async function vapidAuth(endpoint, vapid, subject, nowMs = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.pub}`;
}

// 내용 없는 알림 신호만 보냄 → 휴대폰이 받아서 서버에 "무슨 내용?" 하고 물어봄
export async function sendPush(endpoint, vapid, subject) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: await vapidAuth(endpoint, vapid, subject), TTL: "86400", Urgency: "normal" },
    body: "",
  });
  return r.status;
}

// 알림 서비스 주소만 허용 (구글·애플·모질라·마이크로소프트)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export function checkEndpoint(ep) {
  if (typeof ep !== "string" || ep.length > 1000) throw new Error("잘못된 구독 정보");
  let u;
  try { u = new URL(ep); } catch { throw new Error("잘못된 구독 정보"); }
  if (u.protocol !== "https:" || !PUSH_HOSTS.some(r => r.test(u.hostname))) throw new Error("지원하지 않는 알림 주소");
  return ep;
}

export function cleanRecord(body) {
  const endpoint = checkEndpoint(body && body.sub && body.sub.endpoint);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 300)
    .map(i => ({ name: String((i && i.name) || "").slice(0, 40), date: String((i && i.date) || "").slice(0, 10) }))
    .filter(i => i.name && /^\d{4}-\d{2}-\d{2}$/.test(i.date));
  let warnDays = Math.round(+body.warnDays);
  if (!(warnDays >= 0 && warnDays <= 30)) warnDays = 3;
  let tz = Math.round(+body.tz);
  if (!(tz >= -840 && tz <= 840)) tz = -540; // 기본: 한국 시간
  return { endpoint, items, warnDays, tz, updated: Date.now() };
}

export async function keyFor(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(endpoint));
  return "sub:" + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// tz = 휴대폰의 getTimezoneOffset() 값 (한국은 -540)
export function localYmd(nowMs, tz) {
  return new Date(nowMs - tz * 60000).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// 오늘 알려줄 내용 (없으면 null)
export function buildMessage(rec, nowMs) {
  const today = localYmd(nowMs, rec.tz);
  const soon = [], bad = [];
  for (const it of rec.items || []) {
    const d = daysBetween(today, it.date);
    if (isNaN(d)) continue;
    if (d < 0) { if (d >= -3) bad.push(it); } // 지난 음식은 3일까지만 알려줌
    else if (d <= rec.warnDays) soon.push({ ...it, d });
  }
  if (!soon.length && !bad.length) return null;
  soon.sort((a, b) => a.d - b.d);
  const more = (n, k) => (n > k ? ` 외 ${n - k}개` : "");
  const lines = [];
  if (soon.length) lines.push("⏰ " + soon.slice(0, 5).map(i => `${i.name}(${i.d === 0 ? "오늘까지" : "D-" + i.d})`).join(", ") + more(soon.length, 5));
  if (bad.length) lines.push("⚠️ 지남: " + bad.slice(0, 3).map(i => i.name).join(", ") + more(bad.length, 3));
  const title = soon.length ? `🧊 유통기한 임박 음식 ${soon.length}개` : `🧊 유통기한 지난 음식 ${bad.length}개`;
  return { title, body: lines.join("\n") };
}
