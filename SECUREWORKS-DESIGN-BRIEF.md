# SecureWorks Group — Master Design Brief

**Movement:** Architectural Assurance
**Version:** 1.0 — March 2026
**Governs:** All visual output — websites, lookbooks, brochures, guides, social, signage, apparel, vehicle wraps

This document is the single source of truth for how SecureWorks looks. Every piece of collateral must be traceable back to the principles in this brief. When in doubt, refer here. When building with AI tools (Claude Code, etc.), feed this document as context.

---

## 1. The Philosophy — Architectural Assurance

Architectural Assurance finds its foundation in the visual language of built environments — the confidence that emerges when structure meets warmth, when engineered precision dissolves into the comfort of lived space.

Every composition is an act of spatial choreography: bold masses of colour and photography anchor the eye, while fine typographic details whisper authority through restraint. The result is work that feels inevitable — as though no other arrangement could exist.

### The Five Laws

**I. Space is the primary material.**
Generous voids create gravitational pull toward information. Dense zones of photographic imagery and dark-toned colour blocks establish visual weight and monumentality. The interplay between full-bleed photographic warmth and sharp geometric fields creates a rhythm that feels both editorial and architectural — magazine meets blueprint.

**II. Colour is emotional architecture.**
Deep blue-blacks form structural walls — stable, trustworthy, immovable. Against these masses, a single chromatic accent burns like fired steel: hot, purposeful, used with surgical economy. Warm neutrals — the colour of sandstone and rendered walls in afternoon light — create breathing rooms between structural elements. This palette is never decorative; it is load-bearing.

**III. Typography operates at extreme scales.**
Oversized numerals and bold condensed headlines create immediate impact, while small uppercase labels with generous tracking provide systematic precision. Every letterform is placed with painstaking attention, every counter-space considered, every baseline alignment the mark of master-level execution.

**IV. Composition follows asymmetric monumentality.**
Elements are displaced — a large photographic mass occupying the upper third while information cascades asymmetrically below; a vertical colour band anchoring the left edge while content breathes rightward. Information hierarchies are expressed spatially rather than through decoration: what matters most occupies the most space, what is secondary contracts to elegant density. This is not minimalism — it is maximalism distilled.

**V. Nothing shouts, nothing begs.**
Photography is used boldly: full-bleed, overlaid with translucent colour fields, masked into geometric forms. Text never explains what the eye already understands from spatial arrangement. Numbers are monumental, labels are clinical, body text is rare and precious. The work announces quiet authority — the visual equivalent of a firm handshake and steady eye contact.

---

## 2. Brand Identity

### 2.1 Logo Suite

| Variant | File | Use Case |
|---------|------|----------|
| **Primary (Full)** | `SecureWorks Main.svg/pdf/png` | Light backgrounds, hero sections, documents |
| **White 1** | `SecureWorks White 1.svg/pdf/png` | Dark blue backgrounds, photo overlays |
| **White 2** | `SecureWorks White 2.svg/pdf/png` | Very dark/photo backgrounds |
| **Group (Full)** | `SecureWorks Group Main.svg` | When representing the parent company |
| **Group (White)** | `SecureWorks Group White.svg` | Group logo on dark backgrounds |
| **Icon (Main)** | `SecureWorks Icon Main.svg/pdf/png` | Favicons, small spaces, app icons |
| **Icon (White 1)** | `SecureWorks Icon White 1.svg/pdf/png` | Icons on dark backgrounds |
| **Icon (White 2)** | `SecureWorks Icon White 2.svg/pdf/png` | Icons on very dark/photo backgrounds |

**Logo anatomy:** House icon (Dark Dusty Blue) + orange underline accent + "SecureWorks" (dark blue italic bold) + "WA" or "Group" (lighter weight)

**Logo rules:**
- Minimum clear space: 1x the height of the icon on all sides
- Never rotate, stretch, recolour, or add effects
- Never place on busy photo backgrounds without overlay/container
- Minimum size: icon 16px digital / 8mm print; full logo 80px digital / 25mm print

### 2.2 Colour System

#### Primary Palette (Anchor Colours)

| Role | Name | HEX | RGB | CMYK | CSS Variable |
|------|------|-----|-----|------|-------------|
| **Accent** | SecureWorks Orange | `#F15A29` | 241, 90, 41 | 0, 60, 95, 0 | `--orange` |
| **Structure** | Dark Dusty Blue | `#293C46` | 41, 60, 70 | 83, 64, 53, 46 | `--dark-blue` |
| **Support** | Mid Dusty Blue | `#4C6A7C` | 76, 106, 124 | 75, 50, 39, 13 | `--mid-blue` |
| **Ground** | White | `#FFFFFF` | 255, 255, 255 | 0, 0, 0, 0 | `--white` |
| **Warmth** | Warm Grey | `#F8F6F3` | 248, 246, 243 | 2, 2, 3, 0 | `--warm-grey` |
| **Text** | Body Text | `#323232` | 50, 50, 50 | 0, 0, 0, 80 | `--body-text` |
| **Wayfinding** | Tab Brown | `#8B6F47` | 139, 111, 71 | 0, 20, 49, 45 | `--tab-brown` |

#### Colour Families (Tonal Scales)

Each anchor colour has a **family of 5 tonal steps** — from deep/saturated to barely-there. These are NOT arbitrary shades; each step has a specific role. The family creates depth, atmosphere, and hierarchy within a single hue.

**Orange Family — "Fired Steel"**

| Step | Name | HEX | CSS Variable | Role |
|------|------|-----|-------------|------|
| 900 | Ember | `#C4481F` | `--orange-900` | Hover states, pressed buttons, dark-bg accent lines |
| 700 | Fired Steel | `#F15A29` | `--orange` (base) | Primary accent — CTAs, tag pills, accent lines |
| 500 | Warm Glow | `#F4845F` | `--orange-500` | Secondary accent — icon fills, chart highlights |
| 300 | Blush | `#FADDD2` | `--orange-300` | Tinted backgrounds, alert surfaces, soft emphasis |
| 100 | Heat Haze | `#FDF2EE` | `--orange-100` | Barely-there wash — hover backgrounds, warm panels |

**Dark Blue Family — "Structural Walls"**

| Step | Name | HEX | CSS Variable | Role |
|------|------|-----|-------------|------|
| 950 | Midnight Structure | `#1A272E` | `--blue-950` | Immersive backgrounds, hero overlays, near-black |
| 800 | Deep Wall | `#293C46` | `--dark-blue` (base) | Headings, dark sections, primary structure |
| 600 | Threshold | `#4C6A7C` | `--mid-blue` (base) | Secondary text, borders, captions |
| 400 | Haze | `#8FA4B2` | `--blue-400` | Disabled states, placeholder text, subtle borders |
| 200 | Mist | `#D4DEE4` | `--blue-200` | Divider lines, table borders, subtle separators |
| 100 | Frost | `#EDF1F4` | `--blue-100` | Alternating row backgrounds, subtle surface shifts |

**Warm Grey Family — "Sandstone"**

| Step | Name | HEX | CSS Variable | Role |
|------|------|-----|-------------|------|
| 300 | Limestone | `#E8E4DF` | `--warm-300` | Borders on warm backgrounds, card outlines |
| 200 | Sandstone | `#F0ECE8` | `--warm-200` | Subtle surface distinction on warm-grey pages |
| 100 | Rendered Wall | `#F8F6F3` | `--warm-grey` (base) | Breathing-room backgrounds, alternating sections |
| 50 | Afternoon Light | `#FCFBFA` | `--warm-50` | Near-white with warmth — softer than pure #FFF |

#### Colour Usage Rules

**Orange (#F15A29) — "Fired Steel"**
- Used with surgical economy — accent only, never dominant
- **One orange element per view.** If the CTA button is orange, the stat number isn't. If the accent line is orange, the tag pill uses outline variant instead. The eye should never have to choose between competing orange elements.
- Correct: thin accent lines (3px), CTA buttons, single tag pill, section markers, one stat number per spread
- Wrong: large background fills, full-width banners, multiple orange elements competing, orange text on light backgrounds (use dark blue instead)
- Ratio guideline: orange should occupy no more than ~5-8% of any composition
- **Hover/active:** Use `--orange-900` (#C4481F), never darken with black overlay
- **Tinted surfaces:** Use `--orange-100` (#FDF2EE), never orange at low opacity on white

**Dark Dusty Blue (#293C46) — "Structural Walls"**
- The dominant dark colour — used for headings, dark backgrounds, colour blocks
- Creates visual weight and monumentality
- **Never use pure black (#000000)** — always Dark Blue family for dark elements
- For immersive hero sections, use `--blue-950` (#1A272E) not the base
- For softer dark sections (less drama), use base `--dark-blue` (#293C46)

**Mid Dusty Blue (#4C6A7C) — "Threshold"**
- Secondary text, labels, borders, captions, supporting elements
- The transitional colour between structural dark and breathing-room light
- Use `--blue-400` (#8FA4B2) for truly de-emphasised elements (placeholders, disabled)
- Use `--blue-200` (#D4DEE4) for structural lines (dividers, table rules, separators)

**Warm Grey (#F8F6F3) — "Sandstone"**
- Breathing room between structural elements
- Alternative to white for softer page backgrounds
- The colour of rendered walls in afternoon Perth light
- Use `--warm-50` (#FCFBFA) instead of pure white for a warmer, more premium ground
- Use `--warm-300` (#E8E4DF) for borders/outlines on warm surfaces

**Forbidden Colours:**
- Pure black (#000000) — use `--blue-950` or `--dark-blue`
- Generic greys (#888, #999, #ccc, #eee) — use blue-toned family equivalents
- Any other brand colours — the palette is closed
- Never mix warm grey family with cool blue family in the same surface (e.g., a warm grey card with a blue-200 border — pick one temperature)

#### Colour-on-Colour Interaction Rules

Not every colour can sit on every other colour. These rules prevent muddy, low-contrast, or clashing combinations.

**On Dark Blue / Blue-950 backgrounds:**
| Element | Colour | Notes |
|---------|--------|-------|
| Headlines | `#FFFFFF` | Full white, never off-white |
| Body text | `rgba(255,255,255,0.85)` | Slightly softened for reading comfort |
| Labels | `rgba(255,255,255,0.55)` | Whispered, not shouted |
| Accent | `--orange` base | Full saturation on dark — it earns its heat |
| Borders/dividers | `rgba(255,255,255,0.08)` | Barely visible structural lines |
| Cards/surfaces | `rgba(255,255,255,0.04)` | Subtle lift, not floating panels |

**On White / Warm-50 backgrounds:**
| Element | Colour | Notes |
|---------|--------|-------|
| Headlines | `--dark-blue` | Never body-text colour for headings |
| Body text | `--body-text` (#323232) | Warm dark, never pure black |
| Labels | `--orange` or `--mid-blue` | Orange for primary sections, mid-blue for secondary |
| Borders | `--blue-200` (#D4DEE4) | Or `--warm-300` if on warm-grey surface |
| Accent lines | `--orange` | 3px, 40px wide |

**On Warm Grey backgrounds:**
| Element | Colour | Notes |
|---------|--------|-------|
| Headlines | `--dark-blue` | Same as white |
| Body text | `--body-text` | Same as white |
| Cards | `#FFFFFF` | White cards on warm grey create gentle lift |
| Borders | `--warm-300` (#E8E4DF) | Stay in the warm family |
| Never | `--blue-200` for borders | Warm surface + cool border = temperature clash |

**On Photography:**
| Element | Colour | Notes |
|---------|--------|-------|
| Headlines | `#FFFFFF` | Always full white over photo overlays |
| Body text | `rgba(255,255,255,0.9)` | Slightly softened |
| Overlay | `rgba(41,60,70,0.88)` minimum | Text requires this contrast ratio |
| Never | Orange text on photos | Insufficient contrast, visually chaotic |

### 2.3 Opacity & Transparency System

Opacity is not a shortcut — it's a design tool with specific values for specific purposes. Never use arbitrary opacity values.

| Token | Value | CSS Variable | Use |
|-------|-------|-------------|-----|
| **Solid** | 1.0 | — | Headlines, primary CTAs, brand orange |
| **Prominent** | 0.85 | `--opacity-prominent` | Body text on dark backgrounds |
| **Secondary** | 0.55 | `--opacity-secondary` | Labels, captions on dark backgrounds |
| **Subtle** | 0.25 | `--opacity-subtle` | Watermarks, background numbers, decorative elements |
| **Ghost** | 0.08 | `--opacity-ghost` | Divider lines on dark, surface tints, structural hints |
| **Whisper** | 0.04 | `--opacity-whisper` | Card surfaces on dark, barely-there panels |

**Rules:**
- Never use opacity on `--orange` to create a "light orange" — use the orange family steps instead
- Never use opacity to create greys — use the blue family steps
- Opacity is for *layering* (text on backgrounds, overlays on photos), not for creating new colours
- On dark backgrounds, white at `--opacity-ghost` (0.08) is the standard divider/border colour

### 2.4 Shadow & Elevation System

Shadows create hierarchy and depth. Like everything else, they're blue-toned, never grey or black.

| Level | Name | CSS | Use |
|-------|------|-----|-----|
| 0 | Flat | `none` | Default — most elements have no shadow |
| 1 | Lift | `0 1px 3px rgba(41,60,70,0.08)` | Cards, subtle hover states |
| 2 | Rise | `0 4px 12px rgba(41,60,70,0.10)` | Dropdown menus, popovers, active cards |
| 3 | Float | `0 8px 30px rgba(41,60,70,0.14)` | Modals, image galleries, overlaid panels |
| 4 | Monument | `0 16px 60px rgba(41,60,70,0.20)` | Page presentation on dark background (the design brief itself) |

**Rules:**
- Shadow colour is ALWAYS based on `--dark-blue` (41,60,70), never black (0,0,0)
- Shadows are **rare** — most elements are flat. Overuse destroys the premium feel.
- On dark backgrounds, shadows are invisible and unnecessary. Use `--opacity-whisper` surfaces instead.
- Never combine shadow with border on the same element — choose one elevation method

### 2.5 Gradient System

Gradients are atmospheric, not decorative. They create mood and depth within surfaces.

#### Surface Gradients (within a colour family)

| Name | CSS | Use |
|------|-----|-----|
| **Deep Immersion** | `linear-gradient(180deg, #1A272E 0%, #293C46 100%)` | Hero dark sections — adds depth without new colours |
| **Warm Shift** | `linear-gradient(180deg, #F8F6F3 0%, #FFFFFF 100%)` | Warm-to-white transition — avoids hard colour breaks |
| **Steel Surface** | `linear-gradient(160deg, #293C46 0%, #3A5060 60%, #293C46 100%)` | Metallic feel on dark sections — like brushed steel |

#### Photo Overlays

| Name | CSS | Use |
|------|-----|-----|
| **Bottom Anchor** | `linear-gradient(to bottom, transparent 0%, rgba(26,39,46,0.85) 100%)` | Text at bottom of photo |
| **Full Veil** | `linear-gradient(to bottom, rgba(26,39,46,0.5) 0%, rgba(26,39,46,0.3) 40%, rgba(26,39,46,0.7) 100%)` | Text at top and bottom of photo |
| **Warm Cast** | `linear-gradient(135deg, rgba(241,90,41,0.06) 0%, transparent 50%)` | Subtle warmth on cool photos |
| **Directional Drama** | `linear-gradient(135deg, rgba(26,39,46,0.9) 0%, transparent 70%)` | Text on one side, photo visible on other |

**Rules:**
- **Never** gradient between two different palette colours (e.g., orange to blue) — that's a nightclub, not a brand
- Surface gradients stay within the SAME colour family (dark-to-darker, warm-to-warmer)
- Photo overlays use `--blue-950` base (26,39,46), not pure black
- Maximum two gradient stops for surface gradients. Three for photo overlays.

### 2.6 Texture & Atmosphere

Premium surfaces have materiality — they feel like real materials, not flat CSS fills.

#### Grain Overlay
A subtle noise texture on dark backgrounds creates a tactile, printed quality that separates premium from generic.

```css
.grain::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat: repeat;
  pointer-events: none;
  mix-blend-mode: overlay;
}
```

- Apply to: dark blue sections, hero overlays, immersive backgrounds
- Never apply to: white surfaces, warm grey surfaces, photographs
- Opacity: 0.03 on screen, 0 for print (grain doesn't survive print reproduction)

#### Material Metaphors

The brand draws from construction materials. These metaphors guide surface treatment:

| Material | Visual Treatment | Where Used |
|----------|-----------------|-----------|
| **Brushed Steel** | Subtle directional gradient on dark blue, grain overlay | Hero sections, footer, immersive backgrounds |
| **Rendered Concrete** | Warm grey with barely-visible texture | Content backgrounds, breathing-room sections |
| **Glass** | `backdrop-filter: blur(20px)` + white at 0.06 opacity | Overlaid info panels on photos (digital only) |
| **Timber** | Photo-sampled warm tones, never synthetic wood texture | Photography colour grading, warm accent surfaces |

### 2.7 Edge & Border System

Edges define the character of an interface. SecureWorks uses deliberate geometry, not default softness.

#### Border Radius

| Token | Value | CSS Variable | Use |
|-------|-------|-------------|-----|
| **Sharp** | 0px | `--radius-sharp` | Default — most elements. Cards, containers, sections, images |
| **Eased** | 3px | `--radius-eased` | Input fields, small interactive elements, buttons |
| **Pill** | 100px | `--radius-pill` | Tag pills only — a specific component, not a general shape |

**Rules:**
- **Default is sharp (0px).** Rounded corners are the exception, not the rule.
- Never use 6px, 8px, 12px, 16px — these are the hallmark of generic UI kits
- The only rounded elements are: input fields (3px), buttons (3px), and tag pills (100px full pill)
- Photos: always sharp edges unless using `clip-path` for geometric masks
- Cards: sharp edges. The border or shadow provides the container definition, not the radius.

#### Border Weights

| Weight | Use | Colour |
|--------|-----|--------|
| 1px | Standard borders — cards, table rules, dividers | `--blue-200` or `--warm-300` |
| 2px | Emphasis borders — highlighted cards, active states | `--orange` or `--dark-blue` |
| 3px | Accent lines — section labels, left-border callouts | `--orange` only |
| 4px | Heavy accent — section dividers, structural markers | `--dark-blue` only |

### 2.8 Motion & Animation Principles (Digital Only)

Motion is choreography, not decoration. One orchestrated sequence creates more impact than scattered micro-interactions.

#### Page Load Sequence
```
0ms    — Page background renders (instant)
100ms  — Hero image fades in (opacity 0→1, 600ms ease)
400ms  — Headline slides up (translateY 20px→0, opacity 0→1, 500ms ease-out)
600ms  — Subheadline and accent line (same motion, staggered)
800ms  — CTA button (same motion, staggered)
```
Total sequence: ~1.3 seconds. Everything settles, nothing bounces.

#### Scroll-Triggered Reveals
- Elements fade in from `opacity: 0; translateY: 16px` to `opacity: 1; translateY: 0`
- Duration: 500ms, `ease-out` timing
- Trigger: when element enters viewport (IntersectionObserver, threshold 0.15)
- **Never** slide from left/right — vertical motion only (gravity, not wind)
- **Never** scale/zoom — we're not a tech startup

#### Hover States
- Buttons: background darkens to `--orange-900`, transition 200ms
- Cards: shadow elevates from Level 0 to Level 1, transition 250ms
- Links: underline appears via `scaleX(0)` to `scaleX(1)`, transition 200ms
- **Never** colour-shift, rotate, scale, or wobble on hover

#### Easing
- Use `cubic-bezier(0.25, 0.1, 0.25, 1.0)` (standard ease) for entrances
- Use `cubic-bezier(0.0, 0.0, 0.2, 1.0)` (ease-out) for settlements
- **Never** use `linear`, `ease-in-out`, or spring/bounce physics

### 2.9 Photography Colour Grading

All project photography should be graded to a consistent temperature that matches the brand palette. This creates the feeling that the brand and the photography were born from the same visual DNA.

#### Target Grade
- **Temperature:** Warm — shift toward golden/amber, away from cool blue daylight
- **Shadows:** Lift slightly, tint toward dark blue (#293C46) — never pure black shadows
- **Highlights:** Preserve warmth, never blown out — creamy, not clinical
- **Saturation:** Slightly reduced globally, selectively boosted in warm tones (wood, skin, sunset)
- **Contrast:** Medium-high — architectural clarity without harshness

#### Reference Lighting
- **Ideal:** Golden hour (last 90 minutes before sunset) — Perth faces west, golden hour is dramatic
- **Acceptable:** Overcast (soft, even) with warmth added in post
- **Avoid:** Harsh midday sun (creates unflattering shadows on structures)
- **Night:** Warm tungsten lighting on patio, cool blue twilight sky — the contrast IS the brand

#### Consistency Test
Take any two SecureWorks photos, place them side by side at equal size. They should look like they were shot on the same day, in the same light, by the same photographer. If one feels cool/clinical and the other warm/golden, the grading is inconsistent.

#### Overlay Colours (Photography)

| Overlay | CSS | Use |
|---------|-----|-----|
| Brand dark | `rgba(41, 60, 70, 0.88)` | Text over photos — high readability |
| Gradient bottom | `linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.65) 100%)` | Text anchored at bottom of photo |
| Gradient full | `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.1) 40%, rgba(0,0,0,0.55) 100%)` | Full photo with text at top and bottom |
| Warm tint | `linear-gradient(135deg, rgba(241,90,41,0.08), transparent 60%)` with `mix-blend-mode: overlay` | Subtle warm cast on photos |
| Blue multiply | `var(--dark-blue)` at `opacity: 0.15` with `mix-blend-mode: multiply` | Cool editorial tone on photos |

### 2.3 Typography

#### Font Stack
```
Primary: 'Helvetica Neue', Helvetica, Arial, sans-serif
Condensed: 'HelveticaNeue-CondensedBold', 'Helvetica Neue', Helvetica, Arial, sans-serif
```

#### Type Scale

| Level | Size | Weight | Tracking | Line Height | Use |
|-------|------|--------|----------|-------------|-----|
| **Mega** | 72pt | 900 | -2px | 0.88 | Cover headlines, section openers, monumental statements |
| **Divider** | 48pt | 900 | tight | 0.95 | Section divider pages, chapter titles |
| **H1** | 28pt | 800 | -0.3px | 1.05 | Page headlines |
| **H2** | 18pt | 700 | normal | 1.15 | Section subheadings |
| **H3** | 14pt | 700 | 0.5px | 1.2 | Card titles, list headers |
| **Body** | 11pt | 400 | normal | 1.7 | Paragraphs, descriptions |
| **Caption** | 9pt | 400 | normal | 1.4 | Photo captions, fine detail |
| **Label** | 9pt | 700 | 2.5px | 1.2 | Section labels, category tags — ALWAYS UPPERCASE |
| **Fine** | 8pt | 400 (italic) | normal | 1.3 | Legal, disclaimers, footnotes |

#### Typography Rules

1. **Scale jumps must be dramatic.** The gap between H1 (28pt) and Mega (72pt) is 2.6x. The gap between Body (11pt) and H1 (28pt) is 2.5x. Never use timid increments like 12pt → 14pt → 16pt.
2. **Weight extremes, not weight middles.** Use 400 (regular) and 700-900 (bold/black). Never use 500 or 600 — they read as indecisive.
3. **Labels are sacred.** Always uppercase, always tracked out (letter-spacing: 2-3px), always 9pt, always 700 weight. They are the systematic precision that counterbalances the monumental headlines.
4. **No pure black text.** Body text is `#323232`. Headlines are `var(--dark-blue)`. On dark backgrounds, use white at 0.9 opacity for body, full white for headlines.
5. **Line lengths: 45-75 characters.** Shorter for print, can stretch to 75 for digital. Never wider.
6. **Condensed is for impact only.** HelveticaNeue-CondensedBold is reserved for Mega and Divider sizes. Never use condensed at body or caption sizes.

---

## 3. Photography

### 3.1 Photo Style

SecureWorks photography captures the warmth of outdoor living — late afternoon Perth light, golden hour tones, families and spaces in use. The camera is confident and still, never tilted or overly stylised.

**Hero shots:** Full-bleed, wide angle, environmental context visible (house, garden, sky). Always golden hour or blue hour light when possible. People optional but spaces should feel lived-in.

**Detail shots:** Tight crops on craftsmanship — clean welds, precise joins, quality hardware, ceiling panel patterns. These shots prove competence through visual evidence.

**Process shots:** Team on-site, installation in progress, engineering drawings. These build trust through transparency.

### 3.2 Photo Treatment

| Treatment | CSS Technique | When to Use |
|-----------|--------------|-------------|
| **Full bleed** | `background-size: cover; background-position: center;` on page div | Hero pages, section openers |
| **Geometric mask** | `clip-path: polygon(...)` | Breaking rectangular monotony, editorial flair |
| **Dark overlay** | `rgba(41,60,70,0.88)` positioned overlay | Text-heavy pages over photography |
| **Gradient overlay** | `linear-gradient(to bottom, ...)` | Anchoring text to bottom of photo |
| **Colour tint** | `mix-blend-mode: multiply/overlay` | Tonal cohesion across varied photo lighting |
| **Asymmetric crop** | CSS Grid with photo in oversized area | Editorial layouts, visual tension |

### 3.3 Photo Specifications

| Application | Resolution | Format | Colour Mode |
|-------------|-----------|--------|-------------|
| Digital lookbook/PDF | 150 DPI at display size | JPEG (photos), PNG (graphics) | sRGB |
| Commercial print (offset) | 300 DPI at print size | TIFF, PDF | CMYK |
| Website | 72-150 DPI, optimised | WebP/JPEG, max ~200KB | sRGB |
| Vehicle wraps | 100-150 DPI at full size | EPS, PDF, AI (vector preferred) | CMYK |
| Social media | 1080px minimum width | JPEG/PNG | sRGB |

---

## 4. Layout System

### 4.1 Page Architecture (Print — A4 Portrait)

```
Page: 210mm × 297mm
Bleed: 3mm all sides (final trim file: 216mm × 303mm)
Binding margin: 10mm (perfect bound)
Safe zone: 10mm from trim on all non-binding sides
Text safe: 20mm from binding edge, 10mm from other edges
```

#### Odd Pages (Right-hand) — Binding on LEFT
```
padding: 16mm 14mm 14mm 20mm (top right bottom left)
```

#### Even Pages (Left-hand) — Binding on RIGHT
```
padding: 16mm 20mm 14mm 14mm (top right bottom left)
```

### 4.2 Grid System

**Use CSS Grid with named template areas — NOT Flexbox for page composition.**

Flexbox is 1-dimensional and content-driven. Grid is 2-dimensional and structural — like an architect's blueprint. For editorial layouts where precise spatial control matters, Grid produces predictable, agency-level results.

#### Editorial Grid Templates

**Hero + Text (section opener):**
```css
.grid-editorial--hero-text {
  display: grid;
  grid-template-areas:
    "hero hero hero"
    ".    text sidebar";
  grid-template-columns: 1fr 2fr 1fr;
  grid-template-rows: 60% 1fr;
}
```

**Asymmetric Split (photo + content):**
```css
.grid-editorial--split-asymmetric {
  display: grid;
  grid-template-areas:
    "photo content content";
  grid-template-columns: 55% 1fr 1fr;
}
```

**Text + Photo (reverse layout):**
```css
.grid-editorial--text-photo {
  display: grid;
  grid-template-areas:
    "text text photo";
  grid-template-columns: 1fr 1fr 45%;
}
```

### 4.3 Spacing Scale

| Token | Value | Use |
|-------|-------|-----|
| `--space-xs` | 4px | Tight internal gaps |
| `--space-sm` | 8px | Between related items |
| `--space-md` | 16px | Standard padding, card internal |
| `--space-lg` | 24px | Between sections within a page |
| `--space-xl` | 40px | Major section breaks |
| `--space-2xl` | 60px | Monumental breathing room |

**Spacing philosophy:** Commit to generous voids OR controlled density. Never the comfortable middle ground. If a section has lots of content, pack it tight with precision. If a section has a hero statement, surround it with emptiness.

---

## 5. Components

### 5.1 Section Labels
```
INSULATED PATIOS          ← var(--orange), 9pt, 700, tracking 2.5px, uppercase
━━━━━━━━                  ← 40px × 3px orange accent line below
```
The systematic wayfinding element. Appears at the top of content sections. Always orange on light backgrounds, white (opacity 0.7) on dark backgrounds.

### 5.2 Tag Pills
```css
.tag {
  background: var(--orange);
  color: white;
  padding: 5px 14px;
  font-size: 9pt;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
}
```
Used sparingly for categorisation, key callouts, CTAs within content.

### 5.3 Stat Blocks
```
64pt                      ← Monumental number, condensed bold, orange or white
────
PROJECTS COMPLETED        ← Label underneath, 9pt, 700, tracked, mid-blue or white
```
Numbers are the architectural equivalent of a column — they anchor and give weight. Always use condensed bold at large scale.

### 5.4 Accent Lines
- Width: 40px
- Height: 3px
- Colour: `var(--orange)`
- Margin: 8px above, 14px below
- Purpose: Visual punctuation between label and content

### 5.5 Cards
```css
/* Standard card */
background: var(--white);
border: 1px solid #E8ECF0;
border-radius: 6px;      /* Note: 6px max — subtle, not bubbly */
padding: 16px;

/* Highlighted card */
border: 2px solid var(--orange);
/* with "Most Popular" or similar pill badge */
```

### 5.6 Tab Markers (Lookbook wayfinding)
Vertical colour bars on the page edge that indicate which section the reader is in.
- Width: 5mm
- Height: 22mm
- Positioned: absolute, on outer edge of page
- Colours: Orange (position 1), Mid Blue (position 2), Tab Brown (position 3)

---

## 6. Application Guidelines

### 6.1 Lookbooks & Brochures (Print PDF)

- Single HTML file, exported to PDF via headless Chrome + Paged.js
- Each page is a `<div class="page">` with fixed A4 dimensions
- Use `page-break-after: always` for pagination
- Paged.js polyfill adds: bleeds, crop marks, facing page support
- Photos: full-bleed hero pages alternating with structured content pages
- Variety: every spread should look visually DIFFERENT from the previous one
- Pace: photo-heavy → info-dense → photo-heavy → social proof → CTA

### 6.2 Websites & Landing Pages

- Same colour system, typography, and spacing tokens
- Responsive: mobile-first, tablet/iPad optimised (44px minimum touch targets)
- Animations: one orchestrated page-load reveal sequence with staggered delays — not scattered micro-interactions
- Dark sections: use `var(--dark-blue)` backgrounds, never pure black
- CTAs: orange buttons with white text, 700 weight, uppercase

### 6.3 Social Media

- Templates in Canva using Brand Kit (colours, fonts, logo)
- Photo-forward: let the work speak
- Text overlays: use Dark Dusty Blue semi-transparent bar with white text
- Keep to 2-3 elements per post maximum
- Orange accent sparingly — one element per post

### 6.4 Vehicle Wraps & Signage

- Vector formats: AI, EPS, SVG, PDF
- CMYK colour mode
- 150 DPI at full print size minimum
- 2-4 inch bleed on all sides
- Sans-serif only (Helvetica) — no scripts, no serifs
- Hierarchy: 1) Logo/name 2) What you do 3) Phone/website 4) Tagline
- Bold colour blocking, not photographic wraps
- Fleet consistency: same design across all vehicles

### 6.5 Apparel & Workwear

- Left chest: logo (above any reflective tape on hi-vis)
- Upper back: company name (visible when working)
- Sleeve: website or tagline (subtle)
- 1-2 colours for durability
- Match vehicle and signage colours
- Hi-vis: logos cannot cover required 0.4m² fluorescent area (AS 4602.1-2024)
- Embroidery for polos, screen print/heat transfer for hi-vis

### 6.6 Documents & Guides (Quote packages, council guides, etc.)

- Same Architectural Assurance philosophy — these are NOT Word documents
- Dark blue header bars, orange accent details
- Photography: at least one lifestyle hero image
- Stats and numbers: monumental treatment
- White space is confidence, not emptiness

---

## 7. AI Workflow Integration

### 7.1 CLAUDE.md Design Block

Include this in any project's CLAUDE.md where Claude Code builds visual output:

```xml
<secureworks_design_philosophy>
Follow the Architectural Assurance philosophy for all visual output.
- Space is the primary material — generous voids, not comfortable middles
- Colour is load-bearing — Dark Blue (#293C46) for structure, Orange (#F15A29) for surgical accent
- Typography at extreme scales — 3x+ size jumps, weight extremes (400 vs 800+)
- Asymmetric monumentality — displaced elements, not centred grids
- Nothing shouts — quiet authority, editorial confidence

NEVER: symmetric card grids, Word-doc tables, purple gradients, Inter/Roboto,
predictable layouts, rounded corners everywhere, evenly distributed colours

INSTEAD: asymmetric columns, full-bleed masked photography, colour blocking,
grid-breaking elements, atmospheric overlays, editorial typography, deliberate whitespace

CSS: Grid template areas (not Flexbox) for layouts, clip-path for photo masks,
mix-blend-mode for overlays, :root variables for all brand tokens
</secureworks_design_philosophy>
```

### 7.2 Design Review Rubric

Score each dimension 1-5. Target: 8+/10 average. Fix anything below 7.

1. **Layout & Composition** — visual balance, grid, content hierarchy
2. **Whitespace** — breathing room, margins, padding consistency
3. **Typography Hierarchy** — heading/body distinction, sizing, line lengths
4. **Alignment** — grid snapping, gutters, consistent offsets
5. **Colour Consistency** — brand colours correct, orange used sparingly
6. **Photo Placement** — sized well, masked geometrically where appropriate
7. **Visual Flow** — eye follows intended path through the page
8. **Professional Polish** — no orphans, broken elements, or placeholders
9. **Print Readiness** — margins, text safety zones, image resolution
10. **Brand Compliance** — colours, fonts, tone match Architectural Assurance

### 7.3 Screenshot Settings (AI Visual Review)

| Setting | Value | Why |
|---------|-------|-----|
| Viewport | 794 × 1123 | Matches A4 portrait in CSS pixels |
| Scale | 2x (deviceScaleFactor) | Output: 1588 × 2246 — Claude's sweet spot |
| Format | PNG only | JPEG artifacts hurt text analysis |
| Scope | One page at a time | Full-document screenshots are too small to analyse |
| Reference | Always provide alongside | Dramatically improves accuracy |

### 7.4 Installed Skills

- **Impeccable** (`.claude/skills/`) — 17 design commands: `/polish`, `/audit`, `/critique`, `/bolder`, `/distill`, `/colorize`, etc.
- **Frontend Design** (`.claude/skills/frontend-design/`) — core design vocabulary + 7 reference docs

---

## 8. File Organisation

### Logo Files
```
assets/logo/
├── svg/           ← Vector (scalable, web, design tools)
├── pdf/           ← Vector (print, InDesign, Illustrator)
├── png/           ← Raster @4x (presentations, documents)
└── SecureWorks WA Style Guide.pdf
```

### CSS Design Tokens (copy into any project)
```css
:root {
  /* ── Brand Colours (Anchor) ── */
  --orange: #F15A29;
  --dark-blue: #293C46;
  --mid-blue: #4C6A7C;
  --white: #FFFFFF;
  --warm-grey: #F8F6F3;
  --body-text: #323232;
  --tab-brown: #8B6F47;

  /* ── Orange Family ── */
  --orange-900: #C4481F;
  --orange-700: #F15A29; /* base */
  --orange-500: #F4845F;
  --orange-300: #FADDD2;
  --orange-100: #FDF2EE;

  /* ── Blue Family ── */
  --blue-950: #1A272E;
  --blue-800: #293C46; /* base = --dark-blue */
  --blue-600: #4C6A7C; /* base = --mid-blue */
  --blue-400: #8FA4B2;
  --blue-200: #D4DEE4;
  --blue-100: #EDF1F4;

  /* ── Warm Family ── */
  --warm-300: #E8E4DF;
  --warm-200: #F0ECE8;
  --warm-100: #F8F6F3; /* base = --warm-grey */
  --warm-50: #FCFBFA;

  /* ── Opacity Scale ── */
  --opacity-prominent: 0.85;
  --opacity-secondary: 0.55;
  --opacity-subtle: 0.25;
  --opacity-ghost: 0.08;
  --opacity-whisper: 0.04;

  /* ── Shadows ── */
  --shadow-lift: 0 1px 3px rgba(41,60,70,0.08);
  --shadow-rise: 0 4px 12px rgba(41,60,70,0.10);
  --shadow-float: 0 8px 30px rgba(41,60,70,0.14);
  --shadow-monument: 0 16px 60px rgba(41,60,70,0.20);

  /* ── Border Radius ── */
  --radius-sharp: 0px;
  --radius-eased: 3px;
  --radius-pill: 100px;

  /* ── Typography Scale ── */
  --font-mega: 72pt;
  --font-divider: 48pt;
  --font-h1: 28pt;
  --font-h2: 18pt;
  --font-h3: 14pt;
  --font-body: 11pt;
  --font-caption: 9pt;
  --font-label: 9pt;
  --font-fine: 8pt;

  /* ── Spacing ── */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 40px;
  --space-2xl: 60px;

  /* ── Motion ── */
  --ease-entrance: cubic-bezier(0.25, 0.1, 0.25, 1.0);
  --ease-settle: cubic-bezier(0.0, 0.0, 0.2, 1.0);
  --duration-fast: 200ms;
  --duration-normal: 500ms;
  --duration-slow: 800ms;

  /* ── Print ── */
  --page-w: 210mm;
  --page-h: 297mm;
  --bleed: 3mm;
  --bind: 10mm;
  --safe: 10mm;
}
```

---

## 9. What This Is NOT

This brief does not cover:
- **Copy/voice guidelines** — how SecureWorks writes (separate document)
- **Content strategy** — what to say and in what order (per-project)
- **Technical specifications** — engineering details, product specs
- **Pricing** — never design pricing into templates without approval

This brief covers HOW things look, not WHAT they say.

---

*Architectural Assurance is not a style — it is a structural commitment to visual confidence. Every piece of work that leaves this business should feel like the product of deep expertise, meticulously crafted, labored over with care that borders on obsession.*
