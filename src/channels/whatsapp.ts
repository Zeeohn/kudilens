// WhatsApp channel (Cloud API). Meta calls our webhook; every POST is checked against
// the app secret (X-Hub-Signature-256) before anything is read.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { App, Button, Incoming, Reply } from '../app.ts';

export interface WhatsAppConfig {
  token: string; // permanent system-user token or temporary test token
  phoneNumberId: string;
  verifyToken: string; // our own secret, typed into the Meta webhook settings
  appSecret: string;
  graphVersion?: string;
}

export class WhatsApp {
  private readonly c: WhatsAppConfig;
  private readonly app: App;
  private readonly log: (e: string, d: Record<string, unknown>) => void;
  private readonly seen = new Set<string>();
  private readonly graph: string;

  constructor(c: WhatsAppConfig, app: App, log: (e: string, d: Record<string, unknown>) => void = () => {}) {
    this.c = c;
    this.app = app;
    this.log = log;
    this.graph = `https://graph.facebook.com/${c.graphVersion ?? 'v23.0'}`;
  }

  /** GET handshake when the webhook is registered. Returns the challenge or null. */
  verify(query: URLSearchParams): string | null {
    return query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === this.c.verifyToken ? query.get('hub.challenge') : null;
  }

  validSignature(raw: Buffer, header: string | undefined): boolean {
    if (!header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', this.c.appSecret).update(raw).digest();
    const got = Buffer.from(header.slice(7), 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** Handle a verified webhook body. Returns at once; replies are sent asynchronously. */
  receive(body: any): void {
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value;
        if (v?.metadata?.phone_number_id && v.metadata.phone_number_id !== this.c.phoneNumberId) continue;
        const names = new Map<string, string>((v?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
        for (const m of v?.messages ?? []) {
          if (this.seen.has(m.id)) continue; // Meta retries deliveries
          this.seen.add(m.id);
          if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
          const msg = this.toIncoming(m, names.get(m.from));
          if (!msg) continue;
          void this.markRead(m.id);
          void this.app.handle(msg, (r) => this.send(m.from, r));
        }
      }
    }
  }

  private toIncoming(m: any, name?: string): Incoming | null {
    const base = { channel: 'whatsapp' as const, user: String(m.from), displayName: name };
    switch (m.type) {
      case 'text': return { ...base, type: 'text', text: m.text?.body ?? '' };
      case 'image': return { ...base, type: 'photo', text: m.image?.caption ?? '', file: () => this.download(m.image.id) };
      case 'document':
        if (/^image\//.test(m.document?.mime_type ?? '')) return { ...base, type: 'photo', text: m.document.caption ?? '', file: () => this.download(m.document.id) };
        return null;
      case 'audio': return { ...base, type: 'voice', file: () => this.download(m.audio.id) };
      case 'interactive': {
        const id = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
        return id ? { ...base, type: 'button', text: id } : null;
      }
      case 'button': return { ...base, type: 'text', text: m.button?.text ?? '' };
      default: return null;
    }
  }

  private async api(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${this.graph}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.c.token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`whatsapp ${path}: HTTP ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
    return json;
  }

  private async download(mediaId: string): Promise<Uint8Array> {
    const meta = await this.api(mediaId, { method: 'GET' });
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${this.c.token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`whatsapp media ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private markRead(id: string) {
    return this.api(`${this.c.phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: id }),
    }).catch(() => {});
  }

  private message(to: string, payload: object) {
    return this.api(`${this.c.phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });
  }

  async send(to: string, r: Reply): Promise<void> {
    if (r.photo) {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', 'image/jpeg');
      form.append('file', new Blob([r.photo], { type: 'image/jpeg' }), 'kudilens.jpg');
      const media = await this.api(`${this.c.phoneNumberId}/media`, { method: 'POST', body: form });
      await this.message(to, { type: 'image', image: { id: media.id, caption: r.caption ? wa(r.caption).slice(0, 1024) : undefined } });
    }
    if (!r.text) return;
    const text = wa(r.text);
    const buttons = (r.buttons ?? []).flat();
    const link = buttons.find((b) => b.url);
    const replies = buttons.filter((b) => !b.url);
    if (link) {
      await this.message(to, { type: 'text', text: { body: text.slice(0, 4096), preview_url: false } });
      return void await this.message(to, {
        type: 'interactive',
        interactive: { type: 'cta_url', body: { text: '👇' }, action: { name: 'cta_url', parameters: { display_text: link.title.slice(0, 20), url: link.url } } },
      });
    }
    if (!replies.length) return void await this.message(to, { type: 'text', text: { body: text.slice(0, 4096), preview_url: false } });
    if (replies.length <= 3 && text.length <= 1024) {
      return void await this.message(to, {
        type: 'interactive',
        interactive: { type: 'button', body: { text }, action: { buttons: replies.map((b) => ({ type: 'reply', reply: { id: b.id, title: short(b.title, 20) } })) } },
      });
    }
    // More than three choices, or a long body: send the text, then a list of choices.
    let body = text;
    if (text.length > 1024) {
      await this.message(to, { type: 'text', text: { body: text.slice(0, 4096), preview_url: false } });
      body = '👇';
    }
    await this.message(to, {
      type: 'interactive',
      interactive: {
        type: replies.length <= 3 ? 'button' : 'list',
        body: { text: body },
        action: replies.length <= 3
          ? { buttons: replies.map((b) => ({ type: 'reply', reply: { id: b.id, title: short(b.title, 20) } })) }
          : { button: 'Choose', sections: [{ title: 'Options', rows: replies.slice(0, 10).map((b) => ({ id: b.id, title: short(b.title, 24) })) }] },
      },
    });
  }
}

/** Our light markup (**bold**) → WhatsApp (*bold*). */
export function wa(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/gs, '*$1*');
}

function short(s: string, n: number): string {
  return [...s].length <= n ? s : [...s].slice(0, n - 1).join('') + '…';
}

export type { Button };
