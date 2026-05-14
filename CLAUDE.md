# SECUREWORKS WA — WEBSITE PROJECT CONTEXT

## CRITICAL PRODUCTION EDGE DEPLOY RULE

`ops-api` and `send-quote` must have one deployable reality only.

Production deploys are allowed only from:

- GitHub repo: `marninms98-dotcom/secureworks-site`
- Branch: `main`
- Local release worktree: `/Users/marninstobbe/Projects/_release/secureworks-site-main`

Do not deploy `ops-api` or `send-quote` from stale worktrees, dashboard repos,
feature folders, copied repos, `/private/tmp`, or any folder other than the
canonical release worktree.

Allowed local deploy command:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
SW_API_KEY=... scripts/deploy-edge-function.sh send-quote
```

If you are Claude/Codex/Shaun/Marnin in another terminal and you are unsure, do
not deploy. Open a PR or run the read-only smoke script instead.

## WHAT THIS PROJECT IS

Building a landing page / website for SecureWorks WA's insulated patio division. Single-page HTML site designed to convert visitors into quote requests. The site is embedded/hosted via GoHighLevel (GHL) and the lead capture form is a GHL form embed.

---

## COMPANY OVERVIEW

**Business:** SecureWorks Group pty ltd
**Trading as:** SecureWorks Group Pty ltd
**Location:** Perth, Western Australia (servicing northern suburbs primarily)
**Founded:** 2022
**Stage:** Scaling from founder-led to operator-led
**Culture:** Kingdom-first (faith-based values) with professional execution

SecureWorks is a multi-division outdoor living construction company. Patios are the primary revenue driver. Fencing is a secondary service used for cross-selling.

### Services
- **Insulated Patios** (primary — SolarSpan panels by Bondor)
- **Non-insulated patios/carports** (Trimdek, SpanPlus, Corrugated sheets)
- **Colorbond Fencing**
- **Decking** (composite + hardwood)
- **Screening, blinds, shutters**
- **Outdoor kitchens, lighting, fans**
- **Emergency/make-safe services** (separate division)

### Positioning
- "Outdoor living solutions provider" — NOT just patio builders
- Premium quality, fair pricing — not the cheapest, not luxury
- Tone: Confident but not arrogant. Plain English, not marketing speak. Local, reachable, real people.
- Tagline direction: "Extend your living space" / "More than a patio"

---

## BRAND GUIDE

### Brand Colours (EXACT VALUES — use these precisely)

| Name | HEX | RGB | CMYK | Use |
|------|-----|-----|------|-----|
| SecureWorks Orange | #F15A29 | 241, 90, 41 | 0, 60, 95, 0 | Primary accent, CTAs, highlights, header bands |
| Dark Dusty Blue | #293C46 | 41, 60, 70 | 83, 64, 53, 46 | Headings, dark backgrounds, section headers |
| Mid Dusty Blue | #4C6A7C | 76, 106, 124 | 75, 50, 39, 13 | Secondary text, labels, borders |
| White | #FFFFFF | 255, 255, 255 | 0, 0, 0, 0 | Backgrounds, text on dark elements |
| Light Tint | — | 240, 244, 247 | — | Alternating rows, subtle backgrounds |

### Colours NOT to use
- No pure black (#000000) for headings — use Dark Dusty Blue instead
- No generic greys — use the blue tones
- No orange as a large background fill — orange is for accents, CTAs, thin lines only
- Body text: near-black (50, 50, 50) or similar dark grey is fine

### Typography
- **Primary:** Helvetica Bold (headings, buttons)
- **Secondary:** Helvetica Regular Oblique (emphasis)
- **Body:** Helvetica Regular
- Web fallback: `'Helvetica Neue', Helvetica, Arial, sans-serif`
- Labels: uppercase, letter-spacing, font-weight 700

### Logo
- Primary logo: House icon (dark dusty blue) + orange underline accent + "SecureWorks" in dark blue italic bold + "WA" lighter weight
- Icon version available (house shape with SW chevron)
- White version exists for dark backgrounds
- Logo files are in the project folder

---

## WEBSITE SECTIONS (Current Build)

The landing page has been built as a single HTML file with these sections:

### 1. HERO
- Full-width hero with headline, subheadline, CTA button
- Headline: "Perth's Premium Insulated Patio Builders" or similar
- CTA: "Get Your Free Quote" → scrolls to form or opens GHL form

### 2. SERVICES / WHAT WE DO
- Grid showing service offerings (insulated patios, carports, gables, freestanding, etc.)
- Icons or cards for each service type

### 3. WHY INSULATED
- Benefits section explaining why insulated panels are superior
- Key benefits: Cooler in summer, warmer in winter, quiet in rain, ready for lights/fans, adds home value
- Technical credibility without being overwhelming

### 4. ROOF STYLES
- Flat/Skillion, Gable, Flyover, Freestanding
- Visual cards or diagrams for each

### 5. PROJECT GALLERY
- Grid of completed project photos
- Before/after or showcase shots

### 6. COST ESTIMATOR
- Interactive calculator: size × style × type = price range
- Base rate ~$650/m² with multipliers for gable (1.25x), hip (1.35x), freestanding (1.15x)
- Shows range (±15%) rounded to nearest $500
- CTA after result: "Get Your Exact Quote"

### 7. OUR PROCESS / HOW IT WORKS
- Timeline: Consultation → Design → Quote → Approval → Build → Enjoy
- Timeframe note: 6-10 weeks from first call to completion

### 8. FAQ
- Accordion-style FAQ section
- Common questions about insulated patios, council approval, pricing, etc.

### 9. LEAD CAPTURE FORM
- GHL embedded form
- Fields: Full Name, Phone, Suburb, Project Type (dropdown), Timeframe (dropdown)
- Form styling should match brand colours

### 10. FOOTER
- Contact details, service areas, social links
- "Fully Licensed | Engineering Certified | Quality Guaranteed"

---

## TECHNICAL NOTES

### Form Integration
- Lead capture form is a GoHighLevel (GHL) embedded form
- GHL forms render inside iframes
- Custom CSS in GHL form builder Advanced tab applies inside the iframe
- GHL class names may change — inspect element to find current selectors
- Form fields per spec: Full Name, Phone, Suburb, Project Type dropdown, Timeframe dropdown

### JavaScript Features
- Scroll-triggered animations
- FAQ accordion (click to expand/collapse)
- Cost estimator calculator
- Smooth scroll for anchor links
- Sticky/floating CTA button that appears on scroll (after 600px)

### Responsive
- Must work on mobile (most traffic will be mobile from Google Ads / social)
- iPad-friendly for sales reps showing clients

---

## CONTENT / COPY TONE

### Voice Guidelines
- Speak to homeowners directly ("you" / "your")
- Confident but not arrogant
- Plain English — no jargon unless explaining technical benefits
- Quality you can see, not a brand tax
- Local references welcome (Perth weather, WA lifestyle)
- Not salesy — educational and reassuring

### Key Messages
1. An insulated patio is genuine living space, not just a shade structure
2. SolarSpan panels = roof + ceiling + insulation in one
3. Spans up to 8+ metres without posts in the way
4. Perth summers are brutal — insulation makes the difference
5. We handle everything: design, engineering, council, build
6. Same team for patios + fencing = one project, one contact

### Competitor Differentiation
- vs Stratco Outback: We're not a kit — every patio is custom designed
- vs cheap patio builders: Engineering-certified, proper footings, premium materials
- vs architect/builder: Specialist focus = faster, more efficient, better value

---

## SUPPLIERS (for technical accuracy)

| Supplier | Products | Notes |
|----------|----------|-------|
| Bondor | SolarSpan insulated panels | Our hero product. 50mm, 75mm, 100mm thickness |
| Metroll | SpanPlus 330, CDek, steel | Powdercoated both sides |
| CMI | Steel, fabrication, flashings | Fastest turnaround |
| Stratco | Patio systems (Outback range) | Competitor product but we also source from them |
| JBS Patios | Custom fabrication (trusses) | Malaga |

---

## TECHNICAL SPECS (for cost estimator accuracy and content)

### Panel Thickness Guide
| Thickness | R-Value | Best For |
|-----------|---------|----------|
| 50mm | R1.2 | Standard patios, carports |
| 75mm | R1.8 | Larger spans, better insulation |
| 100mm | R2.4 | Maximum comfort, longest spans |

### Roof Styles
- **Flat/Skillion:** Clean modern lines. Attaches to fascia, slopes away from house. Most popular.
- **Gable:** Traditional peaked roof. Adds height, hot air escapes through ridge. Suits federation homes.
- **Flyover/Raised Skillion:** Roof sits above existing roofline. Open, airy feel. Great for breezes.
- **Freestanding:** Standalone — poolside pavilions, outdoor kitchens, separate entertaining zones.

### Attachment Methods
- Fascia beam (riser brackets)
- Receiving channel to fascia
- Receiving channel to wall
- Flyover brackets
- Freestanding (posts all sides)

### Standard Dimensions
- Post sizes: 90x90, 100x100, 125x125mm SHS
- Beam spans (N2): 150x50x2mm up to 4.9m, 150x50x3mm up to 5.6m
- Footings: 400x400x500mm standard, larger for long spans
- Minimum pitch: 2° for Trimdek/SolarSpan, 5° for Corrugated

---

## COLORBOND COLOURS (for any colour selector/swatch displays)

### Popular Roof/Ceiling Colours
Surfmist, Classic Cream, Paperbark, Shale Grey, Dune, Basalt, Woodland Grey, Monument, Night Sky

### Ceiling Options
- Plain (smooth modern finish)
- V-Line (grooved panel look)
- Cedar Look (timber aesthetic without maintenance)

---

## FILE STRUCTURE

```
secureworks-site/
├── CLAUDE.md          (this file — project context)
├── index.html         (main landing page)
├── assets/
│   ├── secureworks-logo.png
│   ├── secureworks-logo-white.png
│   ├── secureworks-icon.png
│   └── photos/        (project photos)
└── css/               (if splitting out styles)
```

---

## WHAT NEEDS DOING (Current Priority List)

1. **GHL form styling** — form CSS not applying correctly, needs brand colours
2. **Mobile responsiveness** — check all sections work on phone
3. **Photo integration** — replace placeholders with real project photos
4. **Cost estimator refinement** — rates and multipliers may need adjusting
5. **SEO basics** — meta tags, title, description for "insulated patios Perth"
6. **Performance** — optimise images, lazy loading

---

## IMPORTANT NOTES FOR AI

- This is a Perth, Western Australia business — all references should be WA-specific
- Building codes: National Construction Code (NCC), AS/NZS standards
- Wind region: N2 standard suburban, N3 coastal
- Climate: Hot dry summers, mild wet winters — insulation messaging should emphasise summer heat
- The founder (Marnin) is not a developer — keep code clean and well-commented
- Single HTML file approach is preferred for simplicity unless there's a good reason to split

---

## DESIGN PHILOSOPHY — "ARCHITECTURAL ASSURANCE"

<secureworks_design_philosophy>
When creating any visual collateral (lookbooks, brochures, guides, PDFs), follow the Architectural Assurance philosophy. This is NOT optional — it defines how SecureWorks design should look and feel.

### Core Principles
- **Space is the primary material.** Generous voids create gravitational pull toward information. Dense zones of photography and dark-toned colour blocks establish visual weight and monumentality.
- **Asymmetric monumentality.** Elements are displaced — a large photographic mass in the upper third while information cascades asymmetrically below; a vertical colour band anchoring the left edge while content breathes rightward.
- **Colour is emotional architecture.** Deep blue-blacks form structural walls — stable, trustworthy. Against these, orange burns like fired steel: hot, purposeful, used with surgical economy. Warm neutrals create breathing rooms. Each hue is load-bearing, not decorative. **One orange element per view** — if the CTA is orange, the stat number isn't.
- **Typography at extreme scales.** Oversized numerals and bold condensed headlines create impact, while small uppercase labels with generous tracking provide systematic precision. Size jumps of 3x+ (not 1.5x), weight extremes of 400 vs 800/900 only.
- **Nothing shouts, nothing begs.** Photography is used boldly: full-bleed, overlaid with translucent colour fields, masked into geometric forms via clip-path. Text never explains what the eye already understands from spatial arrangement.

### Colour Families (use tonal steps, not flat fills)
- **Orange:** 900 #C4481F (hover) → 700 #F15A29 (base) → 500 #F4845F → 300 #FADDD2 → 100 #FDF2EE
- **Blue:** 950 #1A272E (immersive) → 800 #293C46 (base) → 600 #4C6A7C → 400 #8FA4B2 → 200 #D4DEE4 → 100 #EDF1F4
- **Warm:** 300 #E8E4DF → 200 #F0ECE8 → 100 #F8F6F3 (base) → 50 #FCFBFA
- Use --blue-950 for immersive/hero backgrounds (not base --dark-blue)
- Use --warm-50 instead of pure #FFFFFF for warmer premium ground
- Use --orange-100 for tinted surfaces (not orange at low opacity)

### Opacity Scale (fixed values, never arbitrary)
- 0.85 (body text on dark) | 0.55 (labels on dark) | 0.25 (watermarks) | 0.08 (dividers on dark) | 0.04 (card surfaces on dark)

### Edge Philosophy
- **Default: sharp edges (0px radius).** Not 6px, not 8px, not 12px.
- Only rounded: inputs/buttons (3px), tag pills (100px full pill)
- Photos: always sharp unless clip-path masked
- Cards: sharp edges — border or shadow provides container, not radius

### Shadows (blue-toned, never black)
- Lift: `0 1px 3px rgba(41,60,70,0.08)` | Rise: `0 4px 12px rgba(41,60,70,0.10)`
- Shadows are RARE. Most elements are flat. On dark backgrounds, use surface tints instead.

### Atmosphere
- Grain overlay (0.03 opacity, mix-blend-mode: overlay) on dark sections
- Surface gradients stay within SAME colour family (dark→darker, warm→warmer)
- Never gradient between different palette colours (no orange-to-blue)
- Photo overlays use --blue-950 base, never pure black

### Design Rules (Mandatory)
- Use CSS Grid with named `grid-template-areas` for editorial layouts — NOT Flexbox for page composition
- Use `clip-path` and `mask-image` for geometric photo crops — no need for Photoshop
- Use `mix-blend-mode` for colour overlays on photography
- Full-bleed images: `margin: -Xmm -Ymm; width: calc(100% + 2*Ymm);` to pull to page edges
- All brand values via CSS custom properties (`:root` variables) — never hardcode
- Print viewport: 794x1123 at deviceScaleFactor 2 for AI review screenshots (PNG only, never JPEG)
- Full design system with all tokens, families, and interaction rules in SECUREWORKS-DESIGN-BRIEF.md

### NEVER Do These (AI Slop Indicators)
- Symmetric card grids with equal spacing
- Predictable 3-column equal-width layouts
- Tables that look like Word documents
- Rounded corners on everything (default is SHARP)
- Generic hero + 3 feature cards + CTA pattern
- Evenly distributed colour palettes
- "Comfortable" middle-ground whitespace — commit to generous voids OR controlled density
- Arbitrary opacity values — use the fixed scale
- Pure black shadows — always blue-toned
- Multiple orange elements competing on the same view

### INSTEAD Do These (Agency-Level Indicators)
- Asymmetric column widths, off-centre elements, intentional imbalance
- Full-bleed photography masked into geometric forms
- Colour blocking with dark blue masses and surgical orange accents
- Grid-breaking elements that span unexpected areas
- Atmospheric backgrounds: grain overlays, gradient depth, translucent colour fields
- Editorial typography with extreme scale contrast
- Whitespace as a deliberate design element, not leftover space
- Colour family tonal steps for depth (not flat hex fills)
- Sharp edges with intentional geometry (not default border-radius)
</secureworks_design_philosophy>

---

## DESIGN REVIEW PROTOCOL

When building or reviewing visual collateral, score each dimension 1-5:

1. **Layout & Composition** — visual balance, grid, content hierarchy
2. **Whitespace** — breathing room, margins, padding consistency
3. **Typography Hierarchy** — heading/body distinction, sizing, line lengths (45-75 chars)
4. **Alignment** — grid snapping, gutters, consistent offsets
5. **Colour Consistency** — brand colours correct, no clashing, orange used sparingly
6. **Photo Placement** — sized well, positioned well, masked geometrically where appropriate
7. **Visual Flow** — eye follows intended path through the page
8. **Professional Polish** — no orphans, no broken elements, no placeholders
9. **Print Readiness** — margins, text safety zones, image quality
10. **Brand Compliance** — colours, fonts, tone match Architectural Assurance

**Target: 8+/10 average.** If below 7 on any dimension, fix before presenting.

### Screenshot Settings for AI Review
- Viewport: 794x1123 (A4 portrait)
- deviceScaleFactor: 2 (output: 1588x2246)
- Format: PNG only (JPEG artifacts hurt text analysis)
- Review pages individually, not full-document screenshots
- Always compare against a reference image when available
