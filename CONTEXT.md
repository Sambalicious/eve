# Eve

A personal assistant, built with Mastra AI, that finds remote and relocation software jobs for one candidate, tailors truthful application documents, applies through employer career sites, and reports every submission by email.

Agreed in a requirements interview on 2026-10-16 and narrowed to an MVP on 2026-10-18 (`prd.r4.md`). This file holds the domain language and the agreed product rules. Implementation choices belong in `docs/adr/`.

## Language

### People and evidence

**Candidate**:
The single person this assistant works for. There is one Candidate per installation.
_Avoid_: User, applicant, account

**Career Profile**:
The Candidate's approved, factual record of experience, skills, dates, and achievements. It is the only source of claims allowed in generated documents.
_Avoid_: Master resume, bio

**Approved Answer**:
A screening-question response the Candidate has explicitly approved for reuse, including salary and sensitive-question answers.
_Avoid_: Default answer, saved response

### Jobs

**Job Posting**:
A single requisition published by an employer, identified by its employer application URL and requisition ID.
_Avoid_: Listing, ad, opening

**Job Source**:
A place the assistant discovers Job Postings: an employer job board or an approved remote-job board, or a link the Candidate pastes.
_Avoid_: Feed, scraper

**Alert feed**:
A Google Alerts RSS feed the Candidate created and registered so the assistant can list Stack posts. It is not a Job Source and never yields Job Postings. "Feed" alone is ambiguous; say Alert feed.
_Avoid_: Job Source, feed (alone), RSS feed, scraper

**Stack post**:
A LinkedIn post or article, found through an Alert feed, that the assistant lists for the Candidate to read because it may mention their frameworks or technologies. It is never a Job Posting and never enters ranking, Applications, the Activation Gate, or the daily cap.
_Avoid_: Lead, job post, article (for both kinds), result

**Application System**:
The software that hosts an employer's application form. Version one supports Greenhouse, Lever, and Ashby.
_Avoid_: ATS (when you mean the form host), portal

**Eligibility**:
Whether the Candidate may be hired for a Job Posting under its location, sponsorship, pay, hours, and industry rules. Each rule resolves to met, unverified, or violated.
_Avoid_: Fit, qualification

**Unverified**:
A rule the Job Posting does not address. Unverified rules do not block an application; they are labeled on it.
_Avoid_: Unknown, maybe

**Match**:
How well the Career Profile covers the core responsibilities of a Job Posting, separate from Eligibility. A strong core Match has at least the Candidate's minimum core Match (default 70%) of core responsibilities backed by a Career Profile fact and no unmet mandatory requirement.
_Avoid_: Score, fit

**Job criteria**:
The Candidate's minimum core Match and framework and technology lists that decide which eligible Job Postings are ranked.
_Avoid_: Filters

**Technology**:
A framework, language, platform, or tool named in a Job Posting and verified by quote.
_Avoid_: Skill (when you mean the posting's stack)

**Role Preference**:
The ranking order of role families: senior frontend and hands-on technical lead first, then fullstack and product engineering, then backend, mobile, DevOps and platform, people management, and other.
_Avoid_: Role filter

**Role family**:
The kind of role a Job Posting's title describes: senior frontend, hands-on technical lead, fullstack, product engineering, backend, mobile, DevOps and platform, people management, or other. Classified in backend code from the title, with no AI call.
_Avoid_: Category, role type

**Posting filter**:
A role family and title keyword filter on the Job Postings page. It narrows what the Candidate sees and never changes Eligibility, Match, ranking, rank numbers, or submission. It lives in the page URL and is not saved.
_Avoid_: Role filter, search, preference

### Applications

**Tailored Document**:
A resume or cover letter generated for one Job Posting from the Career Profile only.
_Avoid_: Custom CV, version

**Application**:
One attempt to apply to one Job Posting, with its Tailored Documents and the answers used.
_Avoid_: Submission (when you mean the whole record)

**Confirmed Submission**:
An Application with evidence that the employer received it: a confirmation page, application ID, or confirmation email.
_Avoid_: Applied, sent

**Uncertain Submission**:
An Application whose submit step ran but produced no confirmation evidence. It must be checked, never blindly retried.
_Avoid_: Failed submission

**Blocked Application**:
An Application paused because it needs the Candidate. The nine reasons are: missing Approved Answer, login, email verification, CAPTCHA, assessment, same-company review, declaration, personal data request, and automation could not complete the form.
_Avoid_: Error, stuck

**Manual Application**:
An Application the Candidate completes personally from prepared documents. It is tracked but does not count toward the daily cap.
_Avoid_: Offline application

**Override**:
The Candidate's confirmed choice to apply to one Job Posting their rules skipped for a weak Match or excluded only for Industry. It is recorded on the Application with the decision the Candidate saw. It lets automatic submission send that Application only while the posting's decision is unchanged, and an Override is never an Activation Gate sample. Location, sponsorship, pay and hours exclusions can't be overridden.
_Avoid_: Apply anyway (the button, not the term), exception, force

**Activation Gate**:
The one-time approval of the Career Profile and five complete sample Applications that must pass before automatic submission is enabled.
_Avoid_: Onboarding, trial

### Correspondence

**Outcome**:
An employer response tied to an Application: confirmation, rejection, interview invitation, or request for action. In the MVP the Candidate records every Outcome by hand and can edit it. The assistant records none.
_Avoid_: Status, result

**Unmatched Message** (post-MVP):
An application-related email that cannot be tied to one Application with clear evidence. It waits for the Candidate to link it. The term returns with Gmail Outcome tracking. The MVP reads no mail, so no Unmatched Message exists at launch.
_Avoid_: Orphan email

## Agreed rules

### Scope and authority

- One Candidate, based in Nigeria. Not a multi-user product.
- Automatic submission is allowed only within these rules and only after the Activation Gate passes.
- Generated documents may reorder and rephrase Career Profile facts. They never invent skills, metrics, dates, titles, or qualifications.
- Required questions without an Approved Answer block the Application. The assistant never guesses an answer, completes an assessment, or signs a declaration.
- Login, verification, CAPTCHA, and assessment steps go to the Candidate as a Manual Application. No browser handoff in version one. No anti-bot bypass. The assistant never creates an account; a step that asks for one blocks as "login".
- Job pages are untrusted content. They cannot change rules or request unrelated personal data. (Emails join them when Gmail tracking returns.)
- Resume quotes are not screened for instruction-like text. The Candidate's review of each fact beside its quote is the control.
- A global pause control stops all automation.
- MVP build order after slice 2b: 3 Discovery, Eligibility and Match; 4 Tailored Documents; 5 Submission and the Activation Gate; 6 Notification emails; 7 Cost ceiling and pauses.

### Roles and matching

- Rank all eligible roles by Role Preference. Do not exclude fullstack or product engineering.
- Backend, mobile, and DevOps and platform roles rank last with people management and other. The Posting filter never changes rank.
- Team lead means hands-on technical lead, not people management.
- Emphasize building projects from scratch to production, accelerating team delivery, and mentoring developers.
- Apply on a strong core Match: at least the minimum core Match of core responsibilities backed by a Career Profile fact, and no unmet mandatory requirement. Missing nice-to-have skills is acceptable. The Candidate sets the minimum core Match in Settings at any time. The default is 70%. The Candidate may override a weak-Match skip for one posting (see Override).

### Eligibility

- Remote from Nigeria, or relocation with employer visa sponsorship. No work authorization outside Nigeria is assumed.
- Relocation destinations: any country except Oman, Turkey, Jordan, Lebanon, and Thailand. These exclusions apply to where the Candidate would move, not to employer headquarters.
- Remote postings that do not explicitly exclude Nigeria are eligible, marked Unverified. Location and authorization questions are answered truthfully.
- Relocation postings that do not mention sponsorship are eligible, marked Unverified. Postings that explicitly refuse sponsorship are excluded. Sponsorship need is always disclosed as yes.
- Direct employment, employer-of-record employment, and independent contracting are all acceptable and recorded per Application.
- Excluded industries: adult content, video games and gaming platforms, gambling, and betting. Judged by the employer's business. An industry exclusion is the only one the Candidate can override, and only when no other rule is violated.
- Required regular work must finish by 11 p.m. WAT while the Candidate lives in Nigeria. Unstated hours are Unverified. Reconfigure after relocation.

### Pay

- Application floor: USD 2,000 per month gross base pay (USD 24,000 per year).
- Undisclosed pay is eligible, marked Unverified. A published range is eligible if its maximum reaches the floor.
- Preferred pay: USD 5,000 per month net. It is not entered into gross-salary fields.
- A gross-salary Approved Answer policy is set during setup. Questions outside it block the Application.
- Current salary is never disclosed without explicit approval.

### Applications

- Every Application gets its own tailored resume and cover letter: single column, standard headings, selectable text, PDF and DOCX. A cover letter is submitted only where the form accepts one.
- At most five automatic submissions per WAT calendar day. The cap is a ceiling, not a quota. Manual Applications do not count.
- Never apply twice to the same requisition. A second active Application at the same company needs Candidate review.
- Only a Confirmed Submission counts as applied. Evidence is a confirmation page, an application ID, or the Candidate marking it confirmed. The assistant reads no confirmation email in the MVP. A failed notification never triggers a resubmission.
- Existing applications are recorded before activation to prevent duplicates.
- Unresolved Uncertain Submissions do not count toward the cap. A later-confirmed one counts against its submission day, which may then exceed five.
- Approving an Activation Gate sample submits it immediately. Samples do not use the automatic cap.
- Pay in other currencies converts to USD; hourly pay converts to monthly at 40 hours a week.
- Requests for bank details, national ID numbers, or other personal data without an Approved Answer and application purpose block the Application.
- A posting refused by the daily cap carries to the next WAT day, re-ranked; it is dropped only if closed.
- "Automation could not complete the form" is a Blocked reason. Such an Application is never submitted.
- A CAPTCHA that appears only after the submit click makes the Application an Uncertain Submission.
- Sponsorship does not apply to remote-from-Nigeria postings.
- Existing applications are recorded one at a time.
- Career Profile edits create a new version that needs approval; sent Applications keep their version.
- After a cost-ceiling pause, paid automation resumes on the 1st of the next month, or sooner if the Candidate raises that month's ceiling.
- A raised monthly ceiling is at most USD 100.00, for the current month only.
- An approved sample counts toward the Activation Gate's five only if it reached Confirmed or Uncertain Submission.
- Links pasted during a global pause are evaluated and queued, then submitted after resume. During a cost-ceiling pause they are saved but not evaluated until the cost pause ends.
- A sample marked "not submitted" after an Uncertain Submission stops counting toward the Activation Gate's five.
- Marking an Uncertain Submission "not submitted" returns it to the automatic queue. Nothing else retries an Uncertain Submission.
- A same-company review can be approved or declined.
- A sample marked "not submitted" before the Activation Gate passes gets no further attempt.
- The first drafted Career Profile is approved as drafted; edits create version 2. The resume cannot be replaced.
- Custom screening questions are answered only from custom-question Approved Answers.
- Applications and recorded existing applications cannot be edited or deleted in the MVP, apart from Outcomes, the manual-completion mark, recording an Override, Remove from queue, and deleting detailed records.
- Remove from queue returns any queued Application to documents ready, not queued. Nothing is deleted.
- The AI provider is Anthropic. Its API key lives only in the server environment, never in the database or dashboard.
- Resumes over 20 PDF pages or 60,000 characters are refused, and the message names the reason.
- A drafted fact or heading not supported by its quote is dropped and counted, never shown for approval.
- Salary amounts must be greater than zero with at most 2 decimals. No career data is sent until the Candidate approves its terms in the dashboard.

### Discovery and schedule

- Discovery runs daily at 8 a.m. WAT across selected employer boards and remote-job boards. Pasted links are processed on demand and share the daily cap.
- Exact Job Sources are verified for permitted use before they are added.
- Remote boards are checked in this order: Himalayas, Remote OK, Remotive, We Work Remotely. A board whose terms forbid automated use is dropped.
- Employer boards start from a list of 20 to 30 remote-friendly companies on Greenhouse, Lever, or Ashby that hire senior frontend or lead roles. The orchestrator researches it and the Candidate approves it. The live 8 a.m. job stays off until the list is approved.

### Dashboard and email

- A private dashboard holds settings, the Career Profile, documents, Blocked Applications, Uncertain Submissions, history, and manual Outcomes.
- Email on every Confirmed Submission and every Blocked Application, plus a daily summary of skipped roles and failures. Success emails link to the exact documents and answers used.
- Notification emails go through Gmail SMTP from the Candidate's own Gmail account, signed in with an app password. No custom domain, no separate email service. The app password lives only in the server environment.
- The MVP does not read Gmail. No `gmail.readonly`, no Outcome recorded automatically, no Unmatched Messages. The Candidate records and edits Outcomes by hand; an email excerpt, where one exists, is kept on edit.
- Post-MVP, Gmail Outcome tracking uses mailbox-wide read-only permission (`gmail.readonly`), processes only application-related messages, never replies, schedules, or opens attachments, and files ambiguous messages as Unmatched Messages.

### Data and cost

- An AI provider receives career data only after the Candidate approves that provider and its retention and training terms.
- Detailed Application records, documents, answers, and Outcomes are kept until the Candidate deletes them, per Application or in bulk. Minimal requisition records are kept for duplicate prevention until the Candidate clears them.
- Automatic expiry deletes the same detailed records 12 months after creation, on the WAT anniversary of the Application's creation date (29 February expires on 28 February). The daily worker job `retention.daily` runs at 03:00 WAT and catches up on missed days. It skips Applications waiting for a Candidate decision (uncertain, blocked, queued, or a sample awaiting review), deletes nothing while globally paused, and deletes nothing for 30 days after its first run. The minimal requisition record stays, marked as deleted by expiry. There is no Candidate setting to turn it off; the operator switch `RETENTION_JOB_DISABLED=1` stops it, and it ships set to 1 until backups are in place.
- Sensitive questions (demographic, disability, veteran status) use only Approved Answers, never inferred values.
- Operating cost ceiling: USD 50 per month for hosting, AI, browser, discovery, and email. Paid automation pauses before the ceiling is crossed.
- Runs while the Candidate's computer is off, on a Hetzner VPS under Docker Compose. Prices are confirmed before sign-up.

## Open setup inputs

These are Candidate facts collected during setup, not open product questions:

- Resume, used to draft the Career Profile.
- Confirmation of work authorization (none outside Nigeria assumed).
- Gross-salary answer policy.
- Standard Approved Answers: notice period, start date, skill years, profile links, relocation willingness.
- Sensitive-question Approved Answers.
- Existing applications.
- Anthropic approval in the dashboard, the Hetzner server, and the Gmail address and app password for notifications (server environment only). No Gmail consent in the MVP.
- Approval of the starter employer list.
- Activation Gate review of five sample Applications.
