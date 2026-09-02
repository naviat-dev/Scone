import { spawn } from 'node:child_process';
import electron from 'electron';

const electronBinary = electron as unknown as string;

const electronArgs = process.platform === 'linux'
	? ['--ozone-platform=x11', '.']
	: ['.']

const child = spawn(electronBinary, electronArgs, {
	stdio: 'inherit',
})

child.on('close', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal)
	} else {
		process.exitCode = code ?? 1
	}
})