/**
 * Read-only tool registry with default-deny semantics.
 *
 * Default-deny: only tools explicitly registered as read-only bypass the
 * approval gate. All other tools — including unknown/new tools — require
 * user confirmation before execution.
 *
 * Immutability: registerReadOnlyTool returns a NEW registry instance.
 * It never mutates the original. This is enforced structurally by the
 * createRegistry factory pattern.
 *
 * Phase 1: The default set is empty. Phase 2 will register diagnostic tools
 * (kinetica_health_check, kinetica_get_metrics, etc.) via registerReadOnlyTool.
 * Phase 4 mutation tools are NEVER added to this registry.
 */

// Default-deny: empty set in Phase 1. No tools are pre-approved.
// Phase 2 will add diagnostic tools here.
const DEFAULT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set();

export type Registry = {
  readonly isReadOnlyTool: (toolName: string) => boolean;
  readonly registerReadOnlyTool: (toolName: string) => Registry;
  readonly tools: ReadonlySet<string>;
};

/**
 * Creates an immutable read-only tool registry.
 *
 * @param tools - Initial set of allowed tool names (defaults to empty set)
 * @returns A registry object with immutable operations
 */
export function createRegistry(tools: ReadonlySet<string> = DEFAULT_READ_ONLY_TOOLS): Registry {
  return {
    isReadOnlyTool: (toolName: string): boolean => tools.has(toolName),

    // Returns a NEW registry — never mutates the current one
    registerReadOnlyTool: (toolName: string): Registry =>
      createRegistry(new Set([...tools, toolName])),

    tools,
  };
}

// Module-level default registry for convenience import
const defaultRegistry = createRegistry();

/** Returns true only if toolName is in the read-only allow-list */
export const isReadOnlyTool = defaultRegistry.isReadOnlyTool;

/** The read-only tool set (empty in Phase 1) */
export const READ_ONLY_TOOLS: ReadonlySet<string> = defaultRegistry.tools;
