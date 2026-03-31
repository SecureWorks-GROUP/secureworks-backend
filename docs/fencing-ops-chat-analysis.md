# SecureWorks Fencing Operations — WhatsApp Chat Analysis

**Data:** 6,212 messages over 364 days (17 Mar 2025 → 16 Mar 2026)
**Participants:** 12 people, 6 active contributors
**Source:** "SWWA: FENCING" WhatsApp group

---

## 1. Issue Frequency Analysis (Ranked)

| Rank | Category | Occurrences | Impact |
|------|----------|-------------|--------|
| 1 | **Payment & Billing** | 194 | Invoicing delays, cash jobs, deposit tracking, extra charges, neighbour splits |
| 2 | **Asbestos** | 125 | THE operational bottleneck. No in-house license. Removalist scheduling cascades into every delay |
| 3 | **Scheduling Delays** | 64 | Jobs pushed back, clients waiting months, crews arriving to unready sites |
| 4 | **Wrong Materials Ordered** | 38 | Wrong height panels (2100 vs 1800), wrong post type (SHS vs fence posts), wrong colour |
| 5 | **Site Conditions** | 34 | Limestone, tree roots, hard soil, brick walls, access for diggers |
| 6 | **Pickup vs Delivery Confusion** | 33 | Crew arrives, no materials. "Was I meant to pick it up?" |
| 7 | **Work Order Errors** | 30 | Wrong height on WO, no photos, missing scope info, inaccurate details |
| 8 | **Site Cleanup** | 17 | Tec screws in client's driveway (busted tire), debris left, materials dumped on wrong lawn |
| 9 | **Materials Missing** | 16 | No concrete, no plinths, no gate stile, no rails — arrived on site to nothing |
| 10 | **Communication Gaps** | 15 | No one told the client, removalist didn't update, crew didn't know the plan |
| 11 | **Client Complaints** | 14 | Upset clients, near-refund requests, "wouldn't recommend us" |
| 12 | **Scope Errors** | 8 | Quote didn't match site reality, extra plinths not in scope, wrong fence line |

### The Big Three:
1. **Asbestos is strangling the business.** 125 mentions. No license, dependent on 3rd party removalists (Din/Max Safe, Luka/Pratezina, Steve). Every asbestos job cascades delays through the entire schedule. Luka was "God-sent" until he went on holiday for 2 weeks.

2. **Material ordering is chaotic.** Wrong items ordered (38), materials missing on site (16), pickup/delivery confusion (33) = **87 material-related issues in 12 months.** That's roughly 2 per week. At $200-500 per incident (wasted crew time, return trips, re-orders), this is $20-40K/year in waste.

3. **Payment admin is heavy.** 194 mentions of invoicing, deposits, cash jobs, extra charges. This suggests the financial side consumes enormous chat bandwidth — people asking about invoices, confirming deposits, tracking neighbour payments. This is exactly what the Xero + Supabase integration solves.

---

## 2. Supplier Scorecard

| Supplier | Total Mentions | Problems | Positive | Net Score |
|----------|---------------|----------|----------|-----------|
| **R&R Fencing** | 68 | 4 | 6 | +2 (reliable) |
| **Fencing Warehouse (FW)** | 65 | 9 | 9 | 0 (mixed) |
| **Pratezina / Luka** | 41 | 3 | 4 | +1 (good, asbestos removalist) |
| **Team Work** | 19 | 5 | 4 | -1 (delivery issues) |
| **Bunnings** | 7 | 2 | 2 | 0 (backup only) |
| **Oxworks** | 6 | 2 | 1 | -1 (gate delays) |

### Key Supplier Findings:
- **R&R Fencing (Wangara):** Primary supplier. Mostly reliable. Issues are usually on SecureWorks' side (not specifying correctly, not checking invoices). Used for pickup frequently.
- **Fencing Warehouse (FW):** Gate manufacturer. Major issue: Adam Bennett's gate delayed 3+ months due to manufacturer taking sick leave. Client nearly asked for refund. FW's custom gate lead times are unreliable.
- **Team Work (TW):** Frequent delivery delays. "Team Work actually delivered wow" — Shaun's surprise tells you everything about their reliability.
- **Pratezina / Luka:** Asbestos removalist. $60/sheet, $550 clearance. Goes by hand (no digger needed). Described as "God-sent" and "rockstar" multiple times. But goes on holiday — need backup removalists.

---

## 3. Job Timeline (Most Discussed)

| Client | Mentions | Key Events |
|--------|----------|------------|
| **Steve** | 90 | Long-running job. Corner closure forgotten. Multiple return visits. Gate from FW delayed. |
| **Anthony** | 43 | Asbestos job. Removalist scheduling nightmare. Wrong address for delivery. Client couldn't be reached by phone. |
| **Sunita** | 28 | Asbestos removal + new fence. Required temp fencing. Brickwork removal by client. Multiple removalist quotes. |
| **Adam (Bennett)** | 23 | Gate ordered Dec, promised Jan, delayed 3 months due to FW manufacturer sick leave. Client "wouldn't recommend us." |
| **David** | 23 | Shared fence with Anthony. Neighbour payment split. Asbestos complications. |
| **Rishen** | 17 | ~$25K job. 30 sheets asbestos. Neighbours all paid deposits. Cross-sell to patio. |
| **Ryder** | 15 | Gate from R&R ready after 2 months wait. Scheduling to install kept getting pushed. |

---

## 4. Decision Patterns (SOP Candidates)

These are recurring decisions made ad-hoc in chat that should be formalised:

### Material Ordering
- **What happens:** Georgia/Rex/Khairo create material orders, send them in chat for approval, then email to supplier.
- **What goes wrong:** Wrong height, wrong post type, missing plinths, colour not confirmed, no concrete ordered for core-drill jobs.
- **SOP needed:** Material order checklist with mandatory fields (height, colour, post type, concrete qty, plinth count, pickup vs delivery, delivery pin location, date required).
- **The ordering template already exists** (Georgia created it April 2025) but isn't always followed.

### Pickup vs Delivery
- **What happens:** Sometimes materials are delivered to site, sometimes crew picks up from Wangara. This isn't always clear on the work order.
- **What goes wrong:** Crew arrives at 7am, no materials. Half a day wasted. "Was I meant to pick it up?" appears multiple times.
- **SOP needed:** Work order title must start with "DELIVERY-" or "PICKUP-" (Georgia started doing this but it wasn't consistent).

### Asbestos Removal Scheduling
- **What happens:** Quote sent → client accepts → then scramble to find a licensed removalist → then schedule removal → then schedule installation. The removalist step adds 2-4 weeks.
- **SOP needed:** Before accepting any asbestos job, confirm removalist availability + date. Don't promise installation dates until removal is booked.

### Client Colour Confirmation
- **What happens:** Client changes mind on colour after deposit. Khairo: "Chris Wilson at the last minute changed his mind on the colour."
- **Policy established in chat:** Colour locked at deposit. Changes after = $150 handling fee.

### Extra Charges / Variations
- **What happens:** Site conditions require extra work (limestone, extra plinths, fence removal not in scope). Crew calls Marnin, gets verbal approval, charges extra $100-400.
- **SOP needed:** Any variation over $200 gets a text confirmation from client before proceeding. Currently done verbally.

### Completion Sign-Off
- **What happens:** Henry finishes a job, sometimes client isn't home. "She was not around to sign off." Invoice gets sent anyway.
- **SOP needed:** Completion form + photos mandatory before invoicing. This is exactly what the Trade app service report does.

---

## 5. Response Time Patterns

### Issue Raised → Acknowledged

| Issue Type | Typical Response Time | Example |
|-----------|----------------------|---------|
| Materials missing on site (crew blocked) | **5-15 minutes** | Emeka reports no concrete → Marnin responds in 2 mins |
| Client complaint | **30-60 minutes** | Adam Bennett upset → discussed within the hour |
| Work order request | **2-24 hours** | Emeka asks for WO → Georgia sends next morning |
| Scheduling change | **1-4 hours** | Job moved → communicated same day |
| Material ordering error discovered | **Minutes** (panic mode) | Wrong height panels → immediate chat discussion |

### Issue Raised → Resolved

| Issue Type | Typical Resolution Time |
|-----------|------------------------|
| Missing materials (pickup available) | Same day (crew goes to Wangara) |
| Wrong materials delivered | Next day (return + reorder) |
| Asbestos removalist needed | 1-4 weeks |
| Gate from FW | 4-12 weeks (!!) |
| Client complaint (service recovery) | 1-3 days |

---

## 6. Crew Dynamics

### Activity & Roles
| Person | Messages | Role | Pattern |
|--------|----------|------|---------|
| **Khairo Pomare** | 1,673 (31%) | Sales/scoping. Became most active from Sept 2025. Closes deals, manages client relationships, does on-site work. | Most active communicator. Raises AND resolves issues. Drives revenue. |
| **Marnin** | 1,434 (26%) | CEO. Sets direction, makes final calls, handles escalations. | Raises quality issues, demands SOP improvements. Active early mornings (5-6am). |
| **Brother Emeka (Henry)** | 916 (17%) | Lead installer. On-site every day. | Reports issues from site, sends completion photos, resolves material problems by picking up himself. Most reliable at resolving. |
| **Shaun Lee** | 660 (12%) | Ops manager (joined ~Jan 2026). Scheduling, supplier coordination. | Brings structure — meeting scheduling, status tracking, removalist coordination. Based in KL. |
| **Godfrey** | 489 (9%) | Ops/admin. Sends work orders, manages Tradify. | Active mid-2025, less active after Shaun joined. |
| **Rex Ramoneda** | 189 (3%) | Material ordering, admin support. | Active Oct-Dec 2025. Handles ordering workflow. |
| **Georgia Bullard** | 47 (1%) | Early admin (Mar-May 2025). Created ordering template. Left May 2025. | Short tenure but established key processes. |

### Issue Raising vs Resolving
| Person | Issues Raised | Issues Resolved | Ratio |
|--------|--------------|-----------------|-------|
| Marnin | 41 | 103 | 2.5x resolver |
| Brother Emeka | 20 | 107 | 5.3x resolver |
| Khairo | 42 | 85 | 2.0x resolver |
| Shaun | 20 | 69 | 3.4x resolver |
| Godfrey | 21 | 52 | 2.5x resolver |

Henry (Brother Emeka) is the most reliable problem-solver — raises the fewest issues relative to how many he resolves. When something goes wrong on site, he fixes it and moves on.

### Time-of-Day Pattern
- Peak activity: **8am-12pm** (2,900+ messages in this window)
- Morning surge at **6-7am**: Marnin sets the day's agenda, shares material orders
- Second peak at **12-1pm**: Status updates, midday coordination
- Drops sharply after **6pm** but doesn't stop — late evening discussions about next day's plan

---

## 7. Surprises & Non-Obvious Insights

### 1. The Business is Essentially Two Different Operations
Early chat (Mar-Jun 2025) is Marnin + Henry + Georgia doing everything. From September 2025, it shifts to Khairo + Shaun + Henry with structured processes (Tradify, work orders, material order approval flows). The operational maturity jumped significantly when Khairo and Shaun joined. The data shows a clear inflection point in September 2025 (message volume triples).

### 2. Asbestos is a Strategic Bottleneck, Not Just an Operational One
125 mentions. It's not just about removal — it's about the cascade effect. Every asbestos job delays 2-4 weeks. During that delay, crew has no work (or does smaller jobs). The $1,510 Class B license Shaun found would pay for itself in one month of not waiting for removalists. This is the single highest-ROI operational investment identified in the data.

### 3. The "Work Order" is the Weakest Link
30 mentions of WO problems: wrong height, no photos, missing info, inaccurate scope. Henry regularly arrives on site and discovers the WO doesn't match reality. This is exactly what the fencing scope tool + QA verification was designed to fix. The chat data validates that the scope tool is solving a real, expensive problem.

### 4. Material Ordering Errors Cost ~$20-40K/Year
87 material-related issues × estimated $200-500 per incident (crew time, return trips, re-orders, wrong items). The ordering template Georgia created in April 2025 was the right idea but wasn't consistently used. The scope-tool-to-PO automation eliminates this entirely.

### 5. Chat IS the Operations System
Everything happens in WhatsApp: material orders, scheduling, client communication, financial decisions, scope clarifications. The Secure Suite is replacing a WhatsApp group, not a software system. This means the Trade app needs to capture what currently happens in chat:
- "Materials on site? Y/N" check
- "Pickup or delivery?" flag on every job
- Quick photo of materials on arrival (Henry already does this)
- One-tap "Job done" with completion photos
- Variation request with client confirmation

### 6. Marnin's Strategic Clarity is Already in the Chat
The Feb 2026 strategy message (line 8712-8719) about needing to differentiate from "hundreds of one man bands" and target premium builders, landscape architects, and government contracts — this is articulated clearly in the chat months before the Secure Suite AI would surface it. The AI should reinforce and track progress against these strategic priorities, not discover them.

### 7. Crew Respect and Morale is High
Despite the operational chaos, the chat shows genuine respect between team members. Henry is consistently thanked. Mistakes are treated as learning opportunities ("lots of learning this week ✅ we can do it"). Khairo nearly cried when Rishen's $25K job was accepted. Shaun calls Henry a "rockstar." This culture is a competitive advantage that the system should protect, not undermine.

---

## What This Means for the Trade App

The chat reveals 6 things the Trade app needs to capture that currently only exist in WhatsApp:

1. **Material arrival confirmation** — "Are materials on site? Y/N" with photo
2. **Pickup vs delivery clarity** — visible flag on every job, not buried in work order text
3. **Variation requests** — when site conditions differ from scope, log the variation with amount + client approval
4. **Completion photos** — Henry already does this in chat. The Trade app should make it easier, not harder
5. **Removalist/subcontractor coordination** — asbestos removalist booked? Date? Status? This lives in Shaun's head currently
6. **Client communication log** — "Called client, confirmed Friday" — this gets lost in WhatsApp. Should be a job event

---

## What This Means for AI Alerts

Based on real patterns in this data, the AI daily digest should flag:

- Job scheduled within 3 days but materials not confirmed as on-site or ordered
- Asbestos job accepted but no removalist booked
- Work order created without photos attached
- Job completed more than 3 days ago but not invoiced
- Gate ordered from FW — auto-alert every 2 weeks until delivered (FW lead times are unreliable)
- Client hasn't been contacted within 48 hours of schedule change

---

## Baseline Metrics (Pre-System)

These numbers set the baseline for measuring improvement after Secure Suite is fully operational:

| Metric | Current (from chat data) |
|--------|------------------------|
| Material ordering errors per month | ~3-4 |
| Average gate delivery time (FW) | 4-8 weeks |
| Asbestos delay per job | 2-4 weeks |
| Client complaints per quarter | ~4-5 |
| Invoicing delay (completion → invoice) | 1-7 days (often delayed) |
| Crew site-ready failures (no materials) | ~3 per month |
| Work order accuracy issues | ~2-3 per month |
