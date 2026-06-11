const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// In-memory store for sessions
const sessions = new Map();

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Serve xterm locally from node_modules
app.use('/xterm', express.static(path.join(__dirname, 'node_modules', 'xterm')));
app.use('/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', 'xterm-addon-fit')));

// Helper: execute command asynchronously
function runCommand(command) {
    return new Promise((resolve) => {
        exec(command, (error, stdout, stderr) => {
            resolve({ error, stdout, stderr });
        });
    });
}

// Helper: Write file locally (ensuring directories exist)
async function writeLocalFile(filePath, content) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf8');
}

// Helper: Generate C++ code structure for REPL compilation
function generateCode(session, newCode, isGlobal) {
    let code = '';
    // 1. Add headers
    code += session.headers.join('\n') + '\n\n';
    
    // 2. Add global declarations
    if (isGlobal) {
        code += session.globals.join('\n\n') + '\n\n';
        code += newCode + '\n\n';
    } else {
        code += session.globals.join('\n\n') + '\n\n';
    }
    
    // 3. Add main function
    code += 'int main() {\n';
    
    // If there are previous local statements, suppress their output
    if (session.locals.length > 0) {
        code += '    // Suppress stdout/stderr of previous statements\n';
        code += '    int old_stdout = dup(1);\n';
        code += '    int null_fd = open("/dev/null", O_WRONLY);\n';
        code += '    fflush(stdout);\n';
        code += '    cout << flush;\n';
        code += '    dup2(null_fd, 1);\n';
        code += '    close(null_fd);\n\n';
        
        for (const stmt of session.locals) {
            code += '    ' + stmt + '\n';
        }
        
        code += '\n    // Restore stdout\n';
        code += '    fflush(stdout);\n';
        code += '    cout << flush;\n';
        code += '    dup2(old_stdout, 1);\n';
        code += '    close(old_stdout);\n\n';
    }
    
    // If this is a local statement test, append it here
    if (!isGlobal) {
        code += '    // New statement\n';
        code += '    ' + newCode + '\n';
    }
    
    code += '    return 0;\n';
    code += '}\n';
    return code;
}

// WebSocket connection
wss.on('connection', (ws) => {
    let currentSessionId = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'init') {
                let sessionId = data.sessionId;
                let session = null;

                if (sessionId && sessions.has(sessionId)) {
                    // Reconnect to existing session
                    session = sessions.get(sessionId);
                    clearTimeout(session.cleanupTimer);
                    session.cleanupTimer = null;
                    session.ws = ws;
                    currentSessionId = sessionId;
                    console.log(`Reconnected to session: ${sessionId}`);
                } else {
                    // Create a new session
                    sessionId = uuidv4();
                    const sessionDir = path.join('/tmp', 'cpp-playground', 'sessions', sessionId);
                    
                    try {
                        fs.mkdirSync(sessionDir, { recursive: true });
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: `Failed to initialize session directory: ${err.message}` }));
                        return;
                    }

                    session = {
                        id: sessionId,
                        dir: sessionDir,
                        headers: [
                            '#include <iostream>',
                            '#include <vector>',
                            '#include <string>',
                            '#include <map>',
                            '#include <set>',
                            '#include <algorithm>',
                            '#include <cmath>',
                            '#include <random>',
                            '#include <memory>',
                            '#include <numeric>',
                            '#include <sstream>',
                            '#include <unistd.h>',
                            '#include <fcntl.h>',
                            '#include <cstdio>',
                            'using namespace std;'
                        ],
                        globals: [],
                        locals: [],
                        ws,
                        cleanupTimer: null,
                        idleTimer: null,
                        activeProcess: null
                    };
                    
                    sessions.set(sessionId, session);
                    currentSessionId = sessionId;
                    console.log(`Created new session: ${sessionId} in directory: ${sessionDir}`);
                }

                resetIdleTimeout(session);
                ws.send(JSON.stringify({
                    type: 'init_ok',
                    sessionId,
                    state: {
                        headers: session.headers,
                        globals: session.globals,
                        locals: session.locals
                    }
                }));
            }

            // Verify session is active
            const session = sessions.get(currentSessionId);
            if (!session) {
                ws.send(JSON.stringify({ type: 'error', message: 'No active session found.' }));
                return;
            }
            resetIdleTimeout(session);

            if (data.type === 'repl_stdin') {
                if (session.activeProcess) {
                    session.activeProcess.stdin.write(data.data);
                }
                return;
            }

            if (data.type === 'repl_execute') {
                if (session.activeProcess) {
                    session.activeProcess.kill('SIGKILL');
                    session.activeProcess = null;
                }
                const codeInput = data.code.trim();
                if (!codeInput) return;

                ws.send(JSON.stringify({ type: 'status', message: 'Compiling...' }));

                // 1. Check if it's a header include or namespace instruction
                if (codeInput.startsWith('#include') || codeInput.startsWith('using namespace')) {
                    const tempHeaders = [...session.headers, codeInput];
                    const dummyCode = tempHeaders.join('\n') + '\nint main() { return 0; }';
                    const tempCppPath = path.join(session.dir, 'temp_header.cpp');
                    const tempBinPath = path.join(session.dir, 'temp_header');

                    try {
                        await writeLocalFile(tempCppPath, dummyCode);
                        const compileRes = await runCommand(`timeout 30 clang++ -std=c++17 ${tempCppPath} -o ${tempBinPath}`);
                        
                        // Clean up
                        await fs.promises.rm(tempCppPath, { force: true });
                        await fs.promises.rm(tempBinPath, { force: true });
                        
                        if (compileRes.error) {
                            ws.send(JSON.stringify({ type: 'output', error: compileRes.stderr }));
                        } else {
                            session.headers.push(codeInput);
                            ws.send(JSON.stringify({
                                type: 'output',
                                stdout: `Header/Namespace added: ${codeInput}\n`,
                                state: { headers: session.headers, globals: session.globals, locals: session.locals }
                            }));
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: `Internal compilation error: ${err.message}` }));
                    }
                    return;
                }

                // 2. Local compile attempt
                const localSource = generateCode(session, codeInput, false);
                const cppPath = path.join(session.dir, 'temp_local.cpp');
                const binPath = path.join(session.dir, 'temp_local');

                try {
                    await writeLocalFile(cppPath, localSource);
                    const compileRes = await runCommand(`timeout 30 clang++ -std=c++17 -O0 ${cppPath} -o ${binPath}`);

                    if (!compileRes.error) {
                        // Compiled successfully as local statement! Execute it with a timeout
                        ws.send(JSON.stringify({ type: 'status', message: 'Running...' }));
                        
                        const child = spawn('bash', ['-c', `ulimit -u 64 -f 51200 -v 524288; timeout -s KILL 5 ${binPath}`]);
                        session.activeProcess = child;
                        
                        let runError = '';
                        
                        child.stdout.on('data', (chunk) => {
                            ws.send(JSON.stringify({ type: 'run_output', stdout: chunk.toString() }));
                        });
                        
                        child.stderr.on('data', (chunk) => {
                            ws.send(JSON.stringify({ type: 'run_output', stderr: chunk.toString() }));
                        });
                        
                        child.on('close', async (code, signal) => {
                            session.activeProcess = null;
                            
                            // Cleanup
                            await fs.promises.rm(cppPath, { force: true });
                            await fs.promises.rm(binPath, { force: true });
                            
                            if (code === 124 || signal === 'SIGKILL') {
                                runError = 'Execution timed out (5s limit exceeded).\n';
                            } else if (code !== 0 && code !== null) {
                                runError = `Process exited with code ${code}\n`;
                            } else if (signal) {
                                runError = `Process terminated by signal ${signal}\n`;
                            }
                            
                            if (!runError) {
                                // Save statement only if executed successfully
                                session.locals.push(codeInput);
                            }
                            
                            ws.send(JSON.stringify({
                                type: 'output',
                                stdout: '',
                                stderr: '',
                                error: runError || null,
                                state: { headers: session.headers, globals: session.globals, locals: session.locals }
                            }));
                        });
                        return;
                    }
                    
                    // Local compile failed. Clean files and try Global compile attempt
                    await fs.promises.rm(cppPath, { force: true });
                    await fs.promises.rm(binPath, { force: true });
                    
                    const globalSource = generateCode(session, codeInput, true);
                    const globalCppPath = path.join(session.dir, 'temp_global.cpp');
                    const globalBinPath = path.join(session.dir, 'temp_global');

                    await writeLocalFile(globalCppPath, globalSource);
                    const compileGlobalRes = await runCommand(`timeout 30 clang++ -std=c++17 -O0 ${globalCppPath} -o ${globalBinPath}`);
                    
                    // Cleanup
                    await fs.promises.rm(globalCppPath, { force: true });
                    await fs.promises.rm(globalBinPath, { force: true });
                    
                    if (!compileGlobalRes.error) {
                        // Compiled successfully as global declaration! Save it.
                        session.globals.push(codeInput);
                        ws.send(JSON.stringify({
                            type: 'output',
                            stdout: `Global declaration accepted.\n`,
                            state: { headers: session.headers, globals: session.globals, locals: session.locals }
                        }));
                    } else {
                        // Both failed. Return compilation error of local attempt
                        ws.send(JSON.stringify({ type: 'output', error: compileRes.stderr }));
                    }
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: `Internal server execution error: ${err.message}` }));
                }
            }

            if (data.type === 'standalone_run') {
                if (session.activeProcess) {
                    session.activeProcess.kill('SIGKILL');
                    session.activeProcess = null;
                }
                const codeInput = data.code;
                ws.send(JSON.stringify({ type: 'status', message: 'Compiling standalone script...' }));

                const cppPath = path.join(session.dir, 'standalone.cpp');
                const binPath = path.join(session.dir, 'standalone');

                try {
                    await writeLocalFile(cppPath, codeInput);
                    const compileRes = await runCommand(`timeout 30 clang++ -std=c++17 -O2 ${cppPath} -o ${binPath}`);

                    if (compileRes.error) {
                        ws.send(JSON.stringify({ type: 'output', error: compileRes.stderr }));
                        await fs.promises.rm(cppPath, { force: true });
                        return;
                    }

                    ws.send(JSON.stringify({ type: 'status', message: 'Running standalone script...' }));
                    
                    const child = spawn('bash', ['-c', `ulimit -u 64 -f 51200 -v 524288; timeout -s KILL 5 ${binPath}`]);
                    session.activeProcess = child;
                    
                    let runError = '';
                    
                    child.stdout.on('data', (chunk) => {
                        ws.send(JSON.stringify({ type: 'run_output', stdout: chunk.toString() }));
                    });
                    
                    child.stderr.on('data', (chunk) => {
                        ws.send(JSON.stringify({ type: 'run_output', stderr: chunk.toString() }));
                    });
                    
                    child.on('close', async (code, signal) => {
                        session.activeProcess = null;
                        
                        // Cleanup
                        await fs.promises.rm(cppPath, { force: true });
                        await fs.promises.rm(binPath, { force: true });
                        
                        if (code === 124 || signal === 'SIGKILL') {
                            runError = 'Execution timed out (5s limit exceeded).\n';
                        } else if (code !== 0 && code !== null) {
                            runError = `Process exited with code ${code}\n`;
                        } else if (signal) {
                            runError = `Process terminated by signal ${signal}\n`;
                        }
                        
                        ws.send(JSON.stringify({
                            type: 'output',
                            stdout: '',
                            stderr: '',
                            error: runError || null
                        }));
                    });
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: `Internal standalone execution error: ${err.message}` }));
                }
            }

            if (data.type === 'reset') {
                if (session.activeProcess) {
                    session.activeProcess.kill('SIGKILL');
                    session.activeProcess = null;
                }
                ws.send(JSON.stringify({ type: 'status', message: 'Resetting playground session...' }));
                session.globals = [];
                session.locals = [];
                
                try {
                    // Clean and recreate directory
                    await fs.promises.rm(session.dir, { recursive: true, force: true });
                    await fs.promises.mkdir(session.dir, { recursive: true });
                    
                    ws.send(JSON.stringify({
                        type: 'output',
                        stdout: 'Playground environment successfully reset.\n',
                        state: { headers: session.headers, globals: session.globals, locals: session.locals }
                    }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: `Reset failed: ${err.message}` }));
                }
            }

        } catch (err) {
            console.error('Error handling WebSocket message:', err);
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to process request.' }));
        }
    });

    ws.on('close', () => {
        if (currentSessionId && sessions.has(currentSessionId)) {
            const session = sessions.get(currentSessionId);
            session.ws = null;
            
            if (session.activeProcess) {
                session.activeProcess.kill('SIGKILL');
                session.activeProcess = null;
            }
            
            console.log(`Client disconnected from session: ${currentSessionId}. Starting grace period.`);
            
            // 60-second grace period before deleting session folder and state
            session.cleanupTimer = setTimeout(async () => {
                console.log(`Grace period expired for session: ${currentSessionId}. Cleaning up.`);
                try {
                    await fs.promises.rm(session.dir, { recursive: true, force: true });
                } catch (e) {
                    console.error('Failed to clean up session directory:', e);
                }
                sessions.delete(currentSessionId);
            }, 60000);
        }
    });
});

// Helper: Reset idle inactivity timeout (10 minutes)
function resetIdleTimeout(session) {
    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(async () => {
        console.log(`Inactivity timeout reached for session: ${session.id}. Cleaning up.`);
        try {
            await fs.promises.rm(session.dir, { recursive: true, force: true });
        } catch (e) {
            console.error('Failed to clean up session directory:', e);
        }
        
        if (session.ws) {
            session.ws.send(JSON.stringify({ type: 'error', message: 'Session terminated due to 10 minutes of inactivity.' }));
            session.ws.close();
        }
        sessions.delete(session.id);
    }, 600000); // 10 minutes
}

// Global cleanup: Delete all active session files on server exit
async function cleanupAllSessions() {
    console.log('Server shutting down. Removing all session directories...');
    const cleanupPromises = [];
    for (const [id, session] of sessions.entries()) {
        cleanupPromises.push(fs.promises.rm(session.dir, { recursive: true, force: true }));
    }
    await Promise.all(cleanupPromises).catch(console.error);
    console.log('Cleanup completed. Exiting.');
    process.exit(0);
}

process.on('SIGINT', cleanupAllSessions);
process.on('SIGTERM', cleanupAllSessions);

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`C++ Playground Backend running at http://localhost:${PORT}`);
});
