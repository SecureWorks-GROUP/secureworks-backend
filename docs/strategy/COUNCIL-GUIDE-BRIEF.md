# Council Approval Guide — Design Brief

## What We're Building

A **2-page A4 PDF** that goes inside patio quotes sent to homeowners in Perth, WA. It explains the council building permit process in a way that builds trust and supports conversion — NOT an educational document.

## Who It's For

- Homeowners considering an insulated patio
- They've already had a quote from SecureWorks Group
- This PDF is emailed alongside: reviews, a quote with diagram, and a small brochure
- They are NOT builders or council experts — plain English only

## The Sales Strategy (Critical)

This document must:
- **Reassure** — "we handle everything, you do nothing"
- **Speed** — emphasise how fast the process is (3-5 weeks total)
- **No surprises** — permit fees included in quote, no hidden costs
- **Downplay planning approval** — it's RARE, we design to avoid it
- **NOT scare clients** with long wait times or complex processes
- **Feel premium** — this company charges $15-30K for patios, the collateral should match

## Brand System

| Element | Value |
|---------|-------|
| Orange | #F15A29 |
| Dark Blue | #293C46 |
| Mid Blue | #4C6A7C |
| Warm Grey | #F8F6F3 |
| Font | Helvetica Neue family |
| Logo | SecureWorks Group (white version for dark backgrounds, main version for light) |
| Logos at | `assets/logo/svg/SecureWorks Group White.svg` and `SecureWorks Group Main.svg` |

## Content to Include

### Page 1 — The Hook + Process
- Hero: lifestyle photo of someone enjoying a patio (use `assets/photos-optimized/patio-lifestyle-golden.jpg`)
- Headline: "Your Patio Approval, Sorted."
- Stats strip: 2-3 wks most approvals | 100% managed by us | $0 extra for permit fees
- Quick intro paragraph: every patio needs a permit, but that's our job not yours
- 4-step process: Design finalised (1-2d) → Engineering (3-5d) → Council lodge (10-15d) → Permit + build (1-3d)
- Two info cards: Building Permit (required, we handle it) vs Planning Approval (RARE — we design around it)
- Boundary setbacks: 1.0m standard / 0.5m with neighbour letter / 0m with consent + roof clearance
- "We Handle Everything" banner with checklist

### Page 2 — Supporting Detail
- Timeline visualisation (quote to completion)
- Who handles what (paperwork checklist — almost all "we do this", only neighbour letter sometimes needs client)
- 4 FAQ items: Do I need to do anything? / Is permit fee extra? / What if property is tricky? / Can I start before permit?
- CTA: phone number 0450 580 065, email marnin@secureworkswa.com.au

## Photos Available (Safe to Use — Not in Other Brochures)
- `assets/photos-optimized/patio-lifestyle-golden.jpg` — Woman relaxing under patio, golden hour
- `assets/photos-optimized/patio-entertaining-sunset.jpg` — Family dinner under patio at sunset

## Photos NOT to Use (Already in Landing Pages/Brochures)
- `poolside-patio-luxury` — used in index.html, patio-general.html, fencing-site

## Design Direction

Previous HTML attempts scored 5.5-6/10. The feedback was:
- "Looks like a Word document with orange tables"
- "Basic and trash — no creative thought in the flow"
- "Nothing wow, nothing creative, no real visual hierarchy"
- Card grids and bullet lists are boring
- Needs to feel like it came from a design agency, not a developer

### What We Want
- Art-quality design, not a template
- Creative visual hierarchy — not just font sizes
- Photography used boldly (bleeds, overlays, masks)
- Dramatic typography contrast (weight mixing, scale)
- Asymmetric layouts, colour blocking
- Info should feel scannable yet premium
- Page 2 must look visually DIFFERENT from page 1 (different layout structure entirely)
- The kind of thing where someone opens the PDF and thinks "these guys are legit"

## Technical Requirements
- A4 portrait (210mm x 297mm)
- Print-ready with `@page` sizing and `print-color-adjust: exact`
- Single HTML file that can be printed/saved as PDF
- Dark `#1a1a1a` screen background (presentation mode, like the lookbook)
- Inline SVG logos (not image references)

## Reference
- The lookbook (`lookbook-v2.html`) is the closest thing to the quality level we want
- It uses warm grey backgrounds, editorial typography, photo spreads, and magazine-style layouts
- The lookbook's "Your Journey" section has a nice numbered grid timeline worth referencing

## Existing Attempt
- `council-approval-guide.html` — current version, can be used as content reference but design needs complete rethink
