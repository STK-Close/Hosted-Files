# Launch campaign build plan: Vault Deck Forge, HyMeta, Hustle & Flow

Date: 2026-11-27. Builds the approved design: `docs/launch/2026-11-27-launch-campaign-design.md` (commit 8630ca5), with its "Update 2026-11-27: everything automatic" section (design branch tip 3ee9609) and
Ligia's later requests: a prominent tip jar, one Stripe account for all money, and her Google Calendar.
Where the design's earlier sections still mention Ligia approving or posting posts by hand, the Update section
overrides them.

> For the sessions doing this work: go task by task, in order. Tick each step (`- [x]`) as it is done and
> commit the tick. Posts go out on their own, but only after a separate reviewer agent passes each one against
> its product's rules and its link is checked. Apart from those posts and the site updates in this plan, nothing is bought,
> made public or emailed without Ligia's approval.
> Before a task is called done, a separate reviewer agent checks it (Ligia's standing rule).
> Ligia: this file is the builder's checklist. The plain summary is in the message sent to you.

**Goal:** three staggered launches (Vault Deck Forge on Tuesday, December 8, 2026; HyMeta on Wednesday,
January 13, 2027; Hustle & Flow on Tuesday, January 26, 2027, an estimate tied to the IRS start date), each
with buildup, launch day and follow-through, posted automatically once each post passes the rules check.

**How it fits together:** one private Google Sheet per product (tabs `errands`, `posts`, `results`,
`change_log`). Three scheduled tasks (weekly planner, poster, deadline nudges) run as fresh sessions with push
notifications. Posting goes through Composio, the same pattern as the "Lumina Instagram posting" task: check
the connected account's username, post only rows that passed the check and are due, write the link back, log
the change. A post that fails the check is held, not posted, and listed in the Monday report. Reddit and
Discord are automatic too, but only where a community's own rules allow self-promotion, at low frequency; the
rules are re-read before each post and communities that forbid it are skipped. Every date also goes on
Ligia's Google Calendar (Task 20).

**Tools already in place:** Google Sheets connector, Composio (Instagram already connected for Lumina),
Gmail drafts, Supermetrics (TikTok and Instagram numbers), the browser and Playwright in these sessions
(screenshots and screen recordings), the shared promo maker (`STK-Close/promo-maker`). No new paid services.

**Update 2026-11-27 (evening):** TikTok and Threads are dropped for now; the launch uses Instagram, YouTube and Reddit.
Reddit posts go from Ligia's own account in her voice as the maker. All three scheduled tasks exist, paused until Ligia adds
their connectors.

## Rules this plan keeps

- **This repository is public.** It holds dates, errand names and the plan only. Never put here: sheet IDs or
  links, account names, Ko-fi or email addresses, prices beyond the design, or anything from Hustle & Flow
  beyond what the approved design already says. Sheet links live only inside the scheduled tasks' prompts.
- **Hustle & Flow stays sealed.** All its detailed work happens in its own private repository, from a plan
  written there (Task 13). Nothing from it is copied into HyMeta, Vault Deck Forge or here.
- **Each product connects its own accounts** and every post is checked against that product's expected
  username first. A mismatch means no post, and Ligia is told.
- **Each product's own rules win** (HyMeta: "An unofficial fan site", no mod names, logos or numbers,
  child-safe, a playpack's advert only in its own week. Hustle & Flow: education, not advice, no overpromising.
  Vault Deck Forge: "Unofficial fan tool. Not affiliated with Vault Hunters / Iskallia.").
- **Every post links to a page that works.** The planner opens each link before a post joins a batch.
- **All money goes to one Stripe account** (Ligia). HyMeta's memberships and Vault Deck Forge's Ko-fi tips land in
  the same bank account, and Hustle & Flow's payouts follow the same rule in its private plan. Claude never asks for account or
  bank details in chat. HyMeta's live Stripe key is asked for with the secure credential form when the build
  needs it, and never goes in chat, files or commits.
- **Ligia's errands** go in the sheet's `errands` tab as plain numbered steps, with a due date and a "done" box.
- **Any test that is added or changed** is shown failing on a version with the bug and passing on the fixed one.
- Plain words, sentence case, no em dashes in anything Ligia or the public reads.

## Order of work

Tasks are grouped by product below, but are done in this order, by deadline:
1, 2, 3 and 4 (Nov 27 to 29) · 20 (calendar shared; links added as each sheet appears) · 6 and 7 (kit and clips, Nov 28 to
Dec 1) · 8 (Nov 30) · 9 (batch checked Tue Dec 1) · 5 (tip jar, Nov 30 to Dec 3, switched on when the Ko-fi link arrives) ·
11 (Dec 4) · 10 (Dec 7 to 9) · 13 (Dec 12) · 14 (Dec 12) · 12 (from Dec 14) · 15 (from Jan 2) · 16 · 17 · 18 (weekly) · 19.

## Calendar at a glance (America/New_York)

| Date | What |
|---|---|
| Fri Nov 27 to Sun Nov 29 | Tasks 1 to 4: Vault Deck Forge sheet and errands, HyMeta sheet with the CurseForge email draft, platform check |
| Mon Nov 30 | Promo kit and clips finishing (Tasks 6, 7), tip jar started (Task 5), scheduled tasks created (Task 8) |
| Tue Dec 1 | First Vault Deck Forge batch written and rules-checked (Task 9) |
| Wed Dec 2 | Ligia finishes the Stripe account and payout bank (first, because Ko-fi uses it) |
| Wed Dec 2, evening | Nudge: Vault Deck Forge errands due tomorrow |
| **Thu Dec 3** | **Ligia's Vault Deck Forge errands due** (Ko-fi on Stripe, accounts, connect accounts) |
| Fri Dec 4 | First teaser goes out (if it passed the check). The rest of HyMeta's errands sent to Ligia |
| **Sat Dec 5** | **CurseForge permission email sent by Ligia** (drafted in Task 3) |
| Mon Dec 7 | Launch eve check for Vault Deck Forge (Task 10) |
| **Tue Dec 8** | **Vault Deck Forge launch** |
| Dec 9 to Dec 22 | Vault Deck Forge follow-through |
| **Sat Dec 12** | Hustle & Flow errands start (Task 13) |
| Wed Dec 23 | HyMeta buildup starts (3 weeks) |
| Jan 2 to Jan 8 | Watch for the IRS filing start date; move Hustle & Flow's date to match |
| Tue Jan 5 | Hustle & Flow buildup starts (3 weeks before Jan 26) |
| **Wed Jan 6** | **HyMeta errands must be done. If CurseForge has not said yes, the launch moves** |
| **Wed Jan 13** | **HyMeta launch** |
| **Tue Jan 19** | **Hustle & Flow errands must be done** |
| **Tue Jan 26 (estimate)** | **Hustle & Flow launch** |
| to Feb 9 | Hustle & Flow follow-through, then a results review with Ligia |

Note: Vault Deck Forge's buildup is short (Dec 4 to Dec 7, four days, not two to three weeks). That is the
cost of launching before the holiday break. It is also the smallest product and the posting test run.

---

## Part 1: Vault Deck Forge (launch Tue Dec 8)

### Task 1: Vault Deck Forge sheet

**Where:** a new private Google Sheet, "Vault Deck Forge launch", in Ligia's Google account. Its link goes
in the scheduled tasks' prompts only. The repository gets `docs/launch/README.md` saying a sheet exists and
what its tabs mean, without the link.

- [x] Create the sheet (Google Sheets connector or Composio Google Sheets; if neither can create a file,
      Ligia's first errand is "make a blank sheet and share the link", with steps).
- [x] Tabs and columns:
  - `errands`: errand_id, what, steps (plain, numbered), due, status (to do / done / skipped), done_on, notes
  - `posts`: post_id, date, time_et, platform, community (subreddit or server), format, caption, media, link,
    check (passed / held), check_notes, status (draft / ready / posted / failed / held), posted_url, notes
  - `results`: week_start, platform, views, followers, clicks, tips, notes, source
  - `change_log`: timestamp, editor, tab, row, field, old, new
- [x] Freeze the header rows, add a "how to use this sheet" note in row 1 of
      each tab in plain words.
- [ ] Reviewer agent opens the sheet and checks every tab against this list.

### Task 2: Vault Deck Forge errands (due Thu Dec 3)

Fill the `errands` tab. Each errand has plain steps. Claude looks up current steps on the official help page
of each service on the day, so the steps match what Ligia sees.

- [ ] **Make a Ko-fi page** (free), after the Stripe errand in the HyMeta sheet (Task 3) is done: sign up,
      name the page for Vault Deck Forge (or Lumina Art House), turn on tips, choose Stripe as the payment
      method and connect it to that same Stripe account, then paste the page link into the errand's notes.
- [ ] **Make the accounts, as early as possible (ideally this weekend):** a YouTube channel for Vault Deck
      Forge (for Shorts), and a Discord account to join the Vault Hunters Discord. For Reddit, an older account
      Ligia already has is better than a new one: many subreddits hide posts from accounts that are days old or
      have little activity. Claude checks the subreddit's account age and activity rules first (Task 9) and
      tells her what is needed. Note each username in the sheet.
- [ ] **Connect the accounts for automatic posting:** YouTube, and Reddit and Discord where Task 4 found an
      allowed route. Claude sends a Composio connection link for each; Ligia taps it and signs in. Claude then
      confirms each account name.
- [x] Phone number in the app's Legal section: decided, it stays (it is the business line).
- [ ] Send Ligia one message with the sheet link and the errands, then add the dates to the master view
      (Task 18).

### Task 3: HyMeta sheet and the CurseForge permission email draft (due Sat Dec 5)

The biggest risk of the whole campaign, so it is drafted now even though HyMeta launches in January.

- [x] Create the "HyMeta launch" sheet now, the same way as Task 1, so HyMeta's errands never sit in another
      product's sheet. Its other errands are added in Task 11.
- [ ] First errand in it, due Wed Dec 2: **finish the Stripe account and its payout bank** (HyMeta uses Stripe,
      and Ko-fi connects to the same account). Plain steps from Stripe's own help pages; no details in chat.

- [x] Find CurseForge's current contact route for API and partnership questions on their official support site
      (do not guess an address). Record where it was found and the date.
- [x] Draft the email from `docs/curseforge-terms.md` in the HyMeta repository. It asks, in writing:
  1. That a paid membership site ($3.99 a month or $24.99 a year) using the API is acceptable (clause 2.3).
  2. That HyMeta may store mod details on its own server and refresh them weekly (clause 3.1, "save or cache").
  3. That curated playpacks that send every download back to CurseForge are not treated as competing (clause 3.1).
  4. What usage limits apply when the site opens to everyone, and whether a licence is needed (clause 2.3).
  5. Anything in the Mod Author Terms that applies (read that page first and summarize it in the draft notes).
  It is short, friendly, signed as Lumina Art House, LLC, and asks for an answer by Monday, January 4, 2027.
- [x] Reviewer agent checks the draft against the terms page for accuracy and tone.
- [x] Put the draft in Ligia's Gmail drafts (not sent) and add an errand to the HyMeta sheet, "Send the
      CurseForge email", with steps, due Sat Dec 5, plus a follow-up errand on Mon Dec 21 if no answer has come.

### Task 4: Can each platform post automatically? (check before anything depends on it)

Composio's tools differ by platform, and some platforms limit posting by outside apps. Check before the
batches are written.

- [x] With Composio's tool search, confirm for each platform: YouTube (upload a Short), Instagram (Reels,
      already working for Lumina), TikTok (direct post, or only "send to inbox as a draft"), Threads.
- [ ] Confirm Composio can hold more than one account per platform (Lumina's Instagram plus a product's), and
      how a tool call picks the right one.
- [ ] Write the result into each product sheet's notes and here as a short table (no account names).
- [ ] Reddit: confirm Composio can submit a post to a subreddit from Ligia's account, and that the account
      meets each subreddit's age and activity rules.
- [ ] Discord: automatic posting from a personal account breaks Discord's own terms. It is allowed only through
      a webhook or bot a server's staff add, or a channel the server sets up for that. Where a server offers no
      such route, that server is skipped and Ligia is told why.
- [ ] Any platform that cannot post automatically is skipped for that product, and the Monday report says so.

**Result, checked Nov 27 with Composio's tool search (no accounts connected yet, so not yet tried live):**

| Platform | Can post automatically? | Notes |
|---|---|---|
| YouTube Shorts | Yes | Upload with title, description and privacy. A vertical clip under 60 seconds becomes a Short. |
| Threads | Yes | Text, image, video and carousel posts. |
| Reddit | Yes | Text or link posts, with flair. Subreddit rules can be read first. Reddit may still hide posts from new accounts. |
| Instagram | Yes | Already working for Lumina. |
| TikTok | Probably only "only me" | Composio's TikTok tool says unaudited apps may only post privately. Confirm once connected; if so, TikTok posts go to the account as private drafts and someone has to publish them. |
| Discord | Only with a bot the server adds | Composio's Discord tool is a bot. It can post only in servers whose staff add it. Large community servers rarely do. |

### Task 5: A prominent tip jar in the app (Vault Deck Forge, before Dec 8)

Repository `STK-Close/vault-deck-forge`. The app is web only (the app store release was dropped), so a tip
link is allowed. Ligia asked for it to be prominent; this spec is the master session's, and she can change it.
The Ko-fi link lives in one setting. Until her real link is in, it is a placeholder and everything below stays
hidden.

- [x] **Always visible:** a "☕ Support the tool" button in the app header. 44px or larger, visible focus, a
      screen reader label that says it opens Ko-fi in a new tab, correct in both themes.
- [x] **A gentle tip card at a moment of value, not on a timer:** it appears right after someone finishes
      building or optimizing their 3rd deck, or after 10 minutes of real use, whichever comes first. Warm and
      short, for example: "Vault Deck Forge is free and ad-free. If it helped your run, a tip keeps it going."
      Two buttons: "Leave a tip" and "Not now".
  - At most once every 14 days. After "Leave a tip" is tapped, never again.
  - Never during the guided tour or on the first visit.
  - Respects reduce motion. Closes with Escape, returns focus where it was.
  - Its state is stored only in the browser's own storage: no tracking, nothing leaves the browser.
- [x] **The same link** in Settings, in the Legal section.
- [x] **Tests first:** browser tests for the header button (shown with a real link, hidden with the
      placeholder, size and label), the card (third deck, ten minutes, 14 days, never after a tip, never during
      the tour or first visit, reduce motion, "Leave a tip" opens the link and stops the card for good, "Not now"
      and Escape close it and return focus) and the Legal link. Show each test failing before the change and
      passing after it.
- [x] `npm test` (rules, build, browser tests at phone, tablet and desktop, both themes). Look at phone and
      desktop screenshots of the header, the tip card and Settings, in both themes.
- [x] Reviewer agent checks the change. Push to `main` (publishes to vault-deck-forge.vercel.app), then open the
      live site and confirm. Add a CHANGELOG entry.

### Task 6: Vault Deck Forge advert kit

- [x] Install the shared promo maker into the repository (its `install.js`, the same way HyMeta and
      Hustle & Flow have it). Never edit the copy inside the project; change `promo-maker` instead.
- [x] Screenshots from the live app with a sample collection: the deck grid with a strong build, Best upgrades,
      the strongest builds list, phone and desktop.
- [x] Draw wide, square and tall adverts. Every one carries "Unofficial fan tool. Not affiliated with
      Vault Hunters / Iskallia." and the live link. No game logos or art that is not the app's own.
- [x] Run the promo maker's check and look at every picture. Show the kit to Ligia on a private page.

### Task 7: Vault Deck Forge video clips

- [x] Record three to four short vertical clips (15 to 40 seconds) with Playwright's built-in screen recording
      on the live site: building a deck from owned cards, a Best upgrades tap-through, the gold strategy, and
      importing cards from the save file. Captions are shown in the page while recording (no new installs).
- [x] End each clip on the matching advert as an end card.
- [ ] Each clip goes through the same rules check as a post before it is used (the clip file is the row's media).

### Task 8: The three scheduled tasks

Created with `create_trigger`: fresh session on every run (`create_new_session_on_fire: true`), push
notifications on (`notifications: {push: true}`), times in America/New_York, minutes moved off the hour by the
standard jitter (name length mod 29, plus 1, minutes early). Connectors attached: Google Sheets and Composio.
If the result warns that no connectors were stored, tell Ligia and fix it before relying on the task.
At first each task lists Vault Deck Forge only. HyMeta and Hustle & Flow are added with `update_trigger` when
their sheets exist (Tasks 11 and 14).

In plain words: the planner runs Monday mornings, the poster four times a day, the nudges every evening.
The cron column is the code the scheduler reads.

| Task name | Schedule | Cron |
|---|---|---|
| Launch weekly planner | Mondays, 7:40 AM | `CRON_TZ=America/New_York 40 7 * * 1` |
| Launch poster | daily, 7:47 AM, 12:47 PM, 5:47 PM, 8:47 PM | `CRON_TZ=America/New_York 47 7,12,17,20 * * *` |
| Launch deadline nudges | daily, 6:39 PM | `CRON_TZ=America/New_York 39 18 * * *` |

Each prompt is a complete standalone instruction and handles each product **separately, one after another**:
it opens only that product's sheet and repository, never copies text from one product to another, and
commits only to that product's repository.

- [ ] **Weekly planner** prompt: for each product, read its rules (CLAUDE.md and promo rules), write the next
      week's posts from the ads its promo setup makes and its clips (phase by date: buildup, launch,
      follow-through), check every link opens, have a separate reviewer agent check each post against that
      product's rules, then mark it passed (status ready) or held (with the reason). Check errands, pull last week's numbers into `results`
      (Supermetrics for TikTok and Instagram where connected, YouTube from Composio, Ko-fi and anything else by
      hand from Ligia's notes, never invented), then send **one** push, a report: "Last week: 6 posts out, 1 held ·
      340 views, 12 sign-ups · this week: 5 posts scheduled, 2 errands due", with a link to each product's sheet and nothing
      confidential in it. Last, update the master view in this repository (Task 18): dates and errand status
      only. This is the one place the planner writes outside a product's repository. Then bring Ligia's Google
      Calendar in line with the sheets (Task 20).
- [ ] **Poster** prompt: the Lumina Instagram posting steps, per product: find rows whose check is passed,
      status ready, no posted_url, due now or earlier today; confirm the connected account's username matches
      the product's expected one; for Reddit and Discord, re-read the community's current rules and skip (status
      held, with the reason) if they no longer allow it or the post would break its frequency limit; post; write posted_url and status; log in `change_log`. Media from a private
      repository is re-hosted through Composio's upload first. Push Ligia only if something fails. Never edit or
      delete a published post.
- [ ] **Deadline nudges** prompt: push only when an errand is due tomorrow or overdue. It reads only the
      sheets' `errands` tabs. When a date moves, it updates the calendar event too (Task 20). HyMeta: from Jan 4, check whether CurseForge has answered (ask Ligia in the push) and on
      Jan 6 propose a new date if not. Hustle & Flow: from Jan 2, check the IRS newsroom for the 2027 filing
      start date and, once announced, propose moving the launch to match.
- [ ] Create the three tasks (poster and nudges created Nov 27, paused: tasks made from a session cannot carry connectors on this account; waiting on Ligia to add them in claude.ai or choose a long-lived session), read each back with `get_trigger`, and fire the planner once by hand
- [x] Nov 27 test run of the planner: Sheets, Calendar, Composio and the push all worked. Scheduled sessions have no
      repositories, so its prompt now carries each product's rules itself and no longer edits this repository.
      (`fire_trigger`) to prove it works on the Vault Deck Forge sheet. Its first real posts are Dec 4.
- [ ] Reviewer agent checks the three prompts against this plan and the products' rules.

### Task 9: Vault Deck Forge posts (batch ready Tue Dec 1)

- [x] Find the current Vault Hunters subreddit and its self-promotion rules, and the modpack Discord's rules
      for sharing tools (which channel, how often, whether bots or webhooks may post). Record what was found and
      the date in the sheet notes. Skip any community that forbids it.
- [x] Write the batch into `posts`:
  - Buildup (Dec 4 to Dec 7): one YouTube Short teaser ("coming Tuesday"), one Discord "coming soon" post
    if the server's rules allow it.
  - Launch day (Dec 8): a YouTube Short, a Reddit post written to the subreddit's rules (made by a player, for
    players, free, what it does, the link, unofficial), a Discord post where allowed.
  - Follow-through (Dec 9 to Dec 22): two to three Shorts a week (tips: the gold strategy, Best upgrades,
    importing cards) and one "what's new" post that answers feedback. Reddit and Discord at most once a week
    each, or less if their rules say so.
- [x] Every caption: plain words, US spelling, the unofficial line, the working link, the tip link once live.
- [x] A separate reviewer agent checks every post; failures are held with the reason.

### Task 10: Launch eve and launch day (Mon Dec 7 and Tue Dec 8)

- [ ] Dec 7: open the live app on phone and desktop sizes, both themes; tip link works; every launch-day link
      opens; YouTube connection still points at the right channel. Fix or tell Ligia the same day.
- [ ] Dec 8: the poster sends the posts that passed the check, Reddit and Discord included where allowed.
- [ ] Dec 9: a short note to Ligia: what went out, first numbers, comments that need an answer.

---

## Part 2: HyMeta (launch Wed Jan 13, 2027)

Repository `STK-Close/hymeta` (public: nothing private goes in it). Its rules (`CLAUDE.md`) apply in full.

### Task 11: HyMeta errands (sent Fri Dec 4, all done by Wed Jan 6)

- [ ] Add HyMeta (its sheet from Task 3) to the three scheduled tasks with `update_trigger`.
- [ ] Errands with plain steps, from `docs/launch-checklist.md`:
  - Send the CurseForge email (Dec 5, from Task 3), follow up Dec 21.
  - Lawyer review: privacy policy, terms, community rules and the 13-and-up rule (book by Dec 11, done Jan 6).
  - Stripe (the account and payout bank are done in Task 3): finish the business questions, switch to the
    live key (Claude asks for it with the secure credential form when the build needs it; never in chat, files
    or commits), set the statement descriptor (LUMINA ART
    HOUSE, short LUMINA). Ask an accountant where sales tax applies, then switch on Stripe Tax.
  - Support email address, added to the Help and contact page.
  - Email service (free Brevo account), the sending address, and the postal address the law needs on newsletters.
  - Confirm the rights to the eight original pictures (Perplexity's terms) and Hypixel's fan site rules,
    including the "Hy" in the name.
  - Make the accounts (TikTok, YouTube, Reddit, Discord) and connect TikTok and YouTube through Composio.
  - Launch morning: Ligia opens the site herself (the `SITE_OPEN` setting in Vercel, with steps). Claude never
    sets it.
  - Decide whether search engines may list the site once it opens (buttons).
- [ ] Add HyMeta's dates to the master view.

### Task 12: HyMeta rule update, kit, clips and posts

- [x] Change the rule in HyMeta's `CLAUDE.md` "Nothing is posted by Claude. Ligia posts." to: "Claude may post
      launch content that passed the rules check, and nothing else." Keep "A playpack's advert goes out in
      its own week, not before." Commit to `main`.
- [ ] Clips on the test site with the password screen left out, from sample mode, cropped above the list of
      mods: the front door, a playpack page, Hex, membership. No mod names, logos or numbers. "An unofficial fan
      site" on every clip and advert.
- [ ] Posts from the existing advert kit (about 90 adverts) and the clips. Buildup Dec 23 to Jan 12 (the app,
      Hex, what membership gets you; never an upcoming playpack). Until the Jan 6 gate passes, posts say
      "coming in January", never the exact date. Jan 7 to Jan 12 posts name Jan 13 only once the gate is passed. Launch day Jan 13 (Hytale's
      early access birthday) on TikTok, YouTube Shorts, and Reddit and Discord where each community's rules allow it (rules re-read before each post, as in Task 9). Follow-through to
      Jan 27, including each week's playpack advert in its own week only.
- [ ] `npm test` (includes the advert check that blocks mod names). Reviewer agent checks for child safety
      and the fan site rules.
- [ ] **Gate, Wed Jan 6:** all errands done and CurseForge has said yes in writing. If not, the nudges task
      tells Ligia and proposes a new date; nothing goes out that names Jan 13 until it is settled.
- [ ] **Jan 12:** with Ligia, one real membership payment and refund on the live key, every link checked.

---

## Part 3: Hustle & Flow (launch Tue Jan 26, 2027, estimate)

Hustle & Flow is confidential. This public plan lists only what the approved design already says. Every
detail, file and step lives in a private plan inside its own repository.

### Task 13: Hustle & Flow's own private plan (by Sat Dec 12)

- [ ] In its own private repository, following its own rules, write its launch plan: its sheet and errands
      (including the payout errand), its launch build, clips, posts, and its rule update (Claude may post launch
      content that passed the rules check, and nothing else). Its details stay there.

### Task 14: Hustle & Flow sheet and errands (start Sat Dec 12, done by Tue Jan 19)

- [ ] Create its sheet the same way as Task 1, private, its link only in its private plan and the scheduled
      task prompts. Add it to the three scheduled tasks with `update_trigger`.
- [ ] Errands from its private plan, each with plain steps.
- [ ] The master view here shows only "Hustle & Flow errands: on track / behind", with no errand names.

### Task 15: Hustle & Flow date check (Jan 2 to Jan 8)

- [ ] The nudges task watches the IRS newsroom for the 2027 filing start date. When announced, it proposes the
      new launch date to Ligia with buttons, and every post date moves with it.

### Task 16: Hustle & Flow kit, clips and posts

- [ ] As set out in its private plan, under its wording rules (education, not advice; no overpromising).
      Channels: TikTok, Instagram Reels, YouTube Shorts, Threads.

### Task 17: Hustle & Flow launch (Jan 26) and follow-through (to Feb 9)

- [ ] As set out in its private plan.

---

## Part 4: Across all three

### Task 18: Master view (dates and errands only)

- [ ] Keep `docs/launch/status.md` in this repository: each product's launch date, each errand's name, due date
      and done or not. No links, accounts or numbers. Updated by the working sessions when something changes
      (Nov 27 test run: scheduled sessions carry no repositories, so the planner reports in its Monday push instead).

### Task 18b: Frame-by-frame media safeguard (added Nov 28)

Ligia, Nov 28: "I need to be able to trust that these are being made correctly and without me." Two clips had passed a
review that never looked at their frames (a hidden caption left a still screen). Now, for all three products:
- [x] **Automatic media check** (`promo/tool/media-check.js` in the shared promo maker, installed in each product):
      videos must be 1080 by 1920, inside the planned length, carry an audio track, never stand still for 3 seconds
      or more outside the end card, and show a caption at least every 3 seconds; pictures must be the right size, not
      blank, carry the small print and be unchanged since drawn. Published copies must match the checked file byte for
      byte. It writes a report and a contact sheet per file, runs in each product's tests, and proves itself on
      broken samples. It also fails on the two old broken clips.
- [x] **Visual sign-off:** the reviewer agent must open each contact sheet and describe it frame by frame, and check the
      story against the caption plan, before a post is marked passed. A metadata-only review is a fail.
- [x] **Posting gate:** each product sheet's posts tab has `media_check` and `visual_review` columns. The poster
      downloads the media, compares its fingerprint with the published check report, and holds anything missing,
      failed or changed. Held posts are reported on Monday.
- [x] **Monday report** adds "N posts checked frame by frame, M held" and a link to an optional preview tab in the
      product's sheet. Nothing waits for Ligia.
- [x] Nov 28: every Vault Deck Forge post and media file was re-checked (21 files, 10 posts with media): all passed, after
      the Trade clip's longest caption was split in two. HyMeta's 90 adverts pass. Hustle & Flow's adverts are recorded
      the next time its kit is drawn in its own sessions; until then they cannot pass.

### Task 19: Results review (after each follow-through)

- [ ] Dec 23 (Vault Deck Forge), Jan 28 (HyMeta), Feb 10 (Hustle & Flow): a one-page summary per product from
      its `results` tab, kept in that product's own place. Then the round-two questions from the design: paid
      ads with real numbers, influencers, press.

### Task 20: Ligia's Google Calendar (as soon as it is shared)

The master session says when the calendar is shared with the connected Google account. Until then, nothing
is written to it.

The master session already added 10 events (three launches, four errands, two deadlines, the Monday report),
each with a reminder at 9 AM the day before. This task keeps them current; it never makes duplicates.

- [x] Confirm access with the Google Calendar connector (read the existing events). Calendar ID and time zone
      (America/New_York) live in the scheduled tasks' prompts, not in this repository.
- [x] Before creating any event, search by title. Add each sheet's link to the matching events' descriptions
      once the sheet exists. New errands get an event on their due date with the same day-before reminder.
- [ ] When a date moves (CurseForge, the IRS date, a slipped errand), move the existing event.
- [ ] Hustle & Flow events say only what its private plan allows.
- [ ] Reviewer agent compares the calendar with the three sheets.

## What this plan cannot check in advance

- Whether TikTok, Threads, Reddit and Discord allow automatic posts (Task 4 decides; anything that cannot is
  skipped and reported).
- Each subreddit's and Discord server's current rules (checked on the day in Tasks 9, 12 and 16).
- CurseForge's answer and the IRS date, which move HyMeta's and Hustle & Flow's dates.
- A real iPhone with VoiceOver for the tip link change (the browser tests cover sizes, themes and keyboard).
