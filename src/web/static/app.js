/* osint-ai · case console
 * Vanilla dashboard over the audit-pipeline HTTP API. Computes a
 * de-anonymization exposure index client-side from the report content,
 * deterministic identifiers, and the structured-findings appendix.
 */

const state = {
	reports: [],
	jobs: [],
	activeView: "dashboard",
	selectedReport: "",
	analyzeCache: new Map(),
	// Rendered markdown is cached per report file so closing/reopening is
	// instant. Invalidate when a report's mtime/content actually changes.
	markdownCache: new Map(),
	// Track which views have painted at least once so we can re-render just
	// the active one on refresh.
	renderedViews: new Set(),
	eventSource: null,
	chatHistory: [],
	chatBusy: false,
	// Live log — SSE events are coalesced through a rAF-driven queue so bursts
	// of tool/token events don't trigger N style/layout recalcs per frame.
	liveLogQueue: [],
	liveLogRaf: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/* ── Theme (light / dark) ──────────────────────────────────────────────── */
/* The initial theme is set before first paint by the inline script in index.html
   (which also honours the OS preference). Here we only expose the toggle. */
function setTheme(theme) {
	document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
	const root = document.documentElement;
	const next = root.dataset.theme === "dark" ? "light" : "dark";
	try {
		localStorage.setItem("ro-theme", next);
	} catch (e) {}
	/* Scope the cross-panel color transition to the toggle itself — without
	   this, every repaint everywhere pays the 0.3s transition tax. */
	root.classList.add("theme-toggling");
	setTheme(next);
	setTimeout(() => root.classList.remove("theme-toggling"), 360);
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

function formatDate(value) {
	if (!value) return "unknown";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanMarkdownText(value) {
	return String(value ?? "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^[->#\s]*|[->#\s]*$/g, "")
		.replace(/[`*_>#|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function sanitizeUrl(value) {
	const url = String(value ?? "").trim();
	return /^(https?:\/\/|mailto:)/i.test(url) ? escapeHtml(url) : "#";
}

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function countMatches(content, pattern) {
	return [...String(content).matchAll(pattern)].length;
}

function riskClass(risk) {
	const n = String(risk || "unknown").toLowerCase();
	if (n.includes("critical")) return "critical";
	if (n.includes("high")) return "high";
	if (n.includes("medium")) return "medium";
	if (n.includes("low")) return "low";
	return "unknown";
}

/* ── Exposure-index bands ───────────────────────────────────────────────── */

const BANDS = [
	{ max: 20, key: "minimal", label: "Minimal", color: "#6fcf97" },
	{ max: 40, key: "low", label: "Low", color: "#5fb38d" },
	{ max: 60, key: "moderate", label: "Moderate", color: "#f0a830" },
	{ max: 80, key: "elevated", label: "Elevated", color: "#e87a4a" },
	{ max: 100, key: "critical", label: "Critical", color: "#e0533a" },
];

function bandForScore(score) {
	return BANDS.find((b) => score <= b.max) ?? BANDS[BANDS.length - 1];
}

/* ── Markdown rendering ─────────────────────────────────────────────────── */

function inlineMarkdown(value) {
	const code = [];
	let text = escapeHtml(value).replace(/`([^`]+)`/g, (_, inner) => {
		const token = `@@CODE${code.length}@@`;
		code.push(`<code>${inner}</code>`);
		return token;
	});
	text = text
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
			`<a href="${sanitizeUrl(url)}" target="_blank" rel="noreferrer">${label}</a>`)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
	for (let i = 0; i < code.length; i += 1) text = text.replace(`@@CODE${i}@@`, code[i]);
	return stampInline(text);
}

/** Wrap all-caps attribution/confidence tokens in rubber-stamp badges. */
function stampInline(html) {
	return html
		.replace(/\b(CONFIRMED)\b/g, '<span class="stamp-inline confirmed">confirmed</span>')
		.replace(/\b(LIKELY)\b/g, '<span class="stamp-inline likely">likely</span>')
		.replace(/\b(POSSIBLE)\b/g, '<span class="stamp-inline possible">possible</span>')
		.replace(/\b(REJECTED)\b/g, '<span class="stamp-inline rejected">rejected</span>')
		.replace(/[🔴]\s*(HIGH)/gi, '<span class="stamp-inline high">$1</span>')
		.replace(/[🟡]\s*(MEDIUM)/gi, '<span class="stamp-inline medium">$1</span>')
		.replace(/[🟢⚪]\s*(LOW)/gi, '<span class="stamp-inline low">$1</span>');
}

function isMarkdownTable(lines, index) {
	return Boolean(
		lines[index]?.trim().startsWith("|") &&
			lines[index + 1]?.trim().startsWith("|") &&
			/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim()),
	);
}

function splitMarkdownRow(line) {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function renderMarkdownTable(lines, index) {
	const headers = splitMarkdownRow(lines[index]);
	let cursor = index + 2;
	const rows = [];
	while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
		rows.push(splitMarkdownRow(lines[cursor]));
		cursor += 1;
	}
	const head = headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("");
	const body = rows
		.map((row) => `<tr>${headers.map((_, i) => `<td>${inlineMarkdown(row[i] ?? "")}</td>`).join("")}</tr>`)
		.join("");
	return {
		html: `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
		nextIndex: cursor,
	};
}

const FINDINGS_HEADING = /^#{1,4}\s+structured\s+findings/i;
const DIRECTID_HEADING = /^#{1,4}\s+direct\s+identifiers\s+extracted/i;

function renderMarkdown(markdown) {
	const lines = String(markdown ?? "").replace(/\t/g, "    ").split(/\r?\n/);
	const html = [];
	let inCode = false;
	let listType = "";

	const closeList = () => {
		if (!listType) return;
		html.push(`</${listType}>`);
		listType = "";
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];

		if (/^```/.test(line)) {
			closeList();
			html.push(inCode ? "</code></pre>" : "<pre><code>");
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			html.push(`${escapeHtml(line)}\n`);
			continue;
		}

		// Special block: Structured Findings (machine-readable appendix).
		if (FINDINGS_HEADING.test(line)) {
			closeList();
			let end = i + 1;
			while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end += 1;
			html.push(renderFindingsBlock(lines.slice(i + 1, end)));
			i = end - 1;
			continue;
		}

		if (!line.trim()) {
			closeList();
			continue;
		}

		if (isMarkdownTable(lines, i)) {
			closeList();
			const rendered = renderMarkdownTable(lines, i);
			html.push(rendered.html);
			i = rendered.nextIndex - 1;
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			closeList();
			const quote = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				quote.push(lines[i].replace(/^\s*>\s?/, ""));
				i += 1;
			}
			i -= 1;
			const body = quote.join("\n").trim();
			const tone = /critical|severe|risk|warning|danger/i.test(body)
				? " critical"
				: /identity|confidence|likely|resolved/i.test(body)
					? " identity"
					: /note|caveat|caveats|limitation/i.test(body)
						? ""
						: "";
			html.push(`<blockquote class="report-callout${tone}">${renderMarkdown(body)}</blockquote>`);
			continue;
		}

		const heading = line.match(/^(#{1,5})\s+(.+)$/);
		const bullet = line.match(/^\s*[-*]\s+(.+)$/);
		const ordered = line.match(/^\s*\d+\.\s+(.+)$/);

		if (heading) {
			closeList();
			const level = Math.min(heading[1].length, 5);
			html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
		} else if (bullet) {
			if (listType !== "ul") {
				closeList();
				html.push("<ul>");
				listType = "ul";
			}
			html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
		} else if (ordered) {
			if (listType !== "ol") {
				closeList();
				html.push("<ol>");
				listType = "ol";
			}
			html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
		} else if (/^\s*-{3,}\s*$/.test(line) || /^\s*\*\*\*\s*$/.test(line)) {
			closeList();
			html.push("<hr />");
		} else {
			closeList();
			const paragraph = [line.trim()];
			while (
				i + 1 < lines.length &&
				lines[i + 1].trim() &&
				!isMarkdownTable(lines, i + 1) &&
				!/^(```|#{1,5}\s+|\s*[-*]\s+|\s*\d+\.\s+|\s*>\s?|\s*[-*]{3,}\s*$|\s*\*\*\*\s*$)/.test(lines[i + 1])
			) {
				i += 1;
				paragraph.push(lines[i].trim());
			}
			html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
		}
	}
	closeList();
	if (inCode) html.push("</code></pre>");
	return html.join("");
}

/** Render the machine-readable "Structured Findings" appendix as cards. */
function renderFindingsBlock(lines) {
	const out = ['<section class="findings-section">'];
	out.push('<h2 class="findings-title">Structured Findings <span class="findings-sub">machine-readable</span></h2>');

	let summary = "";
	let riskLine = "";
	const identity = { user: "", rationale: "", urls: [] };
	const groups = [];
	let current = null;

	const flushCurrent = () => {
		if (current) groups.push(current);
		current = null;
	};

	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];
		const line = raw.trim();
		if (!line) continue;

		const risk = line.match(/^\*\*\s*overall\s+risk:?\s*\*\*\s*(.+)$/i);
		if (risk) {
			riskLine = risk[1].trim();
			continue;
		}

		const h3 = line.match(/^#{3,4}\s+(.+)$/i);
		if (h3) {
			flushCurrent();
			const label = h3[1].trim();
			if (/identity/i.test(label)) {
				current = { type: "identity", label };
			} else {
				const conf = /high|medium|low/i.exec(label);
				current = { type: "group", label: conf ? conf[0].toLowerCase() : "findings", entries: [] };
			}
			continue;
		}

		if (/^>/.test(line)) {
			summary = cleanMarkdownText(line.replace(/^>\s?/, ""));
			continue;
		}

		if (current?.type === "identity") {
			const user = line.match(/^\*\*\s*resolved user:?\s*\*\*\s*(.+)$/i);
			const rat = line.match(/^\*\*\s*rationale:?\s*\*\*\s*(.+)$/i);
			if (user) identity.user = user[1].trim();
			else if (rat) identity.rationale = rat[1].trim();
			else if (/^\s*[-*]\s+/.test(line)) identity.urls.push(cleanMarkdownText(line.replace(/^\s*[-*]\s+/, "")));
			continue;
		}

		const entry = line.match(/^\*\*\s*\[([^\]]+)\]\s*\*\*\s*(.+)$/i);
		if (entry && current?.type === "group") {
			// Capture the label BEFORE flushing — flushCurrent() nulls `current`,
			// and reading `current.label` afterwards throws "Cannot read
			// properties of null". Each finding entry becomes its own group so
			// the confidence stamp is preserved per card.
			const label = current.label;
			flushCurrent();
			current = { type: "group", label, entries: [{ category: entry[1], claim: entry[2], why: "", fix: "", evidence: [] }] };
			continue;
		}
		if (entry) {
			flushCurrent();
			current = { type: "group", label: "findings", entries: [{ category: entry[1], claim: entry[2], why: "", fix: "", evidence: [] }] };
			continue;
		}

		if (current?.type === "group" && current.entries.length) {
			const e = current.entries[current.entries.length - 1];
			const why = line.match(/^\s*[-*]\s+\*?why:?\s*\*?\s*(.+)$/i);
			const fix = line.match(/^\s*[-*]\s+\*?(?:fix|fix\/verify|verify):?\s*\*?\s*(.+)$/i);
			if (why) e.why = why[1].trim();
			else if (fix) e.fix = fix[1].trim();
			else if (/^\s*[-*]\s+/.test(line)) e.evidence.push({ quote: "", permalink: cleanMarkdownText(line.replace(/^\s*[-*]\s+/, "")) });
			else {
				const m = line.match(/^(`[^`]+`)\s*([^\s]*)\s*$/);
				if (m && /^https?:/i.test(m[2])) e.evidence.push({ quote: m[1].replace(/`/g, ""), permalink: m[2] });
				else if (/^`/.test(line)) e.evidence.push({ quote: line.replace(/`/g, "").trim(), permalink: "" });
			}
		}
	}
	flushCurrent();

	if (riskLine) {
		out.push(`<div class="findings-risk">${stampInline(escapeHtml(riskLine))}</div>`);
	}
	if (summary) out.push(`<blockquote class="report-callout">${escapeHtml(summary)}</blockquote>`);

	if (identity.user || identity.rationale || identity.urls.length) {
		out.push('<div class="finding identity-finding">');
		out.push('<div class="finding-head"><span class="finding-cat">resolved identity</span></div>');
		if (identity.user) out.push(`<p class="finding-claim">${inlineMarkdown(identity.user)}</p>`);
		if (identity.rationale) out.push(`<p class="finding-detail">${inlineMarkdown(identity.rationale)}</p>`);
		identity.urls.filter(Boolean).forEach((u) => {
			out.push(`<a class="evidence-link" href="${sanitizeUrl(u)}" target="_blank" rel="noreferrer">${escapeHtml(u)}</a>`);
		});
		out.push("</div>");
	}

	for (const group of groups.filter((g) => g.type === "group")) {
		for (const e of group.entries) {
			if (!e.claim) continue;
			out.push('<div class="finding">');
			out.push('<div class="finding-head">');
			out.push(`<span class="finding-cat">${escapeHtml(e.category)}</span>`);
			out.push(`<span class="finding-claim">${inlineMarkdown(e.claim)}</span>`);
			out.push(`<span class="stamp-inline ${group.label === "high" ? "high" : group.label === "medium" ? "medium" : "low"}">${escapeHtml(group.label)} conf</span>`);
			out.push("</div>");
			if (e.why) out.push(`<p class="finding-detail"><span class="label">why</span> ${inlineMarkdown(e.why)}</p>`);
			e.evidence.forEach((ev) => {
				if (ev.quote && ev.permalink) {
					out.push(`<span class="finding-evidence"><code>${escapeHtml(ev.quote)}</code> · <a href="${sanitizeUrl(ev.permalink)}" target="_blank" rel="noreferrer">source</a></span>`);
				} else if (ev.quote) {
					out.push(`<span class="finding-evidence"><code>${escapeHtml(ev.quote)}</code></span>`);
				} else if (ev.permalink && /^https?:/i.test(ev.permalink)) {
					out.push(`<a class="evidence-link" href="${sanitizeUrl(ev.permalink)}" target="_blank" rel="noreferrer">${escapeHtml(ev.permalink)}</a>`);
				}
			});
			if (e.fix) out.push(`<p class="finding-detail"><span class="label">fix / verify</span> ${inlineMarkdown(e.fix)}</p>`);
			out.push("</div>");
		}
	}

	out.push("</section>");
	return out.join("");
}

/* ── Analysis: extraction + exposure index ──────────────────────────────── */

function extractField(content, labels) {
	for (const label of labels) {
		const table = new RegExp(`\\|\\s*(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*\\|\\s*([^|\\n]+)`, "i").exec(content);
		if (table?.[1]) return cleanMarkdownText(table[1]);
		const line = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*[:|-]\\s*([^\\n]+)`, "i").exec(content);
		if (line?.[1]) return cleanMarkdownText(line[1]);
	}
	return "";
}

function isPlausibleIdentityName(value) {
	const text = cleanMarkdownText(value);
	if (!text || text.length > 60) return false;
	if (/[,;]|—|--|unknown|n\/a|none/i.test(text)) return false;
	return /^[A-Za-z]/.test(text) && /[A-Za-z0-9]/.test(text);
}

function extractLikelyIdentity(content, summary) {
	const explicitName = extractField(content, ["Name", "Likely Identity", "Identity", "Real Name", "Resolved user", "Candidate", "ExactUser"]);
	const inferredName = cleanMarkdownText(
		content.match(/(?:likely identity|associated with|points to|identified as|resolved user)\s*(?:is|:)?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})/i)?.[1] || "",
	);
	const name = isPlausibleIdentityName(explicitName)
		? explicitName
		: isPlausibleIdentityName(inferredName)
			? inferredName
			: "";
	const confidence = cleanMarkdownText(
		content.match(/(?:attribution confidence|overall attribution|confidence)\s*[:\-]?\s*(high|medium|low|critical)/i)?.[1] || "",
	) || summary.risk;
	return {
		name: name || `u/${summary.username}`,
		resolved: Boolean(name),
		location: extractField(content, ["Location", "City", "Region", "Possible location"]),
		occupation: extractField(content, ["Occupation", "Role", "Job", "Employer", "Profession"]),
		education: extractField(content, ["Education", "School", "University"]),
		confidence: confidence || summary.risk,
		rationale: extractField(content, ["Rationale", "Reasoning", "Why"]),
	};
}

function extractClueItems(content) {
	const clues = [];
	const seen = new Set();
	const add = (value, source = "Report") => {
		const text = cleanMarkdownText(value);
		if (text.length < 18 || text.length > 240) return;
		if (!/(location|employer|education|github|linkedin|instagram|telegram|email|handle|username|timezone|age|birthday|school|city|bridge|cross-platform|profile|bio|website|evidence|confidence|identity|work|company|reddit|posted|mentions|caste|relationship|degree|neighborhood)/i.test(text)) return;
		const key = text.toLowerCase().slice(0, 80);
		if (seen.has(key)) return;
		seen.add(key);
		clues.push({ text, source });
	};

	for (const match of content.matchAll(/^\s*(?:[-*]|\d+\.)\s+(.+)$/gm)) add(match[1]);
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim().startsWith("|") || /^\s*\|?\s*:?-{3,}/.test(line)) continue;
		const cells = splitMarkdownRow(line).filter(Boolean);
		if (cells.length >= 2 && !/^(attribute|evidence|claim|category|platform|attribute)$/i.test(cleanMarkdownText(cells[0]))) {
			add(`${cells[0]}: ${cells.slice(1, 3).join(" · ")}`, "Table");
		}
	}
	return clues.slice(0, 9);
}

function extractEvidenceLinks(content, directIdentifiers) {
	const urls = [...content.matchAll(/https?:\/\/[^\s)\]|<>"']+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
	const directUrls = directIdentifiers.socialHandles.map((h) => h.url);
	return [...new Set([...directUrls, ...urls])].slice(0, 8);
}

function extractTimeline(content) {
	const rows = [];
	const seen = new Set();
	for (const line of content.split(/\r?\n/)) {
		const year = line.match(/\b(?:19|20)\d{2}\b/);
		if (!year) continue;
		const text = cleanMarkdownText(line);
		if (text.length < 8 || text.length > 200 || seen.has(text)) continue;
		seen.add(text);
		rows.push({ year: year[0], text });
	}
	return rows.slice(0, 6);
}

function platformLabel(platform) {
	const labels = {
		x: "X", github: "GitHub", linkedin: "LinkedIn", instagram: "Instagram",
		reddit: "Reddit", youtube: "YouTube", bluesky: "Bluesky", hackernews: "Hacker News",
		telegram: "Telegram", gitlab: "GitLab", stackoverflow: "Stack Overflow", mastodon: "Mastodon",
	};
	return labels[platform] || platform;
}

const VECTOR_PATTERNS = {
	"Cross-platform": /\b(github|linkedin|instagram|x\.com|twitter|telegram|handle|username|cross-platform|bridge|reuse|reused|same username|alias)\b/gi,
	"Location": /\b(city|location|local|campus|neighborhood|neighbourhood|area|state|country|region|commute|street|road|district|metro|belt|landmark|timezone|fluent)\b/gi,
	"Work & education": /\b(employer|company|job|role|career|university|college|school|degree|graduation|graduat|undergrad|student|studied|major|intern|agency|firm|office|ad agency)\b/gi,
	"Identity / name": /\b(real name|partial name|nickname|surname|first name|name registry|identity|resolved user|exactuser)\b/gi,
	"Temporal / age": /\b(year|years old|age|birthday|born|timeline|semester|graduat|posted|activity|created)\b/gi,
	"Behavioral fingerprint": /\b(personality|behavior|behaviour|trait|fingerprint|writing style|introvert|extrovert|pattern|psycholog|self-disclosure|opsec)\b/gi,
};

const CATEGORY_PATTERNS = [
	"location", "employer", "school", "real name", "age", "dob", "gender",
	"relationship", "family", "financial", "health", "schedule", "routine",
	"cross-platform", "handle", "external link", "writing",
];

/**
 * Compute the de-anonymization exposure index (0–100) plus the contributing
 * signal vectors and structured counts. Deterministic & client-side.
 */
function analyzeReport(detail) {
	if (state.analyzeCache.has(detail.summary.file)) return state.analyzeCache.get(detail.summary.file);

	const content = String(detail.content ?? "");
	const ids = detail.directIdentifiers;
	const emails = ids.emails.length;
	const handles = ids.socialHandles.length;

	const confirmed = countMatches(content, /\bCONFIRMED\b/g);
	const likely = countMatches(content, /\bLIKELY\b/g);
	const possible = countMatches(content, /\bPOSSIBLE\b/g);

	const highFindings = countMatches(content, /high confidence|🔴\s*high|stamp-inline high/gi);
	const medFindings = countMatches(content, /medium confidence|🟡\s*medium/gi);

	const categoryHits = CATEGORY_PATTERNS.filter((c) =>
		new RegExp(`\\b${escapeRegExp(c)}\\b`, "i").test(content));
	const identity = extractLikelyIdentity(content, detail.summary);

	// Proper-noun place names ("City, Country", "lives in Pune") — the strongest
	// real-world OSINT vector and invisible to plain keyword counting.
	const placeCount =
		countMatches(content, /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2})\s*[,—/]+\s*([A-Z][a-z]{2,}|[A-Z]{2})\b/g) +
		countMatches(content, /\b(?:in|from|near|at|based in|lives? in|moved to|return(?:s|ed)? to)\s+[A-Z][a-z]{2,}/g);

	// ── Base band from overall risk ──
	const risk = String(detail.summary.risk || "unknown").toLowerCase();
	let base = 12;
	if (risk.includes("critical")) base = 74;
	else if (risk.includes("high")) base = 68;
	else if (risk.includes("medium")) base = 44;
	else if (risk.includes("low")) base = 22;

	// ── Signal vectors (each 0–100 exposure contribution) ──
	// Per-vector keyword caps keep a single verbose dimension from saturating
	// the gauge; identifiers are blended in where they are the real key.
	const VECTOR_CAPS = {
		"Cross-platform": 28,
		"Location": 32,
		"Work & education": 30,
		"Identity / name": 18,
		"Temporal / age": 30,
		"Behavioral fingerprint": 18,
	};
	const vectors = Object.entries(VECTOR_PATTERNS)
		.map(([label, pattern]) => {
			const count = countMatches(content, pattern);
			const cap = VECTOR_CAPS[label] ?? 24;
			let value = Math.round((Math.min(count, cap) / cap) * 82);
			if (label === "Cross-platform") {
				value = Math.max(value, clamp(emails * 14 + handles * 10 + confirmed * 16 + likely * 6, 0, 100));
			}
			if (label === "Location") {
				value = clamp(Math.round((Math.min(count + placeCount, 40) / 40) * 82) + (identity.location ? 12 : 0), 0, 100);
			}
			if (label === "Identity / name") value = clamp(value + (identity.resolved ? 22 : 0), 0, 100);
			return { label, value: clamp(value, 0, 100), count };
		})
		.sort((a, b) => b.value - a.value);

	const vectorCoverage = vectors.slice(0, 3).reduce((s, v) => s + v.value, 0) / Math.min(3, vectors.length);

	// ── Boosters ──
	const boost =
		clamp(emails * 7, 0, 18) +
		clamp(handles * 5, 0, 18) +
		clamp(confirmed * 9, 0, 20) +
		clamp(likely * 3, 0, 8) +
		clamp(highFindings * 3, 0, 12) +
		clamp(medFindings * 1.5, 0, 6) +
		clamp(categoryHits.length * 2.2, 0, 12) +
		(identity.resolved ? 6 : 0) +
		clamp(placeCount * 1.5, 0, 14) +
		clamp(vectorCoverage * 0.26, 0, 24);

	const score = Math.round(clamp(base + boost, 2, 100));
	const band = bandForScore(score);

	const result = {
		score,
		band,
		risk,
		identity,
		vectors,
		counts: { emails, handles, confirmed, likely, possible, highFindings, medFindings, categories: categoryHits.length },
		clues: extractClueItems(content),
		links: extractEvidenceLinks(content, ids),
		timeline: extractTimeline(content),
		handles: ids.socialHandles,
		emailsList: ids.emails,
	};
	state.analyzeCache.set(detail.summary.file, result);
	return result;
}

/* ── Dossier rendering ──────────────────────────────────────────────────── */

function renderGauge(score, band) {
	const r = 88;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - score / 100);
	const arcColor = band.color;
	return `
		<div class="gauge" role="img" aria-label="De-anonymization index ${score} out of 100, ${band.label}">
			<svg width="210" height="210" viewBox="0 0 210 210">
				<circle class="gauge-track" cx="105" cy="105" r="${r}"></circle>
				<circle class="gauge-arc" cx="105" cy="105" r="${r}"
					stroke="${arcColor}"
					stroke-dasharray="${circ.toFixed(2)}"
					stroke-dashoffset="${offset.toFixed(2)}"></circle>
			</svg>
			<div class="gauge-readout">
				<small>De-anon index</small>
				<div class="gauge-num" style="color:${arcColor}">${score}<sub>/100</sub></div>
				<span class="gauge-band" style="color:${arcColor}">${band.label}</span>
			</div>
		</div>
	`;
}

function renderVectors(vectors) {
	return `
		<div class="vectors">
			<div class="vectors-head">
				<h3>Exposure vectors</h3>
				<small>where the identity signal concentrates</small>
			</div>
			${vectors
				.map(
					(v) => `
				<div class="vector">
					<span class="vector-label">${escapeHtml(v.label)}</span>
					<span class="vector-bar"><i style="width:${v.value}%"></i></span>
					<span class="vector-val">${v.value}</span>
				</div>
			`,
				)
				.join("")}
		</div>
	`;
}

function renderStatStrip(a, summary) {
	const stat = (value, label) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`;
	return `
		<div class="stat-strip">
			${stat(a.counts.emails, "Emails")}
			${stat(a.counts.handles, "X-Platform")}
			${stat(summary.findingCount, "Findings")}
			${stat(a.counts.confirmed, "Confirmed")}
			${stat(a.counts.categories, "Categories")}
		</div>
	`;
}

function renderIdentityLine(identity) {
	const bits = [identity.location, identity.occupation, identity.education].filter(Boolean);
	return `
		<div class="identity-line">
			<span class="il-label">Resolved →</span>
			<strong>${escapeHtml(identity.name)}</strong>
			${bits.length ? `<span style="color:var(--text-dim)">${bits.map(escapeHtml).join(" · ")}</span>` : ""}
			<span class="stamp ${riskClass(identity.confidence)}" style="margin-left:auto">${escapeHtml(identity.confidence || "unknown")}</span>
		</div>
	`;
}

function renderCluesRail(a) {
	const handleRows = a.handles.length
		? a.handles
				.map(
					(h) => `
			<a class="handle-row" href="${sanitizeUrl(h.url)}" target="_blank" rel="noreferrer">
				<span class="platform-mark">${escapeHtml(platformLabel(h.platform).slice(0, 2))}</span>
				<span><strong>${escapeHtml(h.handle)}</strong><small>${escapeHtml(platformLabel(h.platform))}</small></span>
				<span class="stamp-inline confirmed" style="transform:rotate(0)">↗</span>
			</a>`,
				)
				.join("")
		: `<div class="empty-inline">No cross-platform handles harvested.</div>`;

	const emailTags = a.emailsList.length
		? a.emailsList.map((e) => `<span class="id-tag">${escapeHtml(e)}</span>`).join("")
		: `<div class="empty-inline">No emails harvested.</div>`;

	const clueItems = a.clues.length
		? a.clues
				.map(
					(c) => `<div class="clue-item"><p>${escapeHtml(c.text)}</p><span class="src">${escapeHtml(c.source)}</span></div>`,
				)
				.join("")
		: `<div class="empty-inline">No clue-like lines detected.</div>`;

	const linkItems = a.links.length
		? a.links.map((u) => `<a class="evidence-link" href="${sanitizeUrl(u)}" target="_blank" rel="noreferrer">${escapeHtml(u)}</a>`).join("")
		: `<div class="empty-inline">No evidence URLs detected.</div>`;

	const timelineItems = a.timeline.length
		? a.timeline.map((t) => `<div class="timeline-row"><strong>${escapeHtml(t.year)}</strong><p>${escapeHtml(t.text)}</p></div>`).join("")
		: `<div class="empty-inline">No dated claims detected.</div>`;

	return `
		<aside class="clues-rail" aria-label="Clues and evidence">
			<div class="clue-block">
				<div class="clue-head"><h4>Resolved identity</h4><span class="count">${a.identity.resolved ? "✓" : "?"}</span></div>
				${renderIdentityLine(a.identity)}
			</div>
			<div class="clue-block">
				<div class="clue-head"><h4>Cross-platform handles</h4><span class="count">${a.handles.length}</span></div>
				${handleRows}
			</div>
			<div class="clue-block">
				<div class="clue-head"><h4>Direct identifiers</h4><span class="count">${a.emailsList.length}</span></div>
				${emailTags}
			</div>
			<div class="clue-block">
				<div class="clue-head"><h4>Clues</h4><span class="count">${a.clues.length}</span></div>
				${clueItems}
			</div>
			<div class="clue-block">
				<div class="clue-head"><h4>Evidence</h4><span class="count">${a.links.length}</span></div>
				${linkItems}
			</div>
			<div class="clue-block">
				<div class="clue-head"><h4>Timeline</h4><span class="count">${a.timeline.length}</span></div>
				${timelineItems}
			</div>
		</aside>
	`;
}

/* ── API + state ────────────────────────────────────────────────────────── */

async function api(path, options) {
	const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || response.statusText);
	return body;
}

async function refresh() {
	const [health, reportData, scanData] = await Promise.all([
		api("/api/health"),
		api("/api/reports"),
		api("/api/scans"),
	]);
	state.reports = reportData.reports;
	state.jobs = scanData.jobs;
	$("#providerLabel").textContent = health.provider;
	renderAll();
}

function setView(view) {
	state.activeView = view;
	$$(".view").forEach((node) => node.classList.toggle("active", node.id === `view-${view}`));
	$$(".nav-button").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
	// Render the view content lazily on first visit so initial page load
	// doesn't pay for views the user might not open.
	if (!state.renderedViews.has(view)) {
		state.renderedViews.add(view);
		renderView(view);
	}
	if (view === "reports" && state.reports.length && !state.selectedReport) openReport(state.reports[0].file);
}

function renderView(view) {
	switch (view) {
		case "dashboard":
			renderRecentReports();
			renderScanActivity();
			break;
		case "scan":
			break;
		case "reports":
			renderReportRows();
			break;
		case "compare":
			renderCompareOptions();
			break;
	}
}

function renderAll() {
	const active = state.jobs.filter((j) => j.status === "running" || j.status === "queued").length;
	const identifiers = state.reports.reduce((sum, r) => sum + r.identifierCount, 0);
	$("#reportCount").textContent = state.reports.length;
	$("#activeCount").textContent = active;
	$("#identifierCount").textContent = identifiers;
	$("#fileCount").textContent = state.reports.length;
	// Only re-render views the user has actually opened; repaint the active
	// one eagerly so header / list stay in sync after a refresh.
	state.renderedViews.add(state.activeView);
	for (const view of state.renderedViews) renderView(view);
}

function miniScore(report) {
	// lightweight estimate for list cards (full compute happens on open).
	const base = { critical: 86, high: 74, medium: 50, low: 26, unknown: 14 }[riskClass(report.risk)] ?? 14;
	return clamp(base + report.identifierCount * 4, 0, 99);
}

function renderRecentReports() {
	const rows = state.reports.slice(0, 6).map((r) => caseCard(r)).join("");
	$("#recentReports").innerHTML = rows || `<div class="empty-block">No dossiers filed yet — initiate a sweep to begin.</div>`;
}

function caseCard(report) {
	const score = miniScore(report);
	const band = bandForScore(score);
	return `
		<button class="case-card" data-open-report="${escapeHtml(report.file)}">
			<span class="sevbar sev-${riskClass(report.risk)}" style="background:${band.color}"></span>
			<span class="case-main">
				<span class="case-title">u/${escapeHtml(report.username)}</span>
				<span class="case-sub">
					<span>${formatDate(report.generatedAt || report.modifiedAt)}</span>
					<span>${report.identifierCount} IDs</span>
					<span>${report.findingCount} findings</span>
				</span>
			</span>
			<span class="case-tail">
				<span class="miniscore"><strong style="color:${band.color}">${score}</strong><small>index</small></span>
				<span class="sev ${riskClass(report.risk)}">${escapeHtml(report.risk)}</span>
			</span>
		</button>
	`;
}

function renderReportRows() {
	const query = $("#reportSearch")?.value?.trim().toLowerCase() || "";
	const filtered = state.reports.filter((r) =>
		`${r.file} ${r.username} ${r.brief} ${r.risk}`.toLowerCase().includes(query));
	$("#reportRows").innerHTML =
		filtered.map((r) => fileCard(r)).join("") ||
		`<div class="empty-block">No matching dossiers.</div>`;
}

function fileCard(report) {
	const score = miniScore(report);
	const band = bandForScore(score);
	return `
		<button class="file-card ${state.selectedReport === report.file ? "active" : ""}" data-open-report="${escapeHtml(report.file)}">
			<span class="sevbar" style="background:${band.color}"></span>
			<span class="file-main">
				<span class="file-title">u/${escapeHtml(report.username)}</span>
				<span class="file-sub">
					<span>${formatDate(report.generatedAt || report.modifiedAt)}</span>
					<span>${report.identifierCount} IDs</span>
				</span>
			</span>
			<span class="file-tail">
				<span class="miniscore"><strong style="color:${band.color}">${score}</strong><small>${band.label}</small></span>
			</span>
		</button>
	`;
}

function renderScanActivity() {
	const items = state.jobs
		.slice(0, 8)
		.map(
			(j) => `
		<div class="feed-item">
			<div>
				<strong>u/${escapeHtml(j.options.username)}</strong>
				<small>${j.options.deep ? "deep" : "standard"}${j.options.web ? " · web" : ""} · ${formatDate(j.startedAt)}</small>
			</div>
			<span class="stamp ${j.status}">${j.status}</span>
		</div>`,
		)
		.join("");
	$("#scanActivity").innerHTML = items || `<div class="empty-block">No operations launched from this console.</div>`;
}

function renderCompareOptions() {
	const options = state.reports.map((r) => `<option value="${escapeHtml(r.file)}">u/${escapeHtml(r.username)} · ${escapeHtml(r.file)}</option>`).join("");
	$("#leftReport").innerHTML = options;
	$("#rightReport").innerHTML = options;
	if (state.reports[1]) $("#rightReport").value = state.reports[1].file;
}

async function openReport(file) {
	state.selectedReport = file;
	state.chatHistory = [];
	state.chatBusy = false;
	setView("reports");
	$$(".file-card").forEach((n) => n.classList.toggle("active", n.dataset.openReport === file));
	const url = new URL(window.location.href);
	url.searchParams.set("report", file);
	window.history.replaceState({}, "", url);
	$("#reportPreview").innerHTML = `<div class="empty-block">Decrypting ${escapeHtml(file)}…</div>`;
	try {
		const detail = await api(`/api/reports/${encodeURIComponent(file)}`);
		const a = analyzeReport(detail);
		// Phase 1: paint the hero (gauge, vectors, stats) synchronously so the
		// user sees *something* immediately. The heavy markdown pass below can
		// be a half-second on large reports; without the split the whole dossier
		// waits on it.
		$("#reportPreview").innerHTML = `
			<div class="dossier-hero">
				<div class="dossier-hero-top">
					<div class="hero-id">
						<span class="eyebrow">Dossier · u/${escapeHtml(detail.summary.username)}</span>
						<h2>${escapeHtml(detail.summary.username === "unknown" ? detail.summary.file : "u/" + detail.summary.username)}</h2>
						<div class="hero-meta">
							<span><b>FILE</b> ${escapeHtml(detail.summary.file)}</span>
							<span><b>FILED</b> ${formatDate(detail.summary.generatedAt || detail.summary.modifiedAt)}</span>
							<span><b>RISK</b> ${escapeHtml(detail.summary.risk)}</span>
							<span><b>FORMAT</b> ${escapeHtml(detail.summary.type)}</span>
						</div>
					</div>
					<div class="hero-actions">
						<a class="dl-link" href="/api/download/${encodeURIComponent(file)}" download>↓ download</a>
					</div>
				</div>
				<div class="exposure-grid">
					${renderGauge(a.score, a.band)}
					${renderVectors(a.vectors)}
				</div>
				${renderStatStrip(a, detail.summary)}
			</div>
			<div class="dossier-body-grid">
				<div class="reader">
					<div class="reader-head">
						<h3>Full report</h3>
						<div class="reader-tabs">
							<button class="reader-tab active">rendered</button>
						</div>
					</div>
					<div class="markdown-body"><div class="empty-block">Rendering…</div></div>
					<div class="chat-panel">
						<div class="chat-head">
							<div>
								<h3>Ask the verdict</h3>
								<small>grounded in this dossier — no new web research</small>
							</div>
							<button id="chatClear" class="text-button" type="button">clear</button>
						</div>
						<div id="chatLog" class="chat-log" aria-live="polite"></div>
						<form id="chatForm" class="chat-form">
							<input id="chatInput" autocomplete="off" placeholder="Ask about the findings, evidence, or remediation…" />
							<button type="submit" class="submit-button compact">Ask →</button>
						</form>
					</div>
				</div>
				${renderCluesRail(a)}
			</div>
		`;
		// Phase 2: render the markdown outside the initial paint. Serve from
		// cache when the same file is re-opened. requestIdleCallback with a
		// small timeout so even busy pages schedule the work.
		const renderBody = () => {
			const body = $("#reportPreview .markdown-body");
			if (!body) return; // user navigated away mid-render
			let html = state.markdownCache.get(file);
			if (!html) {
				html = renderMarkdown(detail.content);
				state.markdownCache.set(file, html);
			}
			body.innerHTML = html;
		};
		if ("requestIdleCallback" in window) {
			window.requestIdleCallback(renderBody, { timeout: 250 });
		} else {
			setTimeout(renderBody, 0);
		}
	} catch (error) {
		$("#reportPreview").innerHTML = `<div class="empty-block error">${escapeHtml(error.message)}</div>`;
	}
}

/* ── Chat with the verdict ──────────────────────────────────────────────── */

function chatAppend(role, content) {
	const log = $("#chatLog");
	if (!log) return;
	const node = document.createElement("div");
	node.className = `chat-msg ${role}`;
	const body = document.createElement("div");
	body.className = "chat-bubble";
	body.innerHTML = role === "user" ? escapeHtml(content) : renderMarkdown(content);
	node.appendChild(body);
	log.appendChild(node);
	log.scrollTop = log.scrollHeight;
}

async function sendChat() {
	if (state.chatBusy || !state.selectedReport) return;
	const input = $("#chatInput");
	const question = input?.value.trim();
	if (!question) return;
	input.value = "";
	chatAppend("user", question);
	state.chatHistory.push({ role: "user", content: question });
	state.chatBusy = true;
	chatSetBusy(true);
	try {
		const { answer } = await api("/api/chat", {
			method: "POST",
			body: JSON.stringify({ file: state.selectedReport, question, history: state.chatHistory.slice(0, -1) }),
		});
		chatAppend("assistant", answer);
		state.chatHistory.push({ role: "assistant", content: answer });
	} catch (error) {
		chatAppend("assistant", `⚠ ${error.message}`);
	} finally {
		state.chatBusy = false;
		chatSetBusy(false);
	}
}

function chatSetBusy(busy) {
	const input = $("#chatInput");
	if (input) input.disabled = busy;
	const button = $("#chatForm button");
	if (button) button.disabled = busy;
}

/* ── Scan lifecycle ─────────────────────────────────────────────────────── */

async function submitScan(event) {
	event.preventDefault();
	const form = new FormData(event.currentTarget);
	const payload = {
		username: form.get("username"),
		subjectName: form.get("subjectName"),
		provider: form.get("provider"),
		model: form.get("model"),
		years: Number(form.get("years")),
		deep: form.has("deep"),
		web: form.has("web"),
		json: form.has("json"),
	};
	$("#liveLog").innerHTML = "";
	$("#liveStatus").textContent = "starting";
	$("#liveStatus").className = "stamp running";
	try {
		const { job } = await api("/api/scans", { method: "POST", body: JSON.stringify(payload) });
		connectJob(job.id);
		await refresh();
	} catch (error) {
		appendLiveLog("error", error.message);
		$("#liveStatus").textContent = "failed";
		$("#liveStatus").className = "stamp failed";
	}
}

function connectJob(id) {
	if (state.eventSource) state.eventSource.close();
	const source = new EventSource(`/api/scans/${id}/events`);
	state.eventSource = source;
	source.addEventListener("job", (event) => updateLiveJob(JSON.parse(event.data)));
	source.addEventListener("complete", async (event) => {
		updateLiveJob(JSON.parse(event.data));
		await refresh();
	});
	source.addEventListener("failed", (event) => updateLiveJob(JSON.parse(event.data)));
	source.addEventListener("log", (event) => {
		const log = JSON.parse(event.data);
		appendLiveLog(log.kind, log.message, log.at);
	});
}

function updateLiveJob(job) {
	$("#liveStatus").textContent = job.status;
	$("#liveStatus").className = `stamp ${job.status === "failed" ? "failed" : job.status === "completed" ? "completed" : "running"}`;
	if (job.reportFile) appendLiveLog("status", `Report ready: ${job.reportFile}`);
}

/* Live telemetry used to prepend a fresh node per SSE event — a burst of
   token/tool events forces a style+layout recalc per insert, which is the
   visible "the Initiate view janks while a scan runs" complaint. Buffer
   entries and flush at most once per animation frame; cap the total so long
   scans don't balloon the DOM. */
const LIVE_LOG_MAX = 400;

function flushLiveLog() {
	state.liveLogRaf = 0;
	const liveLog = $("#liveLog");
	if (!liveLog) {
		state.liveLogQueue.length = 0;
		return;
	}
	const frag = document.createDocumentFragment();
	for (const entry of state.liveLogQueue) {
		const node = document.createElement("div");
		node.className = `log-line ${entry.kind}`;
		node.innerHTML = `<span>${formatDate(entry.at)}</span><code>${escapeHtml(entry.kind)}</code><p>${escapeHtml(entry.message)}</p>`;
		frag.appendChild(node);
	}
	state.liveLogQueue.length = 0;
	liveLog.prepend(frag);
	// Trim tail so long scans don't keep growing the DOM indefinitely.
	while (liveLog.children.length > LIVE_LOG_MAX) liveLog.lastChild.remove();
}

function appendLiveLog(kind, message, at = new Date().toISOString()) {
	state.liveLogQueue.push({ kind, message, at });
	if (!state.liveLogRaf) {
		state.liveLogRaf = requestAnimationFrame(flushLiveLog);
	}
}

/* ── Compare ────────────────────────────────────────────────────────────── */

async function compareSelected() {
	const left = $("#leftReport").value;
	const right = $("#rightReport").value;
	if (!left || !right) return;
	$("#compareResult").innerHTML = `<div class="empty-block">Correlating…</div>`;
	try {
		const result = await api("/api/compare", { method: "POST", body: JSON.stringify({ left, right }) });
		const shared = [...result.overlap.emails, ...result.overlap.handles];
		$("#compareResult").innerHTML = `
			<div class="compare-grid">
				${compareCard(result.left)}
				${compareCard(result.right)}
			</div>
			<div class="overlap">
				<h3>Deterministic overlap</h3>
				<div class="idrow">
					<span class="chip">${result.overlap.emails.length} shared emails</span>
					<span class="chip">${result.overlap.handles.length} shared handles</span>
				</div>
				<pre>${escapeHtml(shared.join("\n") || "// no deterministic overlap between subjects")}</pre>
			</div>
		`;
	} catch (error) {
		$("#compareResult").innerHTML = `<div class="empty-block error">${escapeHtml(error.message)}</div>`;
	}
}

function compareCard(detail) {
	return `
		<article class="compare-card">
			<h3>u/${escapeHtml(detail.summary.username)}</h3>
			<div class="idrow">
				<span class="sev ${riskClass(detail.summary.risk)}">${escapeHtml(detail.summary.risk)}</span>
				<span class="chip">${detail.directIdentifiers.emails.length} emails</span>
				<span class="chip">${detail.directIdentifiers.socialHandles.length} handles</span>
			</div>
			<p>${escapeHtml(detail.summary.brief || "No brief extracted.")}</p>
		</article>
	`;
}

/* ── Clock + session + init ─────────────────────────────────────────────── */

function tickClock() {
	if (document.hidden) return; // paused; visibilitychange handler resumes
	$("#clock").textContent = new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date());
}

function paintSession() {
	const hex = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let id = "";
	for (let i = 0; i < 4; i += 1) id += hex[Math.floor(Math.random() * hex.length)];
	$("#sessionId").textContent = `CASE-${id}`;
}

document.addEventListener("click", (event) => {
	const viewButton = event.target.closest("[data-view]");
	if (viewButton) setView(viewButton.dataset.view);
	const reportButton = event.target.closest("[data-open-report]");
	if (reportButton) openReport(reportButton.dataset.openReport);
});

$("#scanForm").addEventListener("submit", submitScan);
$("#refreshButton").addEventListener("click", refresh);
$("#themeToggle").addEventListener("click", toggleTheme);
/* Debounce search — each keystroke used to walk all reports and rebuild the
   list. 120ms is below perception but big enough to coalesce fast typing. */
let searchTimer = 0;
$("#reportSearch").addEventListener("input", () => {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(renderReportRows, 120);
});
$("#compareButton").addEventListener("click", compareSelected);

document.addEventListener("submit", (event) => {
	if (event.target && event.target.id === "chatForm") {
		event.preventDefault();
		sendChat();
	}
});
document.addEventListener("click", (event) => {
	if (event.target && event.target.id === "chatClear") {
		state.chatHistory = [];
		const log = $("#chatLog");
		if (log) log.innerHTML = "";
	}
});
setInterval(tickClock, 1000);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) tickClock(); // instant catch-up on return
});
tickClock();
paintSession();
refresh()
	.then(() => {
		const report = new URLSearchParams(window.location.search).get("report");
		if (report) openReport(report);
	})
	.catch((error) => appendLiveLog("error", error.message));
