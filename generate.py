#!/usr/bin/env python3
"""Turn the frozen snapshot into the page's data. Plain code, no model, no network.

  python3 generate.py facts       snapshot -> site/data/accounts.json, postings.json, run.json,
                                  and cache/role-texts.json (private: the numbered text the model reads)
  python3 generate.py practice    the practice postings -> cache/practice-texts.json (private)
  python3 generate.py quotes ANSWERS.json
                                  copies only the lines an answer file points to into site/data/quotes.json

Every rule it applies is in data/rules.json.
"""
import datetime
import glob
import hashlib
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = json.load(open(os.path.join(HERE, "data", "rules.json")))
TITLE = re.compile(RULES["title_words_pattern"], re.I)
LEADER = re.compile(RULES["leader_pattern"], re.I)
SEASON_T = re.compile(RULES["seasonal"]["title_pattern"], re.I)
SEASON_X = re.compile(RULES["seasonal"]["text_pattern"], re.I)
COPY = re.compile(r"^\s*copy\s+of\s+", re.I)
SPLIT = re.compile(r"\s+-\s+|-\s+|\s+-(?=\S)|\s*\|\s*|\s+\(|\s+–\s+|\s+—\s+")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
PHONE = re.compile(r"(?<!\d)(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
MAX_LINES, MAX_CHARS = 200, 12000

STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND "
          "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split()
STATE_NAMES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
               "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
               "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
               "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
               "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
               "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
               "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"]
US_RE = re.compile(r"\b(" + "|".join(STATES) + r")\b|\b(" + "|".join(STATE_NAMES) + r")\b|United States|\bUSA\b|\bU\.S\.")
NON_US = re.compile(r"\b(Canada|Ontario|Quebec|Toronto|Vancouver|Montreal|UK|United Kingdom|London|England|Scotland|"
                    r"Germany|Berlin|France|Paris|Netherlands|Amsterdam|Australia|Sydney|Melbourne|Ireland|Dublin|"
                    r"Spain|Italy|India|Singapore|Mexico|Sweden|Denmark|Belgium|Austria|Switzerland|Japan|Brazil|"
                    r"Malaysia|Philippines|Poland|Portugal|Colombia|Argentina|Chile|Israel|China|Hong Kong|Taiwan|Korea|"
                    r"Vietnam|Thailand|Indonesia|New Zealand|South Africa|Nigeria|Kenya|Egypt|Turkey|Greece|Romania|Ukraine)\b")
# A US state after a comma or a full US state name settles it first (so "Dublin, OH" and "New Mexico" are US). A bare "US"
# is not read, so the postings read in the version 2 run stay the same.
US_FIRST = re.compile(r",\s*(" + "|".join(STATES) + r")\b|\b(" + "|".join(STATE_NAMES) + r")\b|\bU\.S\.|United States|\bUSA\b")


def role_key(title):
    t = COPY.sub("", title or "")
    parts = [p.strip() for p in SPLIT.split(t) if p and p.strip()]
    if not parts:
        return ""
    pick = next((p for p in parts if TITLE.search(p)), parts[0])
    pick = re.sub(r"[^\w\s&/]", " ", pick.lower())
    return re.sub(r"\s+", " ", pick).strip()


def region(place, country=None):
    if country:
        return "US" if str(country).upper() in ("US", "USA", "UNITED STATES") else "not US"
    p = place or ""
    if US_FIRST.search(p):
        return "US"
    if NON_US.search(p):
        return "not US"
    if US_RE.search(p):
        return "US"
    return "place not readable"


def seasonal(title, text):
    if SEASON_T.search(title or ""):
        return "title"
    m = SEASON_X.search(text or "")
    return ("text: " + m.group(0)) if m else None


def names_company(text, forms):
    t = (text or "").replace("’", "'").replace("‘", "'")
    for f in forms:
        flags = 0 if len(f) <= 3 else re.I
        if re.search(r"(?<![\w'])" + re.escape(f) + r"(?!\w)", t, flags):
            return True
    return False


def clustered(ages):
    c = RULES["clustered"]
    a = sorted(x for x in ages if x is not None)
    if len(a) < c["min_postings"]:
        return False, 0, len(a)
    best, j = 0, 0
    for i in range(len(a)):
        while a[i] - a[j] > c["span_days"]:
            j += 1
        best = max(best, i - j + 1)
    return best / len(a) >= c["share"], best, len(a)


def number_lines(text):
    """Split text into numbered lines: a line break or the end of a sentence starts a new line."""
    lines = []
    for para in (text or "").split("\n"):
        for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(])", para.strip()):
            s = s.strip()
            if s:
                lines.append(s)
    out, total, cut = [], 0, False
    for s in lines:
        if len(out) >= MAX_LINES or total + len(s) > MAX_CHARS:
            cut = True
            break
        out.append(s)
        total += len(s) + 1
    return out, cut


def fp(line):
    return hashlib.sha256(line.encode()).hexdigest()[:12]


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower().replace("'", "")).strip("-")


def is_new_role(title, newest_age, can_be_new=True):
    """New: a posting in the last 30 days, or 60 days for a leadership title (manager, director, head of ...)."""
    if not can_be_new or newest_age is None:
        return False
    days = RULES["days"].get("new_leader", RULES["days"]["new"]) if LEADER.search(title or "") else RULES["days"]["new"]
    return newest_age <= days


def age_of(date, read_date):
    if not date:
        return None
    return (read_date - datetime.date.fromisoformat(date)).days


def facts():
    snaps = sorted(glob.glob(os.path.join(HERE, "cache", "snapshot-*.json")))
    if not snaps:
        sys.exit("No snapshot. Run collect.py first.")
    snap = json.load(open(snaps[-1]))
    read_date = datetime.date.fromisoformat(snap["read_date"])
    boards_meta = {(b["system"], b["board"]): b for b in json.load(open(os.path.join(HERE, "data", "boards.json")))["boards"]}
    markets = {m["label"]: m for m in json.load(open(os.path.join(HERE, "data", "markets.json")))["markets"]}
    new_days, old_days = RULES["days"]["new"], RULES["days"]["old"]
    dates = RULES["dates"]

    companies = {}
    run = {"read_date": snap["read_date"], "client": snap["client"], "snapshot_checksum": snap["checksum_sha256"],
           "boards_listed": len(snap["boards"]), "boards_answered": 0, "boards_not_answered": [],
           "postings_read": 0, "boards_not_shown": [], "stopped_hosts": snap.get("stopped_hosts", [])}
    for b in snap["boards"]:
        meta = boards_meta[(b["system"], b["board"])]
        if b["status"] != 200:
            run["boards_not_answered"].append({"company": b["company"], "system": b["system"], "status": b["status"]})
            continue
        run["boards_answered"] += 1
        ps = b["postings"]
        run["postings_read"] += len(ps)
        stated = any((p.get("company_stated") or "").strip() for p in ps)
        named = sum(1 for p in ps if names_company(p["text"], meta["name_forms"]))
        shown = stated or named >= RULES["name_check"]["min_postings_naming"]
        for p in ps:
            p["system"], p["board"] = b["system"], b["board"]
            p["age"] = age_of(p["date"], read_date)
            p["region"] = region(p["place"], p.get("country"))
        c = companies.setdefault(b["company"], {"company": b["company"], "market": meta["market"], "boards": [], "postings": []})
        if meta.get("display_name"):
            c["display_name"] = meta["display_name"]
        cl, best, tot = clustered([p["age"] for p in ps]) if shown else (False, 0, len(ps))
        cl_ages = sorted(p["age"] for p in ps if p["age"] is not None)
        c["boards"].append({"system": b["system"], "board": b["board"], "board_url": meta["board_url"], "postings": len(ps),
                            "named_by": named, "feed_states_name": stated, "shown": shown,
                            "clustered": cl, "clustered_best": best, "clustered_total": tot})
        if not shown:
            run["boards_not_shown"].append({"company": b["company"], "system": b["system"], "named_by": named})
            continue
        c["postings"].extend(ps)

    accounts, postings_pub, role_texts = [], [], []
    for name, c in companies.items():
        core = [p for p in c["postings"] if TITLE.search(p["title"])]
        if not core:
            continue
        apart = []
        for rule in RULES["set_apart"]:
            sysb = rule["board"].split(":")
            for p in core:
                if [p["system"], p["board"]] == sysb and (any(w in p["title"] for w in rule["title_contains"]) or re.search(rule["department_matches"], p["department"] or "", re.I)):
                    apart.append(p)
        core = [p for p in core if p not in apart]
        brands = None
        for rule in RULES["local_brands"]:
            sysb = rule["board"].split(":")
            bp = [p for p in c["postings"] if [p["system"], p["board"]] == sysb]
            if bp:
                names = [((p["department"] or "").split(" / ")[0]).strip() for p in bp]
                other = [n for n in names if n and rule["own_name"].lower() not in n.lower()]
                brands = {"postings_with_another_name": len(other), "distinct_names": len(set(other)), "postings": len(bp)}
        roles = {}
        for p in core:
            roles.setdefault(role_key(p["title"]), []).append(p)
        rl = []
        for k, v in roles.items():
            v.sort(key=lambda p: (p["age"] if p["age"] is not None else 10 ** 6, p["id"]))
            us = [p for p in v if p["region"] == "US"]
            rep = us[0] if us else v[0]
            ages = [p["age"] for p in v if p["age"] is not None]
            can_new = dates[rep["system"]].get("can_be_new", True)
            newest = min(ages) if ages else None
            leader = bool(LEADER.search(rep["title"] or ""))
            is_new = is_new_role(rep["title"], newest, can_new)
            rl.append({
                "key": k, "posting_id": rep["id"], "title": rep["title"], "place": rep["place"], "department": rep["department"],
                "date": rep["date"], "date_label": dates[rep["system"]]["label"], "age": rep["age"],
                "newest_age": newest, "oldest_age": max(ages) if ages else None,
                "postings": len(v), "places": len({p["place"] for p in v}),
                "new": is_new, "leader": leader, "older_copies": bool(is_new and ages and max(ages) > old_days),
                "seasonal": seasonal(rep["title"], rep["text"]),
                "region": "US" if us else ("not US" if all(p["region"] == "not US" for p in v) else "place not readable"),
                "system": rep["system"], "url": rep["url"], "has_text": bool(rep["text"].strip()),
                "_text": rep["text"],
            })
        # Leadership titles are read first, then the newest roles (the cap is 8 roles per company).
        rl.sort(key=lambda r: (0 if r["leader"] else 1, r["newest_age"] if r["newest_age"] is not None else 10 ** 6, r["posting_id"]))
        cap = RULES["cap_roles_per_company"]
        for i, r in enumerate(rl):
            r["read"] = i < cap and r["has_text"]
            r["not_read_reason"] = None if r["read"] else ("beyond the cap" if i >= cap else "no text")
        acc_id = slug(name)
        cl_board = next((bd for bd in c["boards"] if bd["clustered"]), None)
        acc = {
            "id": acc_id, "company": c.get("display_name") or name, "market": c["market"], "notes_role": markets[c["market"]]["notes_role"],
            "boards": c["boards"], "postings_total": len(c["postings"]),
            "delivery_type_postings": len(core) + len(apart), "set_apart": len(apart),
            "roles_total": len(rl), "roles_read": sum(1 for r in rl if r["read"]),
            "places": len({p["place"] for p in core}),
            "local_brands": brands,
            "clustered": ({"board": cl_board["system"] + ":" + cl_board["board"], "within_14_days": cl_board["clustered_best"],
                           "postings": cl_board["clustered_total"]} if cl_board else None),
            "roles": [{k2: v2 for k2, v2 in r.items() if not k2.startswith("_")} for r in rl],
        }
        accounts.append(acc)
        for r in rl:
            if not r["read"]:
                continue
            lines, cut = number_lines(r["_text"])
            role_texts.append({"posting_id": r["posting_id"], "account": acc_id, "title": r["title"], "place": r["place"],
                               "lines": lines, "truncated": cut})
            postings_pub.append({"posting_id": r["posting_id"], "account": acc_id, "title": r["title"], "place": r["place"], "department": r["department"],
                                 "date": r["date"], "date_label": r["date_label"], "url": r["url"],
                                 "lines": len(lines), "line_fingerprints": [fp(l) for l in lines], "truncated": cut})
    accounts.sort(key=lambda a: a["company"].lower())
    run["companies_with_title"] = len(accounts)
    run["boards_with_title"] = sum(1 for a in accounts for bd in a["boards"] if bd["shown"])
    run["boards_without_title"] = run["boards_answered"] - run["boards_with_title"] - len(run["boards_not_shown"])
    run["role_texts_read"] = len(role_texts)
    run["role_texts_without_text"] = sum(1 for a in accounts for r in a["roles"] if r["not_read_reason"] == "no text")
    run["title_words"] = RULES["title_words_plain"]
    os.makedirs(os.path.join(HERE, "site", "data"), exist_ok=True)
    json.dump({"accounts": accounts}, open(os.path.join(HERE, "site", "data", "accounts.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"postings": postings_pub}, open(os.path.join(HERE, "site", "data", "postings.json"), "w"), indent=1, ensure_ascii=False)
    json.dump(run, open(os.path.join(HERE, "site", "data", "run.json"), "w"), indent=1, ensure_ascii=False)
    json.dump(RULES, open(os.path.join(HERE, "site", "data", "rules.json"), "w"), indent=1, ensure_ascii=False)
    json.dump({"read_date": snap["read_date"], "texts": role_texts}, open(os.path.join(HERE, "cache", "role-texts.json"), "w"), indent=1, ensure_ascii=False)
    print(f"companies with a delivery-type title: {len(accounts)}; boards with one: {run['boards_with_title']}; "
          f"boards without: {run['boards_without_title']}; not shown: {len(run['boards_not_shown'])}; "
          f"role texts to read: {len(role_texts)}; without text: {run['role_texts_without_text']}")


def practice():
    p = RULES["practice"]
    boards = json.load(open(os.path.join(HERE, "data", "boards.json")))["boards"]
    key = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
    names = {key(b["company"]) for b in boards}
    tokens = {b["board"].lower() for b in boards}
    extra = {key(x) for x in p["exclude_extra"]}
    rows = []
    # The saved postings (2026-11-10) the practice set is drawn from are a private folder, named in local/private-paths.json.
    pp = os.path.join(HERE, "local", "private-paths.json")
    if not os.path.exists(pp):
        sys.exit("The practice draw reads a private folder of saved postings (local/private-paths.json). The drawn set is in cache/, also private.")
    src = json.load(open(pp))["practice_source"]
    for f in sorted(glob.glob(os.path.join(src, "collected-*.jsonl"))):
        if not re.search(r"collected-(greenhouse|lever|ashby)\.jsonl$", f):
            continue
        for line in open(f):
            try:
                j = json.loads(line)
            except ValueError:
                continue
            if TITLE.search(j.get("title") or ""):
                rows.append(j)
    keep = []
    for j in rows:
        b, c, u = (j.get("board") or "").lower(), key(j.get("company")), (j.get("url") or "").lower()
        hit = b in tokens or key(b) in extra or c in names or any(n in c for n in names if len(n) > 5) or any(x in key(u) for x in extra)
        if not hit:
            keep.append(j)
    keep.sort(key=lambda j: (j.get("company") or "", j.get("url") or ""))
    capped, seen = [], {}
    for j in keep:
        if seen.get(j["company"], 0) < p["per_company"]:
            capped.append(j)
            seen[j["company"]] = seen.get(j["company"], 0) + 1
    draw = random.Random(p["seed"]).sample(capped, min(p["size"], len(capped)))
    texts = []
    for i, j in enumerate(draw):
        t = EMAIL.sub("[email removed]", j.get("text") or "")
        t = PHONE.sub("[phone removed]", t)
        lines, cut = number_lines(t)
        texts.append({"posting_id": f"P{i + 1:02d}", "company": j.get("company"), "title": j.get("title"),
                      "place": j.get("location") or "", "url": j.get("url"), "lines": lines, "truncated": cut})
    json.dump({"pool": len(rows), "after_exclusion": len(keep), "after_cap": len(capped), "texts": texts},
              open(os.path.join(HERE, "cache", "practice-texts.json"), "w"), indent=1, ensure_ascii=False)
    print(f"practice pool {len(rows)}, after exclusion {len(keep)}, after cap {len(capped)}, drawn {len(texts)}")


def quotes(answers_path):
    """Copy into site/data/quotes.json only the lines that an answer file points to."""
    texts = {t["posting_id"]: t for t in json.load(open(os.path.join(HERE, "cache", "role-texts.json")))["texts"]}
    answers = json.load(open(answers_path))["answers"]
    keep_b = []
    ko = os.path.join(HERE, "local", "keep-out.json")
    if os.path.exists(ko):
        k = json.load(open(ko))
        keep_b = k["list_a"] + k["list_b"]
    out, flagged = {}, []
    for a in answers:
        t = texts.get(a["posting_id"])
        if not t:
            continue
        for q in ("q1_line", "q3_line"):
            n = a.get(q)
            if not n or n == "none":
                continue
            idx = int(str(n).lstrip("L")) - 1
            if 0 <= idx < len(t["lines"]):
                line = t["lines"][idx]
                hits = [w for w in keep_b if re.search(r"(?<![A-Za-z0-9])" + re.escape(w) + r"(?![A-Za-z0-9])", line)]
                if hits:
                    flagged.append({"posting_id": a["posting_id"], "line": n, "names": hits})
                out.setdefault(a["posting_id"], {})[f"L{idx + 1:03d}"] = line
    # Plain code, no model: lines that name the tools or systems a company uses today, and the line that names who the
    # job reports to. A line holding a name on the keep-out list is never kept.
    tools_re = re.compile(RULES["tool_words_pattern"], re.I)
    report_re = re.compile(RULES["reports_to_pattern"], re.I)
    # Up to three lines per posting, each naming at least one tool the lines before it did not, so a name later in a
    # posting is not lost behind two lines that repeat the same word.
    tools, reports = {}, {}
    for a in answers:
        t = texts.get(a["posting_id"])
        if not t:
            continue
        seen = set()
        for i, line in enumerate(t["lines"]):
            if len(line) > 400 or any(re.search(r"(?<![A-Za-z0-9])" + re.escape(w) + r"(?![A-Za-z0-9])", line) for w in keep_b):
                continue
            key = f"L{i + 1:03d}"
            found = sorted({m.group(0) for m in tools_re.finditer(line)}, key=str.lower)
            if found and any(n.lower() not in seen for n in found) and len(tools.get(a["posting_id"], [])) < 3:
                tools.setdefault(a["posting_id"], []).append({"line": key, "names": found})
                out.setdefault(a["posting_id"], {})[key] = line
                seen |= {n.lower() for n in found}
            if report_re.search(line) and a["posting_id"] not in reports:
                reports[a["posting_id"]] = key
                out.setdefault(a["posting_id"], {})[key] = line
    json.dump({"quotes": out, "tools": tools, "reports_to": reports, "flagged_for_reading": flagged},
              open(os.path.join(HERE, "site", "data", "quotes.json"), "w"), indent=1, ensure_ascii=False)
    print(f"quoted lines: {sum(len(v) for v in out.values())}; tools lines: {sum(len(v) for v in tools.values())}; "
          f"reporting lines: {len(reports)}; flagged for a read: {len(flagged)}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "facts"
    if cmd == "facts":
        facts()
    elif cmd == "practice":
        practice()
    elif cmd == "quotes":
        quotes(sys.argv[2])
    else:
        sys.exit(__doc__)
