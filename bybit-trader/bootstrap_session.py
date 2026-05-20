"""One-shot script to create the Telethon session file interactively.

Run this LOCALLY (not in the production container) because it prompts for the
SMS code Telegram sends. The resulting ``telethon.session`` file should then
be copied into the ``crypto-data`` Docker volume on the server.

Usage::

    cd bybit-trader
    pip install telethon
    TELETHON_API_ID=1234567 \\
    TELETHON_API_HASH=abcdef... \\
    TELETHON_SESSION=./telethon.session \\
        python bootstrap_session.py

After it prints "Session saved", copy the file:

    docker cp ./telethon.session trader-bybit-trader-1:/data/telethon.session
"""

from __future__ import annotations

import os
import sys

from telethon import TelegramClient


def main() -> int:
    api_id = os.getenv("TELETHON_API_ID")
    api_hash = os.getenv("TELETHON_API_HASH")
    session_path = os.getenv("TELETHON_SESSION", "./telethon.session")

    if not api_id or not api_hash:
        print("ERROR: TELETHON_API_ID / TELETHON_API_HASH env vars must be set.")
        print("Get them at https://my.telegram.org/apps")
        return 1

    client = TelegramClient(session_path, int(api_id), api_hash)
    print(f"Starting interactive login → {session_path}")
    client.start()
    me = client.loop.run_until_complete(client.get_me())
    print(f"Logged in as: {me.username or me.first_name} (id={me.id})")
    print(f"Session saved to: {session_path}")

    print("\nAvailable dialogs (paste IDs into channel_whitelist):")
    for dlg in client.iter_dialogs():
        kind = "channel" if dlg.is_channel else ("group" if dlg.is_group else "user")
        print(f"  [{kind:7}] id={dlg.id}  name={dlg.name!r}")

    client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
