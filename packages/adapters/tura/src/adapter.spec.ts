import {
  chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { TuraAdapter, turaArgs } from './adapter.js';

const dirs: string[] = [];

function executable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-tura-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-tura');
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

function waitFor(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = (): void => {
      if (existsSync(path)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Tura subprocess and capability conformance', () => {
  it('passes source-CLI arguments, model, resume token, cwd, and no stdin', async () => {
    const command = executable(`
const fs = require('node:fs');
const detail = JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8'),projectRoot:process.env.TURA_PROJECT_ROOT});
console.log(JSON.stringify({type:'cli.started',sessionID:'ses_existing'}));
console.log(JSON.stringify({type:'cli.completed',sessionID:'ses_existing',status:'completed',finalText:detail}));
`);
    const adapter = new TuraAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-tura-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('ses_existing');
    session.cwd = cwd;
    session.model = 'openai/gpt-5.6-sol';
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(JSON.parse(done.final_text!)).toEqual({
      argv: ['--cwd', cwd, 'run', '--zsh', '--output', 'ndjson', '--agent-id', 'balanced', '--session-type', 'coding', '--timeout', '86400', '--model', 'openai/gpt-5.6-sol', '--session', 'ses_existing', 'PONG'],
      cwd: realpathSync(cwd),
      input: '',
      projectRoot: undefined,
    });
    expect(session.session_ref).toBe('ses_existing');
  });

  it('rejects unverified policy and thinking claims', () => {
    const adapter = new TuraAdapter('/fake/tura');
    expect(() => adapter.spawn({ cwd: '/work', policy: 'anything' })).toThrow('valid policies');
    expect(() => adapter.spawn({ cwd: '/work', thinking: 'ultra' })).toThrow('valid levels: low, medium, high, xhigh, max');
    expect(adapter.capabilities.policies).toEqual({
      'read-only': null, 'workspace-write': null, 'full-access': null,
    });
  });

  it('turns a missing binary and a nonzero exit into failed runs', async () => {
    const events: WireEvent[] = [];
    for await (const event of new TuraAdapter('/definitely/missing/tura').deliver(
      { harness: 'tura', cwd: process.cwd() }, 'hello',
    )) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable(`
console.log(JSON.stringify({type:'message.updated', sessionID:'ses_failed', text:'partial answer', raw:{payload:{properties:{info:{role:'assistant'}}}}}));
process.stderr.write('native failure\\n');
process.exit(7);
`);
    const failed: WireEvent[] = [];
    for await (const event of new TuraAdapter(command).deliver(
      { harness: 'tura', cwd: process.cwd() }, 'hello',
    )) failed.push(event);
    expect(failed.at(-1)).toMatchObject({
      type: 'run.completed', status: 'failed', final_text: 'partial answer', error: 'native failure',
    });
  });

  it('lets Tura exit cleanly after its terminal event instead of killing its session checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-tura-clean-exit-'));
    dirs.push(dir);
    const checkpoint = join(dir, 'checkpoint');
    const command = executable(`
const fs = require('node:fs');
console.log(JSON.stringify({type:'cli.completed',sessionID:'ses_clean',status:'completed',finalText:'done'}));
setTimeout(() => fs.writeFileSync(process.env.TURA_CHECKPOINT, 'clean'), 25);
`);
    const session = new TuraAdapter(command).spawn({ cwd: dir });
    session.env = { TURA_CHECKPOINT: checkpoint };
    const events: WireEvent[] = [];
    for await (const event of new TuraAdapter(command).deliver(session, 'finish')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed', final_text: 'done' });
    expect(readFileSync(checkpoint, 'utf8')).toBe('clean');
  });

  it('reaps a Tura process that emits its terminal result, checkpoints, then never exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-tura-hang-'));
    dirs.push(dir);
    const checkpoint = join(dir, 'checkpoint');
    // Valid terminal result, a checkpoint written shortly after (native
    // session cleanup), then the process deliberately hangs forever.
    const command = executable(`
const fs = require('node:fs');
console.log(JSON.stringify({type:'cli.completed',sessionID:'ses_hang',status:'completed',finalText:'answer stays'}));
setTimeout(() => fs.writeFileSync(process.env.TURA_CHECKPOINT, 'late'), 50);
setInterval(() => {}, 1000);
`);
    // Short injected grace keeps the test fast while still outlasting the 50ms
    // checkpoint write.
    const session = new TuraAdapter(command, 250).spawn({ cwd: dir });
    session.env = { TURA_CHECKPOINT: checkpoint };
    const started = Date.now();
    const events: WireEvent[] = [];
    for await (const event of new TuraAdapter(command, 250).deliver(session, 'finish')) events.push(event);
    const elapsed = Date.now() - started;
    // The iterator must finish on its own — the whole point of the fix.
    expect(elapsed).toBeLessThan(2_000);
    // Grace must outlast the checkpoint write, not race it.
    expect(readFileSync(checkpoint, 'utf8')).toBe('late');
    // The already-emitted completed turn and its text survive the reap.
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed', status: 'completed', final_text: 'answer stays',
    });
  });

  it('reaps a halted Tura process that goes silent with no terminal event (inactivity)', async () => {
    // Emits some activity, then goes silent forever without exiting or emitting a
    // terminal event — a halted agent. The inactivity timer must reap it and end the
    // turn interrupted in bounded time.
    const command = executable(`
console.log(JSON.stringify({type:'cli.started',sessionID:'ses_stall'}));
console.log(JSON.stringify({type:'command.updated',sessionID:'ses_stall',raw:{payload:{properties:{commandID:'c1',status:'running',command:{command_type:'zsh',command_line:'{}'}}}}}));
setInterval(() => {}, 1000);
`);
    const started = Date.now();
    const events: WireEvent[] = [];
    // Short injected inactivity grace so the test is fast; default terminal grace.
    for await (const event of new TuraAdapter(command, undefined, 250).deliver(
      { harness: 'tura', cwd: process.cwd() }, 'go',
    )) events.push(event);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(done).toMatchObject({ type: 'run.completed', status: 'interrupted' });
    expect(done.error).toMatch(/stalled/i);
  });

  it('does not stall-reap a Tura process that keeps emitting activity', async () => {
    // Emits immediately, then a line every 100ms, then completes — each gap stays
    // under the 600ms inactivity grace, so it must finish completed, never
    // stall-reaped. (Grace is comfortably above Node's process-startup latency so the
    // first line always arrives in time.)
    const command = executable(`
console.log(JSON.stringify({type:'cli.started',sessionID:'ses_live'}));
let n = 0;
const t = setInterval(() => {
  n++;
  console.log(JSON.stringify({type:'message.part.delta',sessionID:'ses_live',text:'.'}));
  if (n >= 5) { clearInterval(t); console.log(JSON.stringify({type:'cli.completed',sessionID:'ses_live',status:'completed',finalText:'done'})); }
}, 100);
`);
    const events: WireEvent[] = [];
    for await (const event of new TuraAdapter(command, undefined, 600).deliver(
      { harness: 'tura', cwd: process.cwd() }, 'go',
    )) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed', final_text: 'done' });
  });

  it('discovers root sessions through Tura session list JSON', () => {
    const command = executable(`
const expected = ['--json','session','list','--all'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);
console.log(JSON.stringify([{id:'ses_first'},{id:'ses_second'},{title:'missing id'}]));
`);
    expect(new TuraAdapter(command).discoverSessions()).toEqual(['ses_first', 'ses_second']);
  });

  it('reports the source gateway configured coding models', async () => {
    const command = executable(`
const expected = ['--json','config','model-tiers'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);
console.log(JSON.stringify({tiers:[
  {tier:'thinking',options:[{provider:'codex',model:'gpt-5.6-sol'},{provider:'openai',model:'gpt-5.6-sol'}]},
  {tier:'fast',options:[{provider:'codex',model:'gpt-5.6-luna'},{provider:'codex',model:'gpt-5.6-sol'}]},
  {tier:'embedding_high',options:[{provider:'openai',model:'text-embedding-3-large'}]},
]}));
`);
    await expect(new TuraAdapter(command).listModels()).resolves.toEqual({
      models: ['codex/gpt-5.6-sol', 'openai/gpt-5.6-sol', 'codex/gpt-5.6-luna'],
      source: 'discovered',
    });
  });

  it('asks Tura to abort the native session before force-stopping the local process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-tura-abort-'));
    dirs.push(dir);
    const output = join(dir, 'abort.json');
    const command = executable(`
const fs = require('node:fs');
if (process.argv.includes('abort')) { fs.writeFileSync(process.env.TURA_ABORT_OUT, JSON.stringify(process.argv.slice(2))); process.exit(0); }
console.log(JSON.stringify({type:'cli.started',sessionID:'ses_abort'}));
console.log(JSON.stringify({type:'command.updated',sessionID:'ses_abort',raw:{payload:{properties:{commandID:'cmd_abort',status:'ready',command:{command_type:'zsh',command_line:'{}'}}}}}));
setInterval(() => {}, 1000);
`);
    const adapter = new TuraAdapter(command);
    const session = adapter.spawn({ cwd: dir });
    session.env = { TURA_ABORT_OUT: output };
    const iterator = adapter.deliver(session, 'wait')[Symbol.asyncIterator]();
    await iterator.next();
    adapter.interrupt(session);
    await waitFor(output);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['--cwd', dir, '--json', 'session', 'abort', 'ses_abort']);
    await iterator.return?.();
  });

  it('rejects interaction responses because Tura run has no response channel', async () => {
    await expect(new TuraAdapter().respondInteraction()).rejects.toThrow('no response channel');
  });
});

describe('Tura argv construction', () => {
  it('keeps policy out of argv until a real Tura mapping is verified', () => {
    const base = { harness: 'tura', cwd: '/work' };
    expect(turaArgs({ ...base, policy: 'read-only' }, 'go'))
      .toEqual(turaArgs({ ...base, policy: 'workspace-write' }, 'go'));
  });

  it('maps Codor thinking effort to Tura model variants', () => {
    expect(turaArgs({ harness: 'tura', cwd: '/work', thinking: 'max' }, 'go'))
      .toContain('--model-variant');
    expect(turaArgs({ harness: 'tura', cwd: '/work', thinking: 'max' }, 'go'))
      .toContain('max');
  });
});
