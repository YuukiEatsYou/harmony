# Harmony

![The Harmony logo: three stacked smiling faces](apps/web/public/icon.png)

**A chat server you run yourself.** Everything a small community actually uses
from Discord — channels, roles, reactions, custom emoji, images and video — on a
machine you own, with a bridge so nobody has to leave Discord behind.

## What is this?

One instance is one server: channels and categories, a member list, replies,
emoji reactions, polls, custom emoji, images and video, invites, per-channel slowmode,
message search across everything you can see (with Discord-style filters such as from:, in:, has: and dates), notification sounds, timeouts and
bans, and an admin panel for all of it. It runs as a single small program, keeps
everything in one folder you can back up, and needs no database server, no Docker
and no cloud account.

## Why Harmony?

**Because you own it.** Your messages, your images and your members' data live on
your hardware, under your rules. No ID verification, no ads, no analytics, no data
mining, no terms of service but your own.

**Because migrating doesn't mean leaving.** A built-in bridge mirrors messages
both ways with Discord, so your community can keep talking where it is while you
settle in — or phase it out gradually. The setup wizard imports your channels and
custom emoji for you.

**Because it's small on purpose.** A single process and a single file. It
comfortably fits on a Raspberry Pi or the cheapest VPS, and there is no scaling to
get wrong.

**Because it feels like home.** A familiar, Discord-like interface, with the
colors and icon you choose — and it installs to a phone or desktop home screen
like a real app.

### What it isn't

Harmony is deliberately scoped. There is no voice or video chat, no direct
messages and no friend list. One instance is one server — it is built to be *a*
home for *a* community, not a platform.

## Getting started

You need [Node.js 24 or newer](https://nodejs.org). Then, from the project folder:

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173> and register. **The first account you create becomes
the owner**, and a short wizard greets you: name and colors, storage, and whether
to bring anything over from Discord.

That is already a working chat server. By default it listens on loopback only, so
it is reachable from that machine and nowhere else.

When you are ready to invite other people, follow
[**docs/DEPLOYMENT.md**](docs/DEPLOYMENT.md) — it walks through putting the
instance online behind HTTPS, which is also what the install-to-home-screen
feature needs.

## Documentation

| | |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Putting an instance online: TLS, reverse proxy, backups, updates |
| [docs/TECHNICAL.md](docs/TECHNICAL.md) | How it is built, development setup, and the Discord bridge in depth |
| [docs/API.md](docs/API.md) | The HTTP and WebSocket API, for custom clients and bots |

## License

Harmony is free software, licensed under the
[GNU Affero General Public License v3.0 or later](LICENSE).
