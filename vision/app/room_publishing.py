"""Publish local room builds to one owner-configured HTTPS deployment.

Only the host ticket can publish a pinned build. The deployment credential stays
on the API process, and imports keep HTML in the same opaque sandbox as generation.
"""
from __future__ import annotations
import hashlib
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from app import play_rooms as rooms
from app.config import get_settings

MAX_BUILD_BYTES = 12 * 1024 * 1024  # Includes the packaged image data.


def configuration():
    path = get_settings().data_dir / "messaging" / "publishing.json"
    try:
        saved = json.loads(path.read_text()) if path.is_file() else {}
    except (OSError, ValueError):
        saved = {}
    url = (os.environ.get("DAL_REMOTE_PUBLIC_URL") or saved.get("public_url") or "").rstrip("/")
    secret = os.environ.get("DAL_REMOTE_PUBLISH_SECRET") or saved.get("secret") or ""
    number = os.environ.get("DAL_SPECTRUM_NUMBER") or saved.get("imessage_number") or None
    parts = urlsplit(url)
    valid = parts.scheme == "https" and parts.hostname and not (parts.username or parts.password or parts.query or parts.fragment) and parts.path in ("", "/")
    return {"public_url": url if valid else None, "secret": secret if valid else "", "imessage_number": number}


def client_configuration():
    config = configuration()
    return {"imessage_number": config["imessage_number"], "public_url": config["public_url"],
            "local_publishing": bool(config["public_url"] and config["secret"])}


def links(created, base):
    room_id, invite = created["match"]["id"], created["invite"]
    return created | {"invite_url": f"{base}/#/room/{room_id}?{urlencode({'invite': invite})}",
                      "card_url": f"{base}/api/v2/play-rooms/{room_id}/card?{urlencode({'invite': invite})}"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a deployment credential to a different destination.


def send_build(url, secret, payload):
    request = Request(url + "/api/v2/play-rooms/import", data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json", "X-Draw-Play-Publish": secret}, method="POST")
    try:
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            result = json.loads(response.read(100_000))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError):
        rooms.fail(502, "Could not put your game online. Try again in a moment.")
    # Return URLs minted locally from the validated deployment, never arbitrary response URLs.
    if not isinstance(result, dict) or not isinstance(result.get("match"), dict) or not isinstance(result.get("invite"), str):
        rooms.fail(502, "The online game could not be opened. Try again.")
    return links(result, url)


def publish(room_id, token):
    config = configuration()
    if not config["public_url"] or not config["secret"]:
        rooms.fail(503, "This game is only on your Mac. Connect online sharing or create it on the live draw.play site.")
    with rooms.transaction() as conn:
        room = rooms.load(conn, room_id)
        player = rooms.member(room, token)
        if player["seat"] != 0:
            rooms.fail(403, "Only the game's host can put it online.")
        if room["phase"] == "expired":
            rooms.fail(410, "This invitation expired. Start a new game.")
        previous = room.get("published")
        if previous and previous.get("public_url") == config["public_url"]:
            return previous["receipt"] | {"imessage_number": config["imessage_number"]}
        html = rooms.artifact_path(room_id).read_text()
        if len(html.encode()) > MAX_BUILD_BYTES:
            rooms.fail(413, "This game's artwork is too large to share.")
        payload = {"title": room["title"], "spec": room["spec"], "html": html,
                   "request_key": hashlib.sha256((room_id + html).encode()).hexdigest()}
    receipt = send_build(config["public_url"], config["secret"], payload)
    with rooms.transaction() as conn:
        room = rooms.load(conn, room_id)
        room["published"] = {"public_url": config["public_url"], "receipt": receipt}
        rooms.save(conn, room)
    return receipt | {"imessage_number": config["imessage_number"]}
