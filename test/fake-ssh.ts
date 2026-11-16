// Stand-in for the OpenSSH client in tests: runs the "remote" command with a local POSIX sh in FAKE_SSH_HOME.
import { spawn } from 'node:child_process';
const a = process.argv.slice(2);
const cmd = a.slice(a.indexOf('--') + 2).join(' ');
const home = process.env.FAKE_SSH_HOME!;
const c = spawn(process.env.FAKE_SSH_SH!, ['-c', cmd], { cwd: home, env: { ...process.env, HOME: home }, stdio: 'inherit' });
c.on('close', (code) => process.exit(code ?? 1));
