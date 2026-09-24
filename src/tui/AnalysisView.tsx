import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { join } from "node:path";
import { assertLLMConfig } from "../runtime/providers/index.ts";
import { describeModels } from "../config/models.ts";
import { runAudit, saveReport, type AuditCallbacks } from "../analysis/pipeline.ts";
import type { AnalysisOptions, ReportData } from "./App.tsx";

type LogEntry = {
	time: string;
	type: "info" | "tool" | "error" | "done";
	message: string;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LOG_LINES = 250;

function timestamp(): string {
	const now = new Date();
	return `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
}

const DATA_DIR = join(import.meta.dir, "..", "..", "data");

export function AnalysisView(props: {
	username: string;
	options: AnalysisOptions;
	onComplete: (data: ReportData) => void;
	onCancel: () => void;
}) {
	const [status, setStatus] = useState("Starting...");
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [reportPreview, setReportPreview] = useState("");
	const [error, setError] = useState("");
	const [spinner, setSpinner] = useState(0);
	const startedRef = useRef(false);
	const cancelledRef = useRef(false);

	const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
		setLogs((prev) => {
			const next = [...prev, { time: timestamp(), type, message }];
			return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
		});
	}, []);

	useEffect(() => {
		const id = setInterval(() => setSpinner((value) => (value + 1) % SPINNER.length), 90);
		return () => clearInterval(id);
	}, []);

	useKeyboard((key) => {
		if (key.name === "escape") {
			cancelledRef.current = true;
			props.onCancel();
		}
	});

	const run = useCallback(async () => {
		if (startedRef.current) return;
		startedRef.current = true;

		try {
			assertLLMConfig();
		} catch (err: any) {
			setError(err.message);
			setStatus("Configuration error");
			addLog(err.message, "error");
			return;
		}

		addLog(describeModels());
		const mode = props.options.deep
			? `deep ${props.options.years}yr (multi-agent)`
			: "standard (live agent)";
		const enrich = [
			props.options.web ? "Firecrawl" : null,
		].filter(Boolean).join(" + ");
		addLog(`Mode: ${mode}${enrich ? ` + ${enrich}` : ""}`);
		setStatus(`Analyzing u/${props.username}`);

		const callbacks: AuditCallbacks = {
			onStatus: (message) => setStatus(message),
			onProgress: (message) => addLog(message),
			onToolCall: (name, args) => {
				setStatus(`Calling ${name}...`);
				const argText = JSON.stringify(args);
				addLog(`→ ${name} ${argText.length > 160 ? `${argText.slice(0, 160)}…` : argText}`, "tool");
			},
			onToolResult: (name, value) => {
				setStatus(`${name} complete`);
				const size = JSON.stringify(value).length;
				addLog(`← ${name} complete (${size.toLocaleString()} chars)`, "tool");
			},
			onToken: (text) => {
				// Live-agent streaming (standard path). Deep path populates preview on completion.
				setReportPreview(text);
			},
		};

		try {
			const result = await runAudit(
				{
					username: props.username,
					deep: props.options.deep,
					years: props.options.years,
					web: props.options.web,
					dataDir: DATA_DIR,
					candidate: {
						name: props.options.subjectName,
					},
				},
				callbacks,
			);

			if (cancelledRef.current) return;

			// Deep path doesn't stream; show the final synthesized content.
			setReportPreview((prev) => prev || result.content);

			const filepath = saveReport(props.username, result.content);
			setStatus("Analysis complete");
			addLog(`Saved report: ${filepath}`, "done");
			// Surface the narrative person-brief as a log entry so the result is visible.
			if (result.brief) addLog(`Summary — u/${props.username}: ${result.brief}`, "done");
			props.onComplete({
				username: props.username,
				content: result.content,
				filePath: filepath,
				toolCalls: result.toolCalls,
				iterations: result.iterations,
				...props.options,
			});
		} catch (err: any) {
			if (cancelledRef.current) return;
			setError(err.message ?? String(err));
			setStatus("Analysis failed");
			addLog(err.message ?? String(err), "error");
		}
	}, [props.username, props.options, props.onComplete, addLog]);

	useEffect(() => {
		void run();
	}, [run]);

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box backgroundColor="#181825" paddingX={1} justifyContent="space-between">
				<text fg="#89b4fa"><strong>{SPINNER[spinner]} {status}</strong></text>
				<text fg="#6c7086">Esc: cancel</text>
			</box>

			<box flexGrow={1} flexDirection="row">
				<box flexDirection="column" width="42%" border borderStyle="single" borderColor="#45475a">
					<box backgroundColor="#313244" paddingX={1}><text fg="#cdd6f4"><strong>Event log</strong></text></box>
					<scrollbox focused flexGrow={1}>
						<box flexDirection="column" padding={1}>
							{logs.map((entry, index) => (
								<text key={`${entry.time}-${index}`} fg={entry.type === "error" ? "#f38ba8" : entry.type === "tool" ? "#f9e2af" : entry.type === "done" ? "#a6e3a1" : "#bac2de"}>
									{entry.time} {entry.message}
								</text>
							))}
							{error && <text fg="#f38ba8">Error: {error}</text>}
						</box>
					</scrollbox>
				</box>

				<box flexDirection="column" flexGrow={1} border borderStyle="single" borderColor="#45475a">
					<box backgroundColor="#313244" paddingX={1}><text fg="#cdd6f4"><strong>Report preview</strong></text></box>
					<scrollbox flexGrow={1}>
						<box padding={1}>
							{reportPreview ? <markdown content={reportPreview} /> : <text fg="#6c7086">Report will appear as the analysis progresses.</text>}
						</box>
					</scrollbox>
				</box>
			</box>
		</box>
	);
}
