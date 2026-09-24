/**
 * Multi-Agent Deep Analysis Pipeline
 *
 * Instead of dumping an entire Reddit history (7000+ items) into a single LLM call,
 * this module dispatches specialized sub-agents that each focus on one domain:
 *
 *   1. Identity & Demographics      — age, name, gender, family + behavioral/psych signals
 *   2. Geography & Career           — city, commute, landmarks + schools, jobs, employers
 *   3. Digital Footprint            — usernames, devices, platforms, cross-platform traces
 *
 * Each sub-agent receives only the top-ranked relevant items for its domain
 * (deterministic relevance cap in rank.ts, default 200), so a 7,000-item history
 * costs ~1 LLM chunk per domain instead of the old fanout's dozens of sequential
 * chunks. All three domains run in parallel.
 *
 * Domain count was cut 5 → 3 (psychology → identity, education/career → geo) to
 * eliminate the per-domain cold-start + consolidation calls; the synthesis agent
 * still produces every report section from the merged sub-reports.
 *
 * A final Synthesis Agent combines all sub-reports into a unified OSINT report.
 *
 * Uses the OpenAI-compatible runtime to create independent calls for each sub-agent.
 */

import { promptOnce } from "../runtime/llm.ts";
import { runAgentWithTools } from "../runtime/agent.ts";
import { buildWebTools } from "../runtime/tools.ts";
import { mcpWebPreferred, mcpWebNote, webToolsAvailable } from "../runtime/providers/index.ts";
import { resolveModel } from "../config/models.ts";
import type { Candidate, FilteredItem } from "../types.ts";
import { formatObjectiveContext } from "../prompts.ts";
import { heuristicFilter } from "./filter.ts";
import { extractDirectIdentifiers, renderDirectIdentifiersBlock, renderModelMentionedBlock } from "./extract.ts";
import { extractStructuredFindings, renderStructuredFindings, buildCorpusManifest, validateStructuredFindings, type StructuredFindings } from "./findings.ts";
import type { DirectIdentifiers } from "./extract.ts";
import type { RedditPost, RedditComment } from "../reddit/fetch.ts";
import { buildKeywordWeights, rankAndCapBucket, handleKey, maxItemsPerDomain } from "./rank.ts";

// ── Domain definitions ────────────────────────────────────────────────────

interface Domain {
  id: string;
  label: string;
  icon: string;
  keywords: string[];
  subreddits: string[];
  prompt: string;
}

export const DOMAINS: Domain[] = [
  {
    id: "identity",
    label: "Identity & Demographics",
    icon: "👤",
    keywords: [
      // Age/birthday
      "my age",
      "i'm ",
      "i am ",
      "years old",
      "birthday",
      "born in",
      "my name",
      "call me",
      "i go by",
      "real name",
      // Partial name / name fragments
      "my surname",
      "my last name",
      "my first name",
      "name on",
      "well done mr",
      "mr ",
      "people call me",
      "friends call me",
      "named after",
      "my initials",
      "name is",
      // Third-person framing (likely self-reference)
      "my friend works",
      "someone i know",
      "a colleague of mine",
      "my friend who",
      "i know someone at",
      "a friend of mine at",
      "my buddy",
      "a guy i know",
      "a girl i know",
      // Gender/physical
      "male",
      "female",
      "guy",
      "girl",
      "man",
      "woman",
      "boy",
      "girlfriend",
      "boyfriend",
      "height",
      "weight",
      "tall",
      "short",
      // Family
      "my dad",
      "my mom",
      "my father",
      "my mother",
      "my parents",
      "my brother",
      "my sister",
      "my wife",
      "my husband",
      "my partner",
      "my kids",
      "my son",
      "my daughter",
      "family",
      "married",
      "single",
      "divorced",
      "engaged",
      // Ethnicity/nationality
      "indian",
      "american",
      "from india",
      "from the us",
      "nationality",
      "vegetarian",
      "vegan",
      "diet",
      // Psychology & Behavioral (absorbed — the old standalone domain was merged
      // in to cut the sub-agent fanout; see rank.ts for the coverage story)
      "depression",
      "anxiety",
      "adhd",
      "burnout",
      "stress",
      "therapy",
      "therapist",
      "counseling",
      "mental health",
      "lonely",
      "isolated",
      "no friends",
      "social anxiety",
      "trauma",
      "ptsd",
      "bullying",
      "abuse",
      "abusive",
      "coping",
      "motivation",
      "discipline",
      "procrastinat",
      "addiction",
      "alcohol",
      "smoking",
      "insomnia",
      "hopeless",
      "regret",
      "guilt",
      "shame",
      "scared",
      "worried",
    ],
    subreddits: [
      "teenagers",
      "GetMotivatedBuddies",
      "TeensMeetTeens",
      "r4r",
      "relationships",
      "relationship_advice",
      "dating",
      "datingoverthirty",
      "TrueOffMyChest",
      "CasualConversation",
      "confession",
      "TwentiesIndia",
      "GenZIndia",
      "india",
      "indiasocial",
      "entitledparents",
      "insaneparents",
      "raisedbynarcissists",
      // Psychology & Behavioral (absorbed)
      "depression",
      "anxiety",
      "ADHD",
      "mentalhealth",
      "therapy",
      "getmotivated",
      "selfimprovement",
      "survivorsofabuse",
    ],
    prompt: `You are a de-anonymization analyst specializing in identity and demographics extraction. Your goal is to help resolve the real-world identity behind this Reddit account. Aggregate weak signals across many posts into stronger conclusions.

Analyze the Reddit posts and comments below. Extract EVERY concrete identity marker you can find.

## YOUR FOCUS: Identity & Demographics

Extract and report on:
- **Age**: exact age, birth year, birthday, zodiac sign, or age range with evidence. When deriving age from a degree timeline, apply standard enrollment-age norms: a bachelor's starts at ~18 (Indian BSc/B.Tech 3–4yr, US/EU 4yr), a master's at ~21–22. Write out the arithmetic (milestone → enrollment year − 18 → birth year → current age) and keep it internally consistent. Do NOT assume a non-traditional ~21 start age for a standard bachelor's unless the evidence forces it.
- **Name**: real first name, surname, nicknames, handles, any name mentioned as theirs
  - Also capture PARTIAL names — first name only, nicknames, "my name starts with", "people call me", etc.
  - Capture name fragments from direct references only when the context supports that they refer to the account holder
- **Gender**: with evidence
- **Physical description**: height, weight, appearance mentions
- **Family composition**: parents, siblings, partner, children — names, ages, relationships
  - Family members' professions can be exposure markers ("my dad's tax firm", "my father works in wealth management")
- **Nationality/ethnicity**: citizenship, origin, immigration status
- **Diet/lifestyle**: vegetarian, vegan, religious dietary restrictions
- **Relationship status**: single, dating, married, divorced — timeline of changes
- **Third-person framing**: When they say "my friend works at X" or "someone I know does Y" — flag these as POTENTIAL SELF-REFERENCES. People often describe their own jobs/experiences this way for deniability. Note the evidence for and against.

## RULES
1. Every claim MUST cite the specific comment/post with date and subreddit
2. Flag sarcasm/irony with ⚠️ — especially from meme subs
3. Don't guess. If uncertain, write "unclear" with your reasoning
4. Show temporal changes — note when relationship status changed, when they moved, etc.
5. Be exhaustive — partial clues like "I'm in my twenties" or "my dad works in banking" are identity leads; combine many of them to narrow the person
6. Deleted content is marked [DELETED] — it's often the most revealing
7. Treat partial names and name fragments as high-value leads toward resolving the real identity. Record every one (first names, nicknames, initials, "people call me") — these are the primary keys to attribution.
8. When you find a "my friend works at [company]" pattern, note: (a) the company named, (b) whether the user has matching skills/knowledge for that role, (c) whether they show emotional investment in the topic suggesting personal stake

## OUTPUT FORMAT
For each finding, use this format:
**[Category]**: Finding
- Evidence: [date] r/subreddit — "exact quote"
- Confidence: HIGH/MEDIUM/LOW
- Notes: any caveats

## SECONDARY FOCUS: Psychology & Behavioral (merged domain — keep it subordinate to concrete identity markers)
Also extract, in service of attributing the account:
- **Mental health indicators**: signs consistent with depression, anxiety, ADHD, burnout, trauma — "consistent with", not diagnostic
- **Stressors & coping**: what is causing stress (family, work, academics, money) and how they cope
- **Recurring themes**: what they post about repeatedly (obsessions, anxieties, aspirations)
- **Temporal changes**: when did their mental state shift? What triggered it?
Be clinical ("consistent with", not "has"); flag ironic self-deprecation from meme subs with ⚠️; look for patterns, not isolated incidents; deleted mental-health content is especially revealing.

End with these sections:
1. **PARTIAL NAME REGISTRY** — every name fragment found, even uncertain ones
2. **THIRD-PERSON FRAMING LOG** — every instance of "my friend/colleague/someone I know" that could be self-reference, with analysis
3. **PSYCHOLOGICAL TIMELINE** — changes in mental state over time
4. **SUMMARY** table of all identity markers found`,
  },

  {
    id: "geo_career",
    label: "Geography & Career",
    icon: "\ud83c\udf10",
    keywords: [
      // Location
      "live in",
      "moved to",
      "moved from",
      "relocated",
      "commute",
      "metro",
      "station",
      "area",
      "neighborhood",
      "near",
      "local",
      "my city",
      "my area",
      "street",
      "road",
      "highway",
      "district",
      "sector",
      "colony",
      "km from",
      "miles from",
      "drive to",
      "bus to",
      "train to",
      "apartment",
      "flat",
      "house",
      "rent",
      "landlord",
      "weather",
      "rain",
      "hot",
      "cold",
      "summer",
      "winter",
      "coffee shop",
      "restaurant",
      "mall",
      "park",
      "gym",
      "hyderabad",
      "delhi",
      "mumbai",
      "bangalore",
      "chennai",
      "pune",
      "kolkata",
      "india",
      "us",
      "uk",
      "canada",
      "australia",
      "telugu",
      "hindi",
      "tamil",
      "marathi",
      "kannada",
      "bkc",
      "andheri",
      "goregaon",
      "vile parle",
      "juhu",
      // Education & Career
      "school",
      "college",
      "university",
      "degree",
      "bachelor",
      "master",
      "phd",
      "graduation",
      "graduated",
      "semester",
      "exam",
      "certification",
      "certificate",
      "ceh",
      "cissp",
      "azure",
      "aws",
      "google cloud",
      "comptia",
      "job",
      "work",
      "company",
      "employer",
      "salary",
      "package",
      "ctc",
      "intern",
      "internship",
      "offer",
      "resignation",
      "notice period",
      "startup",
      "llc",
      "founding",
      "founder",
      "co-founder",
      "cybersecurity",
      "developer",
      "engineer",
      "analyst",
      "manager",
      "remote",
      "hybrid",
      "office",
      "wfh",
      "onsite",
      "promoted",
      "promotion",
      "hired",
      "fired",
      "laid off",
      "tax firm",
      "edtech",
      "fintech",
      "bank",
      "consulting",
      "boi filing",
      "registered agent",
      "delaware",
      "c-corp",
      "my friend works",
      "someone i know",
      "a colleague of mine",
      "my friend who",
      "i know someone at",
      "a friend of mine at",
      "in my firm",
      "at my company",
      "my employer",
      "our team",
      "credit risk",
      "quant",
      "portfolio",
      "compliance",
      "audit",
      "corporate discount",
      "notice period",
      "payroll",
      "onboarding",
    ],
    subreddits: [
      "hyderabad",
      "delhi",
      "mumbai",
      "bangalore",
      "chennai",
      "pune",
      "india",
      "indiasocial",
      "indianstartups",
      "IndianWorkplace",
      "TwentiesIndia",
      "GenZIndia",
      "apartments",
      "rent",
      "realestate",
      "cybersecurity",
      "cissp",
      "netsec",
      "asknetsec",
      "career",
      "careerguidance",
      "cscareerquestions",
      "jobs",
      "IndiaCareers",
      "startups",
      "llc",
      "smallbusiness",
      "entrepreneur",
      "LegalAdviceIndia",
      "consulting",
    ],
    prompt: `You are a de-anonymization analyst specializing in geographic location extraction AND education/career profiling. Precise location, employers, schools, and certifications are direct attribution anchors — capture every one.

Analyze the Reddit posts and comments below. Extract EVERY location, education, and career signal.

## YOUR FOCUS: Location & Geography
- **Current city**: with neighborhood precision if possible
- **Previous cities**: moves, relocations, timeline
- **Specific landmarks**: places mentioned (cafes, malls, stations, offices)
- **Commute patterns**: routes, transit stops, distances
- **Dialect/language clues**: regional slang, language patterns
- **Local knowledge**: references only a local would know
- **Time zone indicators**: posting times, reference to local time
- **Address fragments**: street names, building names, area codes

## YOUR FOCUS: Education & Career
- **Current job**: title, industry, company type, work location
- **Previous jobs**: timeline of employment, reasons for leaving
- **Education**: institutions, degrees, graduation year, mode (online/distance/on-campus)
- **Certifications**: held, planned, in-progress — with dates
- **Skills**: technical skills, tools, platforms mentioned
- **Employer clues**: company name, type, size — piece together clues from industry + location + role + timeline
- **Salary/compensation**: any mention of pay, package, CTC
- **Startup activity**: entrepreneurial ventures, LLC formation, business ideas
- **Career timeline**: chronological progression

### CRITICAL: Third-Person Employer Framing
People frequently disguise their own employment by attributing it to others. Look for:
- "My friend works at [company]" — they might be describing THEIR OWN job
- "Someone I know at [company] said..." — they have insider knowledge because THEY work there
- "A colleague of mine..." — explicitly admits working at the same place
For each: note the company, whether the user shows insider knowledge, whether their skills match, and emotional investment. Mark likely self-references as **[LIKELY SELF-REFERENCE: X% confidence]**.

## RULES
1. Every claim MUST cite the specific comment/post with date and subreddit
2. Small clues matter — "the metro from Goregaon" is a strong location signal
3. Note when they moved — "just moved to X" or "used to live in Y"
4. Local subreddit membership (r/hyderabad) is strong evidence
5. Distinguish between what they DO vs what they WANT to do
6. Note the timeline — "I'm in my 2nd year" + date = graduation year estimate
7. Employer evidence: piece together clues (industry + location + role + size + timeline)
8. Deleted posts about jobs can contain sensitive employer names
9. ALWAYS flag third-person employer mentions and analyze whether they're self-referential

## OUTPUT FORMAT
For each finding:
**[Category]**: Finding
- Evidence: [date] r/subreddit — "exact quote"
- Confidence: HIGH/MEDIUM/LOW
- Notes: any caveats

End with three sections:
1. **LOCATION TRIANGULATION** — narrowed to specific neighborhoods/areas
2. **CAREER TIMELINE** — chronological progression
3. **EMPLOYER EVIDENCE** — all employer clues combined
4. **THIRD-PERSON FRAMING LOG** — every "my friend/someone I know" employer mention`,
  },

  {
    id: "digital",
    label: "Digital Footprint & Cross-Platform",
    icon: "🌐",
    keywords: [
      "discord",
      "instagram",
      "linkedin",
      "twitter",
      "x.com",
      "github",
      "telegram",
      "whatsapp",
      "signal",
      "snapchat",
      "tiktok",
      "email",
      "@",
      "phone",
      "number",
      "username",
      "handle",
      "account",
      "profile",
      "macbook",
      "iphone",
      "android",
      "windows",
      "linux",
      "nothing phone",
      "pixel",
      "samsung",
      "oneplus",
      "browser",
      "chrome",
      "firefox",
      "arc",
      "safari",
      "vpn",
      "proxy",
      "tor",
      "adblock",
      "openai",
      "chatgpt",
      "claude",
      "cursor",
      "copilot",
      "zomato",
      "swiggy",
      "uber",
      "ola",
      "rapido",
      "reddit",
      "subreddit",
      "moderator",
      "karma",
      "hinge",
      "tinder",
      "bumble",
      "dating app",
      "letterboxd",
      "goodreads",
      "spotify",
    ],
    subreddits: [
      // No specific subreddit filter — digital traces are scattered everywhere
    ],
    prompt: `You are a de-anonymization analyst specializing in digital footprint and cross-platform attribution. Reused usernames, emails, and external links are the strongest keys to resolving identity across platforms.

Analyze the Reddit posts and comments below. Extract EVERY digital footprint and cross-platform trace.

## YOUR FOCUS: Digital Footprint & Cross-Platform Traces

Extract and report on:
- **Other usernames**: Discord, Instagram, Twitter, GitHub, LinkedIn handles
- **Email addresses**: even partial ones (e.g., "my work email is first.last@...")
- **Phone/devices**: model, OS, carrier, case descriptions
- **Browser/software**: what browser, extensions, dev tools they use
- **Apps/services**: Zomato, Swiggy, Uber, dating apps, streaming services
- **AI tools**: ChatGPT, Claude, Cursor, Copilot — plan types (Pro, Plus, free)
- **Reddit metadata**: subreddits they moderate, karma milestones, account age
- **Online communities**: Discord servers, subreddits created, moderation activity
- **Security practices**: VPN use, ad blockers, privacy tools
- **Cross-reference patterns**: username patterns that could be exposure risks across platforms

## RULES
1. Even PARTIAL usernames are strong attribution leads — "my Discord is Psychomerc..." is a direct cross-platform key. Record every handle, email, and external URL.
2. Every claim MUST cite the specific comment/post with date and subreddit
3. Note the context — are they sharing their OWN handle or someone else's?
4. Device mentions are temporal — "my iPhone 8+" from 2023 ≠ current device
5. Dating app mentions can reveal relationship timeline
6. Moderator/creator of subreddits is a strong identity anchor
7. Food delivery profiles (Zomato) can expose real names; treat them as sensitive and cite only what appears in evidence

## OUTPUT FORMAT
For each finding:
**[Category]**: Finding
- Evidence: [date] r/subreddit — "exact quote"
- Confidence: HIGH/MEDIUM/LOW
- Exposure risk: how this marker could reveal or confirm identity

End with a CROSS-PLATFORM ATTRIBUTION section listing every handle, service, email, phone fragment, and external URL found, plus the exact platform-check queries (e.g. site:github.com "<handle>") that would resolve the cross-platform identity.`,
  },
];

// ── Synthesis agent prompt ──────────────────────────────────────────────

const SYNTHESIS_PROMPT = `You are the lead de-anonymization analyst producing the final identity-resolution report. You have received specialized reports from three sub-agents (Identity & Psychology, Geography & Career, Digital Footprint). Your PRIMARY objective is to name the real person behind u/{username}: synthesize the sub-reports into ONE coherent report, resolve contradictions, and — when web tools (web_search / web_scrape) are available — actively hunt the public web to discover and verify their other online identities.

## GROUND TRUTH ABOUT TIME
Today's date is {TODAY}. EVERY timestamp in the sub-reports below is the real, literal date a Reddit post/comment was made. Do NOT label any date as "future", "anomalous", a "timestamp error", or a "data artifact" — all of them are in the past. Compute the subject's CURRENT age and elapsed time relative to {TODAY}. Never invent a "date of synthesis".

## AGE INFERENCE CALIBRATION (do this explicitly — age errors are the most common failure)
Age is frequently mis-estimated because of a wrong assumption about TYPICAL ENROLLMENT AGE. Apply these norms and SHOW the arithmetic; never state a final age without the computation.

Education-system norms (use these unless there is direct evidence the subject is non-traditional):
- **Indian BSc / BA / BCom / BBA**: 3-year program, starts at age **~18** (immediately after 12th grade, age 17–18). Distance/online variants follow the same nominal duration and typical start age.
- **Indian B.Tech / B.E.**: 4-year program, starts at age **~18**.
- **US/EU bachelor's**: 4-year, starts at age **~18**.
- **Master's (MSc/MBA/M.Tech)**: starts at age **~21–22**.

Required computation chain (write it out):
1. From the evidence, fix the most recent dated education milestone (e.g. "2nd year in Nov 2024").
2. Derive the **enrollment year** ("2nd year" = academic year Y−1/Y → enrolled ~Y−2; so 2nd year in late-2024 → enrolled ~2023).
3. Apply the **normative start age** for that degree (≈18 for a bachelor's) → **birth_year = enroll_year − ~18**.
4. **current_age = today_year − birth_year** (today_year = {TODAY} year).
5. Sanity-check the result against: (a) Reddit account creation date (cake day) — a younger estimate is more consistent with a recent cake day; (b) age-bracket subreddits like r/TwentiesIndia (implies ~20–29); (c) stated age/zodiac if any.

CONSISTENCY RULE: the "started at age X" assumption, the derived birth year, and the final current age MUST agree. If you assume "started at 18" you CANNOT conclude "born ~2001" — that would imply starting at 18 in ~2019, contradicting a 2023 enrollment. Re-derive until the chain is internally consistent. **A 3-year bachelor's "2nd year" statement almost always implies the subject is in their early ~20s NOW, not mid-20s.** Prefer the younger, normative inference unless direct evidence (a stated age, a graduation year that forces an older start, a profession requiring years of post-grad experience) says otherwise. Label age confidence MEDIUM (not HIGH) when it rests only on the degree timeline.

## YOUR TASK
1. **Resolve the identity** — this is the top priority. Combine the weak signals from all five sub-reports (a timezone, a commute, a reused username, a "my company" aside, a writing fingerprint) into the strongest possible real-world attribution. Name the most likely real person (or rank candidates) and justify with a reasoning chain.
2. **Cross-reference findings** across sub-reports and reconcile timelines (e.g., Identity says "22M" + Education "graduated 2021" must be consistent).
3. **Resolve contradictions** — pick the stronger evidence and explain briefly.
4. **Connect patterns** across domains (a location + a job + a school + handles).
5. **Build a timeline** of ALL life events discovered.
6. **Assess confidence** — rate each marker HIGH/MEDIUM/LOW by how many independent sources confirm it.
7. **When web tools are available, USE THEM** (see WEB INTELLIGENCE) to find and verify the subject's other usernames/accounts BEFORE writing the Digital Footprint section.
8. If a candidate identity hypothesis was provided, test it explicitly: confirm or refute it against the evidence.

## REPORT STRUCTURE (produce in this exact order)

### 1. EXECUTIVE SUMMARY — PERSON BRIEF
This is the MOST important section and MUST come first. Write a tight, specific, plain-English snapshot the reader can absorb in ~15 seconds. Open with ONE sentence stating who this person most likely is, then a compact block of crisp fields. No vague hedging, no padding. Cover every field below that is inferable; for any field that is not, write "unknown":
- **Possible location** — city + specific area/neighborhood (e.g., "Uppal area, eastern Hyderabad").
- **Country / nationality**.
- **Estimated age** — a NARROW range with one-line reasoning (e.g., "~20–21 (2nd-year BSc, graduating 2026)").
- **Gender**.
- **Background / socioeconomic feel** — e.g., "middle-class suburban", "tier-2 city student", "metro IT-corridor commuter".
- **Education** — type + mode (e.g., "distance/online BSc Cybersecurity, expected 2026").
- **Past & current employment** — the real jobs/timeline in one line.
- **Profession & aspirations** — what they do / train for / want to become (e.g., "self-taught cybersecurity learner chasing CEH/CISSP + pentest certs, aiming for a security role").
Keep the whole brief to ~120–180 words. Be concrete — this is the section readers actually use.

### 2. IDENTITY MARKERS
Table of every identifying marker with evidence and confidence. Include a **Partial Name Registry** (every first name, nickname, surname fragment, or name-like word that appears to refer to the account holder, with caveats).

### 3. IDENTITY RESOLUTION & CANDIDATE VERIFICATION
First, state the single most likely real-world identity behind u/{username} (or a ranked candidate list if no single identity dominates), with the reasoning chain that combines the weak signals, and any public proof URLs (GitHub, LinkedIn, personal site, profile pages). Give an overall attribution confidence (HIGH/MEDIUM/LOW). If a specific candidate identity hypothesis was provided, assess whether the evidence is CONSISTENT, INCONCLUSIVE, or CONFLICTING with it, citing evidence for and against. If you cannot yet name the person, say so and list the specific missing evidence that would resolve it.

### 4. THIRD-PERSON FRAMING ANALYSIS
Every instance where the user attributes their own experience to "a friend", "someone I know", "a colleague". For each: the exact quote/framing, why it's likely self-referential (matching timeline/skills/intimate knowledge/emotional investment), and what it reveals.

### 5. LOCATION TRIANGULATION
Current and previous locations, narrowed to neighborhood precision — sourced from the Geography & Career sub-report.

### 6. EDUCATION & CAREER
Timeline of education and employment with specific institutions/companies — sourced from the Geography & Career sub-report. Include an **Employer Evidence** subsection that pieces together employer clues (industry + location + role + company type) without inventing names.

### 7. PSYCHOLOGICAL PROFILE
Mental state, personality, behavioral patterns — sourced from the Identity & Psychology sub-report.

### 8. DIGITAL FOOTPRINT & CROSS-PLATFORM ATTRIBUTION
Devices, platforms, and handles discovered. When web tools were used, report cross-platform findings here (see WEB INTELLIGENCE). Never claim an external account is the same person from a username match alone.

### 9. TIMELINE
Chronological list of all life events discovered.

### 10. ATTRIBUTION, LEADS TO PURSUE & GAPS
- Overall confidence in the real-world attribution and the reasoning chain behind it.
- Concrete leads to pursue next: platforms still to check, usernames/names to verify, subreddits or date ranges worth re-scanning, and the specific missing evidence that would most raise attribution confidence.
- Cross-platform usernames/URLs discovered or explicitly disclosed by the Reddit account.
- Knowledge gaps and remaining uncertainty.

## WEB INTELLIGENCE (use when web_search / web_scrape tools are available)
You MUST proactively use web tools to look for the subject's other online identities. Do this before writing the Digital Footprint section:
- Search the Reddit username in quotes, then on specific platforms: GitHub, X/Twitter, Instagram, LinkedIn, Telegram, Discord, Medium, dev.to, HackTheBox, TryHackMe, and the Reddit profile itself.
- **CRITICAL: Bridge-owner cross-platform expansion.** When the deterministic leads show a BRIDGE (e.g. github.com/fixturenew mentions fixtureveil), the page owner (fixturenew) is the subject's CURRENT identity — the renamed handle they actively use. You MUST search for that NEW handle on Instagram, YouTube, Twitter/X, LinkedIn, TikTok, Telegram, etc. This is the single highest-value web search you can perform — the new handle will have active profiles the old handle never will.
- Try sensible variants and any handle fragments surfaced in the sub-reports.
- web_scrape the most promising profiles to actually read them.
- Cross-reference each hit against the Reddit identity markers (location, school, certs, employer, writing style, timeline).
- Label every external account: **CONFIRMED** (name/URL explicitly disclosed on Reddit), **LIKELY** (username + multiple matching markers, no conflicts), **POSSIBLE** (username match only or partial markers), or **REJECTED** (username matches but profile conflicts with the Reddit evidence).
- Report the URL and evidence for each label. Never fabricate URLs or profiles. If you find nothing, say so plainly.

## RULES
1. Every claim cites at least one piece of evidence with date and subreddit.
2. Don't repeat the sub-agent reports — synthesize and resolve.
3. Flag any inconsistencies between sub-reports.
4. Be clinical and direct — no narration, no editorializing.
5. When a user says "my friend works at X" / "I know someone at Y" — flag as a POTENTIAL SELF-REFERENCE with evidence for and against.
6. Aggregate weak signals into strong conclusions — always show the reasoning chain.
7. Partial names and handles are leads toward attribution: record them and note how they'd be verified, but never fabricate a person, name, or URL.
8. Never assert a cross-platform account belongs to this person from a username match alone.`;

// ── Data categorization ────────────────────────────────────────────────────

const MAX_ITEMS_PER_AGENT_CHUNK = 180;
const MAX_PROMPT_CHARS = 90_000;
const MAX_CHARS_PER_ITEM = 1_200;
const MAX_REPORTS_PER_CONSOLIDATION = 6;

/**
 * Categorize filtered items into domain buckets based on keywords and subreddits.
 * Items can appear in multiple buckets (a comment about "my job in Mumbai" goes to both
 * Location and Education/Career).
 */
export function categorizeItems(items: FilteredItem[]): Map<string, FilteredItem[]> {
  const buckets = new Map<string, FilteredItem[]>();
  for (const domain of DOMAINS) {
    buckets.set(domain.id, []);
  }

  // Also add a "deleted" bucket — deleted items are always high-value
  // We'll add deleted items to ALL agents
  const deletedItems = items.filter(
    (item) => item.is_deleted || item.is_removed,
  );

  for (const item of items) {
    const text = ((item.body ?? "") + " " + (item.title ?? "")).toLowerCase();
    const sub = item.subreddit.toLowerCase();

    for (const domain of DOMAINS) {
      const bucket = buckets.get(domain.id)!;

      // Check subreddit match
      const subMatch = domain.subreddits.some(
        (s) => sub === s.toLowerCase() || sub.includes(s.toLowerCase()),
      );

      // Check keyword match
      const kwMatch = domain.keywords.some((kw) =>
        text.includes(kw.toLowerCase()),
      );

      if (subMatch || kwMatch) {
        bucket.push(item);
      }
    }

    // Unmatched items are NOT copied into every bucket (the old fanout).
    // rank.ts scores every item by relevance; the top-ranked ones survive the
    // per-domain cap. Deleted items still reach every domain via the deleted
    // bucket below.
  }

  // Ensure deleted items are visible to every domain, then de-duplicate and sort.
  for (const domain of DOMAINS) {
    const bucket = buckets.get(domain.id)!;
    const seen = new Set<string>();
    const deduped: FilteredItem[] = [];
    for (const item of [...deletedItems, ...bucket]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      deduped.push(item);
    }
    buckets.set(
      domain.id,
      deduped.sort((a, b) => b.created_utc - a.created_utc),
    );
  }

  return buckets;
}

function formatDate(utcSeconds: number): string {
  if (!Number.isFinite(utcSeconds) || utcSeconds <= 0) return "unknown-date";
  return new Date(utcSeconds * 1000).toISOString().split("T")[0];
}

function compactText(value: string | undefined, maxChars: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function itemIdentity(item: FilteredItem): string {
  return `${item.type}:${item.id}`;
}

function estimateItemChars(item: FilteredItem): number {
  return (
    180 +
    Math.min(MAX_CHARS_PER_ITEM, (item.body ?? "").length) +
    Math.min(220, (item.title ?? "").length)
  );
}

/**
 * Split items into context-safe chunks. This prevents silent truncation while
 * preserving newest-first order inside each chunk.
 */
function splitItemsForAgent(items: FilteredItem[]): FilteredItem[][] {
  const sorted = [...items].sort((a, b) => b.created_utc - a.created_utc);
  const chunks: FilteredItem[][] = [];
  let current: FilteredItem[] = [];
  let currentChars = 0;

  for (const item of sorted) {
    const itemChars = estimateItemChars(item);
    const wouldOverflowItems = current.length >= MAX_ITEMS_PER_AGENT_CHUNK;
    const wouldOverflowChars =
      current.length > 0 && currentChars + itemChars > MAX_PROMPT_CHARS;
    if (wouldOverflowItems || wouldOverflowChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Format filtered items for a sub-agent prompt.
 */
function formatItemsForAgent(items: FilteredItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const date = formatDate(item.created_utc);
    const text = compactText(item.body, MAX_CHARS_PER_ITEM);
    const title = item.title ? ` [post: ${compactText(item.title, 220)}]` : "";
    const deleted = item.is_deleted || item.is_removed ? " [DELETED]" : "";
    const score = item.score !== 0 ? ` (score: ${item.score})` : "";
    const source = item.source ? ` source:${item.source}` : "";
    const permalink = item.permalink ? ` permalink:${item.permalink}` : "";
    lines.push(
      `[id:${itemIdentity(item)} ${date}] r/${item.subreddit}${deleted}${title}${score}${source}${permalink}: ${text}`,
    );
  }
  return lines.join("\n");
}

// ── Run a single sub-agent ────────────────────────────────────────────────

interface SubAgentResult {
  domainId: string;
  label: string;
  icon: string;
  output: string;
  itemCount: number;
  modelId: string;
  durationMs: number;
  chunkIndex?: number;
  chunkCount?: number;
}

async function runSubAgent(
  domain: Domain,
  items: FilteredItem[],
  onProgress?: (msg: string) => void,
  chunkIndex = 1,
  chunkCount = 1,
): Promise<SubAgentResult> {
  const start = Date.now();
  const chunkLabel = chunkCount > 1 ? ` chunk ${chunkIndex}/${chunkCount}` : "";
  const modelId = resolveModel("subagent");
  onProgress?.(
    `  ${domain.icon} ${domain.label}${chunkLabel}: Using ${modelId}, analyzing ${items.length} items...`,
  );

  // Format items and build the prompt
  const formattedItems = formatItemsForAgent(items);
  const dataHeader = [
    `=== REDDIT DATA FOR: ${domain.label.toUpperCase()} ANALYSIS ===`,
    `Chunk: ${chunkIndex}/${chunkCount}`,
    `Items provided in this chunk: ${items.length} (filtered and categorized for this domain)`,
    `Note: Items marked [DELETED] were deleted/removed by the user. Treat missing deleted bodies as unavailable, not as evidence.`,
    `Note: Focus only on your domain. Other sub-agents handle other aspects.`,
    `Note: Cite item ids, dates, and subreddits for every claim.`,
    ``,
  ].join("\n");

  const prompt = `${dataHeader}${formattedItems}\n\n---\nAnalyze the above data for ${domain.label.toLowerCase()} markers. Be exhaustive.`;

  const output = await promptOnce(domain.prompt, prompt, { role: "subagent" });

  const durationMs = Date.now() - start;
  onProgress?.(
    `  ${domain.icon} ${domain.label}${chunkLabel}: Done (${(durationMs / 1000).toFixed(1)}s, ${output.length} chars)`,
  );

  return {
    domainId: domain.id,
    label: domain.label,
    icon: domain.icon,
    output,
    itemCount: items.length,
    modelId,
    durationMs,
    chunkIndex,
    chunkCount,
  };
}

async function consolidateDomainReports(
  domain: Domain,
  reports: SubAgentResult[],
  onProgress?: (msg: string) => void,
  round = 1,
): Promise<{ output: string; durationMs: number; modelIds: string[] }> {
  if (reports.length === 1) {
    return { output: reports[0].output, durationMs: 0, modelIds: [] };
  }

  const consolidated: SubAgentResult[] = [];
  for (let i = 0; i < reports.length; i += MAX_REPORTS_PER_CONSOLIDATION) {
    const batch = reports.slice(i, i + MAX_REPORTS_PER_CONSOLIDATION);
    const batchNumber = Math.floor(i / MAX_REPORTS_PER_CONSOLIDATION) + 1;
    const batchCount = Math.ceil(
      reports.length / MAX_REPORTS_PER_CONSOLIDATION,
    );
    const start = Date.now();
    onProgress?.(
      `  ${domain.icon} ${domain.label}: Consolidating reports round ${round}, batch ${batchNumber}/${batchCount}...`,
    );

    const consolidateSystem = `You consolidate ${domain.label} analysis reports. Merge the chunk reports into one deduplicated, evidence-preserving report. Do not introduce new facts. Drop claims that lack item id/date/subreddit evidence. Preserve uncertainty labels and contradictions.`;
    const prompt = [
      `DOMAIN: ${domain.label}`,
      `ROUND: ${round}`,
      `REPORTS IN THIS BATCH: ${batch.length}`,
      `TASK: Produce one consolidated ${domain.label} report. Keep all unique findings with citations. Resolve duplicates and contradictions.`,
      "",
      ...batch.map((result, idx) =>
        [
          `--- INPUT REPORT ${idx + 1} (${result.itemCount} items, chunk ${result.chunkIndex ?? "?"}/${result.chunkCount ?? "?"}) ---`,
          result.output,
        ].join("\n"),
      ),
    ].join("\n\n");

    const output = await promptOnce(consolidateSystem, prompt, { role: "subagent" });

    consolidated.push({
      domainId: domain.id,
      label: domain.label,
      icon: domain.icon,
      output,
      itemCount: batch.reduce((sum, result) => sum + result.itemCount, 0),
      modelId: resolveModel("subagent"),
      durationMs: Date.now() - start,
      chunkIndex: batchNumber,
      chunkCount: batchCount,
    });
  }

  if (consolidated.length === 1) {
    return {
      output: consolidated[0].output,
      durationMs: consolidated[0].durationMs,
      modelIds: [consolidated[0].modelId],
    };
  }

  const next = await consolidateDomainReports(
    domain,
    consolidated,
    onProgress,
    round + 1,
  );
  return {
    output: next.output,
    durationMs:
      consolidated.reduce((sum, result) => sum + result.durationMs, 0) +
      next.durationMs,
    modelIds: [
      ...consolidated.map((result) => result.modelId),
      ...next.modelIds,
    ],
  };
}

async function runDomainAgent(
  domain: Domain,
  items: FilteredItem[],
  onProgress?: (msg: string) => void,
): Promise<SubAgentResult> {
  const chunks = splitItemsForAgent(items);
  if (chunks.length === 0) {
    return {
      domainId: domain.id,
      label: domain.label,
      icon: domain.icon,
      output: "No items matched this domain.",
      itemCount: 0,
      modelId: "none",
      durationMs: 0,
      chunkIndex: 0,
      chunkCount: 0,
    };
  }

  onProgress?.(
    `  ${domain.icon} ${domain.label}: ${items.length} items split into ${chunks.length} chunk(s)`,
  );
  const chunkResults: SubAgentResult[] = [];
  for (let i = 0; i < chunks.length; i++) {
    chunkResults.push(
      await runSubAgent(domain, chunks[i], onProgress, i + 1, chunks.length),
    );
  }

  if (chunkResults.length === 1) return chunkResults[0];

  const consolidated = await consolidateDomainReports(
    domain,
    chunkResults,
    onProgress,
  );
  const analysisModelIds = chunkResults.map((result) => result.modelId);
  const modelIds = [
    ...new Set([...analysisModelIds, ...consolidated.modelIds]),
  ];

  return {
    domainId: domain.id,
    label: domain.label,
    icon: domain.icon,
    output: consolidated.output,
    itemCount: items.length,
    modelId: modelIds.join(", "),
    durationMs:
      chunkResults.reduce((sum, result) => sum + result.durationMs, 0) +
      consolidated.durationMs,
    chunkIndex: 0,
    chunkCount: chunkResults.length,
  };
}

// ── Run the synthesis agent ────────────────────────────────────────────────

async function runSynthesisAgent(
  username: string,
  subResults: SubAgentResult[],
  candidate?: Candidate,
  onProgress?: (msg: string) => void,
  enableWeb = false,
  webContextText = "",
): Promise<string> {
  onProgress?.(`\n🔧 Synthesis: Creating final analysis session...`);

  const modelId = resolveModel("synthesis");
  const useWeb = webToolsAvailable(enableWeb);
  if (enableWeb && !useWeb) {
    onProgress?.(`🔧 Synthesis: Web tools requested but unavailable; continuing without web tools.`);
  }
  onProgress?.(
    `🔧 Synthesis: Using ${modelId}, combining ${subResults.length} sub-reports...${useWeb ? " (web tools ENABLED)" : ""}`,
  );

  // Build the synthesis prompt with all sub-reports
  const parts: string[] = [];
  parts.push(`=== SUB-AGENT REPORTS FOR u/${username} ===`);
  parts.push(formatObjectiveContext(candidate).replace("{username}", username));
  parts.push(
    `The following reports were produced by specialized sub-agents. Synthesize them into a unified OSINT profile.\n`,
  );

  // Deterministic web leads (ground truth) — injected BEFORE the sub-reports
  // so the model treats them as anchors while synthesizing. These were found
  // by a search+scrape+regex pass; the model must reason about them, not
  // re-discover them.
  if (webContextText.trim()) {
    parts.push(webContextText.trim());
  }

  for (const result of subResults) {
    parts.push(`\n${"═".repeat(60)}`);
    parts.push(`${result.icon} ${result.label.toUpperCase()} REPORT`);
    const chunkInfo =
      result.chunkCount && result.chunkCount > 1
        ? ` | Chunks: ${result.chunkCount}`
        : "";
    parts.push(
      `Analyzed ${result.itemCount} items${chunkInfo} | Model: ${result.modelId} | Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    );
    parts.push(`${"═".repeat(60)}\n`);
    parts.push(result.output);
  }

  const userPrompt = parts.join("\n");
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = SYNTHESIS_PROMPT.replaceAll("{TODAY}", today);
  // Web research: when claude-code prefers the Firecrawl MCP server, web tools
  // are native (no ReAct fences) — pass no tools and a note pointing the model
  // at firecrawl_search/firecrawl_scrape. OpenAI and Codex CLI attach our app
  // ReAct web tools and run the same tool-calling agent loop.
  const viaMcp = mcpWebPreferred();
  const tools = useWeb && !viaMcp ? buildWebTools() : [];
  const finalSystem = useWeb && viaMcp ? `${systemPrompt}${mcpWebNote()}` : systemPrompt;

  const run = await runAgentWithTools({
    systemPrompt: finalSystem,
    userPrompt,
    tools,
    maxIterations: useWeb ? 16 : 6,
    callbacks: {
      onToolCall: (name, args) => {
        const detail =
          (args as any)?.query ?? (args as any)?.url ?? "";
        onProgress?.(
          `  🔎 Synthesis web tool: ${name}${detail ? ` — ${String(detail).slice(0, 140)}` : ""}`,
        );
      },
      onToolResult: (name, value) => {
        const size = JSON.stringify(value ?? {}).length;
        onProgress?.(`  🔎 Synthesis web tool done: ${name} (${size.toLocaleString()} chars)`);
      },
      onLog: (m) => onProgress?.(m),
    },
  });

  return run.text;
}

// ── Main pipeline entry point ─────────────────────────────────────────────

export interface DeepAnalysisResult {
  username: string;
  subAgentResults: SubAgentResult[];
  synthesisReport: string;
  /** Deterministic identifiers from the RAW corpus (pre-filter). The source
   *  of truth for the corpus corroboration domain. */
  directIdentifiers: DirectIdentifiers;
  /** Identifiers extracted from the LLM synthesis text. NOT deterministic —
   *  surfaced separately and never counted as an independent corroboration
   *  source, so a hallucinated email can't masquerade as a verified leak. */
  modelMentionedIdentifiers: DirectIdentifiers;
  structured?: StructuredFindings;
  stats: {
    total_items_raw: number;
    total_items_filtered: number;
    items_per_domain: Record<string, number>;
    total_duration_ms: number;
    model_used: string;
  };
}

/**
 * Run the multi-agent deep analysis pipeline.
 *
 * 1. Load data from JSONL files
 * 2. Heuristic filter to remove noise
 * 3. Categorize items into domain buckets
 * 4. Dispatch sub-agents in parallel (2 at a time to respect rate limits)
 * 5. Run synthesis agent to produce final report
 */
export async function runDeepAnalysis(
  username: string,
  posts: any[],
  comments: any[],
  candidate?: Candidate,
  onProgress?: (msg: string) => void,
  options: { web?: boolean; webContextText?: string; knownHandles?: string[] } = {},
): Promise<DeepAnalysisResult> {
  const pipelineStart = Date.now();
  const totalRaw = posts.length + comments.length;

  onProgress?.(`\n${"━".repeat(60)}`);
  onProgress?.(`🚀 Multi-Agent Deep Analysis: u/${username}`);
  onProgress?.(
    `   Raw data: ${posts.length} posts, ${comments.length} comments`,
  );
  onProgress?.(`${"━".repeat(60)}\n`);

  // Step 1: Heuristic filter
  onProgress?.(`[1/4] Filtering noise from ${totalRaw} items...`);

  // Convert raw JSONL items to the format expected by heuristicFilter
  const typedPosts: RedditPost[] = posts.map((p: any) => ({
    id: p.id ?? "",
    title: p.title ?? "",
    selftext: p.selftext ?? "",
    author: p.author ?? "",
    subreddit: p.subreddit ?? "",
    created_utc: p.created_utc ?? 0,
    score: p.score ?? 0,
    num_comments: p.num_comments ?? 0,
    url: p.url ?? "",
    permalink: p.permalink ?? "",
    is_deleted:
      p.selftext === "[deleted]" || p.author === "[deleted]",
    is_removed: p.selftext === "[removed]",
    source: "jsonl",
  }));

  const typedComments: RedditComment[] = comments.map((c: any) => ({
    id: c.id ?? "",
    body: c.body ?? "",
    author: c.author ?? "",
    subreddit: c.subreddit ?? "",
    created_utc: c.created_utc ?? 0,
    score: c.score ?? 0,
    permalink: c.permalink ?? "",
    link_id: c.link_id ?? "",
    is_deleted: c.body === "[deleted]" || c.author === "[deleted]",
    is_removed: c.body === "[removed]",
    source: "jsonl",
  }));

  const { kept } = heuristicFilter(typedPosts, typedComments);
  onProgress?.(
    `   Kept ${kept.length} items after heuristic filtering (removed ${totalRaw - kept.length} noise items)\n`,
  );

  // Step 2: Categorize into domain buckets + deterministic relevance cap
  onProgress?.(
    `[2/4] Categorizing ${kept.length} items into domain buckets (deterministic relevance cap)...`,
  );
  const buckets = categorizeItems(kept);

  // Deterministic relevance rank + per-domain cap (see rank.ts). Replaces the
  // old fanout: instead of copying every unmatched item into every bucket, we
  // score each bucket by signal strength and keep only the top N. Deleted
  // items are pinned above the cut line. This is what makes large accounts
  // (~7k items) finish in ~1 chunk per domain instead of dozens.
  const cap = maxItemsPerDomain();
  const rankCtxByDomain = new Map(
    DOMAINS.map((d) => [
      d.id,
      {
        keywordWeights: buildKeywordWeights(d.keywords),
        subreddits: d.subreddits.map((s) => s.toLowerCase()),
        knownHandleKeys: [
          username.toLowerCase(),
          handleKey(username),
          ...(options.knownHandles ?? []).map((h) => handleKey(h)),
        ],
      },
    ]),
  );
  const itemsPerDomain: Record<string, number> = {};
  for (const domain of DOMAINS) {
    const bucket = buckets.get(domain.id) ?? [];
    const ctx = rankCtxByDomain.get(domain.id)!;
    const { kept: capped, droppedByCap, droppedByFloor } = rankAndCapBucket(bucket, ctx, cap);
    buckets.set(domain.id, capped);
    itemsPerDomain[domain.id] = capped.length;
    onProgress?.(
      `   ${domain.icon} ${domain.label}: ${capped.length}/${bucket.length} items kept (cap=${cap}, dropped low-signal=${droppedByFloor}, over-cap=${droppedByCap})`,
    );
  }
  onProgress?.("");

  // Step 3: Dispatch sub-agents (all in parallel — each domain now fits in
  // ~1 chunk, so the per-domain chunk loop collapses to a single call).
  onProgress?.(
    `[3/4] Dispatching ${DOMAINS.length} specialized sub-agents in parallel...\n`,
  );

  const subResults: SubAgentResult[] = await Promise.all(
    DOMAINS.map((domain) => {
      const items = buckets.get(domain.id) ?? [];
      return runDomainAgent(domain, items, onProgress);
    }),
  );

  onProgress?.(`\n   ✅ All ${subResults.length} sub-agents completed`);

  // Step 4: Run synthesis agent
  onProgress?.(`\n[4/4] Running synthesis agent...\n`);
  const synthesisReport = await runSynthesisAgent(
    username,
    subResults,
    candidate,
    onProgress,
    options.web,
    options.webContextText,
  );

  const totalDurationMs = Date.now() - pipelineStart;
  onProgress?.(`\n${"━".repeat(60)}`);
  onProgress?.(
    `✅ Deep analysis complete in ${(totalDurationMs / 1000).toFixed(1)}s`,
  );
  onProgress?.(`${"━".repeat(60)}\n`);

  // ── Deterministic identifier extraction (source-separated) ──
  // CORPUS identifiers come from the FULL raw history (pre-filter), so an
  // identifier living in an item the heuristic filter dropped is still found.
  // These are the deterministic "direct" identifiers. MODEL-MENTIONED
  // identifiers come from the LLM synthesis text ONLY: they are not
  // deterministic (the model may paraphrase or hallucinate) and are kept
  // separate so an invented email can never masquerade as a verified leak or
  // count as an independent corroboration source.
  onProgress?.(`[extract] Scanning full corpus (pre-filter) for direct identifiers...`);
  const corpusManifest = buildCorpusManifest([...typedPosts, ...typedComments]);
  const directIdentifiers = extractDirectIdentifiers(corpusManifest.texts, username);
  const modelMentionedIdentifiers = extractDirectIdentifiers([synthesisReport], username);
  onProgress?.(
    `[extract] Corpus: ${directIdentifiers.emails.length} email(s), ${directIdentifiers.socialHandles.length} handle(s). Model-mentioned (unverified): ${modelMentionedIdentifiers.emails.length} email(s), ${modelMentionedIdentifiers.socialHandles.length} handle(s).`,
  );

  // Structured-findings pass: re-project the narrative report into a strict,
  // machine-readable schema (with JSON repair fallback), then VALIDATE every
  // evidence quote/permalink against the real corpus so unsupported evidence
  // carries zero weight downstream (corroboration counts only surviving
  // permalinks).
  let structured: StructuredFindings | undefined;
  try {
    structured = await extractStructuredFindings(
      synthesisReport,
      directIdentifiers,
      username,
      onProgress,
    );
    structured = validateStructuredFindings(structured, corpusManifest);
    const dropped = structured.evidenceValidation?.unsupported ?? 0;
    onProgress?.(
      `[findings] ${structured.findings.length} structured finding(s), risk=${structured.overallRisk}${dropped > 0 ? `, ${dropped} unsupported evidence entr(ies) dropped` : ""}.`,
    );
  } catch (err: any) {
    onProgress?.(`[findings] Structured extraction failed: ${err?.message ?? err}`);
  }

  return {
    username,
    subAgentResults: subResults,
    synthesisReport,
    directIdentifiers,
    modelMentionedIdentifiers,
    structured,
    stats: {
      total_items_raw: totalRaw,
      total_items_filtered: kept.length,
      items_per_domain: itemsPerDomain,
      total_duration_ms: totalDurationMs,
      model_used: subResults[0]?.modelId ?? "unknown",
    },
  };
}

/**
 * Format the deep analysis result as a markdown report.
 */
export function formatDeepAnalysisReport(result: DeepAnalysisResult): string {
  const lines: string[] = [];

  lines.push(
    `Method: Multi-Agent Deep Analysis (${result.subAgentResults.length} sub-agents)`,
  );
  lines.push(
    `Duration: ${(result.stats.total_duration_ms / 1000).toFixed(1)}s`,
  );
  lines.push(`Model: ${result.stats.model_used}`);
  lines.push("");

  // Direct identifiers — concrete regex-extracted leaks from the corpus,
  // rendered near the top so they are never buried under the LLM narrative.
  const directBlock = renderDirectIdentifiersBlock(result.directIdentifiers);
  if (directBlock) {
    lines.push(directBlock);
    lines.push(`---\n`);
  }

  // Identifiers the model MENTIONED in its report but that are NOT in the
  // deterministic corpus extraction — kept separate and clearly unverified so
  // a paraphrased or hallucinated value can't masquerade as a verified leak.
  const modelBlock = renderModelMentionedBlock(result.modelMentionedIdentifiers, result.directIdentifiers);
  if (modelBlock) {
    lines.push(modelBlock);
    lines.push(`---\n`);
  }

  // Sub-agent stats
  lines.push(`## Analysis Statistics`);
  lines.push(`- Raw items: ${result.stats.total_items_raw}`);
  lines.push(`- After filtering: ${result.stats.total_items_filtered}`);
  lines.push(`- Items per domain:`);
  for (const [domainId, count] of Object.entries(
    result.stats.items_per_domain,
  )) {
    const domain = DOMAINS.find((d) => d.id === domainId)!;
    lines.push(`  - ${domain.icon} ${domain.label}: ${count}`);
  }
  lines.push("");

  // Synthesis report (the main output)
  lines.push(result.synthesisReport);

  // Structured findings appendix (machine-readable projection of the report)
  if (result.structured) {
    lines.push(`\n---\n`);
    lines.push(renderStructuredFindings(result.structured));
  }

  // Appendix: Individual sub-agent reports
  lines.push(`\n---\n`);
  lines.push(`## Appendix: Sub-Agent Reports\n`);
  lines.push(
    `<details>\n<summary>Click to expand individual sub-agent reports</summary>\n`,
  );

  for (const subResult of result.subAgentResults) {
    lines.push(`\n### ${subResult.icon} ${subResult.label}`);
    const chunkInfo =
      subResult.chunkCount && subResult.chunkCount > 1
        ? ` | Chunks: ${subResult.chunkCount}`
        : "";
    lines.push(
      `Items analyzed: ${subResult.itemCount}${chunkInfo} | Duration: ${(subResult.durationMs / 1000).toFixed(1)}s\n`,
    );
    lines.push(subResult.output);
    lines.push("");
  }

  lines.push(`\n</details>`);

  return lines.join("\n");
}
