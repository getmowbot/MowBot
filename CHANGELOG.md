# Changelog

What changed in each version of MowBot. The version is the desktop app's: each one is a [GitHub release](https://github.com/getmowbot/MowBot/releases) with its installers. The hub, the web app and the mobile app move with it; update a server with `sudo mowbot update`.

The release workflow publishes the section of the version it builds as the release notes.

## Unreleased

### One memory for all your bots
- **What you tell one bot, every bot knows.** Your email, your birthday, the artists you like, the app you listen to music in, a competition on Saturday: a bot keeps it as soon as you mention it, without asking or saying so, and every other bot finds it in its prompt. A fact that changes replaces the old one; passwords and codes go to the vault, never to the memory.
- **Bots work on their own.** Before asking you something, a bot looks for the answer: what it knows of you, the vault, your files, your connected services, the web. It asks only what it truly cannot find, never makes things up, and keeps working on what doesn't depend on your answer.
- The memory works unseen: the apps show neither what it holds nor a bot keeping something. The hub's logs record each fact kept or forgotten.

### Bots look after you, quietly
- **Initiatives.** A bot plans what will help you at the right time (a reminder the evening before your competition, the route, your flight's check-in) and comes back to you then, on its own: you only see what it does, a notification, a question, a message. Nothing shows in your Routines or in the conversation before that; the hub's logs record each one.
- **The Chef's watch.** Twice a day by default (or every two hours, or never: Proactivity → Chef's watch), the Chef goes through your mail, your calendar and what it knows of you, tells you what matters, prepares what it can and asks you before acting. It respects quiet hours, stays out of your Routines, and leaves no trace when there is nothing to say.
- A bot whose mission meets your tastes tells you what's new (a music bot, the new album of an artist you like, with a link that opens in your music app).

### The mobile app, redone
- **Light and dark themes**, or the phone's, from Settings → Appearance. Liquid Glass, blur, the tab bar and the keyboard follow.
- **The chat's header** as in a group chat: the bot's face in the middle, its name in a capsule under it, round back and ⋯ buttons; what the bot is doing shows under its name while it works.
- **A bot's question opens as a native sheet**: the photo, what it found, a link, and its answers as big buttons; answer, write your own, keep it for later, or dismiss it. It opens by itself when you get to the chat (from its notification, for instance); above the message field it stays a line to reopen it.
- **Fold a team** in the bot list to see only its row; the app remembers it.
- **The message field as on the web**: a round lens of glass with a slow light along its edge, brighter while you write, and the white send and mic buttons with their sweeping reflection. The bot's face at the top of the chat is bigger.

### Questions that help you decide
- A bot asking you something can join a few lines, a picture (a file of its PC or a web picture) and a link: "The sneakers are down to €89 — order them?", with the photo and the page. The web shows them on the question's card.

### Bots search the web without their PC
- **web_search and web_read**: a bot searches the web and reads public pages from the hub, without turning on its computer, and so do bots that have none. Pages come back as their main text, with headings, lists and links.
- The search goes to DuckDuckGo by default (free, but it often blocks automated searches: bots then use their PC's browser), or to **Brave Search** or **Tavily** with a free API key, set in Tools → Web search.
- The hub never fetches local addresses for a bot (your network, its own machine), not even through a redirect or a name that points there.

### Fixes
- **Voice messages** no longer fail to transcribe on a flaky connection: the first one downloads the Whisper model, and a download cut short is now tried again.

### Pick each team's computer
- **With a desktop or the command line.** A team's PC runs Ubuntu with its desktop (you watch it and take control), or without a screen: lighter, with a shell, files and a browser without a window. Pick it when you create the team (the Chef too) or on the team's page.
- **Graphics cards.** Give a PC the hub machine's NVIDIA cards, all of them or some: CUDA, NVENC and compute work inside it, and several PCs can share a card. It needs the NVIDIA Container Toolkit on the host (Docker Desktop on Windows has it with WSL 2).
- A running PC takes a new setup when it restarts, from the team's page.
- Bots on a PC without a screen don't get the screenshot, mouse and take-control tools; their prompt says what their PC has, cards included.

### Smaller things (web app)
- The sidebar's "Desktop" is now **Computer**.
- A bot's question is a new card: its answers as pills, and an × to **close it without answering** (the bot isn't told).
- **Drafts stay.** What you type to a bot, or to the Chef from the home page, is still there when you come back.
- Opening a bot's conversation marks its notifications as seen.

### See the mission, not the chatter (web app)
- **A mission board per team:** the goal, a progress bar, who works on which step right now (with what they do this very moment), every step with what it delivers, and the deliverables, delivered and coming, with links to open them (a file of the team, a preview).
- **Deliverables in the plan.** The lead names what each step delivers; a bot that finishes a step says what it delivered and where. A finished task fills its step on its own.
- **"What's the plan?"** gets the plan itself in the conversation, a card that stays up to date, and a sentence or two instead of a wall of text.
- The mission in one line under the chat header of a team's bots.
- Bots keep their answers to five lines unless you ask for details, and start long ones with a sentence that sums them up; earlier long answers fold to it.

### Bots that keep going
- **No more "Continue".** A bot that reaches its step limit goes on by itself, up to 5 times in a row. Past that, its lead (or the Chef) is told and decides: tell it to go on, help it, split its work or stop it. Nothing goes on while the bots are paused.
- **See what a bot thinks about.** OpenAI models (API key or ChatGPT plan) now share a short summary of their reasoning: "Thinking · Comparing the two layouts", in the conversation and next to the bot's name. Bots are told not to think for long without acting.

### A new look (web app)
- **Light and dark themes**, or the system's, from the sidebar.
- **Three panels:** the bots, the conversation, and the bot's PC live and small on the right, to watch it or take control, with the team's mission under it. Docked on wide screens (hide it if you like), over the conversation on smaller ones.
- Primary buttons are white pebbles, lit from above, with a reflection on hover (ink on the light theme); the send button is round.
- The message box is a pill of glass, bulging, with a slow light along its edge.

### More model providers
- **Anthropic**, with an API key from the Claude Console: Claude's Messages API with prompt caching, and refusals rerun on another Claude model. A Claude Pro/Max subscription can't be used: Anthropic keeps it for its own apps.
- **OpenRouter, Google Gemini, xAI (Grok), DeepSeek, Mistral, Groq and Ollama** ready to pick, their address filled in.
- Each provider shows its company's logo, in Models and in `/model`; the page to add one is a grid of them.

## 0.2.5 — 2026-10-22

### Your projects, mirrored
- **Live two-way mirror.** A project a bot works in is copied into the bots' workspace and kept in sync with your folder in both directions, within seconds. Bots keep working when your computer is off; your folder catches up on its own when it comes back.
- **Nothing gets lost.**
  - Every change to your folder first checks that you didn't change the file meanwhile.
  - Deleted files go to your system's trash.
  - A mass deletion is put back instead.
  - When you and a bot changed the same file, your version stays and the bot's is kept next to it (you get a notification).
- **Add a folder from the conversation.** The project chip has "Add a folder…": in the desktop app it opens the folder picker and makes the folder the bot's project; from the web or your phone, "Choose on <computer>" opens the picker on that computer.
- `.git`, dependencies and builds are never copied; git repositories are updated in place.

### See what's going on
- **Who does what.** Each bot says what it is working on ("I'm building the home page"), with its live action under it ("Running npm"), in the sidebar, the org chart and the team pages.
- The chat header shows the bot's role instead of its model; `/model` switches the model.
- **A plan of attack per team.** The lead (or the Chef) writes the goal and the steps, who does each one and where it stands; steps follow their tasks. It is on the team page, live.

### Previews of work in progress
- A bot running a website on its PC shares it as a **private link** that opens on your phone or any computer, on your network or from the internet, with hot reload and no public tunnel.
- The link is a secret that turns into a cookie on the first visit. Your hub's cookies never reach the bot's server.
- Servers: open the preview ports (8800-8819 by default) in your firewall.

### Teams
- Delete a team with its bots.
- Clear every conversation of a team at once, for instance before a new project. The Chef can do it too.

### Desktop app
- Folder watcher, safe writes and deletions, and a folder picker the hub can open: what the mirror needs.

## 0.2.4 — 2026-10-22

### Your projects
- **Work lands in your folder.** A task given in a project carries it: it becomes the project of the bot that does it, and messages between bots say which project they're about. Bots no longer rebuild your project elsewhere in their workspace.
- Bringing work back from a bot's PC now writes straight into a folder that is not a git repository (it used to refuse). Files you changed meanwhile are left alone.

### Calmer conversations
- Messages that reach a bot while it works show above its answer, where it read them.
- Bots' answers to each other fold to their first sentence; bots give you results rather than progress reports.
- Long conversations stay light: the last 40 messages, earlier ones as you scroll up.

### Desktop app
- Writes the binary files (pictures…) that bots bring back into a project.

## 0.2.3 — 2026-10-21

### Use your ChatGPT plan
- **OpenAI with a ChatGPT account**, a new model provider: sign in with ChatGPT from the desktop app, and your bots run on your plan.
- The hub refreshes the sign-in itself; at the usage limit, bots move to their fallback model.

### Conversations
- **Voice messages**, transcribed on your hub by a local Whisper model; the transcript sits under the waveform.
- **Attachments:** photos, documents, any file, by paperclip, drag and drop or paste. Bots see the pictures.
- Messages between bots show as one line ("Message from Nova · the gist") and open large on click.

### MCP servers
- Servers that run as a command now run on their own computer on the hub's host, and the Chef manages them (add, change, remove, set up). Bots use them only through their tools.

### Desktop app
- "Sign in with ChatGPT": the sign-in happens on your computer, and the app hands the result to your hub.

## 0.2.2 — 2026-10-21

- **Pick the project a bot works in from the conversation:** the project chip, `/project`, or `@project`.

### Desktop app
- **Native window on macOS:** the system's traffic lights and title bar instead of the custom buttons.

## 0.2.1 — 2026-10-21

First public release.

### Desktop app
- **Your computer's folders as projects**, even when your hub is on a remote server. Bots read, edit, search and run commands there: commands with your approval, or freely in auto mode.
- Bots can copy a project to their PC to install and test it, and bring their changes back as a git branch of your repository.
- Frameless window with its own buttons; the app keeps running in the tray.
- Choose your hub on first launch; change it from Profile → Change hub, or with `--hub`.
- **Updates itself**, with signed updates.
- Installers for Windows (`.exe`, `.msi`), macOS (`.dmg`) and Linux (AppImage, `.deb`, `.rpm`), and a one-command install on Linux.

### Hub and apps
- `@` mentions (a bot, a team, a file) and `/` commands (`/stop`, `/clear`, `/pc`, `/files`, `/mcp`…).
- MCP servers: remote ones with OAuth, or local ones.
- When a bot needs you on its PC (a login, a code), it asks with a card in the conversation, which opens the screen.
- More expressive bot characters.
- Change your hub's password from your profile.
- Free software under the AGPL-3.0.
