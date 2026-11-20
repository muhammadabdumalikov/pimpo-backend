#!/usr/bin/env python3
"""Post what a deploy shipped to the platform Telegram chat.

Runs in GitHub Actions on a push to main. Lists every commit between the last
deployed commit and this one, with its full message (Co-Authored-By trailers
dropped), and sends it through the platform bot. It never fails the job: a
Telegram or GitHub hiccup must not turn a good deploy red.

Env:
  TELEGRAM_BOT_TOKEN, TELEGRAM_DEPLOY_CHAT_ID   unset = skip quietly
  GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA   set by Actions
  BASE_SHA        compare from this commit (a push: github.event.before)
  BASE_WORKFLOW   instead of BASE_SHA: start at the head of this workflow's
                  last successful run on main. Use it where a newer push
                  cancels an older build, or that build's commits are lost.
  DEPLOY_LABEL    name shown in the header (default: the repo name)
  DRY_RUN=1       print the messages instead of sending them
"""
import html
import json
import os
import re
import urllib.error
import urllib.request

LIMIT = 4000  # Telegram refuses a message over 4096 characters
MAX_COMMITS = 40
TRAILER = re.compile(r"^(Co-Authored-By|Signed-off-by):.*$", re.IGNORECASE | re.MULTILINE)


def esc(text):
    return html.escape(text, quote=False)


def github(path):
    base = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    req = urllib.request.Request(
        base + path,
        headers={
            "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.load(res)


def base_sha(repo):
    workflow = os.environ.get("BASE_WORKFLOW")
    if workflow:
        runs = github(
            f"/repos/{repo}/actions/workflows/{workflow}/runs"
            "?branch=main&status=success&per_page=1"
        )["workflow_runs"]
        return runs[0]["head_sha"] if runs else None
    sha = os.environ.get("BASE_SHA", "")
    # A brand-new branch reports before = 000…0.
    return sha if sha and set(sha) != {"0"} else None


def shipped(repo, base, head):
    """(commits oldest first, total count) between base and head."""
    if base == head:
        return [], 0  # a re-run of what is already live
    if base:
        try:
            data = github(f"/repos/{repo}/compare/{base}...{head}")
            return data["commits"][-MAX_COMMITS:], data["total_commits"]
        except urllib.error.HTTPError as err:
            # A force push can leave base unreachable; say at least what is live.
            print(f"compare {base[:7]}...{head[:7]} failed ({err.code}); head commit only")
    return [github(f"/repos/{repo}/commits/{head}")], 1


def block(commit, server, repo, budget):
    message = TRAILER.sub("", commit["commit"]["message"]).strip()
    subject, _, body = message.partition("\n")
    body = body.strip()
    link = f'<a href="{server}/{repo}/commit/{commit["sha"]}">{commit["sha"][:7]}</a>'

    def render(text):
        parts = [f"<b>{esc(subject.strip())}</b>"]
        if text:
            parts.append(esc(text))
        parts.append(link)
        return "\n".join(parts)

    out = render(body)
    # One huge commit still has to fit a message. Cut the raw text, never the
    # escaped one, so an &amp; is not split in half.
    while len(out) > budget and body:
        body = body[: max(0, len(body) - (len(out) - budget) - 1)].rstrip()
        out = render(body + "…" if body else "")
    return out


def pack(header, blocks, footer):
    messages, current = [], header
    for part in blocks + ([footer] if footer else []):
        if len(current) + 2 + len(part) > LIMIT:
            messages.append(current)
            current = part
        else:
            current += "\n\n" + part
    messages.append(current)
    return messages


def send(token, chat_id, text):
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps(
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "link_preview_options": {"is_disabled": True},
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=20).read()
    except urllib.error.HTTPError as err:
        print(f"Telegram {err.code}: {err.read().decode(errors='replace')}")
        raise


def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_DEPLOY_CHAT_ID", "").strip()
    dry = os.environ.get("DRY_RUN") == "1"
    if not dry and not (token and chat_id):
        print("TELEGRAM_BOT_TOKEN / TELEGRAM_DEPLOY_CHAT_ID not set - skipping.")
        return

    repo = os.environ["GITHUB_REPOSITORY"]
    head = os.environ["GITHUB_SHA"]
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    label = os.environ.get("DEPLOY_LABEL") or repo.split("/")[-1]

    base = base_sha(repo)
    commits, total = shipped(repo, base, head)
    commits = [c for c in commits if len(c.get("parents", [])) < 2]  # skip merges
    if not commits:
        print("Nothing new since the last deploy - skipping.")
        return

    header = f"🚀 <b>{esc(label)}</b> · {total} ta o'zgarish"
    blocks = [block(c, server, repo, LIMIT - 200) for c in commits]
    footer = ""
    if base and base != head:
        more = f"Yana {total - len(commits)} ta · " if total > len(commits) else ""
        footer = f'{more}<a href="{server}/{repo}/compare/{base[:12]}...{head[:12]}">GitHub\'da hammasi</a>'

    for text in pack(header, blocks, footer):
        if dry:
            print(text, end="\n\n" + "-" * 60 + "\n")
        else:
            send(token, chat_id, text)
    print(f"Posted {len(commits)} commit(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - a notice must never fail a deploy
        print(f"deploy notice not sent: {err!r}")
