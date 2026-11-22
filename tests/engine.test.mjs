// Public tests. They read only site/data and small made-up fixtures written here, never the private snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { decide, decideAll, orderAccounts, readAnswers, brief } from "../site/engine.js";
import { classify } from "../baseline.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const rules = J("../site/data/rules.json");
const wording = J("../site/data/wording.json");

// ---- made-up fixtures (names end in "Example"; no real company) ----
let n = 0;
const role = (o) => ({ key: `r${++n}`, posting_id: `p${n}`, title: "Delivery Driver", place: "Austin, TX", date: "2026-11-15", date_label: "first published, per the board",
  age: 6, newest_age: 6, oldest_age: 6, postings: 1, places: 1, new: true, older_copies: false, seasonal: null, region: "US", read: true, url: "https://example.com/job", ...o });
const account = (roles, o = {}) => ({ id: `a${++n}`, company: "Fixture Example", market: "retail", notes_role: "the person who runs delivery operations",
  boards: [{ system: "greenhouse", board: "x", board_url: "https://example.com", shown: true }], postings_total: 10, delivery_type_postings: roles.length,
  set_apart: 0, roles_total: roles.length, roles_read: roles.filter((r) => r.read).length, places: 1, local_brands: null, clustered: null, roles, ...o });
const sure = (q1, q2) => ({ q1: { [q1]: 1 }, q2: { [q2]: 1 }, q1_line: "L001" });
const unsure = () => ({ q1: { yes: 0.5, not_said: 0.5 }, q2: { driving_or_courier: 0.5, other: 0.5 }, q1_line: "L001" });

function fixtures() {
  const out = [];
  const add = (roles, answers, o) => { const a = account(roles, o); out.push({ a, answers }); return a; };
  let r;
  r = role({}); add([r], { [r.posting_id]: sure("yes", "driving_or_courier") });                                   // brief ready
  r = role({ older_copies: true, oldest_age: 400 }); add([r], { [r.posting_id]: sure("yes", "driving_or_courier") }); // older copies open
  r = role({}); add([r], { [r.posting_id]: unsure() });                                                              // model unsure, new
  r = role({ new: false, age: 120, newest_age: 120 }); add([r], { [r.posting_id]: unsure() });                       // unsure, old
  r = role({}); add([r], { [r.posting_id]: sure("no", "other") });                                                    // read as other work
  r = role({ seasonal: "title" }); add([r], { [r.posting_id]: sure("yes", "driving_or_courier") });                  // seasonal
  r = role({ region: "not US" }); add([r], { [r.posting_id]: sure("yes", "driving_or_courier") });                   // outside US
  r = role({ new: false, age: 45, newest_age: 45 }); add([r], { [r.posting_id]: sure("yes", "dispatch_or_routing") }); // open a while
  r = role({ new: false, age: 300, newest_age: 300 }); add([r], { [r.posting_id]: sure("yes", "driving_or_courier") }); // nothing new
  r = role({}); add([r], { [r.posting_id]: { broken: true } });                                                       // not read
  r = role({}); add([r], { [r.posting_id]: sure("yes", "driving_or_courier") }, { clustered: { within_14_days: 53, postings: 54 } }); // clustered
  r = role({}); add([r], { [r.posting_id]: sure("not_said", "driving_or_courier") });                                 // no operation shown
  return out;
}

test("each rule of the decision rule gives the group and reason it should", () => {
  const want = [["brief_ready", "BRIEF_READY"], ["skipped", "OLDER_COPIES_OPEN"], ["needs_person", "MODEL_UNSURE"], ["skipped", "NOTHING_NEW"],
    ["skipped", "READ_AS_OTHER_WORK"], ["skipped", "SEASONAL"], ["skipped", "OUTSIDE_US"], ["skipped", "OPEN_A_WHILE"], ["skipped", "NOTHING_NEW"],
    ["needs_person", "NOT_READ"], ["needs_person", "DATES_CLUSTERED"], ["skipped", "NO_DELIVERY_OPERATION_SHOWN"]];
  fixtures().forEach(({ a, answers }, i) => {
    const d = decide(a, answers, rules, wording);
    assert.deepEqual([d.group, d.reason.code], want[i], `fixture ${i}`);
  });
});

test("no fixture reaches the NO RULE FITS line", () => {
  for (const { a, answers } of fixtures()) assert.notEqual(decide(a, answers, rules, wording).reason.code, "NO_RULE_FITS");
});

test("an unsure answer never moves an account into Brief ready, and never becomes a reason that states a fact", () => {
  const factual = ["READ_AS_OTHER_WORK", "NO_DELIVERY_OPERATION_SHOWN"];
  for (const { a, answers } of fixtures()) {
    const before = decide(a, answers, rules, wording);
    for (const id of Object.keys(answers)) {
      for (const q of ["q1", "q2"]) {
        if (answers[id].broken) continue;
        const swapped = { ...answers, [id]: { ...answers[id], [q]: q === "q1" ? { yes: 0.5, not_said: 0.5 } : { driving_or_courier: 0.5, other: 0.5 } } };
        const after = decide(a, swapped, rules, wording);
        if (before.group !== "brief_ready") assert.notEqual(after.group, "brief_ready");
        if (!factual.includes(before.reason.code)) assert.ok(!factual.includes(after.reason.code), `${after.reason.code} from an unsure answer`);
      }
    }
  }
});

test("the page uses the thresholds written in the questions file", async () => {
  const { DEFAULT_THRESHOLDS } = await import("../site/engine.js");
  assert.deepEqual(DEFAULT_THRESHOLDS, J("../site/data/questions.json").thresholds);
});

test("thresholds: an answer below the written line is unsure", () => {
  const r = readAnswers({ q1: { yes: 0.79, no: 0.21 }, q2: { driving_or_courier: 0.5, dispatch_or_routing: 0.31, other: 0.19 }, q1_line: "L003", q1_line_p: 0.19 });
  assert.equal(r.runsOperation, "unsure");
  assert.equal(r.opsWork, "yes", "the operations kinds are added up");
  assert.equal(r.q1Line, null, "a pointed line under the line threshold is not used");
});

test("Brief ready puts delivery kinds before field-service kinds", () => {
  const a1 = account([role({ title: "Plumbing Dispatch" })]), a2 = account([role({ title: "Delivery Station Supervisor", age: 9 })]);
  const answers = { [a1.roles[0].posting_id]: sure("yes", "dispatch_or_routing"), [a2.roles[0].posting_id]: sure("yes", "delivery_operations_management") };
  const list = orderAccounts(decideAll([a1, a2], answers, rules, wording));
  assert.equal(list[0].account.id, a2.id);
});

test("the notes appear on Brief ready accounts, only as 'if a person decides' on Needs a person, never on Skipped, and name a role, never a person", () => {
  const run = { read_date: "2026-11-21" };
  for (const { a, answers } of fixtures()) {
    const d = decide(a, answers, rules, wording);
    const b = brief(a, d, {}, run, wording);
    if (d.group === "brief_ready") assert.ok(b.notes && !b.notes.conditional && /^the person /.test(b.notes.to));
    else if (d.group === "skipped") assert.equal(b.notes, null);
    else if (b.notes) assert.ok(b.notes.conditional && /^the person /.test(b.notes.to));
    assert.ok(b.lines.some((l) => l.tag === "NOT KNOWN"));
  }
});

test("a proof line is shown only where the reading was a sure yes; never on a no or an unsure answer", () => {
  const run = { read_date: "2026-11-21" };
  const quotes = {};
  const make = (ans) => { const r = role({}); quotes[r.posting_id] = { L001: "A line from the posting." }; return { a: account([r]), answers: { [r.posting_id]: ans } }; };
  for (const [ans, shown] of [[sure("yes", "driving_or_courier"), true], [sure("no", "software_or_data"), false], [sure("not_said", "other"), false], [unsure(), false]]) {
    const { a, answers } = make(ans);
    const d = decide(a, answers, rules, wording);
    const b = brief(a, d, quotes, run, wording);
    assert.equal(b.lines.some((l) => l.tag === "SAID"), shown, JSON.stringify(ans.q1));
    if (!shown) assert.ok(!b.lines.some((l) => l.quote), "no quoted line at all");
  }
});

// ---- the wording test ----
const PUBLIC_NEVER = ["qualified", "hot", "in-market", "intent", "buying signal", "ready to buy", "sales leads", "a lead", "prospect", "needs Nash", "would benefit",
  "struggling", "falling behind", "guaranteed", "proven", "will increase", "saves", "ROI", "reply rate", "meetings booked", "pipeline", "converts",
  "accuracy", "accurate", "never misses", "in production", "deployed", "used by", "real time", "autonomous", "AI-powered", "instantly", "faster than",
  "by hand", "hand-labeled", "all year", "not posted before"];
function strings(o, out = []) { if (typeof o === "string") out.push(o); else if (o && typeof o === "object") Object.values(o).forEach((v) => strings(v, out)); return out; }
const hit = (s) => PUBLIC_NEVER.filter((w) => new RegExp(`(?<![\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(s));

test("the wording file uses none of the public never-words", () => {
  for (const s of strings(wording)) assert.deepEqual(hit(s), [], s);
});

test("the page's own text and the scores use none of the public never-words", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8").replace(/<[^>]+>/g, " ");
  assert.deepEqual(hit(html), []);
  const scores = J("../site/data/scores.json");
  for (const s of strings({ rows: scores.rows, plain: scores.plain, folds: scores.folds })) assert.deepEqual(hit(s.replace(/<[^>]+>/g, " ")), [], s);
});

test("the page code, the public README and CHANGES use none of the public never-words", () => {
  const files = ["../site/app.js", "../CHANGES.md", existsSync(new URL("../public/README.md", import.meta.url)) ? "../public/README.md" : "../README.md"];
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.deepEqual(hit(text), [], f);
  }
});

test("every reason the real data produces uses none of the public never-words", () => {
  const accounts = J("../site/data/accounts.json").accounts;
  const answers = Object.fromEntries(J("../site/data/answers.json").answers.map((a) => [a.posting_id, a]));
  for (const { decision } of decideAll(accounts, answers, rules, wording)) assert.deepEqual(hit(decision.reason.text), []);
});

test("every reason and brief line the real data produces is filled in and reads in the singular where the count is 1", () => {
  const accounts = J("../site/data/accounts.json").accounts;
  const answers = Object.fromEntries(J("../site/data/answers.json").answers.map((a) => [a.posting_id, a]));
  const quotes = J("../site/data/quotes.json");
  const run = J("../site/data/run.json");
  const texts = [];
  for (const { account: a, decision: d } of decideAll(accounts, answers, rules, wording)) {
    texts.push(d.reason.text);
    const b = brief(a, d, quotes.quotes || quotes, run, wording);
    for (const l of b.lines) texts.push(l.fact || "");
    for (const st of b.steps) texts.push(st.text);
  }
  for (const { a, answers: ans } of fixtures()) {
    const d = decide(a, ans, rules, wording);
    texts.push(d.reason.text);
    for (const st of brief(a, d, {}, { read_date: "2026-11-21" }, wording).steps) texts.push(st.text);
  }
  for (const s of texts) {
    assert.ok(!/\[\w+\]/.test(s), `placeholder left: ${s}`);
    assert.ok(!/(^|[^\d.,])1 (delivery-type |delivery job )?(roles|places|postings|titles|jobs|locations|job titles)\b/.test(s), `plural after 1: ${s}`);
    assert.ok(!/\b1 delivery role with a new posting here, but each\b/.test(s), s);
    assert.ok(!/ :/.test(s), `space before a colon: ${s}`);
    assert.ok(!/(^|[^\d.])1 days\b/.test(s), `"1 days": ${s}`);
    assert.ok(!/\bfirst first\b/.test(s), s);
    assert.ok(!/\.[A-Z0-9]/.test(s.replace(/\b\d+\.\d+/g, "").replace(/\(M\/F\/X\)/g, "")), `no space after a full stop: ${s}`);
  }
});

test("a Brief ready reason gives the role's first posting date, not its newest copy", () => {
  const r = role({ age: 8, newest_age: 8, oldest_age: 23, postings: 2, places: 2 });
  const d = decide(account([r]), { [r.posting_id]: sure("yes", "driving_or_courier") }, rules, wording);
  assert.equal(d.group, "brief_ready");
  assert.match(d.reason.text, /\b23 days ago/);
});

test("the unsure reason names only the question the model was unsure on", () => {
  const r1 = role({}), r2 = role({});
  const onlyQ1 = decide(account([r1]), { [r1.posting_id]: { q1: { yes: 0.5, not_said: 0.5 }, q2: { driving_or_courier: 1 } } }, rules, wording);
  assert.equal(onlyQ1.reason.code, "MODEL_UNSURE");
  assert.equal(onlyQ1.reason.text, wording.reasons.MODEL_UNSURE.replace("[what]", wording.unsure_what.q1));
  const onlyQ2 = decide(account([r2]), { [r2.posting_id]: { q1: { yes: 1 }, q2: { driving_or_courier: 0.5, other: 0.5 } } }, rules, wording);
  assert.equal(onlyQ2.reason.text, wording.reasons.MODEL_UNSURE.replace("[what]", wording.unsure_what.q2));
});

test("the notes stand on the new posting itself, and the question is tied to the hire", () => {
  const run = { read_date: "2026-11-21" };
  const r = role({ title: "Plumbing Dispatch", place: "Brea, CA" });
  const a = account([r], { market: "field services" });
  const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "dispatch_or_routing") }, rules, wording), {}, run, wording);
  assert.deepEqual([b.notes.stand_on.title, b.notes.stand_on.place, b.notes.stand_on.date, b.notes.stand_on.url], ["Plumbing Dispatch", "Brea, CA", r.date, r.url]);
  assert.equal(b.notes.ask, wording.notes.ask_by_kind.dispatch_or_routing);
  const r2 = role({ place: "Austin, TX" }), a2 = account([r2]);
  const b2 = brief(a2, decide(a2, { [r2.posting_id]: sure("yes", "driving_or_courier") }, rules, wording), {}, run, wording);
  assert.equal(b2.notes.ask, wording.notes.ask_by_kind.driving_or_courier.replace("[in_place]", " in Austin"));
  assert.equal(b2.notes.to, a2.notes_role, "a driver hire: the market's role");
  assert.ok(b2.notes.buyers_note, "a driver hire: the note that drivers' posters are rarely the buyers");
  const r3 = role({ title: "Director of Fleet Management" }), a3 = account([r3]);
  const b3 = brief(a3, decide(a3, { [r3.posting_id]: sure("yes", "fleet_management") }, rules, wording), {}, run, wording);
  assert.match(b3.notes.to, /Director of Fleet Management will report to/, "a leadership hire: the person the role reports to");
  assert.equal(b3.notes.buyers_note, null);
});

test("a leadership hire comes first, among a company's new roles and among Brief ready companies", () => {
  const driver = role({ title: "Delivery Driver", age: 1 }), lead = role({ title: "Fleet Manager", age: 20 });
  const a = account([driver, lead]);
  const d = decide(a, { [driver.posting_id]: sure("yes", "driving_or_courier"), [lead.posting_id]: sure("yes", "fleet_management") }, rules, wording);
  assert.equal(d.ready[0].title, "Fleet Manager");
  const r1 = role({ title: "Route Driver", age: 1 }), r2 = role({ title: "Director of Delivery", age: 25 });
  const a1 = account([r1]), a2 = account([r2]);
  const list = orderAccounts(decideAll([a1, a2], { [r1.posting_id]: sure("yes", "driving_or_courier"), [r2.posting_id]: sure("yes", "delivery_operations_management") }, rules, wording));
  assert.equal(list[0].account.id, a2.id);
});

test("old-role lines leave out jobs outside the United States and jobs read as other work", () => {
  const fresh = role({}), abroad = role({ title: "Delivery Intern", region: "not US", new: false, age: 200, newest_age: 200, oldest_age: 200 });
  const other = role({ title: "Delivery Analyst", new: false, age: 150, newest_age: 150, oldest_age: 150 });
  const kept = role({ title: "Courier", new: false, age: 120, newest_age: 120, oldest_age: 120, read: false });
  const a = account([fresh, abroad, other, kept]);
  const ans = { [fresh.posting_id]: sure("yes", "driving_or_courier"), [abroad.posting_id]: sure("yes", "driving_or_courier"), [other.posting_id]: sure("yes", "software_or_data") };
  const b = brief(a, decide(a, ans, rules, wording), {}, { read_date: "2026-11-21" }, wording);
  const old = b.lines.filter((l) => l.old).map((l) => l.fact);
  assert.deepEqual(old, ["Courier: newest posting is 120 days old."]);
});

test("the size line gives the job board's open postings", () => {
  const r = role({});
  const a = account([r], { postings_total: 1637 });
  const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "driving_or_courier") }, rules, wording), {}, { read_date: "2026-11-21" }, wording);
  assert.match(b.lines.find((l) => l.tag === "NOT KNOWN").fact, /its job board lists 1,637 open postings in all/);
});

test("every change after the lock has one plain line on the page", { skip: !existsSync(new URL("../site/data/lock.json", import.meta.url)) }, () => {
  const changes = J("../site/data/lock.json").entries.filter((e) => e.kind === "change");
  const notes = J("../site/data/lock-notes.json").notes;
  assert.equal(notes.length, changes.length);
  for (const n of notes) assert.ok(n.split(" ").length <= 45 && !/\.(js|mjs|py|json)\b/.test(n), n);
});

test("the count line leaves out postings set apart, so roles, places and postings are about the same postings", () => {
  const r = role({});
  const a = account([r], { delivery_type_postings: 10, set_apart: 4 });
  const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "driving_or_courier") }, rules, wording), {}, { read_date: "2026-11-21" }, wording);
  assert.match(b.lines.find((l) => /delivery job posting/.test(l.fact)).fact, /^6 delivery job postings on its job board: /);
});

test("the scores leave out a posting the written rules did not settle, where it could change that row's answer", () => {
  const key = Object.fromEntries(J("../site/data/key.json").labels.map((l) => [l.posting_id, l]));
  const OPS = ["field_technician", "fleet_management", "delivery_operations_management", "dispatch_or_routing", "driving_or_courier"];
  const sign = (l) => (l.q1 === "yes" && OPS.includes(l.q2) ? "yes" : "no");
  const unclear = J("../site/data/disputes.json").disputes.filter((x) => /rule unclear/.test(x.log));
  const out = new Set(unclear.filter((x) => sign({ ...key[x.posting_id], [x.question]: x.second }) !== sign(key[x.posting_id])).map((x) => x.posting_id));
  const scores = J("../site/data/scores.json");
  const n = Object.keys(key).length - out.size;
  assert.match(scores.rows[0].note, new RegExp(`^Counted on ${n} of ${Object.keys(key).length}: ${out.size} left out`));
  const total = (x) => x.split(" · ").reduce((t, part) => t + Number(part.split(" ")[0]), 0);
  for (const col of ["model", "rule", "common"]) assert.equal(total(scores.rows[0][col]), n, col);
  assert.equal(scores.disputes.length, J("../site/data/disputes.json").disputes.length, "every disagreement is listed on the page");
});

test("version 2: an unsure answer sends a company to a person only when the job could still qualify", () => {
  const ruledOut = role({});
  const d1 = decide(account([ruledOut]), { [ruledOut.posting_id]: { q1: { yes: 0.5, not_said: 0.5 }, q2: { other: 1 } } }, rules, wording);
  assert.equal(d1.group, "skipped", "sure it is other work: unsure on question 1 cannot change the result");
  const abroad = role({ region: "not US" });
  const d2 = decide(account([abroad]), { [abroad.posting_id]: unsure() }, rules, wording);
  assert.deepEqual([d2.group, d2.reason.code], ["skipped", "NONE_QUALIFY"]);
  const open = role({});
  const d3 = decide(account([open]), { [open.posting_id]: unsure() }, rules, wording);
  assert.deepEqual([d3.group, d3.reason.code], ["needs_person", "MODEL_UNSURE"]);
});

test("version 2: the page's leadership pattern is the one in the data rules", async () => {
  const { LEADER } = await import("../site/engine.js");
  assert.equal(LEADER.source, new RegExp(rules.leader_pattern, "i").source);
  assert.equal(rules.days.new_leader, 60);
});

test("a new delivery job whose place cannot be read goes to a person, not to Skipped", () => {
  const r = role({ region: "place not readable", place: "Remote" });
  const d = decide(account([r]), { [r.posting_id]: sure("yes", "delivery_operations_management") }, rules, wording);
  assert.deepEqual([d.group, d.reason.code], ["needs_person", "PLACE_UNCLEAR"]);
  assert.match(d.reason.text, /"Remote"/);
});

test("a Brief ready reason says which date it is about: one posting, a job posted again, or a leadership role", () => {
  const one = role({ age: 1, newest_age: 1, oldest_age: 1 });
  assert.match(decide(account([one]), { [one.posting_id]: sure("yes", "driving_or_courier") }, rules, wording).reason.text, /\b1 day ago\./);
  const again = role({ age: 2, newest_age: 2, oldest_age: 46 });
  assert.match(decide(account([again]), { [again.posting_id]: sure("yes", "field_technician") }, rules, wording).reason.text, /^Newest posting 2 days ago; first published 46 days ago\./);
  const lead = role({ title: "Director of Home Delivery", age: 43, newest_age: 43, oldest_age: 43 });
  assert.match(decide(account([lead]), { [lead.posting_id]: sure("yes", "delivery_operations_management") }, rules, wording).reason.text, /^New leadership role, first published 43 days ago \(leadership roles count as new for 60 days\)/);
});

test("the count line counts jobs new by the same rule as the decision: 30 days, or 60 for a leadership role", () => {
  const lead = role({ title: "Director of Home Delivery", age: 43, newest_age: 43, oldest_age: 43 });
  const a = account([lead]);
  const b = brief(a, decide(a, { [lead.posting_id]: sure("yes", "delivery_operations_management") }, rules, wording), {}, { read_date: "2026-11-21" }, wording);
  assert.match(b.lines.find((l) => /^New jobs/.test(l.fact)).fact, /or 60 for a leadership role\): 1 of 1\./);
});

test("among leadership hires, the one that stands out most comes first: a senior title, not posted many times, at the company with the fewest other new jobs", () => {
  const big = account([role({ title: "Logistics General Manager", age: 1 }), ...Array.from({ length: 5 }, () => role({ title: "Delivery Driver", age: 2 }))]);
  const small = account([role({ title: "Director of Home Delivery", age: 40, newest_age: 40, oldest_age: 40 })]);
  const answers = {};
  for (const r of [...big.roles, ...small.roles]) answers[r.posting_id] = sure("yes", r.title.includes("Driver") ? "driving_or_courier" : "delivery_operations_management");
  const list = orderAccounts(decideAll([big, small], answers, rules, wording));
  assert.equal(list[0].account.id, small.id);
  const many = role({ title: "Logistics Manager", postings: 13, age: 1 }), one = role({ title: "Delivery Driver", age: 1 });
  const d = decide(account([many, one]), { [many.posting_id]: sure("yes", "delivery_operations_management"), [one.posting_id]: sure("yes", "driving_or_courier") }, rules, wording);
  assert.equal(d.ready[0].title, "Logistics Manager", "a plain manager still ranks above a driver");
});

test("the brief quotes the tools a posting names and the notes use its reporting line, both found by plain code", () => {
  const r = role({ title: "General Manager - Delivery Operations" });
  const a = account([r]);
  const quotes = { [r.posting_id]: { L029: "Lead delivery initiatives (e.g., scan-at-delivery, Burq pilot).", L015: "Reports to : Senior General Manager" } };
  const extra = { tools: { [r.posting_id]: [{ line: "L029", names: ["Burq"] }] }, reports_to: { [r.posting_id]: "L015" } };
  const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "delivery_operations_management") }, rules, wording), quotes, { read_date: "2026-11-21" }, wording, extra);
  assert.ok(b.lines.some((l) => l.tag === "SAID" && /^Delivery or dispatch software/.test(l.fact) && /Burq/.test(l.fact) && l.quote === quotes[r.posting_id].L029));
  assert.equal(b.notes.to_quote, "Reports to : Senior General Manager");
  assert.match(b.notes.ask, /"Burq"/);
  assert.equal(b.notes.do_not_assume, wording.notes.do_not_assume_software, "delivery software named: do not assume they want to switch");
  assert.equal(b.notes.buyers_note, null);
  assert.equal(b.notes.to_note, null, "no procurement or finance in the reporting line");
});

test("a quote from another posting at the company names that posting", () => {
  const lead = role({ title: "Transportation Manager" }), other = role({ title: "National Transportation Manager", age: 3 });
  const a = account([lead, other]);
  const answers = { [lead.posting_id]: sure("yes", "delivery_operations_management"), [other.posting_id]: sure("yes", "fleet_management") };
  const quotes = { [lead.posting_id]: { L001: "Plan routes for the delivery team." }, [other.posting_id]: { L001: "Run the fleet.", L018: "Experience with ELD/GPS/telematics, WMS platforms." } };
  const extra = { tools: { [other.posting_id]: [{ line: "L018", names: ["ELD", "telematics", "WMS"] }] }, reports_to: {} };
  const b = brief(a, decide(a, answers, rules, wording), quotes, { read_date: "2026-11-21" }, wording, extra);
  const tools = b.lines.find((l) => /ELD/.test(l.fact));
  assert.equal(tools.job, "National Transportation Manager");
  assert.match(tools.fact, /its National Transportation Manager posting/);
  const proof = b.lines.find((l) => l.ai);
  assert.equal(proof.job, null, "the proof line comes from the job the notes stand on");
  assert.match(proof.fact, /^The AI picked this line from the posting/);
});

test("on a Needs a person company, the proof line comes from the job the row is about, or names its posting", () => {
  const lead = role({ title: "Transportation Manager", age: 9 }), other = role({ title: "Regional Transportation Safety Manager", age: 8 });
  const a = account([lead, other], { clustered: { within_14_days: 10, postings: 10 } });
  const answers = { [lead.posting_id]: sure("yes", "delivery_operations_management"), [other.posting_id]: sure("yes", "fleet_management") };
  const quotes = { [lead.posting_id]: { L001: "Oversee daily transport operations." }, [other.posting_id]: { L001: "Oversee ELD compliance." } };
  const d = decide(a, answers, rules, wording);
  assert.equal(d.group, "needs_person");
  const b = brief(a, d, quotes, { read_date: "2026-11-21" }, wording, { tools: {}, reports_to: {} });
  const headline = d.candidate.title;
  for (const l of b.lines.filter((x) => x.quote)) {
    const from = l.job || headline;
    assert.equal(l.quote, quotes[[lead, other].find((r) => r.title === from).posting_id].L001, `${l.fact} must be from ${from}`);
  }
});

test("generic words are never listed as tools, in the brief or in the question", () => {
  const r = role({ title: "Home Delivery Driver" }), a = account([r]);
  const q = { [r.posting_id]: { L001: "Deliver orders.", L013: "Record deliveries on the delivery application." } };
  const e = { tools: { [r.posting_id]: [{ line: "L013", names: ["delivery application"] }] }, reports_to: {} };
  const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "driving_or_courier") }, rules, wording), q, { read_date: "2026-11-21" }, wording, e);
  assert.ok(!b.lines.some((l) => /delivery application/.test(l.fact)), "no tools line for a generic word");
  assert.doesNotMatch(b.notes.ask, /delivery application/);
});

test("the procurement or finance note reads only the words after 'reports to'", () => {
  const note = (line) => {
    const r = role({ title: "Director of Fleet Management" }), a = account([r]);
    const q = { [r.posting_id]: { L001: "Run the fleet.", L009: line } };
    const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "fleet_management") }, rules, wording), q, { read_date: "2026-11-21" }, wording, { tools: {}, reports_to: { [r.posting_id]: "L009" } });
    return b.notes.to_note;
  };
  assert.match(note("This role reports to the Vice President of Procurement."), /reports into procurement/);
  assert.match(note("Reports directly to the CFO."), /reports into finance/);
  assert.equal(note("Reports to the Director of Logistics and partners with finance."), null);
});

test("old-role lines leave out recruiting jobs; a remote place is not put into the question", () => {
  const fresh = role({ title: "Delivery Driver", place: "Remote" });
  const old = role({ title: "Driver Recruiter", age: 200, newest_age: 200, oldest_age: 200, new: false, read: false });
  const a = account([fresh, old]);
  const b = brief(a, decide(a, { [fresh.posting_id]: sure("yes", "driving_or_courier") }, rules, wording), {}, { read_date: "2026-11-21" }, wording);
  assert.ok(!b.lines.some((l) => /Recruiter/.test(l.fact)), "a recruiting job is not an old delivery role");
  assert.equal(b.notes.ask, wording.notes.ask_by_kind.driving_or_courier.replace("[in_place]", ""));
});

test("the notes say where the hire fits Nash, from the job's kind or from carriers in the quoted lines", () => {
  const r = role({ title: "Director of Home Delivery" }), a = account([r]);
  const q = { [r.posting_id]: { L001: "Own all outbound carrier relationships." } };
  const b = brief(a, decide(a, { [r.posting_id]: sure("yes", "delivery_operations_management") }, rules, wording), q, { read_date: "2026-11-21" }, wording);
  assert.equal(b.notes.fits, wording.notes.fits.carriers);
  assert.match(b.lines.find((l) => l.ai).fact, /The line mentions carriers\./);
  const r2 = role({ title: "HVAC Technician" }), a2 = account([r2]);
  const b2 = brief(a2, decide(a2, { [r2.posting_id]: sure("yes", "field_technician") }, rules, wording), {}, { read_date: "2026-11-21" }, wording);
  assert.equal(b2.notes.fits, wording.notes.fits.field_technician);
});

test("a Brief ready reason says how many more new roles qualify, in the right number", () => {
  const mk = (n) => {
    const roles = Array.from({ length: n }, (_, i) => role({ title: `Delivery Driver ${i}` }));
    const a = account(roles);
    return decide(a, Object.fromEntries(roles.map((r) => [r.posting_id, sure("yes", "driving_or_courier")])), rules, wording).reason.text;
  };
  assert.match(mk(2), / 1 more new role qualifies the same way\.$/);
  assert.match(mk(3), / 2 more new roles qualify the same way\.$/);
  assert.doesNotMatch(mk(1), /more new role/);
});

test("the question names only tools from the posting the notes stand on, and never generic words", () => {
  const lead = role({ title: "Transportation Manager" }), other = role({ title: "National Transportation Manager", age: 3 });
  const a = account([lead, other]);
  const answers = { [lead.posting_id]: sure("yes", "delivery_operations_management"), [other.posting_id]: sure("yes", "fleet_management") };
  const quotes = { [other.posting_id]: { L018: "Experience with ELD/GPS/telematics, WMS platforms." } };
  const extra = { tools: { [other.posting_id]: [{ line: "L018", names: ["ELD", "telematics", "WMS"] }] }, reports_to: {} };
  const d = decide(a, answers, rules, wording);
  const b = brief(a, d, quotes, { read_date: "2026-11-21" }, wording, extra);
  assert.equal(b.notes.stand_on.title, "Transportation Manager");
  assert.doesNotMatch(b.notes.ask, /ELD|WMS|telematics/, "tools from another posting are not credited to this one");
  const r = role({ title: "Home Delivery Driver" }), a2 = account([r]);
  const q2 = { [r.posting_id]: { L013: "Record deliveries on the delivery application." } };
  const e2 = { tools: { [r.posting_id]: [{ line: "L013", names: ["delivery application"] }] }, reports_to: {} };
  const b2 = brief(a2, decide(a2, { [r.posting_id]: sure("yes", "driving_or_courier") }, rules, wording), q2, { read_date: "2026-11-21" }, wording, e2);
  assert.doesNotMatch(b2.notes.ask, /delivery application/, "a generic word is not asked about as a tool");
});

// ---- the look ----
test("the accent colour is used only in the allowed places: the main button and the done dot", () => {
  const css = readFileSync(new URL("../site/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rulesWithAccent = css.split("}").filter((b) => /var\(--accent\)|#C9FF00/i.test(b)).map((b) => b.split("{")[0].trim()).filter((s) => !s.startsWith(":root"));
  for (const sel of rulesWithAccent) assert.ok(/\.btn-accent|\.done-dot/.test(sel), `accent used in ${sel}`);
});

// ---- the data ----
test("every quoted line belongs to its posting (checked against the posting's line fingerprints)", () => {
  const postings = Object.fromEntries(J("../site/data/postings.json").postings.map((p) => [p.posting_id, p]));
  const quotes = J("../site/data/quotes.json").quotes;
  for (const [id, lines] of Object.entries(quotes)) {
    for (const [ln, text] of Object.entries(lines)) {
      const i = Number(ln.replace("L", "")) - 1;
      assert.equal(createHash("sha256").update(text).digest("hex").slice(0, 12), postings[id].line_fingerprints[i], `${id} ${ln}`);
    }
  }
});

test("no email address or phone number appears in any public data file", () => {
  for (const f of ["accounts", "postings", "quotes", "run", "scores"]) {
    const s = readFileSync(new URL(`../site/data/${f}.json`, import.meta.url), "utf8");
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(s.replace(/@context/g, "")), `email in ${f}`);
    assert.ok(!/(?<!\d)\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/.test(s), `phone in ${f}`);
  }
});

test("every board is accounted for, and every company lands in exactly one group", () => {
  const run = J("../site/data/run.json");
  assert.equal(run.boards_with_title + run.boards_without_title + run.boards_not_shown.length, run.boards_listed, "boards with a title + without + not shown = boards read");
  const all = J("../site/data/accounts.json").accounts;
  const answersAll = Object.fromEntries(J("../site/data/answers.json").answers.map((a) => [a.posting_id, a]));
  const groups = decideAll(all, answersAll, rules, wording).map((x) => x.decision.group);
  assert.equal(groups.length, new Set(all.map((a) => a.id)).size, "one row per company");
  assert.ok(groups.every((g) => ["brief_ready", "needs_person", "skipped"].includes(g)));
});

test("the group counts on the page add up to the companies with a delivery-type title", () => {
  const accounts = J("../site/data/accounts.json").accounts;
  const run = J("../site/data/run.json");
  assert.equal(accounts.length, run.companies_with_title);
});

// ---- the lock ----
test("every public locked file matches its fingerprint, or a logged change explains it; the log's chain holds", { skip: !existsSync(new URL("../site/data/lock.json", import.meta.url)) }, () => {
  const log = J("../site/data/lock.json").entries;
  const h = (e) => createHash("sha256").update(JSON.stringify(sortKeys(e))).digest("hex");
  for (let i = 1; i < log.length; i++) assert.equal(log[i].previous, h(log[i - 1]), `chain broken at entry ${i}`);
  const latest = {};
  for (const e of log) for (const [f, v] of Object.entries(e.files || {})) latest[f] = v.sha256;
  for (const [f, s] of Object.entries(latest)) {
    if (f.startsWith("cache/")) continue; // files kept outside this repo are checked separately
    const p = new URL(`../${f}`, import.meta.url);
    if (!existsSync(p)) continue;
    assert.equal(createHash("sha256").update(readFileSync(p)).digest("hex"), s, `${f} changed after the lock with no logged change`);
  }
});

function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  return o;
}

// ---- the yardstick port ----
test("the title rule, ported, gives the classes it gave while planning", () => {
  assert.equal(classify("Bike Delivery Driver", "Field / Delivery Drivers"), "clear");
  assert.equal(classify("Senior Instructional Designer, Training Design & Delivery", "Pharmacy"), "trap");
  assert.equal(classify("Driver, Wrecker Rollback DOT", "Transportation"), "unsure");
  assert.equal(classify("Full-Time Inbound Shift - Warehouse Forklift Driver (Inbound)", "Inbound"), "clear");
  assert.equal(classify("Plumbing Dispatch", "Dispatch"), "clear");
  assert.equal(classify("Director, Care Delivery Learning & Development", "Care Delivery"), "trap");
});
