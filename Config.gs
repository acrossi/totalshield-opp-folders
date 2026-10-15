/**
 * TotalShield Opportunity Folder Automation
 * Config.gs - all tunables in one place.
 *
 * Secrets (Copper API key, webhook secret) live in Script Properties, never in code.
 *   File > Project properties > Script properties, or run setSecrets() once from the editor.
 */

var CONFIG = {
  // Google Drive: the four lifecycle buckets in the CRM shared drive. Fill in the IDs after creating the folders.
  CRM_SHARED_DRIVE_ID: '0APSqj2NtUHkPUk9PVA',                      // Shared Drive "CRM" root (ARCHIVE/ORPHANED is created here)
  OPPORTUNITIES_FOLDER_ID: '1Cv0F499ViGYEobgn500daJxSy9fA0ErE',   // CRM > OPPORTUNITIES (existing)
  BUCKETS: {
    OPPORTUNITIES:   '1Cv0F499ViGYEobgn500daJxSy9fA0ErE',
    PRODUCTION:      '1YkTqe0rhAHEwIT9vkwdzL7RV8u9qqTSr',   // CRM > PRODUCTION
    CLOSED_PROJECTS: '1qRVeM9UNCkUhCv8pZCRzKAJzNYQdDB3Q',   // CRM > CLOSED_PROJECTS
    LOST:            '1XQYYAhGS8m4nha8OVtRGMi_rw7Nj0toe'    // CRM > LOST
  },
  ENABLE_MOVES: true,        // false = rename only, never move between buckets (useful for the first dry run)
  // Lost/Abandoned folders: rename and move, but never create subfolders (nobody works in them).
  // If a lost record is reopened it moves back and gets subfolders on that pass.
  SUBFOLDERS_FOR_LOST: false,
  CREATE_FOLDERS_FOR_LOST: false,   // a lost record with no folder gets none until it is reopened
  LOG_SPREADSHEET_NAME: 'TS Opportunity Folder Automation Log',    // created on first run, in the CRM shared drive root

  // Copper pipeline names (matched by name, ids resolved at runtime)
  PIPELINE_SALES: 'Sales',
  PIPELINE_PRODUCTION: 'Production',
  PIPELINE_CLOSED: 'Closed Projects',
  STAGE_PROJECT_COMPLETE: 'Project Complete',   // in Closed Projects; triggers final rescore
  LOST_STATUSES: ['Lost', 'Abandoned'],

  // Copper
  COPPER_BASE_URL: 'https://api.copper.com/developer_api/v1',
  COPPER_USER_EMAIL: 'adam@totalshield.com',       // the user the API key belongs to
  COPPER_APP_URL: 'https://app.copper.com/companies/435828/app',

  // Custom field labels in Copper (matched by name so IDs never have to be hard-coded)
  CF_DRIVE_ROOT_ID: 'Google Drive Root ID - Opportunity',
  CF_DRIVE_LINK: 'Google Drive Folder Link - Opportunity',
  CF_OPP_ID: 'Opportunity ID',
  CF_PRODUCT_TYPE: 'Primary Product Type of Interest',
  CF_PRODUCTS_MULTI: 'Product(s) of Interest',   // fallback: first selected value when the primary field is blank
  CF_PROJECT_COMPLETED: 'Project Completed (Archive)',
  CF_DOC_SCORE: 'Opportunity Documentation Score',   // create this (Number) in Copper before enabling scoring
  CF_HIST_OWNER: 'Historical Owner',                 // text field: who really ran old records whose Copper assignee is empty (e.g. departed employees)
  // Documentation stage gates (Checkbox fields — create in Copper before ENABLE; script is the writer of Docs OK_*)
  CF_DOCS_OK_PRODUCTION: 'Docs OK for Production',
  CF_DOCS_OK_CLOSE: 'Docs OK for Close',
  CF_DOCS_OK_COMPLETE: 'Docs OK for Complete',
  CF_GATE_OVERRIDE: 'Gate Override',                 // managers only; forces all Docs OK true

  // Product code map: dropdown option name -> short code
  PRODUCT_CODES: {
    'Benchtop Enclosure': 'BENCHTOP',
    'Shielding Room': 'SHLDROOM',
    'Shielding Blanket': 'BLANKET',
    'Mobile Shield Barrier': 'MBARRIER',
    'Mobile Shield Enclosure': 'MBLENCLS',
    'Machine Guard': 'MGUARD',
    'Small Shield Enclosure': 'SMALLENC',
    'Heat Exchanger Test Shield': 'HETSHILD',
    'On-site Assessment': 'ASSESS',
    'Replacement Parts': 'PARTS',
    'Other / Unknown': 'OTHER',
    // "Product(s) of Interest" multi-select uses some different labels
    'Solvent Bonded Small Shield Enclosure': 'SMALLENC',
    'Level 1 Assessment': 'ASSESS',
    'Level 2 Assessment': 'ASSESS',
    'Level 3 Assessment': 'ASSESS',
    'Other/Unknown': 'OTHER'
  },
  DEFAULT_PRODUCT_CODE: 'OTHER',
  // Keyword fallback when the Copper product fields are blank: first matching pattern (case-insensitive) on the
  // opportunity name wins. Not applied to Lost/Abandoned records (old records are left as OTHER).
  PRODUCT_KEYWORDS: [
    [/assessment|consultation|site visit/i, 'ASSESS'],
    [/replacement|spare|\bparts?\b|\bpanels?\b|\bplates?\b|bracket|\bdoor\b|cover/i, 'PARTS'],
    [/benchtop|bench top|table ?top/i, 'BENCHTOP'],
    [/blanket|kevlar|curtain/i, 'BLANKET'],
    [/heat exchanger/i, 'HETSHILD'],
    [/machine guard|guarding|press shield/i, 'MGUARD'],
    [/small (shield(ed)? )?enclosure|solvent (bonded|weld)/i, 'SMALLENC'],
    [/mobile (shield(ed)? )?enclosure|shield(ed)? enclosure/i, 'MBLENCLS'],
    [/barrier|shield wall|blast shield|\bwall\b/i, 'MBARRIER'],
    [/shield(ing)? room|blast room|\broom\b/i, 'SHLDROOM']
  ],
  PRODUCT_KEYWORDS_FOR_LOST: false,

  // Standard subfolders created inside every opportunity folder. Nested paths use "/".
  // Missing entries are topped up on every sync, so adding one here rolls out to all live folders automatically.
  SUBFOLDERS: [
    '00_CUSTOMER_DOCS',
    '01_CLIENT_INTAKE',
    '02_REQUIREMENTS',
    '03_ANALYSIS',
    '04_MODEL',
    '05_QUOTE',
    '06_PURCHASE_ORDER',
    '07_PRODUCTION',
    '07_PRODUCTION/CNC',             // DXF, DWG, NC, G-code, nesting files as sent to the machine
    '07_PRODUCTION/SHOP_DRAWINGS',   // fabrication drawings and cut lists the shop works from
    '07_PRODUCTION/QC',              // inspection sheets, dimensional checks, material certs
    '08_DELIVERABLES',
    '09_INSTALLATION',
    '10_FINANCIALS',
    '11_PHOTOS'
  ],

  // Naming
  NAME_SEPARATOR: '_',
  INCLUDE_OPP_NAME: true,          // false -> YYYYMMDD_CODE_Company_ID-123
  MAX_NAME_LENGTH: 180,
  TIMEZONE: 'America/New_York',

  // Company names typed in ALL CAPS in Copper are shown in Title Case, except these acronyms (kept as typed)
  TITLE_CASE_ALLCAPS: true,
  ACRONYMS: ['ASML', 'KLA', 'GEA', 'ATI', 'NXP', 'IBM', 'GE', 'SGS', 'AWC', 'XNRGY', 'NASA', 'BAE', 'EOG', 'GATX', 'TE', 'PSNS&IMF', 'LM', 'WPI', 'UK', 'USA', 'US', 'LLC', 'SA', 'AG'],
  // Company name normalisation: suffixes stripped for comparison AND display
  STRIP_COMPANY_SUFFIXES: ['inc', 'inc.', 'llc', 'l.l.c.', 'ltd', 'ltd.', 'corp', 'corp.', 'corporation', 'co.', 'company', 'gmbh', 'ab', 'as', 's.l', 's.l.', 'plc'],

  // Polling: primary sync mechanism (webhooks are optional). Look back further than the interval so nothing slips.
  POLL_EVERY_MINUTES: 5,       // Apps Script allows 1, 5, 10, 15, 30
  POLL_LOOKBACK_MINUTES: 15,
  // Parallel-run safety: the poll ignores opportunities created before this unix timestamp (seconds).
  // Set to 0 after the migration so every record is kept in sync.
  SYNC_CREATED_AFTER: 0,   // was 1787774400 (2026-08-26 16:00 EDT) during the parallel-run period; 0 since the 27 Aug migration.

  // Scoring rubric (agreed with Adam, refined 28 Aug 2026). Keys are top-level subfolder names; files in
  // nested children count. weight = points; the score is normalised, so equal weights = equal shares.
  // needTypes: list of requirements that must ALL be met; each requirement is a list of FILE_TYPES
  // alternatives of which at least one file must match. No credit until every requirement is met.
  // bonus: credit is added when present but the folder never counts against the score (capped at 100).
  // 07_PRODUCTION and 11_PHOTOS are deliberately unscored.
  SCORING: {
    '00_CUSTOMER_DOCS':  { weight: 10, minFiles: 1, needTypes: [['pdf', 'word', 'gdoc']] },
    '01_CLIENT_INTAKE':  { weight: 10, minFiles: 1, needTypes: [['pdf', 'word', 'gdoc']] },
    '02_REQUIREMENTS':   { weight: 10, minFiles: 1, needTypes: [['pdf', 'word', 'gdoc']] },
    '03_ANALYSIS':       { weight: 10, minFiles: 1, needTypes: [['pdf', 'word', 'gdoc', 'gsheet', 'excel']] },
    '04_MODEL':          { weight: 10, minFiles: 1, needTypes: [['solidworks'], ['pdf']] },   // native SW AND a PDF drawing
    '05_QUOTE':          { weight: 10, minFiles: 1, needTypes: [['gsheet', 'excel']] },
    '06_PURCHASE_ORDER': { weight: 10, minFiles: 1, needTypes: [['pdf', 'word', 'gdoc']] },
    '08_DELIVERABLES':   { weight: 10, minFiles: 1, needTypes: [['pdf']] },
    '10_FINANCIALS':     { weight: 10, minFiles: 1 },
    '09_INSTALLATION':   { weight: 5,  minFiles: 1, bonus: true }
  },
  // File-type matchers referenced by needTypes. Checked against file name and mime type.
  FILE_TYPES: {
    solidworks: { ext: /\.(sldprt|sldasm|slddrw)$/i },                       // native SolidWorks only
    pdf:        { mime: /^application\/pdf$/, ext: /\.pdf$/i },
    word:       { mime: /(msword|wordprocessingml)/, ext: /\.docx?$/i },
    gdoc:       { mime: /^application\/vnd\.google-apps\.document$/ },
    gsheet:     { mime: /^application\/vnd\.google-apps\.spreadsheet$/ },   // native Google Sheet
    excel:      { mime: /spreadsheetml|ms-excel/, ext: /\.(xlsx?|xlsm)$/i }
  },
  // One sentence per folder expressing its intent, shown in the guide and every score report.
  FOLDER_INTENT: {
    '00_CUSTOMER_DOCS': 'Documents received directly from the customer: NDAs, contracts, correspondence, and reference material they sent us.',
    '01_CLIENT_INTAKE': 'Intake forms and notes from discovery calls and meetings that capture what the customer told us.',
    '02_REQUIREMENTS': 'A document summarizing the customer\'s request, plus anything they supplied such as floor plans, RFP documents, and specifications.',
    '03_ANALYSIS': 'Calculation worksheets for the specific customer threat: the blast or ballistic analysis supporting the design.',
    '04_MODEL': 'The SolidWorks model of the proposed solution and the PDF drawing generated from it.',
    '05_QUOTE': 'The quote workbook used to price the job, including revisions sent to the customer.',
    '06_PURCHASE_ORDER': 'The customer\'s purchase order and our order acknowledgement.',
    '07_PRODUCTION': 'Working files used to build the job: CNC files, shop drawings, and QC records.',
    '08_DELIVERABLES': 'The final package issued to the customer: drawings, test reports, certificates, and manuals.',
    '09_INSTALLATION': 'Install plans, site documentation, and customer sign-off when TotalShield performs the installation.',
    '10_FINANCIALS': 'Invoices, payment records, and the budget-to-actual workbook.',
    '11_PHOTOS': 'Build, shipping, and install photos.'
  },
  // Human wording for FILE_TYPES, used in report documents
  TYPE_LABELS: {
    solidworks: 'native SolidWorks file (.sldprt / .sldasm / .slddrw)',
    pdf: 'PDF',
    word: 'Word document',
    gdoc: 'Google Doc',
    gsheet: 'Google Sheet',
    excel: 'Excel workbook'
  },
  // Report documents (file directory + score) are created at the opportunity folder root with this name prefix.
  // Files with this prefix are ignored by the inventory, and old ones are trashed on re-run.
  REPORT_PREFIX: '_FILE DIRECTORY AND SCORING',
  LEGACY_REPORT_PREFIXES: ['_SCORE REPORT'],   // earlier report names: still excluded from inventory and trashed on re-run (renamed 29 Sep 2026)
  REPORT_SHEET: 'Score Report',          // summary tab in the log spreadsheet
  REPORT_OWNER_SHEET: 'Score by Owner',  // per-owner averages tab
  REPORT_FILE_LIST_CAP: 300,             // max files listed in a report's "Files in this folder" section

  // Penalty per loose file left at the folder root (0 = disabled; decided 28 Aug 2026)
  LOOSE_FILE_PENALTY: 0,
  LOOSE_FILE_PENALTY_CAP: 10,

  // Documentation stage gates. Copper handoff workflows gain a condition on these checkboxes;
  // this script ticks them when the folder earns credit. See Gates.gs and PLAN.md.
  // ENABLE false = no evaluation. WARN_ONLY true = log only (use before editing Copper workflows).
  GATES: {
    ENABLE: false,
    WARN_ONLY: true,                 // strongly recommended for the first 2-3 weeks (no grandfathering; baseline ~0)
    // Override: honored for everyone who can tick it, because Copper's API does not say who edited a field.
    // Only these Copper users are allowed to tick it (Adam Rossi, Carin Charon, Isabel Silva); every
    // override is logged with the opportunity's assignee and modified date so Hanibal can audit it.
    OVERRIDE_ALLOWED_USERS: { 984268: 'Adam Rossi', 991740: 'Carin Charon', 993457: 'Isabel Silva' },
    // Parked-deal list for Hanibal's Slack nudges (#crm-bot + owner DM): log sheet tab, rewritten each sweep.
    PARKED_SHEET: 'Parked',
    // Installed job = Copper checkbox below ticked, OR the deal was ever seen at one of INSTALL_STAGES
    // (remembered in Script Properties). Not "Customer Installation Support": every job passes through it.
    CF_INSTALLED: 'Installed by TotalShield',
    INSTALL_STAGES: ['Active Installation'],
    GATES: [
      {
        key: 'production',
        label: 'Docs OK for Production',
        checkboxField: 'Docs OK for Production',
        handoffStage: 'Initial Down Payment Received',   // Sales 4424598 -> workflow moves to Production
        // Partial at this point: requirements, model, quote, PO. 00/01/03 recommended only (listed in nudges).
        requiredFolders: ['02_REQUIREMENTS', '04_MODEL', '05_QUOTE', '06_PURCHASE_ORDER'],
        recommendedFolders: ['00_CUSTOMER_DOCS', '01_CLIENT_INTAKE', '03_ANALYSIS']
      },
      {
        key: 'close',
        label: 'Docs OK for Close',
        checkboxField: 'Docs OK for Close',
        handoffStage: 'Customer Installation Support',   // Production 4394767 (final stage) -> Closed / All Payments Received; confirm in Copper
        requiredFolders: ['02_REQUIREMENTS', '03_ANALYSIS', '04_MODEL', '05_QUOTE', '06_PURCHASE_ORDER', '08_DELIVERABLES'],
        recommendedFolders: ['00_CUSTOMER_DOCS', '01_CLIENT_INTAKE'],
        requiredWhenInstalled: ['09_INSTALLATION']
      },
      {
        key: 'complete',
        label: 'Docs OK for Complete',
        checkboxField: 'Docs OK for Complete',
        handoffStage: 'Folder Review',                   // Closed 5191144 -> Workflow C sets Project Complete (hard gate)
        requiredFolders: [],
        requireScore100: true
      }
    ]
  }
};

function getSecret_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing Script Property: ' + key);
  return v;
}

/** Run once from the editor after pasting your values, then delete the values from this function. */
function setSecrets() {
  PropertiesService.getScriptProperties().setProperties({
    COPPER_API_KEY: 'PASTE_KEY_HERE',
    WEBHOOK_SECRET: Utilities.getUuid()
  });
}
