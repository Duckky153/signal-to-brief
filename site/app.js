// Signal to Brief: draws the page and the panel, and handles the clicks.
// Every number is counted from the saved data when the page loads. A visitor's clicks stay in their own browser.
import { decideAll, orderAccounts, brief, readAnswers, KIND_WORDS, DEFAULT_THRESHOLDS } from "./engine.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STORE = "signal-to-brief-clicks-v1";
// Film mode is for recording the demo on the author's own machine; the public page never enters it.
const FILM = new URLSearchParams(location.search).has("film") && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
const SMOOTH = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
const CODE_URL = "https://github.com/Duckky153/signal-to-brief";

async function load(name) {
  const r = await fetch(`data/${name}.json`);
  if (!r.ok) throw new Error(`data/${name}.json: ${r.status}`);
  return r.json();
}

function usDate(iso) {
  if (!iso) return "no date";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function readClicks() {
  if (FILM) return {};
  try { const c = JSON.parse(localStorage.getItem(STORE) || "{}"); return c && typeof c === "object" && !Array.isArray(c) ? c : {}; } catch { return {}; }
}
function writeClicks(c) {
  if (FILM) return;
  try { localStorage.setItem(STORE, JSON.stringify(c)); } catch { /* storage may be off; clicks then last for this visit only */ }
}

const state = { tab: "brief_ready", clicks: readClicks(), open: null, lastFocus: null };
let D = null;

const groupClass = (g) => (g === "brief_ready" ? "g" : g === "needs_person" ? "a" : "");
const SYSTEM = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };
const MARK = { worked: "Worked", not_a_fit: "Not a fit", looks_fine: "Looks fine", wrongly_skipped: "Wrongly skipped" };
const TAG_SHOWN = { SAID: "QUOTED" };
const WHO_SHOWN = { CODE: "NO AI", MODEL: "AI", "YOUR CLICK": "YOUR CHOICE" };
const DAY = 86400000;
const daysBefore = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) - n * DAY).toISOString().slice(0, 10);

function counts() {
  const c = { brief_ready: 0, needs_person: 0, skipped: 0 };
  for (const d of D.list) c[d.decision.group]++;
  return c;
}

// The job a row is about: the best new role for Brief ready, else the newest delivery-type role.
function signRole(d) {
  return (d.decision.group === "brief_ready" ? d.decision.ready[0] : d.decision.candidate) || [...d.account.roles].sort((x, y) => (x.newest_age ?? 1e6) - (y.newest_age ?? 1e6))[0];
}

function render() {
  const { run } = D;
  $("#eyebrow").textContent = `Public job postings · checked ${usDate(run.read_date)}`;
  $("#sub").textContent =
    `Nash's GTM Engineer posting describes a loop: “A signal comes in, an agent decides what to do with it, the rep gets the account ready to work…” ` +
    `This is my small version of the first part, on one signal: a company posting a new delivery, dispatch or fleet job. ` +
    `From one check of ${run.boards_listed} public job boards on ${usDate(run.read_date)}, an AI model answered two fixed questions about up to ${D.rules.cap_roles_per_company} delivery-type postings per company, ` +
    `plain code (no AI) sorted the companies and wrote each one a short brief for a sales rep. Every quote links to its posting.`;
  const h = D.scores.headline;
  if (h) {
    const wrong = h.missed + h.alarms, ruleWrong = h.rule.missed + h.rule.alarms;
    $("#proof").textContent = `Tested on ${h.n} postings from ${h.companies} companies against an answer key that AI wrote from fixed rules: the AI matched ${h.match}, ` +
      (wrong ? `was sure but wrong on ${wrong}, ` : "was never sure and wrong, ") + `and marked ${h.unsure} unsure. ` +
      `A plain title rule matched ${h.rule.match}, with ${ruleWrong} wrong. The test run cost ${h.cost}.`;
    $("#proof").hidden = false;
  }
  if (D.answers.source !== "model") {
    const p = $("#preview");
    p.hidden = false;
    p.textContent = "Design preview: the answer key stands in for the model";
  }
  renderOverview();
  renderRows();
  const notShown = run.boards_not_shown.length;
  const multi = D.accounts.filter((a) => a.boards.filter((b) => b.shown).length > 1).map((a) => a.company);
  $("#after").textContent =
    `The ${D.list.length} companies above use ${run.boards_with_title} of the ${run.boards_listed} boards` +
    (multi.length ? ` (${multi.join(", ")} ${multi.length === 1 ? "has" : "have"} two)` : "") + `. ` +
    `The other ${run.boards_listed - run.boards_with_title} boards had no job title with a delivery word` +
    (notShown ? `, and ${notShown} of them could not be confirmed as the company's own.` : ".") +
    ` The market under each company name is my own label. Job titles are shown as posted.`;
  renderTested();
}

function renderOverview() {
  const c = counts();
  const w = D.wording;
  const card = (g, cls, dot) => `<button class="ov ${cls}" type="button" id="tab-${g}" aria-pressed="${state.tab === g}" aria-controls="board" data-g="${g}">
      <span class="label"><span class="dot ${dot}"></span>${esc(w.groups[g])}</span><span class="num">${c[g]}</span><span class="what detail">${state.tab === g ? "Shown below" : "Show this list"}</span></button>`;
  $("#overview").innerHTML =
    `<div class="ov static"><span class="label">Companies</span><span class="num">${D.list.length}</span><span class="what detail">with a delivery-word job title, of ${D.run.boards_listed} boards checked</span></div>` +
    card("brief_ready", "", "g") + card("needs_person", c.needs_person ? "amber" : "", "a") + card("skipped", "", "n");
  $("#overview").querySelectorAll("button.ov").forEach((b) => b.addEventListener("click", () => {
    state.tab = b.dataset.g; renderOverview(); renderRows(); $(`#tab-${state.tab}`).focus();
    if ($("#board").getBoundingClientRect().top > window.innerHeight * 0.7) $("#board").scrollIntoView({ behavior: SMOOTH(), block: "start" });
  }));
  $("#board-title").textContent = w.groups[state.tab];
  $("#board-meaning").textContent = w.group_meaning[state.tab].replace("[d]", usDate(D.run.read_date));
}

function renderRows() {
  const w = D.wording;
  const rows = D.list.filter((d) => d.decision.group === state.tab);
  const notDelivery = new Set(["READ_AS_OTHER_WORK", "NO_DELIVERY_OPERATION_SHOWN", "NONE_QUALIFY"]);
  if (state.tab === "skipped") rows.sort((x, y) => notDelivery.has(x.decision.reason.code) - notDelivery.has(y.decision.reason.code));
  let lastPart = null;
  $("#rows").innerHTML = rows.map((d) => {
    const part = state.tab === "skipped" ? (notDelivery.has(d.decision.reason.code) ? w.skipped_parts.not_delivery : w.skipped_parts.runs_deliveries) : null;
    const head = part && part !== lastPart ? `<p class="label part">${esc(part)}</p>` : "";
    lastPart = part;
    const a = d.account, r = signRole(d), cl = groupClass(d.decision.group);
    const click = state.clicks[a.id];
    const mine = click ? `<span class="tag mine">You: ${esc(click.label || MARK[click.mark] || "your call")}</span>` : "";
    const chip = d.decision.group === "brief_ready" && d.decision.ready[0] ? `New · ${KIND_WORDS[d.decision.ready[0].ans.kind] || ""}` : w.tags[d.decision.reason.code];
    return `${head}<button class="row" type="button" data-id="${esc(a.id)}" aria-label="${esc(`${a.company}: ${r.title.trim()}. ${chip}. Open the brief`)}">
      <span><span class="company">${esc(a.company)}</span><span class="detail block">${esc(a.market)}</span></span>
      <span><span class="tagline"><span class="tag ${cl}">${esc(chip)}</span>${mine}</span>
        <span class="headline block">${esc(r.title)}</span>
        <span class="detail block">${esc(d.decision.reason.text)}</span></span>
      <span class="open" aria-hidden="true">Open →</span>
    </button>`;
  }).join("") || `<p class="detail">No accounts in this group.</p>`;
  $("#rows").querySelectorAll(".row").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.id)));
}

function renderTested() {
  const s = D.scores;
  const companies = (n) => `${n} compan${n === 1 ? "y" : "ies"}`;
  const countCells = (x) => String(x).split(" · ").map((p) => `<span class="c">${esc(p)}</span>`).join("");
  const na = '<span class="detail">cannot pick a line</span>';
  const lab = (r) => `<th class="q" scope="row"><span class="strong">${esc(r.label)}</span><span class="detail block">${esc(r.note || "")}${r.shows_little ? " Most postings are a yes, so even always saying yes scores well here." : ""}</span></th>`;
  $("#score-title").textContent = "How often the AI matched an answer key, next to two simple baselines.";
  $("#score-caption").textContent = `${s.set_size} postings from ${companies(s.set_companies)}. ` +
    `Each result is compared with an answer key that AI assistants wrote from written rules before version 2's run; no key writer saw a model answer, though the model had read ${s.split ? s.split.overlap : "some"} of these postings in version 1. ` +
    `The two baselines use no AI: a title rule that looks only at the job title and department (written with every title in view), and always giving the most common answer.`;
  $("#score").innerHTML = `<thead><tr><th class="q" scope="col">Question</th><th scope="col">The AI model</th><th scope="col">The title rule</th><th scope="col">Always the common answer</th></tr></thead><tbody>${
    s.rows.filter((r) => !r.span).map((r) =>
      `<tr>${lab(r)}<td class="num">${countCells(r.model)}</td><td class="num">${r.rule == null ? na : countCells(r.rule)}</td><td class="num">${r.common == null ? na : countCells(r.common)}</td></tr>`).join("")
  }</tbody>`;
  const agree = s.rows.find((r) => r.span);
  const q = s.headline ? s.headline.quotes : null;
  const diffs = D.baseDiffs || [];
  const one = diffs.length === 1;
  const diffLine = !diffs.length ? "" : diffs.every((x) => x.ruleMatchesKey)
    ? ` For the ${one ? "one that differs" : "ones that differ"}, ${diffs.map((x) => x.company).join(", ")}, the title rule sorts ${one ? "it" : "them"} the way the answer key does.`
    : ` ${one ? "The one that differs" : "The ones that differ"}: ${diffs.map((x) => x.company).join(", ")}.`;
  const adds = D.baseSame == null || !q ? "" :
    `<p class="strong-line">With the title rule's yes or no in place of the AI's answers, ${D.baseSame} of ${D.list.length} companies land in the same group.${esc(diffLine)} ` +
    `What the AI adds is the proof and the doubt: it picked a line the answer key counts as proof on ${q.good} of ${q.n} postings, which a title rule cannot do, ` +
    `and it says unsure (below ${Math.round(DEFAULT_THRESHOLDS.q1 * 100)} percent sure) instead of guessing.</p>`;
  const split = s.split ? `<p>${esc(s.split.note)}</p><div class="score-wrap small"><table class="score"><thead><tr><th class="q" scope="col">Postings</th><th scope="col">The AI model</th><th scope="col">The title rule</th></tr></thead><tbody>${
    s.split.rows.map((r) => `<tr><th class="q" scope="row"><span class="strong">${esc(r.label)}</span></th><td class="num">${countCells(r.model)}</td><td class="num">${countCells(r.rule)}</td></tr>`).join("")}</tbody></table></div>` : "";
  $("#plain").innerHTML = adds + (agree ? `<p>${esc(`${agree.label} ${agree.model}. ${agree.note}`)}</p>` : "") + split + s.plain.map((p) => `<p>${esc(p)}</p>`).join("");
  const folds = [...s.folds];
  if (D.modelDiffs.length || D.groupDiffs.length) {
    folds.unshift({ title: "Where the AI and the answer key differ", html:
      `<ul>${D.modelDiffs.map((m) => `<li>${esc(m)}</li>`).join("")}${D.groupDiffs.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` });
  }
  if (s.disputes && s.disputes.length) {
    folds.unshift({ title: `Where the answer key and the second AI disagreed (${s.disputes.length})`, html: `${s.disputes_note ? `<p>${esc(s.disputes_note)}</p>` : ""}<ul>${s.disputes.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` });
  }
  if (s.disagreements && s.disagreements.length) {
    folds.unshift({ title: "Where the title rule and the answer key disagree", html: `<ul>${s.disagreements.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` });
  }
  // Every freeze and every change logged after it (site/data/lock.json), one plain line each (site/data/lock-notes.json).
  const entries = D.lock?.entries || [];
  const changes = entries.filter((e) => e.kind === "change");
  if (entries.some((e) => e.kind === "lock")) {
    const L = D.lockNotes || {};
    const notes = L.notes || [], moved = new Set(L.moved || []);
    let ci = 0, rest = "", open = false, version = "1";
    const top = [];
    for (const e of entries) {
      if (e.kind === "lock") {
        version = e.version || "1";
        if (open) rest += "</ol>";
        rest += `<p><span class="strong">Version ${esc(e.version || "1")} frozen, ${esc(usDate(e.date.slice(0, 10)))}.</span> ${e.version && e.version !== "1" ? esc(L.versions?.[e.version] || "") : "The rules, questions, answer key, sorting code and scoring code were saved with a fingerprint each, and each later change is logged with its reason."}</p><ol>`;
        open = true;
      } else {
        ci++;
        const line = esc(notes[ci - 1] || e.reason);
        if (moved.has(ci)) top.push(`<li value="${ci}"><span class="strong">Version ${esc(version)}.</span> ${line}</li>`); else rest += `<li value="${ci}">${line}</li>`;
      }
    }
    if (open) rest += "</ol>";
    const others = changes.length - top.length;
    folds.push({ title: `Changes after the rules were frozen (${changes.length})`, html:
      `<p>${top.length} of the ${changes.length} changes moved a score or a company:</p><ol>${top.join("")}</ol>` +
      `<details class="inner"><summary>The other ${others}, which moved no score or group</summary>${rest}</details>` +
      (L.reworded ? `<p class="detail">${esc(L.reworded)}</p>` : "") +
      `<p class="detail">The order (freeze first, test second) can be checked only in my unpublished history. The full log is <a href="${CODE_URL}/blob/main/site/data/lock.json" target="_blank" rel="noopener">site/data/lock.json on GitHub ↗</a>.</p>` });
  }
  $("#folds").innerHTML = folds.map((f) => `<details><summary>${esc(f.title)}</summary>${f.html}</details>`).join("");
  const run = D.run;
  $("#runline").innerHTML = [s.run_line_model, `checked ${usDate(run.read_date)}`, `${run.postings_read.toLocaleString("en-US")} postings on ${run.boards_answered} boards`,
    `${run.role_texts_read} read by the AI`, s.run_line_cost, `data fingerprint ${String(run.snapshot_checksum || "").slice(0, 12)}`].map((x, i, all) => `<span class="seg">${esc(x)}${i < all.length - 1 ? " ·" : ""}</span>`).join(" ");
}

function openPanel(id) {
  const d = D.list.find((x) => x.account.id === id);
  if (!d) return;
  state.lastFocus = document.activeElement;
  state.open = id;
  // A brief gets its own history entry, tagged as the page's own, so the browser's Back button closes it.
  if (!FILM && location.hash !== `#${id}`) { history.pushState({ brief: id }, "", `#${id}`); state.pushed = true; }
  else if (!FILM && history.state && history.state.brief === id) state.pushed = true;
  document.body.classList.add("panel-open");
  for (const el of document.querySelectorAll("header.topbar, section.hero, main")) el.inert = true;
  drawPanel(d);
  $("#scrim").hidden = false;
  $("#panel").hidden = false;
  // Focus goes to the brief's title, the start of the dialog; Tab then reaches Close and the rest.
  $("#panel-title").focus();
}

function closePanel(fromHistory) {
  const id = state.open;
  if (!id) return;
  $("#panel").hidden = true;
  $("#scrim").hidden = true;
  document.body.classList.remove("panel-open");
  for (const el of document.querySelectorAll("header.topbar, section.hero, main")) el.inert = false;
  state.open = null;
  if (!FILM && !fromHistory) {
    if (state.pushed) { state.closing = true; history.back(); }
    else history.replaceState(null, "", location.pathname + location.search);
  }
  state.pushed = false;
  const row = id && document.querySelector(`#rows .row[data-id="${CSS.escape(id)}"]`);
  const opener = state.lastFocus && document.contains(state.lastFocus) ? state.lastFocus : null;
  (opener && opener.id === "open-first" ? opener : row || opener || $("#open-first")).focus({ preventScroll: opener && opener.id === "open-first" });
}

function drawPanel(d, flash, focusSel, flashAt) {
  const a = d.account, w = D.wording, cl = groupClass(d.decision.group), r = signRole(d);
  const decidedOpen = Boolean($("#panel details.decided[open]"));
  const b = brief(a, d.decision, D.quotes, { ...D.run, read_date: usDate(D.run.read_date), model: D.answers.source === "model" }, w, D.quoteExtra);
  const click = state.clicks[a.id];
  const boards = a.boards.filter((x) => x.shown).map((x) => `<a href="${esc(x.board_url)}" target="_blank" rel="noopener">Job board (${esc(SYSTEM[x.system] || x.system)}) ↗</a>`).join(" · ");
  const facts = b.lines.map((l) => {
    const tags = `<span class="tag ${l.old ? "a" : ""}">${esc(TAG_SHOWN[l.tag] || l.tag)}</span>${l.ai ? ' <span class="tag">AI pick</span>' : ""}${l.old ? ' <span class="tag a">Old</span>' : ""}`;
    const text = `<span class="fact-text">${esc(l.fact)}</span>`;
    const job = l.job || r.title.trim();
    // A leading list bullet is a mark of the posting's layout, not a word; it is not shown.
    const quote = l.quote
      ? `<div class="quote">“${esc(l.quote.replace(/^[·•\-–]\s*/, ""))}”<span class="src">${l.job ? `From the “${esc(l.job)}” posting · ` : ""}${esc(cap(l.date_label.split(",")[0]))} ${esc(usDate(l.date))} (date from the job board) <span class="nw">· <a href="${esc(l.url)}" target="_blank" rel="noopener" aria-label="${esc(`Open the ${job} posting (new tab)`)}">open the posting ↗</a></span></span></div>`
      : "";
    return `<div class="fact${l.old ? " old" : ""}"><div class="fact-row">${text}<span class="tags">${tags}</span></div>${quote}</div>`;
  }).join("");
  const notes = b.notes ? `
    <section><h3 class="label">First message</h3><p class="detail">${b.notes.conditional ? "If a person decides it is fine: notes for a rep, not an email." : "Notes for a rep, not an email."}</p>
      <div class="notes"><dl>
        <dt>Who to contact</dt><dd>${esc(cap(b.notes.to))}${b.notes.to_quote ? `<div class="detail">“${esc(b.notes.to_quote)}” <span class="nw">· <a href="${esc(b.notes.stand_on.url)}" target="_blank" rel="noopener" aria-label="${esc(`Open the ${b.notes.stand_on.title} posting (new tab)`)}">open the posting ↗</a></span></div>` : ""}${b.notes.to_note ? `<div class="detail">${esc(b.notes.to_note)}</div>` : ""}${b.notes.buyers_note ? `<div class="detail">${esc(b.notes.buyers_note)}</div>` : ""}</dd>
        <dt>Reason to reach out</dt><dd>${esc(standOn(b.notes.stand_on))} <a href="${esc(b.notes.stand_on.url)}" target="_blank" rel="noopener" aria-label="${esc(`Open the ${b.notes.stand_on.title} posting (new tab)`)}">open the posting ↗</a></dd>
        <dt>Question to ask</dt><dd>${esc(b.notes.ask)}</dd>
        <dt>Do not assume</dt><dd>${esc(b.notes.do_not_assume)}</dd>
      </dl>
      <div class="row-actions"><button class="btn btn-small" type="button" id="copy-notes">Copy the notes</button><span class="detail status" role="status" id="copy-status"></span></div></div>
    </section>` : "";
  const reasons = d.decision.group === "skipped"
    ? ["it is delivery work", "the job is new", "other"]
    : ["wrong company", "not really delivery work", "already a customer", "bad timing", "other"];
  const actions = d.decision.group === "brief_ready"
    ? [["worked", "Worked it"], ["not_a_fit", "Not a fit, because..."]]
    : d.decision.group === "needs_person"
      ? [["looks_fine", "Looks fine: I'd work it"], ["not_a_fit", "Skip it, because..."]]
      : [["wrongly_skipped", "Wrongly skipped, because..."]];
  const when = click && Number.isFinite(click.at) ? `, on ${new Date(click.at).toLocaleString("en-US")}` : "";
  const mineLine = click && click.label ? `Your choice: “${click.label}”${click.reason ? `, because ${click.reason}` : ""}. ` : "";
  const steps = b.steps.concat(click && click.label ? [{ who: "YOUR CLICK", text: `You marked it “${click.label}”${click.reason ? `, because ${click.reason}` : ""}${when}.` }] : []);
  $("#panel").innerHTML = `
    <div class="panel-head">
      <div><h2 id="panel-title" tabindex="-1">${esc(a.company)}</h2><div class="detail"><span>${esc(a.market)} (my label)</span><span class="sep"> · </span><span class="boards">${boards}</span></div></div>
      <button class="btn btn-small" type="button" id="panel-close">Close</button>
    </div>
    <div class="panel-body">
      <section>
        <span class="tag ${cl}">${esc(w.tags[d.decision.reason.code])}</span>
        <div class="reason-box"><span class="strong">${esc(r.title)}</span>${esc(d.decision.reason.text)}</div>
        ${b.notes && b.notes.fits ? `<p class="fits"><span class="strong">${esc(w.notes.fits_label)}${b.notes.conditional ? ", if a person decides it is fine" : ""}:</span> ${esc(b.notes.fits)} <span class="detail">${esc(w.notes.fits_note)}</span></p>` : ""}
      </section>
      <section><h3 class="label">The brief</h3>
        <p class="detail">From the company's own job postings. QUOTED: words from a posting. AI PICK: the AI chose the line. COUNTED: counted from its job board, no AI. OLD: newest posting over ${D.rules.days.old} days old. NOT KNOWN: this prototype cannot see it. Ages are as of ${esc(usDate(D.run.read_date))}.</p>${facts}</section>
      ${notes}
      <section><h3 class="label">Your call</h3>
        <div class="actions">${actions.map(([k, label]) => `<button class="btn btn-small" type="button" data-act="${k}" aria-pressed="${click && click.mark === k ? "true" : "false"}" data-label="${esc(label.replace("...", "").replace(", because", ""))}">${esc(label)}</button>`).join("")}</div>
        <div id="reasons" hidden><p class="detail why">Why?</p><div class="reasons">${reasons.map((x) => `<button class="btn btn-small" type="button" data-reason="${esc(x)}">${esc(cap(x))}</button>`).join("")}</div></div>
        <p class="detail"><span class="status" role="status" id="call-status"></span>${esc(mineLine)}Kept in this browser only. In real use, these choices are the labels that would correct the rules. ${click ? '<button class="btn btn-small" type="button" id="clear-mine">Undo my choice</button>' : ""}</p>
      </section>
      <section><details class="decided"${decidedOpen ? " open" : ""}><summary>How this was decided</summary>
        ${d.decision.ready.length ? `<p>New jobs the AI read as delivery, dispatch or fleet work: ${d.decision.ready.map((x) => `${esc(x.title.trim())} (${esc(KIND_WORDS[x.ans.kind] || "")})`).join("; ")}.</p>` : ""}
        <ol class="steps">${steps.map((s) => `<li><span>${esc(s.text)}</span><span class="tag">${esc(WHO_SHOWN[s.who] || s.who)}</span></li>`).join("")}</ol>
      </details></section>
    </div>`;
  wirePanel(d, b);
  const f = focusSel && $(focusSel, $("#panel"));
  if (f) f.focus();
  // The status regions exist before their text is set, so screen readers announce the change.
  const copyStatus = $("#copy-status");
  if (copyStatus) copyStatus.textContent = "Nothing is sent.";
  if (flashAt === "call" && flash) setTimeout(() => { const el = $("#call-status"); if (el) el.innerHTML = `<span class="done-dot"></span>${esc(flash)} `; }, 30);
}

function cap(t) {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function standOn(s) {
  const first = s.first_age > s.age ? ` The same job was first posted elsewhere at the company on ${usDate(daysBefore(D.run.read_date, s.first_age))}.` : "";
  const city = (s.place || "").split(/[,;]/)[0].trim();
  const named = city && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s.title);
  const where = !s.place ? "" : /\bremote\b/i.test(s.place) ? " (listed as remote)" : named ? "" : ` in ${s.place.trim()}`;
  return `Their new ${s.title} job${where}, ${s.label.split(",")[0]} ${usDate(s.date)}.${first}`;
}

function wirePanel(d, b) {
  const a = d.account;
  $("#panel-close").addEventListener("click", () => closePanel());
  const copy = $("#copy-notes");
  if (copy) copy.addEventListener("click", async () => {
    const n = b.notes;
    const extra = [n.to_note, n.buyers_note].filter(Boolean).map((x) => ` ${x}`).join("");
    const text = `Company: ${n.company}\nWho to contact: ${cap(n.to)}${n.to_quote ? ` ("${n.to_quote}")` : ""}.${extra}\nReason to reach out: ${standOn(n.stand_on)} ${n.stand_on.url}\nQuestion to ask: ${n.ask}` +
      `${n.fits ? `\n${D.wording.notes.fits_label} (my reading): ${n.fits}` : ""}\nDo not assume: ${n.do_not_assume}`;
    const status = $("#copy-status");
    try { await navigator.clipboard.writeText(text); status.innerHTML = `<span class="done-dot"></span>Copied. Nothing was sent.`; }
    catch { status.textContent = "Copy did not work in this browser. Select the notes and copy them yourself."; }
  });
  let pending = null;
  $("#panel").querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => {
    const act = btn.dataset.act;
    if (act === "worked" || act === "looks_fine") return save(d, act, btn.dataset.label, null);
    pending = { act, label: btn.dataset.label };
    $("#reasons").hidden = false;
    $("#reasons button").focus();
  }));
  $("#panel").querySelectorAll("[data-reason]").forEach((btn) => btn.addEventListener("click", () => {
    if (pending) save(d, pending.act, pending.label, btn.dataset.reason);
  }));
  const clr = $("#clear-mine");
  if (clr) clr.addEventListener("click", () => { delete state.clicks[a.id]; writeClicks(state.clicks); renderRows(); drawPanel(d, FILM ? "Cleared (film mode: nothing is stored)." : "Your choice was cleared.", "[data-act]", "call"); });
}

function save(d, act, label, reason) {
  state.clicks[d.account.id] = { mark: MARK[act] ? act : "your_call", label, reason, at: Date.now() };
  writeClicks(state.clicks);
  renderRows();
  drawPanel(d, FILM ? "Shown, not saved (film mode)." : "Saved.", "#clear-mine", "call");
}

function trapFocus(e) {
  if ($("#panel").hidden) return;
  if (e.key === "Escape") { closePanel(); return; }
  if (e.key !== "Tab") return;
  const f = [...$("#panel").querySelectorAll("button, a[href], summary, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.closest("[hidden]"));
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !f.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

async function main() {
  const [accounts, postings, run, wording, rules, answers, quotes, scores] = await Promise.all(
    ["accounts", "postings", "run", "wording", "rules", "answers", "quotes", "scores"].map(load));
  const byId = Object.fromEntries(answers.answers.map((x) => [x.posting_id, x]));
  D = { accounts: accounts.accounts, postings: postings.postings, run, wording, rules, answers, quotes: quotes.quotes, scores, modelDiffs: [], groupDiffs: [],
    quoteExtra: { tools: quotes.tools || {}, reports_to: quotes.reports_to || {} } };
  D.list = orderAccounts(decideAll(D.accounts, byId, rules, wording));
  try { D.lock = await load("lock"); } catch { D.lock = null; }
  try { D.lockNotes = await load("lock-notes"); } catch { D.lockNotes = null; }
  // The title rule's yes or no in place of the AI's answers, to show how many companies would land in the same group.
  try {
    const base = await load("baseline-answers");
    const as = (sign) => sign === "yes" ? { q1: { yes: 1 }, q2: { delivery_operations_management: 1 } } : sign === "no" ? { q1: { yes: 1 }, q2: { other: 1 } } : { q1: { yes: 0.5, no: 0.5 }, q2: { other: 0.5, delivery_operations_management: 0.5 } };
    const baseAns = Object.fromEntries(base.answers.map((x) => [x.posting_id, { posting_id: x.posting_id, ...as(x.sign), q1_line: "none" }]));
    const baseGroups = Object.fromEntries(decideAll(D.accounts, baseAns, rules, wording).map((d) => [d.account.id, d.decision.group]));
    D.baseSame = D.list.filter((d) => baseGroups[d.account.id] === d.decision.group).length;
    D.baseGroups = baseGroups;
  } catch { D.baseSame = null; }
  if (answers.source === "model") {
    // The same answers file shape, built from the answer key, so the page can say where the model and the key differ.
    const key = await load("key");
    const keyAns = Object.fromEntries(key.labels.map((l) => [l.posting_id, { posting_id: l.posting_id, q1: { [l.q1]: 1 }, q2: { [l.q2]: 1 }, q1_line: l.q1_lines?.length ? `L${String(l.q1_lines[0]).padStart(3, "0")}` : "none" }]));
    const sign = (a) => { const r = readAnswers(a); return !r.read ? "not read" : r.runsOperation === "yes" && r.opsWork === "yes" ? "yes" : (r.runsOperation === "no" || r.opsWork === "no") ? "no" : "unsure"; };
    const post = Object.fromEntries(D.postings.map((p) => [p.posting_id, p]));
    const company = Object.fromEntries(D.accounts.map((a) => [a.id, a.company]));
    const words = { yes: "delivery, dispatch or fleet work at a company that runs it", no: "it is not", unsure: "unsure", "not read": "not read" };
    for (const p of D.postings) {
      const m = sign(byId[p.posting_id]), k = sign(keyAns[p.posting_id]);
      if (m !== k) D.modelDiffs.push(`${company[p.account]}, “${p.title.trim()}”: the AI was ${m === "unsure" ? "unsure" : `sure it is ${words[m]}`}; the key says ${k === "yes" ? `it is ${words.yes}` : words[k]}.`);
    }
    const keyGroups = Object.fromEntries(decideAll(D.accounts, keyAns, rules, wording).map((d) => [d.account.id, d.decision.group]));
    D.keyGroups = keyGroups;
    for (const d of D.list) {
      const kg = keyGroups[d.account.id];
      if (kg === d.decision.group) continue;
      const clause = d.decision.reason.text.replace(/ A person reads the posting\.$/, "").replace(/\.$/, "");
      D.groupDiffs.push(`${d.account.company}: here in ${wording.groups[d.decision.group]}, because ${clause.charAt(0).toLowerCase()}${clause.slice(1)}. With the answer key's answers, it would be ${wording.groups[kg]}.`);
    }
  }
  if (D.baseGroups && D.keyGroups) D.baseDiffs = D.list.filter((d) => D.baseGroups[d.account.id] !== d.decision.group)
    .map((d) => ({ company: d.account.company, ruleMatchesKey: D.baseGroups[d.account.id] === D.keyGroups[d.account.id] }));
  render();
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const hashId = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; } };
  // "How it was tested" gets its own history entry, so Back returns to the top; focus moves to the section's title.
  document.querySelector('a[href="#tested"]').addEventListener("click", (e) => {
    e.preventDefault();
    if (!FILM && location.hash !== "#tested") history.pushState({ tested: true }, "", "#tested");
    $("#tested").scrollIntoView({ behavior: SMOOTH() });
    $("#score-title").focus({ preventScroll: true });
  });
  $("#open-first").addEventListener("click", () => {
    const first = D.list.find((d) => d.decision.group === "brief_ready") || D.list[0];
    if (first) { state.tab = first.decision.group; renderOverview(); renderRows(); openPanel(first.account.id); }
  });
  $("#scrim").addEventListener("click", () => closePanel());
  document.addEventListener("keydown", trapFocus);
  // Landing on a company's address: make the plain page the entry before it, so Back closes the brief and stays on the site.
  // A reload keeps the entries the page already made (they carry its tag), so it adds none.
  const landing = hashId();
  if (!FILM && landing && landing !== "tested" && D.list.some((x) => x.account.id === landing) && !(history.state && history.state.brief === landing)) {
    history.replaceState(null, "", location.pathname + location.search);
    history.pushState({ brief: landing }, "", `#${landing}`);
  }
  const fromHash = () => {
    const hash = hashId();
    if (state.closing) { state.closing = false; return; }
    if (hash === "tested") { if (state.open) closePanel(true); else $("#tested").scrollIntoView(); return; }
    if (!hash) {
      if (state.open) closePanel(true);
      else { window.scrollTo({ top: 0 }); if ($("#tested").contains(document.activeElement)) document.querySelector('a[href="#tested"]').focus({ preventScroll: true }); }
      return;
    }
    const d = D.list.find((x) => x.account.id === hash);
    if (d && state.open !== hash) {
      if (state.open) closePanel(true);
      state.tab = d.decision.group; renderOverview(); renderRows(); openPanel(hash);
    }
  };
  fromHash();
  window.addEventListener("hashchange", fromHash);
  if (FILM) {
    window.__app = { apply: (s) => { if (s.tab) { state.tab = s.tab; renderOverview(); renderRows(); } if (s.open) openPanel(s.open); if (s.close) closePanel(); }, list: D.list };
    const sc = document.createElement("script");
    // film.js is added only when the film is made; without it film mode just exposes window.__app.
    fetch("film.js", { method: "HEAD" }).then((r) => { if (r.ok) { sc.src = "film.js"; document.body.appendChild(sc); } }).catch(() => {});
  }
}

main().catch((e) => {
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  document.querySelector("main").innerHTML = `<p class="preview">The page could not load its data (${esc(e.message)}).${local ? " Start it with run.sh and open the address it prints." : " Please try again later."}</p>`;
});
