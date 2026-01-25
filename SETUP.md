# Slack Bot Setup Guide

This guide walks you through creating and configuring a Slack app for the Claude Code Slack Bot from scratch.

## Prerequisites

- A Slack workspace where you have admin permissions (or permission to install apps)
- Node.js 18+ installed
- The Claude Code Slack Bot code cloned to your machine
- Native dependencies installed (see [Install Native Dependencies](#install-native-dependencies))

## Table of Contents

1. [Install Native Dependencies](#install-native-dependencies)
2. [Create a Slack App](#step-1-create-a-slack-app)
3. [Enable Socket Mode](#step-2-enable-socket-mode)
4. [Configure Bot Token Scopes](#step-3-configure-bot-token-scopes)
5. [Subscribe to Events](#step-4-subscribe-to-events)
6. [Enable Interactivity](#step-5-enable-interactivity)
7. [Install App to Workspace](#step-6-install-app-to-workspace)
8. [Get Your Tokens](#step-7-get-your-tokens)
9. [Configure Environment](#step-8-configure-environment)
10. [Run the Bot](#step-9-run-the-bot)
11. [Invite Bot to Channels](#step-10-invite-bot-to-channels)

---

## Install Native Dependencies

The bot uses two npm packages that require native system libraries:

| Package | Purpose | Required |
|---------|---------|----------|
| **Puppeteer** | Markdown → PNG image conversion | Optional (graceful fallback) |
| **Sharp** | Image resizing for file uploads | Required for image uploads |

### Quick Install

```bash
make setup-tools    # Install native dependencies for your OS
make verify-tools   # Verify all dependencies are installed
```

### macOS

macOS generally works out of the box. Puppeteer auto-downloads Chromium.

```bash
# Optional: Install via Homebrew if you have issues
brew install --cask chromium
```

### Ubuntu/Debian Linux

**Ubuntu 24.04+:**
```bash
sudo apt-get update && sudo apt-get install -y \
  libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
  libnss3 libnspr4 libcups2 libxss1 libxrandr2 libasound2t64 libatk1.0-0 \
  libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
  libcairo2 libfontconfig1 libdbus-1-3 libexpat1 libglib2.0-0
```

**Ubuntu 22.04 and earlier:**
```bash
sudo apt-get update && sudo apt-get install -y \
  libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
  libnss3 libnspr4 libcups2 libxss1 libxrandr2 libasound2 libatk1.0-0 \
  libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
  libcairo2 libfontconfig1 libdbus-1-3 libexpat1 libglib2.0-0
```

**Note:** Ubuntu 24.04 renamed `libasound2` to `libasound2t64` for 64-bit time support.

### Verify Installation

```bash
make verify-tools
```

Or manually check for missing Chromium dependencies:
```bash
ldd ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome 2>/dev/null | grep "not found"
```

If no output, all dependencies are installed.

---

## Step 1: Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Select **From scratch**
4. Enter your app details:
   - **App Name:** `Claude Code Bot` (or your preferred name)
   - **Pick a workspace:** Select your Slack workspace
5. Click **Create App**

You'll be taken to your app's configuration page.

---

## Step 2: Enable Socket Mode

Socket Mode allows your bot to receive events over a WebSocket connection instead of requiring a public URL.

1. In the left sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** to ON
3. You'll be prompted to create an App-Level Token:
   - **Token Name:** `socket-mode-token` (or any name)
   - **Scopes:** Add `connections:write`
4. Click **Generate**
5. **Copy and save the token** (starts with `xapp-`) - you'll need this later as `SLACK_APP_TOKEN`
6. Click **Done**

---

## Step 3: Configure Bot Token Scopes

Bot Token Scopes define what your bot can do in Slack.

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll down to **Scopes** section
3. Under **Bot Token Scopes**, click **Add an OAuth Scope**
4. Add each of the following scopes:

| Scope | Description | Required For |
|-------|-------------|--------------|
| `app_mentions:read` | View messages that directly mention the bot | Receiving @mentions |
| `channels:history` | View messages in public channels the bot is in | Reading conversation history |
| `channels:manage` | Manage public channels and create new ones | Fork to new channel feature |
| `channels:read` | View basic info about public channels | Channel information |
| `chat:write` | Send messages as the bot | Posting responses |
| `chat:write.public` | Send messages to channels bot isn't a member of | Posting to any public channel |
| `files:read` | View files shared in conversations | Processing uploaded files |
| `files:write` | Upload, edit, and delete files | Sharing files and images |
| `groups:read` | View basic info about private channels | Private channel support |
| `im:history` | View messages in direct messages | DM conversation history |
| `im:read` | View basic info about direct messages | DM support |
| `im:write` | Start direct messages with people | Initiating DMs |
| `mpim:read` | View basic info about group DMs | Group DM support |
| `reactions:read` | View emoji reactions | Reading reactions |
| `reactions:write` | Add and edit emoji reactions | Adding reactions to messages |
| `users:read` | View people in a workspace | User information |

**Complete list to copy:**
```
app_mentions:read
channels:history
channels:manage
channels:read
chat:write
chat:write.public
files:read
files:write
groups:read
im:history
im:read
im:write
mpim:read
reactions:read
reactions:write
users:read
```

5. After adding all scopes, the page auto-saves. Verify all 16 scopes appear in the list.

---

## Step 4: Subscribe to Events

Events allow your bot to receive real-time notifications when things happen in Slack.

1. In the left sidebar, click **Event Subscriptions**
2. Toggle **Enable Events** to ON
3. Expand **Subscribe to bot events**
4. Click **Add Bot User Event** and add each of these events:

| Event | Description |
|-------|-------------|
| `app_mention` | User mentions your bot with @BotName |
| `channel_deleted` | A channel was deleted (for session cleanup) |
| `message.channels` | Messages in public channels |
| `message.groups` | Messages in private channels |
| `message.im` | Direct messages to the bot |
| `message.mpim` | Messages in group DMs |

5. Click **Save Changes** at the bottom

---

## Step 5: Enable Interactivity

Interactivity allows your bot to receive button clicks and other interactive components.

1. In the left sidebar, click **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. For **Request URL**, enter a placeholder URL (Socket Mode doesn't require a real URL):
   ```
   https://localhost:3000/slack/events
   ```
4. Click **Save Changes**

---

## Step 6: Install App to Workspace

1. In the left sidebar, click **Install App**
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. After installation, you'll see your **Bot User OAuth Token**

---

## Step 7: Get Your Tokens

You need two tokens to run the bot:

### Bot User OAuth Token (SLACK_BOT_TOKEN)

1. In the left sidebar, click **OAuth & Permissions**
2. Find **Bot User OAuth Token** at the top of the page
3. Click the **Copy** button next to the token (starts with `xoxb-`)

### App-Level Token (SLACK_APP_TOKEN)

1. In the left sidebar, click **Basic Information**
2. Scroll down to the **App-Level Tokens** section
3. Click on your token name (e.g., "socket-mode-token") to expand it
4. Click the **Copy** button to copy the token (starts with `xapp-`)

If you didn't save the App-Level Token earlier:
1. In **App-Level Tokens** section, click **Generate Token and Scopes**
2. Enter a **Token Name** (e.g., "socket-mode-token")
3. Click **Add Scope** and select `connections:write`
4. Click **Generate**
5. Click **Copy** to copy the token, then click **Done**

---

## Step 8: Configure Environment

1. In your project directory, create a `.env` file:

```bash
cp .env.example .env
```

2. Edit `.env` and add your tokens:

```bash
# Required: Bot User OAuth Token (from OAuth & Permissions page)
SLACK_BOT_TOKEN=xoxb-your-bot-token-here

# Required: App-Level Token for Socket Mode (from Basic Information page)
SLACK_APP_TOKEN=xapp-your-app-token-here

# Optional: Signing secret (from Basic Information > App Credentials > Signing Secret)
SLACK_SIGNING_SECRET=your-signing-secret-here
```

**Where to find Signing Secret:**
1. Go to **Basic Information** in the left sidebar
2. Scroll to **App Credentials** section
3. Click **Show** next to **Signing Secret**
4. Click **Copy**

**Note:** The bot uses `dotenv` to load environment variables from `.env` at startup.

**Security:** Never commit `.env` to version control. It's already in `.gitignore`.

---

## Step 9: Run the Bot

1. Install dependencies:
```bash
make setup
```

2. Build the project:
```bash
make build
```

3. Start the bot:
```bash
make start
```

Or for development with auto-reload:
```bash
make dev
```

You should see output like:
```
[INFO] Bolt app is running!
[INFO] Socket Mode connection established
```

---

## Step 10: Invite Bot to Channels

The bot needs to be invited to channels before it can see messages there.

### Option A: Invite via Slack UI

1. Open the channel where you want to use the bot
2. Type `/invite @Claude Code Bot` (or your bot's name)
3. Press Enter

### Option B: Mention to Auto-Join

1. In any public channel, type `@Claude Code Bot hello`
2. The bot will be invited automatically (if `chat:write.public` scope is enabled)

---

## Verification

Test that everything is working:

1. Go to a channel where the bot is present
2. Type: `@Claude Code Bot /status`
3. You should see a response with session information

If you see an error or no response, check:
- Bot is running (check terminal output)
- Bot is in the channel (try `/invite @BotName`)
- Tokens are correct in `.env`
- All scopes are added (Step 3)
- Events are subscribed (Step 4)

---

## Troubleshooting

### "not_in_channel" Error

The bot needs to be in the channel to read/send messages.

**Solution:** Invite the bot with `/invite @BotName`

### "missing_scope" Error

A required OAuth scope is missing.

**Solution:**
1. Go to **OAuth & Permissions**
2. Add the missing scope
3. **Reinstall the app** (changes require reinstallation)

### Bot Doesn't Respond to @mentions

1. Check **Event Subscriptions** has `app_mention` event
2. Verify Socket Mode is enabled and connected
3. Check terminal for error messages

### "invalid_auth" Error

Your tokens may be incorrect or expired.

**Solution:**
1. Regenerate tokens from Slack API dashboard
2. Update `.env` with new tokens
3. Restart the bot

### Socket Mode Connection Fails

1. Verify `SLACK_APP_TOKEN` starts with `xapp-`
2. Check the App-Level Token has `connections:write` scope
3. Ensure Socket Mode is enabled in app settings

### Puppeteer/Chrome Errors on Linux

See [Install Native Dependencies](#install-native-dependencies) section above for installation commands.

Run `make verify-tools` to check for missing dependencies.

---

## Updating Permissions

If you need to add new scopes later:

1. Go to **OAuth & Permissions**
2. Add the new scope under **Bot Token Scopes**
3. Go to **Install App**
4. Click **Reinstall to Workspace**
5. Approve the new permissions

**Note:** Existing tokens remain valid after reinstallation.

---

## App Manifest (Alternative Setup)

For quick setup, you can use an app manifest. Create a new app and paste this manifest:

```yaml
display_information:
  name: Claude Code Bot
  description: Claude Code assistant for Slack
  background_color: "#4a154b"
features:
  bot_user:
    display_name: Claude Code Bot
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:manage
      - channels:read
      - chat:write
      - chat:write.public
      - files:read
      - files:write
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - channel_deleted
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

To use the manifest:
1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Select **From an app manifest**
4. Select your workspace
5. Paste the YAML manifest
6. Click **Create**
7. Continue from [Step 6](#step-6-install-app-to-workspace)

---

## Next Steps

- Read [CLAUDE.md](./CLAUDE.md) for development guide
- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details
- Read [README.md](./README.md) for usage instructions
