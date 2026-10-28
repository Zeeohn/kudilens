// Telegram channel: long polling (outbound only, no webhook to secure), inline buttons.

import type { App, Button, Incoming, Reply } from '../app.ts';

const API = 'https://api.telegram.org';

export class Telegram {
  private readonly token: string;
  private readonly app: App;
  private readonly log: (e: string, d: Record<string, unknown>) => void;
  private offset = 0;
  private stopped = false;
  private readonly longData = new Map<string, string>(); // callback_data is capped at 64 bytes
  private nextShort = 0;

  constructor(token: string, app: App, log: (e: string, d: Record<string, unknown>) => void = () => {}) {
    this.token = token;
    this.app = app;
    this.log = log;
  }

  private async call(method: string, body?: object | FormData): Promise<any> {
    const init: RequestInit = body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) };
    const res = await fetch(`${API}/bot${this.token}/${method}`, { ...init, signal: AbortSignal.timeout(70_000) });
    const json = (await res.json()) as any;
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async start(): Promise<void> {
    await this.call('setMyCommands', {
      commands: [
        ['today', "Today's sales and spending"], ['week', 'Last 7 days'], ['debtors', 'Who owes you + reminders'],
        ['stock', 'Count stock from a shelf photo'], ['flyer', 'WhatsApp status flyer'], ['passport', 'Share verified records with a lender'],
        ['language', 'English, Pidgin, Yorùbá, Hausa, Igbo'], ['help', 'What I can do'], ['deleteme', 'Erase all your data'],
      ].map(([command, description]) => ({ command, description })),
    }).catch((e) => this.log('tg_commands', { error: String(e) }));
    while (!this.stopped) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          void this.dispatch(u);
        }
      } catch (err) {
        this.log('tg_poll', { error: String(err).slice(0, 200) });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() { this.stopped = true; }

  private async dispatch(u: any): Promise<void> {
    let msg: Incoming | null = null;
    let chatId: number;
    if (u.callback_query) {
      const q = u.callback_query;
      chatId = q.message?.chat?.id ?? q.from.id;
      void this.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      if (q.message && !String(q.data).startsWith('lang:')) {
        void this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      const data = this.longData.get(q.data) ?? q.data;
      msg = { channel: 'telegram', user: String(q.from.id), displayName: q.from.first_name, type: 'button', text: data };
    } else if (u.message) {
      const m = u.message;
      chatId = m.chat.id;
      if (m.chat.type !== 'private') return; // books are personal: private chats only
      const base = { channel: 'telegram' as const, user: String(m.from.id), displayName: m.from.first_name };
      const doc = m.document && /^image\//.test(m.document.mime_type ?? '') ? m.document : null;
      const audioDoc = m.document && /^audio\//.test(m.document.mime_type ?? '') ? m.document : null;
      if (m.photo?.length || doc) {
        const fileId = doc ? doc.file_id : m.photo.at(-1).file_id;
        msg = { ...base, type: 'photo', text: m.caption ?? '', file: () => this.download(fileId) };
      } else if (m.voice || m.audio || audioDoc) {
        const fileId = (m.voice ?? m.audio ?? audioDoc).file_id;
        msg = { ...base, type: 'voice', text: m.caption ?? '', file: () => this.download(fileId) };
      } else if (typeof m.text === 'string') {
        msg = { ...base, type: 'text', text: m.text };
      }
    } else {
      return;
    }
    if (!msg) return;
    const typing = msg.type === 'photo' ? 'upload_photo' : 'typing';
    void this.call('sendChatAction', { chat_id: chatId!, action: typing }).catch(() => {});
    await this.app.handle(msg, (r) => this.send(chatId, r));
  }

  private async download(fileId: string): Promise<Uint8Array> {
    const f = await this.call('getFile', { file_id: fileId });
    const res = await fetch(`${API}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`telegram download ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async send(chatId: number | string, r: Reply): Promise<void> {
    const reply_markup = r.buttons?.length ? { inline_keyboard: r.buttons.map((row) => row.map((b) => this.button(b))) } : undefined;
    if (r.photo) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', new Blob([r.photo], { type: 'image/jpeg' }), 'kudilens.jpg');
      if (r.caption) { form.append('caption', html(r.caption).slice(0, 1024)); form.append('parse_mode', 'HTML'); }
      if (reply_markup && !r.text) form.append('reply_markup', JSON.stringify(reply_markup));
      await this.call('sendPhoto', form);
      if (!r.text) return;
    }
    if (r.text) {
      const parts = chunks(html(r.text), 4000);
      for (let i = 0; i < parts.length; i++) {
        await this.call('sendMessage', {
          chat_id: chatId, text: parts[i], parse_mode: 'HTML', link_preview_options: { is_disabled: true },
          reply_markup: i === parts.length - 1 ? reply_markup : undefined,
        });
      }
    }
  }

  private button(b: Button): object {
    if (b.url) return { text: b.title, url: b.url };
    let data = b.id;
    if (Buffer.byteLength(data) > 64) {
      const short = `x:${(this.nextShort++).toString(36)}`;
      this.longData.set(short, data);
      data = short;
    }
    return { text: b.title, callback_data: data };
  }
}

/** Our light markup (**bold**) → Telegram HTML, escaping everything else. */
export function html(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
}

function chunks(s: string, n: number): string[] {
  if (s.length <= n) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > n) {
    const cut = rest.lastIndexOf('\n', n) > n / 2 ? rest.lastIndexOf('\n', n) : n;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
