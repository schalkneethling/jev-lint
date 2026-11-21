import type { AnyRule } from "../engine/types.ts";
import booleanNameHoldsBoolean from "./code/boolean-name-holds-boolean.ts";
import commentDescribesCode from "./code/comment-describes-code.ts";
import docMatchesFunctionNext from "./code/doc-matches-function-next.ts";
import docMatchesFunction from "./code/doc-matches-function.ts";
import errorMessageMatchesGuard from "./code/error-message-matches-guard.ts";
import functionNameMatchesBody from "./code/function-name-matches-body.ts";
import swallowedErrorJustified from "./code/swallowed-error-justified.ts";
import testAssertionsCanFail from "./code/test-assertions-can-fail.ts";
import testTitleMatchesBodyNext from "./code/test-title-matches-body-next.ts";
import testTitleMatchesBody from "./code/test-title-matches-body.ts";
import alertIsUrgent from "./html/alert-is-urgent.ts";
import altTextQuality from "./html/alt-text-quality.ts";
import ariaLabelJustified from "./html/aria-label-justified.ts";
import autocompleteMatchesLabel from "./html/autocomplete-matches-label.ts";
import controlTypeIntent from "./html/control-type-intent.ts";
import describedbyDescribes from "./html/describedby-describes.ts";
import descriptionMatchesPage from "./html/description-matches-page.ts";
import labelInputType from "./html/label-input-type.ts";
import linkTextPurpose from "./html/link-text-purpose.ts";

export const htmlRules: AnyRule[] = [
  alertIsUrgent,
  altTextQuality,
  ariaLabelJustified,
  autocompleteMatchesLabel,
  controlTypeIntent,
  describedbyDescribes,
  descriptionMatchesPage,
  labelInputType,
  linkTextPurpose,
];

export const codeRules: AnyRule[] = [
  booleanNameHoldsBoolean,
  commentDescribesCode,
  docMatchesFunction,
  docMatchesFunctionNext,
  errorMessageMatchesGuard,
  functionNameMatchesBody,
  swallowedErrorJustified,
  testAssertionsCanFail,
  testTitleMatchesBody,
  testTitleMatchesBodyNext,
];

export const allRules: AnyRule[] = [...htmlRules, ...codeRules];

/**
 * What runs when nothing asks for more: every rule that is not opt-in. A rule is opt-in when a blind
 * panel, on code the rule was not tuned against, called fewer than half of its errors and warnings right.
 * `--experimental` runs them all.
 */
export const defaultRules: AnyRule[] = allRules.filter((rule) => !rule.optIn);
