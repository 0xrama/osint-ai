import { useCallback, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { AnalysisOptions } from "./App.tsx";

interface UsernameInputProps {
	initialUsername: string;
	initialOptions: AnalysisOptions;
	onStart: (username: string, options: AnalysisOptions) => void;
}

type Field = "username" | "deep" | "years" | "web" | "start";
const fields: Field[] = ["username", "deep", "years", "web", "start"];

export function UsernameInput({ initialUsername, initialOptions, onStart }: UsernameInputProps) {
	const [username, setUsername] = useState(initialUsername);
	const [deep, setDeep] = useState(initialOptions.deep);
	const [years, setYears] = useState(initialOptions.years);
	const [web, setWeb] = useState(initialOptions.web);
	const [focused, setFocused] = useState<Field>("username");
	const [error, setError] = useState("");

	const start = useCallback(() => {
		const clean = username.trim().replace(/^u\//, "");
		if (!/^[A-Za-z0-9_-]{3,20}$/.test(clean)) {
			setError("Enter a valid Reddit username: 3-20 chars, letters/numbers/_/-");
			setFocused("username");
			return;
		}
		setError("");
		onStart(clean, { deep, years, web });
	}, [username, deep, years, web, onStart]);

	useKeyboard((key) => {
		if (key.name === "tab" || key.name === "down" || key.name === "j") {
			setFocused((current) => fields[(fields.indexOf(current) + 1) % fields.length]);
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setFocused((current) => fields[(fields.indexOf(current) - 1 + fields.length) % fields.length]);
			return;
		}
		if (key.name === "space") {
			if (focused === "deep") setDeep((value) => !value);
			if (focused === "web") setWeb((value) => !value);
			return;
		}
		if (focused === "years") {
			if (["left", "h", "-"].includes(key.name)) setYears((value) => Math.max(1, value - 1));
			if (["right", "l", "+"].includes(key.name)) setYears((value) => Math.min(20, value + 1));
			return;
		}
		if (key.name === "enter") {
			if (focused === "deep") setDeep((value) => !value);
			else if (focused === "web") setWeb((value) => !value);
			else if (focused === "start") start();
			else if (focused !== "username") setFocused("start");
		}
		if (key.name === "s" && focused !== "username") start();
	});

	const active = "#89b4fa";
	const muted = "#6c7086";
	const panel = "#181825";
	const selected = "#313244";
	const isFocused = (field: Field) => focused === field;

	return (
		<box flexDirection="column" alignItems="center" justifyContent="center" width="100%" height="100%">
			<box flexDirection="column" width={76} gap={1}>
				<box flexDirection="column" alignItems="center" paddingBottom={1}>
					<text fg="#cba6f7"><strong>osint-ai</strong></text>
					<text fg={muted}>TUI · OpenAI-compatible · gpt-5.4-mini default</text>
					<text fg="#f9e2af">De-anonymization & identity-resolution research tool</text>
				</box>

				<box flexDirection="column" gap={0}>
					<text fg={isFocused("username") ? active : muted}><strong>Username</strong></text>
					<box border borderStyle="single" borderColor={isFocused("username") ? active : "#45475a"} backgroundColor={panel} paddingX={1}>
						<text fg="#cdd6f4">u/</text>
						<input
							value={username}
							onChange={setUsername}
							onSubmit={start}
							focused={isFocused("username")}
							placeholder="reddit username"
							width={52}
							backgroundColor="transparent"
							textColor="#cdd6f4"
							cursorColor={active}
						/>
					</box>
				</box>

				<OptionRow label="Deep Reddit scan (multi-agent)" value={deep} focused={isFocused("deep")} onClick={() => { setFocused("deep"); setDeep((v) => !v); }} />
				<box border borderStyle="single" borderColor={isFocused("years") ? active : "#45475a"} backgroundColor={isFocused("years") ? selected : panel} paddingX={1}>
					<text fg={isFocused("years") ? active : "#cdd6f4"}><strong>Years: {years}</strong></text>
					<text fg={muted}>  ←/→ or +/- to adjust</text>
				</box>
				<OptionRow label="Enable Firecrawl web tools" value={web} focused={isFocused("web")} onClick={() => { setFocused("web"); setWeb((v) => !v); }} />

				<box border borderStyle={isFocused("start") ? "double" : "single"} borderColor={isFocused("start") ? "#a6e3a1" : "#45475a"} backgroundColor={isFocused("start") ? selected : panel} justifyContent="center" paddingX={1} onMouseDown={() => { setFocused("start"); start(); }}>
					<text fg={isFocused("start") ? "#a6e3a1" : "#cdd6f4"}><strong>Start audit</strong></text>
				</box>

				{error && <text fg="#f38ba8">{error}</text>}
				<text fg={muted}>Tab/J/K: navigate · Space: toggle · Enter/S: start · Ctrl+C: quit</text>
			</box>
		</box>
	);
}

function OptionRow(props: { label: string; value: boolean; focused: boolean; onClick: () => void }) {
	return (
		<box border borderStyle="single" borderColor={props.focused ? "#89b4fa" : "#45475a"} backgroundColor={props.focused ? "#313244" : "#181825"} paddingX={1} onMouseDown={props.onClick}>
			<text fg={props.value ? "#a6e3a1" : "#6c7086"}>{props.value ? "✓" : "○"} </text>
			<text fg={props.focused ? "#cdd6f4" : "#bac2de"}><strong>{props.label}</strong></text>
			<text fg="#6c7086">  Space to toggle</text>
		</box>
	);
}
