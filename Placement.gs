/**
 * Placement.gs - which top-level bucket a folder belongs in, derived from the Copper record.
 *
 * Rule (first match wins):
 *   1. status Lost or Abandoned        -> LOST
 *   2. pipeline Closed Projects        -> CLOSED_PROJECTS
 *   3. pipeline Production             -> PRODUCTION
 *   4. otherwise                       -> OPPORTUNITIES
 */

/** Pure: (status, pipelineName) -> bucket key. */
function expectedBucket_(status, pipelineName) {
  if (CONFIG.LOST_STATUSES.indexOf(status) !== -1) return 'LOST';
  if (pipelineName === CONFIG.PIPELINE_CLOSED) return 'CLOSED_PROJECTS';
  if (pipelineName === CONFIG.PIPELINE_PRODUCTION) return 'PRODUCTION';
  return 'OPPORTUNITIES';
}

/** Bucket key for a Copper opportunity record. */
function bucketForOpp_(opp) {
  var p = copperPipelines_().byId[opp.pipeline_id];
  return expectedBucket_(opp.status, p ? p.name : '');
}

/** Bucket key -> Drive folder, or null if that bucket has no ID configured. */
function bucketFolder_(key) {
  var id = CONFIG.BUCKETS[key];
  return id ? DriveApp.getFolderById(id) : null;
}

/** Bucket key whose folder ID matches, else null. */
function bucketKeyForFolderId_(folderId) {
  var keys = Object.keys(CONFIG.BUCKETS);
  for (var i = 0; i < keys.length; i++) if (CONFIG.BUCKETS[keys[i]] === folderId) return keys[i];
  return null;
}

/** Which bucket (if any) a folder currently sits in, by inspecting its parent. */
function currentBucketOf_(folder) {
  var parents = folder.getParents();
  while (parents.hasNext()) {
    var k = bucketKeyForFolderId_(parents.next().getId());
    if (k) return k;
  }
  return null;
}

/** Move folder into bucket. Returns true if moved. Shared-drive moves keep the folder ID. */
function moveToBucket_(folder, key) {
  var dest = bucketFolder_(key);
  if (!dest) { Logger.log('Bucket ' + key + ' has no folder ID configured; not moving'); return false; }
  if (currentBucketOf_(folder) === key) return false;
  folder.moveTo(dest);
  return true;
}

/** Stage name for an opportunity, or ''. */
function stageNameOf_(opp) {
  var p = copperPipelines_().byId[opp.pipeline_id];
  if (!p || !p.stages) return '';
  for (var i = 0; i < p.stages.length; i++) if (p.stages[i].id === opp.pipeline_stage_id) return p.stages[i].name;
  return '';
}

/** True when the record is in a state that should carry a documentation score. */
function shouldScore_(opp) {
  return bucketForOpp_(opp) === 'CLOSED_PROJECTS' || !!copperFieldValue_(opp, CONFIG.CF_PROJECT_COMPLETED);
}

/** True when the score should be recomputed even if one already exists (final states). */
function isFinalState_(opp) {
  return stageNameOf_(opp) === CONFIG.STAGE_PROJECT_COMPLETE || !!copperFieldValue_(opp, CONFIG.CF_PROJECT_COMPLETED);
}

/**
 * Score policy: score on entry to Closed Projects (no score yet), recompute in a final state.
 * Returns the result or null if nothing was done.
 */
function maybeScore_(opp) {
  if (!shouldScore_(opp)) return null;
  if (hasScore_(opp) && !isFinalState_(opp)) return null;
  return scoreOpportunity_(opp);
}
