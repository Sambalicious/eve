import type { ContactHeader } from "../documents/document-model.js"
import { containsContactDetail } from "../documents/contact-detail.js"

/**
 * FEAT-0017: the contact-detail rule for **added-fact text only**.
 *
 * The shared `containsContactDetail` is also read by the validator, generation's
 * profile filtering, the headline check and posting extraction; widening it would
 * change decisions for existing inputs with `ADDED_FACTS_ENABLED` off (PRD AC 10.1,
 * architecture "everything else is unchanged", FEAT-0009 non-goal). The contract's
 * `contact_detail` problem also names a URL, and copy `C-AF-59.contact` says
 * "links", so the extra rule lives here and is applied at the two added-fact
 * seams only: the write rules and generation's effective-fact resolver.
 */

/**
 * An absolute URL, a `www.` link, or a bare `host.tld/path` link ("example.com/portfolio")
 * anywhere in the text. SEC-R03: the bare form is the SEC-008 residual the write rules
 * missed; the contract's `contact_detail` names a URL and copy `C-AF-59.contact` says
 * "links". Two technology shapes look like one and stay allowed:
 * `ASP.NET/C#` / `VB.NET/C#` (a real TLD as part of the name) and `Node.js/Express`
 * (`js`, `ts` and the other code extensions are not TLDs). The host stays general, so
 * country domains such as `ada.ng/portfolio` are caught too.
 */
const LINK = /\b(?:(?:https?:\/\/|www\.)\S+|(?!(?:asp|vb)\.net\/)(?![A-Za-z0-9-]*\.(?:js|ts|py|rb|rs|php|css|html|json|yml|yaml|sql|md|sh|go)\/)[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/\S*)/i

export function containsAddedFactContactDetail(text: string, contact: ContactHeader | null): boolean {
  return containsContactDetail(text, contact) || LINK.test(text)
}
