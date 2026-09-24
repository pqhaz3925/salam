/** A POSIX shell word: bare when it only has characters no shell treats specially, else single-quoted. */
export function shellQuote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ResumeContext {
	sessionId: string;
	/** The state directory this process used, and the one salam picks without flags or SALAM_HOME. */
	home: string;
	defaultHome: string;
	/** Resolved SALAM_HOME from the launching shell, if set. */
	environmentHome?: string;
	/** Absolute path of the --config file, when one was given. */
	configFile?: string;
	/** The working directory config was loaded for, and the shell's directory salam was started from. */
	cwd: string;
	launchCwd: string;
}

/**
 * The command that reopens this exact session from the same shell: only the
 * flags needed to find the same state directory, configuration and project
 * configuration are added. `--remote` is deliberately absent: it starts a new
 * session, while a resumed session restores its own SSH target.
 */
export function resumeCommand(context: ResumeContext): string {
	const words = ["salam", "--resume", context.sessionId];
	if (
		context.home !== context.defaultHome ||
		(context.environmentHome !== undefined && context.environmentHome !== context.home)
	)
		words.push("--home", context.home);
	if (context.configFile) words.push("--config", context.configFile);
	if (context.cwd !== context.launchCwd) words.push("--cwd", context.cwd);
	return words.map(shellQuote).join(" ");
}
