# Hivescope

A local dashboard that watches every Claude Code session on your computer: chats in the desktop app and the terminal, their subagents, advisor calls, models, tools and tokens, updating live.

It reads the transcripts Claude Code already writes to `~/.claude/projects`, so there's nothing to install or configure in Claude Code itself.

![Hivescope overview: live sessions, output tokens per day by model, routing share, activity heatmap, advisor consultations and the live log](docs/overview.png)

## Features

**Overview**
- **Top bar:** sessions waiting for you, live sessions, subagents running, advisor calls this week and output tokens today.
- **Active now:** every session that did something in the last 30 minutes, with what it's doing right now.
- **Model mix:** output tokens per day by model.
- **Routing check:** the share of work each model did, so you can see whether your routing to cheaper models actually happens.
- **When you work:** a weekday-by-hour heatmap of tool calls.
- **Advisor consultations:** every advisor call, with what Claude wrote just before asking.
- **Live log:** every session's actions as they happen, newest first.

**Sessions**
- A searchable list, grouped by project, status or day (or not at all), with collapsible groups. Hivescope remembers your choice.
- Badges on each session for running subagents, advisor calls, errors, messages with other sessions, a context that's getting full, and a session that's waiting for you.

**One session**

![A session in Hivescope: the lead model, its advisor and the subagents it delegated to](docs/session.png)

- Its numbers: lead and advisor models, context size, prompts, tool calls, subagents, errors and output tokens.
- **Hive flow:** the lead, its advisor and every subagent it delegated to, with what each one is doing now.
- A timeline with the main session and each subagent in its own lane, the subagents table, top tools, tokens by model and the session log.

**Free space:** finds the disk space agents left behind and frees it.

**Desktop app**
- Keeps watching from the tray (Windows) or menu bar (macOS) when you close the window.
- **Notifications** when a subagent finishes or a session is waiting for you. Clicking one opens that session.
- **Start with Windows / Open at login:** starts hidden in the tray.
- **Automatic updates:** installs new versions by itself, with no installer to click through (see [Updates](#updates)).

## Install

Download the newest installer from the [Releases page](../../releases/latest):

| System | File |
|---|---|
| Windows 10 / 11 | `Hivescope-Setup-<version>.exe` |
| macOS on Apple silicon (M1 and later) | `Hivescope-<version>-arm64.dmg` |
| macOS on Intel | `Hivescope-<version>-x64.dmg` |

### Windows

Run the installer. It isn't code-signed, so the first time Windows SmartScreen says "Windows protected your PC". Choose **More info**, then **Run anyway**.

### macOS

Open the `.dmg` and drag **Hivescope** into **Applications**. The app isn't notarized by Apple, so macOS blocks it the first time you open it:

1. Open Hivescope once. macOS says it can't verify the app.
2. Open **System Settings › Privacy & Security**, scroll down and click **Open Anyway**.

If macOS says the app "is damaged and can't be opened", run this once in Terminal, then open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Hivescope.app
```

You only do this on the first install. Updates install without any warning.

## Updates

The desktop app checks for a new version a few seconds after it starts, and then every 6 hours. Nothing downloads until you say so. When there is one:

1. The top bar shows **⬆ Install 0.6.5** (with the new version). The tray menu has the same option, and you get a notification.
2. Click it. The update downloads, and the top bar shows **Updating …%**.
3. The download is checked against the release's checksum.
4. Hivescope closes, installs the new version silently and opens again.

To check yourself, click the version button in the top bar (**↻ v0.6.4**) or choose **Check for updates** in the tray menu. The bell next to it turns Hivescope's notifications on or off.

Updates come from this repository's latest GitHub release, so the repository must be public.

## Run it in your browser

You need Node.js 20 or newer.

```bash
npm install
npm start
```

Then open http://127.0.0.1:4317. On Windows you can also double-click `start.cmd`, which does both and opens the page.

The first start reads the last 7 days of transcripts, which can take several seconds if you have gigabytes of them. After that it only reads new lines as they're written.

Options:

```bash
npm run serve -- --days 14     # a longer window, without rebuilding the page
npm run serve -- --port 4318   # another port
```

## Development

```bash
npm install
npm run dev        # server + hot-reloading page on http://127.0.0.1:5317
npm run desktop    # the desktop app, without installing it
npm test           # tests
npm run typecheck  # type checks
```

### Releases

Installers are built by GitHub Actions, not on your computer:

1. Raise `version` in `package.json`, for example to `0.6.0`, and commit it.
2. Tag the commit and push the tag:

   ```bash
   git tag v0.6.0
   ```

   ```bash
   git push origin v0.6.0
   ```

3. The **Release** workflow builds the Windows installer and both macOS disk images. It then publishes them as a GitHub release, together with the `windows.json` and `mac.json` manifests that installed copies update from. The tag must match the version in `package.json`, or the build stops.

To try a build without publishing it, run the **Release** workflow by hand from the **Actions** tab. Its installers are kept as workflow artifacts.

To build an installer locally anyway, use `npm run dist:win` on Windows or `npm run dist:mac` on a Mac. A local build doesn't update itself unless you set `HIVESCOPE_UPDATE_REPO=owner/repo` when building it.

## Good to know

- **The advisor's replies can't be shown.** Claude Code stores them encrypted. Hivescope shows what Claude wrote just before asking, or its last action if it wrote nothing.
- **The transcript format is internal to Claude Code** and isn't documented, so a Claude Code update could break parts of Hivescope. Everything that depends on the format is in `server/reader.ts`.
- **Your chats stay on your computer.** The server listens on 127.0.0.1 only and refuses requests addressed to any other host. The desktop app runs the same server inside itself. Don't change it to listen on your network: it exposes the content of every chat.
- **The only thing that goes online is the update check.** The desktop app downloads the release manifest and installers from GitHub. Nothing about your sessions is sent.
- **Token totals count what was processed.** When Claude consults the advisor mid-response, the context is processed twice and both passes are counted. "Context now" shows a single pass.
- **A subagent counts as running** until its transcript is marked finished, or it has had no activity for 30 minutes.
