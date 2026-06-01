/**
 * Shared TypeScript types for all Phase 1 modules.
 * These are type contracts — not implementations.
 * All properties are readonly to enforce immutability.
 */

// Credential collection result (used by session/collect.ts)
export type Credentials = {
  readonly url: string;
  readonly user: string;
  readonly pass: string;
};

// Session object — the pre-authenticated client (used everywhere)
// Implementation in session/KineticaSession.ts, but type defined here
export type KineticaSession = {
  readonly baseUrl: string;
  readonly makeRequest: (endpoint: string, body?: unknown) => Promise<Response>;
  /** Make a request to the same host on a different port (e.g. host manager on 9300). */
  readonly makeRequestToPort?: (
    port: number,
    endpoint: string,
    body?: unknown,
  ) => Promise<Response>;
};

// Approval response from the user (used by approval/gate.ts)
export type ApprovalResponse = "allow" | "deny" | "explain";

// Tool annotation for the read-only allow-list (used by approval/registry.ts)
export type ToolAnnotation = {
  readonly name: string;
  readonly readOnly: boolean;
};

// Truncation options (used by output/truncate.ts)
export type TruncationOptions = {
  readonly headLines: number;
  readonly tailLines: number;
};

// Default truncation configuration
export const DEFAULT_TRUNCATION: TruncationOptions = {
  headLines: 150,
  tailLines: 50,
} as const;

// Tool result types — discriminated union for all Phase 2 diagnostic tools
// Success case: data payload + optional metadata
export type ToolSuccess<T> = {
  readonly ok: true;
  readonly data: T;
  readonly rowCount?: number;
  readonly note?: string;
};

// Failure case: HTTP status + human-readable error + raw response body
// Includes status code so agent can distinguish 401 (auth) vs 503 (down) vs 404 (endpoint missing)
export type ToolFailure = {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly raw: string;
};

// Discriminated union — ok field narrows the type at every call site
export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

// Playbook — expert diagnostic knowledge loaded from knowledge/playbooks/*.md
export type Playbook = {
  readonly title: string;
  readonly category: string;
  readonly severity: string;
  readonly keywords: readonly string[];
  readonly body: string;
  readonly filename: string;
};

// Reference — domain knowledge loaded from knowledge/references/*.md
// Unlike Playbook, has no severity field — references are informational, not failure patterns.
export type Reference = {
  readonly title: string;
  readonly category: string;
  readonly keywords: readonly string[];
  readonly body: string;
  readonly filename: string;
};
