# Mac Mini Setup Guide — SMC Trading Bot

**This guide assumes you have never used Terminal before.** Follow each step exactly as written. If something doesn't look right, stop and ask for help before continuing.

---

## PART 1: Unbox and Configure Your Mac Mini

### Step 1: Plug it in

1. Connect the Mac Mini to power
2. Connect it to your monitor with HDMI (or use it headless later — but you need a monitor for initial setup)
3. Connect a keyboard and mouse
4. Connect an ethernet cable (recommended) OR use WiFi
5. Press the power button on the back

### Step 2: macOS Initial Setup

Follow the on-screen prompts:
- Choose your language
- Connect to WiFi (if not using ethernet)
- Create your user account (remember your password — you'll need it)
- Skip Apple ID if you want (not required)
- Skip all the optional stuff (Siri, analytics, etc.)

### Step 3: Prevent the Mac from Sleeping

This is critical — if it sleeps, your bot stops.

1. Click the **Apple logo** (top-left corner) → **System Settings**
2. Click **Energy** in the left sidebar
3. Turn ON: **"Prevent automatic sleeping when the display is off"**
4. Turn ON: **"Start up automatically after a power failure"**
5. Close System Settings

### Step 4: Keep it Updated (but not automatically)

1. Apple logo → **System Settings** → **General** → **Software Update**
2. Click the small **ⓘ** icon next to "Automatic Updates"
3. Turn OFF: **"Install macOS updates"** (you'll do this manually on weekends)
4. Keep ON: **"Install Security Responses and system files"**

---

## PART 2: Install the Tools

### Step 5: Open Terminal

Terminal is where you type commands. It's like texting your computer.

1. Press **Command + Space** (opens Spotlight search)
2. Type: **Terminal**
3. Press **Enter**
4. A white/black window appears with a blinking cursor — this is Terminal

**Tip:** Right-click the Terminal icon in your Dock → **Options** → **Keep in Dock** (so you can find it easily later)

### Step 6: Install Homebrew (a tool installer)

Copy and paste this ENTIRE line into Terminal, then press Enter:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

- It will ask for your password — type it (you won't see characters appear, that's normal) and press Enter
- Wait 2-5 minutes for it to finish
- When it's done, it will show some instructions about adding to PATH. Copy and paste those lines too.

**To verify it worked, type:**
```
brew --version
```
You should see something like "Homebrew 4.x.x"

### Step 7: Install Deno (runs your bot code)

```
brew install deno
```

Wait for it to finish. **Verify:**
```
deno --version
```
You should see "deno 1.x.x" or "deno 2.x.x"

### Step 8: Install Node.js and PM2 (keeps your bot running forever)

```
brew install node
```

Wait for it to finish. Then:
```
npm install -g pm2
```

**Verify:**
```
node --version
pm2 --version
```

### Step 9: Install Git (for downloading your code)

Git might already be installed. Check:
```
git --version
```

If it says "command not found", install it:
```
brew install git
```

---

## PART 3: Download Your Bot Code

### Step 10: Clone your repository

```
cd ~
git clone https://github.com/aganatsu/connect-assist.git
cd connect-assist
```

You should now see something like:
```
username@Mac-Mini connect-assist %
```

### Step 11: Verify the files are there

```
ls local-runner/
```

You should see:
```
README.md            .env.local.example   runner.ts
```

---

## PART 4: Set Up Your API Keys

### Step 12: Create your environment file

```
cp local-runner/.env.local.example local-runner/.env.local
```

### Step 13: Find your Supabase keys

1. Open Safari (or Chrome)
2. Go to: **https://supabase.com/dashboard**
3. Log in to your account
4. Click on your project (istpcfaokubxlualybhp)
5. In the left sidebar, click **Settings** (gear icon)
6. Click **API**
7. You need TWO values:
   - **Project URL** — looks like `https://istpcfaokubxlualybhp.supabase.co`
   - **service_role key** (under "Project API keys") — the LONG one labeled "service_role" (click "Reveal" to see it)

**⚠️ WARNING:** The service_role key has FULL access to your database. Never share it with anyone.

### Step 14: Edit the environment file

```
nano local-runner/.env.local
```

This opens a text editor in Terminal. You'll see:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...your-service-role-key...
```

- Use arrow keys to move the cursor
- Delete the placeholder text and paste your real values
- **To paste:** press **Command + V**

When done:
- Press **Control + X** (to exit)
- Press **Y** (to confirm save)
- Press **Enter** (to confirm filename)

### Step 15: Verify your env file

```
cat local-runner/.env.local
```

You should see your real Supabase URL and key. If it looks right, continue.

---

## PART 5: Disable the Cloud Scheduler

**IMPORTANT:** You must disable the cloud scheduler BEFORE starting the local one, otherwise your bot will scan twice (double trades!).

### Step 16: Pause Supabase cron jobs

1. Go to your **Lovable dashboard**: https://connect-kindly-assist.lovable.app/settings
2. Open **Bot Configuration**
3. Look for a "Scheduled Tasks" or "Auto Scan" section
4. **Pause** or **disable** the auto-scan

OR (if you have access to Supabase SQL editor):
1. Go to Supabase Dashboard → SQL Editor
2. Run: `SELECT cron.unschedule('bot-scanner-cron');`

**If you're unsure how to do this, ask me and I'll walk you through it.**

---

## PART 6: Start Your Bot

### Step 17: Test run (to make sure it works)

```
cd ~/connect-assist
deno run --allow-all local-runner/runner.ts
```

You should see:
```
═══════════════════════════════════════════════════════
  SMC Trading Bot — Local Runner
═══════════════════════════════════════════════════════
  Supabase: https://istpcfaokubxlualybhp.supabase.co
  Tasks: 8 active
  Market: 🟢 OPEN (or 🔴 CLOSED if it's weekend)
═══════════════════════════════════════════════════════

  Schedule:
    ● Bot Scanner — every 5m
    ● Trade Management — every 1m
    ● Zone Confirmation (Fast) — every 1m
    ● Outcome Tracker — every 1h
    ...
```

Wait 1-2 minutes. You should see:
```
[10:05:23 AM] Running: Trade Management
  ✅ bot-scanner/manage completed
[10:05:23 AM] Running: Zone Confirmation (Fast)
  ✅ zone-confirmation-scanner/scan completed
```

**If you see ✅ messages, it's working!**

Press **Control + C** to stop it (we'll set it up properly next).

### Step 18: Set up PM2 (keeps bot running forever, even after restart)

```
cd ~/connect-assist
pm2 start "deno run --allow-all local-runner/runner.ts" --name smc-bot --cwd $(pwd)
```

You should see a table showing "smc-bot" with status "online".

### Step 19: Make it start automatically on boot

```
pm2 save
pm2 startup
```

PM2 will print a command that starts with `sudo ...`. **Copy that entire line and paste it back into Terminal, then press Enter.** It will ask for your password.

### Step 20: Verify everything is running

```
pm2 status
```

You should see:
```
┌─────┬──────────┬─────────────┬─────────┬─────────┬──────────┐
│ id  │ name     │ namespace   │ version │ mode    │ status   │
├─────┼──────────┼─────────────┼─────────┼─────────┼──────────┤
│ 0   │ smc-bot  │ default     │ N/A     │ fork    │ online   │
└─────┴──────────┴─────────────┴─────────┴─────────┴──────────┘
```

**To see live logs:**
```
pm2 logs smc-bot
```

Press **Control + C** to stop watching logs (the bot keeps running).

---

## PART 7: Access from Your Phone (Optional)

### Step 21: Install Tailscale

1. Go to: https://tailscale.com/download/mac
2. Download and install the app
3. Open Tailscale, sign in with Google/GitHub
4. On your **phone**, install the Tailscale app (iOS or Android)
5. Sign in with the same account

Now your phone can reach your Mac Mini from anywhere. Your Mac Mini's Tailscale IP will look like `100.x.x.x`.

### Step 22: Run the dashboard (optional — for viewing from phone)

If you want to see the dashboard from your phone:

```
cd ~/connect-assist
npm install -g pnpm
pnpm install
pnpm dev
```

Then on your phone browser, go to: `http://100.x.x.x:5173` (replace with your Tailscale IP)

---

## DAILY OPERATIONS

### Check if bot is running:
```
pm2 status
```

### See recent activity:
```
pm2 logs smc-bot --lines 50
```

### Restart the bot (after code updates):
```
cd ~/connect-assist
git pull
pm2 restart smc-bot
```

### Stop the bot:
```
pm2 stop smc-bot
```

### Start it again:
```
pm2 start smc-bot
```

---

## TROUBLESHOOTING

### "Command not found" errors
Close Terminal and open a new one. Some installations need a fresh Terminal window.

### Bot shows ❌ errors
Check your `.env.local` file — the keys might be wrong:
```
cat local-runner/.env.local
```

### Bot stopped running
```
pm2 restart smc-bot
pm2 logs smc-bot
```

### Mac restarted and bot isn't running
```
pm2 resurrect
```

### Need to update the code
```
cd ~/connect-assist
git pull
pm2 restart smc-bot
```

### Something is really broken
Stop the local bot and re-enable the cloud scheduler:
```
pm2 stop smc-bot
```
Then go to your Lovable dashboard and re-enable auto-scan. You're back to the cloud setup.

---

## COSTS AFTER SETUP

| Item | Monthly Cost |
|------|-------------|
| Mac Mini electricity | ~$3 |
| Supabase (free tier) | $0 |
| TwelveData | Your current plan |
| OANDA | $0 |
| Tailscale | $0 |
| **Total** | **~$3 + data feed** |
