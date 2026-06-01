/**
 * Strips display noise from MCP tool names for human-readable output.
 *
 * Transformations applied in order:
 *   1. Strip `mcp__<server>__` prefix (e.g. `mcp__kinetica-diagnostics__`)
 *   2. Strip `kinetica_` prefix
 *   3. Replace remaining underscores with spaces
 *
 * Names without known prefixes pass through with underscores replaced.
 */
export function formatToolName(toolName: string): string {
  const stripped = toolName.replace(/^mcp__[^_]+__/, "").replace(/^kinetica_/, "");
  return stripped.replace(/_/g, " ");
}
