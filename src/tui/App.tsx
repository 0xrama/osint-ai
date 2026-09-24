import { useCallback, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { UsernameInput } from "./UsernameInput.tsx";
import { AnalysisView } from "./AnalysisView.tsx";
import { ReportView } from "./ReportView.tsx";
import { StatusBar } from "./StatusBar.tsx";

export type AppScreen = "input" | "analyzing" | "report";

export interface AnalysisOptions {
	deep: boolean;
	years: number;
	web: boolean;
	subjectName?: string;
}

export interface ReportData extends AnalysisOptions {
	username: string;
	content: string;
	filePath: string | null;
	toolCalls: number;
	iterations: number;
}

export function App(props: {
	initialUsername?: string;
	initialDeep?: boolean;
	initialYears?: number;
	initialWeb?: boolean;
	initialSubjectName?: string;
	autoStart?: boolean;
}) {
	const [screen, setScreen] = useState<AppScreen>(props.autoStart && props.initialUsername ? "analyzing" : "input");
	const [pendingUsername, setPendingUsername] = useState(props.initialUsername ?? "");
	const [options, setOptions] = useState<AnalysisOptions>({
		deep: props.initialDeep ?? false,
		years: props.initialYears ?? 7,
		web: props.initialWeb ?? false,
		subjectName: props.initialSubjectName,
	});
	const [report, setReport] = useState<ReportData | null>(null);
	const renderer = useRenderer();

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") renderer.destroy();
	});

	const handleStart = useCallback((username: string, nextOptions: AnalysisOptions) => {
		setPendingUsername(username);
		setOptions(nextOptions);
		setReport(null);
		setScreen("analyzing");
	}, []);

	const handleComplete = useCallback((data: ReportData) => {
		setReport(data);
		setScreen("report");
	}, []);

	const handleNewScan = useCallback(() => {
		setPendingUsername("");
		setReport(null);
		setScreen("input");
	}, []);

	return (
		<box flexDirection="column" width="100%" height="100%" backgroundColor="#11111b">
			{screen === "input" && (
				<UsernameInput
					initialUsername={pendingUsername}
					initialOptions={options}
					onStart={handleStart}
				/>
			)}
			{screen === "analyzing" && (
				<AnalysisView
					username={pendingUsername}
					options={options}
					onComplete={handleComplete}
					onCancel={handleNewScan}
				/>
			)}
			{screen === "report" && report && (
				<ReportView report={report} onNewScan={handleNewScan} />
			)}
			<StatusBar screen={screen} options={options} />
		</box>
	);
}
