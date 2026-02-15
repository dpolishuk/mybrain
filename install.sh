#!/bin/bash
#
# Claude Brain Installer
# Dual-platform installer for Claude Code and OpenCode
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/memvid/claude-brain/main/install.sh | bash
#

set -e

REPO="memvid/claude-brain"
BRANCH="main"
VERSION="${1:-latest}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

detect_platforms() {
    PLATFORMS=""
    
    # Check for Claude Code
    if [ -d ".claude" ] || [ -f ".claude/settings.json" ]; then
        PLATFORMS="${PLATFORMS}claude,"
        log_info "Detected Claude Code"
    fi
    
    # Check for OpenCode
    if [ -d ".opencode" ] || [ -f "opencode.json" ]; then
        PLATFORMS="${PLATFORMS}opencode,"
        log_info "Detected OpenCode"
    fi
    
    # Default to both if neither detected
    if [ -z "$PLATFORMS" ]; then
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
    
    log_success "Dependencies installed"
}

install_for_claude() {
    log_info "Installing for Claude Code..."
    
    # Create .claude directory if needed
    mkdir -p .claude
    
    # Copy plugin files
    mkdir -p .claude-plugin
    cp -r /tmp/claude-brain-temp/.claude-plugin/* .claude-plugin/ 2>/dev/null || true
    cp -r /tmp/claude-brain-temp/dist .claude-plugin/ 2>/dev/null || true
    
    # Copy commands
    mkdir -p commands
    cp -r /tmp/claude-brain-temp/commands/* commands/ 2>/dev/null || true
    
    # Copy skills
    mkdir -p skills
    cp -r /tmp/claude-brain-temp/skills/* skills/ 2>/dev/null || true
    
    # Create memory directory
    mkdir -p .claude
    
    log_success "Claude Code installation complete"
    log_info "Enable the plugin with: /plugins → Installed → mind → Enable"
}

install_for_opencode() {
    log_info "Installing for OpenCode..."
    
    # Create .opencode directory if needed
    mkdir -p .opencode
    mkdir -p .opencode/plugins/claude-brain
    
    # Copy plugin files
    cp -r /tmp/claude-brain-temp/.opencode/* .opencode/ 2>/dev/null || true
    cp -r /tmp/claude-brain-temp/dist .opencode/plugins/claude-brain/ 2>/dev/null || true
    cp /tmp/claude-brain-temp/package.json .opencode/plugins/claude-brain/ 2>/dev/null || true
    
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
        log_warn "opencode.json already exists. Add \"claude-brain\" to the plugin array manually."
    fi
    
    log_success "OpenCode installation complete"
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

main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║           Claude Brain - Dual Platform Installer          ║"
    echo "║        Persistent memory for Claude Code & OpenCode       ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    
    # Detect platforms
    detect_platforms
    
    # Download and extract
    download_release
    extract_and_install
    
    # Install for each platform
    cd "$OLDPWD" 2>/dev/null || cd "$HOME"
    
    if echo "$PLATFORMS" | grep -q "claude"; then
        install_for_claude
    fi
    
    if echo "$PLATFORMS" | grep -q "opencode"; then
        install_for_opencode
    fi
    
    # Create version marker
    create_version_marker
    
    # Cleanup
    cleanup
    
    echo ""
    log_success "Installation complete!"
    echo ""
    echo "Platforms installed: ${PLATFORMS}"
    echo ""
    echo "Next steps:"
    if echo "$PLATFORMS" | grep -q "claude"; then
        echo "  • Claude Code: Run /plugins to enable the 'mind' plugin"
    fi
    if echo "$PLATFORMS" | grep -q "opencode"; then
        echo "  • OpenCode: Restart OpenCode to load the plugin"
    fi
    echo ""
    echo "Commands available:"
    echo "  /mind:stats    - View memory statistics"
    echo "  /mind:search  - Search memories"
    echo "  /mind:ask     - Ask your memory"
    echo "  /mind:recent  - View timeline"
    echo ""
}

main "$@"