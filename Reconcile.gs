/**
 * Reconcile.gs - full Copper <-> Drive reconciliation.
 *
 *   reconcileDryRun()   -> writes a "Reconcile Plan" sheet: every proposed create/rename, plus orphan folders. Changes nothing.
 *   reconcileExecute()  -> applies the plan (creates, renames, subfolders, Copper write-back). Resumable across the 6-minute limit.
 *   reconcileNightly()  -> same as execute, meant for a daily time trigger.
 *
 * Orphans (Drive folders with no matching Copper opportunity) are only ever LISTED, never moved or deleted.
 */

function reconcileDryRun() { reconcile_({ dryRun: true }); }
function reconcileExecute() { reconcile_({ dryRun: false }); }
function reconcileNightly() { reconcile_({ dryRun: false, quiet: true }); }

/** Lost/Abandoned records only: safe first migration pass (rename + move to LOST, no subfolders). */
function reconcileLostDryRun() { reconcile_({ dryRun: true, onlyBucket: 'LOST', label: 'Lost' }); }
function reconcileLostExecute() { reconcile_({ dryRun: false, onlyBucket: 'LOST', label: 'Lost' }); }

function reconcileFn_(opts) {
  var dryRun = !!opts.dryRun;
  return opts.onlyBucket === 'LOST' ? (dryRun ? 'reconcileLostDryRun' : 'reconcileLostExecute')
       : (dryRun ? 'reconcileDryRun' : (opts.quiet ? 'reconcileNightly' : 'reconcileExecute'));
}

function scheduleContinuation_(fn, seconds) {
  return ScriptApp.newTrigger(fn).timeBased().after(seconds * 1000).create().getUniqueId();
}

function deleteTriggerById_(id) {
  if (!id) return;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getUniqueId() === id) { try { ScriptApp.deleteTrigger(t); } catch (e) {} }
  });
}

/**
 * Chunk driver. Holds the script lock so the 5-minute poll and a reconcile never touch Drive at the same time.
 * Each chunk arms a "watchdog" continuation before doing any work, so a platform error that kills the chunk
 * (no catch block runs) still resumes about two minutes after the budget would have expired.
 */
function reconcile_(opts) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    scheduleContinuation_(reconcileFn_(opts), 60);
    Logger.log('Reconcile: lock busy, retry scheduled.');
    return;
  }
  try { reconcileChunk_(opts); } finally { lock.releaseLock(); }
}

function reconcileChunk_(opts) {
  var dryRun = !!opts.dryRun;
  var props = PropertiesService.getScriptProperties();
  var started = Date.now();
  var BUDGET_MS = 5 * 60 * 1000;
  var fn = reconcileFn_(opts);

  // Resume support: the full opportunity list is fetched once and cached; progress index kept in properties.
  var stateKey = (dryRun ? 'RECON_DRY_STATE' : 'RECON_EXEC_STATE') + (opts.onlyBucket || '');
  var state = JSON.parse(props.getProperty(stateKey) || 'null');
  if (!state || !state.oppIds) {
    var all = copperSearchOpportunities_({});
    if (opts.onlyBucket) all = all.filter(function (o) { return bucketForOpp_(o) === opts.onlyBucket; });
    state = { oppIds: all.map(function (o) { return o.id; }), next: 0, watchdog: null };
    // Keep the records in cache so the first pass doesn't refetch each one
    reconcileCache_().set(all);
  }
  // Arm the watchdog for this chunk (replacing any earlier one)
  deleteTriggerById_(state.watchdog);
  state.watchdog = scheduleContinuation_(fn, Math.round(BUDGET_MS / 1000) + 120);
  props.setProperty(stateKey, JSON.stringify(state));

  var plan = planSheet_((opts.label ? opts.label + ' ' : '') + (dryRun ? 'Reconcile Plan' : 'Reconcile Applied'));
  if (state.next === 0 && !opts.quiet) {
    plan.clearContents();
    plan.appendRow(['timestamp', 'opp_id', 'action', 'current_name', 'expected_name', 'current_bucket', 'expected_bucket', 'company', 'status', 'note']);
  }

  var companyCache = {};
  var rows = [];
  while (state.next < state.oppIds.length && (Date.now() - started) < BUDGET_MS) {
    var id = state.oppIds[state.next];
    try {
      var opp = reconcileCache_().get(id) || copperGetOpportunity_(id);
      var r = syncOpportunity_(opp, { dryRun: dryRun, companyCache: companyCache });
      if (r.action !== 'none' || !opts.quiet) {
        rows.push([new Date(), id, r.action, r.oldName, r.expected, r.oldBucket || '', r.bucket, oppNamingInput_(opp, companyCache).companyName, dryRun ? 'planned' : 'done', '']);
      }
    } catch (e) {
      rows.push([new Date(), id, 'error', '', '', '', '', '', 'error', String(e).slice(0, 300)]);
    }
    state.next++;
    if (rows.length >= 25) { appendRows_(plan, rows); rows = []; props.setProperty(stateKey, JSON.stringify(state)); }
  }
  if (rows.length) appendRows_(plan, rows);

  if (state.next < state.oppIds.length) {
    // Normal pause: disarm the watchdog and continue in 1 minute
    deleteTriggerById_(state.watchdog);
    state.watchdog = scheduleContinuation_(fn, 60);
    props.setProperty(stateKey, JSON.stringify(state));
    Logger.log('Reconcile paused at ' + state.next + '/' + state.oppIds.length + '; continuation scheduled.');
    return;
  }

  // Finished: list orphans (full runs only), clean up state and one-off continuation triggers
  if (!opts.onlyBucket) listOrphans_(plan, state.oppIds);
  deleteTriggerById_(state.watchdog);
  props.deleteProperty(stateKey);
  reconcileCache_().clear();
  invalidateFolderIndex_();
  cleanupContinuationTriggers_();
  Logger.log('Reconcile complete: ' + state.oppIds.length + ' opportunities.');
}

function listOrphans_(plan, oppIds) {
  var known = {};
  oppIds.forEach(function (id) { known[id] = true; });
  var rows = [];
  Object.keys(CONFIG.BUCKETS).forEach(function (key) {
    var root = bucketFolder_(key);
    if (!root) return;
    var it = root.getFolders();
    while (it.hasNext()) {
      var f = it.next();
      var id = parseIdFromName_(f.getName());
      if (!id || !known[id]) {
        rows.push([new Date(), id || '', 'orphan', f.getName(), '', key, '', '', 'review', id ? 'ID not found in Copper' : 'No Copper ID in name']);
      }
    }
  });
  if (rows.length) appendRows_(plan, rows);
}

function planSheet_(name) {
  var ss = logSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.setFrozenRows(1); }
  return sh;
}

function appendRows_(sh, rows) {
  if (!rows.length) return;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** Delete stray one-off reconcile continuation triggers. The recurring nightly trigger (id kept in NIGHTLY_TRIGGER_ID) is left alone. */
function cleanupContinuationTriggers_() {
  var keep = PropertiesService.getScriptProperties().getProperty('NIGHTLY_TRIGGER_ID');
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (/^reconcile/.test(t.getHandlerFunction()) && t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK && t.getUniqueId() !== keep) {
      try { ScriptApp.deleteTrigger(t); } catch (e) {}
    }
  });
}

/** Chunked cache of opportunity records keyed by id (CacheService values are capped at 100KB). */
function reconcileCache_() {
  var cache = CacheService.getScriptCache();
  return {
    set: function (opps) {
      var m = {};
      opps.forEach(function (o) { m['opp_' + o.id] = JSON.stringify(o); });
      var keys = Object.keys(m);
      for (var i = 0; i < keys.length; i += 100) {
        var chunk = {};
        keys.slice(i, i + 100).forEach(function (k) { chunk[k] = m[k]; });
        try { cache.putAll(chunk, 21600); } catch (e) {}
      }
    },
    get: function (id) { var v = cache.get('opp_' + id); return v ? JSON.parse(v) : null; },
    clear: function () { /* entries expire on their own */ }
  };
}

/**
 * Move orphan folders (ID- suffix not found in Copper, or no ID at all) out of the lifecycle buckets into
 * CRM > ARCHIVE > ORPHANED. Nothing is deleted or renamed. Pass {dryRun: true} to only list them.
 * Logged to the "Orphans Archived" tab.
 */
function archiveOrphans(opts) {
  opts = opts || {};
  var dryRun = !!opts.dryRun;
  var known = {};
  copperSearchOpportunities_({}).forEach(function (o) { known[o.id] = true; });
  var sd = DriveApp.getFolderById(CONFIG.CRM_SHARED_DRIVE_ID);
  var archive = childFolderByName_(sd, 'ARCHIVE') || (dryRun ? null : sd.createFolder('ARCHIVE'));
  var dest = archive ? (childFolderByName_(archive, 'ORPHANED') || (dryRun ? null : archive.createFolder('ORPHANED'))) : null;
  var sheet = planSheet_('Orphans Archived');
  if (sheet.getLastRow() === 0) sheet.appendRow(['timestamp', 'opp_id', 'folder_name', 'from_bucket', 'folder_id', 'status', 'note']);
  var rows = [], moved = 0;
  Object.keys(CONFIG.BUCKETS).forEach(function (key) {
    var root = bucketFolder_(key);
    if (!root) return;
    var it = root.getFolders();
    while (it.hasNext()) {
      var f = it.next();
      var id = parseIdFromName_(f.getName());
      if (id && known[id]) continue;
      var note = id ? 'ID not found in Copper' : 'No Copper ID in name';
      try {
        if (!dryRun) { f.moveTo(dest); moved++; }
        rows.push([new Date(), id || '', f.getName(), key, f.getId(), dryRun ? 'planned' : 'moved', note]);
      } catch (e) {
        rows.push([new Date(), id || '', f.getName(), key, f.getId(), 'error', String(e).slice(0, 300)]);
      }
    }
  });
  appendRows_(sheet, rows);
  invalidateFolderIndex_();
  Logger.log((dryRun ? 'Would move ' : 'Moved ') + (dryRun ? rows.length : moved) + ' orphan folders to ARCHIVE/ORPHANED');
  return rows;
}
function archiveOrphansDryRun() { return archiveOrphans({ dryRun: true }); }

function childFolderByName_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

/** Utility: abandon a paused reconcile and start over next time. */
function resetReconcileState() {
  var p = PropertiesService.getScriptProperties();
  ['RECON_DRY_STATE', 'RECON_EXEC_STATE', 'RECON_DRY_STATELOST', 'RECON_EXEC_STATELOST'].forEach(function (k) { p.deleteProperty(k); });
  cleanupContinuationTriggers_();
}
