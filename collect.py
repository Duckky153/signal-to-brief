#!/usr/bin/env python3
"""Read the fixed list of public job boards once, slowly, and freeze what they said.

What it does, in order:
  1. Reads data/boards.json (the fixed list) and local/keep-out.json if present.
  2. Refuses to start if any board's company is on the keep-out list.
  3. Asks each board's public feed once: one request at a time, at least 1.2 seconds between
     requests to the same host, client name "research-prototype/0.1", no login, no retry.
     A host that refuses twice is stopped for the rest of the run.
  4. Keeps only what the build needs from each posting, removes email addresses and phone
     numbers from the text, and drops Greenhouse's metadata field.
  5. Writes one dated snapshot (private; it holds full posting text) with a checksum, and a
     log of every request.

Nothing here sends anything anywhere except plain read requests to public job-board feeds.
"""
import datetime
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "research-prototype/0.1"}
GAP = 1.2

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
PHONE = re.compile(r"(?<!\d)(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")


def scrub(text):
    """Plain text from HTML, with email addresses and phone numbers removed."""
    t = html.unescape(html.unescape(text or ""))
    t = re.sub(r"<\s*(br|/p|/li|/h\d|/div)\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"<li[^>]*>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = t.replace(" ", " ")
    t = EMAIL.sub("[email removed]", t)
    t = PHONE.sub("[phone removed]", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n", t)
    return t.strip()


def feed_url(system, board):
    if system == "greenhouse":
        return "boards-api.greenhouse.io", f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true"
    if system == "lever":
        return "api.lever.co", f"https://api.lever.co/v0/postings/{board}?mode=json"
    if system == "ashby":
        return "api.ashbyhq.com", f"https://api.ashbyhq.com/posting-api/job-board/{board}"
    raise ValueError(system)


def normalize(system, raw):
    out = []
    if system == "greenhouse":
        for j in raw.get("jobs", []):
            out.append({
                "id": str(j["id"]),
                "title": j.get("title") or "",
                "place": (j.get("location") or {}).get("name") or "",
                "department": ", ".join(d.get("name", "") for d in j.get("departments") or []),
                "date": (j.get("first_published") or "")[:10] or None,
                "updated": (j.get("updated_at") or "")[:10] or None,
                "country": None,
                "url": j.get("absolute_url"),
                "company_stated": j.get("company_name"),
                "text": scrub(j.get("content")),
            })
    elif system == "lever":
        for j in raw:
            c = j.get("createdAt")
            date = datetime.datetime.fromtimestamp(c / 1000, datetime.timezone.utc).date().isoformat() if c else None
            lists = "\n".join((l.get("text") or "") + "\n" + (l.get("content") or "") for l in j.get("lists") or [])
            body = (j.get("description") or j.get("descriptionPlain") or "") + "\n" + lists + "\n" + (j.get("additional") or j.get("additionalPlain") or "")
            cat = j.get("categories") or {}
            out.append({
                "id": j["id"],
                "title": j.get("text") or "",
                "place": cat.get("location") or "",
                "department": " / ".join(x for x in [cat.get("department"), cat.get("team")] if x),
                "date": date,
                "updated": None,
                "country": j.get("country"),
                "url": j.get("hostedUrl"),
                "company_stated": None,
                "text": scrub(body),
            })
    elif system == "ashby":
        for j in raw.get("jobs", []):
            out.append({
                "id": j["id"],
                "title": j.get("title") or "",
                "place": j.get("location") or "",
                "department": " / ".join(x for x in [j.get("department"), j.get("team")] if x),
                "date": (j.get("publishedAt") or "")[:10] or None,
                "updated": None,
                "country": (j.get("address") or {}).get("postalAddress", {}).get("addressCountry"),
                "url": j.get("jobUrl"),
                "company_stated": None,
                "text": scrub(j.get("descriptionHtml") or j.get("descriptionPlain")),
            })
    return out


def keep_out_names():
    p = os.path.join(HERE, "local", "keep-out.json")
    if not os.path.exists(p):
        return []
    return json.load(open(p))["list_a"]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("’", "'"))


def main():
    boards = json.load(open(os.path.join(HERE, "data", "boards.json")))["boards"]
    names = [(a, norm(a)) for a in keep_out_names()]
    for b in boards:
        for a, na in names:
            if norm(b["company"]) == na or norm(b["board"]) == na or re.search(r"(?<![A-Za-z0-9])" + re.escape(a) + r"(?![A-Za-z0-9])", b["company"], re.I):
                sys.exit(f"Refusing to start: {b['company']} matches a keep-out name.")
    started = datetime.datetime.now().astimezone()
    read_date = started.date().isoformat()
    os.makedirs(os.path.join(HERE, "cache"), exist_ok=True)
    log_path = os.path.join(HERE, "cache", f"requests-{read_date}.jsonl")
    log = open(log_path, "a")
    last, refusals, stopped = {}, {}, set()
    snapshot = {"read_date": read_date, "started": started.isoformat(timespec="seconds"),
                "client": UA["User-Agent"], "boards": []}
    for b in boards:
        host, url = feed_url(b["system"], b["board"])
        entry = {"company": b["company"], "system": b["system"], "board": b["board"], "status": None, "postings": []}
        if host in stopped:
            entry["status"] = "host stopped"
            snapshot["boards"].append(entry)
            continue
        wait = GAP - (time.time() - last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        t = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                body, status = r.read(), r.status
        except Exception as e:
            body, status = b"", getattr(e, "code", type(e).__name__)
        last[host] = time.time()
        log.write(json.dumps({"t": t, "url": url, "status": status, "bytes": len(body)}) + "\n")
        log.flush()
        entry["status"] = status
        if status == 200:
            entry["postings"] = normalize(b["system"], json.loads(body))
        elif status in (403, 429):
            refusals[host] = refusals.get(host, 0) + 1
            if refusals[host] >= 2:
                stopped.add(host)
        snapshot["boards"].append(entry)
        print(f"{b['company']:32} {b['system']:10} {status} {len(entry['postings'])}")
    snapshot["finished"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    snapshot["stopped_hosts"] = sorted(stopped)
    blob = json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()
    snapshot["checksum_sha256"] = hashlib.sha256(blob).hexdigest()
    out = os.path.join(HERE, "cache", f"snapshot-{read_date}.json")
    if os.path.exists(out):
        sys.exit(f"{out} already exists. A second read is a second file on another day; the first is never overwritten.")
    json.dump(snapshot, open(out, "w"), ensure_ascii=False)
    print("snapshot:", out, "checksum:", snapshot["checksum_sha256"][:16])


if __name__ == "__main__":
    main()
