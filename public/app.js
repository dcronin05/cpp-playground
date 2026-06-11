// Application state variables
let ws = null;
let sessionId = localStorage.getItem('cpp_repl_session_id') || null;
let editor = null;
let term = null;
let fitAddon = null;
let inputBuffer = '';
let history = [];
let historyIndex = -1;
let isExecuting = false;
let cursorPosition = 0;

// Standard C++ templates for snippets
const SNIPPETS = {
    vector: `#include <iostream>
#include <vector>
#include <algorithm>
#include <numeric>

int main() {
    std::vector<int> v = {4, 1, 5, 2, 3};
    std::sort(v.begin(), v.end());
    
    std::cout << "Sorted vector: ";
    for (int x : v) {
        std::cout << x << " ";
    }
    std::cout << "\\nSum of elements: " 
              << std::accumulate(v.begin(), v.end(), 0) << std::endl;
    return 0;
}`,
    lambda: `#include <iostream>
#include <vector>
#include <algorithm>

int main() {
    auto square = [](int x) { return x * x; };
    std::cout << "Square of 8 is " << square(8) << std::endl;
    
    std::vector<int> nums = {1, 2, 3, 4};
    std::for_each(nums.begin(), nums.end(), [](int &n) {
        n *= 2;
    });
    
    std::cout << "Doubled elements: ";
    for (int n : nums) std::cout << n << " ";
    std::cout << std::endl;
    return 0;
}`,
    pointers: `#include <iostream>
#include <memory>

class Entity {
public:
    Entity() { std::cout << "Entity Created!" << std::endl; }
    ~Entity() { std::cout << "Entity Destroyed!" << std::endl; }
    void Speak() { std::cout << "Hello from Entity!" << std::endl; }
};

int main() {
    std::cout << "--- Unique Pointer Block ---" << std::endl;
    {
        std::unique_ptr<Entity> entity = std::make_unique<Entity>();
        entity->Speak();
    } // entity is automatically destroyed
    std::cout << "--- Block End ---" << std::endl;
    return 0;
}`,
    bindings: `#include <iostream>
#include <map>
#include <string>

int main() {
    // C++17 Structured Bindings
    std::map<std::string, int> ages = {
        {"Alice", 24},
        {"Bob", 30},
        {"Charlie", 28}
    };
    
    for (const auto& [name, age] : ages) {
        std::cout << name << " is " << age << " years old." << std::endl;
    }
    return 0;
}`
};

// Initialize the WebSocket connection
function initWebSocket() {
    updateStatus('connecting', 'Connecting...');
    
    let wsUrl;
    if (window.location.protocol === 'file:' || !window.location.host) {
        wsUrl = 'ws://localhost:3000';
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}`;
    }
    
    console.log(`Connecting to WebSocket at: ${wsUrl}`);
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connection opened');
        ws.send(JSON.stringify({
            type: 'init',
            sessionId: sessionId
        }));
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'init_ok') {
            sessionId = data.sessionId;
            localStorage.setItem('cpp_repl_session_id', sessionId);
            document.getElementById('session-id-display').textContent = sessionId.substring(0, 8);
            updateStatus('connected', 'Connected');
            
            // Render the cumulative compilation state
            updateProgramStateView(data.state);
            
            // Print initial terminal screen
            term.write('\r\x1b[K'); // clear line
            term.write('\x1b[36mc++ > \x1b[0m');
            inputBuffer = '';
            cursorPosition = 0;
        }
        
        else if (data.type === 'status') {
            // Write transient status line
            term.write(`\r\x1b[K\x1b[90m[${data.message}]\x1b[0m`);
            isExecuting = true;
        }
        
        else if (data.type === 'output') {
            isExecuting = false;
            term.write('\r\x1b[K'); // clear compile status line
            
            if (data.stdout) {
                term.write(data.stdout.replace(/\n/g, '\r\n'));
            }
            if (data.stderr) {
                term.write(`\x1b[31m${data.stderr.replace(/\n/g, '\r\n')}\x1b[0m`);
            }
            if (data.error) {
                term.write(`\x1b[1;31m${data.error.replace(/\n/g, '\r\n')}\x1b[0m`);
            }
            
            if (data.state) {
                updateProgramStateView(data.state);
            }
            
            term.write('\x1b[36mc++ > \x1b[0m');
            inputBuffer = '';
            cursorPosition = 0;
        }
        
        else if (data.type === 'error') {
            isExecuting = false;
            term.write('\r\x1b[K');
            term.write(`\x1b[1;31mServer Error: ${data.message}\r\n\x1b[0m`);
            term.write('\x1b[36mc++ > \x1b[0m');
        }
    };
    
    ws.onclose = () => {
        console.log('WebSocket connection closed');
        updateStatus('disconnected', 'Disconnected');
        term.write('\r\n\x1b[31mConnection lost. Retrying in 5s...\x1b[0m\r\n');
        setTimeout(initWebSocket, 5000);
    };
    
    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// Update UI status badges
function updateStatus(cls, text) {
    const badge = document.getElementById('status-badge');
    const badgeText = document.getElementById('status-text');
    badge.className = `status-badge ${cls}`;
    badgeText.textContent = text;
}

// Update the code display panel with active variables and declarations
function updateProgramStateView(state) {
    if (!state) return;
    
    const pre = document.getElementById('state-code-view');
    let code = '';
    
    code += '// --- HEADERS ---\n';
    code += state.headers.join('\n') + '\n\n';
    
    if (state.globals.length > 0) {
        code += '// --- GLOBAL DECLARATIONS ---\n';
        code += state.globals.join('\n\n') + '\n\n';
    }
    
    code += '// --- LOCAL STATEMENTS ---\n';
    code += 'int main() {\n';
    if (state.locals.length > 0) {
        state.locals.forEach(stmt => {
            code += '    ' + stmt + '\n';
        });
    } else {
        code += '    // Execute lines in REPL to view variables here\n';
    }
    code += '    return 0;\n}';
    
    pre.textContent = code;
}

// Set up Monaco Editor
function initMonaco() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
        // Define unified premium dark theme
        monaco.editor.defineTheme('soft-charcoal', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'editor.background': '#181818',
                'editorGutter.background': '#181818',
                'minimap.background': '#181818',
                'editor.lineHighlightBackground': '#222222'
            }
        });
        
        editor = monaco.editor.create(document.getElementById('editor-container'), {
            value: `// Write a full C++ program to run as Standalone,
// or write variables/functions to inject in the REPL.

#include <iostream>
#include <vector>

int main() {
    std::cout << "Hello, C++ REPL!" << std::endl;
    return 0;
}`,
            language: 'cpp',
            theme: 'soft-charcoal',
            automaticLayout: true,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            minimap: { enabled: false },
            lineHeight: 20,
            padding: { top: 10 }
        });
        
        // Force initial layout pass
        setTimeout(() => {
            if (editor) editor.layout();
        }, 100);
    });
}

// Set up Xterm.js terminal
function initXterm() {
    term = new Terminal({
        cursorBlink: true,
        theme: {
            background: '#181818',
            foreground: '#d4d4d4',
            cursor: '#528bff',
            cursorAccent: '#181818',
            selectionBackground: 'rgba(38, 79, 120, 0.5)',
            black: '#000000',
            red: '#f44747',
            green: '#608b4e',
            yellow: '#dcdcaa',
            blue: '#569cd6',
            magenta: '#c586c0',
            cyan: '#4ec9b0',
            white: '#d4d4d4',
            brightBlack: '#808080',
            brightRed: '#f44747',
            brightGreen: '#608b4e',
            brightYellow: '#dcdcaa',
            brightBlue: '#569cd6',
            brightMagenta: '#c586c0',
            brightCyan: '#4ec9b0',
            brightWhite: '#ffffff'
        },
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 13,
        lineHeight: 1.3
    });
    
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();
    
    // Welcome Header
    term.write('\x1b[1;36m======================================================\r\n');
    term.write('      C++ Interactive Sandbox REPL Playground\r\n');
    term.write('======================================================\x1b[0m\r\n');
    term.write('Type C++ statements and press \x1b[1;33mEnter\x1b[0m to execute.\r\n');
    term.write('Variables persist. Define functions & structs globally.\r\n\r\n');
    
    // Resize listener
    window.addEventListener('resize', () => {
        if (fitAddon) fitAddon.fit();
    });
    
    // Handle inputs
    term.onData(data => {
        if (isExecuting) return; // Prevent typing while compile is in progress
        
        for (let i = 0; i < data.length; i++) {
            const char = data[i];
            
            // Check for multi-character ANSI escape sequences first
            if (data.slice(i, i + 3) === '\x1b[A') { // Arrow Up
                i += 2; // skip escape chars
                if (history.length > 0 && historyIndex > 0) {
                    term.write('\r\x1b[K\x1b[36mc++ > \x1b[0m');
                    historyIndex--;
                    inputBuffer = history[historyIndex];
                    term.write(inputBuffer);
                    cursorPosition = inputBuffer.length;
                }
            } 
            else if (data.slice(i, i + 3) === '\x1b[B') { // Arrow Down
                i += 2;
                if (history.length > 0 && historyIndex < history.length) {
                    term.write('\r\x1b[K\x1b[36mc++ > \x1b[0m');
                    historyIndex++;
                    if (historyIndex === history.length) {
                        inputBuffer = '';
                    } else {
                        inputBuffer = history[historyIndex];
                    }
                    term.write(inputBuffer);
                    cursorPosition = inputBuffer.length;
                }
            } 
            else if (data.slice(i, i + 3) === '\x1b[D') { // Arrow Left
                i += 2;
                if (cursorPosition > 0) {
                    cursorPosition--;
                    term.write('\x1b[D');
                }
            } 
            else if (data.slice(i, i + 3) === '\x1b[C') { // Arrow Right
                i += 2;
                if (cursorPosition < inputBuffer.length) {
                    cursorPosition++;
                    term.write('\x1b[C');
                }
            }
            else if (data.slice(i, i + 3) === '\x1b[H' || data.slice(i, i + 3) === '\x1bOH') { // Home Key
                i += 2;
                if (cursorPosition > 0) {
                    term.write('\x1b[D'.repeat(cursorPosition));
                    cursorPosition = 0;
                }
            }
            else if (data.slice(i, i + 3) === '\x1b[F' || data.slice(i, i + 3) === '\x1bOF') { // End Key
                i += 2;
                if (cursorPosition < inputBuffer.length) {
                    term.write('\x1b[C'.repeat(inputBuffer.length - cursorPosition));
                    cursorPosition = inputBuffer.length;
                }
            }
            else if (char === '\r') { // Enter Key
                const cmd = inputBuffer.trim();
                term.write('\r\n');
                if (cmd) {
                    executeInRepl(cmd);
                    // Add command to history
                    if (history.length === 0 || history[history.length - 1] !== cmd) {
                        history.push(cmd);
                    }
                    historyIndex = history.length;
                } else {
                    term.write('\x1b[36mc++ > \x1b[0m');
                }
                inputBuffer = '';
                cursorPosition = 0;
            } 
            else if (char === '\x7f' || char === '\b') { // Backspace Key
                if (cursorPosition > 0) {
                    inputBuffer = inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition);
                    cursorPosition--;
                    term.write('\b\x1b[K'); // Move cursor left and clear to the right
                    const remainder = inputBuffer.slice(cursorPosition);
                    term.write(remainder);
                    // Move terminal cursor back to cursorPosition
                    const moveLeft = inputBuffer.length - cursorPosition;
                    if (moveLeft > 0) {
                        term.write('\x1b[D'.repeat(moveLeft));
                    }
                }
            } 
            else if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) { // Printable ASCII
                inputBuffer = inputBuffer.slice(0, cursorPosition) + char + inputBuffer.slice(cursorPosition);
                term.write('\x1b[K'); // Clear line to the right
                const remainder = inputBuffer.slice(cursorPosition);
                term.write(remainder);
                cursorPosition++;
                // Move cursor back to the right position
                const moveLeft = inputBuffer.length - cursorPosition;
                if (moveLeft > 0) {
                    term.write('\x1b[D'.repeat(moveLeft));
                }
            }
        }
    });
}

// Execute command in the REPL
function executeInRepl(code) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'repl_execute',
            code: code
        }));
    }
}

// Setup Event Listeners
function setupEventHandlers() {
    // Run Standalone code
    document.getElementById('btn-run-standalone').addEventListener('click', () => {
        if (!editor) return;
        const code = editor.getValue();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'standalone_run',
                code: code
            }));
        }
    });
    
    // Run selected code or all code in the REPL
    document.getElementById('btn-run-repl').addEventListener('click', () => {
        if (!editor) return;
        
        // Use selection if exists, otherwise use all editor text
        const selection = editor.getSelection();
        let code = '';
        if (selection && !selection.isEmpty()) {
            code = editor.getModel().getValueInRange(selection);
        } else {
            code = editor.getValue();
        }
        
        // Notify user in terminal
        term.write(`\r\n\x1b[35m[Running Editor Script in REPL Context...]\x1b[0m\r\n`);
        executeInRepl(code);
    });
    
    // Clear Editor
    document.getElementById('btn-clear-editor').addEventListener('click', () => {
        if (editor) editor.setValue('');
    });
    
    // Reset REPL State
    document.getElementById('btn-reset-repl').addEventListener('click', () => {
        if (confirm('Are you sure you want to reset the REPL state? This will clear all variables, libraries, and functions.')) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'reset'
                }));
            }
        }
    });
    
    // Tabs Navigation
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from other tabs
            tabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            // Activate current
            tab.classList.add('active');
            const targetId = tab.id.replace('tab-', 'tab-content-');
            document.getElementById(targetId).classList.add('active');
        });
    });
    
    // Snippets Loading
    const snippetItems = document.querySelectorAll('.snippet-item');
    snippetItems.forEach(item => {
        item.addEventListener('click', () => {
            const key = item.getAttribute('data-snippet');
            if (editor && SNIPPETS[key]) {
                editor.setValue(SNIPPETS[key]);
                // Switch tab back to active program view or code view for better context
                document.getElementById('tab-code').click();
            }
        });
    });
}

// Initialize drag splitters for resizable panes
function initSplitters() {
    const horizontalSplitter = document.getElementById('panes-splitter');
    const verticalSplitter = document.getElementById('vertical-splitter');
    const appMain = document.querySelector('.app-main');
    const appFooter = document.querySelector('.app-footer');
    
    // Load persisted vertical height on boot
    const savedFooterHeight = localStorage.getItem('footer_height');
    if (savedFooterHeight && appFooter) {
        appFooter.style.height = savedFooterHeight;
    }
    
    // Load persisted horizontal ratio on boot
    const savedRatio = localStorage.getItem('splitter_ratio');
    if (savedRatio && appMain) {
        appMain.style.gridTemplateColumns = `${savedRatio} 6px 1fr`;
    }
    
    // 1. Horizontal split dragging (Left vs Right)
    if (horizontalSplitter && appMain) {
        let isDragging = false;
        
        horizontalSplitter.addEventListener('mousedown', (e) => {
            isDragging = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            horizontalSplitter.classList.add('active');
            
            document.querySelectorAll('#editor-container, #terminal-container').forEach(el => {
                el.style.pointerEvents = 'none';
            });
        });
        
        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const mainRect = appMain.getBoundingClientRect();
            const relativeX = e.clientX - mainRect.left;
            const totalWidth = mainRect.width;
            
            const minWidth = 200;
            let leftWidth = relativeX;
            if (leftWidth < minWidth) leftWidth = minWidth;
            if (leftWidth > totalWidth - minWidth - 6) leftWidth = totalWidth - minWidth - 6;
            
            const ratio = `${leftWidth}px`;
            appMain.style.gridTemplateColumns = `${ratio} 6px 1fr`;
            localStorage.setItem('splitter_ratio', ratio);
            
            if (editor) editor.layout();
            if (fitAddon) fitAddon.fit();
        });
        
        window.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            horizontalSplitter.classList.remove('active');
            
            document.querySelectorAll('#editor-container, #terminal-container').forEach(el => {
                el.style.pointerEvents = '';
            });
            
            if (editor) editor.layout();
            if (fitAddon) fitAddon.fit();
        });
    }
    
    // 2. Vertical split dragging (Main Grid vs Footer)
    if (verticalSplitter && appMain && appFooter) {
        let isDragging = false;
        
        verticalSplitter.addEventListener('mousedown', (e) => {
            isDragging = true;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
            verticalSplitter.classList.add('active');
            
            document.querySelectorAll('#editor-container, #terminal-container').forEach(el => {
                el.style.pointerEvents = 'none';
            });
        });
        
        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const totalHeight = window.innerHeight;
            const minFooterHeight = 60;
            // header is 48px, splitter is 6px, leave at least 150px for main editor
            const maxFooterHeight = totalHeight - 48 - 6 - 150;
            
            let footerHeight = totalHeight - e.clientY;
            if (footerHeight < minFooterHeight) footerHeight = minFooterHeight;
            if (footerHeight > maxFooterHeight) footerHeight = maxFooterHeight;
            
            const heightStr = `${footerHeight}px`;
            appFooter.style.height = heightStr;
            localStorage.setItem('footer_height', heightStr);
            
            if (editor) editor.layout();
            if (fitAddon) fitAddon.fit();
        });
        
        window.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            verticalSplitter.classList.remove('active');
            
            document.querySelectorAll('#editor-container, #terminal-container').forEach(el => {
                el.style.pointerEvents = '';
            });
            
            if (editor) editor.layout();
            if (fitAddon) fitAddon.fit();
        });
    }
}

// Main Setup Entrypoint
window.onload = () => {
    initSplitters(); // Setup splitter layout dimensions first
    initMonaco();
    initXterm();
    setupEventHandlers();
    initWebSocket();
};
