// ============================================================
// SECUREWORKS FENCING — BUSINESS RULES & OUTPUT GENERATION
// Version 3.0 — Synced with Master Prompt v3.0
// ============================================================
// This file contains all pricing, calculation logic, compliance
// checks, and output templates for the fence designer tool.
// Claude Code: Read this entire file before implementing the
// "Generate Outputs" button in index.html.
// ============================================================

// ============================================================
// SECTION 1: CONFIGURABLE RATES
// ============================================================
// These rates appear in a "Pricing & Settings" panel in the UI.
// The sales rep can adjust them per job before generating outputs.
// Default values shown. All prices are SELL prices (ex GST).

const DEFAULT_RATES = {
  // --- Base Fencing (per metre, supply & install) ---
  fencing_1800_per_m: 120,      // 1800mm Colorbond per metre
  fencing_2100_per_m: 128,      // 2100mm Colorbond per metre
  extension_150_per_m: 110,     // Solid fill 150mm extension per metre

  // --- Plinths ---
  plinth_each: 80,              // Per plinth, supply & install

  // --- Gates ---
  pedestrian_gate: 1100,        // Pedestrian gate (bundled with fence)
  pedestrian_gate_standalone: 1175, // Pedestrian gate (standalone, no fence)
  double_gate: 2400,            // Double swing gate

  // --- Removal & Disposal ---
  remove_hardie_per_sheet: 30,  // Remove Hardie/Super6 per sheet
  remove_timber_per_m: 45,      // Remove timber lap per metre
  remove_asbestos_per_sheet: 90,// Remove asbestos per sheet
  asbestos_removal_fee: 300,    // Flat fee for asbestos removal job

  // --- Additional Services ---
  delivery: 250,                // Delivery fee (flat)
  vegetation_clear: 150,        // Vegetation/site clear (flat)
  additional_labour_per_hr: 85, // Additional labour per hour

  // --- Ground Finish (per m², fence_length × 0.5m strip) ---
  mulch_per_m2: 8,
  white_stones_per_m2: 15,
  turf_prep_per_m2: 12,

  // --- Rock Excavation ---
  rock_per_hole: 45,            // Additional charge per hole if rock hit
};

// --- Cost Prices (internal, for GP calculation) ---
// These are NOT shown to the client. Used for margin analysis.
const COST_PRICES = {
  fencing_1800_per_m: 92,
  fencing_2100_per_m: 100,
  extension_150_per_m: 73,
  plinth_each: 55,
  pedestrian_gate: 835,
  double_gate: 1830,
  remove_hardie_per_sheet: 15,
  remove_timber_per_m: 22.50,
  remove_asbestos_per_sheet: 60,
  asbestos_removal_fee: 300,
  delivery: 200,
  vegetation_clear: 100,
  additional_labour_per_hr: 45,
  mulch_per_m2: 5,
  white_stones_per_m2: 10,
  turf_prep_per_m2: 7,
  rock_per_hole: 30,
  labour_base_per_m: 35,       // Base labour rate for surcharge calc
  plinth_install_each: 10,     // Labour per plinth install
};

// --- Surcharges ---
const SURCHARGES = {
  // Urgency (applied to subtotal before GST)
  urgency: {
    standard: 0,      // 2-4 weeks
    urgent: 0.10,     // 1-2 weeks
    rush: 0.20,       // <1 week
    emergency: 0.30,  // <3 days
  },
  // Access difficulty (applied to LABOUR component only)
  access: {
    easy: 0,
    moderate: 0.10,
    difficult: 0.25,
  },
};


// ============================================================
// SECTION 2: SUPPLIER DATA
// ============================================================

const SUPPLIERS = {
  metroll: {
    name: 'Metroll',
    panel_width: 2365,
    long_panel_width: 3150, // Max ONE per run
    product_codes: {
      posts: 'FNP##',    // ## = height suffix (15/18/21/24/27/30)
      rails: 'FNR##',    // ## = length suffix (23=2365, 31=3125)
      sheets_trimclad: 'FNS##',
      sheets_harmony: 'FHS##',
      plinths_std: 'FSP2365##',
      plinths_long: 'FSP3125##',
      tek_screws: 'TK1016##',
    },
  },
  rnr: {
    name: 'R&R Fencing',
    panel_width: 2380,
    long_panel_width: 3150,
    product_codes: null, // R&R uses own codes
  },
};


// ============================================================
// SECTION 3: MATERIAL CALCULATION RULES
// ============================================================

/**
 * Calculate panels needed for a run.
 * panels = ROUNDUP(run_length_mm / panel_width)
 */
function calculatePanels(runLengthMm, supplier) {
  const panelWidth = SUPPLIERS[supplier].panel_width;
  return Math.ceil(runLengthMm / panelWidth);
}

/**
 * Calculate posts needed for a run.
 * posts = panels + 1 (straight run)
 * Corner posts shared between runs — subtract shared corners externally.
 */
function calculatePosts(panelCount) {
  return panelCount + 1;
}

/**
 * Determine post height for a panel based on sheet height + plinth stack.
 *
 * Formula: Sheet Height + (plinths × 150) + 600mm embedment
 * Available sizes: 2400, 2700, 3000
 * If required > 3000: use 3000 + patio tubing
 */
function getPostHeight(sheetHeight, totalPlinths) {
  const required = sheetHeight + (totalPlinths * 150) + 600;
  const available = [2400, 2700, 3000];
  for (const size of available) {
    if (required <= size) return { postHeight: size, needsPatioTube: false };
  }
  return { postHeight: 3000, needsPatioTube: true };
}

/**
 * Calculate patio tubing quantity.
 *
 * RULE: Count panels with 3-4 plinths (total = slope + retaining).
 * Quantity = count + 1 (adjacent panels share tubes).
 * Max 4 plinths per panel. 5+ = engineered retaining, not Colorbond.
 */
function calculatePatioTubing(panels) {
  const qualifyingPanels = panels.filter(p => {
    const totalPlinths = (p.slopePlinths || 0) + (p.retainingPlinths || 0);
    return totalPlinths >= 3 && totalPlinths <= 4;
  });
  if (qualifyingPanels.length === 0) return 0;
  return qualifyingPanels.length + 1;
}

/**
 * Calculate concrete bags.
 * Standard: 2 bags Kwikset per post
 * Waste factor: × 1.1
 * Round UP to nearest even number
 */
function calculateConcrete(postCount, type = 'standard') {
  const bagsPerPost = type === 'deep' ? 3 : 2;
  const raw = postCount * bagsPerPost * 1.1;
  return Math.ceil(raw / 2) * 2; // Round up to even
}

/**
 * Calculate tek screws.
 * 4 per sheet (2 top rail, 2 bottom rail)
 * Sold in boxes of 100
 */
function calculateScrews(panelCount) {
  const total = panelCount * 4;
  return Math.ceil(total / 100); // Boxes of 100
}


// ============================================================
// SECTION 4: COMPLIANCE CHECKS
// ============================================================
// Run ALL checks before generating any output.
// If any check fails with STOP, do not generate outputs.

const COMPLIANCE_CHECKS = [
  {
    id: 'max_plinths',
    severity: 'STOP',
    check: (panels) => {
      for (const p of panels) {
        const total = (p.slopePlinths || 0) + (p.retainingPlinths || 0);
        if (total >= 5) {
          return {
            pass: false,
            message: `ERROR: Panel ${p.number} has ${total} plinths (max 4). This requires post & panel retaining system. Re-scope as retaining wall project, not Colorbond fencing.`,
          };
        }
      }
      return { pass: true };
    },
  },
  {
    id: 'plinth_capacity_warning',
    severity: 'WARNING',
    check: (panels) => {
      const maxPanels = panels.filter(p => {
        const total = (p.slopePlinths || 0) + (p.retainingPlinths || 0);
        return total === 4;
      });
      if (maxPanels.length > 0) {
        return {
          pass: true,
          message: `⚠ ${maxPanels.length} panel(s) at maximum plinth capacity (600mm). Retaining permit likely required.`,
        };
      }
      return { pass: true };
    },
  },
  {
    id: 'retaining_permit',
    severity: 'FLAG',
    check: (panels) => {
      const needsPermit = panels.some(p => {
        const totalMm = ((p.slopePlinths || 0) + (p.retainingPlinths || 0)) * 150;
        return totalMm >= 500;
      });
      if (needsPermit) {
        return {
          pass: true,
          message: 'Building Permit required (retaining ≥500mm). Add ~$350 permit + ~$600 engineering cert to quote.',
        };
      }
      return { pass: true };
    },
  },
  {
    id: 'front_fence',
    severity: 'FLAG',
    check: (run) => {
      if (run.location === 'front' && run.sheetHeight > 1200) {
        return {
          pass: true,
          message: 'Front fences >1.2m solid require Development Approval per R-Codes. Options: reduce to 1.2m, add permeable screen above 1.2m, or apply for DA (~$500).',
        };
      }
      return { pass: true };
    },
  },
  {
    id: 'measurement_sanity',
    severity: 'WARNING',
    check: (run) => {
      if (run.lengthM > 200) {
        return { pass: false, message: 'Run length >200m — likely a typo. Please verify.' };
      }
      return { pass: true };
    },
  },
];


// ============================================================
// SECTION 5: OPTIONAL LINE ITEMS
// ============================================================
// Sales rep can toggle these on/off and set quantities.
// They appear in the quote if enabled.

const OPTIONAL_ITEMS = [
  // Removal
  { id: 'remove_hardie', label: 'Remove Hardie/Super6 sheets', unit: 'sheet', qtyRequired: true },
  { id: 'remove_timber', label: 'Remove timber lap fencing', unit: 'm', qtyRequired: true },
  { id: 'remove_asbestos', label: 'Remove asbestos sheets', unit: 'sheet', qtyRequired: true, flagsAsbestos: true },

  // Ground finish
  { id: 'ground_mulch', label: 'Mulch ground finish', unit: 'm²', autoCalc: 'fence_length × 0.5' },
  { id: 'ground_stones', label: 'White stones (20mm) ground finish', unit: 'm²', autoCalc: 'fence_length × 0.5' },
  { id: 'ground_turf', label: 'Turf prep ground finish', unit: 'm²', autoCalc: 'fence_length × 0.5' },

  // Additional
  { id: 'vegetation_clear', label: 'Vegetation/site clear', unit: 'job', qty: 1 },
  { id: 'additional_labour', label: 'Additional labour', unit: 'hr', qtyRequired: true },
  { id: 'core_drilling', label: 'Core drilling', unit: 'holes', qtyRequired: true },

  // Gates
  { id: 'pedestrian_gate', label: 'Pedestrian gate (incl lock)', unit: 'ea', qtyRequired: true },
  { id: 'double_gate', label: 'Double swing gate', unit: 'ea', qtyRequired: true },

  // Permits (auto-flagged by compliance checks, rep confirms)
  { id: 'building_permit', label: 'Building Permit application', unit: 'job', sellPrice: 350, costPrice: 350 },
  { id: 'engineering_cert', label: 'Structural Engineering cert', unit: 'job', sellPrice: 600, costPrice: 600 },
  { id: 'dev_approval', label: 'Development Approval (front fence)', unit: 'job', sellPrice: 500, costPrice: 500 },

  // Custom blank items — rep can add description and price
  { id: 'custom_1', label: '', unit: '', qtyRequired: true, isCustom: true },
  { id: 'custom_2', label: '', unit: '', qtyRequired: true, isCustom: true },
  { id: 'custom_3', label: '', unit: '', qtyRequired: true, isCustom: true },
];


// ============================================================
// SECTION 6: GATE POST RULES
// ============================================================

const GATE_RULES = {
  pedestrian: {
    width: 900,
    height: 1750,
    posts: 2,           // 2 × 90x90mm SHS gate posts
    postSpec: '90x90mm SHS',
  },
  double: {
    width: 3255,        // Opening width
    height: 1750,
    posts: 4,           // 4 × 90x90mm SHS gate posts (2 per leaf)
    postSpec: '90x90mm SHS',
  },
  // NEVER use standard C-channel for gates
};


// ============================================================
// SECTION 7: OUTPUT GENERATION
// ============================================================
// All three outputs pull from the SAME data model.
// What's on the canvas = what's in the quote = what's in the
// material order = what's in the work order. ONE source of truth.

/**
 * Collects all job data from the UI into a single object.
 * This is the ONLY data source for all outputs.
 */
function collectJobData() {
  // This function reads from the UI and returns:
  return {
    // --- Job header (from top bar) ---
    jobRef: '',         // e.g. "SW9248"
    clientName: '',
    siteAddress: '',
    supplier: '',       // "metroll" or "rnr"
    profile: '',        // "Trimclad", "Harmony", "Sameside", "Ridgeside"
    colour: '',         // e.g. "Surfmist"
    ratePerMetre: 0,    // From $/metre field in top bar

    // --- Surcharges ---
    accessDifficulty: 'easy',  // easy / moderate / difficult
    urgency: 'standard',       // standard / urgent / rush / emergency

    // --- Runs (from left panel, one per tab) ---
    runs: [
      {
        name: '',           // e.g. "Rear", "LHS"
        lengthM: 0,
        sheetHeight: 1800,  // or 2100
        extension: 'none',  // "none" or "150mm"
        location: '',       // "front", "side", "rear" — for compliance
        panels: [
          {
            number: 1,
            width: 2365,
            sheetHeight: 1800,
            slopePlinths: 0,      // Auto-calculated from slope (read-only)
            retainingPlinths: 0,  // Manual input (neighbour height diff)
            // totalPlinths = slopePlinths + retainingPlinths (capped at 4)
            step: '',             // "↓150", "↑300", etc.
            postHeight: 2400,     // Auto-calculated
            patioTube: false,     // Auto-flagged when totalPlinths >= 3
          },
        ],
        slopeProfile: [0, 0, 0, 0, 0], // 5-point or A/B with midpoints
      },
    ],

    // --- Optional items (toggled on by rep) ---
    optionalItems: [],

    // --- Rates (from settings, defaulted from DEFAULT_RATES) ---
    rates: { ...DEFAULT_RATES },

    // --- Notes (free text from rep) ---
    specialNotes: '',
  };
}


// ============================================================
// OUTPUT 1: CLIENT QUOTE
// ============================================================
// Opens as printable HTML in new tab.
// Professional format matching master prompt template.

function generateClientQuote(jobData) {
  // STRUCTURE:
  // - SecureWorks header (logo, ABN, contact)
  // - Client details
  // - Job description (2-3 sentences, auto-generated from scope)
  // - Itemised pricing table
  // - Surcharges
  // - Subtotal, GST, Grand Total
  // - Payment terms (50% deposit, balance on completion)
  // - Disclaimers (ALWAYS include all 6 standard disclaimers)
  // - Optional add-ons (if not already in quote)
  // - Valid for 30 days

  const quote = {
    header: {
      company: 'SECUREWORKS FENCING',
      abn: '64689223416',
      email: 'fencing@secureworkswa.com.au',
      phone: '+61 489 267 772',
    },

    // Auto-generate job description from the data
    // e.g. "Supply and install 20 metres of 1800mm Surfmist Colorbond
    //        fencing (Harmony profile) to the rear boundary, including
    //        6 retaining plinths and patio tube reinforcement."
    description: buildJobDescription(jobData),

    lineItems: buildQuoteLineItems(jobData),

    // --- MANDATORY DISCLAIMERS (always include) ---
    disclaimers: [
      'BOUNDARY VERIFICATION: Client responsible for confirming boundary location via licensed surveyor. SecureWorks not liable for boundary disputes or encroachment.',
      'PERMITS & APPROVALS: Quote excludes council permits, engineering certification, and development approvals unless specifically itemized above.',
      'SITE CONDITIONS: Quote assumes standard digging in sand/loam. Rock, limestone, or difficult excavation will incur additional charges at $' + jobData.rates.rock_per_hole + ' per hole.',
      'NEIGHBOUR RELATIONS: Client responsible for Dividing Fences Act notice and neighbour cost-sharing agreements. This quote reflects full project cost.',
      'VARIATIONS: Changes to scope after acceptance will be quoted separately.',
      'UNDERGROUND SERVICES: Client responsible for locating services via Dial Before You Dig. Quote assumes DBYD plans reviewed and services marked on-site.',
    ],

    // Conditional disclaimers (added by compliance checks)
    conditionalDisclaimers: [],

    paymentTerms: {
      deposit: 0.50, // 50%
      balance: 'on completion',
    },

    validity: 30, // days
  };

  return quote;
}


// ============================================================
// OUTPUT 2: MATERIAL ORDER
// ============================================================
// For supplier (Metroll / R&R).
// Groups panels by post height. Shows patio tubing calc clearly.

function generateMaterialOrder(jobData) {
  const order = {
    header: {
      company: 'SECUREWORKS WA PTY LTD',
      jobRef: jobData.jobRef,
      customer: jobData.clientName,
      deliveryAddress: jobData.siteAddress,
      siteContact: '0489 267 772',
      deliveryDate: '[DATE]',     // Rep fills in
      deliveryTime: '8-10am',
      supplier: SUPPLIERS[jobData.supplier]?.name || jobData.supplier,
    },

    // --- Panels grouped by post height ---
    // e.g. "6 × 1800H × 2365W panels W/ 2400H posts | Surfmist | Harmony"
    //       "2 × 1800H × 2365W panels W/ 2700H posts | Surfmist | Harmony"
    panelGroups: groupPanelsByPostHeight(jobData),

    // --- Patio Tubing (if any panels have 3-4 plinths) ---
    // Show calculation: "[X] panels with 3-4 plinths + 1 = [Y] tubes"
    patioTubing: calculatePatioTubingOrder(jobData),

    // --- Gate Posts (90x90mm, NOT C-channel) ---
    gatePosts: calculateGatePosts(jobData),

    // --- Plinths (total count across all runs) ---
    plinths: calculateTotalPlinths(jobData),

    // --- Gate Kits ---
    gateKits: getGateKits(jobData),

    // --- Fixings ---
    fixings: {
      concrete: calculateConcrete(getTotalPostCount(jobData)),
      screwBoxes: calculateScrews(getTotalPanelCount(jobData)),
      // Gate hardware auto-included with gate kits
    },

    // Standard C-channel posts are INCLUDED with panel kits
    // Do NOT list them separately
    // Only list: patio tubing, gate posts (90x90mm), and special items

    notes: jobData.specialNotes,
    footer: 'Payment: On receipt of itemized invoice\nPlease confirm itemized invoice and delivery ETA within 24 hours.',
  };

  return order;
}


// ============================================================
// OUTPUT 3: WORK ORDER
// ============================================================
// For installers. Includes panel-by-panel breakdown if plinths present.

function generateWorkOrder(jobData) {
  const workOrder = {
    header: {
      jobRef: jobData.jobRef,
      clientName: jobData.clientName,
      siteAddress: jobData.siteAddress,
      clientPhone: '[Phone]',   // Rep fills in
      clientEmail: '[Email]',   // Rep fills in
      scheduledStart: '[Date]',
      expectedCompletion: '[Date]',
      scopedBy: 'Sales',
      approvedBy: 'Admin',
    },

    fenceSpec: {
      profile: jobData.profile,
      colour: jobData.colour,
      sheetHeight: jobData.runs[0]?.sheetHeight || 1800,
      totalLength: getTotalLength(jobData),
      totalPanels: getTotalPanelCount(jobData),
      manufacturer: SUPPLIERS[jobData.supplier]?.name || jobData.supplier,
    },

    // --- Run breakdown (panel by panel if plinths, simplified if not) ---
    // Simple run: "Run A (Rear): 20m | 9 panels | 0 plinths | 2400mm posts"
    // Complex run with plinths:
    //   "Panels 1-3: 0 plinths | 2400mm posts"
    //   "Panels 4-5: 2 plinths each | 2700mm posts"
    //   "⚠ Patio tubing required for panels 4-5"
    runBreakdowns: buildRunBreakdowns(jobData),

    // --- Scope of work checklist ---
    scopeOfWork: buildScopeChecklist(jobData),

    // --- Safety & compliance ---
    safetyChecklist: [
      'DBYD plans reviewed before start',
      'Services marked on-site (hand dig exposure if high risk)',
      'Boundary pegs located and photographed',
      'Client notified 48h advance',
      'Weather checked day-before',
    ],

    // --- Completion requirements ---
    completionReqs: [
      'Upload 10 QC photos (start, mid, end, gates, details, street)',
      'Client walkthrough and acceptance',
      'Mark "Ready for Sign-Off" in Tradify',
    ],

    // --- Internal cost breakdown (not shown to client) ---
    internalCosts: calculateInternalCosts(jobData),

    siteAccess: {
      level: jobData.accessDifficulty,
      notes: '', // Rep fills in
    },
  };

  return workOrder;
}


// ============================================================
// OUTPUT 4: GROSS PROFIT ANALYSIS (Internal)
// ============================================================
// For management. Shows full cost/revenue/margin breakdown.

function generateGPAnalysis(jobData) {
  const costs = calculateAllCosts(jobData);
  const revenue = calculateAllRevenue(jobData);

  const grossProfit = revenue.totalExGST - costs.totalExGST;
  const gpMargin = (grossProfit / revenue.totalExGST) * 100;
  const gpMarkup = (grossProfit / costs.totalExGST) * 100;
  const salesCommission = grossProfit * 0.12;

  return {
    jobRef: jobData.jobRef,
    clientName: jobData.clientName,
    totalLength: getTotalLength(jobData),
    totalPanels: getTotalPanelCount(jobData),

    costs: costs,
    revenue: revenue,

    grossProfit: grossProfit,
    gpMarginPercent: gpMargin,
    gpMarkupPercent: gpMarkup,
    salesCommission: salesCommission,

    // Decision metrics
    marginAbove20: gpMargin >= 20,
    jobAbove3k: revenue.totalExGST >= 3000,
    riskFactors: identifyRiskFactors(jobData),

    // Breakeven = total costs (minimum sell to not lose money)
    breakeven: costs.totalExGST,
  };
}


// ============================================================
// SECTION 8: HELPER FUNCTIONS
// ============================================================
// These are referenced by the output generators above.
// Claude Code: implement these to read from the actual UI state.

function buildJobDescription(jobData) {
  // Auto-generate plain English description from scope data
  // e.g. "Supply and install 20 metres of 1800mm Surfmist Colorbond fencing
  //        (Harmony profile) to the rear boundary. Includes 6 retaining plinths
  //        with patio tube reinforcement at panels 4-6. Existing Hardie fence
  //        to be removed and disposed."
  // Implementation: Build from runs, plinths, gates, removal items
}

function buildQuoteLineItems(jobData) {
  // Returns array of { description, qty, unit, unitPrice, lineTotal }
  // Pull from runs + optional items
  // Always include delivery unless specified otherwise
}

function groupPanelsByPostHeight(jobData) {
  // Group all panels across all runs by post height
  // Returns: { 2400: count, 2700: count, 3000: count }
  // Format each as: "X × [H]H × [W]W panels W/ [PH]H posts | Colour | Profile"
}

function calculatePatioTubingOrder(jobData) {
  // Count panels with 3-4 total plinths across all runs
  // Return: { qty, calculation: "X panels with 3-4 plinths + 1 = Y tubes" }
  // Spec: 76x38mm × 3000mm length
}

function calculateGatePosts(jobData) {
  // From optional items: count pedestrian × 2 + double × 4
  // Spec: 90x90mm SHS (NOT C-channel)
}

function calculateTotalPlinths(jobData) {
  // Sum all plinths (slope + retaining) across all panels, all runs
}

function getGateKits(jobData) {
  // From optional items, list gate kits with specs and colour
}

function getTotalPostCount(jobData) {
  // Sum posts across all runs, minus shared corner posts
}

function getTotalPanelCount(jobData) {
  // Sum panels across all runs
}

function getTotalLength(jobData) {
  // Sum run lengths
  return jobData.runs.reduce((sum, r) => sum + r.lengthM, 0);
}

function buildRunBreakdowns(jobData) {
  // For each run:
  // If all panels identical (no plinths): one-line summary
  // If plinths vary: panel-by-panel or grouped ranges
  // Flag patio tubing sections
}

function buildScopeChecklist(jobData) {
  // Auto-build from scope:
  // ✓ Install Xm of Colorbond fencing (Y panels total)
  // ✓ Total posts: Z standard C-channel + A gate posts
  // ✓ Plinth installation: X plinths total
  // [if patio tubing] ✓ Install X × 76x38mm patio tubing
  // [if gates] ✓ Install gates with 90x90mm gate posts
  // [if removal] ✓ Remove and dispose X sheets/metres of [material]
  // [if ground finish] ✓ Spread [type] along fence line (Xm²)
}

function calculateInternalCosts(jobData) {
  // Labour + materials at cost prices
  // For work order internal view only
}

function calculateAllCosts(jobData) {
  // Full cost breakdown using COST_PRICES
  // Materials + labour + removal + delivery + ground finish
}

function calculateAllRevenue(jobData) {
  // Full revenue using sell prices (from rates)
  // Apply surcharges correctly:
  //   - Access difficulty → LABOUR only
  //   - Urgency → SUBTOTAL
  // Add GST (10%)
}

function identifyRiskFactors(jobData) {
  // Return array of risk strings:
  // "Rock likely" if noted
  // "Asbestos removal" if present
  // "Difficult access" if set
  // "Retaining permit required" if any panel ≥ 500mm
  // "Front fence DA may be required"
  // "Max plinth capacity reached"
}


// ============================================================
// SECTION 9: ERROR PREVENTION (PRE-GENERATION CHECKS)
// ============================================================
// Run before generating ANY output. Mirrors master prompt checks.

function runPreGenerationChecks(jobData) {
  const errors = [];   // STOP — cannot generate
  const warnings = []; // WARNING — generate with flag
  const flags = [];    // FLAG — include in output

  // Check 1: Max plinths per panel ≤ 4
  for (const run of jobData.runs) {
    for (const panel of run.panels) {
      const total = (panel.slopePlinths || 0) + (panel.retainingPlinths || 0);
      if (total >= 5) {
        errors.push(`Panel ${panel.number} in ${run.name} has ${total} plinths (max 4). Requires engineered retaining wall.`);
      }
    }
  }

  // Check 2: Measurements realistic
  for (const run of jobData.runs) {
    if (run.lengthM > 200) {
      warnings.push(`${run.name} run is ${run.lengthM}m — likely a typo.`);
    }
    if (run.sheetHeight > 2400) {
      warnings.push(`Sheet height ${run.sheetHeight}mm exceeds standard range. Requires engineering.`);
    }
  }

  // Check 3: Post heights calculated correctly
  // (Auto-calculated, but verify)

  // Check 4: Cost < Sell (margin exists)
  // Run after calculating all line items

  // Check 5: Critical data present
  if (!jobData.clientName) warnings.push('Client name missing.');
  if (!jobData.siteAddress) warnings.push('Site address missing.');
  if (!jobData.jobRef) warnings.push('Job reference missing.');
  if (!jobData.supplier) errors.push('Supplier not selected.');

  // Check 6: Retaining permit
  for (const run of jobData.runs) {
    for (const panel of run.panels) {
      const totalMm = ((panel.slopePlinths || 0) + (panel.retainingPlinths || 0)) * 150;
      if (totalMm >= 500) {
        flags.push('Building Permit required — retaining ≥500mm. Include permit ($350) and engineering cert ($600) in quote.');
        break;
      }
    }
  }

  // Check 7: Front fence
  for (const run of jobData.runs) {
    if (run.location === 'front' && run.sheetHeight > 1200) {
      flags.push('Front fence >1.2m solid — Development Approval may be required per R-Codes.');
    }
  }

  // Check 8: Asbestos
  const hasAsbestos = jobData.optionalItems.some(i => i.id === 'remove_asbestos' && i.enabled);
  if (hasAsbestos) {
    const totalArea = jobData.optionalItems
      .filter(i => i.id === 'remove_asbestos')
      .reduce((sum, i) => sum + (i.qty || 0) * 1.8 * 0.6, 0); // approx m² per sheet
    if (totalArea > 10) {
      flags.push('Class B Asbestos License required (>10m²). Confirm in-house license or subcontract.');
    }
  }

  return { errors, warnings, flags };
}


// ============================================================
// SECTION 10: COMMON MISTAKES TO PREVENT
// ============================================================
// Hard-coded guards in the calculation logic.

const GUARDS = {
  // NEVER use markup formula. Always use margin.
  // WRONG: cost × 1.20 = $120 (only 16.7% margin)
  // RIGHT: cost / 0.80 = $125 (exactly 20% margin)
  marginFormula: (cost, targetMargin) => cost / (1 - targetMargin),

  // NEVER use C-channel posts for gates → always 90x90mm SHS
  // NEVER list standard posts separately → included with panel kits
  // NEVER mix suppliers on same job
  // NEVER calculate post height from average plinths → use MAXIMUM per panel
  // NEVER double-count corner posts between runs
  // NEVER round concrete bags down → always up to even number
  // ALWAYS include all 6 mandatory disclaimers in quote
};


// ============================================================
// SECTION 11: UPSELL & CROSS-SELL PROMPTS
// ============================================================
// Auto-suggest in quote output based on scope.

function getUpsellSuggestions(jobData) {
  const suggestions = [];

  // If asbestos present but not quoted
  const hasAsbestosOnSite = false; // rep flags this
  const asbestosQuoted = jobData.optionalItems.some(i => i.id === 'remove_asbestos' && i.enabled);
  if (hasAsbestosOnSite && !asbestosQuoted) {
    suggestions.push('Optional: Asbestos removal $90/sheet + $300 removal fee');
  }

  // If no ground finish selected
  const hasGroundFinish = jobData.optionalItems.some(i =>
    ['ground_mulch', 'ground_stones', 'ground_turf'].includes(i.id) && i.enabled
  );
  if (!hasGroundFinish) {
    suggestions.push('Optional: Mulch $8/m², White stones $15/m², Turf prep $12/m²');
  }

  // If retaining >300mm present
  const hasHighRetaining = jobData.runs.some(r =>
    r.panels.some(p => ((p.slopePlinths || 0) + (p.retainingPlinths || 0)) * 150 > 300)
  );
  if (hasHighRetaining) {
    suggestions.push('Note: Retaining wall extension available — quote separately');
  }

  // Always offer patio cross-sell
  suggestions.push('Complementary patio quote available upon request');

  // If removal required, highlight it
  const hasRemoval = jobData.optionalItems.some(i =>
    ['remove_hardie', 'remove_timber', 'remove_asbestos'].includes(i.id) && i.enabled
  );
  if (hasRemoval) {
    suggestions.push('Full removal and licensed disposal included');
  }

  return suggestions;
}
