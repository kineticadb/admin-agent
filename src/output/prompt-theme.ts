/**
 * PROMPT_THEME — shared @inquirer/prompts theme so interactive prompts render their
 * submitted answer and active selection in the brand pink instead of inquirer's
 * default cyan. Pass as the `theme` field to every prompt call (`select`, `confirm`,
 * `input`, `password`, `search`, `checkbox`) so the palette can't drift between them.
 *
 * Only `answer` (the submitted value) and `highlight` (the active choice while
 * navigating) are overridden — the question text, validation errors, and help hints
 * keep inquirer's defaults. Colors degrade to plain via the brand-color helpers when
 * color is unsupported (pipes / CI / NO_COLOR).
 */
import { pink } from "./brand-colors.js";

export const PROMPT_THEME = {
  style: {
    answer: pink,
    highlight: pink,
  },
};
