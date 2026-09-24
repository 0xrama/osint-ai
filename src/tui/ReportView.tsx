import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ReportData } from "./App.tsx";

export function ReportView(props: { report: ReportData; onNewScan: () => void }) {
	const [raw, setRaw] = useState(false);
	useKeyboard((key) => {
		if (key.name === "n") props.onNewScan();
		if (key.name === "r") setRaw((value) => !value);
	});

	const mode = props.report.deep ? `deep:${props.report.years}yr` : "standard";
	const web = props.report.web ? " + web" : "";
	const content = `# Reddit De-anonymization Report: u/${props.report.username}\n\n${props.report.content}`;

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box backgroundColor="#181825" paddingX={1} justifyContent="space-between">
				<text>
					<span fg="#89b4fa"><strong>Report </strong></span>
					<span fg="#cdd6f4">u/{props.report.username}</span>
					<span fg="#6c7086"> · {mode}{web} · tools:{props.report.toolCalls} · iter:{props.report.iterations}</span>
				</text>
				<text fg="#6c7086">N: new scan · R: {raw ? "markdown" : "raw"} · Ctrl+C: quit</text>
			</box>
			{props.report.filePath && (
				<box paddingX={1} backgroundColor="#11111b">
					<text fg="#a6e3a1">Saved: {props.report.filePath}</text>
				</box>
			)}
			<scrollbox focused flexGrow={1}>
				<box padding={1}>
					{raw ? <code content={content} filetype="markdown" /> : <markdown content={content} />}
				</box>
			</scrollbox>
		</box>
	);
}
