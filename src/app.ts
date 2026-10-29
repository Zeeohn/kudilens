// The conversation: one handler for every channel (Telegram, WhatsApp). Channels turn
// their updates into `Incoming` and render `Reply`; everything else happens here.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answer } from './agent.ts';
import { listen, readPage, readText, type Heard } from './extract.ts';
import { t, LANG_FOR_MODEL, LANG_NAMES, type Lang } from './i18n.ts';
import type { Ledger, StoredEntry, Trader } from './ledger.ts';
import { annotate, annotatePixels, sniffMime, toWav, wavSeconds } from './media.ts';
import { imagePart, MODELS, textPart, type Meta } from './meta.ts';
import { formatNaira, fromNaira, type Kobo } from './money.ts';
import { checkEntry, checkPayment, isDuplicate, matchCustomer, normalizeName, reconcileTotal, type Flag, type ProposedEntry, type TotalCheck } from './verify.ts';

export interface Button { id: string; title: string; url?: string }
export interface Reply { text?: string; photo?: Uint8Array; caption?: string; buttons?: Button[][] }
export type Send = (r: Reply) => Promise<void>;

export interface Incoming {
  channel: 'telegram' | 'whatsapp' | 'test';
  user: string;
  displayName?: string;
  type: 'text' | 'photo' | 'voice' | 'button';
  text?: string; // message text, caption, or button data
  file?: () => Promise<Uint8Array>;
}

interface State {
  onboarded: boolean;
  batch: string | null;
  repair: { index: number; to: Kobo } | null;
  awaiting: 'fix' | 'shelf' | null;
  lastActive: number;
}

export interface AppOptions {
  meta: Meta;
  ledger: Ledger;
  dataDir: string;
  publicUrl: string;
  /** Optional open-weight model (OpenAI-compatible) for summaries and reminders. */
  open?: { client: Meta; model: string } | null;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const KIND_ICON: Record<string, string> = { sale: '🛒', payment: '💵', expense: '💸', stock_in: '📦' };
const SHELF_WORDS = /\b(stock|shelf|count|goods|market|store|inventory)\b/i;
const MAX_UPLOAD = 20 * 1024 * 1024;

export class App {
  private readonly o: AppOptions;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly buckets = new Map<number, { tokens: number; at: number }>();

  constructor(o: AppOptions) {
    this.o = o;
    mkdirSync(join(o.dataDir, 'evidence'), { recursive: true });
  }

  get ledger(): Ledger { return this.o.ledger; }

  today(): string {
    return lagosDate(this.o.now?.() ?? new Date());
  }

  /** Messages from one trader run one at a time, so confirmations can't race. */
  handle(msg: Incoming, send: Send): Promise<void> {
    const key = `${msg.channel}:${msg.user}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.process(msg, send)).catch(async (err) => {
      this.log('error', { channel: msg.channel, type: msg.type, error: String(err?.stack ?? err).slice(0, 800) });
      const trader = this.o.ledger.trader(msg.channel, msg.user);
      await send({ text: t(trader.language, 'error') }).catch(() => {});
    });
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    return next;
  }

  private log(event: string, data: Record<string, unknown>) {
    this.o.log?.(event, data);
  }

  private state(traderId: number): State {
    return { onboarded: false, batch: null, repair: null, awaiting: null, lastActive: 0, ...this.o.ledger.getState<State>(traderId) };
  }

  private save(traderId: number, s: State) {
    this.o.ledger.setState(traderId, { ...s, lastActive: Date.now() });
  }

  /** Model calls cost money and the bot is public: 30 heavy actions per hour per trader. */
  private allow(traderId: number): boolean {
    const now = Date.now();
    const b = this.buckets.get(traderId) ?? { tokens: 30, at: now };
    b.tokens = Math.min(30, b.tokens + ((now - b.at) / 3_600_000) * 30);
    b.at = now;
    if (b.tokens < 1) { this.buckets.set(traderId, b); return false; }
    b.tokens -= 1;
    this.buckets.set(traderId, b);
    return true;
  }

  // ------------------------------------------------------------------ routing

  private async process(msg: Incoming, send: Send): Promise<void> {
    const ledger = this.o.ledger;
    let trader = ledger.trader(msg.channel, msg.user);
    if (!trader.name && msg.displayName) {
      ledger.updateTrader(trader.id, { name: msg.displayName.slice(0, 60) });
      trader = ledger.trader(msg.channel, msg.user);
    }
    const st = this.state(trader.id);
    const lang = trader.language;
    this.log('in', { channel: msg.channel, trader: trader.id, type: msg.type, text: msg.type === 'button' ? msg.text : undefined });

    if (!st.onboarded && msg.type !== 'button') {
      st.onboarded = true;
      this.save(trader.id, st);
      await send({ text: t(lang, 'welcome') });
      await send({ text: t(lang, 'pickLang'), buttons: langButtons() });
      if (msg.type === 'text' && isGreeting(msg.text ?? '')) return;
    }

    if (msg.type === 'button') return this.onButton(trader, st, msg.text ?? '', send);
    if (msg.type === 'photo') {
      if (!this.allow(trader.id)) return send({ text: '⏳ Slow down a little: try again in a few minutes.' });
      const shelf = st.awaiting === 'shelf' || SHELF_WORDS.test(msg.text ?? '');
      return shelf ? this.onShelf(trader, st, msg, send) : this.onPage(trader, st, msg, send);
    }
    if (msg.type === 'voice') {
      if (!this.allow(trader.id)) return send({ text: '⏳ Slow down a little: try again in a few minutes.' });
      return this.onVoice(trader, st, msg, send);
    }
    const text = (msg.text ?? '').trim();
    if (!text) return;
    if (text.startsWith('/') || isCommandWord(text)) return this.onCommand(trader, st, text, send);
    if (!this.allow(trader.id)) return send({ text: '⏳ Slow down a little: try again in a few minutes.' });
    if (this.pending(st)) return this.onFollowUp(trader, st, text, send, null);
    return this.onText(trader, st, text, send);
  }

  private async onCommand(trader: Trader, st: State, raw: string, send: Send): Promise<void> {
    const [cmd, ...rest] = raw.replace(/^\//, '').replace(/@\w+$/, '').split(/\s+/);
    const arg = rest.join(' ').trim();
    const lang = trader.language;
    switch (cmd.toLowerCase().replace(/@.*/, '')) {
      case 'start': case 'hi': case 'hello': case 'menu':
        await send({ text: t(lang, 'welcome') });
        return send({ text: t(lang, 'pickLang'), buttons: langButtons() });
      case 'help':
        return send({ text: t(lang, 'help') });
      case 'language': case 'lang':
        return send({ text: t(lang, 'pickLang'), buttons: langButtons() });
      case 'today':
        return this.sendSummary(trader, this.today(), this.today(), 'todayTitle', send);
      case 'week':
        return this.sendSummary(trader, addDays(this.today(), -6), this.today(), 'weekTitle', send);
      case 'debtors': case 'owe':
        return this.sendDebtors(trader, send);
      case 'passport': {
        const token = this.o.ledger.newPassport(trader.id);
        return send({ text: t(lang, 'passportReady', { url: `${this.o.publicUrl}/p/${token}` }) });
      }
      case 'passportoff':
        this.o.ledger.revokePassports(trader.id);
        return send({ text: t(lang, 'passportOff') });
      case 'stock':
        st.awaiting = 'shelf';
        this.save(trader.id, st);
        return send({ text: t(lang, 'stockPrompt') });
      case 'flyer':
        return this.sendFlyer(trader, send);
      case 'shop': case 'name':
        if (arg) this.o.ledger.updateTrader(trader.id, { business: arg.slice(0, 60) });
        return send({ text: arg ? `👍 ${arg.slice(0, 60)}` : 'Send: /shop <your shop name>' });
      case 'deleteme':
        return send({ text: t(lang, 'deleteAsk'), buttons: [[{ id: 'forget:yes', title: t(lang, 'deleteYes') }, { id: 'forget:no', title: t(lang, 'no') }]] });
      case 'confirm': case 'save':
        return st.batch ? this.confirmBatch(trader, st, st.batch, send) : send({ text: t(lang, 'nothingPending') });
      default:
        return send({ text: t(lang, 'help') });
    }
  }

  private async onButton(trader: Trader, st: State, data: string, send: Send): Promise<void> {
    const [kind, a, b] = data.split(':');
    const lang = trader.language;
    switch (kind) {
      case 'lang': {
        if (!(a in LANG_NAMES)) return;
        this.o.ledger.updateTrader(trader.id, { language: a });
        return send({ text: t(a, 'langSet') });
      }
      case 'ok':
        return this.confirmBatch(trader, st, a, send);
      case 'del':
        if (st.batch === a) {
          this.o.ledger.reject(this.o.ledger.batch(a).map((e) => e.id));
          this.save(trader.id, { ...st, batch: null, repair: null, awaiting: null });
        }
        return send({ text: t(lang, 'discarded') });
      case 'fix':
        if (st.batch !== a) return send({ text: t(lang, 'nothingPending') });
        this.save(trader.id, { ...st, awaiting: 'fix' });
        return send({ text: t(lang, 'fixHelp') });
      case 'rep': {
        if (st.batch !== a || !st.repair) return;
        const entries = this.o.ledger.batch(a);
        if (b === 'y') {
          const e = entries[st.repair.index];
          if (e && e.status === 'proposed') {
            const patch: Partial<ProposedEntry> = { amount: st.repair.to };
            if (e.quantity && e.unitPrice && Math.abs(e.quantity * e.unitPrice - e.amount) <= 100) patch.unitPrice = Math.round(st.repair.to / e.quantity);
            this.o.ledger.amend(e.id, patch);
            this.recheck(trader, a);
          }
        }
        this.save(trader.id, { ...st, repair: null });
        return this.sendProposal(trader, a, null, send);
      }
      case 'rem':
        return this.sendReminder(trader, a, send);
      case 'forget':
        if (a !== 'yes') return send({ text: '👍' });
        for (const p of this.o.ledger.forget(trader.id)) rmSync(p, { force: true });
        return send({ text: t('en', 'deleted') });
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ inputs

  private async storeEvidence(trader: Trader, kind: 'photo' | 'voice' | 'shelf' | 'text', bytes: Uint8Array, mime: string, meta: Record<string, unknown> = {}) {
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
    const r = this.o.ledger.addEvidence(trader.id, kind, bytes, { mime, meta });
    if (!r.duplicate && kind !== 'text') {
      const path = join(this.o.dataDir, 'evidence', `${r.evidence.id}.${ext}`);
      writeFileSync(path, bytes, { mode: 0o600 });
      this.o.ledger.db.prepare('UPDATE evidence SET path = ? WHERE id = ?').run(path, r.evidence.id);
    }
    return r;
  }

  private async onPage(trader: Trader, st: State, msg: Incoming, send: Send): Promise<void> {
    const lang = trader.language;
    const bytes = await msg.file!();
    if (bytes.length > MAX_UPLOAD) return send({ text: t(lang, 'tooBig') });
    const mime = sniffMime(bytes);
    const { evidence, duplicate } = await this.storeEvidence(trader, 'photo', bytes, mime);
    if (duplicate) return send({ text: t(lang, 'duplicatePhoto') });
    await send({ text: t(lang, 'reading') });
    const started = Date.now();
    const page = await readPage(this.o.meta, { bytes, mime }, { today: this.today(), customers: this.o.ledger.knownCustomers(trader.id) });
    this.log('page', { trader: trader.id, ms: Date.now() - started, lines: page.lines.length, isLedger: page.isLedger });
    if (!page.isLedger) {
      if (SHELF_WORDS.test(page.note)) return this.onShelf(trader, st, { ...msg, file: async () => bytes }, send);
      return send({ text: t(lang, 'notLedger') });
    }
    if (!page.lines.length) return send({ text: t(lang, 'nothingFound') });
    const total = reconcileTotal(page.lines, page.writtenTotal);
    const batch = this.buildBatch(trader, evidence.id, page.lines);
    const repair = total.status === 'repaired' && typeof total.repairs[0].target === 'number'
      ? { index: total.repairs[0].target, to: total.repairs[0].to } : null;
    this.save(trader.id, { ...st, batch, repair, awaiting: null });

    const entries = this.o.ledger.batch(batch);
    const marks = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.region)
      .map(({ e, i }) => ({ box: pad(e.region!), label: String(i + 1), ok: !e.flags.length && !(repair && repair.index === i) }));
    if (marks.length) {
      const img = await annotate(bytes, marks).catch(() => null);
      if (img) await send({ photo: img, caption: `${t(lang, 'page')} ${prettyDate(page.pageDate ?? this.today())} · ${entries.length} ${t(lang, 'lines')}` });
    }
    return this.sendProposal(trader, batch, total, send);
  }

  private async onVoice(trader: Trader, st: State, msg: Incoming, send: Send): Promise<void> {
    const lang = trader.language;
    const audio = await msg.file!();
    if (audio.length > MAX_UPLOAD) return send({ text: t(lang, 'tooBig') });
    await send({ text: t(lang, 'listening') });
    const wav = await toWav(audio);
    const seconds = wavSeconds(wav);
    const started = Date.now();
    // Routing: Muse Voice Transcribe is fast and cheap but has no Nigerian languages, so it
    // handles English speakers; everyone else goes straight to Muse Spark's native audio.
    let route = 'spark-audio';
    let heard: Heard | null = null;
    if (lang === 'en') {
      try {
        const asr = await this.o.meta.transcribe(wav, { languageBias: ['en'] });
        if (asr.transcript.trim().split(/\s+/).length >= 3) {
          heard = { transcript: asr.transcript, language: 'english', english: asr.transcript, model: MODELS.transcribe };
          route = 'voice-transcribe';
        }
      } catch (err) {
        this.log('asr_fallback', { error: String(err).slice(0, 200) });
      }
    }
    if (!heard) {
      heard = await listen(this.o.meta, wav, { seconds });
      route = `spark-audio:${heard.model}`;
    }
    this.log('voice', { trader: trader.id, route, seconds: Math.round(seconds), ms: Date.now() - started, language: heard.language, words: heard.transcript.split(/\s+/).filter(Boolean).length });
    if (!heard.transcript.trim()) return send({ text: t(lang, 'notHeard') });
    const { evidence } = await this.storeEvidence(trader, 'voice', audio, 'audio/ogg', { route, language: heard.language, transcript: heard.transcript });

    await send({ text: `🎙️ “${heard.transcript.slice(0, 600)}”${heard.language !== 'english' && heard.english ? `\n🇬🇧 ${heard.english.slice(0, 600)}` : ''}` });
    const text = heard.language === 'english' ? heard.transcript : `${heard.transcript}\n(English: ${heard.english})`;
    // A voice note while lines are waiting is about those lines (or adds to them), same as a typed one.
    if (this.pending(st)) return this.onFollowUp(trader, st, text, send, evidence.id);
    const result = await readText(this.o.meta, text, this.readOptions(trader));
    if (result.intent === 'question' || (!result.lines.length && result.question)) {
      return this.onQuestion(trader, result.question ?? result.english ?? result.transcript, send);
    }
    if (!result.lines.length) return send({ text: t(lang, 'nothingFound') });
    const batch = this.buildBatch(trader, evidence.id, result.lines);
    this.save(trader.id, { ...st, batch, repair: null, awaiting: null });
    return this.sendProposal(trader, batch, null, send);
  }

  /** New lines from a typed or spoken note. Lines still waiting for confirmation are kept: the new ones join them. */
  private async onText(trader: Trader, st: State, text: string, send: Send, evidenceId: string | null = null): Promise<void> {
    const r = await readText(this.o.meta, text, this.readOptions(trader));
    if (r.intent !== 'record' || !r.lines.length) return this.onQuestion(trader, text, send);
    evidenceId ??= (await this.storeEvidence(trader, 'text', new TextEncoder().encode(`${Date.now()}\n${text}`), 'text/plain', { text })).evidence.id;
    const open = this.pending(st);
    const batch = this.buildBatch(trader, evidenceId, r.lines, open);
    if (open) this.recheck(trader, open);
    this.save(trader.id, { ...st, batch, repair: open ? st.repair : null, awaiting: null });
    return this.sendProposal(trader, batch, null, send);
  }

  /** The unconfirmed batch, if it still has lines waiting. */
  private pending(st: State): string | null {
    return st.batch && this.o.ledger.batch(st.batch).some((e) => e.status === 'proposed') ? st.batch : null;
  }

  private async onQuestion(trader: Trader, question: string, send: Send): Promise<void> {
    await send({ text: t(trader.language, 'thinking') });
    const r = await answer(this.o.meta, this.o.ledger, trader.id, question, {
      today: this.today(), language: LANG_FOR_MODEL[trader.language as Lang] ?? 'English', business: trader.business,
    });
    this.log('agent', { trader: trader.id, tools: r.tools });
    return send({ text: r.text });
  }

  /**
   * A message (typed or spoken) while lines wait for confirmation: "line 2 is 6,500", "remove 4",
   * "Emeka own na 20,000, he go pay Friday" fill in or fix those lines; anything new is added to them.
   */
  private async onFollowUp(trader: Trader, st: State, text: string, send: Send, evidenceId: string | null): Promise<void> {
    const batch = st.batch!;
    const entries = this.o.ledger.batch(batch).filter((e) => e.status === 'proposed');
    const lines = entries.map((e, i) => ({ line: i + 1, kind: e.kind, item: e.item, quantity: e.quantity, unit: e.unit, unitPrice: e.unitPrice && e.unitPrice / 100, amount: e.amount / 100, paid: e.paid, amountPaid: e.amountPaid && e.amountPaid / 100, customer: e.customer, dueDate: e.dueDate, method: e.method, problems: e.flags.map((f) => f.message) }));
    const r = await this.o.meta.structured<{ action: 'edit' | 'add' | 'confirm' | 'cancel' | 'other'; edits: any[]; newText: string | null }>({
      name: 'corrections',
      effort: 'low',
      schema: CORRECTION_SCHEMA,
      system: `A trader has unsaved lines you proposed (amounts in naira) and sent a follow-up message, typed or spoken in English, Pidgin, Yoruba, Hausa or Igbo. Today is ${this.today()}.
- If it fixes or completes lines in the list (a missing amount, a wrong figure or name, a due date such as "she go pay Friday"), return those edits with action "edit". A line mentioned again with the missing detail is an EDIT of that line, never a new line. Use null for every field they did not change; give dates as YYYY-MM-DD. "remove"/"comot"/"delete" a line = remove true.
- If it also records NEW transactions that are not in the list, copy only the words about those into newText (otherwise null). Action is "add" when there are no edits.
- "save"/"it's fine"/"correct" = action "confirm"; cancel everything = "cancel"; a question or anything else = "other".`,
      parts: [textPart(`Unsaved lines:\n${JSON.stringify(lines)}\n\nTrader says: ${text}`)],
    });
    if (r.action === 'confirm') return this.confirmBatch(trader, st, batch, send);
    if (r.action === 'cancel') return this.onButton(trader, st, `del:${batch}`, send);
    if (r.action === 'other' || (!r.edits.length && !r.newText)) {
      this.save(trader.id, { ...st, awaiting: null });
      return this.onText(trader, { ...st, awaiting: null }, text, send, evidenceId);
    }
    for (const ed of r.edits) {
      const e = entries[ed.line - 1];
      if (!e) continue;
      if (ed.remove) { this.o.ledger.reject([e.id]); continue; }
      const patch: Partial<ProposedEntry> = {};
      for (const k of ['kind', 'item', 'unit', 'paid', 'customer', 'dueDate', 'method'] as const) if (ed[k] !== null && ed[k] !== undefined) (patch as any)[k] = ed[k];
      for (const k of ['amount', 'unitPrice', 'amountPaid'] as const) if (typeof ed[k] === 'number') patch[k] = fromNaira(ed[k]);
      if (typeof ed.quantity === 'number') patch.quantity = ed.quantity;
      if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
        const q = patch.quantity ?? e.quantity, p = patch.unitPrice ?? e.unitPrice;
        if (q && p && patch.amount === undefined) patch.amount = Math.round(q * p);
      }
      patch.confidence = 1; // the trader said so
      this.o.ledger.amend(e.id, patch);
    }
    if (r.newText?.trim()) {
      const added = await readText(this.o.meta, r.newText, this.readOptions(trader));
      if (added.lines.length) {
        evidenceId ??= (await this.storeEvidence(trader, 'text', new TextEncoder().encode(`${Date.now()}\n${text}`), 'text/plain', { text })).evidence.id;
        this.buildBatch(trader, evidenceId, added.lines, batch);
      }
    }
    this.recheck(trader, batch);
    this.save(trader.id, { ...st, awaiting: null, repair: null });
    return this.sendProposal(trader, batch, null, send);
  }

  // ------------------------------------------------------------------ proposals

  private readOptions(trader: Trader) {
    return {
      today: this.today(),
      customers: this.o.ledger.knownCustomers(trader.id),
      debtors: this.o.ledger.debtors(trader.id).map((d) => ({ name: d.name, owed: d.owed })),
    };
  }

  /** Match names to known customers, run every check, store the proposal. */
  private buildBatch(trader: Trader, evidenceId: string | null, lines: ProposedEntry[], into?: string | null): string {
    const known = this.o.ledger.knownCustomers(trader.id);
    const debtors = this.o.ledger.debtors(trader.id).map((d) => d.name);
    const fixed = lines.map((e) => {
      if (!e.customer) return e;
      // A payment names someone who owes, so a short form ("Tunde") can match the one debtor it fits.
      const m = matchCustomer(e.customer, known) ?? (e.kind === 'payment' ? matchShortName(e.customer, debtors) : null);
      return m ? { ...e, customer: m.name } : e;
    });
    const items = this.flagsFor(trader, fixed);
    return this.o.ledger.propose(trader.id, evidenceId, items, into ?? undefined)[0].batchId;
  }

  private flagsFor(trader: Trader, lines: ProposedEntry[]): { entry: ProposedEntry; flags: Flag[] }[] {
    const today = this.today();
    const pendingCredit = new Map<string, Kobo>();
    const confirmed = this.o.ledger.confirmed(trader.id);
    return lines.map((e) => {
      const flags = checkEntry(e, today);
      const key = normalizeName(e.customer ?? '');
      if (e.kind === 'payment') {
        flags.push(...checkPayment(e, this.o.ledger.outstanding(trader.id, e.customer ?? '') + (pendingCredit.get(key) ?? 0)));
      }
      if (e.kind === 'sale' && e.paid !== 'paid' && key) {
        pendingCredit.set(key, (pendingCredit.get(key) ?? 0) + e.amount - (e.amountPaid ?? 0));
      }
      if (isDuplicate(e, confirmed.filter((c) => c.date === e.date))) {
        flags.push({ code: 'duplicate', message: e.kind === 'payment' ? 'The same payment is already saved for today. Save only if this is a second payment.' : 'Looks like a line you already saved.' });
      }
      return { entry: e, flags };
    });
  }

  private recheck(trader: Trader, batchId: string) {
    const entries = this.o.ledger.batch(batchId).filter((e) => e.status === 'proposed');
    const flagged = this.flagsFor(trader, entries);
    entries.forEach((e, i) => this.o.ledger.setFlags(e.id, flagged[i].flags));
  }

  private async sendProposal(trader: Trader, batchId: string, total: TotalCheck | null, send: Send): Promise<void> {
    const lang = trader.language;
    const st = this.state(trader.id);
    const entries = this.o.ledger.batch(batchId).filter((e) => e.status === 'proposed');
    if (!entries.length) {
      this.save(trader.id, { ...st, batch: null, repair: null, awaiting: null });
      return send({ text: t(lang, 'discarded') });
    }
    const out: string[] = [];
    const owed = this.balancesAfter(trader, entries);
    entries.forEach((e, i) => {
      const warn = e.flags.length || (st.repair && st.repair.index === i);
      const after = e.kind === 'payment' && e.flags.every((f) => f.code === 'duplicate' || f.code === 'low_confidence') && owed[i] !== null
        ? ` · ${owed[i]! > 0 ? `${t(lang, 'stillOwes')} ${formatNaira(owed[i]!)}` : t(lang, 'fullyPaid')}` : '';
      out.push(`${i + 1}. ${warn ? '⚠️' : KIND_ICON[e.kind]} ${describe(e, lang)}${after}`);
      for (const f of e.flags.filter((f) => f.code !== 'low_confidence' || e.flags.length === 1)) out.push(`    ↳ ${f.message}`);
    });
    if (total) {
      const vars = { total: formatNaira(total.written ?? 0), written: formatNaira(total.written ?? 0), computed: formatNaira(total.computed) };
      if (total.status === 'match') out.push('', t(lang, total.basis === 'cash_received' ? 'totalCashMatches' : 'totalMatches', vars));
      else if (total.status === 'mismatch') out.push('', t(lang, 'totalMismatch', vars));
      else if (total.status === 'ambiguous') {
        const hints = total.repairs.filter((r) => typeof r.target === 'number').slice(0, 4)
          .map((r) => `${t(lang, 'line')} ${(r.target as number) + 1}: ${formatNaira(r.from)} → ${formatNaira(r.to)}?`);
        out.push('', t(lang, 'totalAmbiguous', vars), ...hints.map((h) => `   • ${h}`));
      }
      else if (total.status === 'repaired' && total.repairs[0].target === 'total') out.push('', t(lang, 'repairTotal', { from: formatNaira(total.repairs[0].from), to: formatNaira(total.repairs[0].to) }));
    }
    if (st.repair) {
      out.push('', t(lang, 'repairLine', { n: st.repair.index + 1, from: formatNaira(entries[st.repair.index]?.amount ?? 0), to: formatNaira(st.repair.to), total: formatNaira(total?.written ?? 0) }));
      return send({ text: out.join('\n'), buttons: [[{ id: `rep:${batchId}:y`, title: `${t(lang, 'yes')}, ${formatNaira(st.repair.to)}` }, { id: `rep:${batchId}:n`, title: t(lang, 'no') }]] });
    }
    if (entries.some((e) => e.flags.length)) out.push('', t(lang, 'needsCheck'));
    return send({
      text: out.join('\n'),
      buttons: [[{ id: `ok:${batchId}`, title: t(lang, 'confirmAll') }, { id: `fix:${batchId}`, title: t(lang, 'fix') }, { id: `del:${batchId}`, title: t(lang, 'discard') }]],
    });
  }

  /** What each customer will still owe after each line of a proposal (null when no customer is involved). */
  private balancesAfter(trader: Trader, entries: ProposedEntry[]): (Kobo | null)[] {
    const running = new Map<string, Kobo>();
    return entries.map((e) => {
      if (!e.customer || !(e.kind === 'payment' || (e.kind === 'sale' && e.paid !== 'paid'))) return null;
      const key = normalizeName(e.customer);
      const before = running.get(key) ?? this.o.ledger.outstanding(trader.id, e.customer);
      const after = e.kind === 'payment' ? before - e.amount : before + e.amount - (e.amountPaid ?? 0);
      running.set(key, after);
      return after;
    });
  }

  private async confirmBatch(trader: Trader, st: State, batchId: string, send: Send): Promise<void> {
    const lang = trader.language;
    if (!batchId || st.batch !== batchId) return send({ text: t(lang, 'nothingPending') });
    const entries = this.o.ledger.batch(batchId).filter((e) => e.status === 'proposed');
    const empty = entries.filter((e) => !(e.amount > 0));
    this.o.ledger.reject(empty.map((e) => e.id));
    const done = this.o.ledger.confirm(entries.filter((e) => e.amount > 0).map((e) => e.id));
    this.save(trader.id, { ...st, batch: null, repair: null, awaiting: null });
    const head = this.o.ledger.head(trader.id);
    this.log('confirm', { trader: trader.id, n: done.length });
    const s = this.o.ledger.summary(trader.id, this.today(), this.today());
    const quick = s.entries ? `\n${t(lang, 'sales')}: **${formatNaira(s.sales)}** · ${t(lang, 'collected')}: ${formatNaira(s.collected)} · ${t(lang, 'credit')}: ${formatNaira(s.creditGiven)}` : '';
    const paidBy = [...new Set(done.filter((e) => e.kind === 'payment' && e.customer).map((e) => e.customer!))];
    const debts = paidBy.map((name) => {
      const left = this.o.ledger.outstanding(trader.id, name);
      return `💵 ${name}: ${left > 0 ? `${t(lang, 'stillOwes')} **${formatNaira(left)}**` : t(lang, 'fullyPaid')}`;
    });
    return send({ text: t(lang, 'saved', { n: done.length, seq: head.seq, hash: head.hash.slice(0, 8) }) + quick + (debts.length ? `\n${debts.join('\n')}` : '') });
  }

  // ------------------------------------------------------------------ reports

  summaryText(trader: Trader, from: string, to: string, title: 'todayTitle' | 'weekTitle'): string | null {
    const lang = trader.language;
    const s = this.o.ledger.summary(trader.id, from, to);
    if (!s.entries) return null;
    const lines = [
      t(lang, title),
      `${t(lang, 'sales')}: **${formatNaira(s.sales)}**`,
      `${t(lang, 'collected')}: ${formatNaira(s.collected)}`,
      `${t(lang, 'credit')}: ${formatNaira(s.creditGiven)}`,
      `${t(lang, 'expenses')}: ${formatNaira(s.expenses)}`,
    ];
    if (s.stockBought) lines.push(`${t(lang, 'stockBought')}: ${formatNaira(s.stockBought)}`);
    lines.push(`${t(lang, 'net')}: **${formatNaira(s.net)}**`);
    if (s.topItems.length) lines.push(`${t(lang, 'top')}: ${s.topItems.slice(0, 3).map((i) => `${i.item} ${formatNaira(i.value)}`).join(' · ')}`);
    return lines.join('\n');
  }

  async sendSummary(trader: Trader, from: string, to: string, title: 'todayTitle' | 'weekTitle', send: Send): Promise<void> {
    const text = this.summaryText(trader, from, to, title);
    if (!text) return send({ text: t(trader.language, 'noEntries') });
    const tip = await this.tip(trader, text).catch(() => '');
    return send({ text: tip ? `${text}\n\n💡 ${tip}` : text });
  }

  /** One practical sentence about the numbers, in the trader's language (open-weight model when configured). */
  private async tip(trader: Trader, summary: string): Promise<string> {
    const debtors = this.o.ledger.debtors(trader.id).slice(0, 3).map((d) => `${d.name} ${formatNaira(d.owed)}${d.dueDate ? ` due ${d.dueDate}` : ''}`);
    const { client, model } = this.talker();
    const { message } = await client.chat({
      model,
      effort: client === this.o.meta ? 'minimal' : undefined,
      maxTokens: 2000,
      messages: [
        { role: 'system', content: `You are a friendly bookkeeper for a Nigerian market trader. Write ONE short practical sentence (max 25 words) in ${LANG_FOR_MODEL[trader.language as Lang] ?? 'English'} about these numbers: something to act on today. Do not repeat the numbers list. No financial or tax advice.` },
        { role: 'user', content: `${summary}\nLargest debts: ${debtors.join('; ') || 'none'}` },
      ],
    });
    return typeof message.content === 'string' ? message.content.trim().replace(/^["“]|["”]$/g, '') : '';
  }

  private talker(): { client: Meta; model: string } {
    return this.o.open ?? { client: this.o.meta, model: MODELS.reason };
  }

  private async sendDebtors(trader: Trader, send: Send): Promise<void> {
    const lang = trader.language;
    const list = this.o.ledger.debtors(trader.id);
    if (!list.length) return send({ text: t(lang, 'noDebtors') });
    const total = list.reduce((s, d) => s + d.owed, 0);
    const lines = list.slice(0, 15).map((d, i) => `${i + 1}. ${d.name}: **${formatNaira(d.owed)}**${d.dueDate ? ` · due ${prettyDate(d.dueDate)}` : d.since ? ` · since ${prettyDate(d.since)}` : ''}`);
    return send({
      text: `${t(lang, 'debtorsTitle')} (${formatNaira(total)})\n${lines.join('\n')}\n\n${t(lang, 'remindPick')}`,
      buttons: list.slice(0, 9).map((d) => [{ id: `rem:${d.key.slice(0, 50)}`, title: `🔔 ${d.name}`.slice(0, 24) }]),
    });
  }

  private async sendReminder(trader: Trader, key: string, send: Send): Promise<void> {
    const lang = trader.language;
    const d = this.o.ledger.debtors(trader.id).find((x) => x.key.slice(0, 50) === key);
    if (!d) return send({ text: t(lang, 'noDebtors') });
    const amount = formatNaira(d.owed);
    const { client, model } = this.talker();
    let text = '';
    try {
      const { message } = await client.chat({
        model, maxTokens: 2000, effort: client === this.o.meta ? 'minimal' : undefined,
        messages: [
          { role: 'system', content: `Write a short, warm, respectful payment reminder (max 45 words) that a Nigerian trader will forward to a customer on WhatsApp. Language: ${LANG_FOR_MODEL[lang as Lang] ?? 'English'}. Include the exact amount "${amount}" unchanged. No threats, no shaming. Sign off as ${trader.business ?? trader.name ?? 'your trader'}. Output only the message.` },
          { role: 'user', content: `Customer: ${d.name}. Owes: ${amount}.${d.dueDate ? ` Was due: ${d.dueDate}.` : ''}${d.since ? ` Since: ${d.since}.` : ''}` },
        ],
      });
      text = typeof message.content === 'string' ? message.content.trim() : '';
    } catch { /* fall back below */ }
    if (!text.includes(amount)) text = `Hello ${d.name}, this is a gentle reminder of the balance of ${amount} for your purchase. Thank you for your business! – ${trader.business ?? trader.name ?? ''}`.trim();
    return send({
      text: `${t(lang, 'reminderReady', { name: d.name })}\n\n${text}`,
      buttons: [[{ id: 'share', title: `📲 ${t(lang, 'shareWa')}`, url: `https://wa.me/?text=${encodeURIComponent(text)}` }]],
    });
  }

  // ------------------------------------------------------------------ stock and flyers

  /** Muse Spark names what is on the shelf; SAM 3.1 finds and counts every instance. */
  private async onShelf(trader: Trader, st: State, msg: Incoming, send: Send): Promise<void> {
    const lang = trader.language;
    const bytes = await msg.file!();
    if (bytes.length > MAX_UPLOAD) return send({ text: t(lang, 'tooBig') });
    const mime = sniffMime(bytes);
    this.save(trader.id, { ...st, awaiting: null });
    await send({ text: t(lang, 'counting') });
    const { evidence } = await this.storeEvidence(trader, 'shelf', bytes, mime);
    const listed = await this.o.meta.structured<{ items: { name: string; concept: string }[] }>({
      name: 'shelf_items',
      effort: 'low',
      schema: SHELF_SCHEMA,
      system: 'List the distinct kinds of goods for sale visible on this shop shelf (max 6, the most plentiful first). "name" is what a trader calls it (e.g. "Rice 50kg"). "concept" is a short visual noun phrase for an object detector that matches ONE unit of it (e.g. "bag of rice", "tin of tomato paste", "carton of noodles").',
      parts: [imagePart(bytes, mime), textPart('What goods are on this shelf?')],
    });
    const items = listed.items.slice(0, 6);
    if (!items.length) return send({ text: t(lang, 'stockNone') });
    const palette = ['0x16a34a', '0x2563eb', '0xf97316', '0xdb2777', '0x9333ea', '0x0891b2'];
    const counted = await Promise.all(items.map(async (it, i) => {
      const r = await this.o.meta.segment({ bytes, mime }, it.concept).catch(() => null);
      const boxes = (r?.boxes ?? []).filter((b) => (b.confidence ?? 1) >= 0.5);
      return { ...it, count: boxes.length, boxes, size: r ? { width: r.width, height: r.height } : null, color: palette[i] };
    }));
    const found = counted.filter((c) => c.count > 0);
    if (!found.length) return send({ text: t(lang, 'stockNone') });
    const lines = found.map((c) => {
      const prev = this.o.ledger.lastStockCount(trader.id, c.name);
      this.o.ledger.recordStockCount(trader.id, c.name, c.count, evidence.id);
      const delta = prev ? ` (was ${prev.count})` : '';
      return `${colorDot(c.color)} ${c.name}: **${c.count}**${delta}`;
    });
    const size = found.find((c) => c.size)?.size;
    const img = size ? await annotatePixels(bytes, found.flatMap((c) => c.boxes.map((b) => ({ ...b, color: c.color }))), size).catch(() => null) : null;
    this.log('shelf', { trader: trader.id, items: found.map((c) => [c.name, c.count]) });
    const text = `${t(lang, 'stockResult')}\n${lines.join('\n')}`;
    if (img) await send({ photo: img, caption: text });
    else await send({ text });
    return send({ text: '🎨 /flyer → WhatsApp status flyer' });
  }

  private async sendFlyer(trader: Trader, send: Send): Promise<void> {
    const lang = trader.language;
    const stock = this.o.ledger.stock(trader.id).filter((s) => s.count > 0);
    if (!stock.length) return send({ text: t(lang, 'flyerNeedsStock') });
    if (!this.allow(trader.id)) return send({ text: '⏳ Slow down a little: try again in a few minutes.' });
    await send({ text: t(lang, 'flyerMaking') });
    const prices = this.o.ledger.prices(trader.id);
    const list = stock.slice(0, 6).map((s) => {
      const p = [...prices.values()].find((x) => normalizeName(s.item).includes(normalizeName(x.item)) || normalizeName(x.item).includes(normalizeName(s.item)));
      return p ? `${s.item}: ${formatNaira(p.unitPrice)}` : s.item;
    });
    const shop = trader.business ?? trader.name ?? 'Our Shop';
    const prompt = `A bright, eye-catching vertical WhatsApp status flyer for a Nigerian provisions shop called "${shop}". Headline: "AVAILABLE TODAY". Clean bold text listing exactly these lines and nothing else:\n${list.map((l) => `• ${l}`).join('\n')}\nFooter: "Order now — chat me on WhatsApp". Warm market colours (green, yellow, orange), simple product illustrations, lots of contrast, text large and spelled exactly as given.`;
    const png = await this.o.meta.generateImage(prompt, '1024x1536');
    return send({ photo: png, caption: t(lang, 'flyerCaption') });
  }
}

// -------------------------------------------------------------------- helpers

const nul = (type: string) => ({ type: [type, 'null'] });

const CORRECTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action', 'edits', 'newText'],
  properties: {
    action: { type: 'string', enum: ['edit', 'add', 'confirm', 'cancel', 'other'] },
    newText: nul('string'),
    edits: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['line', 'remove', 'kind', 'item', 'quantity', 'unit', 'unitPrice', 'amount', 'paid', 'amountPaid', 'customer', 'dueDate', 'method'],
        properties: {
          line: { type: 'integer' }, remove: { type: 'boolean' },
          kind: { type: ['string', 'null'], enum: ['sale', 'expense', 'payment', 'stock_in', null] },
          item: nul('string'), quantity: nul('number'), unit: nul('string'), unitPrice: nul('number'), amount: nul('number'),
          paid: { type: ['string', 'null'], enum: ['paid', 'owed', 'partial', null] }, amountPaid: nul('number'),
          customer: nul('string'), dueDate: nul('string'),
          method: { type: ['string', 'null'], enum: ['cash', 'transfer', 'pos', 'unknown', null] },
        },
      },
    },
  },
};

const SHELF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'concept'], properties: { name: { type: 'string' }, concept: { type: 'string' } } } },
  },
};

function langButtons(): Button[][] {
  const b = (Object.keys(LANG_NAMES) as Lang[]).map((l) => ({ id: `lang:${l}`, title: LANG_NAMES[l] }));
  return [b.slice(0, 3), b.slice(3)];
}

function isGreeting(s: string): boolean {
  return /^(hi|hello|hey|good (morning|afternoon|evening)|start|menu|ẹ ku|bawo|sannu|kedu|how far)\b/i.test(s.trim());
}

function isCommandWord(s: string): boolean {
  return /^(help|today|week|debtors|passport|passportoff|stock|flyer|language|deleteme|menu|confirm|save)$/i.test(s.trim());
}

export function describe(e: StoredEntry | ProposedEntry, lang: string): string {
  const qty = e.quantity ? `${e.quantity}${e.unit ? ` ${e.unit}` : ''}` : '';
  const each = e.quantity && e.unitPrice ? ` × ${formatNaira(e.unitPrice)}` : '';
  const what = [e.item, qty + each].filter(Boolean).join(' ');
  const via = e.method === 'transfer' ? ' (transfer)' : e.method === 'pos' ? ' (POS)' : '';
  const due = e.dueDate ? ` · due ${prettyDate(e.dueDate)}` : '';
  switch (e.kind) {
    case 'sale':
      if (e.paid === 'owed') return `${e.customer ?? '?'} ${t(lang, 'owes')} · ${what} = **${formatNaira(e.amount)}**${due}`;
      if (e.paid === 'partial') return `${e.customer ?? '?'} · ${what} = **${formatNaira(e.amount)}** (${t(lang, 'paidPart')} ${formatNaira(e.amountPaid ?? 0)}, ${t(lang, 'balance')} ${formatNaira(e.amount - (e.amountPaid ?? 0))})${due}`;
      return `${what || 'Sale'} = **${formatNaira(e.amount)}**${via}`;
    case 'payment':
      return `${e.customer ?? '?'} ${t(lang, 'paidPart')} **${formatNaira(e.amount)}**${via}`;
    case 'expense':
      return `${e.item ?? 'Expense'} **${formatNaira(e.amount)}**`;
    case 'stock_in':
      return `${what || 'Stock'}${e.customer ? ` ← ${e.customer}` : ''} = **${formatNaira(e.amount)}**${e.paid === 'owed' ? ' (on credit)' : ''}`;
  }
}

/** Grow a model box by 2% on each side: handwriting runs past tight boxes. */
function pad(b: [number, number, number, number]): [number, number, number, number] {
  return [Math.max(0, b[0] - 20), Math.max(0, b[1] - 15), Math.min(1000, b[2] + 20), Math.min(1000, b[3] + 15)];
}

/** "Tunde" → "Mama Tunde" when exactly one debtor's name contains every word of it. */
export function matchShortName(name: string, candidates: string[]): { name: string; score: number } | null {
  const words = normalizeName(name).split(' ').filter(Boolean);
  if (!words.length) return null;
  const hits = candidates.filter((c) => {
    const have = normalizeName(c).split(' ');
    return words.every((w) => have.includes(w));
  });
  return hits.length === 1 ? { name: hits[0], score: 0.75 } : null;
}

function colorDot(hex: string): string {
  return ({ '0x16a34a': '🟩', '0x2563eb': '🟦', '0xf97316': '🟧', '0xdb2777': '🟥', '0x9333ea': '🟪', '0x0891b2': '⬜' } as Record<string, string>)[hex] ?? '▫️';
}

export function lagosDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(d);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
}

export function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
