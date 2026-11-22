// Score the saved answers against the answer key, beside the two yardsticks. No key, no network.
//
//   node score.mjs             writes site/data/scores.json (the test table, the headline numbers, the disagreements, the folds)
//   node score.mjs --standin   before the model was run only: writes site/data/answers.json from the answer key, so the
//                              page could be designed with the key standing in. It refuses once the model's answers exist.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readAnswers, OPS_KINDS, KIND_WORDS, DEFAULT_THRESHOLDS } from "./site/engine.js";

const J = (p) => JSON.parse(readFileSync(p, "utf8"));
const key = J("site/data/key.json");
const postings = J("site/data/postings.json").postings;
const accounts = J("site/data/accounts.json").accounts;
const run = J("site/data/run.json");
const rules = J("site/data/rules.json");
const labels = Object.fromEntries(key.labels.map((l) => [l.posting_id, l]));
const firstLine = (arr) => (arr && arr.length ? `L${String(arr[0]).padStart(3, "0")}` : "none");

if (process.argv.includes("--standin")) {
  if (existsSync("site/data/answers.json") && J("site/data/answers.json").source === "model") {
    console.error("site/data/answers.json holds the model's answers; --standin would overwrite them. Nothing written.");
    process.exit(1);
  }
  const answers = key.labels.map((l) => ({
    posting_id: l.posting_id,
    q1: { [l.q1]: 1 }, q2: { [l.q2]: 1 },
    q1_line: firstLine(l.q1_lines),
  }));
  writeFileSync("site/data/answers.json", JSON.stringify({ source: "answer key standing in", answers }, null, 1));
  console.log(`answers.json: the answer key stands in for ${answers.length} postings`);
  process.exit(0);
}

const answersFile = J("site/data/answers.json");
const model = answersFile.source === "model" ? Object.fromEntries(answersFile.answers.map((a) => [a.posting_id, a])) : null;
const rule = Object.fromEntries(J("site/data/baseline-answers.json").answers.map((a) => [a.posting_id, a]));
const audit = existsSync("site/data/second-labeling.json") ? J("site/data/second-labeling.json") : null;
const disputes = existsSync("site/data/disputes.json") ? J("site/data/disputes.json").disputes : [];
const questionsFile = J("site/data/questions.json");
const v1Ids = new Set(existsSync("site/data/version1-postings.json") ? J("site/data/version1-postings.json").posting_ids : []);

const scored = postings.filter((p) => labels[p.posting_id]);
const companyOf = Object.fromEntries(postings.map((p) => [p.posting_id, p.account]));
const nCompanies = (ids) => new Set(ids.map((id) => companyOf[id])).size;
const truthSign = (l) => (l.q1 === "yes" && OPS_KINDS.includes(l.q2) ? "yes" : "no");

// The plan: "A case the rules cannot settle is left out of that question's count, and counted."
// A posting leaves a row when a dispute the rules did not settle could change that row's answer:
// for the first row, when the second labeler's answer would give a different yes/no; for the line row,
// when the dispute is on question 1.
const unclear = disputes.filter((x) => /rule unclear/.test(x.log));
const outOfSign = new Set(unclear.filter((x) => truthSign({ ...labels[x.posting_id], [x.question]: x.second }) !== truthSign(labels[x.posting_id])).map((x) => x.posting_id));
const outOfLine = new Set(unclear.filter((x) => x.question === "q1").map((x) => x.posting_id));
const signSet = scored.filter((p) => !outOfSign.has(p.posting_id));

function mostCommon(values) {
  const c = {};
  for (const v of values) c[v] = (c[v] || 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return { value: top[0], share: top[1] / values.length };
}

function signNums(say, set = signSet) {
  let match = 0, missed = 0, alarms = 0, unsure = 0;
  for (const p of set) {
    const t = truthSign(labels[p.posting_id]);
    const s = say(p.posting_id);
    if (s === "unsure") unsure++;
    else if (s === t) match++;
    else if (t === "yes") missed++;
    else alarms++;
  }
  return { n: set.length, match, missed, alarms, unsure };
}
function signCounts(say, set = signSet) {
  const c = signNums(say, set);
  return `${c.match} match · ${c.missed} missed · ${c.alarms} false alarm${c.alarms === 1 ? "" : "s"} · ${c.unsure} unsure`;
}

const signTruths = signSet.map((p) => truthSign(labels[p.posting_id]));
const signCommon = mostCommon(signTruths);
const modelSign = (id) => {
  const r = readAnswers(model[id], DEFAULT_THRESHOLDS);
  if (!r.read) return "unsure";
  if (r.runsOperation === "yes" && r.opsWork === "yes") return "yes";
  if (r.runsOperation === "no" || r.opsWork === "no") return "no";
  return "unsure";
};

function quoteNums() {
  let good = 0, not = 0, none = 0;
  for (const p of scored) {
    const l = labels[p.posting_id];
    if (outOfLine.has(p.posting_id) || l.q1 !== "yes" || !l.q1_lines?.length) continue;
    const pick = readAnswers(model[p.posting_id]).q1Line;
    if (!pick) none++;
    else if (l.q1_lines.includes(Number(pick.replace("L", "")))) good++;
    else not++;
  }
  return { n: good + not + none, good, not, none };
}
const lineCases = () => scored.filter((p) => { const l = labels[p.posting_id]; return !outOfLine.has(p.posting_id) && l.q1 === "yes" && l.q1_lines?.length; });
const allCount = (say) => signCounts(say, scored);

const rows = [
  {
    label: "Is this posting delivery, dispatch or fleet work at a company that runs it?",
    note: `Counted on ${signSet.length} of ${scored.length}: ${outOfSign.size} left out because the written rules did not settle their answer (see the disagreements below). The key says yes on ${signTruths.filter((x) => x === "yes").length} and no on ${signTruths.filter((x) => x === "no").length}.`,
    shows_little: signCommon.share >= 0.9,
    model: model ? signCounts(modelSign) : null,
    rule: signCounts((id) => rule[id]?.sign ?? "unsure"),
    common: signCounts(() => signCommon.value),
  },
  {
    label: "Did the quote it picked prove the company runs deliveries?",
    note: `Counted where the key says yes and lists the lines that would prove it${outOfLine.size ? `, leaving out ${outOfLine.size} the rules did not settle` : ""}. The key's lists are generous, which makes this easier to pass.${model ? ` During practice I lowered the confidence needed to show a quote from 50 to ${Math.round(DEFAULT_THRESHOLDS.line * 100)} percent; at 50, ${lineCases().filter((p) => (model[p.posting_id].q1_line_p ?? 1) < 0.5).length} of these ${lineCases().length} would have shown no quote.` : ""}`,
    shows_little: false,
    model: model ? (() => { const c = quoteNums(); return [`${c.good} good proof`, `${c.not} not proof`, `${c.none} no line picked`].join(" · "); })() : null,
    rule: null,
    common: null,
  },
];
if (audit) {
  const sec = Object.fromEntries(audit.labels.map((l) => [l.posting_id, l]));
  const agree = (q) => scored.filter((p) => sec[p.posting_id] && sec[p.posting_id][q] === labels[p.posting_id][q]).length;
  const n = scored.filter((p) => sec[p.posting_id]).length;
  rows.push({
    label: "The answer key and the second AI agreed",
    note: `Of their ${disputes.length} disagreements, the rules settled ${disputes.length - unclear.length} and were unclear on ${unclear.length}. The key's answer was kept each time.`,
    shows_little: false,
    span: true,
    model: `on ${agree("q1")} of ${n} for question 1 and ${agree("q2")} of ${n} for question 2`,
    rule: null, common: null,
  });
}

const disagreements = scored
  .filter((p) => { const s = rule[p.posting_id]?.sign; return s && s !== "unsure" && s !== truthSign(labels[p.posting_id]); })
  .map((p) => {
    const l = labels[p.posting_id];
    const keySays = truthSign(l) === "yes"
      ? `the key reads it as ${KIND_WORDS[l.q2]} at a company that runs the operation`
      : !OPS_KINDS.includes(l.q2) ? `the key reads it as ${KIND_WORDS[l.q2]}` : "the key reads it as a posting that does not show the company running the operation";
    return `“${p.title.trim()}”: the title rule calls it ${rule[p.posting_id].sign === "yes" ? "delivery work" : "not delivery work"}; ${keySays}.`;
  });

const postingById = Object.fromEntries(postings.map((p) => [p.posting_id, p]));
const companyName = Object.fromEntries(accounts.map((a) => [a.id, a.company]));
const ANSWER = { yes: "yes", no: "no", not_said: "not said", ...KIND_WORDS };
const disputeLines = disputes.map((x) => {
  const p = postingById[x.posting_id];
  const q = x.question === "q1" ? "question 1 (does the company run deliveries?)" : "question 2 (what is the job?)";
  const how = /rule unclear/.test(x.log) ? "Rules unclear." : "The rules settled it for the key.";
  const scoresOut = [outOfSign.has(x.posting_id) && "the delivery-work score", outOfLine.has(x.posting_id) && "the quote score"].filter(Boolean);
  const keptInFirst = /rule unclear/.test(x.log) && !outOfSign.has(x.posting_id) ? " Both answers give the delivery-work score the same answer, so it stays counted there." : "";
  const out = (scoresOut.length ? ` Left out of ${scoresOut.join(" and ")}.` : "") + keptInFirst;
  return `${companyName[p.account]}, “${p.title.trim()}”, ${q}: key: ${ANSWER[x.key]}; second AI: ${ANSWER[x.second]}. ${how}${out}`;
});

const ids = scored.map((p) => p.posting_id);
const li = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;
const out = {
  set_size: scored.length,
  set_companies: nCompanies(ids),
  rows,
  // The numbers the top of the page states, from the same counts as the table.
  headline: model ? { ...signNums(modelSign), rule: signNums((id) => rule[id]?.sign ?? "unsure"), quotes: quoteNums(), cost: answersFile.cost || null, postings: scored.length, companies: nCompanies(ids) } : null,
  disagreements,
  disputes: disputeLines,
  disputes_note: `Where the rules did not settle an answer and the second AI's answer would change a score, that posting is left out of that score. I added this after version 1's test run, as my plan for the scoring called for. Counting all ${scored.length} instead: the AI ${allCount(modelSign)}; the title rule ${allCount((id) => rule[id]?.sign ?? "unsure")}.`,
  plain: [
    `I chose the companies and the title words, and I had read the job titles before writing the rules. ${scored.length} postings from ${nCompanies(ids)} companies is a small set: these are counts, not rates.`,
    "Not tested here: whether delivery hiring leads to buying. Only won and lost deals can test that.",
    `With real reps I would measure briefs worked, meetings per brief worked, and cost per account worked (this test run: ${answersFile.cost || "see the README"} for ${scored.length} postings). The Your call choices on each brief are the labels that would correct the rules. Not built: finding people, sending, replies.`,
  ],
  // Version 2 was written after version 1's results: the first row's counts, split by whether a posting was also in version 1.
  split: model && v1Ids.size ? (() => {
    const inV1 = signSet.filter((p) => v1Ids.has(p.posting_id)), fresh = signSet.filter((p) => !v1Ids.has(p.posting_id));
    const ruleSay = (id) => rule[id]?.sign ?? "unsure";
    const idsOf = (set) => set.map((p) => p.posting_id);
    return {
      overlap: scored.filter((p) => v1Ids.has(p.posting_id)).length,
      note: `Version 2's rules were written after version 1's results were seen, and ${scored.filter((p) => v1Ids.has(p.posting_id)).length} of these ${scored.length} postings were also in version 1. The first row, split:`,
      rows: [
        { label: `Also in version 1: ${inV1.length} counted, from ${nCompanies(idsOf(inV1))} companies`, model: signCounts(modelSign, inV1), rule: signCounts(ruleSay, inV1) },
        { label: `New in version 2: ${fresh.length} counted, from ${nCompanies(idsOf(fresh))} companies`, model: signCounts(modelSign, fresh), rule: signCounts(ruleSay, fresh) },
      ],
    };
  })() : null,
  folds: [
    {
      title: "The AI's 2 questions",
      html: li([
        `Question 1, as asked: "${questionsFile.questions.own_operation.instructions.replace(/^Read `posting.title` and `posting.text`. /, "")}" (not said, no, yes)`,
        "What would the person hired mainly do? (other; software or data; warehouse or store; field technician; fleet management; delivery operations management; dispatch or routing; driving or courier)",
        "For question 1, it also picks the line of the posting that shows it. Code copies that line word for word as the quote.",
        `An answer counts as sure when the model gives it ${DEFAULT_THRESHOLDS.q1 * 100} percent or more. An unsure answer sends the company to a person only when the job could still qualify for Brief ready (new, not seasonal, not a repost, not outside the US, and not already a sure "no"). An unsure answer is never shown as a fact.`,
        "I wrote questions 1 and 2 after reading these boards' job titles, and some examples in them come from these postings (junk removal, medical waste pick-up, towing, a delivery station, DOT compliance). Version 2 reworded question 1 (carriers count, passengers do not) and question 2's management and dispatch options, after version 1's results were seen. Its words \"freight or parcel carriers\" echo the Director of Home Delivery posting, and its 60-day window for leadership roles and its narrower rule for unsure answers came from reviews of version 1's results on that posting and on a training-design job.",
        `Version 1, on 30 practice postings from other companies: a third question (who makes the deliveries) was tested and cut, and the quote cutoff moved from 50 to ${Math.round(DEFAULT_THRESHOLDS.line * 100)} percent. Version 2, on a new draw of 30: question 1 was reworded once, then sat exactly at two of my limits (sure but wrong on 3 of 30, all shipping postings; changed on 3 of 30 with the answer options reversed). The README has the details.`,
      ]),
    },
    {
      title: "The rules",
      html: li([
        `A delivery job title holds one of these words: ${rules.title_words_plain}. A delivery job with none of them in its title is never read.`,
        `The title rule (no AI) treats version 2's new title words like "delivery", except that a title with "analyst" counts as not delivery work and a field technician counts as delivery work unless the department is technical.`,
        `New means the job has a posting from the last ${rules.days.new} days, or ${rules.days.new_leader} days for a leadership title (manager, director, head of). Leadership jobs are read first. A job counts as an old one reposted when any of its postings, anywhere at the company, is over ${rules.days.old} days old. I chose these two cutoffs.`,
        "A job is one company plus one job title. Reposts of the same title count once, and anything after a dash or bracket is ignored. Two different titles for the same job count as two jobs.",
        `The AI reads one posting per job: its newest posting in the United States, or its newest posting when none is in the US. At most ${rules.cap_roles_per_company} jobs per company, leadership jobs first.`,
        `Dates clustered: a board of ${rules.clustered.min_postings} or more postings where four in five show dates no more than ${rules.clustered.span_days} days apart.`,
        "Seasonal: a title that says seasonal, holiday, temporary or peak, or a set phrase in the text such as \"seasonal position\".",
        "Region: the United States, checked per posting. That is my choice, not Nash's.",
        "One board (Carvana's) also lists jobs for a second business that does different work; a rule I wrote for that board after reading it leaves those out.",
        `A board is shown only when I can confirm whose it is: the board states the company's name, or at least ${rules.name_check.min_postings_naming} of its postings do.`,
      ]),
    },
    {
      title: "How each company is sorted, in order",
      html: `<ol>${[
        `Needs a person, DATES CLUSTERED: on a board of ${rules.clustered.min_postings} or more postings, four in five or more show dates no more than ${rules.clustered.span_days} days apart.`,
        "Needs a person, NOT READ: a new job's posting could not be read, or the line the AI picked is not in it.",
        "Brief ready: a new job that the AI was sure is delivery, dispatch or fleet work at a company that runs it, in the United States, not seasonal, and not an old job reposted.",
        "Needs a person, PLACE UNCLEAR: a new job the AI was sure is delivery work, but its place cannot be read (for example only \"Remote\").",
        "Needs a person, AI UNSURE: the AI was unsure on a new job that could still qualify.",
        `Skipped, with the first reason that is true:<ul>${[
          "the AI read every job as other work;",
          "the postings do not show the company running its own deliveries;",
          "every new job is an old one reposted;",
          "the only new jobs are seasonal;",
          "no job is in the United States, or its place could not be read;",
          "open a while: the newest posting for a job the AI was sure is delivery work is 31 to 90 days old;",
          "nothing new: no new job, and the newest job the AI was sure about is older than that, or there is none;",
          "no new job qualifies: there is a new job, but each one is outside the US, seasonal, a repost, or not read as delivery work at this company.",
        ].map((x) => `<li>${x}</li>`).join("")}</ul>`,
        "Needs a person, NO RULE FITS: none of the above. The step before always applies when a new job exists, so this one cannot be reached; it stays as a guard.",
      ].map((x) => `<li>${x}</li>`).join("")}</ol>`,
    },
    {
      title: "How the list of boards was made",
      html: li([
        `While planning, 1,931 company names were tried on three job-board systems (Greenhouse, Lever, Ashby). Most were not found. The boards found were checked one at a time, and ${run.boards_listed} were kept. The list is not complete.`,
        "Only those three systems are read. A company that posts jobs only on its own careers site or on another system is never seen.",
        "Only public postings were read, slowly and without logging in. The page shows only short quotes.",
        "The posting text was read by the AI model, and by the AI assistants and the second AI that wrote and checked the answer key.",
        `I left out the companies I could find that Nash names in public. For the ${accounts.length} companies shown, who owns each was also looked up; none is owned by one of those companies. Five owners could not be fully confirmed, and for the 1-800-GOT-JUNK board only the brand's owner was looked up, not the franchise group that runs it. I can't see the rest of Nash's customers.`,
        "Delivery and courier companies themselves are left off the list.",
        "Each company's market is my label, from one public Nash industry page. Nash's own labels would replace mine. The label does not affect which group a company is in.",
      ]),
    },
  ],
  run_line_model: model ? `AI model: ${answersFile.model || "Jev"}, from TypeSafe` : "model not run yet (the answer key stands in)",
  run_line_cost: model ? `test run cost ${answersFile.cost || "see the README"}` : "no model cost yet",
};
writeFileSync("site/data/scores.json", JSON.stringify(out, null, 1));
console.log(`scores.json: ${scored.length} postings from ${out.set_companies} companies; title rule disagrees with the key on ${disagreements.length}`);
