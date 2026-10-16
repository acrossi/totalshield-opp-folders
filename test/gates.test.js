// Node harness for pure gate helpers in Gates.gs (plus Config + Scoring computeScore_)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
  Utilities: { formatDate: (d, tz, fmt) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = t => p.find(x => x.type === t).value; return g('year') + g('month') + g('day'); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperties: () => {} }) },
  console,
  Logger: { log: () => {} }
};
vm.createContext(ctx);
for (const f of ['Config.gs', 'Naming.gs', 'Scoring.gs', 'Placement.gs', 'Gates.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}

let fails = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : `\n   got: ${JSON.stringify(actual)}\n   exp: ${JSON.stringify(expected)}`));
  if (!ok) fails++;
}

const T = (...types) => ({ count: 3, types });
const salesReady = {
  '00_CUSTOMER_DOCS': T('pdf'), '01_CLIENT_INTAKE': T('gdoc'), '02_REQUIREMENTS': T('word'),
  '03_ANALYSIS': T('excel'), '04_MODEL': T('solidworks', 'pdf'), '05_QUOTE': T('gsheet'),
  '06_PURCHASE_ORDER': T('pdf')
};
const closeReady = { ...salesReady, '08_DELIVERABLES': T('pdf') };
const completeReady = { ...closeReady, '10_FINANCIALS': T() };

// folderCredited_
eq(ctx.folderCredited_(salesReady, '04_MODEL'), true, 'model with SW+PDF credited');
eq(ctx.folderCredited_({ '04_MODEL': T('solidworks') }, '04_MODEL'), false, 'model without PDF not credited');
eq(ctx.folderCredited_(salesReady, '08_DELIVERABLES'), false, 'missing deliverables not credited');
eq(ctx.folderCredited_({ '10_FINANCIALS': T() }, '10_FINANCIALS'), true, 'financials any file credited');
eq(ctx.folderCredited_({ '09_INSTALLATION': T('pdf') }, '09_INSTALLATION'), true, 'install bonus folder credited when present');

const prodGate = ctx.CONFIG.GATES.GATES.find(g => g.key === 'production');
const closeGate = ctx.CONFIG.GATES.GATES.find(g => g.key === 'close');
const completeGate = ctx.CONFIG.GATES.GATES.find(g => g.key === 'complete');

// production gate (partial: 02, 04, 05, 06)
const partial = { '02_REQUIREMENTS': T('word'), '04_MODEL': T('solidworks', 'pdf'), '05_QUOTE': T('gsheet'), '06_PURCHASE_ORDER': T('pdf') };
eq(ctx.evaluateGate_(prodGate, partial, {}).passed, true, 'production passes with 02/04/05/06 only');
eq(ctx.evaluateGate_(prodGate, { ...partial, '04_MODEL': T('pdf') }, {}).passed, false, 'production fails without SolidWorks');
eq(ctx.evaluateGate_(prodGate, { '05_QUOTE': T('gsheet') }, {}).missing, ['02_REQUIREMENTS', '04_MODEL', '06_PURCHASE_ORDER'], 'production lists missing required');
eq(ctx.gateRecommendedMissing_(prodGate, partial), ['00_CUSTOMER_DOCS', '01_CLIENT_INTAKE', '03_ANALYSIS'], 'recommended folders reported, not required');

// close gate: 00-06 + 08, plus 09 when installed
eq(ctx.evaluateGate_(closeGate, closeReady, { installed: false }).passed, true, 'close passes for non-installed job');
eq(ctx.evaluateGate_(closeGate, salesReady, {}).missing, ['08_DELIVERABLES'], 'close missing only 08');
const closeMin = { ...partial, '03_ANALYSIS': T('excel'), '08_DELIVERABLES': T('pdf') };
eq(ctx.evaluateGate_(closeGate, closeMin, {}).passed, true, 'close passes with 02-06+08, no 00/01');
eq(ctx.evaluateGate_(closeGate, { ...closeMin, '03_ANALYSIS': undefined }, {}).missing, ['03_ANALYSIS'], 'close requires 03');
eq(ctx.gateRecommendedMissing_(closeGate, closeMin), ['00_CUSTOMER_DOCS', '01_CLIENT_INTAKE'], 'close recommends 00/01');
eq(ctx.evaluateGate_(closeGate, closeReady, { installed: true }).missing, ['09_INSTALLATION'], 'installed job needs 09');
eq(ctx.evaluateGate_(closeGate, { ...closeReady, '09_INSTALLATION': T('pdf') }, { installed: true }).passed, true, 'installed job passes with 09');
eq(ctx.isInstalledJob_(false, 'Customer Installation Support', false), false, 'final stage alone does not mean installed');
eq(ctx.isInstalledJob_(false, 'Active Installation', false), true, 'Active Installation means installed');
eq(ctx.isInstalledJob_(false, 'Customer Installation Support', true), true, 'remembered install sighting');
eq(ctx.isInstalledJob_(true, 'Producing Product', false), true, 'install checkbox means installed');

// complete gate = score 100
eq(ctx.evaluateGate_(completeGate, completeReady, {}).passed, true, 'complete passes at 100');
eq(ctx.evaluateGate_(completeGate, closeReady, {}).passed, false, 'complete fails without financials');
eq(ctx.evaluateGate_(completeGate, closeReady, {}).missing.includes('10_FINANCIALS'), true, 'complete names financials as missing');
eq(ctx.evaluateGate_(completeGate, completeReady, {}).score, 100, 'complete reports score 100');

// checkbox map + override
const results = ctx.evaluateAllGates_(salesReady, { stageName: 'Initial Down Payment Received' });
const mapNoOverride = ctx.gateCheckboxMap_(results, false, { pipelineName: 'Sales', stageName: 'Initial Down Payment Received' });
eq(mapNoOverride['Docs OK for Production'], true, 'checkbox production true when passed');
eq(mapNoOverride['Docs OK for Close'], false, 'checkbox close false without 08');
eq(mapNoOverride['Docs OK for Complete'], false, 'checkbox complete false under 100');
const mapOverride = ctx.gateCheckboxMap_(results, true, { pipelineName: 'Sales' });
eq(mapOverride['Docs OK for Production'] && mapOverride['Docs OK for Close'] && mapOverride['Docs OK for Complete'], true, 'override forces all Docs OK true');

// sticky: already in Production with empty folder must not clear Docs OK for Production
const emptyResults = ctx.evaluateAllGates_({}, {});
const stickyProd = ctx.gateCheckboxMap_(emptyResults, false, { pipelineName: 'Production' });
eq(Object.prototype.hasOwnProperty.call(stickyProd, 'Docs OK for Production'), false, 'sticky: omit production untick when already in Production');
eq(stickyProd['Docs OK for Close'], false, 'still write close=false while in Production');
const stickyClosed = ctx.gateCheckboxMap_(emptyResults, false, { pipelineName: 'Closed Projects', stageName: 'Folder Review' });
eq(Object.prototype.hasOwnProperty.call(stickyClosed, 'Docs OK for Production'), false, 'sticky: omit production untick in Closed');
eq(Object.prototype.hasOwnProperty.call(stickyClosed, 'Docs OK for Close'), false, 'sticky: omit close untick in Closed');
eq(stickyClosed['Docs OK for Complete'], false, 'complete still written false at Folder Review');
const stickyDone = ctx.gateCheckboxMap_(emptyResults, false, { pipelineName: 'Closed Projects', stageName: 'Project Complete' });
eq(Object.prototype.hasOwnProperty.call(stickyDone, 'Docs OK for Complete'), false, 'sticky: omit complete untick at Project Complete');

// bypass detection (log only — no revert)
const failResults = ctx.evaluateAllGates_({}, {});
eq(ctx.detectGateBypass_('Production', failResults, false).map(b => b.gateKey), ['production'], 'bypass when in Production without docs');
eq(ctx.detectGateBypass_('Closed Projects', failResults, false).map(b => b.gateKey).sort(), ['close', 'production'], 'bypass both gates in Closed');
eq(ctx.detectGateBypass_('Sales', failResults, false), [], 'no bypass while still in Sales');
eq(ctx.detectGateBypass_('Production', failResults, true), [], 'override suppresses bypass');
eq(ctx.detectGateBypass_('Production', ctx.evaluateAllGates_(salesReady, {}), false), [], 'no bypass when production gate passes');

// handoff stages, override users
eq(ctx.gateParkedAt_('Sales', 'Initial Down Payment Received').key, 'production', 'parked: production handoff');
eq(ctx.gateParkedAt_('Production', 'Initial Down Payment Received'), null, 'stage name alone in wrong pipeline is not a handoff');
eq(ctx.gateParkedAt_('Production', 'Customer Installation Support'), null, 'close gate is not stage-driven');
eq(ctx.gateParkedAt_('Production', 'Waiting on 2nd Payment', { 'Project Completed (Archive)': true }).key, 'close', 'parked: Production + archive ticked');
eq(ctx.gateParkedAt_('Production', 'Producing Product', { 'Project Completed (Archive)': false }), null, 'Production without archive tick not parked');
eq(ctx.gateParkedAt_('Closed Projects', 'Folder Review').key, 'complete', 'parked: Folder Review');
eq(ctx.gateParkedAt_('Closed Projects', 'All Payments Received', { 'Project Completed (Archive)': true }), null, 'already Closed is not parked at close');
eq(ctx.CONFIG.GATES.FIELD_IDS['Docs OK for Production'], 772791, 'Docs OK for Production field id');
eq([984268, 991740, 993457].map(ctx.overrideUserAllowed_), [true, true, true], 'Adam, Carin, Isabel may override');
eq(ctx.overrideUserAllowed_(1061440), false, 'others may not override');
eq(typeof ctx.grandfatherGateCheckboxes, 'undefined', 'grandfather helper removed');

// config wiring
eq(ctx.CONFIG.CF_DOCS_OK_PRODUCTION, 'Docs OK for Production', 'CF label production');
eq(ctx.CONFIG.GATES.ENABLE, true, 'gates enabled for observation');
eq(ctx.CONFIG.GATES.WARN_ONLY, true, 'warn-only default for rollout');

// gateDiffRows_: change-only gate logging
{
  const rows = [['fail', 'production', 'Production', 'X', 'missing: 05_QUOTE'], ['bypass', 'production', 'Production', 'X', 'd1']];
  const a = ctx.gateDiffRows_(null, rows);
  eq(a.changed.length, 2, 'first sight logs every row');
  const b = ctx.gateDiffRows_(a.state, rows);
  eq(b.changed.length, 0, 'same result+missing logs nothing');
  const c = ctx.gateDiffRows_(b.state, [['fail', 'production', 'Production', 'Y', 'missing: 05_QUOTE'], rows[1]]);
  eq(c.changed.length, 0, 'stage-only change is not logged');
  const d = ctx.gateDiffRows_(c.state, [['pass', 'production', 'Production', 'X', 'ok']]);
  eq(d.changed.map(r => r[0]), ['pass'], 'fail->pass logged');
  const e = ctx.gateDiffRows_(d.state, [['fail', 'production', 'Production', 'X', 'missing: 02_REQUIREMENTS']]);
  eq(e.changed.length, 1, 'missing list change logged');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
