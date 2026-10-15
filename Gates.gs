/**
 * Gates.gs - documentation stage gates (checkbox write-back for Copper handoff workflows).
 *
 * Copper cannot refuse a stage change. Existing handoff workflows move deals between pipelines;
 * each workflow gains a condition on a Docs OK checkbox. This script is the only writer of those
 * checkboxes: it inventories the Drive folder, evaluates CONFIG.GATES, and ticks/unticks the boxes.
 * Deals that fail a gate simply stay at the handoff stage — nothing is moved backward.
 *
 * Enable with CONFIG.GATES.ENABLE. Boxes are written in WARN_ONLY too (harmless until the workflows carry
 * the condition); WARN_ONLY only tags log rows. A Copper field-updated workflow fires on the API checkbox
 * write itself (tested 15 Oct, ~16 s), so no extra re-save is needed.
 * See /workspace/gates/PLAN.md (or the vault mirror) for the rollout steps Adam runs in Copper.
 */

/**
 * True when a scored subfolder has full credit under CONFIG.SCORING
 * (minFiles met and every needTypes group satisfied). Bonus folders count when present.
 */
function folderCredited_(inventory, name) {
  var r = CONFIG.SCORING[name];
  if (!r) return false;
  var inv = inventory[name];
  var count = typeof inv === 'number' ? inv : (inv ? inv.count : 0);
  var types = (inv && inv.types) || [];
  var missing = (r.needTypes || []).filter(function (group) {
    return !group.some(function (t) { return types.indexOf(t) !== -1; });
  });
  if (missing.length) return false;
  return count >= (r.minFiles || 1);
}

/**
 * Resolve the folder list for one gate, including optional stage-based extras.
 * context = { stageName: string }
 */
function gateRequiredFolders_(gate, context) {
  var required = (gate.requiredFolders || []).slice();
  if (context && context.installed) {
    (gate.requiredWhenInstalled || []).forEach(function (f) { if (required.indexOf(f) === -1) required.push(f); });
  }
  return required;
}

/** Pure: installed job = install checkbox ticked, or ever seen at an INSTALL_STAGES stage. */
function isInstalledJob_(installedField, stageName, seenAtInstallStage) {
  return !!installedField || !!seenAtInstallStage || (CONFIG.GATES.INSTALL_STAGES || []).indexOf(stageName) !== -1;
}

/** Pure: recommended-but-not-required folders still missing (shown in nudges, never blocks). */
function gateRecommendedMissing_(gate, inventory) {
  return (gate.recommendedFolders || []).filter(function (f) { return !folderCredited_(inventory, f); });
}

/**
 * Pure: the gate a deal is parked at, or null. Stage-driven gates match pipeline + stage; the Close gate
 * matches pipeline Production + its handoffField checkbox (Project Completed (Archive)) ticked.
 */
function gateParkedAt_(pipelineName, stageName, fieldValues) {
  fieldValues = fieldValues || {};
  return (CONFIG.GATES.GATES || []).filter(function (g) {
    if (g.handoffPipeline && g.handoffPipeline !== pipelineName) return false;
    if (g.handoffField) return !!fieldValues[g.handoffField];
    return !!g.handoffStage && g.handoffStage === stageName;
  })[0] || null;
}

/** Pure: is this Copper user allowed to set Gate Override? */
function overrideUserAllowed_(userId) {
  return Object.prototype.hasOwnProperty.call(CONFIG.GATES.OVERRIDE_ALLOWED_USERS || {}, String(userId));
}

/**
 * Evaluate one gate definition against an inventory.
 * Returns { key, label, passed, missing[], required[], score }.
 * gate.requireScore100 uses computeScore_ (install bonus capped at 100).
 */
function evaluateGate_(gate, inventory, context) {
  var required = gateRequiredFolders_(gate, context);
  var missing = [];
  required.forEach(function (f) {
    if (!folderCredited_(inventory, f)) missing.push(f);
  });
  var score = null;
  if (gate.requireScore100) {
    score = computeScore_(inventory, (context && context.looseFiles) || 0).score;
    if (score < 100) {
      Object.keys(CONFIG.SCORING).forEach(function (n) {
        if (CONFIG.SCORING[n].bonus) return;
        if (!folderCredited_(inventory, n) && missing.indexOf(n) === -1) missing.push(n);
      });
    }
  }
  return {
    key: gate.key,
    label: gate.label || gate.key,
    passed: missing.length === 0 && (!gate.requireScore100 || score === 100),
    missing: missing,
    required: required,
    score: score
  };
}

/** Evaluate every gate in CONFIG.GATES.GATES. */
function evaluateAllGates_(inventory, context) {
  return (CONFIG.GATES.GATES || []).map(function (g) {
    return evaluateGate_(g, inventory, context);
  });
}

/**
 * Build { checkboxFieldLabel: boolean } for Copper write-back.
 * Override forces every Docs OK box true. Without override, each gate's field follows passed.
 *
 * Sticky past-pipeline rule: once a deal is already in Production / Closed Projects / Project
 * Complete, a failing re-evaluation will NOT clear that gate's checkbox (omitted from the map).
 * A deal that legitimately passed a gate is never un-ticked later if files are moved or renamed.
 * Deals still before the handoff are written true/false every time so a premature tick is corrected.
 * context = { pipelineName, stageName } (optional).
 */
function gateCheckboxMap_(gateResults, override, context) {
  context = context || {};
  var pipelineName = context.pipelineName || '';
  var stageName = context.stageName || '';
  var pastProduction = pipelineName === CONFIG.PIPELINE_PRODUCTION || pipelineName === CONFIG.PIPELINE_CLOSED;
  var pastClose = pipelineName === CONFIG.PIPELINE_CLOSED;
  var pastComplete = stageName === CONFIG.STAGE_PROJECT_COMPLETE;
  var map = {};
  (gateResults || []).forEach(function (r) {
    var gate = (CONFIG.GATES.GATES || []).filter(function (g) { return g.key === r.key; })[0];
    if (!gate || !gate.checkboxField) return;
    var value = !!(override || r.passed);
    if (!override && !value) {
      if (r.key === 'production' && pastProduction) return;
      if (r.key === 'close' && pastClose) return;
      if (r.key === 'complete' && pastComplete) return;
    }
    map[gate.checkboxField] = value;
  });
  return map;
}

/**
 * Detect a manual pipeline-dropdown skip: already in a later pipeline while the gate that
 * should have controlled entry is failed and Override is off.
 * Returns [{ gateKey, pipelineName, detail }] (empty if none).
 */
function detectGateBypass_(pipelineName, gateResults, override) {
  if (override) return [];
  var out = [];
  var byKey = {};
  (gateResults || []).forEach(function (r) { byKey[r.key] = r; });

  if (pipelineName === CONFIG.PIPELINE_PRODUCTION || pipelineName === CONFIG.PIPELINE_CLOSED) {
    var prod = byKey.production;
    if (prod && !prod.passed) {
      out.push({
        gateKey: 'production',
        pipelineName: pipelineName,
        detail: 'In ' + pipelineName + ' but Docs OK for Production would fail; missing ' + prod.missing.join(', ')
      });
    }
  }
  if (pipelineName === CONFIG.PIPELINE_CLOSED) {
    var close = byKey.close;
    if (close && !close.passed) {
      out.push({
        gateKey: 'close',
        pipelineName: pipelineName,
        detail: 'In Closed Projects but Docs OK for Close would fail; missing ' + close.missing.join(', ')
      });
    }
  }
  return out;
}

/** Pipeline name for an opportunity, or ''. */
function pipelineNameOf_(opp) {
  var p = copperPipelines_().byId[opp.pipeline_id];
  return p ? p.name : '';
}

/** Installed flag for one opp; remembers sightings at INSTALL_STAGES in Script Properties. */
function installedForOpp_(opp, stageName) {
  var props = PropertiesService.getScriptProperties();
  var key = 'installSeen_' + opp.id;
  if ((CONFIG.GATES.INSTALL_STAGES || []).indexOf(stageName) !== -1) props.setProperty(key, '1');
  var field = false;
  try { field = !!copperFieldValue_(opp, CONFIG.GATES.CF_INSTALLED); } catch (e) {}
  return isInstalledJob_(field, stageName, props.getProperty(key) === '1');
}

/**
 * Inventory + evaluate + optional Copper write-back for one opportunity.
 * Returns null if gates are disabled or there is no inventory.
 */
function applyDocumentationGates_(opp, inventory, looseFiles) {
  if (!CONFIG.GATES || !CONFIG.GATES.ENABLE) return null;
  if (!inventory) return null;

  var stageName = stageNameOf_(opp);
  var pipelineName = pipelineNameOf_(opp);
  var override = false;
  try { override = !!copperFieldValue_(opp, CONFIG.CF_GATE_OVERRIDE); } catch (e) {}
  if (override) {
    // Copper's API cannot say who ticked the field. Honor it, but log enough for an audit.
    var owner = oppOwner_(opp);
    logRow_('gate', [opp.id, 'override_unverified', '-', pipelineName, stageName,
      'Gate Override ticked; allowed setters: ' + Object.keys(CONFIG.GATES.OVERRIDE_ALLOWED_USERS).map(function (k) { return CONFIG.GATES.OVERRIDE_ALLOWED_USERS[k]; }).join(', ') +
      '; assignee ' + owner.name + '; record modified ' + new Date((opp.date_modified || 0) * 1000).toISOString()]);
  }

  var installed = installedForOpp_(opp, stageName);
  var context = { stageName: stageName, looseFiles: looseFiles || 0, installed: installed };
  var results = evaluateAllGates_(inventory, context);
  detectGateBypass_(pipelineName, results, override).forEach(function (b) {
    logRow_('gate', [opp.id, 'bypass', b.gateKey, pipelineName, stageName, b.detail]);
  });
  results.forEach(function (r) {
    logRow_('gate', [opp.id, r.passed ? 'pass' : 'fail', r.key, pipelineName, stageName,
      r.missing.length ? ('missing: ' + r.missing.join(', ')) : (r.score != null ? ('score ' + r.score) : 'ok')]);
  });
  var handoffFields = {};
  (CONFIG.GATES.GATES || []).forEach(function (g) {
    if (g.handoffField) { try { handoffFields[g.handoffField] = !!copperFieldValue_(opp, g.handoffField); } catch (e) {} }
  });
  var parked = parkedEntry_(opp, pipelineName, stageName, handoffFields, results, inventory, override);
  if (parked) logRow_('gate', [opp.id, CONFIG.GATES.WARN_ONLY ? 'parked_warn' : 'parked', parked.gate, pipelineName, stageName, 'missing: ' + parked.missing]);

  var map = gateCheckboxMap_(results, override, { pipelineName: pipelineName, stageName: stageName });
  try {
    var fields = copperCustomFields_(map);
    if (fields.length) copperUpdateOpportunity_(opp.id, { custom_fields: fields });   // field-updated workflows fire on this write
  } catch (err) {
    logRow_('error', [opp.id, 'gate write-back', String(err)]);
    return { results: results, wrote: false, override: override, installed: installed, parked: parked, error: String(err) };
  }
  return { results: results, wrote: true, override: override, installed: installed, parked: parked, checkboxes: map };
}

/** Parked row (deal at a handoff failing that gate), or null. Shape matches the Parked tab. */
function parkedEntry_(opp, pipelineName, stageName, handoffFields, results, inventory, override) {
  var gate = gateParkedAt_(pipelineName, stageName, handoffFields);
  if (!gate || override) return null;
  var r = results.filter(function (x) { return x.key === gate.key; })[0];
  if (!r || r.passed) return null;
  var owner = oppOwner_(opp), folder = null;
  try { folder = findOppFolder_(opp); } catch (e) {}
  return { oppId: opp.id, name: opp.name, owner: owner.name, ownerEmail: owner.email, gate: gate.label,
           stage: gate.handoffField ? stageName + ' (' + gate.handoffField + ' ticked)' : stageName, missing: r.missing.join(', '),
           recommended: gateRecommendedMissing_(gate, inventory).join(', '),
           folderUrl: folder ? folder.getUrl() : '', copperUrl: copperOppUrl_(opp.id) };
}

/** Poll / webhook entry: find folder, inventory, apply gates. */
function maybeApplyDocumentationGates_(opp) {
  if (!CONFIG.GATES || !CONFIG.GATES.ENABLE) return null;
  var folder = findOppFolder_(opp);
  if (!folder) return null;
  var inv = inventoryFolder_(folder);
  return applyDocumentationGates_(opp, inv.inventory, inv.loose);
}

/**
 * Sweep every deal sitting at a handoff stage (the 5-minute poll only sees recently modified records,
 * and a parked deal may not change). Re-evaluates gates, so a newly filed folder ticks the box,
 * and rewrites the 'Parked' tab that Hanibal reads for Slack nudges (#crm-bot + owner DM).
 * Run from the poll at most every PARKED_SWEEP_MINUTES (15 min).
 */
var PARKED_HEADERS_ = ['opp_id', 'opportunity', 'owner', 'owner_email', 'gate', 'stage', 'missing_required', 'missing_recommended', 'folder', 'copper', 'first_parked', 'last_checked'];

function sweepParkedDeals() {
  if (!CONFIG.GATES || !CONFIG.GATES.ENABLE) return null;
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('parkedSweepAt') || 0);
  if (Date.now() - last < 15 * 60000) return null;
  props.setProperty('parkedSweepAt', String(Date.now()));

  // Candidates: deals at a stage-driven handoff stage, plus every Production deal (filtered by the field gate).
  var pipes = copperPipelines_(), stageIds = [], pipelineIds = [];
  (CONFIG.GATES.GATES || []).forEach(function (g) {
    var p = pipes.byName[g.handoffPipeline];
    if (!p) return;
    if (g.handoffField) { pipelineIds.push(p.id); return; }
    (p.stages || []).forEach(function (st) { if (st.name === g.handoffStage) stageIds.push(st.id); });
  });
  var cands = [];
  if (stageIds.length) cands = cands.concat(copperSearchOpportunities_({ pipeline_stage_ids: stageIds }, 10));
  if (pipelineIds.length) cands = cands.concat(copperSearchOpportunities_({ pipeline_ids: pipelineIds }, 10));
  var seen = {};
  cands = cands.filter(function (o) { if (seen[o.id]) return false; seen[o.id] = true; return true; });

  var sh = logSheet_(CONFIG.GATES.PARKED_SHEET, PARKED_HEADERS_);
  var prev = {};
  sh.getDataRange().getValues().slice(1).forEach(function (row) { prev[row[1]] = row[11]; });   // opp_id -> first_parked

  var rows = [];
  cands.forEach(function (o) {
    if (CONFIG.LOST_STATUSES.indexOf(o.status) !== -1) return;   // Production deals are usually status Won
    try {
      var res = maybeApplyDocumentationGates_(o);
      var p = res && res.parked;
      if (!p) return;
      rows.push([new Date(), p.oppId, p.name, p.owner, p.ownerEmail, p.gate, p.stage, p.missing, p.recommended,
                 p.folderUrl, p.copperUrl, prev[p.oppId] || new Date(), new Date()]);
    } catch (e) { logRow_('error', [o.id, 'parked sweep', String(e)]); }
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  logRow_('poll', ['parked', rows.length]);
  return rows.length;
}
