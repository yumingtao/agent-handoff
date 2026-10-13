import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceController, SERVICE_LABEL } from './service-controller.mjs';

function fakeRunner() {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    return { stdout: command === 'launchctl' ? 'state = running' : 'active', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

test('macOS controller writes and manages only the Board launch agent', async () => {
  const runner = fakeRunner();
  const controller = new ServiceController({ platform: 'darwin', home: '/tmp/handoff-board-test', nodeBinary: '/usr/local/bin/node', serverEntry: '/app/server.mjs', commandRunner: runner });
  assert.equal(controller.configPath, `/tmp/handoff-board-test/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
  assert.match(controller.macosPlist(true), /com\.agent-handoff\.board/);
  assert.match(controller.macosPlist(true), /RunAtLoad/);
});

test('unsupported platforms never fall back to macOS commands', async () => {
  const runner = fakeRunner();
  const controller = new ServiceController({ platform: 'freebsd', serverEntry: '/app/server.mjs', commandRunner: runner });
  assert.equal((await controller.status()).supported, false);
  assert.deepEqual(runner.calls, []);
});

test('Linux unit keeps Board runtime and logs separate from the gateway', () => {
  const controller = new ServiceController({ platform: 'linux', home: '/tmp/home', nodeBinary: '/usr/bin/node', serverEntry: '/app/server.mjs' });
  const unit = controller.linuxUnit();
  assert.match(unit, /com\.agent-handoff\.board/);
  assert.doesNotMatch(unit, /llm-router-gateway/);
  assert.match(unit, /HANDOFF_BOARD_PORT=4319/);
});

test('Windows controller uses a scheduled task instead of Unix service commands', async () => {
  const runner = fakeRunner();
  const controller = new ServiceController({ platform: 'win32', home: '/tmp/handoff-board-win', nodeBinary: 'node.exe', serverEntry: 'C:\\app\\server.mjs', commandRunner: runner });
  assert.equal(controller.configPath, '/tmp/handoff-board-win/AppData/Local/agent-handoff/handoff-board-start.cmd');
  assert.equal(controller.isSupported(), true);
  assert.match(controller.logPaths.stdout, /agent-handoff-board\.out\.log$/);
});
