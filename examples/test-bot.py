#!/usr/bin/env python3
"""A tiny example Harmony bot.

It connects to the gateway, registers one slash command (`/test`), and replies
"It worked!" in the channel whenever somebody runs it.

Setup:

    pip install websockets
    python test-bot.py

Create the bot under **Admin -> Bots** in the Harmony admin panel and paste its
token below. The bot needs **View Channels** and **Send Messages** so it can see
the channel and reply in it.
"""

import asyncio
import json
import time
import urllib.error
import urllib.request

try:
    import websockets
except ImportError:  # pragma: no cover - just a friendly message
    raise SystemExit("This script needs the websockets package: pip install websockets") from None

# --- Configuration: the only part you need to edit --------------------------

# The bot's token, shown once when the bot is created or its token is regenerated.
TOKEN = "paste-your-token-here"

# The instance to talk to. The gateway address is derived from this.
BASE_URL = "http://127.0.0.1:5173/"

# The one command this bot offers. `requiredPermissions` is a decimal permission
# bitfield; 0 means any member may run it.
COMMAND = {
    "name": "test",
    "description": "Replies with It worked!",
    "requiredPermissions": "0",
}

# --- The bot itself: nothing below here should need changing ----------------

BASE_URL = BASE_URL.rstrip("/")
WS_URL = ("wss://" if BASE_URL.startswith("https://") else "ws://") + BASE_URL.split("://", 1)[1] + "/gateway"

OP_DISPATCH = 0
OP_HEARTBEAT = 1
OP_IDENTIFY = 2
OP_HELLO = 10


def api(method, path, body=None):
    """One JSON call against the REST API, authenticated with the bot token."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        BASE_URL + "/api/v1" + path,
        data=data,
        method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            payload = response.read()
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"{method} {path} -> {error.code}: {detail}") from error


def register_commands():
    """Tell the server which commands this bot offers (replaces the whole set)."""
    result = api("PUT", "/bots/@me/commands", {"commands": [COMMAND]})
    names = ", ".join("/" + command["name"] for command in result["commands"])
    print("registered:", names)


async def heartbeat(websocket, interval_ms):
    """Keep the connection alive; the server drops a silent one after two beats."""
    while True:
        await asyncio.sleep(interval_ms / 1000)
        await websocket.send(json.dumps({"op": OP_HEARTBEAT, "d": None}))


async def run():
    async with websockets.connect(WS_URL) as websocket:
        hello = json.loads(await websocket.recv())
        interval = hello["d"]["heartbeat_interval"]
        await websocket.send(json.dumps({"op": OP_IDENTIFY, "d": {"token": TOKEN}}))

        beats = asyncio.create_task(heartbeat(websocket, interval))
        try:
            async for raw in websocket:
                frame = json.loads(raw)
                if frame.get("op") != OP_DISPATCH:
                    continue

                if frame["t"] == "READY":
                    user = frame["d"]["user"]
                    print(f"online as {user['username']} ({user['accountType']})")
                elif frame["t"] == "COMMAND_INVOKE":
                    command = frame["d"]
                    print(f"/{command['name']} run by {command['username']} in {command['channelId']}")
                    # The bot answers with the ordinary API, as itself.
                    await asyncio.to_thread(
                        api,
                        "POST",
                        f"/channels/{command['channelId']}/messages",
                        {"content": "It worked!"},
                    )
        finally:
            beats.cancel()


if __name__ == "__main__":
    register_commands()
    while True:
        try:
            asyncio.run(run())
            print("connection closed - reconnecting in 5s")
        except KeyboardInterrupt:
            break
        except Exception as error:
            print("error:", error, "- reconnecting in 5s")
        time.sleep(5)
