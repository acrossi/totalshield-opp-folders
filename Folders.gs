/**
 * Folders.gs - Drive operations and the per-opportunity sync routine.
 */

function oppRoot_() { return DriveApp.getFolderById(CONFIG.OPPORTUNITIES_FOLDER_ID); }

/** Ensure the standard subfolders exist (nested "A/B" paths supported). Returns number created. */
function ensureSubfolders_(folder) {
  var created = 0;
  var listing = {};   // parent folder id -> {name: Folder}
  function children(parent) {
    var id = parent.getId();
    if (!listing[id]) {
      var m = {}, it = parent.getFolders();
      while (it.hasNext()) { var f = it.next(); if (!m[f.getName()]) m[f.getName()] = f; }
      listing[id] = m;
    }
    return listing[id];
  }
  CONFIG.SUBFOLDERS.forEach(function (path) {
    var parent = folder;
    path.split('/').filter(Boolean).forEach(function (name) {
      var kids = children(parent);
      if (!kids[name]) { kids[name] = parent.createFolder(name); created++; }
      parent = kids[name];
    });
  });
  return created;
}

/** Find the folder for an opportunity: by stored Root ID first, then by ID- suffix scan. */
function findOppFolder_(opp) {
  var rootId = copperFieldValue_(opp, CONFIG.CF_DRIVE_ROOT_ID);
  if (rootId) {
    try {
      var f = DriveApp.getFolderById(String(rootId).trim());
      if (!f.isTrashed()) return f;
    } catch (e) { /* stale id, fall through */ }
  }
  var idx = folderIndexByOppId_();
  var hit = idx[opp.id];
  return hit ? DriveApp.getFolderById(hit) : null;
}

/** {oppId: folderId} for every folder in any bucket that carries an ID- suffix. Cached 10 min. */
function folderIndexByOppId_() {
  var cache = CacheService.getScriptCache();
  var c = cache.get('folderIndex');
  if (c) return JSON.parse(c);
  var idx = {};
  Object.keys(CONFIG.BUCKETS).forEach(function (key) {
    var root = bucketFolder_(key);
    if (!root) return;
    var it = root.getFolders();
    while (it.hasNext()) {
      var f = it.next();
      var id = parseIdFromName_(f.getName());
      if (id && !idx[id]) idx[id] = f.getId();
    }
  });
  try { cache.put('folderIndex', JSON.stringify(idx), 600); } catch (e) {}
  return idx;
}

function wantSubfolders_(bucket) { return bucket !== 'LOST' || CONFIG.SUBFOLDERS_FOR_LOST; }

function invalidateFolderIndex_() { CacheService.getScriptCache().remove('folderIndex'); }

/** Gather everything needed to name a folder for this opportunity. */
function oppNamingInput_(opp, companyCache) {
  var company = null;
  if (opp.company_id) {
    companyCache = companyCache || {};
    if (!companyCache[opp.company_id]) {
      try { companyCache[opp.company_id] = copperGetCompany_(opp.company_id); } catch (e) { companyCache[opp.company_id] = null; }
    }
    company = companyCache[opp.company_id];
  }
  var productType = copperFieldValue_(opp, CONFIG.CF_PRODUCT_TYPE);
  if (!productType) {
    var multi = copperFieldValue_(opp, CONFIG.CF_PRODUCTS_MULTI);
    if (Array.isArray(multi) && multi.length) productType = multi[0];
  }
  return {
    id: opp.id,
    dateCreated: opp.date_created,
    companyName: company ? company.name : (opp.company_name || ''),
    oppName: opp.name,
    productType: productType
  };
}

/**
 * Bring one opportunity's folder into line with Copper.
 * Creates, renames, adds subfolders, writes back Root ID / Link. Idempotent.
 * @return {Object} summary {action, folderId, folderName, oldName}
 */
function syncOpportunity_(opp, opts) {
  opts = opts || {};
  var dryRun = !!opts.dryRun;
  var input = oppNamingInput_(opp, opts.companyCache);
  var bucket = bucketForOpp_(opp);
  var folder = findOppFolder_(opp);
  // Fallback: no product on the record, infer from the opportunity name (not for lost records)
  if (!input.productType && (bucket !== 'LOST' || CONFIG.PRODUCT_KEYWORDS_FOR_LOST)) {
    var inferred = inferProductFromText_(opp.name);
    if (inferred) input.productCodeOverride = inferred;
  }
  // Fallback: Copper has no resolvable company but the existing folder name carries one
  // (legacy "Company--OPP-..." or new "YYYYMMDD_CODE_Company_...")
  if (!input.companyName && folder) {
    var fromName = companyFromFolderName_(folder.getName());
    if (fromName) input.companyName = fromName;
  }
  var expected = buildFolderName_(input);
  var result = { oppId: opp.id, expected: expected, bucket: bucket, action: 'none', oldName: folder ? folder.getName() : '', oldBucket: folder ? currentBucketOf_(folder) : '' };

  if (!folder) {
    if (bucket === 'LOST' && !CONFIG.CREATE_FOLDERS_FOR_LOST) { result.action = 'skip (lost, no folder)'; return result; }
    result.action = 'create';
    if (dryRun) return result;
    var dest = (CONFIG.ENABLE_MOVES && bucketFolder_(bucket)) || oppRoot_();
    folder = dest.createFolder(expected);
    if (wantSubfolders_(bucket)) ensureSubfolders_(folder);
    invalidateFolderIndex_();
  } else {
    var actions = [];
    if (folder.getName() !== expected) {
      actions.push('rename');
      if (!dryRun) folder.setName(expected);
    }
    if (CONFIG.ENABLE_MOVES && result.oldBucket !== bucket) {
      actions.push('move');
      if (!dryRun && moveToBucket_(folder, bucket)) invalidateFolderIndex_();
    }
    if (!dryRun && wantSubfolders_(bucket)) {
      var added = ensureSubfolders_(folder);
      if (added && !actions.length) actions.push('subfolders');
    }
    if (actions.length) result.action = actions.join('+');
  }
  if (dryRun) return result;

  result.folderId = folder.getId();
  result.folderName = folder.getName();
  result.link = folder.getUrl();

  // Write back to Copper only when something differs
  var curRoot = copperFieldValue_(opp, CONFIG.CF_DRIVE_ROOT_ID);
  var curLink = copperFieldValue_(opp, CONFIG.CF_DRIVE_LINK);
  var curOppId = copperFieldValue_(opp, CONFIG.CF_OPP_ID);
  var updates = {};
  if (String(curRoot || '') !== result.folderId) updates[CONFIG.CF_DRIVE_ROOT_ID] = result.folderId;
  if (String(curLink || '') !== result.link) updates[CONFIG.CF_DRIVE_LINK] = result.link;
  if (String(curOppId || '') !== String(opp.id)) updates[CONFIG.CF_OPP_ID] = String(opp.id);
  if (Object.keys(updates).length) {
    copperUpdateOpportunity_(opp.id, { custom_fields: copperCustomFields_(updates) });
    result.copperUpdated = true;
  }
  logRow_('sync', [opp.id, result.action, result.oldName, result.folderName, result.oldBucket + '>' + bucket, result.link, input.companyName]);
  return result;
}

/** Rename all opportunity folders belonging to a company (after a Company record edit). */
function syncCompany_(companyId) {
  var opps = copperSearchOpportunities_({ company_ids: [companyId] });
  var cache = {};
  opps.forEach(function (o) { try { syncOpportunity_(o, { companyCache: cache }); } catch (e) { logRow_('error', [o.id, 'syncCompany', String(e)]); } });
  return opps.length;
}
