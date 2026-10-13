import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const SERVICE_LABEL = 'com.agent-handoff.board';

function quoteWindows(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function commandResult(error, stdout = '', stderr = '') {
  return {
    ok: !error,
    stdout: String(stdout || ''),
    stderr: String(stderr || ''),
    exitCode: error ? Number(error.code || 1) : 0,
  };
}

export class ServiceController {
  constructor({
    platform = process.platform,
    home = homedir(),
    nodeBinary = process.execPath,
    serverEntry,
    distDir,
    host = '127.0.0.1',
    port = 4319,
    commandRunner = defaultCommandRunner,
  }) {
    this.platform = platform;
    this.home = home;
    this.nodeBinary = nodeBinary;
    this.serverEntry = serverEntry;
    this.distDir = distDir;
    this.host = host;
    this.port = port;
    this.commandRunner = commandRunner;
  }

  get logDirectory() {
    if (this.platform === 'win32') return process.env.LOCALAPPDATA || join(this.home, 'AppData', 'Local');
    if (this.platform === 'linux') return process.env.XDG_STATE_HOME || join(this.home, '.local', 'state', 'agent-handoff');
    return join(this.home, 'Library', 'Logs');
  }

  get logPaths() {
    const prefix = join(this.logDirectory, 'agent-handoff-board');
    return { stdout: `${prefix}.out.log`, stderr: `${prefix}.err.log` };
  }

  get configPath() {
    if (this.platform === 'darwin') return join(this.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    if (this.platform === 'linux') return join(this.home, '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`);
    if (this.platform === 'win32') return join(this.home, 'AppData', 'Local', 'agent-handoff', 'handoff-board-start.cmd');
    return join(this.home, '.agent-handoff', 'handoff-board-start');
  }

  async run(command, args = []) {
    try {
      const result = await this.commandRunner(command, args);
      return commandResult(null, result.stdout, result.stderr);
    } catch (error) {
      return commandResult(error, error.stdout, error.stderr);
    }
  }

  async status() {
    if (!this.isSupported()) return { installed: false, running: false, supported: false, detail: 'Unsupported platform' };
    if (!existsSync(this.configPath)) return { installed: false, running: false, supported: true, detail: 'Service is not installed' };

    if (this.platform === 'darwin') {
      const result = await this.run('launchctl', ['print', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
      return { installed: true, running: result.ok, supported: true, detail: result.ok ? 'Service is running' : 'Service is installed but stopped' };
    }
    if (this.platform === 'linux') {
      const result = await this.run('systemctl', ['--user', 'is-active', `${SERVICE_LABEL}.service`]);
      return { installed: true, running: result.stdout.trim() === 'active', supported: true, detail: result.stdout.trim() || result.stderr.trim() || 'Service is stopped' };
    }
    const result = await this.run('schtasks', ['/Query', '/TN', SERVICE_LABEL, '/FO', 'CSV', '/NH']);
    return { installed: true, running: result.ok && /Running/i.test(result.stdout), supported: true, detail: result.ok ? result.stdout.trim() : 'Service is stopped' };
  }

  async ensureInstalled({ autostart = true } = {}) {
    if (!existsSync(this.configPath)) return this.install({ autostart });
    let config = '';
    try {
      config = readFileSync(this.configPath, 'utf8');
    } catch {
      return this.install({ autostart });
    }
    if (!config.includes(this.serverEntry) || !config.includes(this.distDir)) {
      return this.install({ autostart });
    }
    return this.status();
  }

  async install({ autostart = true } = {}) {
    if (!this.isSupported()) throw new Error(`Unsupported platform: ${this.platform}`);
    if (!this.serverEntry || !this.distDir) throw new Error('Board server paths are not configured');
    mkdirSync(this.logDirectory, { recursive: true });
    if (this.platform === 'darwin') {
      mkdirSync(join(this.home, 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(this.configPath, this.macosPlist(autostart), 'utf8');
      await this.run('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
      const result = await this.run('launchctl', ['bootstrap', `gui/${process.getuid()}`, this.configPath]);
      if (!result.ok) throw new Error(result.stderr || 'Could not install launchd service');
      if (autostart) await this.run('launchctl', ['enable', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
      return this.status();
    }
    if (this.platform === 'linux') {
      mkdirSync(join(this.home, '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(this.configPath, this.linuxUnit(), 'utf8');
      await this.run('systemctl', ['--user', 'daemon-reload']);
      const result = await this.run('systemctl', ['--user', autostart ? 'enable' : 'disable', `${SERVICE_LABEL}.service`]);
      if (!result.ok) throw new Error(result.stderr || 'Could not install systemd service');
      return this.status();
    }
    mkdirSync(join(this.home, 'AppData', 'Local', 'agent-handoff'), { recursive: true });
    writeFileSync(this.configPath, `@echo off\nset HANDOFF_BOARD_DIST_DIR=${this.distDir}\n${quoteWindows(this.nodeBinary)} ${quoteWindows(this.serverEntry)}\n`, 'utf8');
    const result = await this.run('schtasks', ['/Create', '/TN', SERVICE_LABEL, '/TR', quoteWindows(this.configPath), '/SC', 'ONLOGON', '/F']);
    if (!result.ok) throw new Error(result.stderr || 'Could not install Windows scheduled task');
    if (!autostart) await this.run('schtasks', ['/Change', '/TN', SERVICE_LABEL, '/DISABLE']);
    return this.status();
  }

  async uninstall() {
    if (!this.isSupported()) return { installed: false, running: false, supported: false, detail: 'Unsupported platform' };
    await this.stop();
    if (this.platform === 'darwin') await this.run('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
    if (this.platform === 'linux') await this.run('systemctl', ['--user', 'disable', `${SERVICE_LABEL}.service`]);
    if (this.platform === 'win32') await this.run('schtasks', ['/Delete', '/TN', SERVICE_LABEL, '/F']);
    if (existsSync(this.configPath)) unlinkSync(this.configPath);
    return this.status();
  }

  async start() {
    if (!(await this.status()).installed) await this.install();
    if (this.platform === 'darwin') {
      await this.run('launchctl', ['bootstrap', `gui/${process.getuid()}`, this.configPath]);
      await this.run('launchctl', ['kickstart', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
    }
    else if (this.platform === 'linux') await this.run('systemctl', ['--user', 'start', `${SERVICE_LABEL}.service`]);
    else await this.run('schtasks', ['/Run', '/TN', SERVICE_LABEL]);
    return this.status();
  }

  async stop() {
    if (this.platform === 'darwin') await this.run('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
    else if (this.platform === 'linux') await this.run('systemctl', ['--user', 'stop', `${SERVICE_LABEL}.service`]);
    else await this.run('schtasks', ['/End', '/TN', SERVICE_LABEL]);
    return this.status();
  }

  async restart() {
    if (!(await this.status()).installed) return this.start();
    if (this.platform === 'darwin') {
      await this.run('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
      await this.run('launchctl', ['bootstrap', `gui/${process.getuid()}`, this.configPath]);
      await this.run('launchctl', ['kickstart', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
    }
    else if (this.platform === 'linux') await this.run('systemctl', ['--user', 'restart', `${SERVICE_LABEL}.service`]);
    else {
      await this.run('schtasks', ['/End', '/TN', SERVICE_LABEL]);
      await this.run('schtasks', ['/Run', '/TN', SERVICE_LABEL]);
    }
    return this.status();
  }

  async setAutostart(enabled) {
    if (this.platform === 'darwin' || this.platform === 'linux') {
      if (!(await this.status()).installed) await this.install({ autostart: enabled });
      else if (this.platform === 'darwin') {
        writeFileSync(this.configPath, this.macosPlist(enabled), 'utf8');
        await this.run('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
        await this.run('launchctl', ['bootstrap', `gui/${process.getuid()}`, this.configPath]);
      } else {
        await this.run('systemctl', ['--user', enabled ? 'enable' : 'disable', `${SERVICE_LABEL}.service`]);
      }
    } else if (this.platform === 'win32') {
      if (!(await this.status()).installed) await this.install({ autostart: enabled });
      else {
        const result = await this.run('schtasks', ['/Change', '/TN', SERVICE_LABEL, enabled ? '/ENABLE' : '/DISABLE']);
        if (!result.ok) throw new Error(result.stderr || 'Could not change Windows task startup');
      }
    }
    return enabled;
  }

  isSupported() {
    return ['darwin', 'linux', 'win32'].includes(this.platform);
  }

  macosPlist(runAtLoad) {
    const { stdout, stderr } = this.logPaths;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${SERVICE_LABEL}</string><key>ProgramArguments</key><array><string>${this.nodeBinary}</string><string>${this.serverEntry}</string></array><key>EnvironmentVariables</key><dict><key>HANDOFF_BOARD_HOST</key><string>${this.host}</string><key>HANDOFF_BOARD_PORT</key><string>${this.port}</string><key>HANDOFF_BOARD_DIST_DIR</key><string>${this.distDir}</string></dict><key>RunAtLoad</key><${runAtLoad ? 'true' : 'false'}/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${stdout}</string><key>StandardErrorPath</key><string>${stderr}</string></dict></plist>\n`;
  }

  linuxUnit() {
    const { stdout, stderr } = this.logPaths;
    return `[Unit]\nDescription=Agent Handoff Board (${SERVICE_LABEL})\nAfter=network.target\n\n[Service]\nExecStart=${this.nodeBinary} ${this.serverEntry}\nEnvironment=HANDOFF_BOARD_HOST=${this.host}\nEnvironment=HANDOFF_BOARD_PORT=${this.port}\nEnvironment=HANDOFF_BOARD_DIST_DIR=${this.distDir}\nRestart=on-failure\nStandardOutput=append:${stdout}\nStandardError=append:${stderr}\n\n[Install]\nWantedBy=default.target\n`;
  }
}

async function defaultCommandRunner(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
}
