# Google Ads Best Practices for SecureWorks WA
## Multi-Service Home Improvement Contractor (Patios + Fencing + Decking) | Perth, Australia
### Research compiled: 9 March 2026

---

## Table of Contents
1. [Campaign Structure Best Practices](#1-campaign-structure-best-practices)
2. [Ad Copy Best Practices](#2-ad-copy-best-practices)
3. [Landing Page Optimization](#3-landing-page-optimization-for-google-ads)
4. [Conversion Tracking Setup](#4-conversion-tracking-setup)
5. [Australian Home Improvement Benchmarks](#5-australian-home-improvement-benchmarks)

---

## 1. Campaign Structure Best Practices

### How to Structure Campaigns for a Multi-Service Business

**Recommended structure: One campaign per service line, with themed ad groups within each.**

```
Account
├── Campaign: Patios (Insulated)
│   ├── Ad Group: Insulated Patio Perth
│   ├── Ad Group: Patio Builders Perth
│   ├── Ad Group: Outdoor Living Perth
│   ├── Ad Group: Alfresco Area Perth
│   └── Ad Group: Patio Cost/Price Perth
├── Campaign: Fencing
│   ├── Ad Group: Colorbond Fencing Perth
│   ├── Ad Group: Pool Fencing Perth
│   ├── Ad Group: Fence Builders Perth
│   └── Ad Group: Fence Cost/Price Perth
├── Campaign: Decking
│   ├── Ad Group: Composite Decking Perth
│   ├── Ad Group: Timber Decking Perth
│   ├── Ad Group: Deck Builders Perth
│   └── Ad Group: Decking Cost/Price Perth
└── Campaign: Brand (low budget, protect brand terms)
    └── Ad Group: SecureWorks Brand Terms
```

**Why separate campaigns per service:**
- Independent budget control per service line (you can spend more on patios if that is your hero product)
- Separate bidding strategies per campaign based on lead value and conversion data
- Cleaner reporting to see which service line delivers the best ROI
- Different geographic targeting if needed (e.g., certain suburbs convert better for fencing)

**Within each campaign, use 3-7 themed ad groups** with 10-20 related keywords each. This strengthens ad relevance, improves Quality Scores, and ensures your ads connect to tailored landing pages.

### SKAGs vs Themed Ad Groups (STAGs) in 2025/2026

**Verdict: STAGs (Single Theme Ad Groups) are now the standard. SKAGs are largely obsolete.**

| Factor | SKAGs (Old Way) | STAGs (Current Best Practice) |
|--------|-----------------|-------------------------------|
| Keywords per group | 1 | 3-20 (same theme/intent) |
| Data accumulation | Very slow | Fast enough for Smart Bidding |
| Google's preference | Penalised by close variants | Works with Google's AI |
| Management overhead | Extremely high | Manageable |
| When to use | Ultra-high-value single keywords only | Everything else |

**Why SKAGs stopped working:**
- Google's expanded close variants mean a single keyword triggers many related searches anyway
- SKAGs starve the algorithm -- splitting traffic into tiny ad groups prevents the system from gathering enough data to make optimal bidding decisions
- RSAs (Responsive Search Ads) already test multiple headline/description combinations, reducing the need for granular ad group control

**Recommended approach for SecureWorks:**
- Use STAGs with 5-15 tightly themed keywords per ad group
- Group keywords by user intent (e.g., "patio builders Perth" + "build patio Perth" + "patio construction Perth" = same intent)
- Reserve exact match single-keyword treatment only for your absolute highest-value, highest-volume terms (e.g., [insulated patio Perth])

### Performance Max vs Search Campaigns for Tradies

**Verdict: Start with Search. Add Performance Max later as a supplement, not a replacement.**

| Factor | Search Campaigns | Performance Max |
|--------|-----------------|-----------------|
| Lead quality | Higher (user showed intent) | Lower (mixed intent) |
| Transparency | Full keyword/search term visibility | Limited visibility into placements |
| Control | Full negative keyword control | Limited negative keyword options |
| Best for | Service businesses < $5K/month | Businesses with strong conversion data |
| Data needed | Can start immediately | Needs 30-50 conversions/month to optimise |
| Best use case | Capturing high-intent "I need this now" | Brand awareness + remarketing |

**Recommended strategy for SecureWorks:**
1. **Phase 1 (Months 1-3):** Search campaigns only. Build conversion data.
2. **Phase 2 (Month 4+):** If generating 30+ conversions/month, test PMax with 20% of budget.
3. **Ongoing:** Search remains 70-80% of spend; PMax gets 20-30% max.

**Key stat:** Real data from 247 accounts shows PMax wins 58% of the time (4.7% CVR), Search wins 42% (3.9%), but **combined beats both** at 5.9% CVR.

**PMax warnings for tradies:**
- PMax often produces lower-intent, top-of-funnel leads
- Limited visibility into placements makes it harder to filter out wasted spend
- If your budget is under $2,000/month, Search should be your only engine

### Match Types: Broad vs Phrase vs Exact in 2025/2026

**Current state of match types (they are all looser than they used to be):**

| Match Type | Symbol | Behaviour in 2025/2026 | Best For |
|-----------|--------|------------------------|----------|
| Exact | [keyword] | Matches close variants, same intent | Your top 10-15 proven keywords |
| Phrase | "keyword" | Matches queries containing the meaning | Core service terms, moderate control |
| Broad | keyword | Matches anything Google deems related | Discovery + Smart Bidding only |

**Recommended strategy for SecureWorks:**

1. **Start with Exact + Phrase match** for your core terms
   - Exact: `[insulated patio Perth]`, `[patio builders Perth]`, `[colorbond fencing Perth]`
   - Phrase: `"patio installation"`, `"outdoor patio"`, `"fencing contractor"`

2. **Add Broad match ONLY when:**
   - You have Smart Bidding enabled (Maximize Conversions or Target CPA)
   - You have at least 30 conversions in the last 30 days
   - You are actively monitoring the Search Terms Report weekly
   - You have a robust negative keyword list

3. **Broad match + Smart Bidding is powerful but dangerous without data.** Google uses auction-time signals to bid only on relevant queries, but it needs conversion history to do this well.

4. **Run broad match in a separate campaign** with a defined test budget (10-15% of total). This creates a controlled environment for expansion without jeopardising efficiency.

### Budget Allocation Across Services

**Recommended allocation for SecureWorks ($3,000-$5,000/month):**

| Service | % of Budget | Rationale |
|---------|------------|-----------|
| Patios (hero product) | 50-60% | Highest margin, hero offering, strongest positioning |
| Fencing | 20-25% | Steady demand, good volume |
| Decking | 15-20% | Growing category |
| Brand terms | 5% | Protect brand, low CPC |

**Important principles:**
- **Reallocate based on data monthly.** If fencing generates leads at $40 CPL but patios at $120, shift budget to fencing (unless patio jobs are 3x the value).
- **Calculate cost per lead AND cost per sale** for each service to make allocation decisions.
- **Consider seasonality.** Spring/summer = higher search volume for outdoor living in Perth. Increase budgets September-March.
- **Don't spread too thin.** A $3K budget split across 3 services means ~$33/day each. At $5-8 CPC, that is only 4-7 clicks per service per day. If your CPL is high, concentrate on 1-2 services initially.

### Bidding Strategies

**Recommended progression:**

| Stage | Strategy | When | Why |
|-------|----------|------|-----|
| Week 1-2 | Manual CPC or Maximize Clicks | Starting out, no data | Build initial data, understand CPCs |
| Week 3-8 | Maximize Conversions | 15+ conversions tracked | Let Google optimise for conversions |
| Month 3+ | Target CPA | 30+ conversions/month, stable CPA | Control costs while scaling |
| Advanced | Target ROAS | Passing revenue values back from CRM | Optimise for revenue, not just leads |

**Key rules:**
- **Daily budget should be 3-5x your target CPA.** If your target CPA is $80, your daily budget should be $240-$400 minimum.
- **Learning phase lasts 7-10 days.** Performance will fluctuate -- do NOT make changes during this period.
- **Need at least 15 conversions in 30 days for Target CPA** (Google recommends 30+).
- **Set your Target CPA at your actual average CPA** (not aspirational). Then slowly reduce it by 10-15% over time.
- **Never go from Manual to Target CPA directly.** Always go through Maximize Conversions first to build data.

---

## 2. Ad Copy Best Practices

### RSA (Responsive Search Ads) Best Practices

**Structure requirements:**
- Up to **15 headlines** (30 characters each) -- use all 15
- Up to **4 descriptions** (90 characters each) -- use all 4
- Google tests combinations automatically and learns which perform best

**How many headlines to provide:**
- **Minimum effective:** 8-10 unique headlines
- **Ideal:** All 15 filled with diverse messaging
- **Sweet spot for ad groups:** 2 RSAs per ad group (not 1, not 3) -- data shows 2 RSAs per ad group produces the best conversion rate lift

**Headline categories to cover (fill all 15 slots):**

| Slot | Category | Example for Patios |
|------|----------|--------------------|
| 1-3 | Primary keyword + location | "Insulated Patios Perth" / "Patio Builders Perth" |
| 4-5 | Unique value proposition | "Custom Designed & Built" / "Premium Insulated Panels" |
| 6-7 | Trust/credibility | "Licensed & Insured Builders" / "20+ Years Experience" |
| 8-9 | Call-to-action | "Get Your Free Quote Today" / "Book Free Consultation" |
| 10-11 | Benefits | "Keep Cool in Summer" / "Add Value to Your Home" |
| 12-13 | Social proof | "5-Star Rated on Google" / "100+ Happy Customers" |
| 14-15 | Urgency/offer | "Limited Spots This Month" / "Free 3D Design Included" |

**Pinning strategy:**
- **Pin sparingly.** More pins = weaker performance (Google can't optimise).
- **Only pin when legally required** (disclaimers) or for brand consistency.
- **If you must pin:** Pin your primary keyword headline to Position 1 only. Leave everything else unpinned.
- **Best practice:** Pin 1 headline to Position 1 (keyword-rich), leave all other positions unpinned.

### Messaging for High-Value Home Improvement ($20K-$150K Projects)

**Key principles for high-ticket messaging:**

1. **Lead with transformation, not transactions.** Homeowners spending $50K+ are buying a lifestyle, not a product.
   - Bad: "Patio Installation Services"
   - Good: "Transform Your Outdoor Living Space"

2. **Emphasise the consultation/design process.** High-value buyers want to feel the process is personalised.
   - "Free Custom 3D Design"
   - "Personalised Consultation"
   - "Tailored to Your Home"

3. **Signal quality and permanence.**
   - "Built to Last a Lifetime"
   - "Premium Materials & Craftsmanship"
   - "Engineered for Perth Weather"

4. **Address the risk.** Big purchases create anxiety. Reduce it.
   - "Licensed & Fully Insured"
   - "Structural Warranty Included"
   - "Council Approval Handled"

5. **Use specific numbers.** Specificity builds trust.
   - "500+ Outdoor Projects Completed"
   - "4.9 Stars from 120+ Reviews"
   - "Serving Perth Since [Year]"

6. **Don't compete on price in the ad.** For $20K-$150K projects, price shoppers are not your ideal customer. Lead with quality, process, and trust -- qualify on budget during the consultation.

### Australian-Specific Ad Copy That Converts

**Language and tone:**
- Use "tradie" language authentically but professionally
- Perth-specific: reference suburbs, "Perth weather," "WA lifestyle"
- Avoid American spelling (use "colour" not "color", "specialise" not "specialize")
- "Obligation-free quote" is the standard Australian CTA (not "free estimate")
- "Fully licensed" carries more weight in Australia than "bonded"

**Trust signals that matter in Australia:**
- HIA (Housing Industry Association) member
- MBA (Master Builders Association) member
- Licensed builder number
- "Fully insured" (critical for Aussie homeowners)
- ABN displayed
- Google Reviews rating + count
- Local area mentions (Perth, specific suburbs)
- "Australian owned and operated"
- "Family-owned business"
- Years of experience / established date
- Before-and-after photos

**High-converting Australian ad copy patterns:**

```
Headline 1: Insulated Patios Perth | Custom Built
Headline 2: Get Your Obligation-Free Quote
Headline 3: Licensed & Insured Patio Builders
Headline 4: Transform Your Outdoor Space
Headline 5: 5-Star Rated | 100+ Projects
Description 1: Perth's trusted insulated patio builders. Custom designs,
premium materials & council approval handled. Book your free consultation today.
Description 2: Family-owned & fully insured. See our gallery of 100+ completed
projects across Perth. Obligation-free quotes with 3D design included.
```

### Ad Extensions (Assets) That Matter

**Must-have extensions for SecureWorks:**

#### 1. Sitelinks (4-6 minimum)
```
- "Our Patio Gallery" → gallery page
- "Get a Free Quote" → quote form
- "About SecureWorks" → about page
- "Patio Cost Guide" → pricing/cost page
- "Our Process" → how-it-works page
- "Customer Reviews" → testimonials page
```
Keep sitelink text under 25 characters. Update seasonally.

#### 2. Callout Extensions (4-8)
```
- "Obligation-Free Quotes"
- "Licensed & Insured"
- "Custom 3D Designs"
- "Council Approval Handled"
- "Perth Family Business"
- "Premium Materials"
- "Structural Warranty"
- "Finance Available"
```
Keep under 15 characters ideally (25 max).

#### 3. Structured Snippets
```
Header: "Services"
Values: "Insulated Patios, Colorbond Fencing, Composite Decking,
         Alfresco Areas, Carports, Pergolas"

Header: "Types"
Values: "Insulated Panels, Flat Roof, Gable, Hip, Skillion"
```
Minimum 3 values required.

#### 4. Call Extensions
- Add your phone number
- Enable click-to-call on mobile (critical -- 60%+ of tradie leads come from mobile)
- Set call reporting to track call conversions
- Schedule during business hours only

#### 5. Location Extensions
- Link your Google Business Profile
- Shows your address, map pin, and distance from searcher
- Boosts trust and local relevance
- Critical for "near me" searches

#### 6. Image Extensions
- Add high-quality before/after photos
- Show completed projects
- Use images that clearly show your work (not stock photos)

**Extension hierarchy:** Account-level extensions are overridden by campaign-level, which are overridden by ad-group-level. Set generic extensions at account level, service-specific ones at campaign level.

### Ad Copy Testing Framework

**How to test RSA ad copy effectively:**

1. **Run 2 RSAs per ad group** (the conversion rate sweet spot)

2. **Test one variable at a time:**
   - Round 1: Test different value propositions in headlines
   - Round 2: Test different CTAs
   - Round 3: Test different trust signals
   - Round 4: Test different descriptions

3. **Minimum data requirements before declaring a winner:**
   - At least 4 weeks of data
   - Enough conversions for statistical significance (usually 30+ per variant)
   - Completed learning phase
   - Consistent performance over several days

4. **Use Google Ads Experiments** for controlled testing:
   - Go to Campaigns > Experiments > Create new
   - Set 50/50 traffic split (cookie-based)
   - Set clear start and end dates
   - Measure CTR AND conversion rate (CTR alone can be misleading)

5. **Test cadence:** Run one test per ad group per month. Rapid changes prevent learning.

6. **Track headline-level performance:** Google now shows click and conversion data for individual RSA headlines in some accounts, replacing the vague "Good"/"Best" labels.

---

## 3. Landing Page Optimization for Google Ads

### Quality Score Factors and How to Maximise Them

**Quality Score is composed of three factors:**

| Factor | Weight | How to Improve |
|--------|--------|----------------|
| Expected CTR | ~33% | Better ad copy, use all extensions, strong headlines |
| Ad Relevance | ~33% | Match ad copy keywords to search terms; tight ad groups |
| Landing Page Experience | ~33% | Page speed, mobile-friendly, relevant content, clear CTA |

**Impact of Quality Score on costs:**
- Each 1-point increase in Quality Score reduces CPC by 13-16%
- Ads rated "Above average" for both landing page experience AND ad relevance have CPCs **36% below average**
- A Quality Score of 7+ is considered good; 8-10 is excellent
- Below 5 means you are overpaying significantly

### Landing Page Experience Best Practices

**What Google evaluates:**

1. **Content relevance:** Does the landing page deliver on the ad's promise? If your ad says "Free Patio Quote," the landing page must prominently feature a free quote form.

2. **Navigation ease:** Simple, intuitive page structure. Google penalises confusing layouts.

3. **Transparency:** Clear business information, no hidden fees, honest pricing signals.

4. **Ad-to-page consistency:** The headline on the landing page should echo the ad headline. If the ad says "Insulated Patio Builders Perth," the landing page H1 should say something very similar.

5. **Useful, original content:** Not thin content. Show your expertise, include detailed information about your services.

**Landing page structure for maximum conversion (contractor services):**

```
┌─────────────────────────────────────────┐
│  ABOVE THE FOLD                         │
│  ┌─────────────────┬──────────────────┐ │
│  │ Hero headline   │ Short form       │ │
│  │ (matches ad)    │ (Name, Phone,    │ │
│  │                 │  Email, Service) │ │
│  │ Subheadline     │                  │ │
│  │ (value prop)    │ "Get Your Free   │ │
│  │                 │  Quote"          │ │
│  │ Trust badges    │                  │ │
│  │ (HIA, 5-star)   │ Click-to-call   │ │
│  └─────────────────┴──────────────────┘ │
├─────────────────────────────────────────┤
│  SOCIAL PROOF                           │
│  Google Reviews / Testimonials          │
│  Star ratings, customer names, suburbs  │
├─────────────────────────────────────────┤
│  PROJECT GALLERY                        │
│  Before/after photos of local projects  │
│  Suburb names for local relevance       │
├─────────────────────────────────────────┤
│  SERVICES / WHAT WE DO                  │
│  Brief description of service           │
│  Key benefits (3-5 bullet points)       │
├─────────────────────────────────────────┤
│  WHY CHOOSE US                          │
│  Differentiators, process, warranty     │
├─────────────────────────────────────────┤
│  SECOND CTA / FORM                     │
│  Repeat the form or phone CTA          │
├─────────────────────────────────────────┤
│  FAQ                                    │
│  Common questions (helps SEO too)       │
├─────────────────────────────────────────┤
│  FOOTER                                │
│  License number, ABN, insurance details │
│  Phone, email, service areas            │
└─────────────────────────────────────────┘
```

**Critical rules:**
- **One page per service per campaign.** Don't send patio traffic to a generic homepage.
- **One primary CTA** (don't offer 5 different actions). Either "Get a Quote" or "Call Now."
- **Repeat the CTA** at least twice on the page (above fold + after social proof).
- **Floating call button on mobile** -- game-changer for conversion rates.
- **Match the ad's promise to the page headline.** If the ad says "Free Patio Quote," the H1 should be "Get Your Free Patio Quote."

### Mobile Optimization Requirements

**Why this matters:** 60%+ of tradie leads come from mobile devices.

| Requirement | Target | Why |
|-------------|--------|-----|
| Touch targets | 48x48 pixels minimum | Fingers are bigger than cursors |
| Button spacing | 8dp between interactive elements | Prevent mis-taps |
| Font size | 16px minimum for body text | Readable without pinching |
| Form fields | Max 3-4 on mobile | Each extra field reduces conversions |
| Click-to-call | Sticky/floating button | Always accessible |
| Page width | No horizontal scrolling | Responsive design required |

**Mobile conversion rates can be 40% lower than desktop** when pages are not optimised. A floating call button and simplified mobile forms are the fastest wins.

### Page Speed Impact on Quality Score and CPC

**The data is clear: speed = money.**

| Load Time | Conversion Rate | Impact |
|-----------|----------------|--------|
| < 1 second | 9.6% | Best possible |
| 2 seconds | ~7% | Good |
| 3 seconds | ~5% | Acceptable minimum |
| 5 seconds | 3.3% | Significant drop |
| 10 seconds | < 2% | Losing most visitors |

**A 1-second delay in mobile page load time reduces conversions by up to 20%.**

**How to achieve fast load times:**
- Compress all images (use WebP format, lazy loading)
- Minimise CSS/JS (single-file HTML approach helps here)
- Use a CDN (Cloudflare Pages gives you this for free)
- Remove unnecessary third-party scripts
- Target Core Web Vitals: LCP < 2.5s, INP < 200ms, CLS < 0.1
- Test with Google PageSpeed Insights and aim for 90+ mobile score

**For SecureWorks landing pages:**
- Current single-HTML-file approach is good for speed (no extra HTTP requests)
- Cloudflare Pages provides CDN and edge caching
- Optimise hero images (largest contentful paint is usually the hero)
- Defer non-critical JavaScript
- Inline critical CSS

### Form Placement and Design for Maximum Conversion

**Form best practices:**

| Factor | Best Practice | Data |
|--------|--------------|------|
| Number of fields | 3-5 maximum | Reducing from 11 to 4 fields = 120% conversion lift |
| Minimum fields | Name, Phone, Email | Qualify leads AFTER submission |
| Optional field | Service type dropdown | Helps with lead routing |
| Placement | Above the fold + repeated below social proof | Two touchpoints |
| Submit button text | "Get My Free Quote" (not "Submit") | Action-oriented language converts better |
| Phone number | Clickable, prominent, above fold | Moving phone above fold = meaningful conversion lift |

**What NOT to include on the form:**
- Address (ask later)
- Detailed project description (ask later)
- Budget range (ask later)
- CAPTCHA (use honeypot instead -- CAPTCHAs reduce conversions)

**For high-value projects ($20K-$150K):**
- A slightly longer form (Name, Phone, Email, Service, Brief Description) can actually improve lead quality
- Consider a two-step form: Step 1 = Name + Email, Step 2 = Phone + Service details
- This creates micro-commitment and captures the email even if they don't complete step 2

### Google's Own Landing Page Quality Guidelines

**From Google's documentation, they evaluate:**

1. **Relevant and original content:** Content should be directly related to the ad and keywords. Provide useful information about your products or services.

2. **Transparency and trustworthiness:** Clearly state your business model, share contact information, and explain why you collect personal data.

3. **Easy navigation:** Make it easy for users to find what they need. Don't make them search for the CTA.

4. **Fast loading:** Optimise for speed, especially on mobile.

5. **Mobile-friendly:** The page must work perfectly on all devices.

---

## 4. Conversion Tracking Setup

### How to Properly Set Up Google Ads Conversion Tracking in 2025/2026

**Conversion actions to track for SecureWorks:**

| Action | Type | Value | Priority |
|--------|------|-------|----------|
| Form submission (quote request) | Primary | Dynamic (from CRM) or $500 placeholder | Critical |
| Phone call (from ad) | Primary | $300 placeholder | Critical |
| Phone call (from website) | Primary | $300 placeholder | Critical |
| Quote request page view | Secondary | $0 (observation only) | Nice to have |
| Gallery page engagement | Secondary | $0 (observation only) | Nice to have |

**Implementation options:**

| Method | Pros | Cons | Recommended? |
|--------|------|------|-------------|
| Google Tag Manager (GTM) | Flexible, no code changes needed, version control | Additional tool to manage | Yes -- primary method |
| gtag.js (direct) | Simple, no GTM dependency | Requires code changes for updates | OK for simple setups |
| Server-side GTM | Bypasses ad blockers, better data quality | Complex setup, hosting costs | Future consideration |

**Recommended setup for SecureWorks:**

1. **Install GTM container** on all landing pages
2. **Create conversion actions** in Google Ads for form submissions and phone calls
3. **Fire conversion tags** via GTM when forms are submitted
4. **Use call tracking** (Google forwarding number or third-party like CallRail) to track phone conversions
5. **Set up Enhanced Conversions** (see below)

### Enhanced Conversions

**What they are:** Enhanced conversions improve the accuracy of your conversion tracking by sending hashed first-party data (email, phone, name) from your website to Google. This helps Google match conversions back to ad clicks, especially as cookies become less reliable.

**How to set up Enhanced Conversions for leads:**

1. **Collect email or phone on your lead form** (you already do this)
2. **Hash the data** before sending to Google (GTM handles this automatically)
3. **Google matches** the hashed data to signed-in Google users who clicked your ad
4. **Result:** More conversions are attributed to the correct ad/keyword, improving Smart Bidding accuracy

**Implementation via GTM:**
- In your Google Ads Conversion tag in GTM, enable "Enhanced Conversions"
- Map form fields: email, phone number, first name, last name
- GTM automatically hashes the data before sending

**Best matching rates are achieved through email addresses** -- make sure email is a required field on your forms.

### Offline Conversion Imports (CRM to Google Ads)

**This is the most impactful advanced tracking setup for SecureWorks.**

**Why it matters:** Google only sees "lead submitted." It does not know if that lead became a $50K patio job or was a tyre kicker. By importing conversion data from your CRM (GHL) back to Google Ads, you tell the algorithm which leads actually converted to sales and their value. This transforms bidding from "get me more leads" to "get me more leads like the ones that became paying customers."

**How it works:**

```
1. User clicks Google Ad → GCLID is captured
2. User submits form → GCLID stored with lead in GHL
3. Lead converts to sale → You import the sale + value back to Google Ads
4. Google learns → Smart Bidding targets users similar to those who buy
```

**Implementation options for SecureWorks:**

| Method | Complexity | Best For |
|--------|-----------|----------|
| Google Ads Data Manager (manual CSV upload) | Low | Starting out, monthly uploads |
| Zapier integration (GHL → Google Ads) | Medium | Automated, near-real-time |
| Google Ads API (custom edge function) | High | Full automation, custom logic |

**Key requirements:**
- **Capture the GCLID** on every form submission (add a hidden field that captures the `gclid` URL parameter)
- **Store the GCLID** with the lead/opportunity in GHL
- **Upload conversions within 63 days** of the click (conversions uploaded after 63 days are rejected)
- **Upload at least daily** for best Smart Bidding performance (weekly is acceptable if daily is not feasible)
- **Include the conversion value** (the actual project value or estimated value)

**For SecureWorks specifically:**
- You already have GHL integration and Supabase edge functions
- When a lead progresses to "Sale Won" in GHL, trigger an offline conversion import
- Pass the actual quoted/invoiced value as the conversion value
- This enables Value-Based Bidding (Target ROAS) which is the ultimate optimisation

### Value-Based Bidding

**The progression:**

```
Level 1: Maximize Conversions (all leads are equal)
Level 2: Target CPA (control cost per lead)
Level 3: Maximize Conversion Value (leads have different values)
Level 4: Target ROAS (optimise for revenue return on ad spend)
```

**To reach Level 3/4 you need:**
- Offline conversion imports working
- Conversion values being passed (actual project values)
- At least 15 conversions with values in 30 days (30+ recommended)

**For a multi-service business like SecureWorks, this is transformative:**
- A patio lead worth $40K gets more bidding priority than a fence lead worth $5K
- Google learns to target users who are more likely to become high-value customers
- You stop paying the same CPC for a $5K fence enquiry and a $80K patio enquiry

### Server-Side Tracking Considerations

**Current state (2025/2026):**
- Server-side tagging is becoming increasingly important as browsers block more client-side tracking
- Server-side GTM sends data from YOUR server to Google, bypassing ad blockers
- Estimated 10-20% of conversions are missed by client-side tracking due to ad blockers

**For SecureWorks:**
- Not critical right now, but worth planning for
- Your Cloudflare Pages setup could potentially host a server-side GTM container
- Priority should be: (1) Basic GTM tracking → (2) Enhanced Conversions → (3) Offline imports → (4) Server-side tracking
- Server-side tracking becomes important when you want to recover that 10-20% of missed conversions

---

## 5. Australian Home Improvement Benchmarks

### Average CPC for Home Improvement Keywords in Australia

**General Australian CPC range:** $2-$4 AUD for Search (varies significantly by industry and keyword).

**Home improvement/services specific CPCs (USD, multiply by ~1.5 for AUD):**

| Category | Avg CPC (USD) | Estimated AUD |
|----------|--------------|---------------|
| Construction & Contractors | $5.31 | ~$8.00 |
| Home Services (overall) | $7.85 | ~$11.80 |
| Roofing & Gutters | $10.70 | ~$16.00 |
| Electricians | $12.18 | ~$18.30 |
| Painting | $13.74 | ~$20.60 |

**Perth-specific considerations:**
- Perth CPCs are typically 10-20% lower than Sydney/Melbourne due to lower competition density
- Estimated Perth home improvement CPCs: $5-$12 AUD per click
- Patio/outdoor living keywords likely fall in the $6-$10 AUD range
- Fencing keywords are typically lower competition: $4-$8 AUD range
- **Use Google Keyword Planner** with Perth geo-targeting for exact current estimates

### Average Conversion Rate for Contractor Landing Pages

| Metric | Industry Average | Good | Excellent |
|--------|-----------------|------|-----------|
| Landing page CVR (home improvement) | 3.8% (median) | 5-7% | 7.2%+ (top quartile) |
| Overall home services CVR | 7.33% | 8-10% | 10%+ |
| Search ad CTR (home services) | 6.37% | 7-8% | 8%+ |

**Important trend:** Home & Home Improvement conversion rates dropped 14.97% year-over-year, while CTR increased 13.95%. This means more people are clicking but fewer are converting -- likely due to increased price sensitivity and more comparison shopping for big-ticket items.

**What this means for SecureWorks:** Landing page quality and speed-to-contact are more important than ever. If you can respond to leads within 5 minutes (vs. the industry average of several hours), you will close significantly more.

### Average Cost Per Lead in the Patio/Outdoor Living Space

| Service Category | Avg CPL (USD) | Estimated AUD | Notes |
|-----------------|--------------|---------------|-------|
| Home Services (overall) | $90.92 | ~$137 | Broad average |
| Construction & Contractors | ~$60-$80 | ~$90-$120 | Lower CPC helps |
| Roofing (high end) | $228.15 | ~$342 | Highest in home services |
| Painting | $138.38 | ~$207 | High CPC drives this up |
| **Estimated Patio/Outdoor** | **$70-$120** | **~$105-$180** | Based on similar categories |
| **Estimated Fencing** | **$50-$90** | **~$75-$135** | Lower competition |
| **Estimated Decking** | **$60-$100** | **~$90-$150** | Mid-range competition |

**Note:** These are estimates based on available benchmark data. Actual CPL depends heavily on your Quality Score, landing page conversion rate, and geographic targeting.

### What "Good" Looks Like for a Perth Tradie Spending $2K-$5K/Month

**Target KPIs for SecureWorks:**

| KPI | Minimum Acceptable | Good | Excellent |
|-----|-------------------|------|-----------|
| CTR | 5% | 7% | 9%+ |
| Quality Score | 5/10 | 7/10 | 8+/10 |
| Conversion Rate | 3% | 5% | 7%+ |
| Cost Per Lead | < $200 | < $120 | < $80 |
| Leads Per Month ($3K budget) | 15 | 25 | 38+ |
| Leads Per Month ($5K budget) | 25 | 42 | 63+ |
| Cost Per Sale | < $1,000 | < $600 | < $400 |
| ROAS | 5:1 | 10:1 | 20:1+ |

**Calculating your ROAS for high-value projects:**

```
Example at $3,000/month ad spend:
- Generate 25 leads at $120 CPL
- Close 20% = 5 jobs
- Average job value = $25,000
- Revenue = $125,000
- ROAS = $125,000 / $3,000 = 41:1

Even at $5,000/month with only 10% close rate:
- Generate 35 leads at $143 CPL
- Close 10% = 3.5 jobs
- Average job value = $25,000
- Revenue = $87,500
- ROAS = $87,500 / $5,000 = 17.5:1
```

**The key insight for high-value contractors:** Even a "poor" performing campaign can be wildly profitable because each conversion is worth $20K-$150K. The focus should be on **lead quality** (people who actually become customers) rather than lead volume.

### Month-by-Month Expectations

| Month | What to Expect | Focus |
|-------|---------------|-------|
| Month 1 | Learning phase. Costs will be high, conversion data building. Expect 50% of target performance. | Get tracking right, build negative keyword list |
| Month 2 | Algorithm learning. Performance improving. CPCs starting to stabilise. | Optimise ad copy, refine keywords, check search terms weekly |
| Month 3 | Campaigns maturing. Should be approaching target KPIs. | Switch to Target CPA if 30+ conversions, start A/B testing |
| Month 4-6 | Optimisation phase. Fine-tuning for efficiency. | Test landing pages, implement offline conversions, consider PMax test |
| Month 6+ | Mature campaigns. Focus on scaling profitable campaigns, cutting losers. | Value-based bidding, expand match types, geographic expansion |

**Minimum 3-month commitment** before evaluating whether Google Ads is working. The algorithm needs data to learn.

---

## Quick-Start Action Plan for SecureWorks

### Week 1: Foundation
- [ ] Set up Google Ads account (if not already done)
- [ ] Install Google Tag Manager on all landing pages
- [ ] Set up conversion tracking (form submissions + phone calls)
- [ ] Create separate campaigns for Patios, Fencing, Decking
- [ ] Build 3-5 ad groups per campaign with 10-15 keywords each
- [ ] Write 2 RSAs per ad group with all 15 headlines
- [ ] Add all extensions: sitelinks, callouts, structured snippets, call, location
- [ ] Set up negative keyword lists (DIY, jobs, training, free, cheap)
- [ ] Start with Maximize Clicks or Manual CPC bidding

### Week 2-4: Data Collection
- [ ] Monitor search terms report daily, add negative keywords
- [ ] Check Quality Scores and adjust ads/landing pages as needed
- [ ] Switch to Maximize Conversions once tracking is confirmed working
- [ ] Review device, location, and time-of-day performance

### Month 2-3: Optimization
- [ ] A/B test ad copy (one variable at a time)
- [ ] Optimise landing pages for speed and conversion rate
- [ ] Implement Enhanced Conversions
- [ ] Set up GCLID capture on forms for future offline conversion imports
- [ ] Consider switching to Target CPA if 30+ conversions achieved

### Month 4+: Advanced
- [ ] Implement offline conversion imports from GHL
- [ ] Move toward Value-Based Bidding (Target ROAS)
- [ ] Test Performance Max with 20% of budget
- [ ] Test broad match keywords with Smart Bidding
- [ ] Geographic bid adjustments based on suburb-level data

---

## Negative Keywords Starter List

**Add these as negative keywords across all campaigns from day one:**

### DIY / Informational Intent
```
DIY, how to, tutorial, guide, plans, ideas, inspiration, pinterest,
youtube, video, instructions, tips, tricks, steps, build your own,
make your own, self install, do it yourself
```

### Job Seekers
```
jobs, careers, hiring, employment, salary, wage, apprentice,
apprenticeship, traineeship, work, vacancy, position, resume,
apply, application
```

### Education / Training
```
course, courses, training, certificate, qualification, tafe,
university, degree, study, learn, learning
```

### Price Avoidance
```
free, cheap, cheapest, budget, discount, sale, clearance,
second hand, used, reclaimed, salvage
```

### Irrelevant Modifiers
```
repair, fix, fixing, clean, cleaning, paint, painting (for fencing/patio),
remove, removal, demolition, hire (as in equipment hire),
rental, rent, lease
```

### Geographic (if not serving these areas)
```
Sydney, Melbourne, Brisbane, Adelaide, Hobart, Darwin, Canberra,
Gold Coast, Sunshine Coast
(add any Perth suburbs you don't service)
```

---

## Sources

### Campaign Structure & Strategy
- [Google Ads for Remodelers - BG Collective](https://www.bgcollective.com/solutions-lab/google-ads-for-remodelers-wins)
- [Google Ads Best Practices 2026 Guide - Two Minute Reports](https://twominutereports.com/blog/google-ads-best-practices)
- [STAG vs SKAG Campaigns 2026 - sitecentre](https://www.sitecentre.com.au/blog/stag-vs-skag-campaigns)
- [Single Keyword Ad Groups: Still Relevant in 2026? - Store Growers](https://www.storegrowers.com/single-keyword-ad-groups/)
- [Why SKAGs Are Killing Performance - Green Lane](https://www.greenlanemarketing.com/resources/articles/why-your-skags-are-killing-your-google-ads-performance)
- [PMax vs Search Ads for Tradies 2026 - LocaliQ AU](https://localiq.au/blog/search-ads/pmax-vs-search-ads-for-tradies)
- [Performance Max vs Search 2026 Guide - 20 Minute Marketing](https://www.20minutemarketing.com.au/blog/performance-max-vs-search-ads-2026-guide)
- [Performance Max vs Search: Overlap Data - Search Engine Land](https://searchengineland.com/performance-max-vs-search-campaigns-overlap-data-448788)

### Match Types & Bidding
- [Keyword Match Types 2026 Guide - Growth Minded Marketing](https://growthmindedmarketing.com/blog/keyword-match-types/)
- [Broad Match vs Phrase Match 2026 - Search South](https://www.search-south.com/2026/02/24/broad-match-vs-phrase-match-when-to-use-each-in-google-ads/)
- [Google Ads Match Types 2026 - Downey Marketing](https://downeymarketing.com/google-ads-keyword-match-types-explained-2026/)
- [Target CPA Bidding 2026 - Store Growers](https://www.storegrowers.com/target-cpa/)
- [Google Ads Bidding Strategies 2025 - Define Digital Academy](https://www.definedigitalacademy.com/blog/google-ads-bidding-strategies-in-2025-how-to-avoid-costly-mistakes-and-maximize-results)
- [Google Ads Bidding Strategies 2026 - Growth Minded Marketing](https://growthmindedmarketing.com/blog/google-ads-bidding-strategies/)

### Ad Copy & RSAs
- [Responsive Search Ads 2026 Guide - Seize Marketing](https://seizemarketingagency.com/responsive-search-ads/)
- [RSA 2026 Guide + Best Practices - Growth Minded Marketing](https://growthmindedmarketing.com/blog/responsive-search-ads/)
- [RSA Best Practices 2025 - Pattern (AU)](https://au.pattern.com/blog/best-practices-for-responsive-search-ads-rsa-in-2025/)
- [Google Ads for Tradies 2026 - sitecentre](https://www.sitecentre.com.au/blog/google-ads-for-tradies)
- [Google Ads for Tradies 2026 - Elite Property Marketing](https://www.elitepropertymarketing.com.au/google-ads-for-tradies-the-complete-2026-guide/)
- [A/B Testing RSAs 2025 - WebFX](https://www.webfx.com/blog/ppc/ab-testing-responsive-search-ads/)
- [How to Test Google Ads Copy 2026 - Digital Marketing Knight](https://www.digitalmarketingknight.com/how-to-test-google-ads-copy/)

### Landing Pages & Quality Score
- [Fix Your Quality Score 2025 - GrowLeads](https://growleads.io/blog/fix-your-google-ads-quality-score/)
- [Quality Score 2026 - Store Growers](https://www.storegrowers.com/google-ads-quality-score/)
- [Landing Page Experience Optimization 2026 - NitroPack](https://nitropack.io/blog/landing-page-experience-optimization/)
- [Quality Score Optimization 2025 - Adaptly](https://adaptly.dev/blog/google-ads-quality-score-optimization)
- [Landing Page Conversion Stats 2026 - Genesys Growth](https://genesysgrowth.com/blog/landing-page-conversion-stats-for-marketing-leaders)
- [Landing Page Conversion Rates by Industry 2026 - First Page Sage](https://firstpagesage.com/seo-blog/landing-page-conversion-rates-by-industry/)
- [Contractor Landing Page Structure - Ali Raza](https://aliraza.co/best-performing-landing-page-structure-for-local-service-google-ads-electricians-plumbers-contractors/)
- [CTA Stats for Home Services - Cube Creative](https://cubecreative.design/blog/small-business-marketing/top-10-cta-stats-home-services)

### Conversion Tracking
- [Google Ads Conversion Tracking 2026 Complete Guide - Groas](https://groas.ai/post/google-ads-conversion-tracking-setup-2026-the-complete-guide-ga4-enhanced-conversions-consent-mode)
- [Offline Conversion Tracking 2025 Guide - Heeet](https://www.heeet.io/blog/how-to-set-up-offline-conversion-tracking-with-google-ads-a-complete-2025-guide-to-bridging-clicks-and-real-world-sales)
- [Enhanced Conversions 2026 Guide - Lever Digital](https://www.leverdigital.co.uk/guides/the-complete-guide-to-enhanced-conversions-in-google-ads)
- [Value-Based Bidding Guide - One PPC](https://oneppcagency.co.uk/google-ads/value-based-bidding/)
- [Server-Side Tagging 2026 - Analytify](https://analytify.io/gtm-server-side-tagging/)
- [Offline Conversion Imports - Google Ads Help](https://support.google.com/google-ads/answer/2998031?hl=en)

### Benchmarks & Costs
- [Google Ads Benchmarks 2025 - WordStream](https://www.wordstream.com/blog/2025-google-ads-benchmarks)
- [2025 Search Ad Benchmarks for Home Services - LocaliQ](https://localiq.com/blog/home-services-search-advertising-benchmarks/)
- [Google Ads Cost in Australia 2026 - The Ardor](https://www.theardor.com.au/google-ads-cost-in-australia/)
- [Google Ads Pricing Guide Australia - Tradie Digital](https://tradiedigital.co/how-much-does-google-ads-cost/)
- [Google Ads Benchmarks Australia 2025 - Rocking Web](https://www.rockingweb.com.au/google-ads-benchmarks-by-industry-2025/)
- [Google Ads Spending Guide - Tradie Digital](https://tradiedigital.co/how-much-should-you-spend-on-google-ads/)
- [Google Cost Per Conversion Home Improvement - Varos](https://www.varos.com/benchmarks/google-cost-per-conversion-for-home-improvement)
- [Google Ads ROAS Home Improvement - Varos](https://www.varos.com/benchmarks/google-roas-for-home-improvement)
- [PPC Benchmarks 2026 - WebFX](https://www.webfx.com/blog/marketing/ppc-benchmarks-to-know/)
- [Why CPC Is Rising 2025-2026 - Digital Otters](https://www.digitalotters.com/why-google-ads-cpc-is-rising-in-2025-2026-and-how-advertisers-can-reduce-costs/)

### Negative Keywords
- [Negative Keywords 2026 - Optmyzr](https://www.optmyzr.com/blog/negative-keywords/)
- [7 Google Ads Mistakes for Home Improvement - Built Right Digital](https://builtrightdigital.com/google-ads-mistakes-for-home-improvement-contractors/)
- [Negative Keyword Guide for Home Contractors - Texonica](https://texonica.com/avoiding-wasted-ad-spend-a-comprehensive-guide-to-negative-keyword-targeting-for-home-contractors/)
