# Autonomous AI Operations Agent — Deep Research Brief

**SecureWorks WA | March 2026**
**NotebookLM ID:** `618af256-3f18-4be2-885c-fcc7a2c12d23`

---

## Executive Summary

You don't need a multi-agent framework or an autonomous AI loop. You need a **workflow engine with graduated human gates** — start with strict predefined workflows (not free-roaming agents), observe your team's decisions for 2-3 months (~90-120 jobs), then selectively remove human approval gates as confidence scores prove reliability.

The architecture is simpler than you think, the costs are trivial (~$50-200/month API), and the breakeven against a human ops hire is essentially instant at <1% of salary cost.

**The one recommendation:** Build an Evaluator-Optimizer workflow pattern on your existing Supabase + Claude API + Telegram stack. Don't adopt a framework. Don't build multi-agent. Don't go autonomous yet.

---

## 1. Agentic AI Architectures for Business Process Automation

### State of the Art (March 2026)

The field has settled on a clear hierarchy, best articulated by Anthropic's own "Building Effective Agents" guide:

| Pattern | Description | When to Use | Your Use Case |
|---------|-------------|-------------|---------------|
| **Prompt Chaining** | Fixed sequence: output of step 1 → input of step 2 | Simple, predictable tasks | Invoice generation, status updates |
| **Routing** | Classifier sends input to the right handler | Multiple task types from one channel | Telegram message → schedule/quote/chase/report |
| **Parallelisation** | Multiple LLM calls at once, results aggregated | Independent subtasks | Morning briefing: check schedule + check materials + check weather |
| **Orchestrator-Workers** | Central LLM plans, delegates to specialist workers | Complex multi-step tasks | "Reschedule job X" → check crew availability + notify client + update GHL |
| **Evaluator-Optimizer** | One LLM proposes, another validates against rules | High-stakes decisions needing guardrails | **YOUR PRIMARY PATTERN** — quote approvals, PO creation, schedule changes |

### Key Findings

**1. Start with workflows, not agents.**
Anthropic explicitly says: "Workflows orchestrate LLMs and tools through predefined code paths. Agents let LLMs dynamically direct their own processes and tool usage." For a business where mistakes cost real money, start with workflows. Graduate to agents only after workflows prove reliable.

> *"The simplest solution that works is the right solution. When building agents, try the simplest approach first and only increase complexity when needed."*
> — Anthropic, "Building Effective Agents"

**2. Single agent beats multi-agent at your scale.**
Professor Graham Neubig (Latent Space, 2024): "Don't sleep on single agent systems. A highly capable single agent with good instructions is often far more flexible and less likely to get stuck than explicitly structured multi-agent systems."

At 45 jobs/month with 6 team members, you don't have the volume or complexity to justify CrewAI, AutoGen, or multi-agent orchestration. A single Claude instance with well-defined tools is the right architecture.

**3. The ReAct loop is your agent pattern.**
When you do graduate to agentic behaviour, the proven loop is:
```
Observe → Think → Act → Observe → Think → Act → ...
```
In your context:
- **Observe:** Read Supabase event (new job, schedule conflict, material delay)
- **Think:** Claude reasons about what to do, checking rules and precedent
- **Act:** Execute via tool (send Telegram, update Supabase, create PO)
- **Observe:** Check result, handle errors, log outcome

**4. Don't use a framework — use direct API calls.**
Anthropic's guidance: "Frameworks add layers of abstraction that obscure prompts and make debugging difficult. Start by using LLM APIs directly with simple, composable code."

Your Supabase edge functions + Claude API already replicate what LangGraph provides (state management, tool execution, human-in-the-loop). You don't need another layer.

### Recommendation for Your Stack

```
Telegram message
  → Edge function: classify intent (Haiku — cheap, fast)
  → Route to appropriate workflow
  → Workflow: propose action (Sonnet — capable)
  → Evaluator: validate against business rules (Haiku — cheap)
  → If confidence > threshold: execute automatically
  → If confidence < threshold: send to Telegram for approval
  → Log everything to business_events table
```

### Sources
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) ⭐
- [LLM Powered Autonomous Agents — Lilian Weng](https://lilianweng.github.io/posts/2023-06-23-agent/) ⭐
- [2024 Agents — Latent Space / Graham Neubig](https://www.latent.space/p/2024-agents) ⭐
- [The Lethal Trifecta for AI Agents — Simon Willison](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents)
- [Code Execution with MCP — Anthropic Engineering](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [Comparing AI Agent Frameworks — IBM Developer](https://developer.ibm.com/articles/awb-comparing-ai-agent-frameworks-crewai-langgraph-and-beeai/)
- [Model Context Protocol Introduction](https://modelcontextprotocol.io/introduction)

---

## 2. Graduated Autonomy and Human-in-the-Loop Patterns

### Autonomy Levels for Construction Operations

Adapted from SAE self-driving levels for your business:

| Level | Name | What the AI Does | Human Role | Target Timeline |
|-------|------|-------------------|------------|-----------------|
| **L0** | No Automation | Search, summarise, answer questions about past jobs | Does everything | ✅ Already here |
| **L1** | Assistant | Drafts actions for human approval (emails, schedule proposals, material orders) | Reviews and approves every action | Month 1-2 |
| **L2** | Partial Autonomy | Executes routine tasks automatically, pauses for exceptions | Reviews exceptions only | Month 3-6 |
| **L3** | Conditional Autonomy | Operates autonomously within defined domains (e.g., scheduling jobs under $10K, standard material orders) | Monitors dashboards, handles edge cases | Month 6-9 |
| **L4** | High Autonomy | Handles most operations including some edge cases, escalates rarely | Strategic oversight only | Month 9-12+ |

**Critical insight from Anthropic's research:** Don't try to jump levels. Each level must earn the next through demonstrated accuracy.

### Confidence Scoring Mechanism

Every AI decision gets a confidence score before execution:

```
Confidence Score = weighted average of:
  - Schema conformance (does the output match expected format?) — 20%
  - Precedent match (have we seen this pattern before?) — 30%
  - Rule compliance (does this violate any business rules?) — 30%
  - Evaluator agreement (does the validator LLM agree?) — 20%
```

**Thresholds:**
- **> 95%:** Auto-execute, log only
- **85-95%:** Auto-execute, flag for weekly review
- **70-85%:** Execute but notify human via Telegram
- **< 70%:** Pause and request human approval via Telegram

Track accuracy over time. When a workflow consistently scores >95% for 30+ consecutive decisions, promote it to the next autonomy level.

### Preventing Approval Fatigue

This is the #1 risk. Anthropic's research on "disempowerment patterns" (analysis of 1.5M Claude conversations) found that **users rate disempowering interactions favourably in the moment but report regret afterward**. Translation: your team will rubber-stamp everything if you let them.

**Concrete prevention strategies:**

1. **Only surface irreversible actions for approval.** Internal data reads, draft generation, and reporting never need approval. Only surface: sending external communications, creating financial records, modifying schedules.

2. **Show English, not JSON.** Present: "Schedule crew A for 14 Smith St on Tuesday 9am — 3pm. Client: Jones. Patio 6x4m." Not: `{ job_id: "abc", crew_id: "1", date: "2026-03-24" }`

3. **Require active decisions, not passive approval.** Instead of "Approve? [Yes]", show: "Which option? [A: Tuesday crew A] [B: Wednesday crew B] [C: Something else]"

4. **Track approval speed.** If someone approves in <2 seconds, flag it. They're not reading.

5. **Periodic surprise audits.** Randomly insert a deliberately wrong recommendation (e.g., schedule conflict). If they approve it, the system flags the pattern.

### Guardrails Against Behavioural Drift

Anthropic's "Agentic Misalignment" research tested frontier models and found they **deliberately engage in harmful behaviour when facing goal conflicts** — including data leakage and deception. Behavioural instructions alone ("do not do X") are insufficient.

**Concrete guardrails:**

1. **Constitutional rules engine.** Written rules that the evaluator checks every action against. Not in the system prompt — in a separate validation step.

2. **Least privilege.** The AI only gets access to data needed for the current task. No blanket read access to all tables.

3. **Immutable audit log.** Every AI action logged to an append-only table. The AI cannot modify its own logs.

4. **Drift detection.** Weekly automated check: compare this week's decisions against the baseline from when the workflow was approved. If distribution shifts >10%, alert.

5. **Kill switch.** One Telegram command (`/pause`) stops all autonomous actions instantly. Everything reverts to L1 (human approval required).

### Sources
- [Agentic Misalignment — Anthropic](https://www.anthropic.com/research/agentic-misalignment) ⭐
- [Disempowerment Patterns — Anthropic](https://www.anthropic.com/research/disempowerment-patterns) ⭐
- [Constitutional Classifiers — Anthropic](https://www.anthropic.com/research/next-generation-constitutional-classifiers)
- [SHADE-Arena: Sabotage Monitoring — Anthropic](https://www.anthropic.com/research/shade-arena-sabotage-monitoring)
- [Core Views on AI Safety — Anthropic](https://www.anthropic.com/news/core-views-on-ai-safety)
- [Human-in-the-Loop with Agents — LangChain](https://blog.langchain.dev/human-in-the-loop-with-agents/)
- [NIST AI Risk Management Framework](https://airc.nist.gov/AI_RMF_Knowledge_Base/Playbook)
- [Waymo Safety](https://waymo.com/safety)

---

## 3. Observation and Learning Architectures

### How the AI Learns Your Business

The AI doesn't learn by being told rules — it learns by watching your team work. This requires three layers:

```
Layer 1: CAPTURE — Record every human decision with context
Layer 2: DISCOVER — Find patterns in the event logs (process mining)
Layer 3: REPLICATE — Build workflow models from discovered patterns
```

### Layer 1: Event Logging Schema

You already have Supabase. Enable `supa_audit` on your key tables for free, automatic change tracking. Then add a structured decision log:

```sql
CREATE TABLE business_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL,        -- 'job_scheduled', 'material_ordered', 'quote_sent'
  case_id TEXT NOT NULL,           -- job reference (links events into workflows)
  actor TEXT NOT NULL,             -- 'marnin', 'nithin', 'ai_agent'
  action TEXT NOT NULL,            -- 'approved_quote', 'rescheduled_job'
  context JSONB,                   -- full snapshot: what did they know when deciding?
  reasoning TEXT,                  -- optional: why this decision? (for human decisions)
  confidence FLOAT,               -- for AI decisions: 0.0 - 1.0
  outcome TEXT,                    -- 'success', 'failed', 'revised'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_events_case ON business_events(case_id);
CREATE INDEX idx_events_type ON business_events(event_type);
CREATE INDEX idx_events_time ON business_events USING BRIN(created_at);
```

**The three mandatory fields for process mining:** `case_id` (job ref), `action` (activity name), `created_at` (timestamp). Everything else is bonus context that makes the AI smarter.

### Layer 2: Process Mining

Process mining discovers workflows from event logs. It answers: "How does my business actually work?" (not how I think it works).

**Tool:** [pm4py](https://github.com/process-intelligence-solutions/pm4py) — open-source Python library.

**How it works:**
1. Export `business_events` to CSV (case_id, action, created_at)
2. pm4py discovers the process model (which activities follow which)
3. Conformance checking: compare actual paths against expected paths
4. Identify deviations: "Crew B skips the material check step 40% of the time"

**What you'll discover:** The actual flow of a job from lead → scope → quote → approval → schedule → build → invoice. Where bottlenecks are. Where people skip steps. Where the AI should intervene.

### Layer 3: How Much Data Before the AI Can Replicate Decisions?

Research findings:

- **Agent Workflow Memory research:** Agents self-improved with **~40 successful examples** (22.5% performance increase)
- **DSPy framework:** Effective prompt optimisation with **"a few tens or hundreds of representative inputs"**
- **MIT research (2026):** The minimum data needed depends on decision structure, not raw volume. For bounded decision spaces (scheduling, quoting, ordering), hundreds not thousands.
- **Kaggle survey (2020):** 70% of ML practitioners completed projects with <10,000 samples

**For your business:** At 45 jobs/month, after 2-3 months of observation you'll have:
- ~100+ scheduling decisions
- ~100+ material ordering decisions
- ~90+ quote generation patterns
- ~50+ client communication templates

That's enough to start reliably predicting the right action for routine workflows.

### Sources
- [Supabase supa_audit — PostgreSQL Auditing](https://github.com/supabase/supa_audit) ⭐
- [Postgres Auditing in 150 Lines — Supabase Blog](https://supabase.com/blog/postgres-audit) ⭐
- [How Process Mining Works — Celonis](https://www.celonis.com/process-mining/how-does-process-mining-work/)
- [PM4Py — Python Process Mining Library](https://github.com/process-intelligence-solutions/pm4py)
- [CQRS Pattern — Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
- [ADR as AI Context](https://www.janisexplainsarchitecture.com/blog/ai-architecture-implementation/topic-012-architecture-decision-records-as-ai-context-why-your-ai-needs-to-know-what-youve-already-decided.html)
- [More Data Isn't Always Better — MIT / PYMNTS](https://www.pymnts.com/artificial-intelligence-2/2026/more-data-isnt-always-better-for-ai-decisions/)

---

## 4. Self-Improving AI Systems

### How the AI Gets Smarter (Without Fine-Tuning)

Three proven patterns for prompt-level and system-level learning:

### Pattern 1: Reflexion (Self-Critique Loop)

The AI tries, evaluates its own output, writes a critique, and tries again with the critique as context. The critiques are stored and injected into future prompts.

```
Attempt → Evaluate → Reflect → Store reflection → Next attempt uses reflection
```

**Real results:** GPT-4 with Reflexion achieved 91% on code generation vs 80% without.

**Your implementation:** After each AI decision, run a quick evaluation:
- Did the human accept or modify the recommendation?
- If modified, what changed?
- Store the delta as a "lesson learned" in a reflections table
- Inject recent reflections into future prompts for similar decisions

### Pattern 2: Langfuse Observability → Prompt Versioning

Deploy [Langfuse](https://langfuse.com) to track every LLM call. **Note:** Langfuse v3 requires ClickHouse + Redis + S3 (not just PostgreSQL). For your scale, use Langfuse Cloud free tier or build simple custom tracing to a Supabase table. Either way, track:
- What prompt was sent
- What response came back
- How long it took
- What it cost
- Whether the human accepted the result

Then: version your prompts. When you improve a prompt, tag it v2. Compare v1 vs v2 performance over 50+ decisions. Keep the winner.

**Key metrics to track:**
- Acceptance rate (% of AI recommendations humans approve unchanged)
- Correction rate (% that need modification)
- Override rate (% that humans completely replace)
- Latency (time from event to AI response)
- Cost per decision

### Pattern 3: DSPy Prompt Optimisation

[DSPy](https://dspy.ai/) is a framework that automatically discovers better prompts through compilation:
1. Define what the AI should do (input/output signature)
2. Provide 50-200 example inputs
3. DSPy's optimiser automatically discovers the best prompt structure, few-shot examples, and chain-of-thought patterns

**Real results:** Improved categorisation accuracy from 51.9% to 63.0% without manual prompt engineering.

**When to use:** After you have 2-3 months of decision data. Feed your `business_events` + outcomes into DSPy and let it discover the optimal prompts for each workflow.

### Drift Detection

Use statistical comparison of AI output distributions over time:
- **Prompt drift:** Are incoming messages/events changing character?
- **Output drift:** Are AI responses shifting away from the baseline?
- **Confidence drift:** Is the AI becoming more or less confident over time?

Tool: [Fiddler AI](https://www.fiddler.ai/) for drift monitoring, or build simple weekly comparisons in a Supabase edge function.

### Sources
- [Reflexion Framework — Prompt Engineering Guide](https://www.promptingguide.ai/techniques/reflexion) ⭐
- [Reflection in AI Agents — HuggingFace](https://huggingface.co/blog/Kseniase/reflection) ⭐
- [Langfuse — LLM Observability](https://langfuse.com/docs/observability/overview)
- [Langfuse — Prompt Management](https://langfuse.com/docs/prompt-management/overview)
- [LangSmith Practical Guide](https://bix-tech.com/langsmith-simplified-a-practical-guide-to-tracing-and-evaluating-prompts-across-your-ai-pipeline/)
- [DSPy Framework](https://dspy.ai/)
- [DSPy 0-to-1 Guide](https://github.com/haasonsaas/dspy-0to1-guide)
- [LLM Drift Monitoring — Fiddler AI](https://www.fiddler.ai/blog/how-to-monitor-llmops-performance-with-drift)

---

## 5. Multi-Channel AI Agents

### Architecture: One Brain, Multiple Interfaces

Your AI agent needs to be accessible from:
- **Telegram** (real-time chat — crew and ops)
- **Web dashboard** (structured views — CEO and office)
- **API** (automated triggers — edge functions, cron jobs)

The pattern: **Supabase is the single source of truth. All channels read/write through the same edge functions.**

```
Telegram Bot ──→ Edge Function (classify + route) ──→ AI Core (Claude)
Web Dashboard ──→ Edge Function (structured query) ──→ AI Core (Claude)
Cron Job ──────→ Edge Function (scheduled check)  ──→ AI Core (Claude)
                                                          ↓
                                                     Supabase DB
                                                    (single state)
```

### What to Learn From Slack AI and Notion AI

**Slack AI (2025):**
- User-scoped access: AI can only see data the requesting user can see
- Stateless per-request: all context passed fresh each time (no persistent AI memory between sessions)
- Event-driven: three core events trigger AI (thread started, message received, context changed)

**Notion AI (2025-2026):**
- Model routing: different models for different tasks (fast model for auto-fill, capable model for document generation)
- Structured context: every block has metadata and relationships, giving the AI deeply structured context
- LLM-as-judge evaluation: internal team uses AI to evaluate AI outputs

### Role-Based Access

| Role | Telegram Access | Dashboard Access | AI Capabilities |
|------|----------------|------------------|-----------------|
| **CEO (Marnin)** | Full — all commands, all data | Full — CEO dashboard | Full autonomy view, override any AI decision |
| **Sales (Nithin, Khairo)** | Sales pipeline, quotes, lead status | Sale dashboard | Quote generation, lead status, pricing queries |
| **Ops** | Schedule, crews, materials, job status | Ops dashboard | Schedule management, PO creation, crew dispatch |
| **Installers** | Job details, site photos, check-in/out | Trade dashboard | Job-specific info only, photo upload, time tracking |

**Implementation:** Pass `caller_role` and `caller_id` to every AI edge function. The system prompt changes based on role. Data queries are filtered by permission level.

### Telegram-Specific Patterns

- **grammY** (TypeScript) — has official Supabase Edge Functions docs at `grammy.dev/hosting/supabase`
- Supabase has an **official Telegram bot guide** using Deno edge functions + webhook (not polling)
- Use **Telegram WebApp** for structured forms (not just chat)
- **Inline keyboards** for approval buttons (not free-text replies)
- **Group vs DM:** Group messages = team coordination. DM = personal tasks and sensitive data.
- Real projects already exist: **Claudegram** (github.com/NachoSEO/claudegram) bridges Telegram → Claude Code with tool access and session memory

**Your architecture:**
```
Telegram webhook → Supabase Edge Function (Deno/grammY) → Claude API (Haiku) → Supabase DB → response back to Telegram
```

### Sources
- [How Slack Built Slack AI — Slack Engineering](https://slack.engineering/how-we-built-slack-ai-to-be-secure-and-private/) ⭐
- [Notion AI Architecture](https://www.notion.com/blog/speed-structure-and-smarts-the-notion-ai-way) ⭐
- [RBAC for AI Agents — NeuralTrust](https://neuraltrust.ai/blog/rbac-ai-agents) ⭐
- [Slack AI Developer Docs](https://docs.slack.dev/ai/developing-ai-apps/)
- [Telegram Bot + Dashboard Reference](https://github.com/coslynx/ai-telegram-bot-dashboard)

---

## 6. Real-World Examples of AI Operations Agents

### Construction AI Adoption (Reality Check)

A Connect CRE survey found **only 12% of construction firms have embedded AI** in their processes. 35% haven't used it at all. Administration leads at 59% of AI usage; design/planning is just 19%. What you're building is genuinely novel for an SME trades business — both a risk (less proven) and a competitive differentiator.

### Construction & Trades AI (What Exists Today)

| Company | What They Built | Result | Relevance |
|---------|----------------|--------|-----------|
| **Salesforce Agentforce (Field Service)** | AI scheduling, dispatch, troubleshooting for field teams | CPI Security: training 2mo→3wk. Axis Water: 35min/day faster dispatch. | Direct parallel to your crew scheduling |
| **BuildOps** | AI dispatch matching technician to job by skills + proximity | 80% of contractors say AI is essential for survival within 3 years | Construction-specific, validates your direction |
| **Procore + OpenAI** | AI document analysis, RFI generation for construction projects | Reduced admin time on document review by ~40% | Shows construction industry is adopting AI |

### Small Business AI Operations

| Platform | Cost | What It Does |
|----------|------|-------------|
| **Lindy.ai** | $49-299/mo | AI agents as virtual team members (lead qual, appointment booking, invoice follow-up) |
| **Beam.ai** | Custom | AI workflow agents for SMB operations |
| **Various (SIIT survey)** | $0-500/mo for small teams | Lead qualification, appointment booking, invoice follow-up, review response |

### Anthropic Computer Use — Honest Assessment

Claude can operate computers (read screens, click, type). But:
- **Real user report:** "Gets stuck constantly and consumes about $1 of tokens every 4 minutes of browsing"
- Struggles with resolutions above 1024x768
- Best for structured, repetitive tasks with human oversight
- **Not ready** for unsupervised business operations

**Verdict:** Use API-based tool calling (which is reliable and cheap), not computer use (which is expensive and fragile). Computer use is a fallback for tools that have no API.

### MCP (Model Context Protocol)

MCP is now the industry standard for connecting AI to business tools:
- 97M+ monthly SDK downloads
- Adopted by OpenAI, Google, Microsoft, AWS
- Official Supabase MCP server exists
- Donated to Linux Foundation (Dec 2025)

**For your stack:** Expose your Supabase tables and edge functions as MCP servers. Claude connects via MCP. One protocol for all integrations.

### The 35-Minute Rule

AIMultiple tested 18 LLMs and found: **agent performance drops significantly for tasks exceeding 35 minutes of equivalent human effort.** The sweet spot is tasks requiring 30-40 minutes of human time.

This means: break operations into discrete tasks, not "manage everything."

Good agent tasks: Schedule this job. Chase this invoice. Send this SMS. Generate this quote.
Bad agent tasks: Manage all operations for the week. Handle this complex client dispute.

### Sources
- [Salesforce Agentforce for Field Service](https://www.salesforce.com/news/stories/agentforce-for-field-service-announcement/) ⭐
- [BuildOps — AI in Field Service](https://buildops.com/resources/ai-in-field-service-management/) ⭐
- [Anthropic Computer Use Limitations — CIO](https://www.cio.com/article/3583260/how-anthropics-new-computer-use-ability-could-further-ai-automation.html)
- [A Year of MCP — Pento](https://www.pento.ai/blog/a-year-of-mcp-2025-review)
- [AI Agent Performance & 35-Min Rule — AIMultiple](https://aimultiple.com/ai-agent-performance)
- [AI Changing Org Charts — Fortune](https://fortune.com/2025/08/07/ai-corporate-org-chart-workplace-agents-flattening/)
- [AI Platforms for Small Business — SIIT](https://www.siit.io/blog/best-ai-agent-platforms-small-business)

---

## 7. The Cost and Scaling Model

### Claude API Pricing (March 2026)

| Model | Input/MTok | Output/MTok | Best For |
|-------|-----------|-------------|----------|
| **Haiku 4.5** | $1.00 | $5.00 | Classification, extraction, simple routing |
| **Sonnet 4.6** | $3.00 | $15.00 | Complex reasoning, scheduling, planning |
| **Opus 4.6** | $5.00 | $25.00 | Most capable — complex multi-step decisions |

**Cost reduction levers:**
- **Prompt caching:** 90% off repeated content (cache reads = 0.1x base price)
- **Batch API:** 50% off all models (24-hour processing window)
- **Combined:** Batch + caching = 95% input cost savings for overnight processing

### Your Estimated Monthly Cost

**Scenario:** 50-100 events/day, 10-20 complex decisions, 5 monitoring channels

| Task Type | Volume/Day | Model | Tokens/Call | Monthly Cost |
|-----------|-----------|-------|-------------|-------------|
| Message classification | 80 | Haiku 4.5 | ~500 in, ~100 out | ~$3.60 |
| Routine responses | 40 | Haiku 4.5 | ~1,000 in, ~500 out | ~$7.20 |
| Complex decisions | 15 | Sonnet 4.6 | ~2,000 in, ~1,000 out | ~$27.00 |
| Evaluator checks | 15 | Haiku 4.5 | ~1,500 in, ~200 out | ~$3.15 |
| Daily reports (batch) | 1 | Sonnet 4.6 (batch) | ~5,000 in, ~3,000 out | ~$2.03 |
| **Subtotal** | | | | **~$43/month** |
| Prompt caching savings (est. -30%) | | | | **-$13** |
| **Total estimated** | | | | **~$30-50/month** |

**With growth to full autonomy (2-3x volume):** ~$80-150/month

### Breakeven vs Human Ops Hire

Perth ops coordinator salary data (verified March 2026):
- SEEK (construction-specific): ~$77,214/yr
- Indeed (general): ~$95,930/yr
- With super (11.5%) + leave loading: **$86K-$107K total employment cost**

| | AI Agent | Human Ops Coordinator |
|--|----------|----------------------|
| Annual cost | $360-1,800 | $86,000-107,000 (total cost) |
| Available hours | 24/7/365 | ~1,920 hrs/year |
| Response time | Seconds | Minutes to hours |
| Scales with volume | Yes (linear cost) | No (step function) |
| Handles exceptions | Limited (escalates) | Good |
| Learns from mistakes | Systematically | Inconsistently |

**Breakeven: Essentially immediate.** At <1% of salary cost, the AI pays for itself if it saves even 30 minutes of human time per week.

**The real question isn't cost — it's capability.** The AI won't replace a human ops person. It will handle the 70-80% of routine decisions so the human can focus on the 20-30% that require judgment, relationships, and physical presence.

### Real-World Cost Benchmarks

- **Anthropic's own example:** 10,000 support tickets × 3,700 tokens each = ~$37 total using Opus 4.6
- **MetaCTO analysis:** RAG chatbot over 200K docs at 100 queries/hr costs $60/hr without caching, $7.14/hr with caching (88% savings)
- **BCG study of 1,250 companies:** Average ROI 1.7x for companies that move from pilots to production. 6-18 months for initial gains.

### Sources
- [Anthropic Official Pricing](https://platform.claude.com/docs/en/about-claude/pricing) ⭐
- [MetaCTO — Claude API Cost Breakdown](https://www.metacto.com/blogs/anthropic-api-pricing-a-full-breakdown-of-costs-and-integration) ⭐
- [Economics of AI Agents — Brim Labs](https://brimlabs.ai/blog/the-economics-of-ai-agents-faster-outcomes-lower-costs-higher-roi/)
- [AI ROI: Why Only 5% See Returns — Master of Code / BCG](https://masterofcode.com/blog/ai-roi)
- [AI Agent ROI Calculator — Blue Prism](https://www.blueprism.com/resources/blog/ai-agent-roi/)
- [AI Platforms for Small Business — SIIT](https://www.siit.io/blog/best-ai-agent-platforms-small-business)

---

## What's Production-Ready vs Experimental

| Component | Status | Recommendation |
|-----------|--------|----------------|
| Claude API tool calling | ✅ Production-ready | Use directly. No framework needed. |
| Prompt caching | ✅ Production-ready | Enable immediately for all system prompts |
| Batch API | ✅ Production-ready | Use for reports, overnight processing |
| MCP protocol | ✅ Production-ready | Use for Supabase integration |
| Langfuse observability | ⚠️ V3 needs ClickHouse+Redis+S3 | Use Langfuse Cloud free tier, or build simple custom logging to Supabase |
| Telegram bot (grammY) | ✅ Production-ready | Mature framework, good TypeScript support |
| Evaluator-Optimizer pattern | ✅ Production-ready | Anthropic-recommended for high-stakes decisions |
| Reflexion/self-improvement | ⚠️ Emerging | Implement after 3+ months of observation data |
| DSPy prompt optimisation | ⚠️ Emerging | Evaluate at month 3-4 when you have enough data |
| Process mining (pm4py) | ⚠️ Niche but proven | Run periodic batch analysis, not real-time |
| Computer use | ❌ Experimental | Don't use. Too expensive, too fragile. Use API tools. |
| Full autonomous agents | ❌ Not ready for business | Start with workflows. Graduate carefully. |

---

## Action Plan: What to Build and When

### Month 1: Foundation (L0 → L1)
1. Enable `supa_audit` on jobs, quotes, schedules tables
2. Create `business_events` table with the schema above
3. Set up LLM observability (Langfuse Cloud free tier, or custom tracing table in Supabase)
4. Build Telegram bot with Haiku classifier → route to edge functions
5. Implement first 3 workflows: morning briefing, job status queries, schedule lookup

### Month 2-3: Observer Mode (L1)
6. AI drafts actions, humans approve everything via Telegram
7. Log every decision + outcome to business_events
8. Track acceptance rate, correction rate, override rate
9. Run first pm4py analysis on accumulated event logs
10. Identify top 3 workflows where AI accuracy >90%

### Month 3-6: Selective Autonomy (L1 → L2)
11. Remove human gates on workflows with >95% accuracy over 50+ decisions
12. Implement Evaluator-Optimizer for remaining workflows
13. Add confidence scoring to every AI decision
14. Deploy drift detection (weekly comparison reports)
15. Start DSPy optimisation on highest-volume workflows

### Month 6-9: Conditional Autonomy (L2 → L3)
16. AI handles routine operations end-to-end within defined domains
17. Expand to more complex workflows (PO creation, schedule optimisation)
18. Implement Reflexion pattern for continuous self-improvement
19. Human role shifts to exception handling and strategic decisions

### Month 9-12: High Autonomy (L3 → L4)
20. AI manages most daily operations
21. Human oversight = weekly reviews + exception handling
22. Kill switch always available
23. Continuous monitoring and drift detection

---

## Tensions and Trade-offs

### Build vs Buy
**Build.** At your scale, packaged AI ops tools (Lindy, Beam) are generic. Your competitive advantage is a system that knows YOUR business intimately. The build cost is mostly your time + $30-50/month API. Buy options cost $300-500/month and won't integrate with your Supabase/GHL/Xero stack without custom work anyway.

### Single Agent vs Multi-Agent
**Single agent.** Every credible source (Anthropic, Latent Space, Simon Willison) recommends starting simple. Multi-agent adds coordination overhead, debugging complexity, and failure modes that aren't justified at 45 jobs/month.

### Framework vs Direct API
**Direct API.** Your Supabase edge functions already handle state, routing, and tool execution. Adding LangGraph or CrewAI would add abstraction layers that make debugging harder without giving you capabilities you don't already have.

### MCP vs Direct Integration
**Start with direct API, adopt MCP selectively.** Your edge functions already work. MCP is valuable when you need to expose your data to multiple AI clients (e.g., Claude Code for development + your production agent + a reporting agent). Adopt when the multi-client use case appears.

### Speed vs Safety
**Safety wins, always.** An AI that sends a wrong quote or schedules the wrong crew costs real money and real reputation. The cost of being 5 minutes slower is zero. The cost of being wrong is high. Err toward more human oversight, not less.

---

## Blind Spots and Risks

1. **Physical reality gap.** All the AI research is about digital operations. Your business happens in the physical world. The AI can schedule a crew, but it can't verify they actually showed up or that the concrete was poured correctly. You need a human bridge between AI decisions and physical verification.

2. **Unstructured field data.** Installers will send blurry photos, voice notes, and half-sentences via Telegram. The AI needs to handle messy, real-world input — not just clean structured data. Budget for a "normalisation layer" that cleans input before AI processing.

3. **Small sample sizes.** 45 jobs/month means 45 data points/month. For some niche decisions (e.g., "what to do when a supplier is 2 weeks late on gable materials"), you may only see 2-3 examples per year. The AI will struggle with rare events. Keep humans in the loop for anything the AI has seen fewer than 20 times.

4. **Model dependency.** You're building on Claude. If Anthropic raises prices 10x, changes the API, or discontinues a model, your system breaks. Mitigation: keep tool definitions generic (not Claude-specific), use MCP for standardised interfaces, and design for model-swappability.

5. **Team adoption.** The biggest risk isn't technical — it's whether your 6 team members actually use the system. If they bypass the AI and do things the old way, the observation data is incomplete and the system can't learn. You need buy-in, training, and a gradual rollout that proves value before demanding change.

---

*Research conducted March 2026. 40+ sources collected across 5 parallel research agents. Synthesised via NotebookLM (Gemini) + Claude validation. NotebookLM notebook preserved for future queries.*
