// Node harness for the pure functions in Naming.gs and Scoring.gs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
  Utilities: { formatDate: (d, tz, fmt) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = t => p.find(x => x.type === t).value; return g('year') + g('month') + g('day'); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperties: () => {} }) },
  console
};
vm.createContext(ctx);
for (const f of ['Config.gs', 'Naming.gs', 'Scoring.gs', 'Placement.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);

let fails = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : `\n   got: ${JSON.stringify(actual)}\n   exp: ${JSON.stringify(expected)}`));
  if (!ok) fails++;
}

// 2025-08-25 12:31 EDT = 1756139460
eq(ctx.buildFolderName_({ id: 38973969, dateCreated: 1756139460, companyName: 'Bay Advanced Technologies', oppName: 'Bay Advanced Technologies - Benchtop Enclosure', productType: 'Benchtop Enclosure' }),
  '20250825_BENCHTOP_Bay Advanced Technologies_Benchtop Enclosure_ID-38973969', 'standard name');

eq(ctx.buildFolderName_({ id: 1, dateCreated: 1756139460, companyName: 'Acme Cryogenics, Inc.', oppName: 'Acme Cryogenics - Mobile Barrier', productType: 'Mobile Shield Barrier' }),
  '20250825_MBARRIER_Acme Cryogenics_Mobile Barrier_ID-1', 'suffix stripped and company de-duplicated');

eq(ctx.buildFolderName_({ id: 2, dateCreated: 1756139460, companyName: '', oppName: 'Brahma', productType: null }),
  '20250825_OTHER_UNKNOWN COMPANY_Brahma_ID-2', 'no company, no product');

eq(ctx.buildFolderName_({ id: 3, dateCreated: 1756139460, companyName: 'Jergo AS', oppName: 'Jergo AS', productType: 'Shielding Room' }),
  '20250825_SHLDROOM_Jergo_ID-3', 'opp name equal to company is dropped');

eq(ctx.buildFolderName_({ id: 4, dateCreated: 1756139460, companyName: 'H.B. Fuller', oppName: 'H.B. Fuller - Benchtop / Enclosure: v2', productType: 'Benchtop Enclosure' }),
  '20250825_BENCHTOP_H.B. Fuller_Benchtop Enclosure v2_ID-4', 'illegal chars cleaned, colon inside name kept as split');

eq(ctx.companyKey_('Constellium Corp.'), ctx.companyKey_('CONSTELLIUM'), 'company key ignores suffix/case');
eq(ctx.parseIdFromName_('--OPP-Knife River Corp--ID-38880792'), 38880792, 'parse legacy id');
eq(ctx.parseIdFromName_('20250825_BENCHTOP_X_Y_ID-50001'), 50001, 'parse new id');
eq(ctx.parseIdFromName_('--Temp Folder Anduril'), null, 'no id');
eq(ctx.isNewFormat_('20250825_BENCHTOP_Bay Advanced Technologies_Benchtop Enclosure_ID-38973969'), true, 'new format detect');
eq(ctx.isNewFormat_('--OPP-Knife River Corp--ID-38880792'), false, 'legacy not new format');

// length cap
const long = ctx.buildFolderName_({ id: 99, dateCreated: 1756139460, companyName: 'A'.repeat(120), oppName: 'B'.repeat(120), productType: 'Machine Guard' });
eq(long.length <= ctx.CONFIG.MAX_NAME_LENGTH && /_ID-99$/.test(long), true, 'length capped, id preserved');

// scoring (rubric refined 28 Aug 2026: per-folder file-type requirements, install bonus, no loose penalty)
const T = (...types) => ({ count: 3, types });
const full = {
  '00_CUSTOMER_DOCS': T('pdf'), '01_CLIENT_INTAKE': T('gdoc'), '02_REQUIREMENTS': T('word'),
  '03_ANALYSIS': T('excel'), '04_MODEL': T('solidworks', 'pdf'), '05_QUOTE': T('gsheet'),
  '06_PURCHASE_ORDER': T('pdf'), '08_DELIVERABLES': T('pdf'), '10_FINANCIALS': T()
};
eq(ctx.computeScore_(full, 0).score, 100, 'all nine required folders satisfied scores 100');
eq(ctx.computeScore_({}, 5).score, 0, 'empty scores 0, loose files ignored');
eq(ctx.computeScore_({ ...full, '09_INSTALLATION': T() }, 0).score, 100, 'install bonus capped at 100');
const swOnly = { ...full, '04_MODEL': T('solidworks') };
eq(ctx.computeScore_(swOnly, 0).score, 89, 'model without PDF drawing loses its credit (AND rule)');
const pdfOnly = { ...full, '04_MODEL': T('pdf') };
eq(ctx.computeScore_(pdfOnly, 0).score, 89, 'model without SolidWorks loses its credit');
const quoteExcel = { ...full, '05_QUOTE': T('excel') };
eq(ctx.computeScore_(quoteExcel, 0).score, 100, 'excel quote satisfies sheet-or-excel');
const analysisSheet = { ...full, '03_ANALYSIS': T('gsheet') };
eq(ctx.computeScore_(analysisSheet, 0).score, 100, 'analysis spreadsheet satisfies doc-or-spreadsheet');
const analysisCad = { ...full, '03_ANALYSIS': T('solidworks') };
eq(ctx.computeScore_(analysisCad, 0).score, 89, 'analysis with only CAD earns nothing');
eq(ctx.computeScore_({ '10_FINANCIALS': 2 }, 0).score, 11, 'financials has no type requirement; legacy numeric ok');
eq(ctx.computeScore_({ '00_CUSTOMER_DOCS': 2 }, 0).score, 0, 'legacy numeric fails a typed folder');
const b = ctx.computeScore_(swOnly, 0).breakdown.find(x => x.startsWith('04_MODEL'));
eq(b, '04_MODEL:3=0 (no pdf)', 'breakdown names the missing requirement');

// file type matchers
eq(ctx.fileMatchesType_('solidworks', 'frame.SLDASM', ''), true, 'sldasm matches');
eq(ctx.fileMatchesType_('solidworks', 'frame.step', ''), false, 'step does not match solidworks');
eq(ctx.fileMatchesType_('gsheet', 'Quote 1042', 'application/vnd.google-apps.spreadsheet'), true, 'google sheet mime');
eq(ctx.fileMatchesType_('gsheet', 'quote.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), false, 'xlsx is not a google sheet');
eq(ctx.fileMatchesType_('excel', 'budget.xlsx', ''), true, 'xlsx matches excel');
eq(ctx.fileMatchesType_('word', 'notes.DOCX', ''), true, 'docx matches word');
eq(ctx.fileMatchesType_('gdoc', 'Intake Notes', 'application/vnd.google-apps.document'), true, 'gdoc mime matches');
eq(ctx.fileMatchesType_('pdf', 'po_scan.jpg', 'image/jpeg'), false, 'jpg does not match pdf');

// report wording
eq(ctx.rubricExpectation_('04_MODEL'), 'at least 1 file, including a native SolidWorks file (.sldprt / .sldasm / .slddrw), including a PDF', 'model expectation wording');
eq(ctx.rubricExpectation_('00_CUSTOMER_DOCS'), 'at least 1 file, including a PDF or Word document or Google Doc', 'customer docs wording');
eq(ctx.rubricExpectation_('10_FINANCIALS'), 'at least 1 file', 'financials wording');
eq(ctx.rubricExpectation_('09_INSTALLATION'), 'at least 1 file (bonus: adds points, never subtracts)', 'bonus wording');
eq(ctx.foundDescription_({count:2, types:['pdf','solidworks']}), '2 files (includes: PDF, native SolidWorks file (.sldprt / .sldasm / .slddrw))', 'found wording');
eq(ctx.foundDescription_(undefined), 'empty', 'empty wording');
eq(ctx.missingSummary_('04_MODEL', {count:3, types:['solidworks']}), '04_MODEL: no PDF', 'missing summary');
eq(ctx.missingSummary_('04_MODEL', {count:3, types:['solidworks','pdf']}), '', 'satisfied summary');
eq(ctx.missingSummary_('05_QUOTE', {count:0, types:[]}), '05_QUOTE: empty', 'empty summary');

// placement
eq(ctx.expectedBucket_('Lost', 'Production'), 'LOST', 'lost beats pipeline');
eq(ctx.expectedBucket_('Abandoned', 'Sales'), 'LOST', 'abandoned -> LOST');
eq(ctx.expectedBucket_('Open', 'Closed Projects'), 'CLOSED_PROJECTS', 'closed projects pipeline');
eq(ctx.expectedBucket_('Won', 'Production'), 'PRODUCTION', 'production pipeline');
eq(ctx.expectedBucket_('Won', 'Sales'), 'OPPORTUNITIES', 'won but still in sales stays');
eq(ctx.expectedBucket_('Open', 'Sales'), 'OPPORTUNITIES', 'open sales');
eq(ctx.expectedBucket_('Open', ''), 'OPPORTUNITIES', 'unknown pipeline defaults');

// keyword fallback
eq(ctx.inferProductFromText_('Viking - Mobile Enclosure'), 'MBLENCLS', 'keyword mobile enclosure');
eq(ctx.inferProductFromText_('WPI.edu Benchtop Barrier'), 'BENCHTOP', 'benchtop wins over barrier');
eq(ctx.inferProductFromText_('Lockheed Space - Explosives Barrier'), 'MBARRIER', 'keyword barrier');
eq(ctx.inferProductFromText_('Termax Machine Guarding Punch Press Shield'), 'MGUARD', 'keyword guarding');
eq(ctx.inferProductFromText_('Acme - Camera Mount Study'), null, 'no keyword -> null');
eq(ctx.inferProductFromText_('Kevlar Curtain'), 'BLANKET', 'keyword kevlar');
eq(ctx.buildFolderName_({ id: 7, dateCreated: 1756139460, companyName: 'Viking', oppName: 'Viking - Mobile Enclosure', productType: null, productCodeOverride: 'MBLENCLS' }), '20250825_MBLENCLS_Viking_Mobile Enclosure_ID-7', 'override used in name');

// new codes and title case
eq(ctx.productCode_('Level 2 Assessment'), 'ASSESS', 'multi-select assessment maps');
eq(ctx.productCode_('Replacement Parts'), 'PARTS', 'parts maps');
eq(ctx.productCode_('Solvent Bonded Small Shield Enclosure'), 'SMALLENC', 'solvent bonded maps');
eq(ctx.inferProductFromText_('Bickley Engineers - Mobile Shielded Enclosure'), 'MBLENCLS', 'shielded enclosure');
eq(ctx.inferProductFromText_('Woodward Poly Replacement Panels'), 'PARTS', 'replacement panels');
eq(ctx.inferProductFromText_('Mr. Beast YouTube Blast Shield'), 'MBARRIER', 'blast shield');
eq(ctx.inferProductFromText_('NXP - On-site Assessment'), 'ASSESS', 'assessment keyword');
eq(ctx.inferProductFromText_('Duke Energy - 8 Fan Blankets Level 2 Assessment'), 'ASSESS', 'assessment beats blanket (rule order)');
eq(ctx.normalizeCompany_('BAUER COMPRESSORS INC.'), 'Bauer Compressors', 'all caps to title case, suffix stripped');
eq(ctx.normalizeCompany_('ASML'), 'ASML', 'acronym kept');
eq(ctx.normalizeCompany_('PLUG POWER'), 'Plug Power', 'two word all caps');
eq(ctx.normalizeCompany_('Bay Advanced Technologies'), 'Bay Advanced Technologies', 'mixed case untouched');
eq(ctx.normalizeCompany_('GE Aerospace'), 'GE Aerospace', 'mixed case with acronym untouched');

// company recovered from existing folder names
eq(ctx.companyFromFolderName_('Johnson Controls--OPP-Johnson Controls - Mobile Press Shield--ID-32805138'), 'Johnson Controls', 'legacy company');
eq(ctx.companyFromFolderName_('20250902_MBLENCLS_Johnson Controls_3 section mobile enclosure_ID-35250303'), 'Johnson Controls', 'new-format company');
eq(ctx.companyFromFolderName_('20250902_MBLENCLS_UNKNOWN COMPANY_Foo_ID-1'), '', 'unknown placeholder ignored');
eq(ctx.companyFromFolderName_('--Temp Folder Anduril'), '', 'no company');

// report file listing (added 29 Sep 2026)
const F = (name, mime, path, types) => ({ name, mime: mime || '', path: path || '', url: 'u:' + name, updated: null, types: types || [] });
const invL = {
  '04_MODEL': { count: 2, types: ['solidworks'], files: [F('frame.SLDASM', '', '', ['solidworks']), Object.assign(F('frame.skp', '', 'old'), { dirUrl: 'd:old' })] },
  '07_PRODUCTION': { count: 1, types: [], files: [F('cut.dxf', '', 'CNC')] },
  '00_CUSTOMER_DOCS': { count: 0, types: [], files: [] },
  'Research': { count: 1, types: ['pdf'], files: [F('threat.pdf', 'application/pdf', '', ['pdf'])] }
};
const L = ctx.buildFileListing_(invL, [F('loose.docx', '', '', ['word'])], 300);
eq(L.groups.map(g => g.folder), ['00_CUSTOMER_DOCS', '04_MODEL', '07_PRODUCTION', 'Research', null], 'listing order: standard, non-standard, root');
eq(L.groups[1].rows, [['frame.SLDASM', 'SolidWorks', '', 'Yes'], ['old/frame.skp', 'SKP', '', 'No: not a required type (SolidWorks and PDF)']], 'model rows with nested path and credit note');
eq(L.groups[2].rows[0], ['CNC/cut.dxf', 'DXF', '', 'Not scored'], 'production child listed, not scored');
eq(L.groups[3].rows[0][3], 'No: not a standard folder, move into a numbered folder', 'non-standard folder flagged');
eq(L.groups[4].rows[0][3], 'No: loose file at folder root, move into a numbered folder', 'root file flagged');
eq(L.groups[1].links, [{ file: 'u:frame.SLDASM', dir: '', dirLen: 0 }, { file: 'u:frame.skp', dir: 'd:old', dirLen: 4 }], 'file and directory links per row');
eq(ctx.isReportFile_('_SCORE REPORT - 0 of 100 - 2026-09-04'), true, 'legacy report name recognised');
eq(ctx.isReportFile_('_FILE DIRECTORY AND SCORING - 45 of 100 - 2026-09-29'), true, 'new report name recognised');
eq(ctx.isReportFile_('Quote 1042'), false, 'ordinary file not a report');
const Lc = ctx.buildFileListing_(invL, [], 2);
eq([Lc.listed, Lc.total, Lc.omitted, Lc.groups.length], [2, 4, 2, 4], 'cap limits rows, empty root omitted');
eq(ctx.fileTypeLabel_(F('Deck', 'application/vnd.google-apps.presentation')), 'Google Slides', 'google slides label');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
