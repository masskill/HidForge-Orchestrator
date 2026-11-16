import type { Policy } from '../store.ts';

export type Support = 'supported' | 'unsupported' | 'unknown';

export interface Capabilities {
  headless: Support;
  streamEvents: Support;
  cancel: Support;
  questions: Support;
  usage: Support;
  modelSelect: Support;
  readOnlyMode: Support;
}

export interface AgentStatus {
  id: string;
  name: string;
  mock: boolean;
  installed: boolean;
  version: string | null;
  auth: 'ok' | 'missing' | 'unknown';
  available: boolean;
  reason: string | null;
  capabilities: Capabilities;
  notes: string[];
}

/** Normalized event parsed from one stdout line of an agent. */
export interface AgentEvent {
  kind: 'message' | 'tool' | 'result' | 'error' | 'log';
  text: string;
  usage?: Record<string, number>;
  isError?: boolean;
}

export interface Invocation {
  command: string;        // resolved via PATH without a shell
  args: string[];
  stdin: string | null;   // prompt goes through stdin, never argv
}

export interface StartContext {
  prompt: string; workspace: string; model: string | null; policy: Policy;
  maxBudgetUsd?: number | null;  // passed only to CLIs with a native spend cap (claude --max-budget-usd)
  trustWorkspace?: boolean;      // explicit user opt-in per agent (Cursor workspace trust); never on by default
}
export interface ModelInfo { id: string; label: string }

/** The single interface every provider implements. Runtime (spawn/stream/cancel) is shared in runner.ts. */
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly mock: boolean;
  detect(): Promise<{ installed: boolean; version: string | null; reason: string | null }>;
  checkAuth(): Promise<{ auth: 'ok' | 'missing' | 'unknown'; reason: string | null }>;
  capabilities(): Capabilities;
  notes(): string[];
  buildInvocation(ctx: StartContext): Invocation;
  parseLine(line: string): AgentEvent | null;
  /** Models this account can use (from the CLI itself); empty if the CLI cannot list them. */
  listModels?(): Promise<ModelInfo[]>;
  /** Remote backends (ssh): copy the workspace to the host before a run... */
  prepare?(workspace: string): Promise<void>;
  /** ...and bring the agent's changes back into the local workspace after a successful run. */
  collect?(workspace: string): Promise<void>;
}
