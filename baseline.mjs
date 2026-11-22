// The two yardsticks with no model.
//
// (a) "the title rule": a rule written while planning, with every title in view (it also reads the
//     department), ported here and frozen. It was written with every title in view, which favours the
//     rule, not the model. It answers only the first row of the test table: is this posting delivery,
//     dispatch or fleet work at a company that runs it? (clear = yes, trap = no, unsure = unsure).
// (b) "Always the common answer": for each question, the answer the key gives most often.
//
// Usage: node baseline.mjs   (writes site/data/baseline-answers.json from site/data/postings.json and accounts.json)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DRIVER = /\b(drivers?|couriers?)\b/i;
const DRIVER_NOT = /(driver'?s? licen[sc]e|driver recruit|recruit|driver (success|support|experience|onboarding|app|product|growth|pay|safety|compliance|engagement|acquisition|operations analyst)|screwdriver|device driver|\b(key|business|growth|revenue|cost|value) drivers?\b)/i;
const DRIVER_NOT_DELIVERY = /\b(lot|sale day|yard|shuttle|valet|test|transport|wrecker|rollback|porter)\b/i;
const NEG = /\b(software|engineer(ing)?|developer|devops|product (manager|owner|designer|lead|marketing)|program manager|project manager|scrum|agile|data (scientist|analyst|engineer)|scientist|analytics|marketing|designer|design|ux|sales|account (executive|manager)|recruit(er|ing)|talent|counsel|attorney|accountant|finance|financial|consultant|architect|customer success|implementation|solutions?|care delivery|content delivery|learning|training|instructional|clinical|nurse|physician|therap\w+|pharmacist|compliance|security|infrastructure|platform|machine learning|strategy|aide|caregiver)\b/i;
const SERVICE_DELIVERY = /\b(service|solution|program|project|value|client|care|content|training|learning|technical|it|software|product) delivery\b/i;
const DISPATCH = /\bdispatch(er|ers|ing)?\b/i;
const FLEET = /\bfleet\b/i;
const DELIV = /\bdeliver(y|ies|ing)\b/i;
const LASTMILE = /\blast[\s-]?mile\b/i;
const OPS = /\b(operations?|ops|manager|supervisor|lead|associate|specialist|coordinator|helper|team|technician|tech|station|captain|expert|crew|installer|assistant|agent|runner|member|attendant|mechanic|maintenance|director|head|planner|scheduler|admin(istrator)?|advocate|ambassador|representative)\b/i;
const TECH_DEPT = /(engineering|technology|product|data|design|marketing|finance|legal|people|human resources|talent|sales|clinical|medical|research|security|information)/i;
// Version 2 adds the new title words, treated the way the rule already treats "delivery" (written before any version 2 label was seen).
const LOGISTICS = /\b(logistics|transportation|routing|routes?)\b/i;
const FIELD_TECH = /\bfield (service )?technicians?\b/i;

// A line-for-line port of classify(title, dept) from the script used while planning (not in this repo), plus the version 2 title words above.
export function classify(title, dept) {
  const t = title || "", d = dept || "";
  if (DRIVER.test(t)) {
    if (DRIVER_NOT.test(t)) return "trap";
    if (NEG.test(t) && !/\b(delivery|truck|cdl|route|box truck|van)\b/i.test(t)) return "trap";
    if (DRIVER_NOT_DELIVERY.test(t) && !/\bdeliver/i.test(t)) return "unsure";
    return "clear";
  }
  if (SERVICE_DELIVERY.test(t) && !/customer service delivery/i.test(t)) return "trap";
  if (NEG.test(t)) return "trap";
  if (DISPATCH.test(t)) return "clear";
  if (LASTMILE.test(t)) return TECH_DEPT.test(d) ? "unsure" : "clear";
  if (FLEET.test(t)) return OPS.test(t) && !TECH_DEPT.test(d) ? "clear" : "unsure";
  if (DELIV.test(t)) {
    if (TECH_DEPT.test(d)) return "trap";
    if (OPS.test(t)) return "clear";
    return "unsure";
  }
  if (FIELD_TECH.test(t)) return TECH_DEPT.test(d) ? "unsure" : "clear";
  if (LOGISTICS.test(t)) {
    if (TECH_DEPT.test(d) || /\banalyst\b/i.test(t)) return "trap";
    if (OPS.test(t)) return "clear";
    return "unsure";
  }
  return "unsure";
}

export const CLASS_TO_ANSWER = { clear: "yes", trap: "no", unsure: "unsure" };

// Run as a script (also from a folder whose path has spaces, or on Windows), not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const accounts = JSON.parse(readFileSync("site/data/accounts.json", "utf8")).accounts;
  const dept = {};
  for (const a of accounts) for (const r of a.roles) dept[r.posting_id] = r.department || "";
  const postings = JSON.parse(readFileSync("site/data/postings.json", "utf8")).postings;
  const out = postings.map((p) => {
    const cls = classify(p.title, p.department || dept[p.posting_id] || "");
    return { posting_id: p.posting_id, class: cls, sign: CLASS_TO_ANSWER[cls] };
  });
  writeFileSync("site/data/baseline-answers.json", JSON.stringify({ rule: "the title rule, written with every title in view; version 2 adds the new title words, treated like delivery", answers: out }, null, 1));
  console.log(`the title rule: ${out.filter((x) => x.class === "clear").length} clear, ${out.filter((x) => x.class === "unsure").length} unsure, ${out.filter((x) => x.class === "trap").length} trap, of ${out.length}`);
}
