# Company channels

Everything for a company lives in **Settings → Company**: starting work, its
agents, inbox and outbox, its brain and records, and the email and social
accounts it uses. Open it with **Company** at the bottom of the sidebar, which
reopens the company you last worked in, or pick another company at the top of
the page. A company can connect email accounts and X, LinkedIn, and Threads
accounts there. Agents read the inbox and write drafts; only you send them.
Credentials stay on the environment that runs the company and are never shown
again after you save them. Saving an account signs in with it first, so a
mistyped password or token is caught right away.

## Bring an existing company brain

Every agent reads `company/BRAIN.md` and `company/CHANNELS.md` before it works.
If your company already keeps this somewhere else, paste it into **Already have
a company brain?** in Settings → Company. A GitHub repo (`owner/repo` works)
becomes `company/` itself and stays in sync, as described below. A website or a
Supabase project URL opens a Claude thread with an import prompt to review;
Claude reads the source and fills in `company/`. Supabase needs the Supabase MCP
server or CLI on that machine.

## Sync the brain with a repo

Choose **Sync with a repo** under **Company brain** and enter a GitHub repo or
any git clone URL. T4 clones it as `company/`. Files that were only in
`company/` are kept; where the repo has a different version of a file, the
repo's wins and yours is saved to a backup folder T4 names. **Sync** commits
what changed here, including agents' edits, pulls, and pushes. If the same file
changed in both places, Sync stops and lists it so you can merge it in the repo.
Private repos need git credentials on that machine, such as `gh auth login`.
**Stop syncing** keeps the files and leaves the repo as it is.

## Company records

People, companies, deals, investors, candidates, and anything else you track live
in the company brain as plain files. Each folder in `company/` (other than
`outbox/`) is a collection, and each Markdown file in it is a record, with its
fields in the frontmatter and notes below. A folder of notes from Obsidian or a
GitHub repo works as it is. Add People, Companies, Deals, Fundraising, or Hiring
from **Collection** under **Company brain**, or create your
own. A collection with stages shows as a board.

Agents, including Muse and Grok Bot, look up records with `t3_brain_find` and
create or update them with `t3_brain_save`, which also adds dated notes to a
record's `## Log`. Edits keep the comments and field order you wrote. A
collection's `README.md` sets its name, its stages (`stages: [lead, won]`), and
a description agents read.

## Your team

Hire AI employees, or bots, from **Hire** under **Team** in Settings → Company.
Each one is a record in `company/agents/` with a role, the provider it runs on
(Muse, Grok Bot, Claude, or Codex), the collections and channels it works with,
and its instructions. Change how someone works by editing their record under
**Company brain → Team**.

Each bot keeps its own threads. The **Bots** section at the top of the sidebar
lists the bots of the company you last opened, with each bot's threads under
it. **+** next to a bot, or **New thread** on its card in Settings → Company,
starts another thread with that bot, its instructions, and the company brain.

Bots can message each other. When one bot's work fits a teammate better, it
messages that teammate with `t3_bot_message`. The teammate works on it in a
thread of its own, listed under its name, and its answer goes back to the bot
that asked. The thread shows up under the bot that asked as well, as a
delegated task.

## People

**Invite** under **People** in Settings → Company adds a teammate to
`company/members/` and gives you a one-use link to send them. Opening it signs
their browser in to this machine as them, so their threads show who started
them. Their browser has to reach this machine, for example over Tailscale.

A **Member** can see everyone's work and change only the threads they start;
they can fork anyone's thread to continue it as their own. Routines and agent
session imports run as the machine's owner, so only the owner and admins manage
them. An **Admin** can also invite and remove people and change anyone's
thread. Neither can change providers, settings, or the server itself. Both run
agents and terminals as this machine's user, so invite people you trust with it.

Every message a teammate sends shows their name in the thread, and your own
say **You**. The agent reads a teammate's message as "Message from teammate
Sam", so it knows whose request it is working on.

**New invite link** makes another link when one expires or was used up.
**Remove from company** signs them out of every company machine you can manage
from this browser, cancels unused links,
and deletes their record. Their threads stay.

## Machines

A company can work on more than one machine. **Add machine** under **Machines**
lists the other T4 machines you are connected to (add one in Settings →
Environments first) and saves your pick to `company/machines/`. On a machine
where you are an admin, **Manage access** gives a teammate an invite link for
that machine, or takes their access away. **Remove from company** takes the
machine off the list without changing who can use it.

A teammate can add their own computer the same way: connect the company's
browser tab to their own T4 in Settings → Environments, then **Add my
computer**. Work on it counts as theirs in **Activity**.

**Let agents see its work** gives the company machine's agents a read-only link
to another machine, so `t3_team_activity` includes that machine's threads.
It needs Linked environments turned on in Settings → Labs on both machines, and
you must be an admin of both. **Stop** removes the link.

## Activity

**Activity** shows what everyone on the company's machines is doing, one view at a time:
**Everyone** has a card per person and AI employee; click one to see their
threads. **People**, **AI employees**, and **Projects** list the threads for
the one you pick. Agents see the same views with `t3_team_activity`, so they
can check for overlapping work before they start.

## Routines

**Add routine** under **Routines** creates a scheduled task for work that repeats:
morning triage, weekly pipeline follow-ups, weekly metrics, an investor update,
social posts, and a Monday plan. A routine runs on this machine on its schedule,
starts a thread in the company, and shows up with every other task under
**Settings → Scheduled tasks**, where you can edit its prompt and schedule.
Pause a routine with its switch, or run it now with the play button.

## Drafts and sending

Drafts are Markdown files in the company folder's `company/outbox/`, one per
email or post, with its details in the frontmatter at the top. Agents in the
company's threads, and Muse or Grok Bot through their tasks, create them with
`t3_company_draft`; you can also write or edit them yourself. Review a draft in
Settings → Company and send it there. Sending marks the file `sent` with the time
and, for posts, a link. A failed send is marked `failed` with the reason, and
you can fix the draft or the account and send it again. Sent drafts cannot be
sent twice or discarded; they stay as a record.

Posts longer than the network allows are refused with their length rather than
cut: X allows 280 characters, Threads 500, and LinkedIn 3,000.

## Connect an email account

**Gmail, iCloud, and Fastmail** use IMAP and SMTP with an app password, not your
normal password:

- Gmail: turn on 2-Step Verification, then create one at
  [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
- iCloud: at [account.apple.com](https://account.apple.com), open **Sign-In and
  Security → App-Specific Passwords**.
- Fastmail: **Settings → Privacy & Security → Manage app passwords**, with IMAP
  and SMTP access.

For another provider, choose **Other IMAP** and enter its IMAP and SMTP servers,
ports, and whether each uses TLS or STARTTLS. Sent mail is copied to the
account's Sent folder; Gmail does that by itself.

**Outlook and Microsoft 365** sign in with Microsoft, through an Azure app you
own:

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open
   **App registrations → New registration**. Choose who can sign in (any
   account type works for personal Outlook too). No redirect URI is needed.
2. Under **Authentication**, turn on **Allow public client flows**.
3. Under **API permissions**, add Microsoft Graph delegated permissions
   `Mail.ReadWrite`, `Mail.Send`, `User.Read`, and `offline_access`.
4. Copy the **Application (client) ID** into T3 Code. Leave the tenant as
   `common` unless your organization requires its own tenant ID.
5. Open the link T3 Code shows, enter the code, and approve.

## Connect a social account

**X**: in the [X developer portal](https://developer.x.com), set your app's
user authentication permissions to **Read and write**, then copy the API key
and secret and generate an access token and secret under **Keys and tokens**.
Tokens generated before you chose Read and write cannot post; regenerate them.
Posting needs an API plan that allows it.

**LinkedIn**: create an app at
[linkedin.com/developers](https://www.linkedin.com/developers) with the **Share
on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products, then
generate a token with the `openid`, `profile`, and `w_member_social` scopes in
the developer portal's token generator. Tokens last 60 days and cannot be
renewed here, so enter the expiry date LinkedIn shows. The account warns you a
week before it expires; paste a new token then.

**Threads**: in a [Meta developer](https://developers.facebook.com) app with the
Threads use case and the `threads_basic` and `threads_content_publish`
permissions, generate a user token and exchange it for a long-lived one, which
lasts 60 days. T3 Code renews it about once a week while you use the account. A
token left unused until it expires must be replaced.
