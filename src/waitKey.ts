// Runs inside the task terminal: executes the script command, then waits for
// any key before exiting so the (close: true) task terminal goes away.
import { spawn } from 'child_process';

delete process.env.ELECTRON_RUN_AS_NODE; // don't leak into the script

// Ctrl+C should stop the script, not this wrapper.
process.on('SIGINT', () => {});

const child = spawn(process.argv[2], { stdio: 'inherit', shell: process.env.SHELL || true });

child.on('exit', (code, signal) => {
    const status = signal ? `killed by ${signal}` : `exit code ${code}`;
    process.stdout.write(`\r\n\x1b[2m${status} — press any key to close\x1b[0m`);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(code ?? 1));
});
