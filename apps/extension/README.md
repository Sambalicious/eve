# Eve fill (browser extension)

ADR 0016: Eve's side-loaded Chrome/Edge extension. It reads an employer's
application form **in the Candidate's own tab**, asks Eve for the values from
the Candidate's approved answers, fills them, and outlines the required fields
Eve cannot answer. **The Candidate clicks the employer's Submit.**

This is slices 1 and 2: it fills the form and attaches the prepared PDFs. It is unpacked and side-loaded; there is no store listing.

## Build and side-load

```bash
pnpm install
pnpm --filter @eve/extension build   # tsc -> apps/extension/dist
```

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** and pick `apps/extension` — the folder that holds
   `manifest.json`. `manifest.json` points at the compiled `dist/` files, so
   build before loading, and build again after changing `src/`.

## Connect and fill

1. Click the Eve fill toolbar icon, enter your Eve address (for example
   `https://eve.example.com`), press **Connect**, and allow access when Chrome
   asks. Only that origin is granted, as an optional host permission.
2. Open the employer's application form in a normal tab.
3. Click the icon, then **Review values**. Eve reads the form, asks your Eve
   account for the values, and lists every field label with the value it would
   type. A file field that asks for your resume or cover letter is listed with
   "will attach the prepared resume PDF" (or cover letter). Nothing is filled or
   downloaded yet.
4. Read the list, then press **Fill these values**. Only the refs you reviewed
   are filled. Ordinary values are shown as they will be typed; values whose
   label looks sensitive (gender, sex, sexual orientation, pronouns, race,
   ethnicity, Hispanic/Latino, religion, disability, veteran, citizenship,
   criminal history, social security, salary, date of birth, sponsorship, visa,
   age) are masked and marked, but still listed. On this second click the
   values are filled first, then each approved PDF is downloaded from Eve and
   attached to its file field.
5. Answer (or remove) anything outlined in red, and click the employer's
   **Submit** yourself.

While a fill runs the popup shows the item in progress and a **Stop** button.
Stop keeps everything already filled or attached, abandons a download in
flight, and never submits anything.

The employer's page and its third-party scripts can read every value that is
filled, and the file input exposes the attached PDF to the page exactly as it
would expose a file you chose yourself. That is why nothing is typed and no
document is downloaded on the first click: the review list is your control over
what the page gets.

Eve fills a form only on the tab you invoke it on. Nothing runs on a timer and
no content script is installed at install time.

## What this slice does and does not do

Filled:

- Scalar form fields: text inputs, textareas, selects, radio groups and
  checkboxes, from the same per-field `answerFor` classification the automatic path uses (Approved
  Answers, salary answers, contact settings and work context).
- A select is set by option text, then by option value; a radio is chosen by its
  label text; a checkbox is set from the planned boolean value (yes/true/on or
  no/false/off). A radio or checkbox that is not already in the wanted state is
  changed with a real click, so a controlled (React) input commits it. Each value
  is read back after a frame and reported as a mismatch if the page refused it.
  Text and select values are set through the native property setter and reported
  with `input` + `change` events.
- The reader looks at the form that has a visible submit control, falling back to
  the whole document when no form does. Required fields left empty get a 2px red
  outline and a count in the popup.
- **Documents, PDF only.** A file input is read when its box is visible or when
  the field container around it is visible and carries text, so a custom uploader
  that hides its native input is still read. Its label is the real label, then the
  text above it in that container, then Ashby's `resume`/`cover_letter` id or name,
  then "File upload"; a look-alike token such as `recvfile` names nothing. A file
  input whose `accept` excludes PDF is not read, and the filler refuses it again
  if the page changes `accept` after the review. On the second click, the approved
  prepared resume or cover letter is downloaded through the Eve tab and attached to
  the file input the review named, with the same `input` + `change` a real
  selection raises. The selection is read back by file name and reported as a
  mismatch if the page refused it. The input is never clicked and no file chooser
  is opened. Ashby's "Autofill from resume" uploader is skipped by its label, id,
  name or container text and never receives a file.

Not this slice:

- **No file chooser and no arbitrary file.** Only the prepared resume and cover
  letter PDFs are attached, and only after the review's second click. No other
  file is read from disk, and no DOCX is attached.
- **No document prefetch on review.** The first click lists what would be
  attached but downloads nothing, so no document bytes reach the employer page
  before the Candidate approves.
- **No Submit and no link.** The extension never clicks Submit, never opens a
  link, and never navigates. It may click a checkbox or radio to set it the way
  you would.
- **No CAPTCHA solving, no sign-in, no account creation, no LinkedIn reading.**
- **No outcome recording.** Nothing is written in Eve: no Application state, no
  attempt, no event, no ledger row. Recording a completed application stays
  `POST /v1/applications/:id/manual-complete`, wired in a later slice.
- **No stored answers.** `chrome.storage.local` holds the Eve origin and nothing
  else. The plan from the review (labels, values and refs) lives in
  `chrome.storage.session`, which is in-memory for the browser session. It is
  replaced or cleared at the next review, removed after a fill or a refusal, and
  lost when the browser quits. It is never written to disk.
- **No extension credential.** The bridge runs in the Candidate's own Eve tab and
  uses that tab's session: `GET /v1/session` for the CSRF token, then
  `POST /v1/extension/fill` with the session cookie. Signing out of Eve
  disconnects the extension.

A fill belongs to the background worker, not to the popup. `FILL_APPLY` answers
at once and the worker steps the page one item at a time (begin, one value,
then one download-and-attach per document, then finish), writing the run to
`chrome.storage.session` after every item. The popup only renders that record,
so closing it mid-fill loses nothing: reopening shows the item in progress, the
progress, and Stop. A worker that restarts mid-run leaves a record with no loop
behind it, which is failed as interrupted rather than left hanging. The only
trace left on the page is what was filled, the attached PDFs, and the red
outlines on fields that still need your answer.

Limits: one frame (the top document), at most 200 fields per page, password,
hidden, submit and read-only controls are never read, and an Eve tab must exist
in the same browser profile — the extension opens one (inactive) when there is
none. A control is read only when it is genuinely visible (or a custom
radio/checkbox whose label is visible), so an invisible text field is never read.
Geometry cannot catch every trick (transparent text, for one), which is why the
review step, not the reader, is the final control. Eve matches only an
Application that can still be applied to (`documents_ready` with no submission or
a `blocked` one; a queued Application is excluded so a manual fill cannot race the
worker), and it throttles the fill endpoint to 30 requests a minute per Candidate
in each api process. Documents are PDF only and are fetched after the review;
a failed download is reported as unattached and does not stop the values from
being filled: the popup names the document and says whether it needs a signed-in
Eve, a prepared PDF, a smaller file, or attaching by hand. The Eve address must
be `https://`; plain `http://` is accepted only for `localhost` and `127.0.0.1`.

## Files

| File | Runs in | Job |
| --- | --- | --- |
| `src/background.ts` | service worker | Message router: read the tab, ask Eve, store the plan, then step the approved fill (values first, then each document) and write the run |
| `src/page.ts` | employer tab (injected) | READ the visible controls; BEGIN, FILL VALUE, ATTACH FILE and FINISH one item at a time; outline unanswered required fields |
| `src/eve-bridge.ts` | Eve tab (injected) | `GET /v1/session`, `POST /v1/extension/fill`, and the prepared PDF download, all with the session cookie |
| `src/popup.ts`, `src/popup.html`, `src/popup.css` | popup | Connect the Eve origin, review the plan, approve it, then render the run and offer Stop |
| `src/fonts/` | popup | Geist and Bricolage Grotesque `.woff2` files and their OFL licences |
| `src/origin.ts` | popup | https-only origin validation (localhost may be http) |
| `src/review.ts` | popup | The review list and its sensitive-value mask |
| `src/types.d.ts` | compile time | The types that cross those contexts |

`src/page.spec.ts`, `background.spec.ts`, `eve-bridge.spec.ts`, `origin.spec.ts`,
`review.spec.ts`, `popup.spec.ts`, `assets.spec.ts` and `guardrails.spec.ts` cover
the reader, filler, message router, bridge, review list, popup renders, the asset
contract and the never-submit guardrails (`pnpm --filter @eve/extension test`).

## Fonts and licences

The popup bundles its two faces instead of fetching them: the extension has no
bundler, so the files are copied from the web app's `@fontsource-variable`
packages (5.3.0) into `src/fonts/` and declared in `popup.css` with
`font-display: block`.

| Face | File | Licence |
| --- | --- | --- |
| Geist (latin, weight 100–900) | `geist-latin-wght-normal.woff2` | SIL OFL 1.1, `OFL-Geist.txt` |
| Geist (latin-ext, weight 100–900) | `geist-latin-ext-wght-normal.woff2` | SIL OFL 1.1, `OFL-Geist.txt` |
| Bricolage Grotesque (latin, optical size) | `bricolage-grotesque-latin-opsz-normal.woff2` | SIL OFL 1.1, `OFL-Bricolage-Grotesque.txt` |

Both licence files are the unmodified `LICENSE` from each package. Other scripts
(Cyrillic, Greek, Vietnamese) are not bundled and fall back to the system stack.

