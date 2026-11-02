// The trader's books: SQLite, double entry, and a hash chain over confirmed entries.
// Models never write here directly. Extraction proposes entries; the trader confirms;
// only then does code post them, with balanced postings and a chained hash.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kobo } from './money.ts';
import { normalizeName, type Flag, type ProposedEntry } from './verify.ts';

export type EvidenceKind = 'photo' | 'voice' | 'text' | 'shelf';
export type EntryStatus = 'proposed' | 'confirmed' | 'rejected';

export interface Trader {
  id: number;
  channel: string;
  channelUser: string;
  name: string | null;
  business: string | null;
  language: string;
}

export interface Evidence {
  id: string;
  traderId: number;
  kind: EvidenceKind;
  sha256: string;
  path: string | null;
  mime: string | null;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface StoredEntry extends ProposedEntry {
  id: string;
  traderId: number;
  evidenceId: string | null;
  batchId: string;
  flags: Flag[];
  status: EntryStatus;
  seq: number | null;
  prevHash: string | null;
  hash: string | null;
  createdAt: number;
  confirmedAt: number | null;
}

export interface Posting { account: string; amount: Kobo } // debit > 0, credit < 0

export interface ChainCheck {
  ok: boolean;
  length: number;
  head: string;
  brokenAt: number | null;
  intact: number; // records verified before the break (all of them when ok)
  reason: 'changed' | 'missing' | null;
  record: { seq: number; date: string | null; kind: string; item: string | null; amount: Kobo } | null;
}

export const GENESIS = '0'.repeat(64);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traders (
  id INTEGER PRIMARY KEY, channel TEXT NOT NULL, channel_user TEXT NOT NULL,
  name TEXT, business TEXT, language TEXT NOT NULL DEFAULT 'en', created_at INTEGER NOT NULL,
  UNIQUE (channel, channel_user));
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, trader_id INTEGER NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL,
  path TEXT, mime TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
  UNIQUE (trader_id, sha256));
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY, trader_id INTEGER NOT NULL, batch_id TEXT NOT NULL, evidence_id TEXT,
  data TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  seq INTEGER, prev_hash TEXT, hash TEXT, created_at INTEGER NOT NULL, confirmed_at INTEGER,
  UNIQUE (trader_id, seq));
CREATE INDEX IF NOT EXISTS entries_batch ON entries (batch_id);
CREATE TABLE IF NOT EXISTS postings (
  entry_id TEXT NOT NULL, trader_id INTEGER NOT NULL, account TEXT NOT NULL, amount INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS postings_account ON postings (trader_id, account);
CREATE TABLE IF NOT EXISTS stock_counts (
  trader_id INTEGER NOT NULL, item TEXT NOT NULL, count INTEGER NOT NULL,
  evidence_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS state (trader_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS passports (
  token TEXT PRIMARY KEY, trader_id INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
`;

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------------ traders

  trader(channel: string, channelUser: string): Trader {
    this.db.prepare('INSERT OR IGNORE INTO traders (channel, channel_user, created_at) VALUES (?, ?, ?)')
      .run(channel, channelUser, Date.now());
    const r = this.db.prepare('SELECT * FROM traders WHERE channel = ? AND channel_user = ?').get(channel, channelUser) as any;
    return { id: r.id, channel: r.channel, channelUser: r.channel_user, name: r.name, business: r.business, language: r.language };
  }

  updateTrader(id: number, patch: Partial<Pick<Trader, 'name' | 'business' | 'language'>>): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) this.db.prepare(`UPDATE traders SET ${k} = ? WHERE id = ?`).run(v, id);
    }
  }

  // ------------------------------------------------------------------ evidence

  /** Store a source file's fingerprint. The same bytes twice returns the existing record. */
  addEvidence(traderId: number, kind: EvidenceKind, bytes: Uint8Array, opts: { path?: string; mime?: string; meta?: Record<string, unknown> } = {}): { evidence: Evidence; duplicate: boolean } {
    const sha256 = sha(bytes);
    const existing = this.db.prepare('SELECT * FROM evidence WHERE trader_id = ? AND sha256 = ?').get(traderId, sha256) as any;
    if (existing) return { evidence: rowToEvidence(existing), duplicate: true };
    const id = randomUUID();
    this.db.prepare('INSERT INTO evidence (id, trader_id, kind, sha256, path, mime, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, traderId, kind, sha256, opts.path ?? null, opts.mime ?? null, JSON.stringify(opts.meta ?? {}), Date.now());
    return { evidence: this.evidence(id)!, duplicate: false };
  }

  evidence(id: string): Evidence | null {
    const r = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as any;
    return r ? rowToEvidence(r) : null;
  }

  // ------------------------------------------------------------------ entries

  /** Store proposed entries in a new batch, or add them to an unconfirmed one. */
  propose(traderId: number, evidenceId: string | null, items: { entry: ProposedEntry; flags: Flag[] }[], batchId: string = randomUUID()): StoredEntry[] {
    const now = Date.now();
    const stmt = this.db.prepare('INSERT INTO entries (id, trader_id, batch_id, evidence_id, data, flags, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const { entry, flags } of items) {
      stmt.run(randomUUID(), traderId, batchId, evidenceId, JSON.stringify(entry), JSON.stringify(flags), 'proposed', now);
    }
    return this.batch(batchId);
  }

  batch(batchId: string): StoredEntry[] {
    return (this.db.prepare('SELECT * FROM entries WHERE batch_id = ? ORDER BY rowid').all(batchId) as any[]).map(rowToEntry);
  }

  entry(id: string): StoredEntry | null {
    const r = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as any;
    return r ? rowToEntry(r) : null;
  }

  /** Correct a proposed entry before it is confirmed (confirmed entries are immutable). */
  amend(id: string, patch: Partial<ProposedEntry>): StoredEntry {
    const e = this.entry(id);
    if (!e) throw new Error(`no entry ${id}`);
    if (e.status !== 'proposed') throw new Error('only proposed entries can be changed');
    const data = { ...pickProposed(e), ...patch };
    this.db.prepare('UPDATE entries SET data = ?, flags = ? WHERE id = ?').run(JSON.stringify(data), '[]', id);
    return this.entry(id)!;
  }

  /** Replace the checks recorded on a proposed entry (after the trader corrects it). */
  setFlags(id: string, flags: Flag[]): void {
    this.db.prepare("UPDATE entries SET flags = ? WHERE id = ? AND status = 'proposed'").run(JSON.stringify(flags), id);
  }

  reject(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE entries SET status = 'rejected' WHERE id = ? AND status = 'proposed'");
    for (const id of ids) stmt.run(id);
  }

  /**
   * Confirm entries: post balanced double-entry lines and extend the trader's hash chain.
   * Runs in one transaction so the chain and the postings can't diverge.
   */
  confirm(ids: string[]): StoredEntry[] {
    const done: StoredEntry[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        const e = this.entry(id);
        if (!e || e.status !== 'proposed') continue;
        const head = this.head(e.traderId);
        const seq = head.seq + 1;
        const evidenceSha = e.evidenceId ? this.evidence(e.evidenceId)?.sha256 ?? null : null;
        const hash = chainHash(head.hash, seq, pickProposed(e), evidenceSha);
        const lines = postingsFor(e);
        if (lines.reduce((s, p) => s + p.amount, 0) !== 0) throw new Error(`unbalanced postings for ${id}`);
        const ins = this.db.prepare('INSERT INTO postings (entry_id, trader_id, account, amount) VALUES (?, ?, ?, ?)');
        for (const p of lines) ins.run(id, e.traderId, p.account, p.amount);
        this.db.prepare("UPDATE entries SET status = 'confirmed', seq = ?, prev_hash = ?, hash = ?, confirmed_at = ? WHERE id = ?")
          .run(seq, head.hash, hash, Date.now(), id);
        done.push(this.entry(id)!);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return done;
  }

  head(traderId: number): { seq: number; hash: string } {
    const r = this.db.prepare("SELECT seq, hash FROM entries WHERE trader_id = ? AND status = 'confirmed' ORDER BY seq DESC LIMIT 1").get(traderId) as any;
    return r ? { seq: r.seq, hash: r.hash } : { seq: 0, hash: GENESIS };
  }

  confirmed(traderId: number, from?: string, to?: string): StoredEntry[] {
    const rows = this.db.prepare("SELECT * FROM entries WHERE trader_id = ? AND status = 'confirmed' ORDER BY seq").all(traderId) as any[];
    return rows.map(rowToEntry).filter((e) => (!from || (e.date ?? '') >= from) && (!to || (e.date ?? '') <= to));
  }

  /**
   * Recompute the whole chain. Any edit to an entry or its evidence fingerprint breaks it.
   * On a break, `reason` says whether the record itself no longer matches its seal ('changed')
   * or a record before it was removed, added or reordered ('missing'), and `record` describes
   * the broken record as it reads now (no customer name: this goes to lenders).
   */
  verifyChain(traderId: number): ChainCheck {
    let prev = GENESIS;
    const entries = this.confirmed(traderId);
    for (const [i, e] of entries.entries()) {
      const evidenceSha = e.evidenceId ? this.evidence(e.evidenceId)?.sha256 ?? null : null;
      const expected = chainHash(prev, e.seq!, pickProposed(e), evidenceSha);
      const linked = e.seq === i + 1 && e.prevHash === prev;
      if (!linked || e.hash !== expected) {
        return {
          ok: false, length: entries.length, head: prev, brokenAt: e.seq, intact: i,
          reason: linked ? 'changed' : 'missing',
          record: { seq: e.seq!, date: e.date, kind: e.kind, item: e.item, amount: e.amount },
        };
      }
      prev = e.hash!;
    }
    return { ok: true, length: entries.length, head: prev, brokenAt: null, intact: entries.length, reason: null, record: null };
  }

  // ------------------------------------------------------------------ balances

  balance(traderId: number, account: string): Kobo {
    const r = this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM postings WHERE trader_id = ? AND account = ?').get(traderId, account) as any;
    return Number(r.s);
  }

  /** Customers who owe money, largest first, with the name as last written. */
  debtors(traderId: number): { key: string; name: string; owed: Kobo; dueDate: string | null; since: string | null }[] {
    const rows = this.db.prepare("SELECT account, SUM(amount) AS owed FROM postings WHERE trader_id = ? AND account LIKE 'receivable:%' GROUP BY account HAVING owed > 0 ORDER BY owed DESC, account").all(traderId) as any[];
    const entries = this.confirmed(traderId);
    return rows.map((r) => {
      const key = r.account.slice('receivable:'.length);
      const theirs = entries.filter((e) => e.customer && normalizeName(e.customer) === key);
      const credit = theirs.filter((e) => e.kind === 'sale' && e.paid !== 'paid');
      return {
        key,
        name: theirs.at(-1)?.customer ?? key,
        owed: Number(r.owed),
        dueDate: credit.map((e) => e.dueDate).filter(Boolean).sort().at(-1) ?? null,
        since: credit.map((e) => e.date).filter(Boolean).sort()[0] ?? null,
      };
    });
  }

  outstanding(traderId: number, customer: string): Kobo {
    return this.balance(traderId, `receivable:${normalizeName(customer)}`);
  }

  knownCustomers(traderId: number): string[] {
    const names = new Map<string, string>();
    for (const e of this.confirmed(traderId)) if (e.customer) names.set(normalizeName(e.customer), e.customer);
    return [...names.values()];
  }

  /** Sales, spending and stock for a period (dates inclusive, YYYY-MM-DD). */
  summary(traderId: number, from: string, to: string) {
    const entries = this.confirmed(traderId, from, to);
    const sum = (f: (e: StoredEntry) => boolean, v: (e: StoredEntry) => Kobo = (e) => e.amount) =>
      entries.filter(f).reduce((s, e) => s + v(e), 0);
    const sales = sum((e) => e.kind === 'sale');
    const collected = sum((e) => e.kind === 'sale', cashPart) + sum((e) => e.kind === 'payment');
    const expenses = sum((e) => e.kind === 'expense');
    const stockBought = sum((e) => e.kind === 'stock_in');
    const byItem = new Map<string, { item: string; value: Kobo; quantity: number }>();
    for (const e of entries.filter((x) => x.kind === 'sale' && x.item)) {
      const k = normalizeName(e.item!);
      const cur = byItem.get(k) ?? { item: e.item!, value: 0, quantity: 0 };
      cur.value += e.amount;
      cur.quantity += e.quantity ?? 0;
      byItem.set(k, cur);
    }
    return {
      from, to, entries: entries.length, sales, collected, expenses, stockBought,
      net: sales - expenses - stockBought,
      creditGiven: sum((e) => e.kind === 'sale', (e) => e.amount - cashPart(e)),
      topItems: [...byItem.values()].sort((a, b) => b.value - a.value).slice(0, 5),
    };
  }

  // ------------------------------------------------------------------ stock

  recordStockCount(traderId: number, item: string, count: number, evidenceId: string): void {
    this.db.prepare('INSERT INTO stock_counts (trader_id, item, count, evidence_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(traderId, item, count, evidenceId, Date.now());
  }

  lastStockCount(traderId: number, item: string): { count: number; at: number } | null {
    const r = this.db.prepare('SELECT count, created_at FROM stock_counts WHERE trader_id = ? AND item = ? ORDER BY created_at DESC LIMIT 1').get(traderId, item) as any;
    return r ? { count: r.count, at: r.created_at } : null;
  }

  /** The latest count of every item. */
  stock(traderId: number): { item: string; count: number; at: number }[] {
    return (this.db.prepare('SELECT item, count, MAX(created_at) AS at FROM stock_counts WHERE trader_id = ? GROUP BY item ORDER BY item').all(traderId) as any[])
      .map((r) => ({ item: r.item, count: r.count, at: r.at }));
  }

  /** Latest unit price per item from confirmed sales, for flyers and the agent. */
  prices(traderId: number): Map<string, { item: string; unit: string | null; unitPrice: Kobo }> {
    const out = new Map<string, { item: string; unit: string | null; unitPrice: Kobo }>();
    for (const e of this.confirmed(traderId)) {
      if (e.kind === 'sale' && e.item && e.unitPrice) out.set(normalizeName(e.item), { item: e.item, unit: e.unit, unitPrice: e.unitPrice });
    }
    return out;
  }

  // ------------------------------------------------------------------ conversation state and passports

  getState<T extends object>(traderId: number): Partial<T> {
    const r = this.db.prepare('SELECT data FROM state WHERE trader_id = ?').get(traderId) as any;
    return r ? JSON.parse(r.data) : {};
  }

  setState(traderId: number, data: object): void {
    this.db.prepare('INSERT INTO state (trader_id, data) VALUES (?, ?) ON CONFLICT (trader_id) DO UPDATE SET data = excluded.data')
      .run(traderId, JSON.stringify(data));
  }

  /** A shareable lender link. Creating a new one revokes the old ones. */
  newPassport(traderId: number): string {
    this.db.prepare('UPDATE passports SET revoked = 1 WHERE trader_id = ?').run(traderId);
    const token = randomBytes(12).toString('base64url');
    this.db.prepare('INSERT INTO passports (token, trader_id, created_at) VALUES (?, ?, ?)').run(token, traderId, Date.now());
    return token;
  }

  revokePassports(traderId: number): void {
    this.db.prepare('UPDATE passports SET revoked = 1 WHERE trader_id = ?').run(traderId);
  }

  passportTrader(token: string): Trader | null {
    const r = this.db.prepare('SELECT t.* FROM passports p JOIN traders t ON t.id = p.trader_id WHERE p.token = ? AND p.revoked = 0').get(token) as any;
    return r ? { id: r.id, channel: r.channel, channelUser: r.channel_user, name: r.name, business: r.business, language: r.language } : null;
  }

  traders(): Trader[] {
    return (this.db.prepare('SELECT * FROM traders').all() as any[])
      .map((r) => ({ id: r.id, channel: r.channel, channelUser: r.channel_user, name: r.name, business: r.business, language: r.language }));
  }

  /** Erase everything about a trader (their right to be forgotten). Returns evidence file paths to delete. */
  /**
   * Remove evidence that turned out not to be business records (a selfie, a random photo).
   * Refuses if any entry or stock count uses it. Returns the file path to delete, if any.
   */
  dropEvidence(id: string): string | null {
    const used = this.db.prepare('SELECT 1 FROM entries WHERE evidence_id = ? UNION SELECT 1 FROM stock_counts WHERE evidence_id = ? LIMIT 1').get(id, id);
    if (used) return null;
    const r = this.db.prepare('SELECT path FROM evidence WHERE id = ?').get(id) as any;
    this.db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
    return r?.path ?? null;
  }

  forget(traderId: number): string[] {
    const paths = (this.db.prepare('SELECT path FROM evidence WHERE trader_id = ? AND path IS NOT NULL').all(traderId) as any[]).map((r) => r.path as string);
    for (const t of ['postings', 'entries', 'evidence', 'stock_counts', 'state', 'passports']) {
      this.db.prepare(`DELETE FROM ${t} WHERE trader_id = ?`).run(traderId);
    }
    this.db.prepare('DELETE FROM traders WHERE id = ?').run(traderId);
    return paths;
  }
}

// -------------------------------------------------------------------- posting rules

function moneyAccount(e: ProposedEntry): string {
  return e.method === 'transfer' || e.method === 'pos' ? 'bank' : 'cash';
}

function cashPart(e: ProposedEntry): Kobo {
  return e.paid === 'paid' ? e.amount : e.paid === 'partial' ? e.amountPaid ?? 0 : 0;
}

/** Deterministic double entry for each kind of trader transaction. Always sums to zero. */
export function postingsFor(e: ProposedEntry): Posting[] {
  const party = normalizeName(e.customer ?? 'unknown') || 'unknown';
  const money = moneyAccount(e);
  switch (e.kind) {
    case 'sale': {
      const paid = cashPart(e);
      const lines: Posting[] = [{ account: 'revenue', amount: -e.amount }];
      if (paid) lines.push({ account: money, amount: paid });
      if (e.amount - paid) lines.push({ account: `receivable:${party}`, amount: e.amount - paid });
      return lines;
    }
    case 'payment':
      return [{ account: money, amount: e.amount }, { account: `receivable:${party}`, amount: -e.amount }];
    case 'expense':
      return [{ account: `expense:${normalizeName(e.item ?? 'general') || 'general'}`, amount: e.amount }, { account: money, amount: -e.amount }];
    case 'stock_in': {
      const paid = cashPart(e);
      const lines: Posting[] = [{ account: 'inventory', amount: e.amount }];
      if (paid) lines.push({ account: money, amount: -paid });
      if (e.amount - paid) lines.push({ account: `payable:${party}`, amount: -(e.amount - paid) });
      return lines;
    }
  }
}

// -------------------------------------------------------------------- hashing

export function chainHash(prev: string, seq: number, e: ProposedEntry, evidenceSha: string | null): string {
  const canonical = JSON.stringify([
    seq, e.date, e.kind, e.item, e.quantity, e.unit, e.unitPrice, e.amount, e.paid, e.amountPaid,
    e.method, e.customer, e.dueDate, e.rawText, evidenceSha,
  ]);
  return sha(`${prev}\n${canonical}`);
}

function sha(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const PROPOSED_KEYS = ['kind', 'date', 'item', 'quantity', 'unit', 'unitPrice', 'amount', 'paid', 'amountPaid', 'method', 'customer', 'dueDate', 'rawText', 'region', 'confidence'] as const;

function pickProposed(e: ProposedEntry): ProposedEntry {
  return Object.fromEntries(PROPOSED_KEYS.map((k) => [k, e[k]])) as unknown as ProposedEntry;
}

function rowToEntry(r: any): StoredEntry {
  return {
    ...(JSON.parse(r.data) as ProposedEntry),
    id: r.id, traderId: r.trader_id, evidenceId: r.evidence_id, batchId: r.batch_id,
    flags: JSON.parse(r.flags), status: r.status, seq: r.seq, prevHash: r.prev_hash, hash: r.hash,
    createdAt: r.created_at, confirmedAt: r.confirmed_at,
  };
}

function rowToEvidence(r: any): Evidence {
  return { id: r.id, traderId: r.trader_id, kind: r.kind, sha256: r.sha256, path: r.path, mime: r.mime, meta: JSON.parse(r.meta), createdAt: r.created_at };
}
