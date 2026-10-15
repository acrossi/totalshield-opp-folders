/** Explicit on-demand scoring entry point for the authenticated File Bot. */
function fileBotScore(oid) {
  if (typeof oid !== 'string' || !/^[1-9]\d{4,14}$/.test(oid)) {
    throw new Error('A valid opportunity ID is required.');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1)) return {ok: false, oid: oid, reason: 'busy'};
  try {
    var opp = copperGetOpportunity_(Number(oid));
    if (!opp || String(opp.id) !== oid) throw new Error('Opportunity ID mismatch.');
    var result = scoreAndReport(opp, {fileBot: true});
    if (!result || !result.reportId) throw new Error('No report was generated.');
    return {ok: true, oid: oid, score: result.score,
      reportId: result.reportId, docUrl: result.docUrl,
      generatedAt: new Date().toISOString()};
  } finally {
    lock.releaseLock();
  }
}

/** Fail closed before scoring writes if Copper points outside the CRM project. */
function fileBotValidateFolder_(folder, oid) {
  if (folder.isTrashed() || !new RegExp('ID-' + oid + '$').test(folder.getName())) {
    throw new Error('Project folder does not match the requested opportunity.');
  }
  var current = folder;
  var seen = {};
  for (var depth = 0; depth < 100; depth++) {
    var id = current.getId();
    if (id === CONFIG.CRM_SHARED_DRIVE_ID) return;
    if (seen[id]) break;
    seen[id] = true;
    var parents = current.getParents();
    if (!parents.hasNext()) break;
    current = parents.next();
  }
  throw new Error('Project folder is outside the CRM shared drive.');
}
