# Connectors

Connect a service to T4 once and every agent on that machine can use it: Claude,
Codex, and Antigravity. Add one in **Settings → Connectors**
with the service's MCP server URL. Services publish these in their docs, for
example `https://mcp.linear.app/mcp`.

- **Sign-in:** choose **Sign in with browser** for services that sign you in on
  their own page, such as Linear and Notion. T4 opens that page and saves the
  connector when you finish there. Choose **API key or token** for servers that
  take a key in a header. Most use `Authorization` with the value
  `Bearer <your key>`.
- **Browser sign-in returns to your T4.** The service sends your browser back to
  the address you use to reach this machine, and some services accept only
  `https` addresses or `localhost`. If the service refuses the sign-in, connect
  from the desktop app on that machine or over T3 Connect, or use an API key. A
  service that only signs in apps it has approved in advance needs an API key
  too.
- **Signed out?** A connector that says the service signed T4 out needs you to
  choose **Edit**, then **Sign in** again.
- **Saving checks it works.** T4 connects and lists the server's tools before it
  saves, so a wrong URL or key shows up right away. The key stays on the machine
  running T4 and is never shown again.
- **Agents find tools by searching.** Agents search your connectors when they
  need a service, so adding many connectors doesn't slow down every chat. If an
  agent says it can't reach a service you've connected, ask it to search
  connectors.
- **Tools change?** Refresh a connector to pick up tools the service added. A
  connector that stops answering or rejects its key shows **Not working** with
  the reason.

## Google

Choose **Connect Google** and sign in with your Google account. Agents can then
search and read Gmail, write drafts, send mail, list and create Calendar events,
find and read Drive files, create Docs, and look up Contacts. Google returns you
to a T4 page that asks you to confirm which T4 should get the sign-in; continue
only if you just started connecting Google. To switch accounts or fix a
connection marked **Not working**, choose **Reconnect**. Removing the connector
deletes its saved access from your T4. You can also revoke it from your Google
Account's security settings.

Agents act as your connected account, including tools that change things, such
as creating an issue. In supervised threads your provider asks before each
call. In full-access threads it doesn't, so connect only what you trust those
agents to use.
