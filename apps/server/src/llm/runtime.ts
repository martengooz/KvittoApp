/**
 * Bringing the local model up, on whatever machine the server happens to be.
 *
 * Two deployment shapes, and the server has to handle both without asking:
 *
 * - **Ollama is already running** (a Mac where the user installed the app, a
 *   `docker compose` sibling container, a box on the LAN). Then this does
 *   nothing but confirm it and check the model is there.
 * - **Ollama is installed but not running.** Then the server starts it as a
 *   child process and shuts it down again on exit, so `npm start` is still the
 *   only command anyone has to run.
 *
 * It never installs Ollama. Downloading and running a binary on someone's
 * machine is not a thing a sync server should do quietly; when it is missing,
 * the status endpoint says so and gives the one-line install command for the
 * platform it is actually on.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { platform } from 'node:os';

import { config } from '../env.ts';
import { hasModel, listModels, ping, pullModel, type PullProgress } from './ollama.ts';

/** Where a package manager puts the binary, per platform. */
const CANDIDATE_PATHS: Record<string, string[]> = {
  darwin: [
    '/opt/homebrew/bin/ollama',
    '/usr/local/bin/ollama',
    '/Applications/Ollama.app/Contents/Resources/ollama',
  ],
  linux: ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/ollama/bin/ollama'],
};

export type RuntimeState =
  /** Disabled in configuration. */
  | 'off'
  /** Ollama is not installed and not reachable. */
  | 'missing'
  /** Starting a child process, or waiting for it to answer. */
  | 'starting'
  /** Reachable, but the model has not been downloaded. */
  | 'no-model'
  /** Downloading the model. */
  | 'pulling'
  /** Ready to run. */
  | 'ready';

export interface RuntimeStatus {
  state: RuntimeState;
  model: string;
  /** Ollama's own version, when it answered. */
  version: string | null;
  /** How the instance was obtained. */
  managed: boolean;
  baseUrl: string;
  platform: string;
  /** Set while `state` is `pulling`. */
  pull: { status: string; percent: number } | null;
  /** Human-readable explanation of a non-ready state. */
  detail: string | null;
  /** Shown when Ollama is missing, matched to this platform. */
  installHint: string | null;
}

let child: ChildProcess | null = null;
let state: RuntimeState = 'off';
let version: string | null = null;
let detail: string | null = null;
let pull: RuntimeStatus['pull'] = null;
let starting: Promise<boolean> | null = null;

export function status(): RuntimeStatus {
  return {
    state,
    model: config.llm.model,
    version,
    managed: child !== null,
    baseUrl: config.llm.baseUrl,
    platform: platform(),
    pull,
    detail,
    installHint: state === 'missing' ? installHint() : null,
  };
}

/** True only when a request would actually run right now. */
export function isReady(): boolean {
  return state === 'ready';
}

/**
 * Brings the runtime up as far as it can get, and reports whether it is usable.
 *
 * Safe to call repeatedly and concurrently: the work is shared, so a burst of
 * queued receipts produces one startup, not one per receipt.
 */
export function ensureReady(): Promise<boolean> {
  if (!config.llm.enabled) {
    state = 'off';
    return Promise.resolve(false);
  }
  if (state === 'ready') return Promise.resolve(true);
  starting ??= start().finally(() => {
    starting = null;
  });
  return starting;
}

async function start(): Promise<boolean> {
  state = 'starting';
  detail = null;

  let alive = await ping();
  if (!alive.ok && config.llm.manageProcess) {
    if (!(await spawnOllama())) return false;
    alive = await waitForPing();
  }

  if (!alive.ok) {
    state = 'missing';
    detail = `Ingen Ollama-instans svarar på ${config.llm.baseUrl}.`;
    return false;
  }
  version = alive.version;

  if (await hasModel(config.llm.model)) {
    state = 'ready';
    return true;
  }

  if (!config.llm.autoPull) {
    state = 'no-model';
    detail = `Modellen "${config.llm.model}" saknas. Kör "ollama pull ${config.llm.model}".`;
    return false;
  }

  return fetchModel();
}

/**
 * Downloads the configured model.
 *
 * Exposed on its own so the operator can trigger it from the API — a 3 GB pull
 * is not something to start implicitly the first time a receipt arrives.
 */
export async function fetchModel(): Promise<boolean> {
  state = 'pulling';
  pull = { status: 'startar', percent: 0 };
  try {
    await pullModel(config.llm.model, (progress: PullProgress) => {
      pull = {
        status: progress.status,
        percent: progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
      };
    });
    pull = null;
    state = 'ready';
    detail = null;
    return true;
  } catch (error) {
    pull = null;
    state = 'no-model';
    detail = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/** Where the binary is, or `null` when it is not installed. */
export function findBinary(): string | null {
  const explicit = config.llm.binary;
  if (explicit) return executable(explicit) ? explicit : null;

  for (const candidate of CANDIDATE_PATHS[platform()] ?? []) {
    if (executable(candidate)) return candidate;
  }
  // Fall back to whatever is on PATH; `spawn` resolves it.
  return 'ollama';
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function spawnOllama(): Promise<boolean> {
  const binary = findBinary();
  if (!binary) {
    state = 'missing';
    detail = 'Ollama är inte installerat.';
    return false;
  }

  try {
    const host = new URL(config.llm.baseUrl);
    child = spawn(binary, ['serve'], {
      // Inherit the environment so a user's OLLAMA_MODELS or GPU settings apply,
      // but pin the host so the child listens where this server will look.
      env: { ...process.env, OLLAMA_HOST: `${host.hostname}:${host.port || '11434'}` },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own group, so shutting the server down can take the child with it
      // without the signal reaching anything else.
      detached: false,
    });
  } catch {
    state = 'missing';
    detail = `Kunde inte starta "${binary} serve".`;
    child = null;
    return false;
  }

  child.on('exit', (code) => {
    child = null;
    if (state !== 'off') {
      state = 'missing';
      detail = `Ollama-processen avslutades (kod ${code ?? 'okänd'}).`;
    }
  });
  child.on('error', (error) => {
    child = null;
    state = 'missing';
    detail = `Kunde inte starta Ollama: ${error.message}`;
  });

  return true;
}

/** Polls until the freshly-spawned instance answers, or the deadline passes. */
async function waitForPing(): Promise<{ ok: boolean; version: string | null }> {
  const deadline = Date.now() + config.llm.startupTimeoutMs;
  while (Date.now() < deadline) {
    const alive = await ping(1500);
    if (alive.ok) return alive;
    if (child === null) break; // It died; no point waiting out the clock.
    await sleep(500);
  }
  return { ok: false, version: null };
}

/** Stops a child instance. Never touches one this server did not start. */
export async function shutdown(): Promise<void> {
  state = 'off';
  const process_ = child;
  child = null;
  if (!process_) return;

  process_.kill('SIGTERM');
  // Give it a moment to close its model files cleanly before insisting.
  for (let attempt = 0; attempt < 20 && process_.exitCode === null; attempt += 1) {
    await sleep(100);
  }
  if (process_.exitCode === null) process_.kill('SIGKILL');
}

/** Models the instance holds, for the status endpoint. Empty when unreachable. */
export async function installedModels(): Promise<string[]> {
  try {
    return (await listModels()).map((model) => model.name);
  } catch {
    return [];
  }
}

function installHint(): string | null {
  switch (platform()) {
    case 'darwin':
      return 'brew install ollama  (eller ladda ner Ollama.app från ollama.com)';
    case 'linux':
      return 'curl -fsSL https://ollama.com/install.sh | sh';
    default:
      return 'Se https://ollama.com/download';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
