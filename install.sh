#!/bin/bash
#
# Claude Brain Installer - Comprehensive Setup
# Dual-platform installer for Claude Code and OpenCode
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/memvid/claude-brain/main/install.sh | bash
#
# For OpenCode, this also downloads the required embedding model.
#

set -e

REPO="memvid/claude-brain"
BRANCH="main"
VERSION="${1:-latest}"
FORCE="${2:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

check_dependencies() {
    local missing=()
    
    if ! command -v node &> /dev/null; then
        missing+=("node")
    fi
    
    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing dependencies: ${missing[*]}"
        log_info "Please install them first:"
        log_info "  - Node.js 18+: https://nodejs.org/"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        log_error "Node.js version must be 18 or higher (found v$NODE_VERSION)"
        exit 1
    fi
    
    log_success "Dependencies OK (Node.js $(node -v))"
}

detect_platforms() {
    PLATFORMS=""
    HAS_CLAUDE=false
    HAS_OPENCODE=false
    
    # Check for Claude Code
    if [ -d ".claude" ] || [ -f ".claude/settings.json" ] || [ -f ".claude/hooks.json" ]; then
        HAS_CLAUDE=true
        PLATFORMS="${PLATFORMS}claude,"
        log_info "Detected Claude Code"
    fi
    
    # Check for OpenCode
    if [ -d ".opencode" ] || [ -f "opencode.json" ] || [ -f "$HOME/.config/opencode/opencode.json" ]; then
        HAS_OPENCODE=true
        PLATFORMS="${PLATFORMS}opencode,"
        log_info "Detected OpenCode"
    fi
    
    # Default to both if neither detected
    if [ -z "$PLATFORMS" ]; then
        HAS_CLAUDE=true
        HAS_OPENCODE=true
        PLATFORMS="claude,opencode"
        log_warn "No platform detected, installing for both Claude Code and OpenCode"
    fi
    
    # Remove trailing comma
    PLATFORMS="${PLATFORMS%,}"
}

download_release() {
    local url="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
    
    log_info "Downloading claude-brain (${VERSION})..."
    
    if command -v curl &> /dev/null; then
        curl -fsSL "$url" -o /tmp/claude-brain.tar.gz
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O /tmp/claude-brain.tar.gz
    else
        log_error "Neither curl nor wget found. Please install one of them."
        exit 1
    fi
    
    log_success "Download complete"
}

extract_and_install() {
    log_info "Extracting..."
    
    rm -rf /tmp/claude-brain-temp
    mkdir -p /tmp/claude-brain-temp
    tar -xzf /tmp/claude-brain.tar.gz -C /tmp/claude-brain-temp --strip-components=1
    
    cd /tmp/claude-brain-temp
    
    # Install dependencies
    log_info "Installing dependencies..."
    npm install --production --no-fund --no-audit 2>/dev/null || {
        log_warn "npm install failed, trying with --force"
        npm install --production --no-fund --no-audit --force
    }
    
    # Build if needed
    if [ ! -d "dist" ] || [ ! -f "dist/index.js" ]; then
        log_info "Building plugin..."
        npm run build 2>/dev/null || {
            log_warn "Build failed, using pre-built files"
        }
    fi
    
    log_success "Dependencies installed"
}

# ============================================================================
# OpenCode-specific setup
# ============================================================================

setup_opencode_embedding_model() {
    log_step "Setting up OpenCode embedding model..."
    
    # Check if model already exists
    local model_dir="$HOME/.cache/opencode/node_modules/@xenova/transformers/models/Xenova/all-MiniLM-L6-v2"
    
    if [ -f "$model_dir/tokenizer.json" ] && [ "$FORCE" != "--force" ]; then
        log_success "Embedding model already exists"
        return 0
    fi
    
    log_info "Downloading Xenova/all-MiniLM-L6-v2 embedding model..."
    
    # Create cache directories
    mkdir -p "$model_dir"
    mkdir -p "$HOME/.cache/opencode/node_modules/@xenova/transformers/models/.cache"
    
    # Model files to download
    local BASE_URL="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main"
    local MINIMAL_FILES=(
        "tokenizer.json"
        "config.json"
        "model_quantized.onnx"
    )
    
    # Try to download files
    local download_success=true
    
    for file in "${MINIMAL_FILES[@]}"; do
        log_info "  Downloading $file..."
        if command -v curl &> /dev/null; then
            if ! curl -fsSL "$BASE_URL/$file" -o "$model_dir/$file" 2>/dev/null; then
                log_warn "  Failed to download $file (will try alternative)"
                download_success=false
            fi
        elif command -v wget &> /dev/null; then
            if ! wget -q "$BASE_URL/$file" -O "$model_dir/$file" 2>/dev/null; then
                log_warn "  Failed to download $file (will try alternative)"
                download_success=false
            fi
        fi
    done
    
    if [ "$download_success" = false ]; then
        # Try alternative approach: use transformers.js to download
        log_info "Trying alternative download method..."
        
        local temp_dir=$(mktemp -d)
        cd "$temp_dir"
        
        # Create a minimal script to download the model
        cat > download-model.mjs << 'SCRIPT'
import { env, pipeline } from '@xenova/transformers';

// Allow remote downloads
env.allowRemoteModels = true;
env.localModelPath = process.env.HOME + '/.cache/opencode/node_modules/@xenova/transformers/models/';
env.cacheDir = process.env.HOME + '/.cache/opencode/node_modules/@xenova/transformers/models/.cache';

console.log('Downloading embedding model...');

try {
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
        progress_callback: (progress) => {
            if (progress.status === 'downloading') {
                console.log(`  Downloading: ${progress.file} - ${Math.round(progress.progress || 0)}%`);
            }
        }
    });
    console.log('Model downloaded successfully!');
    process.exit(0);
} catch (error) {
    console.error('Download failed:', error.message);
    process.exit(1);
}
SCRIPT
        
        # Install transformers.js temporarily
        npm init -y > /dev/null 2>&1
        npm install @xenova/transformers --silent 2>/dev/null || true
        
        # Run download script
        if node download-model.mjs; then
            log_success "Model downloaded via transformers.js"
        else
            log_warn "Automatic download failed. Manual setup may be required."
        fi
        
        cd - > /dev/null
        rm -rf "$temp_dir"
    fi
    
    # Verify model exists
    if [ -f "$model_dir/tokenizer.json" ]; then
        log_success "Embedding model ready"
    else
        log_warn "Could not download embedding model automatically"
        log_info "OpenCode will attempt to download it on first run"
        log_info "If you have network restrictions, set: export TRANSFORMERS_JS_DISABLE_DOWNLOAD=false"
    fi
}

setup_opencode_env() {
    log_step "Configuring OpenCode environment..."
    
    # Check if env var already set in shell config
    local shell_config=""
    if [ -f "$HOME/.zshrc" ]; then
        shell_config="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
        shell_config="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
        shell_config="$HOME/.bash_profile"
    fi
    
    if [ -n "$shell_config" ]; then
        # Check if already configured
        if ! grep -q "TRANSFORMERS_JS_DISABLE_DOWNLOAD" "$shell_config" 2>/dev/null; then
            log_info "Adding environment variables to $shell_config"
            
            cat >> "$shell_config" << 'EOF'

# Claude Brain / OpenCode embedding model configuration
export TRANSFORMERS_JS_DISABLE_DOWNLOAD=false
EOF
            log_success "Environment variables added"
        else
            log_info "Environment variables already configured"
        fi
    fi
    
    # Export for current session
    export TRANSFORMERS_JS_DISABLE_DOWNLOAD=false
}

install_for_opencode() {
    log_step "Installing for OpenCode..."
    
    # Setup embedding model first
    setup_opencode_embedding_model
    setup_opencode_env
    
    # Create .opencode directory if needed
    mkdir -p .opencode
    mkdir -p .opencode/plugins/claude-brain
    
    # Copy plugin files
    cp -r /tmp/claude-brain-temp/.opencode/* .opencode/ 2>/dev/null || true
    cp -r /tmp/claude-brain-temp/dist .opencode/plugins/claude-brain/ 2>/dev/null || true
    cp /tmp/claude-brain-temp/package.json .opencode/plugins/claude-brain/ 2>/dev/null || true
    cp -r /tmp/claude-brain-temp/node_modules .opencode/plugins/claude-brain/ 2>/dev/null || true
    
    # Copy commands and skills
    mkdir -p .opencode/commands
    cp -r /tmp/claude-brain-temp/commands/* .opencode/commands/ 2>/dev/null || true
    
    # Update opencode.json if needed
    if [ ! -f "opencode.json" ]; then
        cat > opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["claude-brain"]
}
EOF
        log_info "Created opencode.json with claude-brain plugin"
    else
        # Check if plugin already in list
        if ! grep -q "claude-brain" opencode.json 2>/dev/null; then
            log_warn "opencode.json already exists."
            log_info "Add \"claude-brain\" to the plugin array manually:"
            log_info '  "plugin": ["claude-brain"]'
        fi
    fi
    
    log_success "OpenCode installation complete"
}

# ============================================================================
# Claude Code setup
# ============================================================================

install_for_claude() {
    log_step "Installing for Claude Code..."
    
    # Create .claude directory if needed
    mkdir -p .claude
    
    # Copy plugin files
    mkdir -p .claude-plugin
    cp -r /tmp/claude-brain-temp/.claude-plugin/* .claude-plugin/ 2>/dev/null || true
    cp -r /tmp/claude-brain-temp/dist .claude-plugin/ 2>/dev/null || true
    cp -r /tmp/claude-brain-temp/node_modules .claude-plugin/ 2>/dev/null || true
    
    # Copy commands
    mkdir -p commands
    cp -r /tmp/claude-brain-temp/commands/* commands/ 2>/dev/null || true
    
    # Copy skills
    mkdir -p skills
    cp -r /tmp/claude-brain-temp/skills/* skills/ 2>/dev/null || true
    
    log_success "Claude Code installation complete"
    log_info "Enable the plugin with: /plugins → Installed → mind → Enable"
}

create_version_marker() {
    local version_file=".claude-brain-version"
    cat > "$version_file" << EOF
{
  "version": "${VERSION}",
  "installed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "platforms": "${PLATFORMS}"
}
EOF
    log_info "Created version marker: $version_file"
}

cleanup() {
    rm -f /tmp/claude-brain.tar.gz
    rm -rf /tmp/claude-brain-temp
}

print_usage() {
    echo ""
    echo "Usage: install.sh [VERSION] [--force]"
    echo ""
    echo "Options:"
    echo "  VERSION    Version to install (default: latest)"
    echo "  --force    Force re-download of embedding model"
    echo ""
    echo "Examples:"
    echo "  install.sh              # Install latest version"
    echo "  install.sh v1.1.0       # Install specific version"
    echo "  install.sh latest --force  # Force re-download model"
    echo ""
}

main() {
    # Handle help flag
    if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
        print_usage
        exit 0
    fi
    
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║          Claude Brain - Comprehensive Installer               ║"
    echo "║        Persistent memory for Claude Code & OpenCode           ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    # Step 1: Check dependencies
    log_step "Checking dependencies..."
    check_dependencies
    
    # Step 2: Detect platforms
    log_step "Detecting platforms..."
    detect_platforms
    
    # Step 3: Download and extract
    log_step "Downloading claude-brain..."
    download_release
    extract_and_install
    
    # Step 4: Install for each platform
    cd "$OLDPWD" 2>/dev/null || cd "$HOME"
    
    if echo "$PLATFORMS" | grep -q "opencode"; then
        install_for_opencode
    fi
    
    if echo "$PLATFORMS" | grep -q "claude"; then
        install_for_claude
    fi
    
    # Step 5: Create version marker
    create_version_marker
    
    # Step 6: Cleanup
    cleanup
    
    # Step 7: Print summary
    echo ""
    log_success "═══════════════════════════════════════════════════════════════"
    log_success "              Installation Complete!                           "
    log_success "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "Platforms installed: ${PLATFORMS}"
    echo ""
    
    if echo "$PLATFORMS" | grep -q "opencode"; then
        echo "📋 OpenCode Setup:"
        echo "   1. Restart your terminal or run: source ~/.zshrc"
        echo "   2. Restart OpenCode to load the plugin"
        echo "   3. Run /mind stats to verify installation"
        echo ""
    fi
    
    if echo "$PLATFORMS" | grep -q "claude"; then
        echo "📋 Claude Code Setup:"
        echo "   1. Run /plugins in Claude Code"
        echo "   2. Go to Installed → mind → Enable"
        echo "   3. Restart Claude Code"
        echo ""
    fi
    
    echo "📚 Available Commands:"
    echo "   /mind stats    - View memory statistics"
    echo "   /mind search   - Search memories"
    echo "   /mind ask      - Ask your memory questions"
    echo "   /mind recent   - View recent activity"
    echo ""
    
    if echo "$PLATFORMS" | grep -q "opencode"; then
        echo "⚠️  Note: If you see embedding model errors on first run:"
        echo "   export TRANSFORMERS_JS_DISABLE_DOWNLOAD=false"
        echo "   Then restart OpenCode"
        echo ""
    fi
    
    echo "💾 Memory file: .claude/mind.mv2"
    echo "📖 Documentation: https://github.com/memvid/claude-brain"
    echo ""
}

main "$@"