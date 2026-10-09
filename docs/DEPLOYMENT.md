# Deploying Harmony

Harmony is built to be one small process: the same Node server serves the web
client, the HTTP API and the WebSocket gateway on one origin. You do not need a
separate static host, and you do not need Docker, Postgres or Redis.

This guide covers running a real instance: building the client, putting it behind
TLS, the settings that matter once other people can reach it, and backups.

## How it runs

- **One process, one origin.** `apps/server` serves everything. The Vite dev
  server is only for development.
- **The client is prebuilt.** `npm run build:web` writes `apps/web/dist`, and the
  server serves that directory when it exists. Point it elsewhere with
  `HARMONY_WEB_DIR` if you build outside the repo. Without a build, the server
  serves only the API and says so on startup.
- **All state is in `data/`.** The SQLite database (`data/harmony.db`) and the
  uploaded blobs (`data/uploads/`). Move it with `HARMONY_DATA_DIR`.

## Requirements

- **Node.js 24 or newer.**
- A reverse proxy for TLS in front of it. [Caddy](https://caddyserver.com) is the
  least fuss; nginx works too. Both examples are below.

## Build and run

```sh
npm ci
npm run build:web
npm start
```

`npm start` is `node apps/server/src/index.ts`. It reads `.env` from the working
directory if present, so the same tree you develop in can be the one you deploy.

The server binds loopback by default (`127.0.0.1:8787`), which is what you want:
the reverse proxy is the only thing exposed, and it talks to the API over
loopback. For a quick check without a proxy it is reachable at
<http://127.0.0.1:8787> as-is.

## Environment variables

Copy `.env.example` to `.env` and set what you need. Everything has a default.

| Variable | Default | What it does |
| --- | --- | --- |
| `HARMONY_HOST` | `127.0.0.1` | Interface to bind. Leave loopback and let the proxy front it. |
| `HARMONY_PORT` | `8787` | Port to listen on. |
| `HARMONY_SERVER_NAME` | `Harmony` | Initial server name; change it in the admin panel afterwards. |
| `HARMONY_DATA_DIR` | `./data` | Where the database and blobs live. Useful outside the repo. |
| `HARMONY_WEB_DIR` | `apps/web/dist` | The built client to serve. |
| `HARMONY_REQUIRE_INVITE` | `false` | When true, registration needs an invite code. |
| `HARMONY_SESSION_TTL_DAYS` | `30` | How long a login lasts. |
| `HARMONY_COOKIE_NAME` | `harmony_session` | Session cookie name. |
| `HARMONY_COOKIE_SECURE` | `false` | **Set true when served over HTTPS.** Marks the cookie `Secure`. |
| `HARMONY_TRUST_PROXY` | `false` | **Set true behind a reverse proxy** so client IPs come from `X-Forwarded-For`. |
| `HARMONY_PRUNE_INTERVAL_MINUTES` | `60` | How often automatic retention pruning runs. |
| `HARMONY_GATEWAY_HEARTBEAT_MS` | `45000` | How often gateway clients must heartbeat. A silent connection is closed after about two intervals. Leave it alone unless your proxy's idle timeout is shorter than 45s. |
| `HARMONY_LOG_LEVEL` | `info` | `fatal`…`trace`, or `silent`. |
| `HARMONY_CSP` | built-in policy | `Content-Security-Policy` to send; `off` disables the header. |

Two of these matter for safety and are easy to get wrong:

- `HARMONY_COOKIE_SECURE=true` **only when the browser reaches the instance over
  HTTPS** (normally via the proxy). Setting it while serving plain HTTP makes the
  browser drop the cookie, and nobody can stay logged in.
- `HARMONY_TRUST_PROXY=true` **only when there really is a proxy in front.** With
  it off behind a proxy, every request looks like it comes from the proxy, so
  login rate limiting is shared by everyone. With it on and no proxy, a client
  can forge `X-Forwarded-For` to sidestep that limit.

The server prints a warning at startup for the risky combinations it can detect.

## Reverse proxy and TLS

Point your hostname at the proxy, and have the proxy forward to
`127.0.0.1:8787`. Three things must be forwarded for everything to work: the
`Host` header, the client's address (`X-Forwarded-For`) and the original scheme
(`X-Forwarded-Proto`). WebSocket upgrades must be allowed through for `/gateway`,
which is how live messages arrive.

Clients heartbeat over that WebSocket every 45 seconds (`HARMONY_GATEWAY_HEARTBEAT_MS`) and the
server answers each one, so a healthy connection is never idle for longer than that. Any idle or
read timeout on the proxy must be comfortably longer than the interval, or the proxy will cut quiet
connections and every client will reconnect and resync on each cut. Connections that stop
heartbeating for about two intervals are closed by the server itself, which is what takes a
vanished phone or laptop offline.

### Caddy

Caddy obtains and renews certificates on its own, proxies WebSockets with no extra
configuration, and sets the forwarded headers for you.

```caddy
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    # At least as large as the biggest upload limit you configure in the admin
    # panel. The server refuses anything above 100 MB regardless.
    client_max_body_size 100m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # The gateway is a WebSocket.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Clients heartbeat the gateway every 45s and the server acknowledges
        # each beat, so a live WebSocket is never quiet for longer than that.
        # This only has to outlast one interval with room to spare.
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Then set `HARMONY_TRUST_PROXY=true` and `HARMONY_COOKIE_SECURE=true` and restart.

`encode`/`gzip` is worth having: the JavaScript bundle is around 250 kB before
compression and about 75 kB after.

## First run

Do this **before** the instance is reachable from the internet.

1. Start it on loopback (`npm start`) and open <http://127.0.0.1:8787>.
2. **Register the first account.** The first person to register becomes the
   instance owner. Until you have done this, anyone who can reach the server can
   claim that account, so do not expose it first. A setup wizard then greets the
   owner and walks through naming and theming the instance, storage retention, the
   Discord bridge, and which channels and emoji to import; it can be skipped, and
   it does not appear again once finished.
3. Set the server name, icon and colors, and check the upload limits and
   retention rules in the admin panel.
4. Decide about registration. With `HARMONY_REQUIRE_INVITE=true` only people with
   an invite code (Admin → Invites) can sign up; leave it off for an open server.
5. Only now put it behind the proxy, set `HARMONY_COOKIE_SECURE=true` and
   `HARMONY_TRUST_PROXY=true`, and restart.
6. Invite everyone.

## The Discord bridge (optional)

Harmony runs perfectly well on its own. If you would rather the two share channels
while people migrate, the bridge needs a bot of your own — the setup wizard offers
to walk you through this on first run, and **Admin → Bridge** does the same later:

1. Create an application and a bot at
   <https://discord.com/developers/applications>.
2. On the **Bot** page, turn on the **Message Content** and **Presence** intents.
   Both are privileged: the toggles work right away for a bot in fewer than 100
   servers, and need Discord's approval beyond that.
3. Invite the bot to your server with **View Channels**, **Send Messages**, **Read
   Message History**, **Add Reactions** and **Manage Webhooks**. Add **Pin Messages** too if pinning
   a message in Harmony should pin it on Discord as well.
4. Paste the token into **Admin → Bridge**, set the public base URL, and enable it.

**Restart Harmony after changing the intents.** The bot reads them only when it
connects, and an intent that is requested but not enabled makes Discord refuse the
connection entirely (close code 4014), which takes the whole bridge down rather
than one feature. **Admin → Bridge** shows the error if that happens.

Bridging is per channel rather than per server: pick a Discord channel when you
create or edit a Harmony channel, and only that pair syncs. Existing Discord
channels and custom emoji can be imported from the admin panel, which bridges
whatever it imports. Discord users show up as stand-in accounts; they take an
online or offline marker from Discord itself, which is why the Presence intent
matters for the member list of a bridged channel.

The bridge also requests the **Guild Message Polls** intent, which is not privileged and
has no toggle, so there is nothing to enable: it is how votes on a Discord poll reach
Harmony. Give the bot **Send Messages** in a bridged channel to let it post a Harmony
poll there as a native poll.

Do not re-invite the bot to change an intent. Intents are a property of the bot's
gateway connection rather than a permission, so the toggles apply to the bot you
already have.

## Discord sign-in (optional)

Members can sign in with Discord and connect their Discord account instead of, or
alongside, a username and password. It is off by default and uses the same Discord
application as the bridge:

1. In that application, open **OAuth2 → Redirects** and add the callback URL shown
   in **Admin → Bridge**, which looks like
   `https://your-address/api/v1/auth/discord/callback`.
2. Copy the **Client ID** and **Client Secret** from **OAuth2 → General** into
   **Admin → Bridge → Sign in with Discord**.
3. Tick **Allow members to sign in and link with Discord**, and set the public base
   URL if you have not already. Discord must be able to reach that address, so a
   `localhost` one will not work.

Signing in with Discord creates an account the first time, with no password: the
username comes from the Discord name, and if the bridge already knew that person
the stand-in and its history are folded into the new account. If **require
invite** is on, the sign-in screen asks for a code, used only when an account is
being created. Existing members can still connect Discord from their profile,
which proves the account is theirs where a typed id would not. A member who
signed up this way can set a password later from their profile, and cannot
disconnect Discord until they have. The very first account on a new instance is
still created by registering with a password, since Discord sign-in is configured
from the admin panel. The whole thing is optional and can be switched off again at
any time.

## Voice chat (optional)

Voice needs UDP, which the HTTPS connection the rest of Harmony uses cannot
carry. The media relay binds a fixed UDP port range and members send audio
directly to the process, so the range has to be open on the host **and** in your
provider's firewall (OVHcloud has its own panel, separate from the machine).

The range starts at `40000`–`40100`, and is set with `HARMONY_VOICE_PORT_MIN` and
`HARMONY_VOICE_PORT_MAX`. Size it for the busiest moment you expect, not just one
room: a connection binds a port for each local address the host has, so a member
can take several. The default holds roughly a dozen simultaneous connections,
which suits a small community; widen the range if you run larger or busier rooms.

A member whose client vanishes without a clean leave is reaped within about half
a minute, which frees their seat and most of their ports. Closing a connection
that has already failed does not release every socket, though, so a process left
running for a long time accumulates a few; a restart clears them. If members start
being unable to connect after a week or two of heavy use, the range is likely
exhausted and a restart will clear it.

With `ufw` that is one rule for the whole range:

```sh
sudo ufw allow 40000:40100/udp
```

There is nothing to configure in nginx: the media goes straight to the Node
process, bypassing the reverse proxy. The server advertises its own addresses as
the WebRTC candidate, which on a host whose interface carries its public IP (as on
OVH) is already correct. A host behind another NAT should set
`HARMONY_VOICE_PUBLIC_IP` to the address members reach it at.

The relay gathers against no external server by default: a host whose interface
carries its public IP needs no STUN, and werift's silent fallback to a public one is
switched off. If the relay itself sits behind a NAT, set `HARMONY_VOICE_PUBLIC_IP`
to the address members reach it at, or `HARMONY_VOICE_STUN_URLS` (comma-separated)
for it to learn that address itself.

Clients are a different matter, since a member may be behind a NAT the relay cannot
reach. Set the STUN and TURN servers in the admin panel under **Voice relay
(STUN/TURN)**: STUN URLs, TURN URLs, and the coturn shared secret. They are handed
to clients at `GET /voice/ice`, with per-request, expiring TURN credentials, and are
deliberately not in the unauthenticated meta payload. TURN is only needed for a
member on a symmetric NAT or a carrier-grade NAT, and can be left empty: without
it, reachability is one-sided, and a member usually still connects by sending to
the relay even from behind an ordinary NAT. To run TURN, point the TURN URLs and the
secret at a coturn server configured with `use-auth-secret` and the same secret.

## Installing it as an app

Harmony is a Progressive Web App, so it can be installed to a phone or desktop
home screen and run full-screen, with no browser UI around it. The manifest is
built from the instance's own settings, so the installed app takes the server's
name, icon and colors.

Installing needs **HTTPS**: a browser will not offer it over plain HTTP. Once the
instance is behind TLS:

- **Android (Chrome):** open the instance and pick *Install app* from the ⋮ menu,
  or *Add to Home screen*. It opens standalone, with its own entry in the task
  switcher.
- **iOS (Safari):** Share → *Add to Home Screen*.
- **Desktop (Chrome or Edge):** the install icon in the address bar.

The home-screen icon is the admin-uploaded instance icon, or the built-in default
otherwise. A larger source makes a sharper icon — the shipped default is only
96×96 — so if the icon matters to you, upload a square image of at least 512×512
in **Admin → Settings**.

Uploaded icons may have a transparent background, and what the installed app does
with it is a plain choice rather than a clever one, because only you know what
your image is. **Admin → Settings** has both parts of it:

- **Padding** is how much of the tile to leave clear around the artwork, as a
  percentage. Left to work itself out, a picture with no transparent pixels gets
  none — it was drawn to its own edges, so it fills the tile — and a logo drawn
  on transparency gets 10%, so the crop lands on the tile instead of the drawing.
  Set it to 0 for a full image, or raise it if a logo is being cut.
- **Background** is what shows where the padding leaves a gap. Left alone it is
  the artwork's own color, which reads as part of the icon; pick one to override
  it.

The settings panel shows a preview of the result, which updates when you save.

Updates arrive on the next visit: the service worker caches nothing, so a new
deploy is never served stale, though an existing install may need one reload.

## Backups

Everything that matters is under `data/`. To back it up safely, either stop the
service and copy the directory, or take a consistent database copy while it runs:

```sh
sqlite3 data/harmony.db ".backup '/backup/harmony.db'"
cp -a data/uploads /backup/uploads
```

Restoring means putting the database and `uploads/` back with the service
stopped. The uploaded blobs are content-addressed, so the database is the index:
copy the two together and they stay consistent. Retention pruning removes blobs
nothing references any more, so a backup is also a good time to let it run.

Message edit history (the previous text of up to 20 edits per message) lives in the database, so it
is part of every backup. It is removed together with its message, whether by deleting the message
for good or by message retention pruning it; a message that is only soft-deleted keeps its history
in the database, though nobody can read it. Editing a message therefore does not erase the old text
from the database or from backups. It is only visible to the author and to members who can manage
messages.

### From the admin panel

The owner can also download a backup from **Admin → Backup** without shell
access. It is a single `harmony-backup-<server>-<date>.tar.gz` holding a
consistent snapshot of the database (taken with SQLite's online backup, so the
server keeps running) and the whole `uploads/` directory, laid out exactly like
the data directory:

```
harmony.db
uploads/<first two hex digits>/<sha-256>
```

Only the owner can download one, not other administrators: the archive holds
every password hash, the Discord bot token and sign-in secret, and every message,
including deleted ones and those in locked channels. Keep it somewhere only you
can read. Each download is recorded in the audit log.

To restore from it:

```sh
# 1. Stop Harmony.
sudo systemctl stop harmony

# 2. Move the current data aside rather than deleting it, in case you need it.
mv data data.before-restore
mkdir data

# 3. Extract the archive into the data directory.
tar -xzf harmony-backup-myserver-2026-10-03.tar.gz -C data

# 4. Start Harmony again.
sudo systemctl start harmony
```

If you extract over an existing data directory instead, delete
`harmony.db-wal` and `harmony.db-shm` first: they belong to the old database,
and SQLite would try to apply them to the restored one. Use `HARMONY_DATA_DIR`
in place of `data` if you moved it. The archive does not carry `.env`, so keep
that alongside it.

The same tab exports a single channel's history as JSON or as a standalone HTML
page, for administrators with Manage Server. That is a record to read or hand to
another tool, not a backup: it cannot be restored.

## Running as a service

A minimal systemd unit, assuming the checkout is at `/opt/harmony` and runs as a
`harmony` user:

```ini
[Unit]
Description=Harmony
After=network.target

[Service]
Type=simple
User=harmony
WorkingDirectory=/opt/harmony
ExecStart=/usr/bin/node apps/server/src/index.ts
EnvironmentFile=/opt/harmony/.env
# Restart on any exit. The admin panel's update button relies on this: after a
# successful update the server exits and lets systemd start the new build, so
# on-failure would leave it stopped. An explicit `systemctl stop` still stops it.
Restart=always

[Install]
WantedBy=multi-user.target
```

The user needs write access to `data/` (or `HARMONY_DATA_DIR`) and read access to
`apps/web/dist`.

## Updating

By hand, from the checkout this instance runs from, as the user the service runs
as:

```sh
git pull
npm ci
npm run build:web
sudo systemctl restart harmony
```

There are no build steps for the server itself; Node runs the TypeScript
directly.

### The update button

The owner sees an **Update** tab in the admin panel. On its own it holds a manual
*Check for updates* button, a switch for a once-a-day automatic check (off by
default, since it calls out to the internet), and these manual instructions.
There is nothing to configure for the check: a fork that wants it to point at its
own releases changes one constant, described in `docs/TECHNICAL.md`.

An instance can additionally offer an **Update now** button that applies the
update for the owner. It is off unless the operator turns it on, by setting
`HARMONY_UPDATE_COMMAND` in `.env` to the command that pulls and builds, run from
the checkout:

```
HARMONY_UPDATE_COMMAND=git pull && npm ci && npm run build:web
```

Leave the restart out of it. After the command succeeds the server exits cleanly
and lets its supervisor start the new build — which is why the unit above uses
`Restart=always`. With `Restart=on-failure` a clean exit would leave the service
stopped. An explicit `systemctl stop harmony` still stops it. The same command
works under pm2 or Docker, whose restart policies bring the service back the same
way, so nothing here is specific to systemd.

The command runs as the user the service runs as, and it never needs `sudo`: if
that user can run `git` and `npm` in the checkout, it can update. Nothing is
installed outside the checkout.

The owner gets two buttons. **Backup and update** first takes a database-only
snapshot, then runs the command; **Update without backup** skips the snapshot
after a warning. Snapshots are one compact copy of the database, kept beside it,
and the owner chooses how many stay on disk (three by default). Uploaded files are
not copied: they are content-addressed and never rewritten, so an update cannot
damage them. If the command fails, the instance keeps running the old build and
the panel shows the output.

Unset `HARMONY_UPDATE_COMMAND` to take the button away again; the panel then only
prints the manual steps. The feature is opt-in and manual by design: Harmony never
updates itself, and the daily check only notifies.

## A note on the content security policy

The server sends a strict `Content-Security-Policy` that allows only its own
scripts and styles, its own API and gateway, and the YouTube player the link
previews embed. If you run custom clients or add something the policy blocks, set
`HARMONY_CSP` to a policy of your own, or to `off` to send none. The other
When an admin sets Gif storage to "Link to the hosted service", the built-in
policy additionally allows images and media from a short fixed list of gif hosts
(Klipy, Tenor's media hosts, Giphy's media hosts); a policy you set yourself is
never modified, so add those hosts to its `img-src` and `media-src` if you use
link mode with one. Switching between Store and Link never loses a gif: the
server remembers each linked gif's address and copies it on demand, and Settings,
Gifs can archive every linked gif onto the server (or free those copies again).
Copies made that way are kept until released or until the storage limit needs
the space; retention by age does not remove them. The other
hardening headers (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, and HSTS over HTTPS) stay on either way.
