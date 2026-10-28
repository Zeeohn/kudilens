import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meta, outputText, parseSam } from '../src/meta.ts';

test('parses SAM 3.1 output (example from the Meta docs)', () => {
  const line = '<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~abc|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,~x,y|>,2<|box;x1=516;y1=117;x2=536;y2=150;w=537;h=561|><|mask;x=0;y=0;data=34,21,~...|>';
  const r = parseSam(line);
  assert.equal(r.width, 537);
  assert.equal(r.height, 561);
  assert.deepEqual(r.boxes.map((b) => b.id), [0, 1, 2]);
  assert.deepEqual(r.boxes[1], { id: 1, x1: 260, y1: 382, x2: 340, y2: 427, confidence: null });
});

test('reads SAM confidence and handles zero matches', () => {
  const r = parseSam('<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!...|>');
  assert.equal(r.boxes[0].confidence, 0.9609375);
  assert.deepEqual(parseSam('').boxes, []);
});

test('outputText reads both response shapes', () => {
  assert.equal(outputText({ output_text: 'a' }), 'a');
  assert.equal(outputText({ output: [{ content: [{ type: 'output_text', text: 'b' }, { text: 'c' }] }] }), 'bc');
});

test('retries on 429 and sends the bearer key', async () => {
  let calls = 0;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer k');
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const m = new Meta({ apiKey: 'k', fetchImpl: fakeFetch });
  const out = await m.structured<{ ok: boolean }>({ system: 's', parts: [{ type: 'text', text: 'x' }], name: 'n', schema: {} });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);
});

test('does not retry client errors', async () => {
  let calls = 0;
  const fakeFetch = (async () => { calls++; return new Response('bad', { status: 400 }); }) as typeof fetch;
  const m = new Meta({ apiKey: 'k', fetchImpl: fakeFetch });
  await assert.rejects(m.chat({ messages: [] }), /HTTP 400/);
  assert.equal(calls, 1);
});
