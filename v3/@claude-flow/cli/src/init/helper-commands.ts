/**
 * Hook and statusline commands that launch the `.claude/helpers` scripts.
 *
 * A project-level settings.json (`<project>/.claude/settings.json`) keeps the
 * #1943 probe: run the project's helper, fall back to `$HOME/.claude/helpers`.
 * The project controls that settings file anyway, so preferring its helpers
 * grants it nothing new.
 *
 * A user-level settings.json (`~/.claude/settings.json`) applies to every
 * project the user opens. There the probe would let any opened project supply
 * the helper that runs, so user-level commands are pinned to the user's own
 * `$HOME/.claude/helpers` with no project lookup.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type HelperScope = 'project' | 'user';

const IS_WINDOWS = process.platform === 'win32';
const STATUSLINE_SCRIPT = '.claude/helpers/statusline.cjs';

function canonical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Settings written into the user's home directory are user-level settings. */
export function helperScopeFor(targetDir: string | undefined): HelperScope {
  if (!targetDir) return 'project';
  return canonical(targetDir) === canonical(os.homedir()) ? 'user' : 'project';
}

/** Command that runs `node <script> <subcommand>` for a hook. */
export function helperHookCommand(script: string, subcommand: string, scope: HelperScope, windows = IS_WINDOWS): string {
  const winScript = script.replace(/\//g, '\\');
  const arg = subcommand ? ` ${subcommand}` : '';
  if (scope === 'user') {
    return windows
      ? `cmd /c "node "%USERPROFILE%\\${winScript}"${arg}"`
      : `sh -c 'exec node "\${HOME}/${script}"${arg}'`;
  }
  if (windows) {
    // cmd.exe equivalent of the sh probe below. `IF EXIST` checks the
    // project-local path; falls back to %USERPROFILE% if missing.
    return `cmd /c "IF EXIST \"%CLAUDE_PROJECT_DIR%\\${winScript}\" (node \"%CLAUDE_PROJECT_DIR%\\${winScript}\"${arg}) ELSE (node \"%USERPROFILE%\\${winScript}\"${arg})"`;
  }
  // POSIX sh: prefer project-local helpers, fall back to $HOME/.claude/.
  // eslint-disable-next-line no-template-curly-in-string
  const projVar = '${CLAUDE_PROJECT_DIR:-.}';
  // eslint-disable-next-line no-template-curly-in-string
  const homeVar = '${HOME}';
  return `sh -c 'D="${projVar}"; [ -f "$D/${script}" ] || D="${homeVar}"; exec node "$D/${script}"${arg}'`;
}

/** Command for the statusLine entry. */
export function helperStatusLineCommand(scope: HelperScope, windows = IS_WINDOWS): string {
  if (windows) {
    // The Node CLI's `-e` flag avoids all shell-quoting pitfalls (#1948,
    // #1973): never `cmd /c` for statusline, it blocks stdin forwarding.
    const home = "p.join(process.env.USERPROFILE||process.env.HOME||'.', '" + STATUSLINE_SCRIPT + "')";
    const js = scope === 'user'
      ? `const p=require('path');require(${home});`
      : "const fs=require('fs'),p=require('path');" +
        `const d=process.env.CLAUDE_PROJECT_DIR||'.';` +
        `const f=p.join(d,'${STATUSLINE_SCRIPT}');` +
        `const h=${home};` +
        'require(fs.existsSync(f)?f:h);';
    return `node -e "${js}"`;
  }
  if (scope === 'user') return `sh -c 'exec node "\${HOME}/${STATUSLINE_SCRIPT}"'`;
  // eslint-disable-next-line no-template-curly-in-string
  const projVar = '${CLAUDE_PROJECT_DIR:-.}';
  // eslint-disable-next-line no-template-curly-in-string
  const homeVar = '${HOME}';
  return `sh -c 'D="${projVar}"; [ -f "$D/${STATUSLINE_SCRIPT}" ] || D="${homeVar}"; exec node "$D/${STATUSLINE_SCRIPT}"'`;
}

const POSIX_PROBE = /^sh -c 'D="\$\{CLAUDE_PROJECT_DIR:-\.\}"; \[ -f "\$D\/(\.claude\/helpers\/[\w.-]+)" \] \|\| D="\$\{HOME\}"; exec node "\$D\/\1"( [\w:-]+)?'$/;
const WINDOWS_PROBE = /^cmd \/c "IF EXIST "%CLAUDE_PROJECT_DIR%\\(\.claude\\helpers\\[\w.-]+)" \(node "%CLAUDE_PROJECT_DIR%\\\1"( [\w:-]+)?\) ELSE \(node "%USERPROFILE%\\\1"\2\)"$/;
// `ruflo init --upgrade` wrote these git-root forms (#1259, #1284, #2450).
const GIT_ROOT_IMPORT = /^node -e "var c=require\('child_process'\),p=require\('path'\),u=require\('url'\),r;try\{r=c\.execSync\('git rev-parse --show-toplevel',\{encoding:'utf8'\}\)\.trim\(\)\}catch\(e\)\{r=process\.cwd\(\)\}var f=p\.join\(r,'(\.claude\/helpers\/[\w.-]+)'\);import\(u\.pathToFileURL\(f\)\.href\)"( [\w:-]+)?$/;
const GIT_ROOT_STATUSLINE = `node -e "var c=require('child_process'),p=require('path'),r;try{r=c.execSync('git rev-parse --show-toplevel',{encoding:'utf8'}).trim()}catch(e){r=process.cwd()}var s=p.join(r,'.claude/helpers/statusline.cjs');process.argv.splice(1,0,s);require(s)"`;

/**
 * Rewrite a command ruflo itself generated with a project lookup into the
 * pinned user-level form. Returns null for anything else (user-authored
 * commands are left alone).
 */
export function pinToUserHelpers(command: string, windows = IS_WINDOWS): string | null {
  if (command === GIT_ROOT_STATUSLINE || command === helperStatusLineCommand('project', windows)) {
    return helperStatusLineCommand('user', windows);
  }
  const posix = POSIX_PROBE.exec(command);
  if (posix) return helperHookCommand(posix[1], (posix[2] ?? '').trim(), 'user', windows);
  const win = WINDOWS_PROBE.exec(command);
  if (win) return helperHookCommand(win[1].replace(/\\/g, '/'), (win[2] ?? '').trim(), 'user', windows);
  const gitRoot = GIT_ROOT_IMPORT.exec(command);
  if (gitRoot) return helperHookCommand(gitRoot[1], (gitRoot[2] ?? '').trim(), 'user', windows);
  return null;
}
