import type { AnalysisOptions, AppScreen } from "./App.tsx";

export function StatusBar(props: { screen: AppScreen; options: AnalysisOptions }) {
	const screenLabel: Record<AppScreen, string> = {
		input: "INPUT",
		analyzing: "ANALYZING",
		report: "REPORT",
	};
	return (
		<box backgroundColor="#181825" paddingX={1} justifyContent="space-between">
			<text>
				<span fg="#6c7086">osint-ai </span>
				<span fg="#89b4fa">{screenLabel[props.screen]}</span>
				{props.options.deep && <span fg="#f9e2af"> · deep:{props.options.years}yr</span>}
				{props.options.web && <span fg="#a6e3a1"> · Firecrawl</span>}
			</text>
			<text fg="#6c7086">OpenAI-compatible · Ctrl+C quit</text>
		</box>
	);
}
