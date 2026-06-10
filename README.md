# C++ Interactive REPL Playground

A beautiful, self-contained, web-based C++ playground that lets you run C++ statements interactively like a REPL (Read-Eval-Print Loop), alongside a full script editor.

Everything runs inside a single, unified Docker container using standard `clang` compilation. No external database or Docker socket dependencies are required.

---

## ✨ Features

- **Interactive C++ REPL**: Type statements directly in the terminal card (powered by `xterm.js`). Variables, imports, and functions persist across subsequent commands.
- **Script Editor**: A split-screen Monaco Editor that lets you write, compile, and run complete C++ scripts (`int main` required).
- **Double-Compile Routing Engine**:
  1. When you enter a command, the backend first tries to compile it as a **local statement** inside `main()`.
  2. If that fails, it tries compiling it in the **global scope** (for function/struct declarations).
  3. If both fail, it returns the compiler diagnostic errors directly to your console.
- **Smart Output Redirection**: Uses a custom C++ output buffer redirection wrapper (`dup2` to `/dev/null` combined with `fflush`/`cout << flush`) to execute and restore previous statements silently, ensuring old outputs don't bleed into new evaluations.
- **Self-Contained & Offline-Ready**: Serves Monaco Editor and Xterm.js assets locally from inside the container, protecting against tracking blockers and offline environments.
- **Inactivity Protections**: Automatically cleans up session folders in `/tmp` after 10 minutes of inactivity, with a 60-second page-reload grace period to prevent state loss on browser refresh.

---

## 🚀 Getting Started

### Prerequisites
- Docker installed on your host system.

### 1. Build the Docker Image
Navigate to the project directory and build the self-contained image:
```bash
docker build -t cpp-playground .
```

### 2. Run the Container
Expose the app on a port of your choice (e.g., `9090`):
```bash
docker run -d \
  --name cpp-playground \
  --restart unless-stopped \
  -p 9090:3000 \
  cpp-playground
```

### 3. Open in Browser
Open your browser and navigate to:
👉 **`http://localhost:9090`** (or `http://<your-host-ip>:9090` to access it from other devices on your local network).

---

## 🛠️ Docker Hub Backup

To back up and publish this image to your Docker Hub repository so it can be deployed to any remote server:

```bash
# 1. Tag the image (replace 'yourusername' with your Docker Hub username)
docker tag cpp-playground:latest yourusername/cpp-playground:latest

# 2. Log in and push
docker login
docker push yourusername/cpp-playground:latest
```

Once pushed, you can run it on any server (AWS, DigitalOcean, GCP) with a single command:
```bash
docker run -d -p 9090:3000 --restart unless-stopped yourusername/cpp-playground:latest
```

---

## 📂 Project Structure

- `Dockerfile`: Debian container bundling Node.js 20 and the Clang compiler toolchain.
- `server.js`: Express & WebSocket server driving session isolation, local compilation paths, and timeouts.
- `package.json`: Dependency manifests (Express, WS, UUID, Xterm).
- `public/`:
  - `index.html`: Dashboard layout using Monaco and local Xterm bindings.
  - `index.css`: Cyberpunk/neon dark theme layout.
  - `app.js`: Frontend driver handling socket exchanges, history buffers, and code snippets.
