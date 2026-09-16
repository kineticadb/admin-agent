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
  /**
   * Base URL of the Prometheus/Loki stats host, e.g. `http://statshost`.
   * Optional — blank means "no metrics for this session".
   *
   * Collected here rather than derived from gpudb.conf because the address that file
   * declares (`gaia.event_server_address`) is the cluster's INTERNAL one, which usually
   * does not route from wherever the agent runs. Config remains a silent fallback when
   * this is absent. Ports are per service, so only the scheme and host are used.
   */
  readonly statsHost?: string;
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

// ---------------------------------------------------------------------------
// Knowledge corpus (knowledge/playbooks/*.md, knowledge/references/**/*.md)
// ---------------------------------------------------------------------------

/**
 * How a knowledge document reaches the model.
 *
 * "inline"    — rendered in full into the system prompt. Reserve this for policy the
 *               agent must obey WITHOUT knowing to look it up (see mutation-safety.md).
 * "on-demand" — rendered as a one-row card; the body arrives via kinetica_knowledge_read.
 *
 * Declared per document in frontmatter so the decision is a one-line, reversible
 * corpus edit rather than a code change.
 */
export type Disclosure = "inline" | "on-demand";

/** Which corpus a document came from. Set by the loader, which alone knows the directory. */
export type KnowledgeKind = "playbook" | "reference" | "bundle-reference";

/** One `##`/`###` section of a document body. Preamble text is headed "(intro)". */
export type KnowledgeSection = {
  readonly heading: string;
  readonly body: string;
};

/**
 * Fields shared by every knowledge document.
 *
 * The disclosure-related fields are OPTIONAL here and required on `KnowledgeDoc`:
 * loaders fill in what only they know (`id`, `kind`), `normalizeDoc()` derives the
 * rest, and hand-written test fixtures stay valid without restating any of it.
 */
type KnowledgeDocBase = {
  readonly title: string;
  readonly category: string;
  readonly keywords: readonly string[];
  readonly body: string;
  readonly filename: string;
  /** Filename stem, e.g. "gpudb-conf" — the id kinetica_knowledge_read takes. */
  readonly id?: string;
  readonly kind?: KnowledgeKind;
  /** Frontmatter `summary` — one line stating WHAT the document covers. */
  readonly summary?: string;
  /** Frontmatter `read_when` — the unconditional trigger for reading it. */
  readonly readWhen?: string;
  /** Frontmatter `disclosure`; defaults to "on-demand" during normalization. */
  readonly disclosure?: Disclosure;
  /** Body split on `##`/`###` headings. Derived during normalization. */
  readonly sections?: readonly KnowledgeSection[];
};

// Playbook — expert diagnostic knowledge loaded from knowledge/playbooks/*.md
export type Playbook = KnowledgeDocBase & {
  readonly severity: string;
};

// Reference — domain knowledge loaded from knowledge/references/*.md
// Unlike Playbook, has no severity field — references are informational, not failure patterns.
export type Reference = KnowledgeDocBase;

/**
 * A normalized knowledge document — every derived field resolved.
 *
 * Produced by `normalizeDoc()` and served by the KnowledgeStore. The difference from
 * `Playbook`/`Reference` is entirely in the type: nothing here is optional, so a
 * renderer or tool never re-derives a default and the two can never disagree.
 */
export type KnowledgeDoc = {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly category: string;
  readonly keywords: readonly string[];
  readonly body: string;
  readonly filename: string;
  /** Always non-empty — falls back to the title when nothing better exists. */
  readonly summary: string;
  /** "" when the document declares no trigger (inline documents need none). */
  readonly readWhen: string;
  readonly disclosure: Disclosure;
  readonly sections: readonly KnowledgeSection[];
  /** Playbooks only. */
  readonly severity?: string;
  /** Estimated body tokens — drives the card's section list and the oversize warning. */
  readonly tokens: number;
};
