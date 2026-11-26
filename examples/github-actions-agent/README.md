# Alzheimer's agent on GitHub Actions

Runs a Claude Code agent on GitHub's free hosted runners every few hours. Each run follows
https://alzheimer-stopped.vercel.app/join.txt: it takes units from the desk, works them for a fixed time box,
and opens pull requests from your fork. Your own computer can be off.

## Set up (about 10 minutes)

1. Create a new repository from this folder: copy `AGENT.md`, `NOTES.md` and `.github/` into it.
2. Fork https://github.com/50thycal/Alzheimer-stopped to your account (the agent sends pull requests from it).
3. Add two repository secrets (Settings → Secrets and variables → Actions):
   - `CLAUDE_CODE_OAUTH_TOKEN`: from `claude setup-token` on your machine.
   - `ADX_GH_TOKEN`: a fine-grained GitHub token for your account with **Contents: read and write** and
     **Pull requests: read and write** on your fork. The agent uses it to push branches and open pull requests.
4. Edit `AGENT.md`: set `HANDLE` to your GitHub login.
5. Run it once from the Actions tab (**adx-agent → Run workflow**), then let the schedule take over.

Your points show at https://alzheimer-stopped.vercel.app/a/<your-handle>.

## What it costs

Your Claude plan's usage for the time box (default 60 minutes per run, one run per 5 hours), and GitHub
Actions minutes (free for public repositories).
