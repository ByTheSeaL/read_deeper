# Read Deeper

Look up words, phrases and sentences while you read technical writing, code,
philosophy and anything else, and get a short, plain explanation so you can
keep going. It works through:

- **Android:** highlight text, then pick **Read Deeper** from the text-selection
  menu or from **Share**. Or open the app and type into the search box.
- **Chrome:** highlight text, then right-click and choose **Explain with Read
  Deeper**, or press **Alt+Shift+D**. Or click the toolbar icon and type.
- **Obsidian:** select text in a note, then right-click → **Explain with Read
  Deeper**, or run the command *Read Deeper: Explain the selected text* (works
  in reading view and PDFs too; give it a hotkey). Or open the panel from the
  ribbon and type.

Explanations come from the model you choose through
[OpenRouter](https://openrouter.ai) (default `z-ai/glm-5.3-flash`, about
$0.0001 a lookup). Each lookup is filed under a **channel**, an area of
knowledge such as "Python" or "Cardiology". Later lookups in a channel build on
what you've already looked up there, even days later. The channel box shows
which channel a lookup went into. Type a name there to pin a channel or to move
a lookup to another one.

**Markdown history (Android and Obsidian):** choose a folder in Settings → *Markdown
history folder*, e.g. one inside an Obsidian vault, and every lookup is saved
there as a Markdown note: the term, its channel, the explanation and any
follow-ups, with YAML front matter. The note is updated when the lookup is
re-explained, followed up, moved to another channel, or its channel is
renamed. **Export all now** writes notes for the lookups made before you set
the folder. With no folder set, nothing is written.

There is no server: every client talks to OpenRouter directly. Settings, history
and channels are kept separately on each device, except that Obsidian's are in
the vault, so Obsidian on every synced device shares them.

See [PLAN.md](PLAN.md) for the design.

## Install

Builds come from GitHub Actions. Every push to `main` publishes a release named
`v0.1.<build>` on the **Releases** page with both files attached. Builds from
other branches are attached to their workflow run under **Actions**.

**Android:**

1. On your phone, download `read-deeper-<version>.apk` and open it.
2. The first time, allow your browser to "install unknown apps".
3. Later builds install over the top and keep your history, as long as they're
   signed with the same key (see **One-time setup** below).

**Chrome:**

1. Unzip `read-deeper-extension-<version>.zip` into a folder you'll keep, e.g.
   `~/read-deeper-extension/`.
   Already installed as Read Depth? Keep unzipping into your old folder:
   Chrome ties an unpacked extension's settings and history to its folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and choose that folder.
3. For a new build, unzip over the same folder and click **Reload** on the
   extension's card. Settings and history are kept.

**Obsidian:**

1. Unzip `read-deeper-obsidian-<version>.zip` into your vault's
   `.obsidian/plugins/` folder, so you get `.obsidian/plugins/read-deeper/`.
   With Syncthing, every synced device gets it.
2. Settings → Community plugins → enable **Read Deeper**, on each device.

Then, in any of them, open **Settings**, paste your OpenRouter API key and press
**Test**.

## One-time setup: the Android signing key

Android installs an update only if it's signed with the same key as the
installed app, so releases are signed with one permanent key that is kept in
GitHub secrets:

1. Run `scripts/make_keystore.sh` on your own machine. It needs `keytool`, which
   comes with any JDK.
2. Back up the `.jks` file it creates. If it's lost, future builds can't
   update the app; you'd have to uninstall, which loses your history.
3. Add the four values it prints as repository secrets (**Settings → Secrets
   and variables → Actions**).

Until the secrets exist, branch builds are debug-signed, and builds on `main`
fail with a message saying the key is missing.

## Layout

| Path | What it is |
|------|------------|
| `shared/system-prompt.md` | The system prompt, the one copy to edit |
| `shared/test-cases.json` | Cases both clients' unit tests run, so they behave the same |
| `chrome-extension/` | MV3 extension: `background.js` (OpenRouter, history), `panel.js` (the lookup UI), `overlay.js`, popup, options |
| `chrome-extension/lib/core.js` | Prompt building, reply parsing, channel bookkeeping, with no browser APIs |
| `android/` | Kotlin app; `Core.kt` is the port of `core.js` |
| `scripts/` | Prompt sync and test, signing key, icons |
| `.github/workflows/build.yml` | Builds, tests, versions and releases both clients |
| `VERSION` | `major.minor`; CI appends the build number |

## Development

```bash
# After editing shared/system-prompt.md (CI fails if you forget)
scripts/sync_prompt.sh

# Extension unit tests
cd chrome-extension && TZ=UTC node --test test/*.test.js

# Android unit tests and APK (needs the Android SDK; set sdk.dir in android/local.properties)
cd android && ./gradlew testReleaseUnitTest assembleRelease

# Try the prompt against real models: a scripted series of lookups across
# Python, cardiology and Kant, including coming back to a topic a day later
OPENROUTER_API_KEY=… node scripts/try_prompt.mjs [model] [--words 80] [--effort low]

# The same, through the Android client's own code (skipped without a key)
cd android && OPENROUTER_API_KEY=… ./gradlew testReleaseUnitTest --tests '*OpenRouterLiveTest*'

# Regenerate the extension icons
python3 scripts/make_icons.py
```

To test the extension, load `chrome-extension/` unpacked.
