#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
ORANGE='\033[38;5;208m'
GREEN='\033[32m'
RESET='\033[0m'

echo ""
echo -e "${ORANGE}${BOLD}  ┌─────────────────────────────┐${RESET}"
echo -e "${ORANGE}${BOLD}  │       GLOOP.SYS_01          │${RESET}"
echo -e "${ORANGE}${BOLD}  │   recursive AI agent setup  │${RESET}"
echo -e "${ORANGE}${BOLD}  └─────────────────────────────┘${RESET}"
echo ""

# Detect package manager
if command -v bun &>/dev/null; then
  PM="bun"
  INSTALL="bun install"
  LINK="bun link"
elif command -v npm &>/dev/null; then
  PM="npm"
  INSTALL="npm install"
  LINK="npm link"
else
  echo "Error: Neither bun nor npm found. Install bun (https://bun.sh) or Node.js first."
  exit 1
fi

echo -e "${DIM}Using ${PM}${RESET}"
echo ""

# 1. Install dependencies
echo -e "${BOLD}[1/3] Installing dependencies...${RESET}"
$INSTALL
echo ""

# 2. Link globally
echo -e "${BOLD}[2/3] Linking gloop globally...${RESET}"
$LINK
echo -e "${GREEN}✓${RESET} gloop is now available as a global command"
echo ""

# 3. API key setup
echo -e "${BOLD}[3/3] OpenRouter API key setup${RESET}"
echo ""

if [ -f .env ] && grep -q "OPENROUTER_API_KEY" .env 2>/dev/null; then
  EXISTING=$(grep "OPENROUTER_API_KEY" .env | cut -d'=' -f2)
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "" ]; then
    MASKED="${EXISTING:0:8}...${EXISTING: -4}"
    echo -e "  Found existing key: ${DIM}${MASKED}${RESET}"
    echo -n "  Keep it? [Y/n] "
    read -r KEEP
    if [[ "$KEEP" =~ ^[Nn] ]]; then
      echo -n "  Enter your OpenRouter API key: "
      read -r API_KEY
      sed -i.bak "s|OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${API_KEY}|" .env && rm -f .env.bak
    else
      echo -e "  ${GREEN}✓${RESET} Keeping existing key"
    fi
  fi
else
  echo "  Get your key at: https://openrouter.ai/keys"
  echo ""
  echo -n "  Enter your OpenRouter API key: "
  read -r API_KEY
  if [ -n "$API_KEY" ]; then
    echo "OPENROUTER_API_KEY=${API_KEY}" >> .env
    echo -e "  ${GREEN}✓${RESET} Saved to .env"
  else
    echo "  Skipped. Set OPENROUTER_API_KEY in .env later."
  fi
fi

echo ""
echo -e "${ORANGE}${BOLD}  ────────────────────────────────────────${RESET}"
echo ""
echo -e "  ${BOLD}You're ready.${RESET} Here's what to know:"
echo ""
echo -e "  ${ORANGE}>${RESET} Gloop can write its own features, fix its"
echo -e "    own bugs, and build its own tools."
echo ""
echo -e "  ${ORANGE}>${RESET} Gloop is global, but each directory can"
echo -e "    have its own gloop with local config."
echo ""
echo -e "  ${ORANGE}>${RESET} To replicate gloop for this directory:"
echo -e "    ${DIM}gloop --clone${RESET}"
echo ""
echo -e "  ${ORANGE}>${RESET} Use a different model:"
echo -e "    ${DIM}gloop anthropic/claude-sonnet-4${RESET}"
echo ""
echo -e "  ${ORANGE}>${RESET} Run in task mode:"
echo -e "    ${DIM}gloop task \"describe the task\"${RESET}"
echo ""
echo -e "  ${ORANGE}>${RESET} Debug mode:"
echo -e "    ${DIM}gloop --debug${RESET}"
echo ""
echo -e "${ORANGE}${BOLD}  ────────────────────────────────────────${RESET}"
echo -e "  ${DIM}run ${RESET}${BOLD}gloop${RESET}${DIM} to start${RESET}"
echo ""
