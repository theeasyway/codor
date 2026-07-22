import { readFileSync } from 'node:fs';

import { parseRunItemPayload, type WireEvent } from '@codor/protocol';
import { describe, expect, it } from 'vitest';

import { createTurnTranslator } from './translate.js';

describe('Tura NDJSON translation', () => {
  it('maps a native run, its tool lifecycle, and exactly one terminal event', () => {
    const translator = createTurnTranslator();
    const events = readFileSync(new URL('../fixtures/native-run.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .flatMap((line) => translator.push(line));
    events.push(...translator.end({ status: 'completed' }));

    expect(translator.sessionId()).toBe('ses_tura');
    expect(events).toEqual([
      {
        type: 'run.item', item_type: 'tool_call',
        payload: {
          call_id: 'cmd_1', tool: 'command_run', title: 'Command run',
          input: { command_line: 'pwd' },
        },
      },
      {
        type: 'run.item', item_type: 'tool_result',
        payload: {
          call_id: 'cmd_1', status: 'ok', output_text: '/work',
          raw: { payload: { properties: { commandID: 'cmd_1', status: 'completed', command: 'command_run', output: '/work' } } },
        },
      },
      { type: 'run.completed', status: 'completed', final_text: 'PONG' },
    ]);
    for (const event of events) {
      if (event.type === 'run.item') {
        expect(parseRunItemPayload(event.item_type, event.payload).success).toBe(true);
      }
    }
  });

  it('fails cleanly for a native failure and ignores malformed or future records', () => {
    const translator = createTurnTranslator();
    expect(translator.push('not-json')).toEqual([]);
    expect(translator.push('{"type":"future"}')).toEqual([]);
    expect(translator.push('{"type":"cli.failed","sessionID":"ses_bad","error":"auth required"}'))
      .toEqual([{ type: 'run.completed', status: 'failed', final_text: 'auth required', error: 'auth required' }]);
    expect(translator.end({ status: 'failed' })).toEqual([]);
  });

  it('keeps a completed native turn whose session briefly errored (finalText present)', () => {
    // Tura's run surface reports `failed` with the finished answer in finalText when
    // the session momentarily reached `error` during the turn (a retried/cancelled
    // sub-call — routine on tool-heavy turns). The answer is the turn's real output,
    // so it must land as a completed turn, not a hard failure that blanks it and kills
    // the member.
    const translator = createTurnTranslator();
    expect(translator.push('{"type":"cli.completed","sessionID":"ses_soft","status":"failed","finalText":"the audit is complete"}'))
      .toEqual([{ type: 'run.completed', status: 'completed', final_text: 'the audit is complete' }]);
  });

  it('fails a native turn that ends failed with no produced answer', () => {
    const translator = createTurnTranslator();
    // With no produced answer, finish() mirrors the failure detail into final_text,
    // exactly as the cli.failed path does; the daemon blanks it for failed runs.
    expect(translator.push('{"type":"cli.completed","sessionID":"ses_empty","status":"failed"}'))
      .toEqual([{
        type: 'run.completed', status: 'failed',
        final_text: 'Tura ended the turn in a failed state without producing a response',
        error: 'Tura ended the turn in a failed state without producing a response',
      }]);
  });

  it('maps a timed-out turn to interrupted, preserving any partial answer', () => {
    const translator = createTurnTranslator();
    expect(translator.push('{"type":"cli.completed","sessionID":"ses_to","status":"timeout","finalText":"partial work"}'))
      .toEqual([{ type: 'run.completed', status: 'interrupted', final_text: 'partial work', error: 'Tura turn timed out' }]);
  });

  it('maps a permission-gated turn to interrupted rather than failed', () => {
    const translator = createTurnTranslator();
    expect(translator.push('{"type":"cli.completed","sessionID":"ses_perm","status":"permission_required","finalText":"needs approval to continue"}'))
      .toEqual([{ type: 'run.completed', status: 'interrupted', final_text: 'needs approval to continue', error: 'Tura turn paused awaiting permission' }]);
  });

  it('maps the current source runtime command payload without duplicate results', () => {
    const translator = createTurnTranslator();
    const ready = translator.push(JSON.stringify({
      type: 'command.updated', sessionID: 'ses_current', status: 'ready', raw: { payload: { properties: {
        commandID: 'cmd_current', status: 'ready', command: { command_type: 'zsh', command_line: '{"command":"pwd"}' },
      } } },
    }));
    const completed = translator.push(JSON.stringify({
      type: 'command.updated', sessionID: 'ses_current', status: 'completed', raw: { payload: { properties: {
        commandID: 'cmd_current', status: 'completed', command: { command_type: 'zsh', command_line: '{"command":"pwd"}' },
        result: { success: true, output: { stdout: '/work\\n', stderr: '' } },
      } } },
    }));
    const duplicate = translator.push(JSON.stringify({
      type: 'command.updated', sessionID: 'ses_current', status: 'completed', raw: { payload: { properties: {
        commandID: 'cmd_current', status: 'completed', command: { command_type: 'zsh', command_line: '{"command":"pwd"}' },
        result: { success: true, output: { stdout: '/work\\n', stderr: '' } },
      } } },
    }));

    expect(ready).toEqual([{ type: 'run.item', item_type: 'tool_call', payload: {
      call_id: 'cmd_current', tool: 'zsh', title: 'zsh', input: { command: 'pwd' },
    } }]);
    expect(completed).toEqual([{ type: 'run.item', item_type: 'tool_result', payload: {
      call_id: 'cmd_current', status: 'ok', output_text: '/work\\n',
      raw: expect.any(Object),
    } }]);
    expect(duplicate).toEqual([]);
  });

  it('normalizes an idle resumed command-run session', () => {
    const translator = createTurnTranslator();
    expect(translator.push(JSON.stringify({
      type: 'message.updated', sessionID: 'ses_resume', text: 'PONG', raw: { payload: { properties: {
        info: { role: 'assistant' },
      } } },
    }))).toEqual([]);
    expect(translator.push(JSON.stringify({
      type: 'session.status', sessionID: 'ses_resume', status: 'idle',
    }))).toEqual([{ type: 'run.completed', status: 'completed', final_text: 'PONG' }]);
  });

  it('ignores idle before a terminal turn event', () => {
    const translator = createTurnTranslator();
    expect(translator.push(JSON.stringify({
      type: 'session.status', sessionID: 'ses_resume', status: 'idle',
    }))).toEqual([]);
    expect(translator.push(JSON.stringify({
      type: 'message.part.delta', sessionID: 'ses_resume', text: 'ONG',
    }))).toEqual([]);
    expect(translator.push(JSON.stringify({
      type: 'session.status', sessionID: 'ses_resume', status: 'idle',
    }))).toEqual([]);
  });
});
