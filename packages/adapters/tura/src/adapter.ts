import { type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';

import type {
  AdapterTurnHooks,
  HarnessAdapter,
  ModelCatalog,
  Session,
  SessionRef,
  SpawnOpts,
  ThinkingLevel,
  WireEvent,
} from '@codor/protocol';
import { PolicySchema, ThinkingLevelSchema } from '@codor/protocol';

import { createTurnTranslator } from './translate.js';

const ABORT_GRACE_MS = 5_000;
// Once the translator emits a terminal `run.completed`, the turn is done from
// Codor's perspective. Tura sometimes lingers past that point finishing native
// session/checkpoint cleanup and, occasionally, never exits — leaving stdout
// open so the deliver() iterator (and the member) hangs `running`. Give that
// cleanup a short grace, then reap the detached process group so the iterator
// finishes and Codor persists the already-emitted completed turn.
const TURA_TERMINAL_GRACE_MS = 3_000;
// Inactivity (stall) timeout: the primary halt detector. Reset on every line of
// stream output, so a healthy turn — which keeps emitting tool calls, deltas, and
// status events as it works — never trips it no matter how long it runs. Only an
// agent that has genuinely HALTED (a serious error stops it emitting anything) goes
// silent this long, at which point the process group is reaped and the turn ends
// interrupted. This is unrelated to total run length by construction; the single
// caveat is a long silent tool call (a build/test emits nothing until it finishes),
// so this must exceed the longest legitimately-silent operation inside a turn.
const TURA_STALL_GRACE_MS = 10 * 60 * 1_000;
// A catastrophic backstop ONLY — deliberately unrelated to expected run length.
// Real turns can legitimately run for hours, so this must never act as a length
// limit (Tura's 10-minute default did, and would guillotine a healthy long turn).
// Hangs are caught by signal, not the clock: the session.status:error short-circuit
// in the translator ends the common hang the moment Tura reports it, and the
// post-terminal reaper handles a child that lingers after a terminal event. This
// ceiling exists solely so a truly wedged process (no terminal signal ever) cannot
// live forever; a run approaching it is pathological, and the operator can Stop sooner.
const TURA_TURN_TIMEOUT_SECONDS = 24 * 60 * 60;

/** Tura forwards these native variants to its selected provider. */
export const TURA_THINKING_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ThinkingLevel[];

function missingBinary(): Error {
  return new Error('Tura adapter needs CODOR_TURA_BIN set to the pinned source-built tura binary');
}

function commandFor(command: string | undefined): string {
  if (!command) throw missingBinary();
  return command;
}

function turaEnv(sessionEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...sessionEnv };
  delete env.TURA_PROJECT_ROOT;
  return env;
}

function assertThinkingLevel(thinking: ThinkingLevel | undefined): void {
  if (thinking === undefined) return;
  if (!(TURA_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(
      `adapter 'tura' does not support thinking level '${thinking}'; ` +
      `valid levels: ${TURA_THINKING_LEVELS.join(', ')}`,
    );
  }
}

export function turaArgs(session: Session, payload: string): string[] {
  const args = [
    '--cwd', session.cwd,
    'run',
    // Tura's plain run surface can complete the model turn then return a
    // non-zero runtime status. The gateway-owned command-run surface is the
    // proven headless contract used by Wheel's source wrappers.
    '--zsh',
    '--output', 'ndjson',
    '--agent-id', process.env.CODOR_TURA_AGENT_ID ?? 'balanced',
    '--session-type', 'coding',
    '--timeout', String(TURA_TURN_TIMEOUT_SECONDS),
  ];
  if (session.model !== undefined) args.push('--model', session.model);
  if (session.thinking !== undefined) {
    ThinkingLevelSchema.parse(session.thinking);
    assertThinkingLevel(session.thinking);
    args.push('--model-variant', session.thinking);
  }
  if (session.session_ref !== undefined) args.push('--session', session.session_ref);
  args.push(payload);
  return args;
}

function turaCatalogModels(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) throw new Error('Tura returned an invalid model catalog');
  const tiers = (value as { tiers?: unknown }).tiers;
  if (!Array.isArray(tiers)) throw new Error('Tura returned an invalid model catalog');
  const models = new Set<string>();
  for (const tier of tiers) {
    if (typeof tier !== 'object' || tier === null) continue;
    const { tier: name, options } = tier as { tier?: unknown; options?: unknown };
    if ((name !== 'fast' && name !== 'thinking') || !Array.isArray(options)) continue;
    for (const option of options) {
      if (typeof option !== 'object' || option === null) continue;
      const { provider, model } = option as { provider?: unknown; model?: unknown };
      if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
        models.add(`${provider}/${model}`);
      }
    }
  }
  if (models.size === 0) throw new Error('Tura listed no coding models');
  return [...models];
}

/** A CLI adapter for the source-built Tura release, configured through CODOR_TURA_BIN. */
export class TuraAdapter implements HarnessAdapter {
  readonly id = 'tura';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'runtime',
    extensions: false,
    thinking: true,
    thinking_levels: TURA_THINKING_LEVELS,
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': null,
    },
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();

  constructor(
    private readonly command = process.env.CODOR_TURA_BIN,
    private readonly terminalGraceMs = TURA_TERMINAL_GRACE_MS,
    private readonly stallGraceMs = TURA_STALL_GRACE_MS,
  ) {}

  spawn(opts: SpawnOpts): Session {
    if (opts.policy !== undefined && !PolicySchema.safeParse(opts.policy).success) {
      throw new Error(`unknown policy '${opts.policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
    }
    if (opts.thinking !== undefined) {
      ThinkingLevelSchema.parse(opts.thinking);
      assertThinkingLevel(opts.thinking);
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      thinking: opts.thinking,
    };
  }

  /** Reads the source Tura gateway's configured fast and thinking model choices. */
  async listModels(): Promise<ModelCatalog> {
    const command = commandFor(this.command);
    const result = spawn.sync(command, ['--json', 'config', 'model-tiers'], {
      timeout: 5_000,
      maxBuffer: 1_000_000,
      encoding: 'utf8',
      env: turaEnv(),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Command failed: ${command} --json config model-tiers`);
    return { models: turaCatalogModels(JSON.parse(result.stdout)), source: 'discovered' };
  }

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    let command: string;
    try {
      command = commandFor(this.command);
    } catch (error) {
      yield { type: 'run.completed', status: 'failed', error: String(error), final_text: String(error) };
      return;
    }
    const child = spawn(command, turaArgs(session, payload), {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: turaEnv(session.env),
    });
    this.children.set(session, child);

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    let childError: Error | undefined;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        childError = error;
        reject(error);
      });
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
    );

    const translator = createTurnTranslator();
    let reportedSessionRef: string | undefined;
    const reportSessionRef = (): void => {
      const discovered = translator.sessionId();
      if (discovered === undefined || discovered === reportedSessionRef) return;
      session.session_ref = discovered;
      reportedSessionRef = discovered;
      hooks.onSessionRef?.(discovered);
    };

    // Armed once the translator reports the turn semantically complete. Reaps
    // the process group if Tura's post-terminal cleanup never lets stdout close
    // on its own. Not armed for tool-completion or early idle events — only a
    // real `run.completed` from the translator counts.
    let terminalReaper: ReturnType<typeof setTimeout> | undefined;
    const armTerminalReaper = (): void => {
      if (terminalReaper !== undefined) return;
      terminalReaper = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
      }, this.terminalGraceMs);
      terminalReaper.unref?.();
    };
    void closed.then(() => { if (terminalReaper !== undefined) clearTimeout(terminalReaper); });

    // Inactivity (stall) timer — the primary halt detector. Reset on every stream
    // line; if the agent goes silent for the whole grace it has halted (a serious
    // error stopped it emitting anything), so reap the process group and finalize the
    // turn as interrupted. A healthy long run keeps emitting activity that resets
    // this, so it never limits run length.
    let stalled = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpInactivity = (): void => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        stalled = true;
        if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
      }, this.stallGraceMs);
      inactivityTimer.unref?.();
    };
    void closed.then(() => { if (inactivityTimer !== undefined) clearTimeout(inactivityTimer); });

    try {
      try {
        await spawned;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield* translator.end({ status: 'failed', error: detail });
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });
      bumpInactivity();
      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        bumpInactivity();
        for (const event of translator.push(line)) {
          reportSessionRef();
          yield event;
          if (event.type === 'run.completed') armTerminalReaper();
        }
        reportSessionRef();
      }
      const exit = await closed;
      const exitDetail = exit.signal !== null
        ? `Tura terminated by ${exit.signal}`
        : exit.code !== null && exit.code !== 0
          ? `Tura exited with code ${exit.code}`
          : undefined;
      // A stall reap is a halt, not a process failure: surface it as interrupted
      // with a clear reason rather than the generic SIGKILL exit detail.
      const detail = stalled
        ? 'Tura turn stalled — the agent produced no output within the inactivity grace'
        : stderr.trim() || childError?.message || exitDetail;
      const status = stalled
        ? 'interrupted'
        : childError !== undefined || (exit.code !== null && exit.code !== 0)
          ? 'failed'
          : exit.code === 0
            ? 'completed'
            : 'interrupted';
      yield* translator.end({ status, ...(detail && { error: detail }) });
    } finally {
      if (terminalReaper !== undefined) clearTimeout(terminalReaper);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      this.children.delete(session);
      if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    }
  }

  interrupt(session: Session): void {
    const child = this.children.get(session);
    if (session.session_ref === undefined || !this.command) {
      if (child) this.signal(child, 'SIGINT');
      return;
    }
    const abort = spawn(this.command, [
      '--cwd', session.cwd, '--json', 'session', 'abort', session.session_ref,
    ], {
      cwd: session.cwd,
      stdio: 'ignore',
      env: turaEnv(session.env),
    });
    const forceStop = (): void => {
      if (child && child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    };
    if (!child) return;
    const timer = setTimeout(forceStop, ABORT_GRACE_MS);
    child.once('close', () => clearTimeout(timer));
    abort.once('error', forceStop);
  }

  respondInteraction(): Promise<void> {
    return Promise.reject(new Error('Tura run exposes no response channel to Codor'));
  }

  discoverSessions(): SessionRef[] {
    if (!this.command) return [];
    const result = spawn.sync(this.command, ['--json', 'session', 'list', '--all'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: turaEnv(),
    });
    if (result.error || result.status !== 0) return [];
    try {
      const sessions = JSON.parse(result.stdout) as { id?: unknown }[];
      if (!Array.isArray(sessions)) return [];
      return sessions.flatMap((session) =>
        typeof session.id === 'string' && session.id !== '' ? [session.id] : [],
      );
    } catch {
      return [];
    }
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}
