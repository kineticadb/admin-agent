/**
 * themed-prompts — @inquirer/prompts re-exported pre-bound with PROMPT_THEME.
 *
 * Import interactive prompts from HERE, never from "@inquirer/prompts" directly, so
 * every prompt renders in the brand palette and a newly added prompt can't silently
 * ship in inquirer's default cyan. Each wrapper merges PROMPT_THEME UNDER the caller's
 * config, so an explicit `theme` in the call still wins. Signatures and return types
 * are preserved verbatim, including the generic `Value` of select/search/checkbox.
 *
 * Pre-binding is the single point the palette is applied — there is no per-call-site
 * `theme:` to forget. (The colors themselves degrade to plain when color is
 * unsupported; see brand-colors.) The optional `context` arg is forwarded with a rest
 * spread so a one-arg call stays one-arg — we never synthesize a trailing `undefined`.
 */
import {
  input as inputBase,
  confirm as confirmBase,
  password as passwordBase,
  select as selectBase,
  search as searchBase,
  checkbox as checkboxBase,
} from "@inquirer/prompts";
import { PROMPT_THEME } from "./prompt-theme.js";

export function input(...args: Parameters<typeof inputBase>): ReturnType<typeof inputBase> {
  const [config, ...rest] = args;
  return inputBase({ theme: PROMPT_THEME, ...config }, ...rest);
}

export function confirm(...args: Parameters<typeof confirmBase>): ReturnType<typeof confirmBase> {
  const [config, ...rest] = args;
  return confirmBase({ theme: PROMPT_THEME, ...config }, ...rest);
}

export function password(
  ...args: Parameters<typeof passwordBase>
): ReturnType<typeof passwordBase> {
  const [config, ...rest] = args;
  return passwordBase({ theme: PROMPT_THEME, ...config }, ...rest);
}

export function select<Value>(
  ...args: Parameters<typeof selectBase<Value>>
): ReturnType<typeof selectBase<Value>> {
  const [config, ...rest] = args;
  return selectBase<Value>({ theme: PROMPT_THEME, ...config }, ...rest);
}

export function search<Value>(
  ...args: Parameters<typeof searchBase<Value>>
): ReturnType<typeof searchBase<Value>> {
  const [config, ...rest] = args;
  return searchBase<Value>({ theme: PROMPT_THEME, ...config }, ...rest);
}

export function checkbox<Value>(
  ...args: Parameters<typeof checkboxBase<Value>>
): ReturnType<typeof checkboxBase<Value>> {
  const [config, ...rest] = args;
  return checkboxBase<Value>({ theme: PROMPT_THEME, ...config }, ...rest);
}
