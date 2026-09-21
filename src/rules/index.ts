import type { AnyRule } from "../engine/types.ts";
import commentDescribesCode from "./code/comment-describes-code.ts";
import commentGivesReason from "./code/comment-gives-reason.ts";
import functionNameMatchesBody from "./code/function-name-matches-body.ts";
import swallowedErrorJustified from "./code/swallowed-error-justified.ts";
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

export const codeRules: AnyRule[] = [commentDescribesCode, commentGivesReason, functionNameMatchesBody, swallowedErrorJustified, testTitleMatchesBody];

export const allRules: AnyRule[] = [...htmlRules, ...codeRules];
