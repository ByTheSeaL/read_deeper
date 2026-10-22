# Read Deeper — Plan

Demystify technical language without losing your place. Highlight a word,
phrase or sentence in anything you're reading (a medical journal, unfamiliar
code, a work of philosophy), send it to Read Deeper, and get a short,
plain-language explanation back from the LLM you've chosen.

Two clients, one idea:

| Platform | How you trigger a lookup | Where the answer appears |
|----------|--------------------------|--------------------------|
| Android  | Highlight → **Share** → Read Deeper, or highlight → **Read Deeper** in the text-selection menu | A dialog on top of the app you're reading |
| Android  | Open the app, type into the search box | The app's main screen |
| Chrome   | Highlight → right-click → **Explain with Read Deeper**, or a keyboard shortcut | An overlay panel on the page |
| Chrome   | Click the toolbar icon, type into the search box | The popup |

The structure follows `ByTheSeaL/excerpt-anywhere`, which already pairs an
Android share-target app with an MV3 Chrome extension. The difference is that
Read Deeper has **no server**.

---

## 1. Architecture: no endpoint

```
Chrome extension ──┐
                   ├──► https://openrouter.ai/api/v1/chat/completions  (streamed)
Android app ───────┘
```

Excerpt Anywhere needs its VPS endpoint because its job is to write files into
the Obsidian vault that lives there. Read Deeper's job is to ask a question and
show an answer. Nothing has to be stored centrally, so a server would only
relay requests to OpenRouter.

- **The extension calls OpenRouter directly** from its background service
  worker, with `https://openrouter.ai/*` in `host_permissions`. This uses the
  same pattern as Excerpt Anywhere, where every network call goes through the
  service worker, never the page. That keeps the page's own security rules
  (CSP) out of the way.
- **The Android app calls OpenRouter directly** with `HttpURLConnection`.
  As in Excerpt Anywhere, it uses no networking or JSON libraries.
- **What this costs:** the OpenRouter key, model and prompt are configured
  once per client. The extension stores them in `chrome.storage.sync`, so one
  setup covers every Chrome where you're signed in. Android is once per phone.
- **History and channels are per platform**, which you said is fine. Your
  phone's channels and Chrome's channels are separate.
- **When to add an endpoint later:** if you ever want one shared history and
  set of channels across phone and desktop. The clients can gain an optional
  "sync to endpoint" without changing how lookups work.

**Why only OpenRouter:** one key and one API shape for both clients. Claude
models are available through it, so nothing is lost by not wiring up an
Anthropic subscription. A Claude Pro/Max subscription can't be used by
third-party apps anyway; that route needs a separate paid API key.

---

## 1a. The lookup screen

The same layout everywhere a lookup is shown: the Chrome overlay, the
extension popup, the Android dialog and the Android main screen.

```
┌──────────────────────────────────────────────┐
│ [ functools.wraps                       ] ⟳  │  ← query box: your selection, editable
│ Channel: [ Python               ] 📌 auto    │
├──────────────────────────────────────────────┤
│ `functools.wraps` is a decorator you put on  │
│ the inner function of your own decorator so… │  ← streamed explanation
│                                              │
│ ▸ You: why does the name matter?             │
│   Tools like debuggers and help() read…      │  ← follow-up thread
├──────────────────────────────────────────────┤
│ [ Ask a follow-up…                      ] ➤  │
│ Copy                                         │
└──────────────────────────────────────────────┘
```

### Query box: rewording the lookup

- **What's in it:** the highlighted word(s) sit at the top in an editable box.
  On the main screens it is the search box itself, so the same thing is in
  the same place in both cases.
- **Refining:** if the explanation misses what you needed, edit the box and
  press ⟳ or Enter to re-explain. Add words like *"in statistics"* or
  *"simpler"*, or widen the selection to the whole phrase.
- **What happens to the old answer:** the new answer replaces it, in the same
  channel. Only the final version is kept in history, so a misfire doesn't
  clutter the channel.
- **Re-explaining vs following up:** re-explaining asks the original
  question again, worded better. A follow-up keeps the answer and asks
  something further.

### Follow-ups: a small chat scoped to one lookup

- **Not a general chatbot.** Each lookup has its own short thread:
  - an **Ask a follow-up** box under the answer;
  - each question and answer appended under the original explanation;
  - answers streamed, like the main one.
- **What the model receives:** the whole thread so far, as a normal chat
  (system prompt, original question, explanation, follow-ups), plus the
  channel history the original lookup had. That keeps the conversation
  anchored to the term and the document.
- **Answer length:** follow-ups use the same length setting.
- **Where it's saved:** the thread is stored with the lookup. Reopening the
  lookup from history shows the whole thread, and you can carry on asking.
- **Effect on the channel:** only the original lookup's term and gist enter
  the channel roster. The full thread is sent only while you're in that
  lookup. This keeps the roster small. If a follow-up turns out to matter,
  you can look that term up directly and it becomes its own entry.

---

## 2. Channels: continuity between lookups

A **channel** is an area of knowledge that lookups belong to, for example
"Python", "Cardiology", "Kant's Critique of Pure Reason" or "Kubernetes".
Every lookup is filed under one channel. When you look something up, the
model sees what you've already looked up in that channel, so later
explanations build on earlier ones. It can say "like the `@property`
decorator you looked up earlier…" and doesn't re-explain basics you've
already covered.

Channel continuity has to work in both of these cases:

- **Same document, minutes apart.** Three lookups from the same article go
  into the same channel, and each one is informed by the previous ones.
- **Same topic, days apart.** You do four Python lookups today, read about
  something else tomorrow, then come back to Python the day after. The new
  Python lookup lands back in the Python channel with that history attached.

### 2.1 The channel box

Both the main screens (Android app, extension popup) and the lookup UIs
(Android dialog, Chrome overlay) show a **Channel** text box above the
explanation.

- **Auto (default).** The box shows the channel the model chose for this
  lookup, marked *auto*. The next lookup is classified afresh.
- **Pinned.** Type a channel name into the box, or tap the pin icon, and the
  channel is pinned. Every lookup goes into that channel until you unpin it
  or type a different name. A name that doesn't exist yet creates a new
  channel. The box suggests existing channel names as you type.
- **Correcting a misfile.** Editing the box after an answer has appeared
  moves *that* lookup into the channel you typed, and pins it. If the model
  put a lookup in "Snakes" and you meant "Python", you fix it in one edit.
- **Unpinning** returns to auto.

### 2.2 How the model picks a channel, in a single call

Classification and explanation happen in **one** streamed request, so a
lookup costs one round trip.

Each request's prompt includes:

1. **The channel roster.** Up to 12 most recently used channels. For each
   one, the channel's name and its last ~6 lookups as one-liners
   (`term — gist`). This is small, roughly 1–2k tokens, and it holds
   everything the model needs to pick a channel *and* build on that channel's
   history in the same pass.
2. **Recent activity.** The most recent channel, and whether the new lookup
   came from the same source (URL or page title) as the previous one. If it
   did, the prompt says so, which strongly suggests the same channel.
3. **The lookup itself.** The selected text, plus surrounding context and the
   page title when available (see §4).
4. **Pinned mode** replaces 1 and 2 with: "The channel is *X*." Then the
   prompt carries X's history only, with more of it, up to the last ~15
   lookups.

The model replies in a fixed format:

```
CHANNEL: Python
`@functools.wraps` is a decorator you put on the inner function of your own
decorator so the wrapped function keeps its original name and docstring. …
```

- **The first line** is the channel. It is stripped from the display and
  shown in the channel box instead. The model is told to reuse an existing
  channel name exactly when one fits, and to coin a short new name otherwise.
- **The first sentence of the explanation** is written as a standalone,
  one-sentence definition. It is stored as the lookup's **gist**, which is
  what appears in future rosters. That gives the app a gist without asking
  for a second, hidden section.
- **If the model ignores the format**, so that there is no `CHANNEL:` line,
  the lookup goes into the most recent channel and the whole reply is shown.
  Nothing is lost.

Channels older than the top 12 are still kept and listed in the channel
manager. They just don't appear in the auto roster. Typing an old channel's
name into the box brings its history back.

### 2.3 What is stored

Per platform, locally:

```
Lookup  { id, text, context, sourceUrl, sourceTitle, channelId,
          explanation, gist, model, createdAt }
Channel { id, name, createdAt, lastUsedAt }
State   { pinnedChannelId | null }
```

- **Extension:** `chrome.storage.local`. The sync storage area's 100 KB quota
  is too small for history.
- **Android:** a JSON file in app storage. That is fine at this scale; switch
  to SQLite if it ever isn't.
- **Cap:** the last 1,000 lookups. The oldest are dropped first. Channels
  with no remaining lookups are kept by name.

### 2.4 Channel manager

A screen on each platform (in Android's main menu, and a tab in the extension
options page) where you can:

- rename, merge and delete channels;
- browse a channel's lookups;
- clear all history.

Merging is the remedy when the model has split one topic into two names
("Python" vs "Python programming").

---

## 3. The system prompt

There is a default prompt, editable in settings on both platforms with a
"reset to default" button. The canonical copy lives in
`shared/system-prompt.md`, and `scripts/sync_prompt.sh` copies it into
`chrome-extension/` and `android/app/src/main/res/raw/`. That way the two
clients never drift apart.

What the default prompt asks for:

- **Audience:** someone in the middle of reading who wants to keep going.
  Plain language, no padding, no "Great question".
- **Length:** aim for about **{{target_words}}** words, from the *Answer
  length* setting (default 80). Go shorter when a term is simple. Allow up to
  roughly 1.5× when a whole sentence needs unpacking.
- **Shape:**
  1. One-sentence definition, written to stand alone as the gist.
  2. What it means *here*, using the surrounding context when given.
  3. Optionally, one tiny example, or for code, a one- or two-line snippet.
- **Sentences:** when the selection is a whole sentence, paraphrase it
  plainly and flag the one or two terms that carry its meaning.
- **Continuity:** use the channel's history. Refer back to earlier lookups
  when it helps, and don't re-define terms already explained.
- **Format:** `CHANNEL:` first line, then the explanation in light Markdown
  (bold, inline code, short lists only).

Variables filled in per request:

- `{{target_words}}`;
- the channel roster, or the pinned channel's history;
- the source title and URL;
- the surrounding context;
- the selection.

`max_tokens` is set to about 3× the target word count, plus a reasoning
allowance (below), so a runaway answer gets cut off.

**Reasoning models.** The default model, `z-ai/glm-5.3-flash`, always
reasons before answering; OpenRouter rejects `reasoning: {enabled: false}`
for it. A tight `max_tokens` can be used up by hidden reasoning, leaving an
empty reply. A test with `max_tokens: 200` returned nothing.

- **Every request sends `reasoning: {effort: "low"}`.** In testing that
  cost about 60 reasoning tokens and gave a ~2 s answer that followed the
  `CHANNEL:` format.
- **`max_tokens` includes a 1,000-token reasoning allowance.**
- **Settings has a *Reasoning effort* option:** low (default), medium, high,
  or off for models that allow it.
- **If a reply finishes with no visible text**, the client shows
  "The model used its whole allowance thinking — try again or raise the
  answer length". It never shows a blank answer.

---

## 4. Context sent with a lookup

| Source | Selection | Surrounding context | Source title / URL |
|--------|-----------|---------------------|--------------------|
| Chrome right-click / shortcut | ✓ | ✓ the sentence(s) around the selection, read from the page's DOM, ~400 chars | ✓ |
| Chrome popup search box | ✓ typed | — | — |
| Android **Share** | ✓ | — | sometimes: Chrome for Android adds `EXTRA_SUBJECT` (page title) and may add a link-to-text URL |
| Android **select-text menu** (`PROCESS_TEXT`) | ✓ | — | — |
| Android search box | ✓ typed | — | — |

Android only hands over the highlighted text, so on the phone the channel
roster carries most of the disambiguation. If you want more help from
context there, highlight the whole sentence.

---

## 5. Chrome extension (MV3)

```
chrome-extension/
  manifest.json      contextMenus, storage, scripting, activeTab;
                     host_permissions: https://openrouter.ai/*
  background.js      context menu + command; builds the prompt; streams from
                     OpenRouter; owns history and channels
  overlay.js         the on-page panel, inside a shadow root (as in
                     Excerpt Anywhere) so no site CSS reaches it
  popup.html/js      search box, channel box, recent lookups
  options.html/js    API key, model picker, system prompt, channel manager
  prompt.js          the canonical prompt, generated by sync_prompt.sh
  lib/               shared JS: prompt building, response parsing, storage
```

- **Context menu:** "Explain “%s” with Read Deeper" on any selection.
- **Shortcut:** suggested `Alt+Shift+D`. You can change it at
  `chrome://extensions/shortcuts`.
- **Streaming:** the service worker reads the response from OpenRouter as it
  arrives (`stream: true`) and relays chunks to the overlay over a
  `chrome.runtime` port. The answer appears as it's written.
- **Overlay:**
  - the selected text;
  - the channel box (with auto/pinned state);
  - the streamed explanation;
  - **Copy** and **Ask a follow-up**. The layout is described in §1a.
  - It closes with **Esc** or a click outside.
- **Pages where content scripts can't run** (`chrome://` pages, the Web
  Store, Chrome's built-in PDF viewer): the context menu still provides the
  selected text. The answer opens in a small extension popup window instead
  of an overlay.
- **Model picker:** see §7.

## 6. Android app

Kotlin, `minSdk 26`, AppCompat. As in Excerpt Anywhere: no OkHttp, no JSON
library, no Compose. Distributed as an APK on GitHub Releases.

```
android/app/src/main/java/com/readdepth/
  ExplainActivity.kt   dialog-themed; handles SEND (text/plain) and
                       PROCESS_TEXT; shows channel box + streamed answer
  MainActivity.kt      launcher: search box, channel box, answer, recent
                       lookups
  SettingsActivity.kt  API key, model, system prompt
  ChannelsActivity.kt  channel manager
  OpenRouter.kt        streamed chat completion over HttpURLConnection
  Prompt.kt            builds the request (roster, history, context)
  Store.kt             lookups + channels (JSON file)
  Settings.kt          SharedPreferences wrapper
```

- **Two ways into a lookup from another app:**
  - `ACTION_SEND` with `text/plain`: the share sheet. It appears as
    **Read Deeper**.
  - `ACTION_PROCESS_TEXT`: appears directly in the text-selection menu as
    **Read Deeper**. It's one tap faster than Share. Excerpt Anywhere already
    registers both.
- **Dialog:** `ExplainActivity` uses a dialog theme, like Excerpt Anywhere's
  share form. The app you were reading stays visible behind it, and Back
  dismisses it.
- **Streaming:** read the SSE response line by line on a background thread
  and append it to the `TextView` on the UI thread.
- **Main screen:** search box with an **Explain** button, the channel box,
  the answer area, and then a list of recent lookups. Tap a lookup to reopen
  it.

---

## 7. Settings (both platforms)

| Setting | Default |
|---------|---------|
| OpenRouter API key | — (required) |
| Model | `z-ai/glm-5.3-flash` |
| Answer length | 80 words (target; adjustable 20–300) |
| Reasoning effort | low (the default model can't turn reasoning off) |
| System prompt | the shared default, with a reset button |
| Send surrounding context | on (Chrome only) |
| Channel roster size | 12 |
| History kept | 1,000 lookups |

### Model dropdown

- **Where the list comes from:** OpenRouter's public `GET /api/v1/models`,
  which needs no key. The list is fetched when the settings screen opens and
  cached for a day.
- **Extension:** a searchable dropdown.
- **Android:** a dropdown with a filter box, i.e. an `AutoCompleteTextView`.
- **Each entry shows** the model's name and its price per million input and
  output tokens, so cheap and fast choices are easy to spot.
- **Recently used** models are pinned to the top.
- **Model IDs not in the list:** you can still type any ID by hand. If the ID
  isn't in the fetched list, settings shows a warning, which catches typos and
  retired models.
- **If the list can't be fetched** (offline), the field falls back to plain
  text.

### OpenRouter API key

- **The field:** the first field in settings, masked, with a show/hide
  toggle.
- **Test key button:** calls OpenRouter's `GET /api/v1/key` and shows either
  "Key OK", with your remaining credit if OpenRouter reports it, or the
  error.
- **First run:** with no key saved, any lookup or search opens a "Add your
  OpenRouter key" prompt with a link to the settings screen. It does not
  fail silently.
- **Storage:**
  - **Extension:** `chrome.storage.sync`, so one entry covers every Chrome
    where you're signed in. It is tied to your Google account.
  - **Android:** `SharedPreferences`, private to the app.
- **Sent only to `openrouter.ai`**, as the `Authorization: Bearer` header.

---

## 8. Builds, versions and releases (GitHub Actions)

The app and the extension are built by GitHub Actions, never by hand. Every
build gets its own version number, and past builds stay downloadable.

### Version numbers

```
VERSION file:  0.1            ← major.minor, bumped by hand for milestones
build number:  github.run_number   (increments on every workflow run)
full version:  0.1.<build>     e.g. 0.1.37
```

- **Android:**
  - `versionName = "0.1.37"`.
  - `versionCode = 37`. It always increases, so each APK installs over the
    previous one.
- **Extension:** `manifest.json` `"version": "0.1.37"`, written in by the
  workflow. The repo copy keeps `0.0.0`.
- **Where you see it:**
  - **Android:** the settings screen and the main screen's menu show
    "Read Deeper 0.1.37".
  - **Extension:** the options page shows the same, and so does
    `chrome://extensions`.

So you can always tell which build you're running and match it to a release.

### Workflow: `.github/workflows/build.yml`

| Trigger | What it does |
|---------|--------------|
| Push to `main` | Builds both, then publishes a **GitHub Release** `v0.1.<build>` with `read-deeper-0.1.<build>.apk` and `read-deeper-extension-0.1.<build>.zip` attached, plus the commit list since the previous release as notes |
| Push to any other branch / pull request | Builds both and uploads them as **workflow artifacts** (kept 90 days) so a branch can be tried before merging, without cluttering Releases |
| Manual (`workflow_dispatch`) | Same as a push to `main` |

- **Jobs:**
  - `android`: JDK 17 and Gradle cache, then `./gradlew assembleRelease`.
  - `extension`: runs `sync_prompt.sh`, stamps the version, and zips
    `chrome-extension/`.
  - `release`: runs after both, only on `main`.
- **Past builds:** every release stays on the repo's **Releases** page, newest
  first. Download any older APK or extension zip from there to roll back.

### APK signing

Android only lets an update install over the existing app if both are signed
with the **same key**. So the workflow signs with one permanent release key,
stored as GitHub repository secrets:

| Secret | Contents |
|--------|----------|
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

- **Creating the key:** the repo will include `scripts/make_keystore.sh`,
  which runs `keytool` and prints the base64 to paste into the secrets.
  You run it once on your own machine, then keep the keystore file
  somewhere safe. If it's lost, future builds can't update the installed
  app; you'd have to uninstall and reinstall, which loses history.
- **Missing secrets:** branch builds fall back to a debug-signed APK, so the
  workflow still runs. Releases on `main` fail with a clear message instead,
  so an unsigned release never gets published by accident.

### Installing a build

- **Android:**
  - Download the APK from the release on your phone and open it.
  - Allow "install unknown apps" for your browser the first time.
  - Later builds install over the top and keep your history.
- **Chrome:**
  - Unzip into a fixed folder, e.g. `~/read-deeper-extension/`, and use
    **Load unpacked** at `chrome://extensions` once, in developer mode.
  - For each new build, unzip over the same folder and press **Reload** on
    the extension card.
  - Settings and history survive this because they live in Chrome's storage,
    not the folder.

## 9. Build phases

0. **Prompt and format.**
   - Write `shared/system-prompt.md` and the response-format spec.
   - Add `scripts/try_prompt.mjs`, which runs sample lookups through
     `z-ai/glm-5.3-flash` and optionally other models for comparison. It
     reuses the extension's own prompt-building code. The samples cover
     medical, code, philosophy and a whole sentence, including a
     same-channel sequence and a come-back-tomorrow case.
   - Tune the prompt until the `CHANNEL:` line and the first-sentence gist
     are reliable.
   - **Result (first run):**
     - all 8 lookups went to the expected channel, including returning to
       Python a day later;
     - answers referred back to earlier lookups;
     - answers were 64–100 words against an 80-word target;
     - each lookup cost about $0.0001;
     - text usually started appearing in 1–3 s, with outliers of 8 s and
       20 s from the provider.
1. **Chrome extension + CI.**
   - The `build.yml` workflow, the `VERSION` file and the signing script go
     in first. Every later change then produces a numbered build.
   - Context menu, overlay, streaming, popup search, options.
   - Channels: auto, pinned, and correcting a misfile.
2. **Android app.**
   - Share and select-text entry points, dialog, main screen search,
     settings, channels.
   - First signed APK published by the workflow as a GitHub Release.
   - Both clients ship with the editable query box and follow-ups from the
     start.
3. **Polish.**
   - Channel manager (rename, merge, delete).
   - History browsing, including reopening a lookup's thread.
   - Error states: no key, no credit, rate-limited, offline.

## 10. Decisions so far

- **Default model:** `z-ai/glm-5.3-flash`. Changeable from the dropdown.
- **Answer length:** a setting, default 80 words.
- **Follow-ups:** a per-lookup thread. Only the original lookup feeds the
  channel roster.
- **Query box:** the selection sits at the top of every lookup screen and can
  be edited to re-explain.
- **Builds:** GitHub Actions. Every push to `main` publishes a release
  numbered `0.1.<build>`.

## 11. Markdown history (Android)

Added after the first release:

- **What it does:** every lookup becomes a Markdown note in a folder you choose
  with the system folder picker. That folder can be anywhere the phone can
  write, such as a synced Obsidian vault, and the app needs no storage
  permission.
- **Off by default:** with no folder set, nothing is written.
- **File name:** `YYYY-MM-DD HHmm <term>.md`. It is fixed at the first export
  and stored on the lookup, so later changes rewrite the same file.
- **Contents:**
  - YAML front matter: term, channel, date, source, model, `tags: [read-deeper]`;
  - the term as a heading, the channel and source, the surrounding text as a
    quote, the explanation, and a *Follow-ups* section.
- **When the note is rewritten:** on re-explain, follow-up, moving the lookup
  to another channel, and renaming or merging its channel.
- **Deleting:** deleting lookups or channels in the app leaves their notes
  alone. They're your history.
- **Chrome:** not supported. Extensions can only write inside the Downloads
  folder, which doesn't suit an automatic history record.

