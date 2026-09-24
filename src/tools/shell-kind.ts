import { GREP_VALUE_FLAGS, words } from "./shell-words.ts";

/**
 * What a shell command does, for its row header only: `sed -n 1,20p a.ts` reads as
 * `Read(a.ts)`, `rg foo src` as `Search(foo in src)`. The model never sees these labels.
 *
 * Two sources, in order of trust. Files the command actually changed come from the
 * shell's own after-the-fact report, so `python3 -c "…write_text…"` and `sed -i` are
 * labelled by their real effect. Everything else is a static reading of the command
 * line; anything not recognised leaves the row as plain `Shell(command)`.
 */
export interface ShellPart {
	verb: string;
	target: string;
}

/** Parts shown before the rest is summarised as `+N more`. */
const MAX_PARTS = 3;

/** Programs that run the command after them. */
const WRAPPERS = new Set(["rtk", "sudo", "time", "nice", "nohup", "command", "exec", "env", "caffeinate"]);
/** Package runners whose next word is the program. */
const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);
const READERS = new Set(["cat", "bat", "less", "more", "nl", "head", "tail", "wc"]);
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const LISTERS = new Set(["ls", "tree", "fd", "find", "eza", "exa"]);
const CHECKERS = new Set([
	"tsc",
	"biome",
	"eslint",
	"prettier",
	"ruff",
	"mypy",
	"pyright",
	"shellcheck",
	"clippy",
	"golangci-lint",
]);
const TESTERS = new Set(["pytest", "jest", "vitest", "mocha"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_WORDS = new Set(["install", "i", "add", "ci"]);
/** Values of these flags are separate words, not operands. */
const READ_VALUE_FLAGS = new Set(["-n", "-c", "--lines", "--bytes", "--line-range"]);

/** Header label for a shell call, or undefined to keep `Shell(command)`. */
export function classifyShell(command: string, output = ""): ShellPart[] | undefined {
	const effects = changedFiles(output);
	const stages = chains(command)
		.map((chain) => classifyStage(chain[0]!))
		.filter((part) => part !== null);
	// A stage that is not recognised means the label would misdescribe the command.
	const known = stages.includes(undefined) ? undefined : (stages as ShellPart[]);
	if (effects.length === 0) return known && known.length > 0 ? limit(merge(known)) : undefined;
	// The real effect replaces what the command line only suggested about files.
	const rest = (known ?? []).filter(
		(part) => !["Read", "Search", "List", "Write", "Update"].includes(part.verb),
	);
	return limit(merge([...effects, ...rest]));
}

/** `a.py, b.txt (created)` from the shell's report of files that changed while it ran. */
function changedFiles(output: string): ShellPart[] {
	const match = /^\[files you had seen changed on disk while this command ran: (.*)\]$/m.exec(output);
	if (!match) return [];
	return match[1]!.split(", ").map((entry) => {
		const note = / \((created[^)]*|deleted|changed [^)]*)\)$/.exec(entry);
		const path = note ? entry.slice(0, note.index) : entry;
		const verb = note?.[1]?.startsWith("created") ? "Create" : note?.[1] === "deleted" ? "Delete" : "Update";
		return { verb, target: path };
	});
}

/** Consecutive parts with the same verb read as one: `Read(a.ts, b.ts)`. */
function merge(parts: ShellPart[]): ShellPart[] {
	const merged: ShellPart[] = [];
	for (const part of parts) {
		const last = merged.at(-1);
		if (last?.verb === part.verb) {
			if (!last.target.split(", ").includes(part.target)) last.target += `, ${part.target}`;
		} else merged.push({ ...part });
	}
	return merged;
}

function limit(parts: ShellPart[]): ShellPart[] {
	if (parts.length <= MAX_PARTS) return parts;
	return [...parts.slice(0, MAX_PARTS), { verb: `+${parts.length - MAX_PARTS} more`, target: "" }];
}

/**
 * The command as `&&`/`||`/`;`/newline chains of `|` pipeline stages, split outside quotes.
 * Heredoc bodies are skipped: they are data for a stage, not commands.
 */
function chains(command: string): string[][] {
	const result: string[][] = [];
	let stages: string[] = [];
	let current = "";
	let quote: string | undefined;
	const heredocs: { tag: string; strip: boolean }[] = [];
	const endStage = () => {
		if (current.trim()) stages.push(current.trim());
		current = "";
	};
	const endChain = () => {
		endStage();
		if (stages.length > 0) result.push(stages);
		stages = [];
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') current += command[index++] ?? "";
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if (char === "\\" && index + 1 < command.length) {
			current += char + command[++index];
		} else if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
			const heredoc = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(command.slice(index));
			if (heredoc) heredocs.push({ tag: heredoc[3]!, strip: heredoc[1] === "-" });
			current += char;
		} else if (char === "\n") {
			endChain();
			// Skip each pending heredoc's body, through its terminator line.
			for (const { tag, strip } of heredocs.splice(0)) {
				let end = command.indexOf("\n", index + 1);
				while (true) {
					const line = command.slice(index + 1, end < 0 ? undefined : end);
					index = end < 0 ? command.length : end;
					if ((strip ? line.trim() : line) === tag || end < 0) break;
					end = command.indexOf("\n", index + 1);
				}
			}
		} else if (char === ";") endChain();
		else if (char === "&" && command[index + 1] === "&") {
			endChain();
			index++;
		} else if (char === "|" && command[index + 1] === "|") {
			endChain();
			index++;
		} else if (char === "|") endStage();
		else current += char;
	}
	endChain();
	return result;
}

/**
 * One pipeline stage's label. `null` means it does not count either way (`cd`, a bare
 * assignment); `undefined` means it is not recognised.
 */
function classifyStage(stage: string): ShellPart | null | undefined {
	let argv = words(stage);
	if (!argv || argv.length === 0) return null;
	const writes: string[] = [];
	const operands: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const word = argv[index]!;
		const redirect = /^\d*(>>?|<)(.*)$/.exec(word);
		if (!redirect || word.startsWith("<<")) {
			if (!word.startsWith("<<")) operands.push(word);
			continue;
		}
		const target = redirect[2] || argv[++index] || "";
		if (redirect[1] !== "<" && target && !target.startsWith("&") && target !== "/dev/null")
			writes.push(target);
	}
	argv = operands;
	while (argv.length > 0 && /^[A-Za-z_]\w*=/.test(argv[0]!)) argv = argv.slice(1);
	while (argv.length > 1 && WRAPPERS.has(argv[0]!)) argv = argv.slice(1);
	if (argv.length > 1 && RUNNERS.has(argv[0]!)) argv = argv.slice(1);
	const [program = "", ...rest] = argv;
	if (argv.length === 0) return writes.length > 0 ? { verb: "Write", target: writes.join(", ") } : null;
	if (program === "cd" || program === "set" || program === "export" || program === "source") return null;
	const flags = rest.filter((word) => word.startsWith("-"));
	const plain = rest.filter((word) => !word.startsWith("-"));
	if (writes.length > 0 && (READERS.has(program) || ["echo", "printf", "tee"].includes(program)))
		return { verb: "Write", target: writes.join(", ") };
	if (program === "tee" && plain.length > 0) return { verb: "Write", target: plain.join(", ") };

	if (program === "sed" || program === "perl") {
		const inPlace = flags.some((flag) => /^-[a-zA-Z]*i/.test(flag) || flag.startsWith("--in-place"));
		// The first operand is the script (or -e value); macOS `sed -i ''` adds an empty suffix word.
		const files = plain.filter(Boolean).slice(1);
		if (inPlace) return files.length > 0 ? { verb: "Update", target: files.join(", ") } : undefined;
		if (program === "sed" && flags.includes("-n") && files.length > 0)
			return { verb: "Read", target: files.join(", ") };
		return undefined;
	}
	if (READERS.has(program)) {
		const files = operandsAfter(rest, READ_VALUE_FLAGS).filter((word) => !/^\+?\d+$/.test(word));
		return files.length > 0 ? { verb: "Read", target: files.join(", ") } : undefined;
	}
	if (SEARCHERS.has(program) || (program === "git" && rest[0] === "grep")) {
		const args = program === "git" ? rest.slice(1) : rest;
		const explicit = args.findIndex((word) => word === "-e" || word === "--regexp");
		const words = operandsAfter(args, GREP_VALUE_FLAGS);
		const pattern = explicit >= 0 ? args[explicit + 1] : words[0];
		if (!pattern) return undefined;
		const paths = explicit >= 0 ? words : words.slice(1);
		return { verb: "Search", target: paths.length > 0 ? `${pattern} in ${paths.join(" ")}` : pattern };
	}
	if (LISTERS.has(program)) {
		if (program === "find") {
			const name = rest.findIndex((word) => word === "-name" || word === "-iname" || word === "-path");
			const root = rest[0] && !rest[0].startsWith("-") ? rest[0] : ".";
			return { verb: "List", target: name >= 0 && rest[name + 1] ? `${root} ${rest[name + 1]}` : root };
		}
		return { verb: "List", target: plain.join(" ") || "." };
	}
	if (program === "git") {
		const sub = rest.find((word) => !word.startsWith("-"));
		return sub ? { verb: "Git", target: rest.slice(rest.indexOf(sub)).join(" ") } : undefined;
	}
	if (program === "rm") return plain.length > 0 ? { verb: "Delete", target: plain.join(", ") } : undefined;
	if (program === "mkdir") return plain.length > 0 ? { verb: "Create", target: plain.join(", ") } : undefined;
	if ((program === "mv" || program === "cp") && plain.length >= 2)
		return {
			verb: program === "mv" ? "Move" : "Copy",
			target: `${plain.slice(0, -1).join(", ")} → ${plain.at(-1)}`,
		};
	if (program === "touch") return plain.length > 0 ? { verb: "Create", target: plain.join(", ") } : undefined;
	if (program === "curl" || program === "wget") {
		const url = plain.find((word) => /^https?:\/\//.test(word));
		return url ? { verb: "Fetch", target: url } : undefined;
	}
	if (TESTERS.has(program)) return { verb: "Test", target: plain.join(" ") || program };
	if (CHECKERS.has(program)) return { verb: "Check", target: [program, ...plain].join(" ") };
	if (PACKAGE_MANAGERS.has(program) || program === "cargo" || program === "go" || program === "make")
		return toolchain(program, rest);
	if ((program === "pip" || program === "pip3" || program === "brew") && rest[0] === "install")
		return { verb: "Install", target: plain.slice(1).join(" ") };
	return undefined;
}

/** `bun test x`, `npm run lint`, `cargo build`, `make test`: what a toolchain command is for. */
function toolchain(program: string, rest: string[]): ShellPart | undefined {
	const plain = rest.filter((word) => !word.startsWith("-"));
	const sub = plain[0] ?? "";
	const script = sub === "run" ? (plain[1] ?? "") : sub;
	const tail = (from: number) => plain.slice(from).join(" ");
	if (PACKAGE_MANAGERS.has(program) && INSTALL_WORDS.has(sub))
		return { verb: "Install", target: tail(1) || program };
	if (/^test/.test(script))
		return { verb: "Test", target: tail(sub === "run" ? 2 : 1) || `${program} ${script}` };
	if (/^(lint|check|typecheck|clippy|vet|fmt|format)/.test(script))
		return { verb: "Check", target: `${program} ${script}` };
	if (/^build/.test(script)) return { verb: "Build", target: `${program} ${script}` };
	return undefined;
}

/** Operands of an argument list, skipping the separate values of `valued` flags. */
function operandsAfter(args: string[], valued: ReadonlySet<string>): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const word = args[index]!;
		if (word === "--") {
			result.push(...args.slice(index + 1));
			break;
		}
		if (word.startsWith("-")) {
			if (valued.has(word)) index++;
			continue;
		}
		result.push(word);
	}
	return result;
}
