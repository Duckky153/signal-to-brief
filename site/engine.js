// Signal to Brief: the decision code. Plain code, no model. It runs in the page and in the tests.
//
// Input: one account (the facts plain code counted from the company's public job board) and the
// answers to two fixed questions for each posting that was read (from the model, or from the
// answer key standing in for it). Output: the account's group, the reason as a count or a quote,
// the brief, the notes for a first message, and the steps.

export const OPS_KINDS = ["field_technician", "fleet_management", "delivery_operations_management", "dispatch_or_routing", "driving_or_courier"];
export const KIND_ORDER = ["delivery_operations_management", "dispatch_or_routing", "fleet_management", "driving_or_courier", "field_technician"];
export const KIND_WORDS = {
  delivery_operations_management: "delivery operations management",
  driving_or_courier: "driving or courier",
  dispatch_or_routing: "dispatch or routing",
  fleet_management: "fleet management",
  field_technician: "field technician",
  software_or_data: "software or data",
  warehouse_or_store: "warehouse or store",
  other: "other work",
};
export const DEFAULT_THRESHOLDS = { q1: 0.8, q2: 0.8, line: 0.2 }; // must equal site/data/questions.json (a test checks)
export const GROUPS = ["brief_ready", "needs_person", "skipped"];
// A leadership hire: the person hired is closer to whoever chooses delivery tools than a driver is.
export const LEADER = /\b(manager|director|head of|vice president|vp|chief)\b/i;
// A senior leadership hire that is not posted many times over stands out most; then other leadership hires; then the rest.
export const SENIOR = /\b(director|head of|vice president|vp|chief|general manager)\b/i;
const leaderRank = (r) => (!r ? 3 : SENIOR.test(r.title || "") && (r.postings ?? 1) <= 3 ? 0 : (r.leader ?? LEADER.test(r.title || "")) ? 1 : 2);

// Read one posting's answers into plain yes / no / unsure facts, using the written thresholds.
export function readAnswers(a, t = DEFAULT_THRESHOLDS) {
  if (!a || a.broken) return { read: false, broken: true };
  const p = (dist, key) => (dist && typeof dist[key] === "number" ? dist[key] : 0);
  const q1yes = p(a.q1, "yes");
  const q1noOrNot = p(a.q1, "no") + p(a.q1, "not_said");
  const ops = OPS_KINDS.reduce((s, k) => s + p(a.q2, k), 0);
  const nonOps = 1 - ops;
  const kind = Object.entries(a.q2 || {}).sort((x, y) => y[1] - x[1])[0];
  return {
    read: true,
    broken: false,
    lineMissing: Boolean(a.line_missing),
    runsOperation: q1yes >= t.q1 ? "yes" : q1noOrNot >= t.q1 ? "no" : "unsure",
    opsWork: ops >= t.q2 ? "yes" : nonOps >= t.q2 ? "no" : "unsure",
    kind: kind ? kind[0] : null,
    q1Line: a.q1_line && a.q1_line !== "none" && (a.q1_line_p ?? 1) >= t.line ? a.q1_line : null,
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function fill(template, values) {
  return template.replace(/\[(\w+)\]/g, (_, k) => (values[k] !== undefined ? String(values[k]) : `[${k}]`));
}

const s_ = (n) => (n === 1 ? "" : "s");
const days_ = (n) => `${n} day${s_(n)}`;

// The decision rule. The first match wins.
export function decide(account, answersById, rules, wording, t = DEFAULT_THRESHOLDS) {
  const days = rules.days;
  const roles = account.roles.map((r) => ({ ...r, ans: r.read ? readAnswers(answersById[r.posting_id], t) : null }));
  const read = roles.filter((r) => r.read);
  const confirmed = (r) =>
    r.read && r.ans && !r.ans.broken && !r.ans.lineMissing && r.region === "US" && !r.seasonal &&
    r.ans.runsOperation === "yes" && r.ans.opsWork === "yes";
  // Each reason has a full sentence for the brief and a short one for the row.
  const short = (key, values) => ((wording.reasons_short || {})[key] ? fill(wording.reasons_short[key], values) : null);
  const R = (code, values = {}) => ({ code, text: fill(wording.reasons[code], values), short: short(code, values) });
  let group, reason, rule;

  if (account.clustered) {
    group = "needs_person"; rule = 1;
    const a = account.clustered.within_14_days, b = account.clustered.postings;
    reason = R("DATES_CLUSTERED", { a, b, count: a === b ? `All ${b}` : `${a} of ${b}` });
  }
  const newRead = read.filter((r) => r.new);
  if (!group && newRead.some((r) => r.ans.broken || r.ans.lineMissing)) {
    group = "needs_person"; rule = 2; reason = R("NOT_READ");
  }
  const ready = roles.filter((r) => confirmed(r) && r.new && !r.older_copies);
  if (!group && ready.length) {
    group = "brief_ready"; rule = 3;
    ready.sort((x, y) => leaderRank(x) - leaderRank(y) || KIND_ORDER.indexOf(x.ans.kind) - KIND_ORDER.indexOf(y.ans.kind) || x.age - y.age);
    const best = ready[0];
    // The sentence says which date it is about: one posting, a job posted again, or a leadership role inside its 60 days.
    const first = best.oldest_age ?? best.age, last = best.newest_age ?? best.age;
    const code = last < first ? "BRIEF_READY_REPOST" : first > days.new ? "BRIEF_READY_LEADER" : "BRIEF_READY";
    const label = best.date_label.split(",")[0];
    const values = { title: best.title, nd: days_(first), md: days_(last), label, Label: label.charAt(0).toUpperCase() + label.slice(1),
      lead: days.new_leader ?? days.new, more: ready.length > 1 ? ` ${fill(wording.reasons.MORE_READY, { n: ready.length - 1, s: s_(ready.length - 1), v: ready.length === 2 ? "passes" : "pass" })}` : "" };
    reason = { code: "BRIEF_READY", text: fill(wording.reasons[code], values), short: short(code, values) };
  }
  // Version 2: an unsure answer sends the company to a person only when it could change the result: the job is new,
  // in the United States, not seasonal, not an old job reposted, and neither answer is already a sure "no".
  const couldQualify = (r) => r.region !== "not US" && !r.seasonal && !r.older_copies && r.ans.runsOperation !== "no" && r.ans.opsWork !== "no";
  // A new job read, with sure answers, as delivery work whose place cannot be read (for example only "Remote"): a person checks.
  const placeUnclear = newRead.filter((r) => r.region === "place not readable" && !r.seasonal && !r.older_copies && !r.ans.broken &&
    r.ans.runsOperation === "yes" && r.ans.opsWork === "yes");
  if (!group && placeUnclear.length) {
    group = "needs_person"; rule = 4;
    reason = R("PLACE_UNCLEAR", { place: (placeUnclear[0].place || "").trim() || "nothing" });
  }
  const unsureNew = newRead.filter((r) => couldQualify(r) && (r.ans.runsOperation === "unsure" || r.ans.opsWork === "unsure"));
  if (!group && unsureNew.length) {
    group = "needs_person"; rule = 5;
    const u1 = unsureNew.some((r) => r.ans.runsOperation === "unsure"), u2 = unsureNew.some((r) => r.ans.opsWork === "unsure");
    const which = u1 && u2 ? "both" : u1 ? "q1" : "q2";
    reason = R("MODEL_UNSURE", { what: wording.unsure_what[which], ws: (wording.unsure_short || wording.unsure_what)[which] });
  }
  if (!group) {
    group = "skipped"; rule = 6;
    const confirmedAll = roles.filter(confirmed);
    const confirmedIgnoringRegion = roles.filter((r) => r.read && r.ans && r.ans.runsOperation === "yes" && r.ans.opsWork === "yes" && !r.seasonal);
    const confirmedNew = confirmedAll.filter((r) => r.new);
    const newest = (list) => Math.min(...list.map((r) => r.newest_age));
    if (read.length && read.every((r) => r.ans.opsWork === "no")) {
      const kinds = [...new Set(read.map((r) => KIND_WORDS[r.ans.kind] || "other work"))].map((k) => (/work$/.test(k) ? k : `${k} work`));
      reason = R("READ_AS_OTHER_WORK", { n: read.length, s: s_(read.length), kinds: kinds.join(" or "), it: read.length === 1 ? "it" : "them" });
    } else if (read.length && read.every((r) => r.ans.runsOperation === "no" || r.ans.opsWork === "no") && read.some((r) => r.ans.runsOperation === "no")) {
      reason = R("NO_DELIVERY_OPERATION_SHOWN");
    } else if (confirmedNew.length && confirmedNew.every((r) => r.older_copies)) {
      const k = confirmedNew.length, v = { k, s: s_(k), each: k > 1 ? "each" : "it" };
      reason = { code: "OLDER_COPIES_OPEN", text: fill(wording.reasons[k === 1 ? "OLDER_COPIES_ONE" : "OLDER_COPIES_OPEN"], v), short: short("OLDER_COPIES_OPEN", v) };
    } else if (roles.some((r) => r.new) && roles.filter((r) => r.new).every((r) => r.seasonal)) {
      reason = R("SEASONAL", { n: roles.filter((r) => r.new).length });
    } else if (!confirmedAll.length && confirmedIgnoringRegion.length) {
      reason = R("OUTSIDE_US");
    } else if (confirmedAll.length && newest(confirmedAll) <= days.old) {
      reason = R("OPEN_A_WHILE", { nd: days_(newest(confirmedAll)) });
    } else if (confirmedAll.length || !roles.some((r) => r.new)) {
      // The same tag either way; the sentence says which postings the age is about.
      reason = confirmedAll.length ? R("NOTHING_NEW", { nd: days_(newest(confirmedAll)) })
        : { code: "NOTHING_NEW", text: fill(wording.reasons.NOTHING_NEW_UNREAD, { nd: days_(newest(roles)) }), short: short("NOTHING_NEW_UNREAD", { nd: days_(newest(roles)) }) };
    } else if (roles.some((r) => r.new)) {
      // A new job exists, but none could qualify: outside the US, seasonal, a repost, or not read as delivery work.
      reason = R("NONE_QUALIFY");
    } else {
      group = "needs_person"; rule = 7; reason = R("NO_RULE_FITS");
    }
  }
  // When a person must decide first, the job the notes would stand on if they decide it is fine.
  const sortJobs = (list) => [...list].sort((x, y) => leaderRank(x) - leaderRank(y) || KIND_ORDER.indexOf(x.ans.kind) - KIND_ORDER.indexOf(y.ans.kind) || x.age - y.age);
  const candidate = group !== "needs_person" ? null
    : rule === 4 ? sortJobs(placeUnclear)[0]
    : rule === 1 ? (sortJobs(roles.filter((r) => confirmed(r) && r.new && !r.older_copies))[0] || null) : null;
  return { group, rule, reason, roles, ready, candidate };
}

// The facts for the panel: the brief, the notes and the steps.
export function brief(account, decision, quotes, run, wording, extra = {}) {
  const lines = [];
  const toolsOf = (r) => (r && extra.tools ? extra.tools[r.posting_id] || [] : []);
  const reportOf = (r) => (r && extra.reports_to ? extra.reports_to[r.posting_id] || null : null);
  // The proof line "the posting shows the company runs ..." is shown only for a role where the reading was a sure yes.
  // A line picked on a "no" or an unsure answer is never shown as proof of anything.
  const sureYes = (r) => r && r.read && r.ans && !r.ans.broken && r.ans.runsOperation === "yes";
  const cand = decision.candidate;
  // The ready list is sorted only for Brief ready; elsewhere the row's job is the candidate (or the newest role).
  const top = decision.group === "brief_ready" ? decision.ready[0] : null;
  const best = top || (sureYes(cand) && cand.ans.q1Line ? cand : null) || decision.roles.find((r) => sureYes(r) && r.ans.q1Line) || null;
  const q = (r, line) => (r && line && quotes[r.posting_id] ? quotes[r.posting_id][line] : null);
  // The job the row and the reason are about. A quote from any other posting says which posting it is from.
  const headline = top || cand || [...decision.roles].sort((x, y) => (x.newest_age ?? 1e6) - (y.newest_age ?? 1e6))[0] || null;
  const otherJob = (r) => (headline && r && r.title.trim() !== headline.title.trim() ? r.title.trim() : null);
  const lead = (job) => (job ? fill(wording.brief.lead_other, { job }) : wording.brief.lead_same);
  if (sureYes(best) && best.ans.q1Line && q(best, best.ans.q1Line)) {
    const quote = q(best, best.ans.q1Line), job = otherJob(best);
    lines.push({ tag: "SAID", ai: true, job, fact: fill(wording.brief.runs_operation, { lead: lead(job) }) + (wording.brief.mentions_carriers && /\bcarriers?\b/i.test(quote) ? ` ${wording.brief.mentions_carriers}` : ""),
      quote, posting_id: best.posting_id, line: best.ans.q1Line, date: best.date, date_label: best.date_label, url: best.url });
  }
  // Tools or systems a posting names, found by plain code from a fixed word list, never generic words: the posting the
  // notes stand on first, then the company's other read postings. Delivery or dispatch software comes first.
  const generic = new Set((wording.notes.generic_tools || []).map((x) => x.toLowerCase()));
  const software = new Set((wording.notes.delivery_software || []).map((x) => x.toLowerCase()));
  const isSoftware = (n) => software.has(n.toLowerCase());
  const named = (r) => toolsOf(r).map((e) => ({ line: e.line, names: e.names.filter((n) => !generic.has(n.toLowerCase())) })).filter((e) => e.names.length && q(r, e.line));
  const focus = (decision.group === "brief_ready" ? decision.ready[0] : cand) || best;
  const toolSource = [focus, ...decision.roles.filter((r) => r.read && r !== focus)].find((r) => r && named(r).length) || null;
  const entries = toolSource ? named(toolSource).sort((x, y) => Number(y.names.some(isSoftware)) - Number(x.names.some(isSoftware))) : [];
  const shown = new Set();
  for (const entry of entries) {
    const fresh = entry.names.filter((n) => !shown.has(n));
    if (!fresh.length) continue;
    fresh.forEach((n) => shown.add(n));
    const job = otherJob(toolSource), sw = fresh.filter(isSoftware), rest = fresh.filter((n) => !isSoftware(n));
    const fact = sw.length
      ? fill(wording.brief.software, { lead: lead(job), names: sw.join(", ") }) + (rest.length ? ` ${fill(wording.brief.also_names, { names: rest.join(", ") })}` : "")
      : fill(wording.brief.tools, { lead: lead(job), names: rest.join(", ") });
    lines.push({ tag: "SAID", job, fact, quote: q(toolSource, entry.line), posting_id: toolSource.posting_id,
      line: entry.line, date: toolSource.date, date_label: toolSource.date_label, url: toolSource.url });
  }
  // Counts leave out the postings set apart below, so the roles, places and postings are about the same postings.
  const roleCount = account.roles_total, places = account.places, posts = account.delivery_type_postings - (account.set_apart || 0);
  const nBoards = account.boards.filter((b) => b.shown).length;
  const where = nBoards > 1 ? fill(wording.brief.on_boards, { b: nBoards }) : wording.brief.on_board;
  lines.push({ tag: "COUNTED", fact: roleCount === 1 && posts === 1 ? fill(wording.brief.roles_one, { where })
    : fill(wording.brief.roles, { r: roleCount, p: places, n: posts, rs: s_(roleCount), ps: s_(places), ns: s_(posts), where }) });
  const fresh = account.roles.filter((r) => r.new).length; // new: a posting in the last 30 days, or 60 for a leadership title
  // On a board whose dates are bunched together, "new" rests on those dates, and the line says so.
  lines.push({ tag: "COUNTED", fact: roleCount === 1 ? (fresh ? wording.brief.new_role_one : wording.brief.old_role_one)
    : fill(account.clustered ? wording.brief.new_roles_clustered : wording.brief.new_roles, { k: fresh, r: roleCount, d: run.read_date }) });
  // Old roles that matter to a US rep: in the United States, and not read as other work.
  const oldAll = decision.roles.filter((r) => r.newest_age > 90 && r.region === "US" && !(r.read && r.ans && r.ans.opsWork === "no") && !/\brecruit/i.test(r.title || ""));
  for (const r of oldAll.slice(0, 3)) lines.push({ tag: "COUNTED", old: true, fact: fill(wording.brief.old_role, { title: r.title.trim(), nd: days_(r.newest_age) }) });
  if (oldAll.length > 3) lines.push({ tag: "COUNTED", old: true, fact: fill(wording.brief.old_more, { m: oldAll.length - 3, s: s_(oldAll.length - 3) }) });
  if (account.set_apart) lines.push({ tag: "COUNTED", fact: fill(wording.brief.set_apart, { n: account.set_apart }) });
  if (account.local_brands) lines.push({ tag: "COUNTED", fact: fill(wording.brief.local_brands, { n: account.local_brands.postings_with_another_name, b: account.local_brands.postings }) });
  lines.push({ tag: "NOT KNOWN", fact: fill(wording.brief.not_known, { t: Number(account.postings_total).toLocaleString("en-US"), s: s_(account.postings_total),
    boards: nBoards > 1 ? wording.brief.its_boards_list : wording.brief.its_board_lists, they: "they" }) });

  let notes = null;
  const subject = decision.group === "brief_ready" ? decision.ready[0] : decision.candidate;
  if (subject) {
    // A first message stands on the new posting itself: its title, place and date, with the link.
    // The question is tied to the hire and to any tools the posting names; who to contact comes from the posting's
    // reporting line when it has one, otherwise from the market (and, for a leadership hire, the person it reports to).
    const title = subject.title.trim(), city = (subject.place || "").split(/[,;]/)[0].trim();
    const remote = /\bremote\b/i.test(subject.place || "");
    const inPlace = city && !remote ? ` in ${city}` : "";
    const leader = LEADER.test(title);
    const reportLine = reportOf(subject);
    const reportQuote = reportLine ? q(subject, reportLine) : null;
    // A reporting line into procurement or finance: only the words after "reports to" count.
    // ... up to the end of that clause, so "reports to the Director of Logistics and partners with finance" does not count.
    const reportsInto = reportQuote ? (reportQuote.split(/\breports?(?:ing)?\s*(?:directly\s*)?(?:in)?to\b/i)[1] || "").split(/[;.,]|\band\b|\bwhile\b|\bpartner/i)[0] : "";
    const fin = reportsInto.match(/\b(procurement|purchasing|finance|financial|CFO)\b/i);
    // Only tools named in the posting the notes stand on, never generic words; delivery or dispatch software gets its own question.
    const toolList = [...new Set(toolsOf(subject).flatMap((x) => x.names))].filter((n) => !generic.has(n.toLowerCase()));
    const sw = toolList.filter(isSoftware);
    const say = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0]);
    const toolWords = say(toolList);
    const proof = subject.ans.q1Line ? q(subject, subject.ans.q1Line) : null;
    const carriers = /\bcarriers?\b/i.test(`${proof || ""} ${reportQuote || ""}`);
    notes = {
      company: account.company,
      leader,
      conditional: decision.group !== "brief_ready",
      to: reportQuote ? (leader ? wording.notes.to_reports_leader : wording.notes.to_reports) : leader ? fill(wording.notes.to_leader, { title }) : account.notes_role,
      to_quote: reportQuote,
      to_note: fin ? fill(wording.notes.to_note_finance, { word: /^(financial|cfo)$/i.test(fin[1]) ? "finance" : fin[1].toLowerCase() }) : null,
      stand_on: { title, place: (subject.place || "").trim(), date: subject.date, label: subject.date_label, url: subject.url,
        age: subject.age, first_age: subject.oldest_age ?? subject.age },
      ask: sw.length
        ? fill((wording.notes.ask_software_by_kind || {})[subject.ans.kind] || wording.notes.ask_software, { title, tools: say(sw), in_place: inPlace, does: sw.length > 1 ? "do they" : "does it" })
        : toolList.length
          ? fill((wording.notes.ask_tools_by_kind || {})[subject.ans.kind] || wording.notes.ask_tools, { title, tools: toolWords, in_place: inPlace, those: toolList.length > 1 ? "do those tools" : `does ${toolList[0]}` })
          : fill((wording.notes.ask_by_kind || {})[subject.ans.kind] || wording.notes.ask, { title, in_place: inPlace }),
      fits: carriers ? wording.notes.fits.carriers : (wording.notes.fits[subject.ans.kind] || null),
      do_not_assume: sw.length ? wording.notes.do_not_assume_software : toolList.length ? wording.notes.do_not_assume_tools : wording.notes.do_not_assume,
      buyers_note: !reportQuote && subject.ans.kind === "driving_or_courier" ? wording.notes.buyers_note : null,
    };
  }
  const steps = [
    { who: "CODE", text: fill(account.set_apart ? wording.steps.signal_set_apart : wording.steps.signal, { d: run.read_date, n: account.delivery_type_postings, ns: s_(account.delivery_type_postings), a: account.set_apart, b: plural(account.boards.filter((b) => b.shown).length, "board"),
      boards: account.boards.filter((b) => b.shown).length > 1 ? "its boards" : "the board" }) },
    { who: "MODEL", text: account.roles_read === 1 && run.model ? wording.steps.read_model_one : fill(run.model ? wording.steps.read_model : wording.steps.read_key, { k: account.roles_read }) },
    { who: "CODE", text: fill(wording.steps.checked, { r: account.roles_total, rs: s_(account.roles_total), its: account.roles_total === 1 ? "its" : "their" }) },
    { who: "CODE", text: fill(wording.steps.decided, { rule: decision.rule }) },
  ];
  return { lines, notes, steps };
}

export function decideAll(accounts, answersById, rules, wording, t) {
  return accounts.map((a) => ({ account: a, decision: decide(a, answersById, rules, wording, t) }));
}

export function orderAccounts(list) {
  const rank = (d) => (d.decision.ready[0] ? leaderRank(d.decision.ready[0]) : 9);
  const standsOut = (d) => (rank(d) === 0 ? d.account.roles.filter((r) => r.new).length : 0);
  const kindRank = (d) => (d.decision.ready[0] ? KIND_ORDER.indexOf(d.decision.ready[0].ans.kind) : 99);
  const age = (d) => (d.decision.ready[0] ? d.decision.ready[0].age : Math.min(...d.account.roles.map((r) => r.newest_age ?? 99999)));
  return [...list].sort((x, y) => GROUPS.indexOf(x.decision.group) - GROUPS.indexOf(y.decision.group) || rank(x) - rank(y) || standsOut(x) - standsOut(y) ||
    kindRank(x) - kindRank(y) || age(x) - age(y) || x.account.company.localeCompare(y.account.company));
}
