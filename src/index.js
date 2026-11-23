import { DurableObject } from "cloudflare:workers";
import { ensureVapid, sendPush, checkEndpoint, cleanRecord, keyFor, buildMessage } from "./logic.js";

const SUBJECT = "https://fridge-alarm.eke413eke413.workers.dev";

// 알림 받는 사람 목록을 저장하는 곳
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.vapid = await ensureVapid(ctx.storage); });
  }
  pub() { return this.vapid.pub; }
  async save(rec) {
    const k = await keyFor(rec.endpoint);
    const old = await this.ctx.storage.get(k);
    if (old && old.test) rec.test = true;
    await this.ctx.storage.put(k, rec);
  }
  async remove(endpoint) { await this.ctx.storage.delete(await keyFor(endpoint)); }
  async message(endpoint) {
    const k = await keyFor(endpoint);
    const rec = await this.ctx.storage.get(k);
    if (!rec) return null;
    const msg = buildMessage(rec, Date.now());
    if (rec.test) {
      rec.test = false;
      await this.ctx.storage.put(k, rec);
      return { title: "🔔 알림 테스트 성공!", body: msg ? msg.body : "앱을 닫아도 매일 아침 이렇게 알려드려요." };
    }
    return msg;
  }
  async test(endpoint) {
    const k = await keyFor(endpoint);
    const rec = await this.ctx.storage.get(k);
    if (!rec) return 404;
    rec.test = true;
    await this.ctx.storage.put(k, rec);
    return sendPush(endpoint, this.vapid, SUBJECT);
  }
  async daily() {
    const all = await this.ctx.storage.list({ prefix: "sub:" });
    let sent = 0;
    for (const [k, rec] of all) {
      if (!buildMessage(rec, Date.now())) continue;
      try {
        const s = await sendPush(rec.endpoint, this.vapid, SUBJECT);
        if (s === 404 || s === 410) await this.ctx.storage.delete(k); // 앱을 지운 사람
        else if (s < 300) sent++;
      } catch (e) {}
    }
    return sent;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const store = env.STORE.get(env.STORE.idFromName("main"));
    try {
      if (url.pathname === "/api/vapid") return json({ key: await store.pub() });
      if (req.method !== "POST") return json({ error: "POST만 돼요" }, 405);
      const body = await req.json();
      switch (url.pathname) {
        case "/api/subscribe": await store.save(cleanRecord(body)); return json({ ok: true });
        case "/api/unsubscribe": await store.remove(checkEndpoint(body.endpoint)); return json({ ok: true });
        case "/api/message": return json((await store.message(checkEndpoint(body.endpoint))) || {});
        case "/api/test": return json({ status: await store.test(checkEndpoint(body.endpoint)) });
      }
      return json({ error: "없는 주소" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 400);
    }
  },
  // 매일 한국 시간 아침 9시 (UTC 0시)
  async scheduled(event, env, ctx) {
    const store = env.STORE.get(env.STORE.idFromName("main"));
    ctx.waitUntil(store.daily());
  },
};
