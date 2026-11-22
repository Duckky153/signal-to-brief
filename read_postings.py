#!/usr/bin/env python3
"""Ask Jev (TypeSafe's model) two fixed questions about each posting, and which line shows the first, and save the answers.

Jev sees only {"posting": {"title", "location", "text"}}, with the text split into numbered lines.
It answers by picking from fixed options, with a probability for each. It writes no text.
Plain code (site/engine.js) makes every decision. The public page never calls Jev.

Run on your own computer, with the TypeSafe key in TYPESAFE_API_KEY (never printed or saved):
  python3 read_postings.py smoke                 5 practice postings, to check the connection and the token count
  python3 read_postings.py practice              the 30 practice postings (tuning only; other companies' postings)
  python3 read_postings.py practice --reversed   the same, with every question's options in reverse order
  python3 read_postings.py practice --again      the same, read a second time (the same request; the vendor offers no switch
                                                 for saved answers, and second reads did differ from the first)
  python3 read_postings.py scored                the scored postings, once, only after the lock

Every paid attempt is logged in cache/spend.jsonl (never published). Before each run the script works out
the worst case (every call as large as the vendor accepts, 64,000 tokens) and refuses to start if that
could cross the cap ($1.00 for this build), or an account-wide limit kept outside this repo.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "site" / "data"
CACHE = HERE / "cache"
LEDGER = CACHE / "spend.jsonl"
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.14.0"
PRICE_PER_TOKEN = 0.042 / 1_000_000  # docs.typesafe.ai/models.md, re-read 2026-11-21: $0.042 per million input tokens
PRICE_READ = "docs.typesafe.ai/models.md, re-read 2026-11-21"
WORST_TOKENS = 64_000  # the most the vendor accepts in one request
CAP = 1.00
# The account-wide limit, and the other spend logs on the same account, are kept outside this repo in
# local/private-paths.json. Without that file neither can be checked, so no paid call is made (see room_left).
PRIVATE_PATHS = HERE / "local" / "private-paths.json"
OUTSIDE = json.loads(PRIVATE_PATHS.read_text()) if PRIVATE_PATHS.exists() else None
OTHER_LEDGERS = [Path(p) for p in OUTSIDE["other_spend_logs"]] if OUTSIDE else None
ACCOUNT_LIMIT = OUTSIDE.get("account_limit") if OUTSIDE else None
MAX_CHARS = 30_000
LOCKED = ["cache/role-texts.json", "data/rules.json", "data/LABEL-RULES.md", "site/data/questions.json",
          "site/data/key.json", "site/data/second-labeling.json", "site/data/disputes.json", "site/engine.js",
          "score.mjs", "baseline.mjs", "site/data/baseline-answers.json", "generate.py", "read_postings.py"]


class Refused(RuntimeError):
    pass


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def state_of(t: dict) -> dict:
    text = "\n".join(f"L{i + 1:03d}| {s}" for i, s in enumerate(t["lines"]))
    return {"posting": {"title": t["title"], "location": t.get("place") or "", "text": text}}


def build_questions(qfile: dict, t: dict, reverse: bool = False) -> dict:
    out = {}
    for qid, q in qfile["questions"].items():
        crit = dict(reversed(list(q["criteria"].items()))) if reverse else dict(q["criteria"])
        out[qid] = {"type": "choice", "instructions": q["instructions"], "criteria": crit}
    for qid, lq in qfile["line_questions"].items():
        crit = {"none": lq["none"]}
        for i in range(len(t["lines"])):
            crit[f"L{i + 1:03d}"] = None
        if reverse:
            crit = dict(reversed(list(crit.items())))
        out[qid] = {"type": "choice", "instructions": lq["instructions"], "criteria": crit}
    return out


def check_reply(reply: dict, questions: dict) -> str | None:
    if reply.get("model") != MODEL:
        return f"model is {reply.get('model')!r}, not {MODEL}"
    usage = reply.get("usage") or {}
    if not isinstance(usage.get("input_tokens"), int) or usage["input_tokens"] <= 0:
        return "usage.input_tokens missing"
    answers = reply.get("answers")
    if not isinstance(answers, dict):
        return "no answers"
    for qid, q in questions.items():
        a = answers.get(qid)
        if not isinstance(a, dict):
            return f"{qid} missing"
        if a.get("choice") not in q["criteria"]:
            return f"{qid} answer {a.get('choice')!r} is not an allowed option"
        probs = a.get("probabilities") or {}
        if not probs or abs(sum(probs.values()) - 1) > 0.02:
            return f"{qid} probabilities missing or do not add to 1"
        if any(k not in q["criteria"] for k in probs):
            return f"{qid} has a probability for an option it was not given"
    return None


def to_answers(posting_id: str, reply: dict | None, problem: str | None) -> dict:
    """The saved shape the page reads: a probability for each option, and the line picked with its probability."""
    if problem or reply is None:
        return {"posting_id": posting_id, "broken": True, "problem": problem}
    a = reply["answers"]
    p = lambda q: a[q]["probabilities"] if q in a else None
    line = lambda q: (a[q]["choice"], a[q]["probabilities"].get(a[q]["choice"], 0)) if q in a else (None, None)
    l1, p1 = line("own_operation_line")
    out = {"posting_id": posting_id, "q1": p("own_operation"), "q2": p("role_kind"), "q1_line": l1, "q1_line_p": p1}
    if "who_delivers" in a:  # question 3 was cut in stb-v4; older practice files still hold it
        l3, p3 = line("who_delivers_line")
        out.update({"q3": p("who_delivers"), "q3_line": l3, "q3_line_p": p3})
    return out


def tokens_in(ledger: Path) -> int:
    if not ledger.exists():
        return 0
    total = 0
    for line in ledger.read_text().splitlines():
        if line.strip():
            try:
                total += int(json.loads(line).get("input_tokens") or 0)
            except ValueError:
                continue
    return total


def log_attempt(tag: str, posting_id: str, tokens, outcome: str):
    CACHE.mkdir(exist_ok=True)
    estimated = tokens is None
    with LEDGER.open("a") as f:
        f.write(json.dumps({"t": round(time.time()), "tag": tag, "posting": posting_id, "outcome": outcome,
                            "input_tokens": WORST_TOKENS if estimated else tokens, "estimated": estimated, "model": MODEL}) + "\n")


def post(body: bytes, key: str):
    req = urllib.request.Request(URL, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def ask(t: dict, questions: dict, key: str, tag: str):
    body = json.dumps({"model": MODEL, "state": state_of(t), "questions": questions}).encode()
    if len(body) > MAX_CHARS * 2:
        raise Refused(f"request for {t['posting_id']} is too long ({len(body)} bytes)")
    delay, attempts = 2.0, 0
    while True:
        attempts += 1
        try:
            return post(body, key), attempts
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504, 529) and attempts < 6:
                log_attempt(tag, t["posting_id"], None, f"retry {e.code}")
                time.sleep(delay); delay *= 2
                continue
            log_attempt(tag, t["posting_id"], None, f"failed {e.code}")
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempts < 6:
                log_attempt(tag, t["posting_id"], None, "retry network")
                time.sleep(delay); delay *= 2
                continue
            log_attempt(tag, t["posting_id"], None, "failed network")
            raise


def room_left(calls: int) -> tuple[float, float]:
    if OTHER_LEDGERS is None or ACCOUNT_LIMIT is None:
        raise Refused("the account-wide limit cannot be checked without local/private-paths.json; no call made")
    others = sum(tokens_in(p) for p in OTHER_LEDGERS) * PRICE_PER_TOKEN
    mine = tokens_in(LEDGER) * PRICE_PER_TOKEN
    room = min(CAP - mine, ACCOUNT_LIMIT - others - mine)
    worst = calls * WORST_TOKENS * PRICE_PER_TOKEN
    return room, worst


def run(mode: str, reverse: bool = False, again: bool = False) -> dict:
    qfile = json.loads((DATA / "questions.json").read_text())
    if mode == "scored":
        dirty = subprocess.run(["git", "status", "--porcelain", "--", *LOCKED], cwd=HERE, capture_output=True, text=True).stdout.strip()
        if dirty:
            raise Refused(f"commit the locked files before the scored run:\n{dirty}")
        # The practice report and its separate review are kept outside this repo, named in local/private-paths.json.
        needed = json.loads(PRIVATE_PATHS.read_text()).get("practice_report_files", []) if PRIVATE_PATHS.exists() else []
        if not needed or not all((HERE / f).exists() for f in needed):
            raise Refused("the practice report and its separate review must exist before the scored run")
        # One scored run per version of the build, and only after that version's lock.
        if (DATA / "answers.json").exists():
            prev = json.loads((DATA / "answers.json").read_text())
            if prev.get("source") == "model" and prev.get("run", {}).get("question_version") == qfile["version"]:
                raise Refused("the scored set has already been read once with these questions; a re-read needs a changed text and a new yes")
        locks = [e for e in json.loads((DATA / "lock.json").read_text())["entries"] if e["kind"] == "lock"] if (DATA / "lock.json").exists() else []
        if not locks or locks[-1].get("version", "1") != qfile.get("build_version", "1"):
            raise Refused("this version of the build is not locked yet")
        texts = json.loads((CACHE / "role-texts.json").read_text())["texts"]
    else:
        texts = json.loads((CACHE / "practice-texts.json").read_text())["texts"]
        if mode == "smoke":
            texts = texts[:5]
    for t in texts:
        if not t["lines"]:
            raise Refused(f"{t['posting_id']} has no text")
    room, worst = room_left(len(texts))
    if worst > room:
        raise Refused(f"worst case ${worst:.4f} for {len(texts)} calls is more than the ${room:.4f} left under the cap")
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise Refused("TYPESAFE_API_KEY is not set")
    tag = f"{mode}{'-reversed' if reverse else ''}{'-again' if again else ''}:{qfile['version']}"
    raw = CACHE / f"replies-{mode}{'-reversed' if reverse else ''}{'-again' if again else ''}.jsonl"
    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    answers, errors, tokens_total = [], [], 0
    for i, t in enumerate(texts):
        questions = build_questions(qfile, t, reverse)
        try:
            reply, attempts = ask(t, questions, key, tag)
        except Exception as e:  # a call that fails after its retries is "not read"; the run goes on
            answers.append(to_answers(t["posting_id"], None, f"call failed: {type(e).__name__}"))
            errors.append({"posting_id": t["posting_id"], "problem": "call failed"})
            if i < 5 and mode != "scored":
                raise Refused(f"the first calls are failing ({type(e).__name__}); nothing more is sent") from e
            continue
        tokens = (reply.get("usage") or {}).get("input_tokens")
        log_attempt(tag, t["posting_id"], tokens if isinstance(tokens, int) and tokens > 0 else None, "ok")
        tokens_total += tokens if isinstance(tokens, int) and tokens > 0 else WORST_TOKENS
        with raw.open("a") as f:
            f.write(json.dumps({"posting_id": t["posting_id"], "reply": reply}) + "\n")
        problem = check_reply(reply, questions)
        if problem:
            errors.append({"posting_id": t["posting_id"], "problem": problem})
        answers.append(to_answers(t["posting_id"], reply, problem))
        print(f"{i + 1}/{len(texts)} {t['posting_id'][:12]} tokens={tokens} {'PROBLEM ' + problem if problem else 'ok'}", flush=True)
    info = {"model": MODEL, "question_version": qfile["version"], "set": mode, "reversed": reverse, "again": again,
            "started": started, "finished": time.strftime("%Y-%m-%dT%H:%M:%S"), "calls": len(texts),
            "errors": errors, "input_tokens": tokens_total, "cost_dollars": round(tokens_total * PRICE_PER_TOKEN, 6),
            "price_per_million": 0.042, "price_read": PRICE_READ, "cap_dollars": CAP,
            "texts_fingerprint": hashlib.sha256(json.dumps([state_of(t) for t in texts], sort_keys=True).encode()).hexdigest()}
    if mode == "scored":
        info["locked"] = {"commit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True).stdout.strip(),
                          "files": {f: sha(HERE / f) for f in LOCKED}}
    return {"source": "model", "run": info, "answers": answers}


def main(argv):
    if not argv or argv[0] not in ("smoke", "practice", "scored"):
        sys.exit(__doc__)
    mode = argv[0]
    reverse, again = "--reversed" in argv, "--again" in argv
    try:
        out = run(mode, reverse, again)
    except Refused as e:
        sys.exit(f"Refused: {e}")
    name = "answers.json" if mode == "scored" else f"answers-{mode}{'-reversed' if reverse else ''}{'-again' if again else ''}.json"
    target = (DATA if mode == "scored" else CACHE) / name
    if mode == "scored":
        out["model"] = f"Jev ({MODEL})"
        out["cost"] = f"${out['run']['cost_dollars']:.4f}"
    target.write_text(json.dumps(out, indent=1) + "\n")
    print(f"saved {target}; {out['run']['calls']} calls, {out['run']['input_tokens']} tokens, ${out['run']['cost_dollars']:.4f}, {len(out['run']['errors'])} problems")


if __name__ == "__main__":
    main(sys.argv[1:])
