/**
 * Word-level reading of shell command lines, shared by the shell tool (which points plain
 * file inspection at native tools) and the UI (which labels commands by what they do).
 */

/** Splits a simple command line into words, honouring single/double quotes and backslashes. */
export function words(line: string): string[] | undefined {
	const out: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && index + 1 < line.length) current += line[++index];
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (char === "\\" && index + 1 < line.length) {
			current += line[++index];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) out.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (quote) return undefined;
	if (started) out.push(current);
	return out;
}

/** grep/rg flags whose value is a separate word, so it is never mistaken for the pattern. */
export const GREP_VALUE_FLAGS = new Set([
	"-A",
	"-B",
	"-C",
	"-m",
	"-e",
	"-f",
	"-g",
	"-t",
	"-T",
	"-d",
	"-D",
	"--include",
	"--exclude",
	"--glob",
	"--type",
	"--max-count",
	"--regexp",
	"--file",
]);
